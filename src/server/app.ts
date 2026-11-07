import { isIP } from 'node:net';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addCompression } from './compress.js';
import { type Actor, type AgentRow, Hub, HubError, type SessionRow, agentCode, taskSummary } from './hub.js';
import { renderArtifact, renderArtifactLog, renderInbox, renderJoin, renderMe, renderSearch, renderTask, renderTaskList } from './format.js';
import { handleMcpRequest } from './mcp-http.js';
import { renderReport, tasksCsv } from './report.js';
import { buildInstallPackage } from './pack.js';
import { NOTIFY_TOPICS, type Notifier } from './notify.js';
import type { Tagger } from './tagger.js';
import type { HubEvent, Part } from '../shared/model.js';
import { type Lang, currentLang, normalizeLang, tr, withLang } from '../i18n/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface AppOptions {
  /** 写进接入说明里的对外地址，例如 http://192.168.1.10:7788 */
  publicUrl?: string;
  /** 控制台静态文件目录；不存在时不提供控制台 */
  webDir?: string;
  logger?: boolean;
  /** 长轮询最长挂起秒数 */
  maxWaitSeconds?: number;
  /** 上传文件的保存目录；不设置时不提供上传 */
  filesDir?: string;
  /** 外部通知（钉钉机器人）；不设置时不提供通知设置接口 */
  notifier?: Notifier;
  /** 发布任务时用外部模型自动打标签；不设置时不提供模型设置接口 */
  tagger?: Tagger;
  /** 信任的反向代理（IP 或网段，逗号分隔）：从这些地址来的请求才看 X-Forwarded-For */
  trustProxy?: string;
}

/** 校验 --trust-proxy / AHUB_TRUST_PROXY。不接受 true 和跳数：那样谁都能伪造来源 IP。 */
export function parseTrustProxy(v?: string): string | undefined {
  const s = v?.trim();
  if (!s) return undefined;
  const items = s.split(',').map((x) => x.trim());
  for (const item of items) {
    const [ip, bits, ...rest] = item.split('/');
    const family = isIP(ip);
    const ok = family !== 0 && !rest.length && (bits === undefined || (/^\d+$/.test(bits) && Number(bits) <= (family === 4 ? 32 : 128)));
    if (!ok) throw new Error(tr('AHUB_TRUST_PROXY（--trust-proxy）只能写反向代理的 IP 或网段，多个用逗号分隔，例如 172.18.0.0/16；不能用「{item}」', { item }));
  }
  return items.join(',');
}

/** 控制台的内容安全策略：脚本只能来自本站。React 的 style 属性和构建产物都不需要内联脚本。 */
const CONSOLE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

declare module 'fastify' {
  interface FastifyRequest {
    agent?: AgentRow;
    /** 这次请求用的授权 ID */
    session?: SessionRow;
    isOwner?: boolean;
    /** 上传者：owner 或 agent 编号 */
    uploader?: string;
  }
}

type Q = Record<string, string | undefined>;
type B = Record<string, unknown>;

/** 令牌只从请求头读：URL 会被反向代理的访问日志和浏览器历史记下来。 */
function tokenOf(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (h && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  return null;
}

function wantsMarkdown(req: FastifyRequest) {
  const q = req.query as Q;
  if (q?.format === 'md') return true;
  if (q?.format === 'json') return false;
  return (req.headers.accept ?? '').includes('text/markdown');
}

function send(req: FastifyRequest, reply: FastifyReply, data: unknown, md?: () => string) {
  if (md && wantsMarkdown(req)) return reply.type('text/markdown; charset=utf-8').send(md());
  return reply.send(data);
}

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? undefined : String(v));
const strArr = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === 'string' && v ? v.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : undefined;

function requestLang(req: FastifyRequest): Lang {
  const header = req.headers['x-ahub-lang'];
  const query = (req.query as Record<string, string | undefined> | undefined)?.lang;
  const accept = String(req.headers['accept-language'] ?? '').split(',')[0];
  return normalizeLang(Array.isArray(header) ? header[0] : header) ?? normalizeLang(query) ?? normalizeLang(accept) ?? 'zh';
}

export function buildApp(hub: Hub, opts: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 5 * 1024 * 1024, forceCloseConnections: true, trustProxy: opts.trustProxy ?? false });
  const maxWait = opts.maxWaitSeconds ?? 50;
  const publicUrl = (req: FastifyRequest) => opts.publicUrl ?? `${req.protocol}://${req.headers.host}`;

  // 每个请求按请求方的语言处理：x-ahub-lang 请求头（控制台和命令行会带）> ?lang= > Accept-Language > 中文。
  // 旧版命令行不带语言，仍然是中文。
  app.addHook('onRequest', (req, _reply, done) => withLang(requestLang(req), done));
  app.addHook('onRequest', (_req, reply, done) => {
    reply.headers({
      'content-security-policy': CONSOLE_CSP,
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    done();
  });
  // 不存在的接口不读请求体：解析请求体发生在处理之前，不拦的话谁都能让 Hub 把大请求读进内存
  app.addHook('onRequest', async (req, reply) => {
    if (req.is404 && req.method !== 'GET' && req.method !== 'HEAD') {
      return reply.status(404).send({ error: { code: 'not_found', message: tr('接口不存在') } });
    }
  });
  addCompression(app);

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    const status = err instanceof HubError ? err.status : (err.statusCode ?? 500);
    const code = err instanceof HubError ? err.code : status === 500 ? 'internal' : 'bad_request';
    const message = status === 500 ? tr('服务器内部错误') : err.message;
    if (status === 500) req.log.error(err);
    // Markdown 错误里看不到错误码，放在响应头里，命令行据此判断授权 ID 能否自动重连
    reply.header('x-ahub-error', code);
    if (wantsMarkdown(req)) return reply.status(status).type('text/markdown; charset=utf-8').send(tr('**错误**：{message}\n', { message }));
    return reply.status(status).send({ error: { code, message } });
  });

  // ── 鉴权 ──
  // 鉴权都放在 onRequest：Fastify 在 preHandler 之前就把请求体读进内存了，
  // 放在后面的话，不带令牌的大请求也会占满内存。
  const requireAgent = async (req: FastifyRequest) => {
    const token = tokenOf(req);
    if (!token) throw new HubError(401, 'unauthorized', tr('缺少授权 ID：先用身份码换取（POST /api/v1/sessions）'));
    const { agent, session } = hub.authSession(token);
    req.agent = agent;
    req.session = session;
  };
  /** 请求体也没问题了才算一次活动和确认：格式错误的请求不能把收件箱标成已读。 */
  const touchAgent = async (req: FastifyRequest) => {
    const agent = req.agent!;
    hub.touchAgent(agent);
    const ack = (req.query as Q)?.ack ?? (req.headers['x-ahub-ack'] as string | undefined);
    if (ack !== undefined && /^\d+$/.test(ack)) hub.ack(agent, Number(ack));
  };
  const ownerBlocked = (req: FastifyRequest, reply: FastifyReply) => {
    const ms = hub.ownerBlockedMs(req.ip);
    reply.header('retry-after', Math.ceil(ms / 1000));
    const minutes = Math.ceil(ms / 60_000);
    const time = minutes < 60 ? tr('{n} 分钟', { n: minutes }) : tr('{n} 小时', { n: Math.ceil(minutes / 60) });
    return new HubError(429, 'too_many_attempts', tr('令牌错误次数太多，请 {time}后再试', { time }));
  };
  /** 封禁中要不要挡住这个正确的令牌。没配置信任的代理却带着转发头时，req.ip 是大家共用的代理地址，挡了等于谁都能把负责人关在外面。 */
  const blocksValidOwner = (req: FastifyRequest) => hub.ownerBlockedMs(req.ip) > 0 && (!!opts.trustProxy || req.headers['x-forwarded-for'] === undefined);
  const requireOwner = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenOf(req);
    const valid = !!token && hub.isOwnerToken(token);
    if (valid ? blocksValidOwner(req) : hub.ownerBlockedMs(req.ip) > 0) throw ownerBlocked(req, reply);
    const login = req.routeOptions.url === '/api/v1/admin/login';
    if (!valid) {
      // 没带令牌（已退出的页面、扫描器）不算输错
      if (token && hub.noteOwnerFailure(req.ip, token, login)) throw ownerBlocked(req, reply);
      throw new HubError(401, 'unauthorized', tr('需要负责人令牌'));
    }
    if (login) hub.clearOwnerFailures(req.ip);
    req.isOwner = true;
  };
  const actorOf = (req: FastifyRequest): Actor => (req.isOwner ? { kind: 'owner' } : { kind: 'agent', agent: req.agent! });

  // ── 公共 ──
  app.get('/api/v1/health', async () => ({ ok: true, name: 'ahub', last_seq: hub.lastSeq() }));

  app.get('/skill.md', async (req, reply) => {
    const file = join(ROOT, 'skill', currentLang() === 'en' ? 'SKILL.en.md' : 'SKILL.md');
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '# ahub\n';
    return reply.type('text/markdown; charset=utf-8').send(text.replaceAll('{{HUB_URL}}', publicUrl(req)));
  });

  // ahub 命令行安装包，由 Hub 自身的构建产物打成，版本与 Hub 一致
  let installPackage: Buffer | null | undefined;
  app.get('/ahub.tgz', async (_req, reply) => {
    if (installPackage === undefined) installPackage = buildInstallPackage(ROOT);
    if (!installPackage) throw new HubError(404, 'not_found', tr('这个 Hub 没有可用的安装包（缺少构建产物，先运行 npm run build）'));
    return reply.type('application/gzip').header('content-disposition', 'attachment; filename="ahub.tgz"').send(installPackage);
  });

  // ── Agent 接口 ──
  // 这两个接口不需要登录，请求体只有几个短字段，上限定小一点
  const PUBLIC_BODY_LIMIT = 64 * 1024;
  app.post('/api/v1/join', { bodyLimit: PUBLIC_BODY_LIMIT }, async (req, reply) => {
    const body = (req.body ?? {}) as B;
    const token = tokenOf(req);
    const existing = token ? hub.authSession(token).agent : null;
    const r = hub.join(
      {
        invite: str(body.invite) ?? '',
        name: str(body.name),
        platform: str(body.platform),
        tier: str(body.tier),
        description: str(body.description),
        skills: strArr(body.skills),
        tags: strArr(body.tags),
      },
      existing,
    );
    reply.status(201);
    return send(req, reply, { agent: r.agent, code: r.code, project: r.project }, () => renderJoin(r, publicUrl(req)));
  });

  // 用身份码换授权 ID：每次连接（ahub run 启动、MCP 桥启动、命令行第一次调用）换一个
  app.post('/api/v1/sessions', { bodyLimit: PUBLIC_BODY_LIMIT }, async (req, reply) => {
    const b = (req.body ?? {}) as B;
    const r = hub.openSession({
      code: str(b.code) ?? '',
      client: str(b.client),
      host: str(b.host),
      cwd: str(b.cwd),
      ip: req.ip,
      takeover: b.takeover === true || b.takeover === 'true',
      name: str(b.name),
      platform: str(b.platform),
      tier: str(b.tier),
      description: str(b.description),
      skills: strArr(b.skills),
      tags: strArr(b.tags),
    });
    reply.status(201);
    return r;
  });

  app.register(async (agentApi) => {
    agentApi.addHook('onRequest', requireAgent);
    agentApi.addHook('preHandler', touchAgent);

    // 进程退出时交还授权 ID，立即下线
    agentApi.delete('/api/v1/sessions/current', async (req) => hub.releaseSession(req.session!));

    agentApi.get('/api/v1/me', async (req, reply) => {
      const view = hub.agentView(req.agent!);
      return send(req, reply, { ...view, ack_seq: req.agent!.ack_seq }, () => renderMe(view));
    });

    agentApi.patch('/api/v1/me', async (req) => {
      const body = (req.body ?? {}) as B;
      return hub.updateAgent(actorOf(req), agentCode(req.agent!.id), {
        name: str(body.name),
        description: str(body.description),
        skills: strArr(body.skills),
        tier: str(body.tier),
      });
    });

    agentApi.get('/api/v1/inbox', async (req, reply) => {
      const q = req.query as Q;
      const agent = req.agent!;
      const since = q.since !== undefined && /^\d+$/.test(q.since) ? Number(q.since) : undefined;
      const wait = Math.min(Math.max(Number(q.wait ?? 0) || 0, 0), maxWait);
      // mark=1：交互式会话读收件箱，给读到的待处理事项打「处理中」的回执
      const mark = q.mark === '1';
      let result = hub.inbox(agent, { since, project: q.project, mark });
      if (wait > 0 && result.events.length === 0) {
        // cont=1 是 ahub wait 内部的续等，不算 agent 又调用了一次
        const cont = q.cont === '1';
        // resident=1 是交互式会话里的常驻待命（ahub wait --resident），不受连续落空的限制
        const resident = q.resident === '1';
        if (resident) hub.noteResident(agent.id);
        const idle = hub.idleWaits(agent.id);
        const daemon = hub.hasDaemon(agent.id);
        const skip = daemon || (!resident && !cont && idle >= 2);
        if (!skip) {
          await waitForEvent(hub, agent, wait * 1000, req);
          result = hub.inbox(agent, { since, project: q.project, mark });
        }
        if (result.events.length === 0) {
          if (!cont && !resident) hub.noteWait(agent.id, true);
          result.wait = {
            skipped: skip,
            hint: daemon
              ? tr('你的值守进程（ahub run）在线，有新事项会自动唤醒你。不用等待，直接结束本轮。')
              : resident
                ? tr('这次等待没有新事件。你在常驻待命：立即再运行一次 `ahub wait --resident` 继续等待。')
                : skip
                ? tr('你已经连续 {v} 次等待都没有新事件。不要再循环等待：结束本轮，向用户简短汇报即可。需要常驻待命请让用户在工作目录运行 `ahub run`。', { v: idle + 1 })
                : tr('这次等待没有新事件。可以结束本轮了，不要反复调用等待；需要常驻待命请让用户运行 `ahub run`。'),
          };
        }
      }
      if (result.events.length > 0) hub.noteWait(agent.id, false);
      return send(req, reply, result, () => renderInbox(result));
    });

    agentApi.get('/api/v1/stream', async (req, reply) => {
      const agent = req.agent!;
      const lastId = Number(req.headers['last-event-id'] ?? (req.query as Q).since ?? agent.ack_seq) || 0;
      if ((req.query as Q).daemon === '1') {
        hub.markDaemon(agent.id, 1);
        req.raw.on('close', () => hub.markDaemon(agent.id, -1));
      }
      streamEvents(hub, req, reply, lastId, (e) => hub.canSee(agent, e), () => hub.eventsForAgent(agent, lastId, 1000).events, agent.id, req.session!.id);
    });

    // ahub run 守护进程上报自己被唤醒/处理完毕
    agentApi.post('/api/v1/me/runs', async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return hub.recordRun(req.agent!, {
        started_at: str(b.started_at),
        ended_at: str(b.ended_at),
        code: typeof b.code === 'number' ? b.code : null,
        trigger: str(b.trigger),
        summary: str(b.summary),
        harness: str(b.harness),
        session: str(b.session),
      });
    });

    agentApi.post('/api/v1/me/receipts', async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return hub.markReceipts(req.agent!, {
        state: str(b.state),
        note: str(b.note),
        seqs: Array.isArray(b.seqs) ? b.seqs.map(Number) : undefined,
        tasks: strArr(b.tasks),
      });
    });

    // 只是告知、不用回复的 @ 和私信：标为已读（回执直接变成已处理）
    agentApi.post('/api/v1/me/seen', async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return hub.markSeen(req.agent!, { seqs: Array.isArray(b.seqs) ? b.seqs.map(Number) : undefined });
    });

    agentApi.post('/api/v1/me/activity', async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return hub.reportActivity(req.agent!, { state: str(b.state), note: str(b.note) });
    });

    agentApi.get('/api/v1/projects', async (req) => hub.agentView(req.agent!).projects);

    agentApi.get('/api/v1/projects/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const p = hub.getProject(id);
      if (!hub.agentView(req.agent!).projects.some((x) => x.id === p.id)) throw new HubError(403, 'forbidden', tr('你不是项目 {id} 的成员', { id }));
      return send(req, reply, p, () => tr('# {id}「{name}」\n\n## 项目说明（负责人撰写）\n\n{v}\n\n## 成员\n\n{v2}\n', { id: p.id, name: p.name, v: p.description || tr('（无）'), v2: p.members_list.map((a) => tr('- {name}（{id}）· {platform}', { name: a.name, id: a.id, platform: a.platform })).join('\n') }));
    });

    agentApi.get('/api/v1/members', async (req, reply) => {
      const want = (req.query as Q).project?.toUpperCase();
      const mine = hub.agentView(req.agent!).projects.filter((x) => !want || x.id === want);
      if (want && !mine.length) throw new HubError(403, 'forbidden', tr('你不是项目 {want} 的成员', { want }));
      const list = mine.map((x) => {
        const p = hub.getProject(x.id);
        return {
          project: p.id,
          name: p.name,
          members: p.members_list.map((a) => {
            const r = hub.reachability(a.id);
            return { id: a.id, name: a.name, platform: a.platform, online: a.online, reachable: r.ok, state: r.label, tags: a.projects.find((y) => y.id === p.id)?.tags ?? [] };
          }),
        };
      });
      return send(req, reply, list, () =>
        list
          .map(
            (p) =>
              tr('# {project}「{name}」的成员\n\n', { project: p.project, name: p.name }) +
              p.members.map((a) => tr('- {name}（{id}）· {platform}{v}', { name: a.name, id: a.id, platform: a.platform, v: a.tags.length ? tr(' · 标签：{tags}', { tags: a.tags.join(tr('、')) }) : '' }) + ` · ${a.state}`).join('\n') +
              '\n',
          )
          .join('\n') +
          tr('\n评论里用 @编号（如 @A-3）或 @完整名字 提及成员，@负责人 提及负责人。\n') +
          tr('「值守中」「常驻待命」「在线」的成员能很快看到指派和 @；其他状态的可能要等它下次上线，派工前留意。\n'),
      );
    });

    agentApi.get('/api/v1/tasks', async (req, reply) => {
      const q = req.query as Q;
      const tasks = hub.listTasks(actorOf(req), { project: q.project, status: q.status, mine: q.mine === '1' || q.mine === 'true', parent: q.parent });
      return send(req, reply, tasks, () => renderTaskList(tasks));
    });

    agentApi.get('/api/v1/search', async (req, reply) => {
      const q = req.query as Q;
      const r = hub.search(actorOf(req), q.q ?? '', q.project);
      return send(req, reply, r, () => renderSearch(r));
    });

    agentApi.get('/api/v1/tasks/:id', async (req, reply) => {
      const t = hub.getTaskFor(actorOf(req), (req.params as { id: string }).id);
      return send(req, reply, t, () => renderTask(t, publicUrl(req)));
    });

    const action = (
      path: string,
      fn: (agent: AgentRow, id: string, body: B) => unknown,
      done: (r: unknown, agent: AgentRow) => string,
    ) =>
      agentApi.post(path, async (req, reply) => {
        const id = (req.params as { id?: string }).id ?? '';
        const key = req.headers['idempotency-key'] as string | undefined;
        const result = hub.idempotent(req.agent!, key, () => fn(req.agent!, id, (req.body ?? {}) as B));
        return send(req, reply, result, () => done(result, req.agent!));
      });

    const taskDone = (verb: string) => (r: unknown) => {
      const t = r as { id: string; title: string; status_label: string; progress: number };
      return tr('已{verb}：**{id}** {title}（当前状态：{status_label}，进度 {progress}%）\n', { verb, id: t.id, title: t.title, status_label: t.status_label, progress: t.progress });
    };

    action('/api/v1/tasks/:id/claim', (a, id) => hub.claim(a, id), taskDone(tr('领取')));
    action(
      '/api/v1/tasks/:id/pass',
      (a, id, b) => hub.pass(a, id, str(b.reason) ?? ''),
      (r) => {
        const x = r as { task: string; remaining: number };
        return tr('已让出 {task}。{v}\n', { task: x.task, v: x.remaining ? tr('还有 {remaining} 个 agent 可以领取它。', { remaining: x.remaining }) : tr('没有其他 agent 可以自动领取了，已提醒负责人。') });
      },
    );
    // 创建子任务的 agent 验收、退回、归档自己拆出来的子任务（规则见 hub.reviewer）；归档沿用 cancel 路径，archive 是别名
    action('/api/v1/tasks/:id/approve', (a, id, b) => hub.approve(id, str(b.comment), { kind: 'agent', agent: a }), taskDone(tr('验收通过')));
    action('/api/v1/tasks/:id/reject', (a, id, b) => hub.reject(id, str(b.reason) ?? '', { kind: 'agent', agent: a }), taskDone(tr('退回')));
    for (const verb of ['cancel', 'archive'])
      action(`/api/v1/tasks/:id/${verb}`, (a, id, b) => hub.cancel(id, str(b.reason), { kind: 'agent', agent: a }), taskDone(tr('归档')));
    action('/api/v1/tasks/:id/accept', (a, id) => hub.accept(a, id), taskDone(tr('接受')));
    action('/api/v1/tasks/:id/decline', (a, id, b) => hub.decline(a, id, str(b.reason) ?? ''), taskDone(tr('拒绝')));
    action(
      '/api/v1/tasks/:id/progress',
      (a, id, b) =>
        hub.progress(a, id, {
          percent: b.percent === undefined ? undefined : Number(b.percent),
          note: str(b.note) ?? '',
          notes: str(b.notes),
        }),
      taskDone(tr('上报进度')),
    );
    action('/api/v1/tasks/:id/block', (a, id, b) => hub.block(a, id, str(b.reason) ?? '', strArr(b.options) ?? []), taskDone(tr('标记阻塞')));
    action('/api/v1/tasks/:id/unblock', (a, id, b) => hub.unblock({ kind: 'agent', agent: a }, id, str(b.note)), taskDone(tr('解除阻塞')));
    action('/api/v1/tasks/:id/answer', (a, id, b) => hub.answer(id, str(b.answer) ?? '', { kind: 'agent', agent: a }), taskDone(tr('回答问题')));
    action(
      '/api/v1/tasks/:id/submit',
      (a, id, b) => hub.submit(a, id, { summary: str(b.summary) ?? '', artifacts: parseArtifacts(hub, b.artifacts) }),
      taskDone(tr('提交验收')),
    );
    action('/api/v1/tasks/:id/release', (a, id, b) => hub.release(a, id, str(b.reason) ?? ''), taskDone(tr('放弃')));
    action(
      '/api/v1/tasks/:id/comments',
      (a, id, b) => hub.comment({ kind: 'agent', agent: a }, id, str(b.text) ?? '', strArr(b.files)),
      () => tr('已发表评论。\n'),
    );
    action(
      '/api/v1/tasks',
      (a, _id, b) =>
        hub.createTask(
          { kind: 'agent', agent: a },
          {
            parent: str(b.parent),
            title: str(b.title) ?? '',
            description: str(b.description),
            acceptance: strArr(b.acceptance),
            priority: str(b.priority),
            assignee: str(b.assignee) ?? null,
            required_tags: strArr(b.required_tags),
            depends_on: strArr(b.depends_on),
            refs: strArr(b.refs),
            files: strArr(b.files),
            due_at: str(b.due_at) ?? null,
          },
        ),
      (r, a) => {
        const t = r as { id: string; title: string; status_label: string; assignee: string | null; assignee_name: string | null };
        let text = tr('已创建子任务 **{id}** {title}（{status_label}）\n', { id: t.id, title: t.title, status_label: t.status_label });
        // 指派给了现在叫不醒的 agent：提醒一下，免得任务挂着没人做
        const reach = t.assignee && t.assignee !== `A-${a.id}` ? hub.reachability(t.assignee) : null;
        if (reach && !reach.ok) {
          text += tr(
            '\n> 提醒：{name}（{id}）当前「{label}」，收到指派可能不会及时响应（只有值守进程在线、常驻待命或最近 10 分钟有活动的 agent 才会很快看到）。可以改派给能响应的 agent、自己做，或 @负责人 请他启动它。\n',
            { name: t.assignee_name ?? t.assignee, id: t.assignee, label: reach.label },
          );
        }
        return text;
      },
    );
    // 交付物：读取、修改记录、整份替换（PUT）和局部修改（PATCH），都按版本号做冲突检测
    agentApi.get('/api/v1/tasks/:id/artifacts/:aid', async (req, reply) => {
      const { id, aid } = req.params as { id: string; aid: string };
      const rev = (req.query as Q).rev;
      const a = hub.getArtifact(actorOf(req), id, aid, rev ? Number(rev) : undefined);
      return send(req, reply, a, () => renderArtifact(id.toUpperCase(), a, publicUrl(req)));
    });
    agentApi.get('/api/v1/tasks/:id/artifacts/:aid/revisions', async (req, reply) => {
      const { id, aid } = req.params as { id: string; aid: string };
      const revs = hub.artifactRevisions(actorOf(req), id, aid);
      return send(req, reply, revs, () => renderArtifactLog(id.toUpperCase(), aid, revs));
    });
    for (const method of ['put', 'patch'] as const)
      agentApi[method]('/api/v1/tasks/:id/artifacts/:aid', async (req, reply) => {
        const { id, aid } = req.params as { id: string; aid: string };
        const key = req.headers['idempotency-key'] as string | undefined;
        const a = hub.idempotent(req.agent!, key, () => hub.updateArtifact(actorOf(req), id, aid, artifactUpdate(hub, method, (req.body ?? {}) as B)));
        return send(req, reply, a, () => tr('已把交付物 #{id}「{name}」改到第 {rev} 版。\n', { id: a.id, name: a.name, rev: a.rev }));
      });
    agentApi.post('/api/v1/invites', async (req, reply) => {
      const b = (req.body ?? {}) as B;
      const r = hub.agentInvite(
        req.agent!,
        { project: str(b.project), task: str(b.task), note: str(b.note) ?? '', name: str(b.name), tags: strArr(b.tags), harness: str(b.harness) },
        publicUrl(req),
      );
      return send(req, reply, r, () =>
        tr('已新建身份 {v}（{id}，项目 {project}）并通知了负责人。负责人会在控制台复制启动命令拉起它；拉起之前它是离线的，先不要指派任务给它。\n', { v: r.agent.name || tr('（待命名）'), id: r.agent.id, project: r.project }),
      );
    });
    action(
      '/api/v1/messages',
      (a, _id, b) => hub.message({ kind: 'agent', agent: a }, str(b.to) ?? '', str(b.text) ?? str(b.body) ?? ''),
      () => tr('私信已发送。\n'),
    );
  });

  // ── 文件上传与下载 ──
  const MAX_UPLOAD = 25 * 1024 * 1024;
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  const requireUploader = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!opts.filesDir) throw new HubError(501, 'unsupported', tr('这个 Hub 没有开启文件上传'));
    const token = tokenOf(req);
    if (token && hub.isOwnerToken(token)) {
      if (blocksValidOwner(req)) throw ownerBlocked(req, reply);
      req.uploader = 'owner';
    } else if (token) {
      let session: ReturnType<Hub['authSession']>;
      try {
        session = hub.authSession(token);
      } catch (err) {
        // 既不是负责人令牌，也不是见过的授权 ID：这里也能试令牌，一样要计数
        if (err instanceof HubError && err.code === 'unauthorized') hub.noteOwnerFailure(req.ip, token);
        throw err;
      }
      hub.touchAgent(session.agent);
      req.uploader = agentCode(session.agent.id);
    }
    if (!req.uploader) throw new HubError(401, 'unauthorized', tr('缺少或无效的令牌'));
  };
  app.post('/api/v1/files', { bodyLimit: MAX_UPLOAD, onRequest: requireUploader }, async (req, reply) => {
    const filesDir = opts.filesDir!;
    const uploader = req.uploader!;
    if (!Buffer.isBuffer(req.body)) throw new HubError(400, 'invalid', tr('请用 Content-Type: application/octet-stream 上传文件内容'));
    const q = req.query as Q;
    const name = q.name ?? (req.headers['x-file-name'] ? decodeURIComponent(String(req.headers['x-file-name'])) : 'file');
    const mime = q.mime ?? guessMime(name);
    const part = hub.recordFile(uploader, { name, mime, size: req.body.length });
    mkdirSync(filesDir, { recursive: true });
    writeFileSync(join(filesDir, part.url!.slice('/files/'.length)), req.body);
    reply.status(201);
    return { ...part, id: part.url!.slice('/files/'.length), absolute_url: publicUrl(req) + part.url };
  });
  // 下载地址本身难以猜测，相当于一次性分享链接，方便控制台和 agent 直接打开
  app.get('/files/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const f = /^[\w-]{10,64}$/.test(id) ? hub.getFile(id) : null;
    const path = f && opts.filesDir ? join(opts.filesDir, f.id) : null;
    if (!f || !path || !existsSync(path)) throw new HubError(404, 'not_found', tr('找不到这个文件'));
    const inline = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain)$/.test(f.mime);
    reply
      .header('content-type', f.mime === 'text/plain' ? 'text/plain; charset=utf-8' : f.mime)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'")
      .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    return reply.send(createReadStream(path));
  });

  // ── MCP（Streamable HTTP，无状态） ──
  const requireMcpAgent = async (req: FastifyRequest) => {
    const token = tokenOf(req);
    if (!token) throw new HubError(401, 'unauthorized', tr('缺少授权 ID（请求头 Authorization: Bearer <授权 ID>）；推荐用 ahub mcp 桥接，它会自动用身份码换取'));
    const { agent } = hub.authSession(token);
    hub.touchAgent(agent);
  };
  app.all('/mcp', { onRequest: requireMcpAgent }, async (req, reply) => {
    await handleMcpRequest(app, req, reply, tokenOf(req)!);
  });

  // ── 负责人接口 ──
  app.register(async (admin) => {
    admin.addHook('onRequest', requireOwner);
    const A = '/api/v1/admin';

    // 控制台登录框用：令牌校验在 requireOwner 里，每次输错都计数
    admin.post(`${A}/login`, async () => ({ ok: true }));
    admin.get(`${A}/overview`, async (req) => hub.overview((req.query as Q).project));
    admin.post(`${A}/owner-inbox/read`, async (req) => {
      const b = (req.body ?? {}) as B;
      return hub.markOwnerRead({
        seqs: Array.isArray(b.seqs) ? b.seqs.map(Number) : undefined,
        task: str(b.task),
        from: str(b.from),
        type: str(b.type),
        project: str(b.project),
      });
    });
    admin.get(`${A}/search`, async (req) => {
      const q = req.query as Q;
      return hub.search({ kind: 'owner' }, q.q ?? '', q.project);
    });
    admin.get(`${A}/export/report`, async (req, reply) => {
      const q = req.query as Q;
      const md = renderReport(hub, { project: q.project, days: Math.min(Math.max(Number(q.days) || 7, 1), 90) });
      return reply.type('text/markdown; charset=utf-8').send(md);
    });
    admin.get(`${A}/export/tasks.csv`, async (req, reply) => {
      const csv = tasksCsv(hub, (req.query as Q).project);
      return reply.type('text/csv; charset=utf-8').send(csv);
    });
    admin.get(`${A}/recommend`, async (req) => {
      const q = req.query as Q;
      return hub.recommend({ project: q.project, task: q.task, title: q.title, tags: q.tags?.split(/[,，\s]+/) });
    });
    admin.get(`${A}/stats`, async (req) => {
      const q = req.query as Q;
      return hub.stats(q.project, Math.min(Math.max(Number(q.days) || 14, 1), 90));
    });
    admin.get(`${A}/info`, async (req) => {
      if (opts.publicUrl) return { urls: [opts.publicUrl] };
      const port = /:(\d+)$/.exec(req.headers.host ?? '')?.[1] ?? '80';
      const ips = Object.values(networkInterfaces())
        .flat()
        .filter((a) => a && a.family === 'IPv4' && !a.internal)
        .map((a) => a!.address);
      return { urls: [...ips.map((ip) => `http://${ip}:${port}`), `${req.protocol}://${req.headers.host}`] };
    });
    admin.get(`${A}/stream`, async (req, reply) => {
      const lastId = Number(req.headers['last-event-id'] ?? (req.query as Q).since ?? hub.lastSeq()) || 0;
      streamEvents(hub, req, reply, lastId, () => true, () => hub.eventsForOwner({ after: lastId, limit: 500 }), null);
    });
    admin.get(`${A}/events`, async (req) => {
      const q = req.query as Q;
      return hub.eventsForOwner({
        project: q.project,
        before: q.before ? Number(q.before) : undefined,
        after: q.after ? Number(q.after) : undefined,
        limit: q.limit ? Number(q.limit) : 100,
        inbox: q.inbox === '1',
      });
    });

    const notifier = opts.notifier;
    if (notifier) {
      const channelInput = (b: B) => ({
        name: str(b.name),
        kind: str(b.kind),
        webhook: str(b.webhook),
        secret: b.secret === null ? '-' : str(b.secret),
        topics: strArr(b.topics),
        projects: strArr(b.projects),
        console_url: str(b.console_url),
        enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
      });
      const cid = (req: FastifyRequest) => Number((req.params as { id: string }).id);
      admin.get(`${A}/notify/channels`, async () => ({ channels: notifier.list(), topics: Object.fromEntries(Object.entries(NOTIFY_TOPICS).map(([k, v]) => [k, tr(v)])) }));
      admin.post(`${A}/notify/channels`, async (req) => notifier.create(channelInput((req.body ?? {}) as B)));
      admin.patch(`${A}/notify/channels/:id`, async (req) => notifier.update(cid(req), channelInput((req.body ?? {}) as B)));
      admin.delete(`${A}/notify/channels/:id`, async (req) => notifier.remove(cid(req)));
      admin.post(`${A}/notify/channels/:id/test`, async (req) => notifier.test(cid(req)));
    }
    admin.get(`${A}/tags`, async () => hub.tagOptions());
    admin.put(`${A}/tags/presets`, async (req) => ({ presets: hub.setPresetTags(strArr(((req.body ?? {}) as B).presets) ?? []) }));
    const tagger = opts.tagger;
    if (tagger) {
      const llmInput = (b: B) => ({
        base_url: str(b.base_url),
        model: str(b.model),
        api_key: b.api_key === null ? '' : str(b.api_key) || undefined,
        auto_tag: typeof b.auto_tag === 'boolean' ? b.auto_tag : undefined,
      });
      admin.get(`${A}/llm`, async () => tagger.view());
      admin.put(`${A}/llm`, async (req) => tagger.update(llmInput((req.body ?? {}) as B)));
      admin.post(`${A}/llm/test`, async (req) => tagger.test(llmInput((req.body ?? {}) as B)));
      admin.post(`${A}/tasks/:id/auto-tag`, async (req) => tagger.tagTask((req.params as { id: string }).id));
    }
    admin.get(`${A}/templates`, async () => hub.listTemplates());
    const templateInput = (b: B) => ({
      name: str(b.name),
      title: str(b.title),
      description: str(b.description),
      acceptance: strArr(b.acceptance),
      priority: str(b.priority),
      required_tags: strArr(b.required_tags),
      subtasks: strArr(b.subtasks),
      chain: b.chain === true,
    });
    admin.post(`${A}/templates`, async (req) => hub.saveTemplate(templateInput((req.body ?? {}) as B)));
    admin.put(`${A}/templates/:id`, async (req) =>
      hub.saveTemplate({ ...templateInput((req.body ?? {}) as B), id: Number((req.params as { id: string }).id) }),
    );
    admin.delete(`${A}/templates/:id`, async (req) => hub.deleteTemplate(Number((req.params as { id: string }).id)));
    admin.get(`${A}/projects`, async () => hub.listProjects());
    admin.post(`${A}/projects`, async (req, reply) => {
      const b = (req.body ?? {}) as B;
      reply.status(201);
      return hub.createProject({ name: str(b.name) ?? '', description: str(b.description) });
    });
    admin.get(`${A}/projects/:id`, async (req) => hub.getProject((req.params as { id: string }).id));
    admin.patch(`${A}/projects/:id`, async (req) => {
      const b = (req.body ?? {}) as B;
      return hub.updateProject((req.params as { id: string }).id, {
        name: str(b.name),
        description: str(b.description),
        status: str(b.status),
      });
    });

    admin.get(`${A}/agents`, async (req) => hub.listAgents((req.query as Q).project));
    admin.patch(`${A}/agents/:id`, async (req) => {
      const b = (req.body ?? {}) as B;
      return hub.updateAgent({ kind: 'owner' }, (req.params as { id: string }).id, {
        status: str(b.status),
        name: str(b.name),
        description: str(b.description),
        skills: strArr(b.skills),
        tier: str(b.tier),
        can_invite: typeof b.can_invite === 'boolean' ? b.can_invite : undefined,
      });
    });
    admin.post(`${A}/agents/:id/daemon`, async (req) =>
      hub.controlDaemon((req.params as { id: string }).id, str(((req.body ?? {}) as B).action) ?? ''),
    );
    admin.get(`${A}/agents/:id/runs`, async (req) => hub.listRuns((req.params as { id: string }).id));
    admin.delete(`${A}/agents/:id`, async (req) => hub.deleteAgent((req.params as { id: string }).id));
    // 重置身份码：旧码作废，当前连接强制下线（reset-token 是旧地址）
    for (const path of ['reset-code', 'reset-token'])
      admin.post(`${A}/agents/:id/${path}`, async (req) => {
        const code = hub.resetAgentCode((req.params as { id: string }).id);
        return { code, token: code };
      });
    admin.get(`${A}/agents/:id/code`, async (req) => ({ code: hub.agentCodeOf((req.params as { id: string }).id) }));
    admin.post(`${A}/agents`, async (req, reply) => {
      const b = (req.body ?? {}) as B;
      reply.status(201);
      return hub.createAgent({ project: str(b.project) ?? '', name: str(b.name), tags: strArr(b.tags), platform: str(b.platform), note: str(b.note) });
    });
    admin.post(`${A}/agents/:id/projects`, async (req) => {
      const b = (req.body ?? {}) as B;
      return hub.addAgentToProject((req.params as { id: string }).id, { project: str(b.project) ?? '', tags: strArr(b.tags) });
    });
    // 强制下线：吊销当前授权 ID
    admin.post(`${A}/agents/:id/kick`, async (req) =>
      hub.kickAgent((req.params as { id: string }).id, str(((req.body ?? {}) as B).note) ?? ''),
    );
    admin.get(`${A}/presence-settings`, async () => hub.presenceSettings());
    admin.patch(`${A}/presence-settings`, async (req) => {
      const b = (req.body ?? {}) as B;
      const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));
      return hub.setPresenceSettings({ idle_minutes: num(b.idle_minutes), stream_grace_minutes: num(b.stream_grace_minutes) });
    });
    admin.get(`${A}/archive-settings`, async () => hub.archiveSettings());
    admin.patch(`${A}/archive-settings`, async (req) => {
      const v = ((req.body ?? {}) as B).auto_archive_hours;
      return hub.setArchiveSettings({ auto_archive_hours: v === undefined || v === null || v === '' ? undefined : Number(v) });
    });
    admin.get(`${A}/agents/:id/sessions`, async (req) => hub.listSessions((req.params as { id: string }).id));

    admin.get(`${A}/invites`, async (req) => hub.listInvites((req.query as Q).project));
    admin.post(`${A}/invites`, async (req, reply) => {
      const b = (req.body ?? {}) as B;
      reply.status(201);
      return hub.createInvite({
        project: str(b.project) ?? '',
        tags: strArr(b.tags),
        max_uses: b.max_uses === undefined ? undefined : Number(b.max_uses),
        hours: b.hours === undefined ? undefined : Number(b.hours),
        note: str(b.note),
        name: str(b.name),
      });
    });
    admin.delete(`${A}/invites/:code`, async (req) => {
      hub.revokeInvite((req.params as { code: string }).code);
      return { ok: true };
    });

    admin.get(`${A}/tasks`, async (req) => {
      const q = req.query as Q;
      const tasks = hub.listTasks({ kind: 'owner' }, { project: q.project, status: q.status, assignee: q.assignee, parent: q.parent });
      return q.view === 'summary' ? tasks.map(taskSummary) : tasks;
    });
    admin.get(`${A}/tasks/:id`, async (req) => {
      const t = hub.getTask((req.params as { id: string }).id);
      return (req.query as Q).view === 'summary' ? { ...t, subtasks: t.subtasks.map(taskSummary) } : t;
    });
    admin.post(`${A}/tasks`, async (req, reply) => {
      const b = (req.body ?? {}) as B;
      reply.status(201);
      return hub.createTask(
        { kind: 'owner' },
        {
          project: str(b.project),
          parent: str(b.parent) ?? null,
          title: str(b.title) ?? '',
          description: str(b.description),
          acceptance: strArr(b.acceptance),
          priority: str(b.priority),
          assignee: str(b.assignee) ?? null,
          depends_on: strArr(b.depends_on),
          refs: strArr(b.refs),
          files: strArr(b.files),
          required_tags: strArr(b.required_tags),
          due_at: str(b.due_at) ?? null,
          draft: b.draft === true,
        },
      );
    });
    admin.patch(`${A}/tasks/:id`, async (req) => {
      const b = (req.body ?? {}) as B;
      return hub.updateTask((req.params as { id: string }).id, {
        title: str(b.title),
        description: str(b.description),
        acceptance: b.acceptance === undefined ? undefined : (strArr(b.acceptance) ?? []),
        priority: str(b.priority),
        required_tags: b.required_tags === undefined ? undefined : (strArr(b.required_tags) ?? []),
        depends_on: b.depends_on === undefined ? undefined : (strArr(b.depends_on) ?? []),
        refs: b.refs === undefined ? undefined : (strArr(b.refs) ?? []),
        files: b.files === undefined ? undefined : (strArr(b.files) ?? []),
        due_at: b.due_at === undefined ? undefined : (str(b.due_at) ?? null),
        version: b.version === undefined ? undefined : Number(b.version),
      });
    });
    const ownerAction = (verb: string, fn: (id: string, b: B) => unknown) =>
      admin.post(`${A}/tasks/:id/${verb}`, async (req) => fn((req.params as { id: string }).id, (req.body ?? {}) as B));
    ownerAction('assign', (id, b) => hub.assign(id, str(b.agent) ?? null, str(b.message)));
    ownerAction('publish', (id) => hub.publish(id));
    ownerAction('approve', (id, b) => hub.approve(id, str(b.comment)));
    ownerAction('reject', (id, b) => hub.reject(id, str(b.reason) ?? ''));
    ownerAction('cancel', (id, b) => hub.cancel(id, str(b.reason)));
    ownerAction('archive', (id, b) => hub.cancel(id, str(b.reason)));
    ownerAction('answer', (id, b) => hub.answer(id, str(b.answer) ?? ''));
    ownerAction('unblock', (id, b) => hub.unblock({ kind: 'owner' }, id, str(b.note)));
    ownerAction('comments', (id, b) => hub.comment({ kind: 'owner' }, id, str(b.text) ?? '', strArr(b.files)));
    admin.get(`${A}/tasks/:id/artifacts/:aid/revisions`, async (req) => {
      const { id, aid } = req.params as { id: string; aid: string };
      return hub.artifactRevisions({ kind: 'owner' }, id, aid);
    });
    for (const method of ['put', 'patch'] as const)
      admin[method](`${A}/tasks/:id/artifacts/:aid`, async (req) => {
        const { id, aid } = req.params as { id: string; aid: string };
        return hub.updateArtifact({ kind: 'owner' }, id, aid, artifactUpdate(hub, method, (req.body ?? {}) as B));
      });

    admin.get(`${A}/messages`, async (req) => hub.listMessages({ agent: (req.query as Q).agent }));
    admin.post(`${A}/messages`, async (req) => {
      const b = (req.body ?? {}) as B;
      return hub.message({ kind: 'owner' }, str(b.to) ?? '', str(b.text) ?? '');
    });
    admin.post(`${A}/broadcast`, async (req) => {
      const b = (req.body ?? {}) as B;
      return hub.broadcast(str(b.project) ?? '', str(b.text) ?? '');
    });
  });

  // ── 控制台 ──
  const webDir = opts.webDir ?? join(ROOT, 'web', 'dist');
  if (existsSync(join(webDir, 'index.html'))) {
    app.register(fastifyStatic, {
      root: webDir,
      prefix: '/',
      // assets 下的文件名带内容哈希，内容变了地址也变，可以一直缓存；index.html 每次都要确认是否有新版
      setHeaders: (res, path) => {
        if (relative(webDir, path).startsWith(`assets${sep}`)) res.header('cache-control', 'public, max-age=31536000, immutable');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/mcp')) {
        return reply.sendFile('index.html');
      }
      return reply.status(404).send({ error: { code: 'not_found', message: tr('接口不存在') } });
    });
  } else {
    app.get('/', async (_req, reply) =>
      reply
        .type('text/html; charset=utf-8')
        .send(tr('<meta charset="utf-8"><p>ahub 正在运行。控制台尚未构建，请在仓库里运行 <code>npm run build:web</code>。</p>')),
    );
  }

  return app;
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain', log: 'text/plain', md: 'text/markdown', json: 'application/json',
  csv: 'text/csv', zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar', html: 'text/html',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp4: 'video/mp4', mp3: 'audio/mpeg',
};
const guessMime = (name: string) => MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

/** PUT 整份替换（content 或 file_id），PATCH 局部修改（edits）。 */
function artifactUpdate(hub: Hub, method: 'put' | 'patch', b: B) {
  const base = { base_rev: b.base_rev === undefined ? undefined : Number(b.base_rev), note: str(b.note) };
  if (method === 'patch') {
    if (!Array.isArray(b.edits)) throw new HubError(400, 'invalid', tr('PATCH 需要 edits：[{"old":"原文片段","new":"替换后的内容"}]'));
    return { ...base, edits: (b.edits as { old?: unknown; new?: unknown }[]).map((e) => ({ old: str(e?.old) ?? '', new: str(e?.new) ?? '' })) };
  }
  if (b.file_id) return { ...base, parts: [hub.filePart(String(b.file_id))] };
  if (typeof b.content !== 'string') throw new HubError(400, 'invalid', tr('PUT 需要 content（新的完整内容）或 file_id'));
  return { ...base, content: b.content };
}

const badArtifact = (why: string) => new HubError(400, 'invalid', tr('交付物格式不对：{why}', { why }));

/** 链接只放行 http、https、mailto；没写协议的（github.com/foo、localhost:3000）当普通文字，也放行。 */
function linkUrl(v: unknown): string {
  if (typeof v !== 'string') throw badArtifact(tr('链接的 url 必须是字符串'));
  // 浏览器解析地址前会去掉控制字符和空白，java<tab>script: 一样能执行
  const compact = v.replace(/[\u0000-\u0020\u007f]/g, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(compact)?.[1].toLowerCase();
  const hostPort = /^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)+):\d+(\/|$)/i.test(compact);
  if (scheme && !hostPort && !['http', 'https', 'mailto'].includes(scheme)) throw badArtifact(tr('链接只支持 http、https 和 mailto'));
  return v;
}

function parsePart(p: unknown): Part | null {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw badArtifact(tr('parts 里每一项都要是对象'));
  const part = p as Record<string, unknown>;
  switch (part.kind) {
    // 文件只能通过 file_id 引用，不接受客户端自己拼的 file 部分
    case 'file':
      return null;
    case 'text':
      if (typeof part.text !== 'string') throw badArtifact(tr('文本部分的 text 必须是字符串'));
      return { kind: 'text', text: part.text };
    case 'link':
      return { kind: 'link', url: linkUrl(part.url), ...(typeof part.name === 'string' ? { name: part.name } : {}) };
    case 'data':
      return { kind: 'data', data: part.data };
    default:
      throw badArtifact(tr('kind 只能是 text、link、data'));
  }
}

function parseArtifacts(hub: Hub, v: unknown): { name?: string; parts: Part[] }[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw badArtifact(tr('每个交付物都要是对象'));
    const a = item as { name?: unknown; content?: unknown; url?: unknown; file_id?: unknown; parts?: unknown };
    if (a.name != null && typeof a.name !== 'string') throw badArtifact(tr('name 必须是字符串'));
    const name = a.name ?? undefined;
    if (Array.isArray(a.parts)) return { name, parts: a.parts.map(parsePart).filter((p): p is Part => p !== null) };
    if (a.content != null && typeof a.content !== 'string') throw badArtifact(tr('content 必须是字符串'));
    const parts: Part[] = [];
    if (a.file_id) parts.push(hub.filePart(String(a.file_id)));
    if (a.content) parts.push({ kind: 'text', text: a.content });
    if (a.url) parts.push({ kind: 'link', url: linkUrl(a.url) });
    return { name, parts };
  });
}

/** 等到有一条对该 agent 可见的新事件，或超时，或客户端断开。 */
function waitForEvent(hub: Hub, agent: AgentRow, ms: number, req: FastifyRequest): Promise<void> {
  return new Promise((resolve) => {
    hub.markLive(agent.id, 1);
    const done = () => {
      clearTimeout(timer);
      hub.bus.off('event', onEvent);
      req.raw.off('close', done);
      hub.markLive(agent.id, -1);
      resolve();
    };
    const onEvent = (e: HubEvent) => {
      if (hub.canSee(agent, e)) done();
    };
    const timer = setTimeout(done, ms);
    hub.bus.on('event', onEvent);
    req.raw.on('close', done);
  });
}

function streamEvents(
  hub: Hub,
  req: FastifyRequest,
  reply: FastifyReply,
  _lastId: number,
  visible: (e: HubEvent) => boolean,
  backlog: () => HubEvent[],
  agentId: number | null,
  sessionId: number | null = null,
) {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const write = (e: HubEvent) => res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.write(tr(': ahub 事件流已连接\n\n'));
  let sent = 0;
  for (const e of backlog()) {
    write(e);
    sent = e.seq;
  }
  const onEvent = (e: HubEvent) => {
    if (e.seq > sent && visible(e)) {
      write(e);
      sent = e.seq;
    }
  };
  hub.bus.on('event', onEvent);
  // 授权 ID 被吊销、顶掉或过期：告诉对方原因后断开
  const onEnded = (e: { sessionId: number; reason: string; note: string }) => {
    if (e.sessionId !== sessionId) return;
    res.write(`event: session.ended\ndata: ${JSON.stringify({ reason: e.reason, note: e.note })}\n\n`);
    res.end();
  };
  if (sessionId !== null) hub.bus.on('session.ended', onEnded);
  if (agentId !== null) hub.markLive(agentId, 1, 'stream');
  const heartbeat = setInterval(() => res.write(tr(': 心跳\n\n')), 20_000);
  req.raw.on('close', () => {
    clearInterval(heartbeat);
    hub.bus.off('event', onEvent);
    hub.bus.off('session.ended', onEnded);
    if (agentId !== null) hub.markLive(agentId, -1, 'stream');
  });
}
