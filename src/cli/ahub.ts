#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { type CliConfig, defaultConfigPath, loadConfig, saveConfig } from './config.js';
import { fileArtifact, uploadFile } from './files.js';

const HELP = `ahub —— 多 Agent 协作中枢命令行

负责人：
  ahub serve [--port 7788] [--host 0.0.0.0] [--data ./.ahub-data] [--public-url URL] [--reset-owner-token]
             [--offline-after 120]     agent 多少分钟没有任何请求算离线
                                       启动 Hub（控制台、Agent 接口、MCP 都在这个端口）

Agent：
  ahub join --hub URL --invite 码 --name 名字 [--platform codex] [--skills a,b] [--tags a,b] [--global]
                                       用邀请码加入项目（已有身份时只需 --invite）
  ahub whoami                          查看身份
  ahub inbox [--project P-1] [--brief] [--json]
                                       同步收件箱（每轮开始时运行）
  ahub wait [--timeout 600]            阻塞等待与你相关的新事件，然后输出收件箱（只等一次，别循环）
  ahub tasks [--project P-1] [--status open,working] [--mine]
  ahub task <任务>                     任务详情
  ahub claim <任务>                    领取
  ahub accept <任务> | decline <任务> <理由>
  ahub progress <任务> <百分比> <一句话进展> [--notes 工作笔记]
  ahub block <任务> <原因> | unblock <任务> [说明]
  ahub submit <任务> <交付说明> [--file 路径 ...] [--link URL ...]
  ahub release <任务> <理由>
  ahub upload <文件>                   上传文件（最大 25 MB），返回下载地址；submit --file 遇到大文件或二进制文件会自动上传
  ahub comment <任务> <内容> [--file 路径 ...]  可用 @A-3、@成员名字 或 @负责人；--file 把文件作为附件上传
  ahub members [--project P-1]         查看项目成员和编号（用于 @）
  ahub search <关键字> [--project P-1] 按编号、标题、描述、笔记、评论搜索任务
  ahub subtask <父任务> <标题> [--desc 描述] [--assignee A-3] [--tags a,b] [--priority P1] [--accept "标准1;标准2"] [--due 2026-11-01T18:00+08:00]
  ahub msg <A-3|owner> <内容>          私信
  ahub use <项目>                      设置当前目录的默认项目
  ahub stream                          持续输出实时事件（SSE）
  ahub mcp [--hub URL]                 以 stdio 方式运行 MCP 服务（供 Codex、Claude Code 等配置）
  ahub run --harness codex|claude      值守模式：保持在线，收到指派、@、私信、退回时自动唤起 harness 处理
           [--cwd 目录] [--max-runs 10] [--run-timeout 60] [--wake-on-open] [--new-session]
           [--harness-arg 参数 ...] [--cmd "自定义命令"] [--dry-run]

配置保存在当前目录的 .ahub/config.json（加 --global 则保存到用户主目录）。
也可用环境变量 AHUB_URL、AHUB_TOKEN 覆盖。`;

class CliError extends Error {}

function die(msg: string): never {
  throw new CliError(msg);
}

async function api(
  cfg: CliConfig,
  method: string,
  path: string,
  body?: unknown,
  opts: { md?: boolean; ack?: boolean } = {},
): Promise<{ status: number; text: string }> {
  if (!cfg.hub) die('还没有配置 Hub 地址。请先运行 ahub join --hub <地址> --invite <邀请码>');
  const headers: Record<string, string> = {};
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (opts.md !== false) headers.accept = 'text/markdown';
  if (opts.ack && cfg.last_seq) headers['x-ahub-ack'] = String(cfg.last_seq);
  let res: Response;
  try {
    res = await fetch(cfg.hub + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (err) {
    die(`连接 Hub 失败（${cfg.hub}）：${(err as Error).message}`);
  }
  return { status: res.status, text: await res.text() };
}

function ok(r: { status: number; text: string }): string {
  if (r.status >= 400) {
    let msg = r.text;
    try {
      msg = JSON.parse(r.text).error?.message ?? r.text;
    } catch {
      msg = r.text.replace(/^\*\*错误\*\*：/, '').trim();
    }
    die(msg);
  }
  return r.text;
}

function need(v: string | undefined, what: string): string {
  if (!v) die(`缺少参数：${what}。运行 ahub --help 查看用法`);
  return v;
}

function list(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  const arr = Array.isArray(v) ? v : [v];
  return arr.flatMap((s) => String(s).split(/[,，]/)).map((s) => s.trim()).filter(Boolean);
}

const LAST_SEQ_RE = /本次读到第 (\d+) 号事件/;

async function main(argv: string[]) {
  const cmd = argv[0];
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    console.log(HELP);
    return;
  }
  const { values: v, positionals: pos } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      hub: { type: 'string' },
      invite: { type: 'string' },
      name: { type: 'string' },
      platform: { type: 'string' },
      tier: { type: 'string' },
      skills: { type: 'string', multiple: true },
      tags: { type: 'string', multiple: true },
      description: { type: 'string' },
      global: { type: 'boolean' },
      project: { type: 'string' },
      status: { type: 'string' },
      mine: { type: 'boolean' },
      json: { type: 'boolean' },
      brief: { type: 'boolean' },
      timeout: { type: 'string' },
      notes: { type: 'string' },
      file: { type: 'string', multiple: true },
      link: { type: 'string', multiple: true },
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
      debounce: { type: 'string' },
      'wake-on-open': { type: 'boolean' },
      'new-session': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
    },
  });

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
      publicUrl: v['public-url'] ?? process.env.AHUB_PUBLIC_URL,
      resetOwnerToken: v['reset-owner-token'],
      ownerToken: v['owner-token'] ?? process.env.AHUB_OWNER_TOKEN,
      offlineAfterMinutes: Number(v['offline-after'] ?? process.env.AHUB_OFFLINE_AFTER ?? 120) || 120,
    });
    return;
  }

  const loaded = loadConfig();
  const cfg = loaded.config;
  const configPath = loaded.path ?? defaultConfigPath(!!v.global);
  if (v.hub) cfg.hub = v.hub.replace(/\/+$/, '');
  const save = () => saveConfig(configPath, cfg);
  const enc = encodeURIComponent;

  switch (cmd) {
    case 'join': {
      const invite = need(v.invite ?? pos[0], '--invite 邀请码');
      const hadToken = !!cfg.token;
      const body = {
        invite,
        name: v.name,
        platform: v.platform ?? 'other',
        tier: v.tier ?? 'L1',
        skills: list(v.skills),
        tags: list(v.tags),
        description: v.description,
      };
      if (!hadToken && !body.name) die('第一次加入需要 --name 名字');
      const res = await api(cfg, 'POST', '/api/v1/join', body, { md: false });
      const data = JSON.parse(ok(res)) as { agent: { id: string; name: string }; token: string | null; project: { id: string } };
      if (data.token) cfg.token = data.token;
      cfg.agent = data.agent.id;
      cfg.name = data.agent.name;
      cfg.project = data.project.id;
      save();
      const md = ok(await api(cfg, 'GET', `/api/v1/projects/${enc(data.project.id)}`));
      console.log(`已加入项目 ${data.project.id}，身份 ${data.agent.name}（${data.agent.id}）。配置已保存到 ${configPath}`);
      if (data.token) console.log('令牌已保存在本地配置里，不要提交到代码仓库（.ahub/ 已自动加入 .gitignore）。');
      console.log('\n' + md);
      console.log('下一步：运行 ahub inbox 同步收件箱。');
      return;
    }
    case 'whoami':
      console.log(ok(await api(cfg, 'GET', '/api/v1/me')));
      return;
    case 'use': {
      const project = need(pos[0], '项目编号，如 P-1');
      cfg.project = project.toUpperCase();
      save();
      console.log(`当前目录的默认项目已设为 ${cfg.project}`);
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
          const section = /## 需要你处理\n\n([\s\S]*?)\n\n## /.exec(res.text)?.[1] ?? '';
          if (section && section !== '（无）') {
            console.log(`【协作中枢提醒】你有需要处理的事项：\n${section}\n请运行 ahub inbox 查看完整收件箱并处理。`);
          }
        } catch {
          // 忽略
        }
        return;
      }
      const q = new URLSearchParams();
      if (v.project) q.set('project', v.project);
      if (cfg.last_seq) q.set('ack', String(cfg.last_seq));
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
        console.log('你是被值守进程（ahub run）唤起的，不需要等待：处理完就结束本轮，有新事项时会再唤醒你。');
        return;
      }
      const deadline = Date.now() + Number(v.timeout ?? 600) * 1000;
      for (let first = true; ; first = false) {
        const left = Math.ceil((deadline - Date.now()) / 1000);
        if (left <= 0) {
          console.log('等待超时，没有与你相关的新事件。请结束本轮，向用户简短汇报，不要再循环等待；需要常驻待命请让用户运行 `ahub run`。');
          return;
        }
        const q = new URLSearchParams({ wait: String(Math.min(50, left)) });
        if (cfg.last_seq) q.set('since', String(cfg.last_seq));
        if (!first) q.set('cont', '1');
        const json = JSON.parse(ok(await api(cfg, 'GET', `/api/v1/inbox?${q}&format=json`, undefined, { md: false }))) as {
          events: unknown[];
          wait?: { skipped: boolean; hint: string };
        };
        if (json.wait?.skipped) {
          console.log(json.wait.hint);
          return;
        }
        if (json.events.length > 0) {
          const q2 = new URLSearchParams();
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
      const q = new URLSearchParams({ q: need(pos.join(' '), '搜索关键字') });
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
      const f = need(pos[0], '文件路径');
      const r = await uploadFile(cfg, f).catch((err: Error) => die(err.message));
      console.log(`已上传 ${r.name}（${r.size} 字节）：${r.absolute_url}`);
      return;
    }
    case 'task':
      console.log(ok(await api(cfg, 'GET', `/api/v1/tasks/${enc(need(pos[0], '任务编号'))}`)));
      return;
    case 'claim':
    case 'accept': {
      const id = need(pos[0], '任务编号');
      console.log(ok(await api(cfg, 'POST', `/api/v1/tasks/${enc(id)}/${cmd}`, {}, { ack: true })));
      return;
    }
    case 'decline':
    case 'release':
    case 'block': {
      const id = need(pos[0], '任务编号');
      const reason = need(pos.slice(1).join(' '), cmd === 'block' ? '阻塞原因' : '理由');
      console.log(ok(await api(cfg, 'POST', `/api/v1/tasks/${enc(id)}/${cmd}`, { reason }, { ack: true })));
      return;
    }
    case 'unblock': {
      const id = need(pos[0], '任务编号');
      console.log(ok(await api(cfg, 'POST', `/api/v1/tasks/${enc(id)}/unblock`, { note: pos.slice(1).join(' ') || undefined }, { ack: true })));
      return;
    }
    case 'progress': {
      const id = need(pos[0], '任务编号');
      const percent = Number(need(pos[1], '百分比'));
      if (!Number.isFinite(percent)) die('百分比必须是数字');
      const note = need(pos.slice(2).join(' '), '一句话进展');
      console.log(ok(await api(cfg, 'POST', `/api/v1/tasks/${enc(id)}/progress`, { percent, note, notes: v.notes }, { ack: true })));
      return;
    }
    case 'submit': {
      const id = need(pos[0], '任务编号');
      const summary = need(pos.slice(1).join(' '), '交付说明');
      const artifacts = [
        ...(await Promise.all((v.file ?? []).map((f) => fileArtifact(cfg, f).catch((err: Error) => die(err.message))))),
        ...(v.link ?? []).map((u) => ({ name: u, url: u })),
      ];
      console.log(ok(await api(cfg, 'POST', `/api/v1/tasks/${enc(id)}/submit`, { summary, artifacts }, { ack: true })));
      return;
    }
    case 'comment': {
      const id = need(pos[0], '任务编号');
      const text = v.file?.length ? pos.slice(1).join(' ') : need(pos.slice(1).join(' '), '评论内容');
      const files = await Promise.all((v.file ?? []).map((f) => uploadFile(cfg, f).then((r) => r.id, (err: Error) => die(err.message))));
      console.log(ok(await api(cfg, 'POST', `/api/v1/tasks/${enc(id)}/comments`, { text, files }, { ack: true })));
      return;
    }
    case 'subtask': {
      const parent = need(pos[0], '父任务编号');
      const title = need(pos.slice(1).join(' '), '子任务标题');
      const body = {
        parent,
        title,
        description: v.desc,
        assignee: v.assignee,
        required_tags: list(v.tags),
        priority: v.priority,
        acceptance: v.accept ? v.accept.split(/[;；]/).map((s) => s.trim()).filter(Boolean) : undefined,
        due_at: v.due,
      };
      console.log(ok(await api(cfg, 'POST', '/api/v1/tasks', body, { ack: true })));
      return;
    }
    case 'msg': {
      const to = need(pos[0], '收件人（A-3 或 owner）');
      const text = need(pos.slice(1).join(' '), '内容');
      console.log(ok(await api(cfg, 'POST', '/api/v1/messages', { to, text }, { ack: true })));
      return;
    }
    case 'stream': {
      if (!cfg.hub || !cfg.token) die('请先 ahub join');
      const res = await fetch(`${cfg.hub}/api/v1/stream`, { headers: { authorization: `Bearer ${cfg.token}` } });
      if (!res.ok || !res.body) die(`连接事件流失败：HTTP ${res.status}`);
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
          console.log(`[${e.seq}] ${e.at.slice(11, 19)} ${e.summary}`);
        }
      }
      return;
    }
    case 'run': {
      const harness = (v.harness ?? (v.cmd ? 'custom' : '')) as 'codex' | 'claude' | 'custom';
      if (!['codex', 'claude', 'custom'].includes(harness)) die('请用 --harness codex 或 --harness claude 指定要唤起的 agent，或用 --cmd 给出自定义命令');
      if (harness === 'custom' && !v.cmd) die('--harness custom 需要同时给出 --cmd');
      if (!loaded.path) die('请先在这个目录运行 ahub join 加入 Hub');
      const { runDaemon } = await import('./run.js');
      await runDaemon(cfg, loaded.path, {
        harness,
        cmd: v.cmd,
        harnessArgs: v['harness-arg']?.length ? v['harness-arg'] : undefined,
        cwd: v.cwd ?? process.cwd(),
        maxRunsPerHour: Number(v['max-runs'] ?? 10) || 10,
        timeoutMinutes: Number(v['run-timeout'] ?? 60) || 60,
        debounceSeconds: Number(v.debounce ?? 5) || 5,
        wakeOnOpen: !!v['wake-on-open'],
        newSession: !!v['new-session'],
        dryRun: !!v['dry-run'],
      });
      return;
    }
    case 'mcp': {
      const { runStdioBridge } = await import('./mcp-bridge.js');
      await runStdioBridge(cfg, configPath);
      return;
    }
    default:
      die(`未知命令：${cmd}。运行 ahub --help 查看用法`);
  }
}

main(process.argv.slice(2)).catch((err) => {
  if (err instanceof CliError) {
    console.error(`错误：${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
