import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SessionDecision, type SessionRecord, contextRatio, short } from './session.js';
import { tr } from '../i18n/index.js';

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

const judgeSystem = () =>
  tr('你帮一个自动值守程序决定：唤起编程 agent 处理新事项时，续用一个旧会话（保留之前的上下文，缓存命中时更便宜，但上下文越大越贵、越容易被旧信息干扰），还是新开会话（从任务的工作笔记重新开始）。只根据给出的信息判断，用一句中文说明理由。');

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
    tr('## 本次唤起的事项'),
    ...wakeItems.map((x) => `- ${x}`),
    '',
    tr('## 候选会话 {short}', { short: short(s.id) }),
    tr('- 处理过的任务：{v}', { v: s.tasks.join(tr('、')) || tr('无') }),
    tr('- 已运行 {runs} 次，开了 {n} 小时，空闲 {idle} 分钟（缓存有效期约 {cache_ttl_minutes} 分钟）', { runs: s.runs, n: Math.round((now - Date.parse(s.created_at)) / 3600_000), idle, cache_ttl_minutes: s.cache_ttl_minutes }),
    tr('- 上下文已用 {n}%（{n2}k / {n3}k）', { n: Math.round(contextRatio(s) * 100), n2: Math.round(s.context_tokens / 1000), n3: Math.round(s.context_window / 1000) }),
    tr('- 最近几次运行：{v}', { v: s.outcomes.map((o) => (o ? tr('正常') : tr('异常'))).join(tr('、')) || tr('无记录') }),
    s.summary ? tr('- 上次运行的总结：{summary}', { summary: s.summary.slice(0, 500) }) : '',
    '',
    tr('## 规则打分：{score}（达到 {threshold} 续用），规则的倾向是{v}', { score: decision.score, threshold, v: decision.action === 'reuse' ? tr('续用') : tr('新开') }),
    ...decision.breakdown.map((x) => `- ${x}`),
    '',
    tr('请判断续用（reuse）还是新开（new），以 JSON 回答：{"decision":"reuse"|"new","reason":"一句话理由"}'),
  ]
    .filter((x) => x !== '')
    .join('\n');
}

/** 从小模型的输出里取出判断；Claude 的结构化输出在 structured_output，Codex 的在最后一条 agent_message */
export function parseVerdict(stdout: string): JudgeVerdict | null {
  return parseOutput(stdout, (v) => {
    const o = v as Partial<JudgeVerdict> | null;
    if (!o || (o.decision !== 'reuse' && o.decision !== 'new')) return null;
    return { decision: o.decision, reason: cleanReason(o.reason) };
  });
}

const cleanReason = (r: unknown) => String(r ?? '').trim().replace(/[。.；;]+$/, '').slice(0, 300);

function parseOutput<T>(stdout: string, pick: (v: unknown) => T | null): T | null {
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
  let found: T | null = null;
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

export function judgeCommand(opts: JudgeOptions, schemaFile: string, system = judgeSystem(), schema: object = SCHEMA): { cmd: string; args: string[] } {
  if (opts.harness === 'claude') {
    return {
      cmd: 'claude',
      args: [
        '-p',
        '--model', opts.model ?? 'haiku',
        '--output-format', 'json',
        '--tools', '',
        '--no-session-persistence',
        '--system-prompt', system,
        '--json-schema', JSON.stringify(schema),
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
  const out = await runModel(prompt, opts, env, judgeSystem(), SCHEMA);
  return out === null ? null : parseVerdict(out);
}

/** 用指定的系统提示词和输出格式运行一次小模型，返回原始输出；失败返回 null */
async function runModel(prompt: string, opts: JudgeOptions, env: NodeJS.ProcessEnv, system: string, schema: object): Promise<string | null> {
  // 在空目录里运行，不读工作目录的项目说明，也不留下文件
  const dir = mkdtempSync(join(tmpdir(), 'ahub-judge-'));
  const schemaFile = join(dir, 'schema.json');
  writeFileSync(schemaFile, JSON.stringify(schema));
  const { cmd, args } = judgeCommand(opts, schemaFile, system, schema);
  const input = opts.harness === 'codex' ? `${system}\n\n${prompt}` : prompt;
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
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 按小模型的判断改写决定；理由里同时留下规则得分 */
export function applyVerdict(decision: SessionDecision, verdict: JudgeVerdict | null): SessionDecision {
  if (!verdict) return { ...decision, reason: tr('{reason}；小模型没有给出判断，按规则处理', { reason: decision.reason }) };
  const what = verdict.decision === 'reuse' ? tr('续用') : tr('新开');
  const rule = tr('规则得分 {score}（{breakdown}）', { score: decision.score, breakdown: decision.breakdown.join(tr('，')) });
  return {
    ...decision,
    action: verdict.decision,
    reason: tr('小模型判断{what}会话 {short}：{v}；{rule}', { what, short: short(decision.session!.id), v: verdict.reason || tr('未说明'), rule }),
  };
}

// ───────────── 领取判断 ─────────────
// 智能领取第二期：匹配度落在灰区（刚过门槛）的任务，唤起 harness 前先让小模型看一眼任务适不适合这个 agent，
// 不适合就直接让出，省一次唤起；小模型没给出判断时照常唤起，由 harness 自己看。

export interface ClaimVerdict {
  decision: 'claim' | 'pass';
  reason: string;
}

const CLAIM_SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['claim', 'pass'] },
    reason: { type: 'string' },
  },
  required: ['decision', 'reason'],
  additionalProperties: false,
};

const claimSystem = () =>
  tr('你帮一个多 agent 协作平台的值守程序判断：任务池里的这个任务适不适合交给这个 agent 领取。适合（claim）就唤起它去领；明显不适合（能力、平台、环境对不上，或者别人显然更合适）就让出（pass）给下一个候选。拿不准时选 claim，让 agent 自己看。只根据给出的信息判断，用一句中文说明理由。');

export interface ClaimJudgeInput {
  agent: { name: string; platform: string; tags: string[]; cwd: string };
  task: { id: string; title: string; description?: string; acceptance?: string[]; required_tags?: string[]; parent?: string | null };
  fit: { score: number; rank: number; of: number; reasons: string[]; warnings: string[] };
  active: number;
}

/** 这个任务要不要先问小模型 */
export function shouldJudgeClaim(gray: boolean, opts: JudgeOptions) {
  if (opts.mode === 'off') return false;
  if (opts.harness === 'codex' && !opts.model) return false;
  return opts.mode === 'always' || gray;
}

export function claimPrompt(x: ClaimJudgeInput) {
  const t = x.task;
  return [
    '## Agent',
    tr('- 名字：{name}，平台：{platform}', { name: x.agent.name, platform: x.agent.platform }),
    tr('- 能力标签：{v}', { v: x.agent.tags.join(tr('、')) || tr('无') }),
    tr('- 工作目录：{cwd}', { cwd: x.agent.cwd }),
    tr('- 手上进行中的任务：{active} 个', { active: x.active }),
    '',
    tr('## 任务 {id}：{title}', { id: t.id, title: t.title }),
    t.description ? t.description.slice(0, 3000) : tr('（没有描述）'),
    t.acceptance?.length ? tr('验收标准：\n{v}', { v: t.acceptance.map((a) => `- ${a}`).join('\n') }) : '',
    t.required_tags?.length ? tr('所需能力：{required_tags}', { required_tags: t.required_tags.join(tr('、')) }) : '',
    t.parent ? tr('父任务：{parent}', { parent: t.parent }) : '',
    '',
    tr('## 平台算的匹配度：{score}，在 {of} 个候选里排第 {rank}', { score: x.fit.score, of: x.fit.of, rank: x.fit.rank }),
    ...x.fit.reasons.map((r) => `- ${r}`),
    ...x.fit.warnings.map((w) => tr('- 注意：{w}', { w })),
    '',
    tr('请判断领取（claim）还是让出（pass），以 JSON 回答：{"decision":"claim"|"pass","reason":"一句话理由"}'),
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export function parseClaimVerdict(stdout: string): ClaimVerdict | null {
  return parseOutput(stdout, (v) => {
    const o = v as Partial<ClaimVerdict> | null;
    if (!o || (o.decision !== 'claim' && o.decision !== 'pass')) return null;
    return { decision: o.decision, reason: cleanReason(o.reason) };
  });
}

export async function runClaimJudge(input: ClaimJudgeInput, opts: JudgeOptions, env: NodeJS.ProcessEnv): Promise<ClaimVerdict | null> {
  const out = await runModel(claimPrompt(input), opts, env, claimSystem(), CLAIM_SCHEMA);
  return out === null ? null : parseClaimVerdict(out);
}
