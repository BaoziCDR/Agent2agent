import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Actor, type AgentRow, type Binding, Hub, HubError, agentCode } from './hub.js';
import { renderInbox, renderJoin, renderMe, renderRegister, renderTask, renderTaskList } from './format.js';
import { handleMcpRequest } from './mcp-http.js';
import type { HubEvent, Part } from '../shared/model.js';

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
}

declare module 'fastify' {
  interface FastifyRequest {
    agent?: AgentRow;
    isOwner?: boolean;
  }
}

type Q = Record<string, string | undefined>;
type B = Record<string, unknown>;

function tokenOf(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (h && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  const q = (req.query as Q)?.token;
  return q ?? null;
}

/** 绑定标识：命令行和 MCP 桥在每个请求的头里带上；注册/加入时也可以放在请求体里。 */
function bindingOf(req: FastifyRequest, body?: Record<string, unknown>): Binding | null {
  const key = (req.headers['x-ahub-bind'] as string | undefined) ?? (typeof body?.bind_key === 'string' ? body.bind_key : undefined);
  if (!key) return null;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new HubError(400, 'invalid', '绑定标识格式不对');
  let label = typeof body?.bind_label === 'string' ? body.bind_label : '';
  const h = req.headers['x-ahub-bind-label'] as string | undefined;
  if (!label && h) {
    try {
      label = decodeURIComponent(h);
    } catch {
      label = h;
    }
  }
  return { key, label: label.slice(0, 200) };
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

export function buildApp(hub: Hub, opts: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 5 * 1024 * 1024, forceCloseConnections: true });
  const maxWait = opts.maxWaitSeconds ?? 50;
  const publicUrl = (req: FastifyRequest) => opts.publicUrl ?? `${req.protocol}://${req.headers.host}`;

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    const status = err instanceof HubError ? err.status : (err.statusCode ?? 500);
    const code = err instanceof HubError ? err.code : status === 500 ? 'internal' : 'bad_request';
    const message = status === 500 ? '服务器内部错误' : err.message;
    if (status === 500) req.log.error(err);
    if (wantsMarkdown(req)) return reply.status(status).type('text/markdown; charset=utf-8').send(`**错误**：${message}\n`);
    return reply.status(status).send({ error: { code, message } });
  });

  // ── 鉴权 ──
  /** 校验 agent 令牌和绑定位置；成功时记录出现。 */
  const authAgentReq = (req: FastifyRequest, message = '缺少或无效的 agent 令牌'): AgentRow => {
    const token = tokenOf(req);
    const agent = token ? hub.authAgent(token) : null;
    if (!agent) throw new HubError(401, 'unauthorized', message);
    hub.checkBinding(agent, bindingOf(req));
    hub.touchAgent(agent);
    return agent;
  };
  const requireAgent = async (req: FastifyRequest) => {
    const agent = authAgentReq(req);
    req.agent = agent;
    const ack = (req.query as Q)?.ack ?? (req.headers['x-ahub-ack'] as string | undefined);
    if (ack !== undefined && /^\d+$/.test(ack)) hub.ack(agent, Number(ack));
  };
  const requireOwner = async (req: FastifyRequest) => {
    const token = tokenOf(req);
    if (!token || !hub.isOwnerToken(token)) throw new HubError(401, 'unauthorized', '需要负责人令牌');
    req.isOwner = true;
  };
  const actorOf = (req: FastifyRequest): Actor => (req.isOwner ? { kind: 'owner' } : { kind: 'agent', agent: req.agent! });

  // ── 公共 ──
  app.get('/api/v1/health', async () => ({ ok: true, name: 'ahub', last_seq: hub.lastSeq() }));

  app.get('/skill.md', async (req, reply) => {
    const file = join(ROOT, 'skill', 'SKILL.md');
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '# ahub\n';
    return reply.type('text/markdown; charset=utf-8').send(text.replaceAll('{{HUB_URL}}', publicUrl(req)));
  });

  // ── Agent 接口 ──
  app.post('/api/v1/join', async (req, reply) => {
    const body = (req.body ?? {}) as B;
    const token = tokenOf(req);
    const existing = token ? hub.authAgent(token) : null;
    if (token && !existing) throw new HubError(401, 'unauthorized', '令牌无效；新身份加入时不要带令牌');
    const bind = bindingOf(req, body);
    if (existing) hub.checkBinding(existing, bind);
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
      bind,
    );
    reply.status(201);
    return send(req, reply, { agent: r.agent, token: r.token, project: r.project }, () => renderJoin(r, publicUrl(req)));
  });

  // 不需要邀请码的自助注册：创建并绑定身份；加入项目仍需邀请码
  app.post('/api/v1/register', async (req, reply) => {
    const body = (req.body ?? {}) as B;
    if (tokenOf(req)) throw new HubError(400, 'invalid', '已经有身份了，不能再注册新身份');
    const r = hub.register(
      {
        name: str(body.name),
        platform: str(body.platform),
        tier: str(body.tier),
        description: str(body.description),
        skills: strArr(body.skills),
      },
      bindingOf(req, body),
    );
    reply.status(201);
    return send(req, reply, r, () => renderRegister(r));
  });

  app.register(async (agentApi) => {
    agentApi.addHook('preHandler', requireAgent);

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
      let result = hub.inbox(agent, { since, project: q.project });
      if (wait > 0 && result.events.length === 0) {
        await waitForEvent(hub, agent, wait * 1000, req);
        result = hub.inbox(agent, { since, project: q.project });
      }
      return send(req, reply, result, () => renderInbox(result));
    });

    agentApi.get('/api/v1/stream', async (req, reply) => {
      const agent = req.agent!;
      const lastId = Number(req.headers['last-event-id'] ?? (req.query as Q).since ?? agent.ack_seq) || 0;
      streamEvents(hub, req, reply, lastId, (e) => hub.canSee(agent, e), () => hub.eventsForAgent(agent, lastId, 1000).events, agent.id);
    });

    // ahub run 守护进程上报自己被唤醒/处理完毕
    agentApi.post('/api/v1/me/activity', async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return hub.reportActivity(req.agent!, { state: str(b.state), note: str(b.note) });
    });

    agentApi.get('/api/v1/projects', async (req) => hub.agentView(req.agent!).projects);

    agentApi.get('/api/v1/projects/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const p = hub.getProject(id);
      if (!hub.agentView(req.agent!).projects.some((x) => x.id === p.id)) throw new HubError(403, 'forbidden', `你不是项目 ${id} 的成员`);
      return send(req, reply, p, () => `# ${p.id}「${p.name}」\n\n## 项目说明（负责人撰写）\n\n${p.description || '（无）'}\n\n## 成员\n\n${p.members_list.map((a) => `- ${a.name}（${a.id}）· ${a.platform}`).join('\n')}\n`);
    });

    agentApi.get('/api/v1/members', async (req, reply) => {
      const want = (req.query as Q).project?.toUpperCase();
      const mine = hub.agentView(req.agent!).projects.filter((x) => !want || x.id === want);
      if (want && !mine.length) throw new HubError(403, 'forbidden', `你不是项目 ${want} 的成员`);
      const list = mine.map((x) => {
        const p = hub.getProject(x.id);
        return { project: p.id, name: p.name, members: p.members_list.map((a) => ({ id: a.id, name: a.name, platform: a.platform, online: a.online, tags: a.projects.find((y) => y.id === p.id)?.tags ?? [] })) };
      });
      return send(req, reply, list, () =>
        list
          .map(
            (p) =>
              `# ${p.project}「${p.name}」的成员\n\n` +
              p.members.map((a) => `- ${a.name}（${a.id}）· ${a.platform}${a.tags.length ? ` · 标签：${a.tags.join('、')}` : ''}`).join('\n') +
              '\n',
          )
          .join('\n') + '\n评论里用 @编号（如 @A-3）或 @完整名字 提及成员，@负责人 提及负责人。\n',
      );
    });

    agentApi.get('/api/v1/tasks', async (req, reply) => {
      const q = req.query as Q;
      const tasks = hub.listTasks(actorOf(req), { project: q.project, status: q.status, mine: q.mine === '1' || q.mine === 'true', parent: q.parent });
      return send(req, reply, tasks, () => renderTaskList(tasks));
    });

    agentApi.get('/api/v1/tasks/:id', async (req, reply) => {
      const t = hub.getTaskFor(actorOf(req), (req.params as { id: string }).id);
      return send(req, reply, t, () => renderTask(t, publicUrl(req)));
    });

    const action = (
      path: string,
      fn: (agent: AgentRow, id: string, body: B) => unknown,
      done: (r: unknown) => string,
    ) =>
      agentApi.post(path, async (req, reply) => {
        const id = (req.params as { id?: string }).id ?? '';
        const key = req.headers['idempotency-key'] as string | undefined;
        const result = hub.idempotent(req.agent!, key, () => fn(req.agent!, id, (req.body ?? {}) as B));
        return send(req, reply, result, () => done(result));
      });

    const taskDone = (verb: string) => (r: unknown) => {
      const t = r as { id: string; title: string; status_label: string; progress: number };
      return `已${verb}：**${t.id}** ${t.title}（当前状态：${t.status_label}，进度 ${t.progress}%）\n`;
    };

    action('/api/v1/tasks/:id/claim', (a, id) => hub.claim(a, id), taskDone('领取'));
    action('/api/v1/tasks/:id/accept', (a, id) => hub.accept(a, id), taskDone('接受'));
    action('/api/v1/tasks/:id/decline', (a, id, b) => hub.decline(a, id, str(b.reason) ?? ''), taskDone('拒绝'));
    action(
      '/api/v1/tasks/:id/progress',
      (a, id, b) =>
        hub.progress(a, id, {
          percent: b.percent === undefined ? undefined : Number(b.percent),
          note: str(b.note) ?? '',
          notes: str(b.notes),
        }),
      taskDone('上报进度'),
    );
    action('/api/v1/tasks/:id/block', (a, id, b) => hub.block(a, id, str(b.reason) ?? ''), taskDone('标记阻塞'));
    action('/api/v1/tasks/:id/unblock', (a, id, b) => hub.unblock({ kind: 'agent', agent: a }, id, str(b.note)), taskDone('解除阻塞'));
    action(
      '/api/v1/tasks/:id/submit',
      (a, id, b) => hub.submit(a, id, { summary: str(b.summary) ?? '', artifacts: parseArtifacts(hub, b.artifacts) }),
      taskDone('提交验收'),
    );
    action('/api/v1/tasks/:id/release', (a, id, b) => hub.release(a, id, str(b.reason) ?? ''), taskDone('放弃'));
    action(
      '/api/v1/tasks/:id/comments',
      (a, id, b) => hub.comment({ kind: 'agent', agent: a }, id, str(b.text) ?? ''),
      () => '已发表评论。\n',
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
          },
        ),
      (r) => {
        const t = r as { id: string; title: string; status_label: string };
        return `已创建子任务 **${t.id}** ${t.title}（${t.status_label}）\n`;
      },
    );
    action(
      '/api/v1/messages',
      (a, _id, b) => hub.message({ kind: 'agent', agent: a }, str(b.to) ?? '', str(b.text) ?? str(b.body) ?? ''),
      () => '私信已发送。\n',
    );
  });

  // ── 文件上传与下载 ──
  const MAX_UPLOAD = 25 * 1024 * 1024;
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_UPLOAD }, (_req, body, done) =>
    done(null, body),
  );
  app.post('/api/v1/files', { bodyLimit: MAX_UPLOAD }, async (req, reply) => {
    if (!opts.filesDir) throw new HubError(501, 'unsupported', '这个 Hub 没有开启文件上传');
    const token = tokenOf(req);
    let uploader: string | null = null;
    if (token && hub.isOwnerToken(token)) uploader = 'owner';
    else uploader = agentCode(authAgentReq(req, '缺少或无效的令牌').id);
    if (!Buffer.isBuffer(req.body)) throw new HubError(400, 'invalid', '请用 Content-Type: application/octet-stream 上传文件内容');
    const q = req.query as Q;
    const name = q.name ?? (req.headers['x-file-name'] ? decodeURIComponent(String(req.headers['x-file-name'])) : 'file');
    const mime = q.mime ?? guessMime(name);
    const part = hub.recordFile(uploader, { name, mime, size: req.body.length });
    mkdirSync(opts.filesDir, { recursive: true });
    writeFileSync(join(opts.filesDir, part.url!.slice('/files/'.length)), req.body);
    reply.status(201);
    return { ...part, id: part.url!.slice('/files/'.length), absolute_url: publicUrl(req) + part.url };
  });
  // 下载地址本身难以猜测，相当于一次性分享链接，方便控制台和 agent 直接打开
  app.get('/files/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const f = /^[\w-]{10,64}$/.test(id) ? hub.getFile(id) : null;
    const path = f && opts.filesDir ? join(opts.filesDir, f.id) : null;
    if (!f || !path || !existsSync(path)) throw new HubError(404, 'not_found', '找不到这个文件');
    const inline = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain)$/.test(f.mime);
    reply
      .header('content-type', f.mime === 'text/plain' ? 'text/plain; charset=utf-8' : f.mime)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'")
      .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    return reply.send(createReadStream(path));
  });

  // ── MCP（Streamable HTTP，无状态） ──
  app.all('/mcp', async (req, reply) => {
    authAgentReq(req, '缺少或无效的 agent 令牌（用 Authorization: Bearer 或 ?token=）');
    await handleMcpRequest(app, req, reply, tokenOf(req)!, bindingOf(req));
  });

  // ── 负责人接口 ──
  app.register(async (admin) => {
    admin.addHook('preHandler', requireOwner);
    const A = '/api/v1/admin';

    admin.get(`${A}/overview`, async (req) => hub.overview((req.query as Q).project));
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
      });
    });

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
      });
    });
    admin.post(`${A}/agents/:id/unbind`, async (req) => hub.unbindAgent((req.params as { id: string }).id));
    admin.post(`${A}/agents/:id/reset-token`, async (req) => ({ token: hub.resetAgentToken((req.params as { id: string }).id) }));

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
      });
    });
    admin.delete(`${A}/invites/:code`, async (req) => {
      hub.revokeInvite((req.params as { code: string }).code);
      return { ok: true };
    });

    admin.get(`${A}/tasks`, async (req) => {
      const q = req.query as Q;
      return hub.listTasks({ kind: 'owner' }, { project: q.project, status: q.status, assignee: q.assignee, parent: q.parent });
    });
    admin.get(`${A}/tasks/:id`, async (req) => hub.getTask((req.params as { id: string }).id));
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
    ownerAction('unblock', (id, b) => hub.unblock({ kind: 'owner' }, id, str(b.note)));
    ownerAction('comments', (id, b) => hub.comment({ kind: 'owner' }, id, str(b.text) ?? ''));

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
    app.register(fastifyStatic, { root: webDir, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/mcp')) {
        return reply.sendFile('index.html');
      }
      return reply.status(404).send({ error: { code: 'not_found', message: '接口不存在' } });
    });
  } else {
    app.get('/', async (_req, reply) =>
      reply
        .type('text/html; charset=utf-8')
        .send('<meta charset="utf-8"><p>ahub 正在运行。控制台尚未构建，请在仓库里运行 <code>npm run build:web</code>。</p>'),
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

function parseArtifacts(hub: Hub, v: unknown): { name?: string; parts: Part[] }[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map((a: { name?: string; content?: string; url?: string; file_id?: string; parts?: Part[] }) => {
    // 文件只能通过 file_id 引用，不接受客户端自己拼的 file 部分
    if (Array.isArray(a.parts)) return { name: a.name, parts: a.parts.filter((p) => p.kind !== 'file') };
    const parts: Part[] = [];
    if (a.file_id) parts.push(hub.filePart(String(a.file_id)));
    if (a.content) parts.push({ kind: 'text', text: String(a.content) });
    if (a.url) parts.push({ kind: 'link', url: String(a.url) });
    return { name: a.name, parts };
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
  res.write(': ahub 事件流已连接\n\n');
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
  if (agentId !== null) hub.markLive(agentId, 1, 'stream');
  const heartbeat = setInterval(() => res.write(': 心跳\n\n'), 20_000);
  req.raw.on('close', () => {
    clearInterval(heartbeat);
    hub.bus.off('event', onEvent);
    if (agentId !== null) hub.markLive(agentId, -1, 'stream');
  });
}
