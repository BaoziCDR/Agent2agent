import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SessionDecision, type SessionRecord, contextRatio, short } from './session.js';

/**
 * 第二期：规则打分落在灰区（或设置为每次都判断）时，用小模型再看一眼要不要续用。
 * 小模型只看摘要信息，不调用工具；超时、出错或答非所问时沿用规则的决定。
 */

export type JudgeMode = 'off' | 'gray' | 'always';

export interface JudgeOptions {
  mode: JudgeMode;
  harness: 'claude' | 'codex';
  /** Claude 默认 haiku；Codex 没有公认的小模型，必须指定才会判断 */
  model?: string;
  timeoutSeconds: number;
}

export interface JudgeVerdict {
  decision: 'reuse' | 'new';
  reason: string;
}

const SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['reuse', 'new'] },
    reason: { type: 'string' },
  },
  required: ['decision', 'reason'],
  additionalProperties: false,
};

const SYSTEM =
  '你帮一个自动值守程序决定：唤起编程 agent 处理新事项时，续用一个旧会话（保留之前的上下文，缓存命中时更便宜，但上下文越大越贵、越容易被旧信息干扰），还是新开会话（从任务的工作笔记重新开始）。只根据给出的信息判断，用一句中文说明理由。';

/** 这次要不要找小模型判断 */
export function shouldJudge(decision: SessionDecision, opts: JudgeOptions) {
  if (opts.mode === 'off' || !decision.session || decision.score === undefined) return false;
  if (opts.harness === 'codex' && !opts.model) return false;
  return opts.mode === 'always' || decision.gray;
}

export function judgePrompt(decision: SessionDecision, wakeItems: string[], threshold: number, now = Date.now()) {
  const s = decision.session as SessionRecord;
  const idle = Math.round((now - Date.parse(s.last_used_at)) / 60_000);
  return [
    '## 本次唤起的事项',
    ...wakeItems.map((x) => `- ${x}`),
    '',
    `## 候选会话 ${short(s.id)}`,
    `- 处理过的任务：${s.tasks.join('、') || '无'}`,
    `- 已运行 ${s.runs} 次，开了 ${Math.round((now - Date.parse(s.created_at)) / 3600_000)} 小时，空闲 ${idle} 分钟（缓存有效期约 ${s.cache_ttl_minutes} 分钟）`,
    `- 上下文已用 ${Math.round(contextRatio(s) * 100)}%（${Math.round(s.context_tokens / 1000)}k / ${Math.round(s.context_window / 1000)}k）`,
    `- 最近几次运行：${s.outcomes.map((o) => (o ? '正常' : '异常')).join('、') || '无记录'}`,
    s.summary ? `- 上次运行的总结：${s.summary.slice(0, 500)}` : '',
    '',
    `## 规则打分：${decision.score}（达到 ${threshold} 续用），规则的倾向是${decision.action === 'reuse' ? '续用' : '新开'}`,
    ...decision.breakdown.map((x) => `- ${x}`),
    '',
    '请判断续用（reuse）还是新开（new），以 JSON 回答：{"decision":"reuse"|"new","reason":"一句话理由"}',
  ]
    .filter((x) => x !== '')
    .join('\n');
}

/** 从小模型的输出里取出判断；Claude 的结构化输出在 structured_output，Codex 的在最后一条 agent_message */
export function parseVerdict(stdout: string): JudgeVerdict | null {
  const pick = (v: unknown): JudgeVerdict | null => {
    const o = v as Partial<JudgeVerdict> | null;
    if (!o || (o.decision !== 'reuse' && o.decision !== 'new')) return null;
    return { decision: o.decision, reason: String(o.reason ?? '').trim().replace(/[。.；;]+$/, '').slice(0, 300) };
  };
  const fromText = (t: unknown) => {
    if (typeof t !== 'string') return null;
    const m = t.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return pick(JSON.parse(m[0]));
    } catch {
      return null;
    }
  };
  let found: JudgeVerdict | null = null;
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let m: Record<string, any>;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.type === 'result') found = pick(m.structured_output) ?? fromText(m.result) ?? found;
    if (m.type === 'item.completed' && m.item?.type === 'agent_message') found = fromText(m.item.text) ?? found;
  }
  return found ?? fromText(stdout);
}

export function judgeCommand(opts: JudgeOptions, schemaFile: string): { cmd: string; args: string[] } {
  if (opts.harness === 'claude') {
    return {
      cmd: 'claude',
      args: [
        '-p',
        '--model', opts.model ?? 'haiku',
        '--output-format', 'json',
        '--tools', '',
        '--no-session-persistence',
        '--system-prompt', SYSTEM,
        '--json-schema', JSON.stringify(SCHEMA),
      ],
    };
  }
  return {
    cmd: 'codex',
    args: ['exec', '--json', '-m', opts.model!, '--sandbox', 'read-only', '--skip-git-repo-check', '--output-schema', schemaFile, '-'],
  };
}

/** 运行小模型；任何失败都返回 null，由调用方沿用规则的决定 */
export async function runJudge(prompt: string, opts: JudgeOptions, env: NodeJS.ProcessEnv): Promise<JudgeVerdict | null> {
  // 在空目录里运行，不读工作目录的项目说明，也不留下文件
  const dir = mkdtempSync(join(tmpdir(), 'ahub-judge-'));
  const schemaFile = join(dir, 'schema.json');
  writeFileSync(schemaFile, JSON.stringify(SCHEMA));
  const { cmd, args } = judgeCommand(opts, schemaFile);
  const input = opts.harness === 'codex' ? `${SYSTEM}\n\n${prompt}` : prompt;
  try {
    const out = await new Promise<string | null>((done) => {
      let stdout = '';
      const child = spawn(cmd, args, { cwd: dir, env, shell: process.platform === 'win32', stdio: ['pipe', 'pipe', 'ignore'] });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        done(null);
      }, opts.timeoutSeconds * 1000);
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.on('error', () => {
        clearTimeout(timer);
        done(null);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        done(code === 0 ? stdout : null);
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(input);
    });
    return out === null ? null : parseVerdict(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 按小模型的判断改写决定；理由里同时留下规则得分 */
export function applyVerdict(decision: SessionDecision, verdict: JudgeVerdict | null): SessionDecision {
  if (!verdict) return { ...decision, reason: `${decision.reason}；小模型没有给出判断，按规则处理` };
  const what = verdict.decision === 'reuse' ? '续用' : '新开';
  const rule = `规则得分 ${decision.score}（${decision.breakdown.join('，')}）`;
  return {
    ...decision,
    action: verdict.decision,
    reason: `小模型判断${what}会话 ${short(decision.session!.id)}：${verdict.reason || '未说明'}；${rule}`,
  };
}
