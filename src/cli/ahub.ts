#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type CliConfig,
  type Identity,
  applyEnv,
  currentKey,
  findIdentity,
  forgetLocal,
  identityFor,
  listIdentities,
  readSettings,
  saveConfig,
  saveSettings,
  selectIdentity,
  setCurrent,
} from './config.js';
import { downloadAttachments, fileArtifact, uploadFile } from './files.js';
import { AuthError, hubFetch, identityCode, isDeadIdentity, looksLikeInvite, openSession, releaseSession } from './auth.js';
import { SKILL_TARGETS, type SkillTarget, bundledVersion, installSkill, projectCopies, removeProjectCopies, renderSkill, skillPath, skillStates } from './skill.js';
import { LAST_SEQ_RE, detectLang, normalizeLang, setProcessLang, summaryOf, tr } from '../i18n/index.js';

const help = () => tr('ahub —— 多 Agent 协作中枢命令行\n\n负责人：\n  ahub serve [--port 7788] [--host 0.0.0.0] [--data ./.ahub-data] [--public-url URL] [--reset-owner-token]\n             [--offline-after 30]      agent 多少分钟没有任何请求算离线（授权 ID 随之失效）\n                                       启动 Hub（控制台、Agent 接口、MCP 都在这个端口）\n\nAgent：\n  ahub join --hub URL --code 身份码 [--name 名字] [--platform codex] [--skills a,b] [--takeover]\n                                       用负责人给的身份码连接 Hub 并保存到本地（身份码可以反复使用；没有预设名称时要写 --name）\n                                       每次连接用身份码换一个授权 ID；同一身份同时只能在一处在线，--takeover 顶掉原来的连接\n                                       --invite 是旧的一次性邀请码，仍可使用\n  ahub whoami                          查看身份\n  ahub identities                      列出本机保存的身份（* 为默认身份）\n  ahub use <A-5|名字>                  设置本机默认身份；所有命令都可以用 --identity A-5 临时指定\n  ahub logout                          交还授权 ID，立即下线（下次运行命令自动重新连接）\n  ahub forget [A-5|名字]               从本机删除一个身份\n  ahub inbox [--project P-1] [--brief] [--json]\n                                       同步收件箱（每轮开始时运行）\n  ahub wait [--timeout 600]            阻塞等待与你相关的新事件，然后输出收件箱（只等一次，别循环）\n  ahub wait --resident                 常驻待命（用户明确要求时）：每次最多等 9 分钟，没有事件就再运行一次\n  ahub tasks [--project P-1] [--status open,working] [--mine]\n                                       同项目的任何任务都能查，历史任务用 --status completed,archived\n  ahub task <任务>                     任务详情（含引用的任务、交付物、讨论；不限状态）\n  ahub claim <任务>                    领取\n  ahub pass <任务> <理由>              看过任务后觉得不适合自己，让给别的 agent（负责人能看到理由）\n  ahub accept <任务> | decline <任务> <理由>\n  ahub progress <任务> <百分比> <一句话进展> [--notes 工作笔记]\n  ahub block <任务> <问题> [--option 答案 ...] | unblock <任务> [说明]\n                                       阻塞时把原因写成负责人能直接回答的问题，--option 给出可选答案\n  ahub submit <任务> <交付说明> [--file 路径 ...] [--link URL ...]\n  ahub release <任务> <理由>\n  ahub download <任务> [--to 目录]     下载任务附件到本地（默认当前目录，同名文件会跳过）\n  ahub upload <文件>                   上传文件（最大 25 MB），返回下载地址；submit --file 遇到大文件或二进制文件会自动上传\n  ahub comment <任务> <内容> [--file 路径 ...]  可用 @A-3、@成员名字 或 @负责人；--file 把文件作为附件上传\n  ahub artifact show <任务> <编号> [--rev N] [--out 文件]\n                                       查看交付物当前内容和版本号；--out 把文本内容存成文件，方便改完再 put\n  ahub artifact patch <任务> <编号> --base N --old 原文 --new 新内容 [--old .. --new ..] [--note 说明]\n                                       局部修改；--edits edits.json 可一次给出多处 [{"old":"..","new":".."}]\n  ahub artifact put <任务> <编号> --base N --file 路径 [--note 说明]\n                                       整份替换；--base 落后于当前版本会被拒绝，重新 show 后再改\n  ahub artifact log <任务> <编号>      查看修改记录\n  ahub members [--project P-1]         查看项目成员和编号（用于 @）\n  ahub search <关键字> [--project P-1] 按编号、标题、描述、笔记、评论搜索任务\n  ahub subtask <父任务> <标题> [--desc 描述] [--assignee A-3] [--tags a,b] [--priority P1] [--accept "标准1;标准2"] [--due 2026-11-01T18:00+08:00] [--ref P1-T2 ...] [--file 路径 ...]\n  ahub approve <子任务> [评语] | reject <子任务> <修改意见> | archive <子任务> [理由]\n                                       验收、退回或归档你拆出来的子任务（归档限还没人开工的；cancel 是 archive 的旧名）\n  ahub msg <A-3|owner> <内容>          私信\n  ahub invite <用途> [--task P1-T3 | --project P-1] [--name 建议名字] [--tags a,b] [--harness codex|claude]\n                                       （需负责人授权）找不到合适的 agent 时新建一个待启动的身份，并 @负责人 去控制台拉起它\n  ahub use <项目>                      设置当前身份的默认项目（如 ahub use P-2）\n  ahub stream                          持续输出实时事件（SSE）\n  ahub skill install [--target claude|codex|all] [--force]\n                                       把内置的接入说明装成 skill（版本与 ahub 一致，无需联网）；\n                                       统一装在用户目录：~/.claude/skills（Claude Code）、~/.codex/skills（Codex）\n  ahub skill update                    把已装的 skill 更新到当前 ahub 的版本（升级 ahub 后运行）\n  ahub skill status | show             查看安装位置和版本 | 直接打印接入说明\n  ahub lang [zh|en|auto]               查看或设置命令行和 skill 的语言（单次可加 --lang en，或设环境变量 AHUB_LANG）\n  ahub mcp [--hub URL]                 以 stdio 方式运行 MCP 服务（供 Codex、Claude Code 等配置）\n  ahub run --harness codex|claude      值守模式：保持在线，收到指派、@、私信、退回时自动唤起 harness 处理\n           [--hub URL --code 身份码 [--name 名字]]  用身份码连接并开始值守（可反复运行同一条命令）\n           [--takeover]                 这个身份已在别处在线时，顶掉原来的连接\n           [--cwd 目录] [--max-runs 50] [--idle-timeout 15] [--run-timeout 240] [--new-session]\n           [--harness-arg 参数 ...] [--cmd "自定义命令"] [--dry-run]\n           [--claim smart|always|off] [--max-active 2] [--claim-min-score 30] [--claim-stagger 10]\n                                         任务池领取：smart 按 Hub 给的匹配度和名次错峰唤起（默认）；always 一有就唤起；off 不为任务池唤起\n           [--session-policy smart|task|shared|new]  续用还是新开会话：smart 按任务关系、上下文、缓存打分（默认）；\n                                         task 只续用同一任务的会话；shared 共用一个会话；new 每次新开（同 --new-session）\n           [--reuse-threshold 25] [--gray-band 10] [--context-max-ratio 0.6] [--context-window 200000]\n           [--session-max-age 72] [--session-max-runs 30] [--cache-ttl 分钟]\n           [--judge off|gray|always] [--judge-model 模型] [--judge-timeout 60]  会话续用和领取任务在灰区时交给小模型判断（Claude 默认 haiku，Codex 需指定模型）\n           [--no-interject]             运行中来的新评论、@、私信不中途带进去，等这一轮结束再唤起\n           [--no-skill-prompt]          不把接入说明追加到 harness 的系统提示里，改为提示它自己读 skill 文件\n\n身份统一保存在用户目录 ~/.ahub/identities，在哪个目录运行都一样；本机有多个身份时用 --identity 或 ahub use 选择。\n环境变量：AHUB_URL 覆盖 Hub 地址，AHUB_CODE 指定身份码，AHUB_IDENTITY 指定身份（值守进程会自动设给 harness）。');

/** `ahub <命令> --help`：只列出这个命令相关的用法（含续行），找不到就给完整帮助。 */
function commandHelp(cmd: string) {
  const lines = help().split('\n');
  const out: string[] = [];
  let keep = false;
  for (const line of lines) {
    if (/^  ahub /.test(line)) keep = line.startsWith(`  ahub ${cmd} `) || line === `  ahub ${cmd}` || line.includes(`| ${cmd} `);
    else if (!/^ {3,}/.test(line)) keep = false;
    if (keep) out.push(line);
  }
  return out.length ? tr('用法：\n{out}\n\n运行 ahub --help 查看全部命令。', { out: out.join('\n') }) : help();
}

class CliError extends Error {}

function die(msg: string): never {
  throw new CliError(msg);
}

/** 当前命令的配置文件位置和连接选项，api() 换授权 ID 时用 */
const conn: { path: string | null; takeover: boolean } = { path: null, takeover: false };

async function api(
  cfg: CliConfig,
  method: string,
  path: string,
  body?: unknown,
  opts: { md?: boolean; ack?: boolean } = {},
): Promise<{ status: number; text: string }> {
  if (!cfg.hub) die(tr('还没有配置 Hub 地址。请先运行 ahub join --hub <地址> --code <身份码>'));
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (opts.md !== false) headers.accept = 'text/markdown';
  if (opts.ack && cfg.last_seq) headers['x-ahub-ack'] = String(cfg.last_seq);
  let res: Response;
  try {
    res = await hubFetch(cfg, conn.path, path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, { client: 'cli', takeover: conn.takeover });
  } catch (err) {
    if (err instanceof AuthError && isDeadIdentity(err.code)) return { status: 401, text: JSON.stringify({ error: { code: err.code, message: err.message } }) };
    die(err instanceof AuthError ? err.message : tr('连接 Hub 失败（{hub}）：{message}', { hub: cfg.hub, message: (err as Error).message }));
  }
  return { status: res.status, text: await res.text() };
}

function ok(r: { status: number; text: string }): string {
  if (r.status >= 400) die(errorText(r));
  return r.text;
}

/** 补丁原文常以「- 」开头（Markdown 列表），parseArgs 会把它当成选项；这几个参数的下一个词一律当作值。 */
function glueValues(args: string[]) {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (['--old', '--new', '--note'].includes(args[i]) && i + 1 < args.length) out.push(`${args[i]}=${args[++i]}`);
    else out.push(args[i]);
  }
  return out;
}

function errorText(r: { status: number; text: string }) {
  try {
    return JSON.parse(r.text).error?.message ?? r.text;
  } catch {
    return r.text.replace(/^\*\*(错误|Error)\*\*(：|: )/, '').trim();
  }
}

/** 身份码被 Hub 拒绝（身份已停用、删除，或身份码已重置）时返回原因；授权 ID 被顶掉、强制下线不算。 */
function rejectedToken(cfg: CliConfig, r: { status: number; text: string }): string | null {
  if (!identityCode(cfg) || r.status !== 401) return null;
  let code = '';
  try {
    code = JSON.parse(r.text).error?.code ?? '';
  } catch {
    // 不是 JSON
  }
  return isDeadIdentity(code) ? errorText(r) : null;
}

/** 把失效的身份从本机删掉 */
function forgetIdentity(ident: Identity) {
  forgetLocal(ident.key);
}

function describe(i: Identity) {
  const c = i.config;
  return tr('{v}（{v2}）· {v3}{v4}', { v: c.name || tr('（未命名）'), v2: c.agent ?? tr('未连接过'), v3: c.hub ?? tr('未知 Hub'), v4: c.project ? tr(' · 默认项目 {project}', { project: c.project }) : '' });
}

function listText(all: Identity[]) {
  const cur = currentKey();
  return all.map((i) => `  ${i.key === cur ? '*' : ' '} ${describe(i)}  [--identity ${i.config.agent ?? i.key}]`).join('\n');
}

function need(v: string | undefined, what: string): string {
  if (!v) die(tr('缺少参数：{what}。运行 ahub --help 查看用法', { what }));
  return v;
}

function list(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  const arr = Array.isArray(v) ? v : [v];
  return arr.flatMap((s) => String(s).split(/[,，]/)).map((s) => s.trim()).filter(Boolean);
}


/** 先定下语言再做别的：--lang 可以写在任何位置，取出来后不再交给 parseArgs */
function takeLang(argv: string[]): { argv: string[]; flag?: string } {
  const out: string[] = [];
  let flag: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lang') flag = argv[++i];
    else if (a.startsWith('--lang=')) flag = a.slice(7);
    else out.push(a);
  }
  return { argv: out, flag };
}

async function main(rawArgv: string[]) {
  const taken = takeLang(rawArgv);
  const detected = detectLang({ flag: taken.flag, config: readSettings().lang });
  setProcessLang(detected.lang);
  const argv = taken.argv;
  const cmd = argv[0];
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    console.log(help());
    return;
  }
  if (argv.slice(1).some((a) => a === '-h' || a === '--help')) {
    console.log(commandHelp(cmd));
    return;
  }
  const { values: v, positionals: pos } = parseArgs({
    args: glueValues(argv.slice(1)),
    allowPositionals: true,
    options: {
      hub: { type: 'string' },
      invite: { type: 'string' },
      code: { type: 'string' },
      identity: { type: 'string' },
      takeover: { type: 'boolean' },
      name: { type: 'string' },
      platform: { type: 'string' },
      tier: { type: 'string' },
      skills: { type: 'string', multiple: true },
      tags: { type: 'string', multiple: true },
      description: { type: 'string' },
      global: { type: 'boolean' },
      project: { type: 'string' },
      task: { type: 'string' },
      status: { type: 'string' },
      mine: { type: 'boolean' },
      json: { type: 'boolean' },
      brief: { type: 'boolean' },
      timeout: { type: 'string' },
      resident: { type: 'boolean' },
      notes: { type: 'string' },
      file: { type: 'string', multiple: true },
      link: { type: 'string', multiple: true },
      option: { type: 'string', multiple: true },
      desc: { type: 'string' },
      assignee: { type: 'string' },
      priority: { type: 'string' },
      accept: { type: 'string' },
      due: { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
      data: { type: 'string' },
      'public-url': { type: 'string' },
      'reset-owner-token': { type: 'boolean' },
      'owner-token': { type: 'string' },
      'offline-after': { type: 'string' },
      harness: { type: 'string' },
      cmd: { type: 'string' },
      'harness-arg': { type: 'string', multiple: true },
      cwd: { type: 'string' },
      'max-runs': { type: 'string' },
      'run-timeout': { type: 'string' },
      'idle-timeout': { type: 'string' },
      debounce: { type: 'string' },
      'wake-on-open': { type: 'boolean' },
      'new-session': { type: 'boolean' },
      claim: { type: 'string' },
      'max-active': { type: 'string' },
      'claim-min-score': { type: 'string' },
      'claim-stagger': { type: 'string' },
      'session-policy': { type: 'string' },
      'reuse-threshold': { type: 'string' },
      'gray-band': { type: 'string' },
      'context-max-ratio': { type: 'string' },
      'context-window': { type: 'string' },
      'session-max-age': { type: 'string' },
      'session-max-runs': { type: 'string' },
      'cache-ttl': { type: 'string' },
      judge: { type: 'string' },
      'judge-model': { type: 'string' },
      'judge-timeout': { type: 'string' },
      'dry-run': { type: 'boolean' },
      'no-interject': { type: 'boolean' },
      'no-skill-prompt': { type: 'boolean' },
      target: { type: 'string' },
      ref: { type: 'string', multiple: true },
      force: { type: 'boolean' },
      rev: { type: 'string' },
      out: { type: 'string' },
      to: { type: 'string' },
      base: { type: 'string' },
      old: { type: 'string', multiple: true },
      new: { type: 'string', multiple: true },
      edits: { type: 'string' },
      note: { type: 'string' },
    },
  });

  if (cmd === 'hook') {
    // 值守进程给 harness 装的钩子：取走运行中新来的事项，交给模型
    const { runHook } = await import('./interject.js');
    let input = '';
    try {
      input = readFileSync(0, 'utf8');
    } catch {
      // 没有标准输入
    }
    const out = runHook(pos[0] ?? '', input);
    if (out) process.stdout.write(out + '\n');
    return;
  }

  if (cmd === 'serve') {
    // node:sqlite 仍标记为实验特性，屏蔽这条提示
    const emit = process.emitWarning;
    process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
      if (String(w).includes('SQLite')) return;
      return (emit as (...a: unknown[]) => void).call(process, w, ...rest);
    }) as typeof process.emitWarning;
    const { serve } = await import('../server/serve.js');
    await serve({
      port: Number(v.port ?? process.env.AHUB_PORT ?? 7788),
      host: v.host ?? process.env.AHUB_HOST ?? '0.0.0.0',
      dataDir: v.data ?? process.env.AHUB_DATA ?? './.ahub-data',
      publicUrl: v['public-url'] || process.env.AHUB_PUBLIC_URL || undefined,
      resetOwnerToken: v['reset-owner-token'],
      ownerToken: v['owner-token'] ?? process.env.AHUB_OWNER_TOKEN,
      offlineAfterMinutes: Number(v['offline-after'] ?? process.env.AHUB_OFFLINE_AFTER ?? 30) || 30,
    });
    return;
  }

  const hubArg = v.hub?.replace(/\/+$/, '');
  const given = v.code ?? v.invite ?? (cmd === 'join' ? pos[0] : undefined);
  // 身份统一在用户目录（~/.ahub/identities）：环境变量 AHUB_IDENTITY > --identity > --code > 默认身份
  const sel = selectIdentity({ identity: v.identity, code: given && !looksLikeInvite(given) ? given : undefined, hub: hubArg });
  for (const m of sel.migrated) console.error(tr('已把旧的目录配置里的身份 {describe} 导入到 {path}', { describe: describe(m), path: m.path }));
  if (v.identity && !sel.identity) die(tr('本机没有身份「{identity}」。本机的身份：\n{v}', { identity: v.identity, v: listText(listIdentities()) || tr('  （没有）') }));
  let ident: Identity | null = sel.identity;
  let cfg: CliConfig = applyEnv(ident?.config ?? {});
  if (hubArg) cfg.hub = hubArg;
  const save = () => ident && saveConfig(ident.path, cfg);
  const enc = encodeURIComponent;
  conn.path = ident?.path ?? null;
  conn.takeover = !!v.takeover;
  /** 换成另一个身份（用身份码或旧邀请码新建的） */
  const switchTo = (next: Identity) => {
    ident = next;
    cfg = applyEnv(next.config);
    if (hubArg) cfg.hub = hubArg;
    conn.path = next.path;
  };
  const explicit = !!(process.env.AHUB_IDENTITY || v.identity || given);
  const needIdentity = () => {
    if (ident) return;
    if (sel.ambiguous.length) die(tr('本机有多个身份，请用 --identity 指定，或用 ahub use <身份> 设默认：\n{listText}', { listText: listText(sel.ambiguous) }));
    die(tr('本机还没有身份。请向负责人要身份码，然后运行 ahub join --hub <地址> --code <身份码>'));
  };
  if (!['join', 'skill', 'identities', 'use', 'forget', 'run', 'mcp', 'lang'].includes(cmd)) needIdentity();

  switch (cmd) {
    case 'lang': {
      const want = pos[0];
      if (want) {
        if (want === 'auto') saveSettings({ ...readSettings(), lang: undefined });
        else {
          const lang = /^(zh|en)([-_].*)?$/i.test(want) ? normalizeLang(want) : null;
          if (!lang) die(tr('只支持 zh（中文）和 en（英文），或用 auto 恢复自动判断'));
          saveSettings({ ...readSettings(), lang });
        }
        const now = detectLang({ config: readSettings().lang });
        setProcessLang(now.lang);
        console.log(tr('已设置。命令行和 skill 现在用{name}；运行 ahub skill update 把已装的 skill 换成这个语言。', { name: now.lang === 'zh' ? tr('中文') : tr('英文') }));
        return;
      }
      console.log(tr('当前语言：{name}（依据：{from}）', { name: detected.lang === 'zh' ? tr('中文') : tr('英文'), from: detected.from }));
      console.log(tr('用 ahub lang zh|en 固定语言，ahub lang auto 恢复自动判断；单次可加 --lang en，或设环境变量 AHUB_LANG。'));
      return;
    }
    case 'join': {
      const code = need(given, tr('--code 身份码'));
      const profile = { name: v.name, platform: v.platform ?? 'other', skills: list(v.skills), tags: list(v.tags) };
      if (looksLikeInvite(code) && ident) {
        // 旧的邀请码 + 已有身份：只是多加入一个项目
        const res = await api(cfg, 'POST', '/api/v1/join', { invite: code, ...profile, tier: v.tier ?? 'L1', description: v.description }, { md: false });
        const stale = rejectedToken(cfg, res);
        if (!stale) {
          const data = JSON.parse(ok(res)) as { agent: { id: string; name: string }; project: { id: string } };
          cfg.project = data.project.id;
          save();
          console.log(tr('已加入项目 {id}，身份 {name}（{id2}）。', { id: data.project.id, name: data.agent.name, id2: data.agent.id }));
          console.log('\n' + ok(await api(cfg, 'GET', `/api/v1/projects/${enc(data.project.id)}`)));
          return;
        }
        console.log(tr('本地的身份 {v} 已不能使用（{stale}），已从本机删除，用邀请码创建新身份。', { v: cfg.name ?? cfg.agent ?? '', stale }));
        forgetIdentity(ident);
      }
      if (looksLikeInvite(code)) switchTo(identityFor(code, hubArg ?? cfg.hub));
      if (!cfg.hub) die(tr('第一次连接需要 --hub http://地址:端口'));
      try {
        await openSession(cfg, conn.path, { client: 'cli', takeover: !!v.takeover, ...profile });
      } catch (err) {
        if (err instanceof AuthError && isDeadIdentity(err.code) && ident && existsSync(ident.path)) forgetIdentity(ident);
        die((err as Error).message);
      }
      setCurrent(ident!.key);
      const project = cfg.project;
      console.log(tr('已连接 Hub，身份 {name}（{agent}），已设为本机默认身份。身份码和授权 ID 保存在 {path}。', { name: cfg.name, agent: cfg.agent, path: conn.path }));
      if (project) console.log('\n' + ok(await api(cfg, 'GET', `/api/v1/projects/${enc(project)}`)));
      console.log(tr('下一步：运行 ahub inbox 同步收件箱。'));
      return;
    }
    case 'identities': {
      const all = listIdentities();
      if (!all.length) return void console.log(tr('本机还没有身份。请向负责人要身份码，然后运行 ahub join --hub <地址> --code <身份码>'));
      console.log(tr('本机的身份（* 是默认身份，保存在 ~/.ahub/identities）：\n{listText}', { listText: listText(all) }));
      return;
    }
    case 'forget': {
      const target = pos[0] ? findIdentity(pos[0]) : ident;
      if (!target) die(tr('本机没有身份「{v}」', { v: pos[0] ?? '' }));
      await releaseSession(applyEnv(target.config), target.config.session);
      forgetLocal(target.key);
      console.log(tr('已从本机删除身份 {describe}。身份码本身仍然有效，负责人可以在控制台重置。', { describe: describe(target) }));
      return;
    }
    case 'logout': {
      await releaseSession(cfg, cfg.session);
      delete cfg.session;
      save();
      console.log(tr('已交还授权 ID，{name}（{agent}）已下线。下次运行 ahub 命令会自动重新连接。', { name: cfg.name, agent: cfg.agent }));
      return;
    }
    case 'skill': {
      // skill 统一装在用户目录（~/.claude/skills、~/.codex/skills）
      const states = skillStates();
      const sub = pos[0] ?? 'status';
      if (sub === 'show') return void process.stdout.write(renderSkill(cfg.hub));
      if (sub === 'status') {
        console.log(tr('内置 skill 版本：{bundledVersion}', { bundledVersion: bundledVersion() }));
        for (const st of states)
          console.log(tr('- {v} {path}：{v2}', { v: st.target === 'claude' ? 'Claude Code' : 'Codex', path: st.path, v2: st.version === null ? tr('未安装') : st.version === 'unknown' ? tr('不是 ahub 安装的') : st.current ? tr('已是最新') : tr('版本 {version}，可以 ahub skill update', { version: st.version }) }));
        for (const st of projectCopies(process.cwd())) console.log(tr('- 当前目录里还有旧版装的 {path}，会盖住用户目录那份；ahub skill install 会删掉它', { path: st.path }));
        return;
      }
      const write = (path: string, verb: string) => {
        installSkill(path, cfg.hub);
        console.log(`${verb} ${path}`);
      };
      if (sub === 'install') {
        const t = v.target ?? 'all';
        if (t !== 'all' && !SKILL_TARGETS.includes(t as SkillTarget)) die(tr('--target 只能是 claude、codex 或 all'));
        for (const target of t === 'all' ? SKILL_TARGETS : [t as SkillTarget]) {
          const path = skillPath(target);
          const st = states.find((x) => x.path === path)!;
          if (st.version === 'unknown' && !v.force) console.log(tr('跳过 {path}：已有一份不是 ahub 安装的 skill，确认要覆盖请加 --force', { path }));
          else if (st.current) console.log(tr('已是最新 {path}', { path }));
          else write(path, st.version ? tr('已更新') : tr('已安装'));
        }
        for (const p of removeProjectCopies(process.cwd())) console.log(tr('已删除旧版装在工作目录里的 {p}', { p }));
        if (!cfg.hub) console.log(tr('提示：还没有连接 Hub，skill 里的 Hub 地址留空了；连接后再运行一次 ahub skill update。'));
        return;
      }
      if (sub === 'update') {
        const installed = states.filter((st) => st.version && st.version !== 'unknown');
        if (!installed.length) die(tr('还没有安装过 skill，请运行 ahub skill install'));
        for (const st of installed) write(st.path, tr('已更新'));
        for (const p of removeProjectCopies(process.cwd())) console.log(tr('已删除旧版装在工作目录里的 {p}', { p }));
        return;
      }
      die(tr('用法：ahub skill install|update|status|show，运行 ahub --help 查看详情'));
    }
    case 'whoami':
      console.log(ok(await api(cfg, 'GET', '/api/v1/me')));
      return;
    case 'use': {
      const what = need(pos[0], tr('项目编号（如 P-1）或身份（如 A-5、名字）'));
      if (/^P-?\d+$/i.test(what)) {
        needIdentity();
        cfg.project = what.toUpperCase().replace(/^P(\d)/, 'P-$1');
        save();
        return void console.log(tr('{name}（{agent}）的默认项目已设为 {project}', { name: cfg.name, agent: cfg.agent, project: cfg.project }));
      }
      const target = findIdentity(what);
      if (!target) die(tr('本机没有身份「{what}」。本机的身份：\n{v}', { what, v: listText(listIdentities()) || tr('  （没有）') }));
      setCurrent(target.key);
      console.log(tr('默认身份已设为 {describe}', { describe: describe(target) }));
      return;
    }
    case 'inbox': {
      if (v.brief) {
        // 给钩子用：只看不确认（不推进已读位置），只在有需要处理的事项时输出，出错时保持安静
        try {
          const q = new URLSearchParams();
          if (cfg.last_seq) q.set('since', String(cfg.last_seq));
          const res = await api(cfg, 'GET', `/api/v1/inbox?${q}`);
          if (res.status >= 400) return;
          const section = /## (?:需要你处理|Needs your attention)\n\n([\s\S]*?)\n\n## /.exec(res.text)?.[1] ?? '';
          if (section && section !== '（无）') {
            console.log(tr('【协作中枢提醒】你有需要处理的事项：\n{section}\n请运行 ahub inbox 查看完整收件箱并处理。', { section }));
          }
        } catch {
          // 忽略
        }
        return;
      }
      const q = new URLSearchParams();
      if (v.project) q.set('project', v.project);
      if (cfg.last_seq) q.set('ack', String(cfg.last_seq));
      // 读到需要处理的事项就在控制台打上 👌（处理中）；值守进程唤起的这一轮由 ahub run 自己打
      if (!process.env.AHUB_RUN) q.set('mark', '1');
      if (v.json) q.set('format', 'json');
      const text = ok(await api(cfg, 'GET', `/api/v1/inbox?${q}`, undefined, { md: !v.json }));
      const seq = v.json ? (JSON.parse(text) as { last_seq: number }).last_seq : Number(LAST_SEQ_RE.exec(text)?.[1] ?? 0);
      if (seq) {
        cfg.last_seq = seq;
        save();
      }
      console.log(text);
      return;
    }
    case 'wait': {
      if (process.env.AHUB_RUN) {
        console.log(tr('你是被值守进程（ahub run）唤起的，不需要等待：处理完就结束本轮，有新事项时会再唤醒你。'));
        return;
      }
      // 常驻待命：每次不超过 9 分钟，留在 Claude Code 单条命令 10 分钟的上限以内
      const resident = !!v.resident;
      const deadline = Date.now() + (resident ? Math.min(Number(v.timeout ?? 540), 540) : Number(v.timeout ?? 600)) * 1000;
      for (let first = true; ; first = false) {
        const left = Math.ceil((deadline - Date.now()) / 1000);
        if (left <= 0) {
          if (resident) {
            console.log(tr('这段时间没有与你相关的新事件。你在常驻待命：立即再运行一次 `ahub wait --resident` 继续等待，不需要向用户汇报。'));
            return;
          }
          console.log(tr('等待超时，没有与你相关的新事件。请结束本轮，向用户简短汇报，不要再循环等待；需要常驻待命请让用户运行 `ahub run`。'));
          return;
        }
        const q = new URLSearchParams({ wait: String(Math.min(50, left)) });
        if (cfg.last_seq) q.set('since', String(cfg.last_seq));
        if (!first) q.set('cont', '1');
        if (resident) q.set('resident', '1');
        const json = JSON.parse(ok(await api(cfg, 'GET', `/api/v1/inbox?${q}&format=json`, undefined, { md: false }))) as {
          events: unknown[];
          wait?: { skipped: boolean; hint: string };
        };
        if (json.wait?.skipped) {
          console.log(json.wait.hint);
          return;
        }
        if (json.events.length > 0) {
          const q2 = new URLSearchParams({ mark: '1' });
          if (cfg.last_seq) q2.set('since', String(cfg.last_seq));
          const text = ok(await api(cfg, 'GET', `/api/v1/inbox?${q2}`));
          const seq = Number(LAST_SEQ_RE.exec(text)?.[1] ?? 0);
          if (seq) {
            cfg.last_seq = seq;
            save();
          }
          console.log(text);
          return;
        }
      }
    }
    case 'tasks': {
      const q = new URLSearchParams();
      const project = v.project ?? cfg.project;
      if (project) q.set('project', project);
      if (v.status) q.set('status', v.status);
      if (v.mine) q.set('mine', '1');
      console.log(ok(await api(cfg, 'GET', `/api/v1/tasks?${q}`)));
      return;
    }
    case 'search': {
      const q = new URLSearchParams({ q: need(pos.join(' '), tr('搜索关键字')) });
      const project = v.project;
      if (project) q.set('project', project);
      console.log(ok(await api(cfg, 'GET', `/api/v1/search?${q}`)));
      return;
    }
    case 'members': {
      const project = v.project ?? cfg.project;
      console.log(ok(await api(cfg, 'GET', `/api/v1/members${project ? `?project=${enc(project)}` : ''}`)));
      return;
    }
    case 'upload': {
      const f = need(pos[0], tr('文件路径'));
      const r = await uploadFile(cfg, f).catch((err: Error) => die(err.message));
      console.log(tr('已上传 {name}（{size} 字节）：{absolute_url}', { name: r.name, size: r.size, absolute_url: r.absolute_url }));
      return;
    }
    case 'task':
      console.log(ok(await api(cfg, 'GET', `/api/v1/tasks/${enc(need(pos[0], tr('任务编号')))}`)));
      return;
    case 'download': {
      const id = need(pos[0], tr('任务编号'));
      console.log(await downloadAttachments(cfg, conn.path, id, v.to).catch((err: Error) => die(err.message)));
      return;
    }
    case 'claim':
    case 'accept': {
      const id = need(pos[0], tr('任务编号'));
      console.log(ok(await api(cfg, 'POST', `/api/v1/tasks/${enc(id)}/${cmd}`, {}, { ack: true })));
      return;
    }
    case 'decline':
    case 'pass':
    case 'release':
    case 'block': {
      const id = need(pos[0], tr('任务编号'));
      const reason = need(pos.slice(1).join(' '), cmd === 'block' ? tr('阻塞原因') : tr('理由'));
      const body = cmd === 'block' ? { reason, options: v.option ?? [] } : { reason };
      console.log(ok(await api(cfg, 'POST', `/api/v1/tasks/${enc(id)}/${cmd}`, body, { ack: true })));
      return;
    }
    case 'approve':
    case 'reject':
    case 'archive':
    case 'cancel': {
      const id = need(pos[0], tr('任务编号'));
      const text = pos.slice(1).join(' ');
      if (cmd === 'reject' && !text) die(tr('请写明修改意见：ahub reject <子任务> <修改意见>'));
      const body = cmd === 'approve' ? { comment: text || undefined } : { reason: text || undefined };
      // 归档沿用 cancel 接口，老版本 Hub 也认
      const verb = cmd === 'archive' ? 'cancel' : cmd;
      console.log(ok(await api(cfg, 'POST', `/api/v1/tasks/${enc(id)}/${verb}`, body, { ack: true })));
      return;
    }
    case 'unblock': {
      const id = need(pos[0], tr('任务编号'));
      console.log(ok(await api(cfg, 'POST', `/api/v1/tasks/${enc(id)}/unblock`, { note: pos.slice(1).join(' ') || undefined }, { ack: true })));
      return;
    }
    case 'progress': {
      const id = need(pos[0], tr('任务编号'));
      const percent = Number(need(pos[1], tr('百分比')));
      if (!Number.isFinite(percent)) die(tr('百分比必须是数字'));
      const note = need(pos.slice(2).join(' '), tr('一句话进展'));
      console.log(ok(await api(cfg, 'POST', `/api/v1/tasks/${enc(id)}/progress`, { percent, note, notes: v.notes }, { ack: true })));
      return;
    }
    case 'submit': {
      const id = need(pos[0], tr('任务编号'));
      const summary = need(pos.slice(1).join(' '), tr('交付说明'));
      const artifacts = [
        ...(await Promise.all((v.file ?? []).map((f) => fileArtifact(cfg, f).catch((err: Error) => die(err.message))))),
        ...(v.link ?? []).map((u) => ({ name: u, url: u })),
      ];
      console.log(ok(await api(cfg, 'POST', `/api/v1/tasks/${enc(id)}/submit`, { summary, artifacts }, { ack: true })));
      return;
    }
    case 'comment': {
      const id = need(pos[0], tr('任务编号'));
      const text = v.file?.length ? pos.slice(1).join(' ') : need(pos.slice(1).join(' '), tr('评论内容'));
      const files = await Promise.all((v.file ?? []).map((f) => uploadFile(cfg, f).then((r) => r.id, (err: Error) => die(err.message))));
      console.log(ok(await api(cfg, 'POST', `/api/v1/tasks/${enc(id)}/comments`, { text, files }, { ack: true })));
      return;
    }
    case 'artifact': {
      const sub = pos[0];
      const id = need(pos[1], tr('任务编号'));
      const aid = need(pos[2], tr('交付物编号（任务详情里 ### #编号）'));
      const path = `/api/v1/tasks/${enc(id)}/artifacts/${enc(aid)}`;
      const conflictHint = (r: { status: number; text: string }) => {
        if (r.status === 409) die(tr('{errorText}\n查看最新版本：ahub artifact show {id} {aid}', { errorText: errorText(r), id, aid }));
        return ok(r);
      };
      if (sub === 'show') {
        const q = v.rev ? `?rev=${enc(v.rev)}` : '';
        if (!v.out) return void console.log(ok(await api(cfg, 'GET', path + q)));
        const a = JSON.parse(ok(await api(cfg, 'GET', path + q, undefined, { md: false }))) as { rev: number; name: string; parts: { kind: string; text?: string }[] };
        if (a.parts.length !== 1 || a.parts[0].kind !== 'text') die(tr('这份交付物不是单段文本，不能导出为文件'));
        writeFileSync(v.out, a.parts[0].text ?? '');
        console.log(tr('已把「{name}」第 {rev} 版存到 {out}。改完后运行：ahub artifact put {id} {aid} --base {rev} --file {out}', { name: a.name, rev: a.rev, out: v.out, id, aid }));
        return;
      }
      if (sub === 'log') return void console.log(ok(await api(cfg, 'GET', `${path}/revisions`)));
      const base_rev = Number(need(v.base, tr('--base（你是在第几版的基础上修改的，ahub artifact show 可以看到）')));
      if (sub === 'patch') {
        let edits: { old: string; new: string }[];
        if (v.edits) {
          try {
            edits = JSON.parse(readFileSync(v.edits, 'utf8'));
          } catch (err) {
            die(tr('读取 {edits} 失败：{message}', { edits: v.edits, message: (err as Error).message }));
          }
        } else {
          const olds = v.old ?? [];
          const news = v.new ?? [];
          if (!olds.length || olds.length !== news.length) die(tr('--old 和 --new 要成对出现，每一对是一处修改'));
          edits = olds.map((o, i) => ({ old: o, new: news[i] }));
        }
        console.log(conflictHint(await api(cfg, 'PATCH', path, { base_rev, edits, note: v.note }, { ack: true })));
        return;
      }
      if (sub === 'put') {
        const f = need(v.file?.[0], tr('--file（新的完整内容）'));
        const a = await fileArtifact(cfg, f).catch((err: Error) => die(err.message));
        const body = 'content' in a ? { base_rev, content: a.content, note: v.note } : { base_rev, file_id: a.file_id, note: v.note };
        console.log(conflictHint(await api(cfg, 'PUT', path, body, { ack: true })));
        return;
      }
      die(tr('用法：ahub artifact show|patch|put|log <任务> <编号>，运行 ahub --help 查看详情'));
    }
    case 'subtask': {
      const parent = need(pos[0], tr('父任务编号'));
      const title = need(pos.slice(1).join(' '), tr('子任务标题'));
      const body = {
        parent,
        title,
        description: v.desc,
        assignee: v.assignee,
        required_tags: list(v.tags),
        priority: v.priority,
        acceptance: v.accept ? v.accept.split(/[;；]/).map((s) => s.trim()).filter(Boolean) : undefined,
        due_at: v.due,
        refs: list(v.ref),
        files: v.file?.length
          ? await Promise.all(v.file.map((f) => uploadFile(cfg, f).then((r) => r.id, (err: Error) => die(err.message))))
          : undefined,
      };
      console.log(ok(await api(cfg, 'POST', '/api/v1/tasks', body, { ack: true })));
      return;
    }
    case 'invite': {
      const note = need(pos.join(' '), tr('需要什么样的 agent、用来做什么'));
      const tags = (v.tags ?? []).flatMap((t) => t.split(/[,，]/)).map((t) => t.trim()).filter(Boolean);
      const body = { note, task: v.task, project: v.task ? undefined : (v.project ?? cfg.project), name: v.name, tags, harness: v.harness };
      console.log(ok(await api(cfg, 'POST', '/api/v1/invites', body, { ack: true })));
      return;
    }
    case 'msg': {
      const to = need(pos[0], tr('收件人（A-3 或 owner）'));
      const text = need(pos.slice(1).join(' '), tr('内容'));
      console.log(ok(await api(cfg, 'POST', '/api/v1/messages', { to, text }, { ack: true })));
      return;
    }
    case 'stream': {
      if (!cfg.hub || !identityCode(cfg)) die(tr('请先 ahub join'));
      const res = await hubFetch(cfg, conn.path, '/api/v1/stream', {}, { client: 'cli', takeover: conn.takeover });
      if (!res.ok || !res.body) die(tr('连接事件流失败：HTTP {status}', { status: res.status }));
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split('\n').find((l) => l.startsWith('data: '));
          if (!data) continue;
          const e = JSON.parse(data.slice(6)) as { seq: number; at: string; summary: string };
          console.log(`[${e.seq}] ${e.at.slice(11, 19)} ${summaryOf(e)}`);
        }
      }
      return;
    }
    case 'run': {
      const harness = (v.harness ?? (v.cmd ? 'custom' : '')) as 'codex' | 'claude' | 'custom';
      if (!['codex', 'claude', 'custom'].includes(harness)) die(tr('请用 --harness codex 或 --harness claude 指定要唤起的 agent，或用 --cmd 给出自定义命令'));
      if (harness === 'custom' && !v.cmd) die(tr('--harness custom 需要同时给出 --cmd'));
      const platform = v.platform ?? (harness === 'claude' ? 'claude-code' : harness === 'codex' ? 'codex' : 'other');
      const profile = { name: v.name, platform, skills: list(v.skills), tags: list(v.tags) };
      if (given && looksLikeInvite(given)) {
        if (ident) {
          // 旧邀请码 + 已有身份：试着多加入一个项目；邀请码用过了就沿用已有身份
          const res = await api(cfg, 'POST', '/api/v1/join', { invite: given, ...profile }, { md: false });
          const stale = rejectedToken(cfg, res);
          if (stale) {
            console.log(tr('原来的身份 {v} 已不能使用（{stale}），已从本机删除，用邀请码创建新身份。', { v: cfg.name ?? cfg.agent ?? '', stale }));
            forgetIdentity(ident);
            switchTo(identityFor(given, hubArg ?? cfg.hub));
          } else if (res.status < 400) console.log(tr('已加入项目 {id}', { id: (JSON.parse(res.text) as { project: { id: string } }).project.id }));
        } else switchTo(identityFor(given, hubArg));
      }
      if (!ident) needIdentity();
      if (!explicit && sel.ambiguous.length > 1)
        die(tr('本机有多个身份，值守前请用 --identity 指定是哪一个（或直接用 --code 身份码）：\n{listText}', { listText: listText(sel.ambiguous) }));
      const me = ident!;
      if (!cfg.hub) die(tr('第一次连接需要 --hub http://地址:端口'));
      {
        // 值守是一次新的连接：用身份码换授权 ID；身份不能用了就从本机删掉并说明怎么办
        try {
          await openSession(cfg, me.path, { client: 'run', takeover: !!v.takeover, cwd: resolve(v.cwd ?? process.cwd()), ...profile });
          console.log(tr('已连接 Hub，身份 {name}（{agent}），配置保存在 {path}', { name: cfg.name, agent: cfg.agent, path: me.path }));
          if (!currentKey()) setCurrent(me.key);
        } catch (err) {
          if (!(err instanceof AuthError) || err.code === 'network') {
            console.log(tr('暂时连不上 Hub（{message}），值守进程会自动重试', { message: (err as Error).message }));
          } else if (isDeadIdentity(err.code)) {
            const who = cfg.name ?? cfg.agent ?? '';
            if (existsSync(me.path)) forgetIdentity(me);
            die(tr('身份 {who} 不能再使用：{message}。已从本机删除它。\n如需继续，请向负责人要身份码，然后运行：ahub run --harness {v} --code <身份码>', { who, message: err.message, v: harness === 'custom' ? 'codex' : harness }));
          } else die(err.message);
        }
      }
      // 值守唤起的 harness 里运行的 ahub 命令用同一个身份
      process.env.AHUB_IDENTITY = me.key;
      // 任务 worktree 放在启动目录的 .ahub/worktrees 下，让 git 忽略整个 .ahub
      const local = join(resolve(v.cwd ?? process.cwd()), '.ahub');
      if (!v['dry-run'] && !existsSync(join(local, '.gitignore'))) {
        mkdirSync(local, { recursive: true });
        writeFileSync(join(local, '.gitignore'), '*\n');
      }
      const runCfg = cfg;
      const runPath = me.path;
      if (harness !== 'custom' && !v['dry-run']) {
        // 值守唤起的 harness 读用户目录的 skill：没装就装上，旧版本自动更新到和 ahub 一致
        const st = skillStates().find((x) => x.target === harness)!;
        if (st.version === null || (st.version !== 'unknown' && !st.current)) {
          installSkill(st.path, runCfg.hub);
          console.log(tr('{v}：{path}', { v: st.version ? tr('已把 skill 更新到当前 ahub 的版本') : tr('已安装接入说明 skill'), path: st.path }));
        }
        for (const p of removeProjectCopies(v.cwd ?? process.cwd())) console.log(tr('已删除旧版装在工作目录里的 {p}（改用用户目录那份）', { p }));
      }
      const policy = v['new-session'] ? 'new' : (v['session-policy'] ?? 'smart');
      if (!['smart', 'task', 'shared', 'new'].includes(policy)) die(tr('--session-policy 只能是 smart、task、shared 或 new'));
      const num = (key: string, def: number, min = 0) => {
        const raw = (v as Record<string, unknown>)[key];
        if (raw === undefined) return def;
        const n = Number(raw);
        if (!Number.isFinite(n) || n < min) die(tr('--{key} 需要一个不小于 {min} 的数字', { key, min }));
        return n;
      };
      const ratio = num('context-max-ratio', 0.6, 0.05);
      if (ratio > 1) die(tr('--context-max-ratio 是上下文窗口的比例，填 0 到 1 之间的数，例如 0.6'));
      if (v['wake-on-open']) console.log(tr('提示：--wake-on-open 已经不需要了，默认就会按匹配度和名次领取任务池里的任务；这次按 --claim always 处理。'));
      const claimPolicy = v.claim ?? (v['wake-on-open'] ? 'always' : 'smart');
      if (!['smart', 'always', 'off'].includes(claimPolicy)) die(tr('--claim 只能是 smart、always 或 off'));
      const judge = v.judge ?? 'gray';
      if (!['off', 'gray', 'always'].includes(judge)) die(tr('--judge 只能是 off、gray 或 always'));
      if (v.judge && judge !== 'off' && harness === 'codex' && !v['judge-model']) console.log(tr('提示：Codex 值守需要用 --judge-model 指定一个小模型，灰区才会交给小模型判断；现在按规则得分决定。'));
      const { runDaemon } = await import('./run.js');
      await runDaemon(runCfg, runPath, {
        harness,
        cmd: v.cmd,
        harnessArgs: v['harness-arg']?.length ? v['harness-arg'] : undefined,
        cwd: v.cwd ?? process.cwd(),
        maxRunsPerHour: Math.floor(num('max-runs', 50)),
        timeoutMinutes: Number(v['run-timeout'] ?? 240) || 240,
        idleMinutes: Number(v['idle-timeout'] ?? 15) || 15,
        debounceSeconds: Number(v.debounce ?? 5) || 5,
        claim: {
          policy: claimPolicy as 'smart' | 'always' | 'off',
          maxActive: num('max-active', 2, 1),
          minScore: num('claim-min-score', 30),
          staggerMinutes: num('claim-stagger', 10),
        },
        session: {
          policy: policy as 'smart' | 'task' | 'shared' | 'new',
          threshold: num('reuse-threshold', 25),
          grayBand: num('gray-band', 10),
          contextMaxRatio: ratio,
          maxAgeHours: num('session-max-age', 72, 1),
          maxRuns: num('session-max-runs', 30, 1),
        },
        contextWindow: num('context-window', 200_000, 1000),
        cacheTtlMinutes: v['cache-ttl'] === undefined ? undefined : num('cache-ttl', 5, 1),
        judge: { mode: judge as 'off' | 'gray' | 'always', model: v['judge-model'], timeoutSeconds: num('judge-timeout', 60, 5) },
        interject: !v['no-interject'],
        skillPrompt: !v['no-skill-prompt'],
        dryRun: !!v['dry-run'],
      });
      return;
    }
    case 'mcp': {
      const { runStdioBridge } = await import('./mcp-bridge.js');
      await runStdioBridge(cfg, ident?.path ?? null);
      return;
    }
    default:
      die(tr('未知命令：{cmd}。运行 ahub --help 查看用法', { cmd }));
  }
}

main(process.argv.slice(2)).catch((err) => {
  if (err instanceof CliError) {
    console.error(tr('错误：{message}', { message: err.message }));
  } else if (String((err as { code?: string }).code).startsWith('ERR_PARSE_ARGS')) {
    // 参数写错时给一句中文提示，不打印调用栈
    console.error(tr('错误：{v}。运行 ahub {v2} --help 查看用法', { v: (err as Error).message.split('. ')[0], v2: process.argv[2] ?? '' }));
  } else {
    console.error(err);
  }
  process.exit(1);
});
