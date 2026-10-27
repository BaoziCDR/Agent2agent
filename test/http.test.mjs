import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { openDb } from '../dist/server/db.js';
import { Hub } from '../dist/server/hub.js';
import { buildApp } from '../dist/server/app.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

process.removeAllListeners('warning');

async function setup() {
  const hub = new Hub(openDb(':memory:'));
  const ownerToken = 'owner_test';
  hub.ensureOwnerToken(ownerToken);
  const app = buildApp(hub, { webDir: '/nonexistent', maxWaitSeconds: 2, filesDir: mkdtempSync(pathJoin(tmpdir(), 'ahub-files-')) });
  const owner = { authorization: `Bearer ${ownerToken}` };
  const req = async (method, url, body, headers = owner) => {
    const res = await app.inject({ method, url, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, payload: body ? JSON.stringify(body) : undefined });
    return { status: res.statusCode, json: () => res.json(), text: res.body };
  };
  const project = (await req('POST', '/api/v1/admin/projects', { name: '演示' })).json();
  const invite = (await req('POST', '/api/v1/admin/invites', { project: project.id, max_uses: 5 })).json();
  const join = async (name) => {
    const r = (await req('POST', '/api/v1/join', { invite: invite.code, name, platform: 'codex' }, {})).json();
    const s = (await req('POST', '/api/v1/sessions', { code: r.code, client: 'cli' }, {})).json();
    return { ...r, session: s.session, headers: { authorization: `Bearer ${s.session}` } };
  };
  return { hub, app, req, project, join };
}

test('鉴权：没有令牌返回 401，agent 令牌不能调负责人接口', async () => {
  const { req, join } = await setup();
  assert.equal((await req('GET', '/api/v1/inbox', undefined, {})).status, 401);
  const a = await join('甲');
  assert.equal((await req('GET', '/api/v1/admin/projects', undefined, a.headers)).status, 401);
  assert.equal((await req('GET', '/api/v1/me', undefined, a.headers)).status, 200);
});

test('Markdown 输出与中文错误', async () => {
  const { req, join } = await setup();
  const a = await join('甲');
  const md = await req('GET', '/api/v1/inbox?format=md', undefined, a.headers);
  assert.match(md.text, /# A-1 的收件箱/);
  assert.match(md.text, /本次读到第 \d+ 号事件/);
  const err = await req('POST', '/api/v1/tasks/P1-T9/claim?format=md', {}, a.headers);
  assert.equal(err.status, 404);
  assert.match(err.text, /找不到任务 P1-T9/);
});

test('成员列表：agent 只能看自己项目的成员', async () => {
  const { req, join } = await setup();
  const a = await join('甲');
  await join('乙');
  const md = await req('GET', '/api/v1/members?format=md', undefined, a.headers);
  assert.match(md.text, /甲（A-1）[\s\S]*乙（A-2）/);
  assert.equal((await req('GET', '/api/v1/members?project=P-9', undefined, a.headers)).status, 403);
});

test('长轮询：有新事件时立即返回', async () => {
  const { req, join, project } = await setup();
  const a = await join('甲');
  const since = (await req('GET', '/api/v1/inbox', undefined, a.headers)).json().last_seq;
  const started = Date.now();
  const pending = req('GET', `/api/v1/inbox?wait=2&since=${since}`, undefined, a.headers);
  setTimeout(() => void req('POST', '/api/v1/admin/tasks', { project: project.id, title: '新任务' }), 100);
  const r = (await pending).json();
  assert.ok(Date.now() - started < 1500, '应在事件到达后立即返回');
  assert.ok(r.events.some((e) => e.type === 'task.created'));
});

test('空闲等待：连续落空后直接返回提示，续等和值守进程各有处理', async () => {
  const { req, join, hub } = await setup();
  const a = await join('甲');
  const since = (await req('GET', '/api/v1/inbox', undefined, a.headers)).json().last_seq;
  const w = (extra = '') => req('GET', `/api/v1/inbox?wait=1&since=${since}${extra}`, undefined, a.headers).then((r) => r.json());
  let r = await w();
  assert.equal(r.wait.skipped, false);
  assert.match(r.wait.hint, /不要反复调用等待/);
  // 续等不计数
  assert.equal((await w('&cont=1')).wait.skipped, false);
  assert.equal((await w()).wait.skipped, false);
  r = await w();
  assert.equal(r.wait.skipped, true);
  assert.match(r.wait.hint, /连续 3 次/);
  const md = await req('GET', `/api/v1/inbox?wait=1&since=${since}&format=md`, undefined, a.headers);
  assert.match(md.text, /不要再循环等待/);
  // 有新事件后重新计数
  await req('POST', '/api/v1/admin/messages', { to: 'A-1', text: '在吗' });
  assert.equal((await w()).events.length, 1);
  assert.equal(hub.idleWaits(1), 0);
  // 值守进程在线时不等待
  hub.markDaemon(1, 1);
  const last = (await req('GET', '/api/v1/inbox', undefined, a.headers)).json().last_seq;
  r = (await req('GET', `/api/v1/inbox?wait=1&since=${last}`, undefined, a.headers)).json();
  assert.equal(r.wait.skipped, true);
  assert.match(r.wait.hint, /值守进程/);
});

test('常驻等待：不受连续落空限制，控制台显示常驻', async () => {
  const { req, join, hub } = await setup();
  const a = await join('甲');
  const since = (await req('GET', '/api/v1/inbox', undefined, a.headers)).json().last_seq;
  const w = (extra = '') => req('GET', `/api/v1/inbox?wait=1&since=${since}${extra}`, undefined, a.headers).then((r) => r.json());
  for (let i = 0; i < 4; i++) {
    const r = await w('&resident=1');
    assert.equal(r.wait.skipped, false);
    assert.match(r.wait.hint, /--resident/);
  }
  assert.equal(hub.idleWaits(1), 0);
  const me = (await req('GET', '/api/v1/admin/agents')).json().find((x) => x.id === 'A-1');
  assert.equal(me.resident, true);
  // 值守进程在线时仍然不等待
  hub.markDaemon(1, 1);
  assert.equal((await w('&resident=1')).wait.skipped, true);
});

test('并发领取：同一个任务只有一个 agent 领到', async () => {
  const { req, join, project, hub } = await setup();
  const agents = [];
  for (const n of ['甲', '乙', '丙', '丁', '戊']) agents.push(await join(n));
  for (let round = 0; round < 5; round++) {
    const t = (await req('POST', '/api/v1/admin/tasks', { project: project.id, title: `抢任务 ${round}` })).json();
    const results = await Promise.all(agents.map((a) => req('POST', `/api/v1/tasks/${t.id}/claim`, {}, a.headers)));
    const won = results.filter((r) => r.status === 200);
    assert.equal(won.length, 1);
    assert.ok(results.filter((r) => r.status !== 200).every((r) => r.status === 409));
    const detail = (await req('GET', `/api/v1/admin/tasks/${t.id}`)).json();
    assert.match(detail.assignee, /^A-\d+$/);
    assert.equal(detail.assignee, won[0].json().assignee);
    assert.equal(detail.status, 'working');
  }
  // 两个 Hub 进程共用数据库时：读到旧版本的写入会被版本号拦下
  const t = (await req('POST', '/api/v1/admin/tasks', { project: project.id, title: '旧版本' })).json();
  const stale = hub.db.prepare('SELECT * FROM tasks WHERE num = ? AND project_id = (SELECT id FROM projects LIMIT 1)').get(Number(t.id.split('-T')[1]));
  await req('POST', `/api/v1/tasks/${t.id}/claim`, {}, agents[0].headers);
  assert.throws(() => hub.setStatus(stale, 'A-2', 'working', { assignee: 2, summary: 'x' }), /刚刚被其他人修改/);
});

test('搜索：任务、评论、私信；agent 只能搜自己的项目', async () => {
  const { req, join, project } = await setup();
  const a = await join('甲');
  const t = (await req('POST', '/api/v1/admin/tasks', { project: project.id, title: '实现登录接口', description: '用 JWT_令牌' })).json();
  await req('POST', `/api/v1/admin/tasks/${t.id}/comments`, { text: '刷新令牌放在 Redis 里' });
  await req('POST', '/api/v1/admin/messages', { to: 'A-1', text: 'Redis 地址发你了' });
  const other = (await req('POST', '/api/v1/admin/projects', { name: '另一个' })).json();
  await req('POST', '/api/v1/admin/tasks', { project: other.id, title: '登录页设计' });

  let r = (await req('GET', `/api/v1/admin/search?q=${encodeURIComponent('登录')}`)).json();
  assert.equal(r.tasks.length, 2);
  r = (await req('GET', '/api/v1/admin/search?q=Redis')).json();
  assert.equal(r.comments.length, 1);
  assert.match(r.comments[0].text, /Redis/);
  assert.equal(r.messages.length, 1);
  // LIKE 通配符按字面匹配
  assert.equal((await req('GET', '/api/v1/admin/search?q=JWT_')).json().tasks.length, 1);
  assert.equal((await req('GET', '/api/v1/admin/search?q=%25')).json().tasks.length, 0);
  // 编号直接命中
  assert.equal((await req('GET', `/api/v1/admin/search?q=${t.id.toLowerCase()}`)).json().tasks[0].id, t.id);

  r = (await req('GET', `/api/v1/search?q=${encodeURIComponent('登录')}`, undefined, a.headers)).json();
  assert.deepEqual(r.tasks.map((x) => x.id), [t.id]);
  assert.equal(r.messages.length, 0);
  assert.equal((await req('GET', `/api/v1/search?q=x&project=${other.id}`, undefined, a.headers)).status, 403);
  const md = await req('GET', `/api/v1/search?q=Redis&format=md`, undefined, a.headers);
  assert.match(md.text, /## 评论（1）/);
});

test('任务模板：保存、同名覆盖、改名冲突、删除', async () => {
  const { req } = await setup();
  const a = (await req('POST', '/api/v1/admin/templates', { name: '发版', title: '发布 v{版本}', priority: 'p1', subtasks: ['打包', ' ', '冒烟测试'], chain: true })).json();
  assert.equal(a.priority, 'P1');
  assert.deepEqual(a.subtasks, ['打包', '冒烟测试']);
  assert.equal(a.chain, true);
  const b = (await req('POST', '/api/v1/admin/templates', { name: '发版', title: '发布新版本' })).json();
  assert.equal(b.id, a.id);
  assert.equal(b.title, '发布新版本');
  const c = (await req('POST', '/api/v1/admin/templates', { name: '周报' })).json();
  assert.equal((await req('PUT', `/api/v1/admin/templates/${c.id}`, { name: '发版' })).status, 409);
  assert.equal((await req('POST', '/api/v1/admin/templates', { name: ' ' })).status, 400);
  assert.equal((await req('GET', '/api/v1/admin/templates')).json().length, 2);
  await req('DELETE', `/api/v1/admin/templates/${c.id}`);
  assert.equal((await req('DELETE', `/api/v1/admin/templates/${c.id}`)).status, 404);
  assert.deepEqual((await req('GET', '/api/v1/admin/templates')).json().map((t) => t.name), ['发版']);
});

test('幂等键：同一个键重复提交只执行一次', async () => {
  const { req, join, project } = await setup();
  const a = await join('甲');
  const t = (await req('POST', '/api/v1/admin/tasks', { project: project.id, title: 'x' })).json();
  await req('POST', `/api/v1/tasks/${t.id}/claim`, {}, a.headers);
  const h = { ...a.headers, 'idempotency-key': 'k1' };
  await req('POST', `/api/v1/tasks/${t.id}/progress`, { percent: 10, note: '一' }, h);
  await req('POST', `/api/v1/tasks/${t.id}/progress`, { percent: 10, note: '一' }, h);
  const detail = (await req('GET', `/api/v1/admin/tasks/${t.id}`)).json();
  assert.equal(detail.progress_log.length, 1);
});

test('MCP：通过 HTTP 调用 hub_ 工具', async () => {
  const { app, req, join, project } = await setup();
  const a = await join('甲');
  const t = (await req('POST', '/api/v1/admin/tasks', { project: project.id, title: '写文档' })).json();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address();
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: a.headers } }),
  );
  const tools = (await client.listTools()).tools.map((x) => x.name);
  assert.ok(tools.includes('hub_sync') && tools.includes('hub_progress'));
  assert.ok(!tools.includes('hub_join'), 'HTTP MCP 不提供 hub_join');
  const sync = await client.callTool({ name: 'hub_sync', arguments: {} });
  assert.match(sync.content[0].text, /可领取的任务[\s\S]*写文档/);
  const claim = await client.callTool({ name: 'hub_claim', arguments: { task: t.id } });
  assert.match(claim.content[0].text, /已领取/);
  const bad = await client.callTool({ name: 'hub_claim', arguments: { task: t.id } });
  assert.equal(bad.isError, true);
  await client.close();
  await app.close();
});

test('文件上传：agent 上传后作为交付物提交，负责人能下载', async () => {
  const { app, req, join: joinAgent, project } = await setup();
  const a = await joinAgent('甲');
  const t = (await req('POST', '/api/v1/admin/tasks', { project: project.id, title: '出图' })).json();
  await req('POST', `/api/v1/tasks/${t.id}/claim`, {}, a.headers);
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
  const up = await app.inject({
    method: 'POST',
    url: '/api/v1/files?name=' + encodeURIComponent('图 1.png'),
    headers: { ...a.headers, 'content-type': 'application/octet-stream' },
    payload: bytes,
  });
  assert.equal(up.statusCode, 201);
  const f = up.json();
  assert.equal(f.size, 8);
  assert.equal(f.mime, 'image/png');
  // 客户端自己拼的 file 部分会被丢掉，只认 file_id
  await req('POST', `/api/v1/tasks/${t.id}/submit`, {
    summary: '图在附件里',
    artifacts: [{ name: '图', file_id: f.id }, { name: '伪造', parts: [{ kind: 'file', url: '/files/xxx' }] }],
  }, a.headers);
  const detail = (await req('GET', `/api/v1/admin/tasks/${t.id}`)).json();
  const parts = detail.artifacts.flatMap((x) => x.parts).filter((p) => p.kind === 'file');
  assert.equal(parts.length, 1);
  const dl = await app.inject({ method: 'GET', url: parts[0].url });
  assert.equal(dl.statusCode, 200);
  assert.deepEqual(dl.rawPayload, bytes);
  assert.match(dl.headers['content-disposition'], /inline; filename\*=UTF-8''%E5%9B%BE%201\.png/);
  assert.equal((await app.inject({ method: 'GET', url: '/files/abcdefghijklmnop' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/files', headers: { 'content-type': 'application/octet-stream' }, payload: bytes })).statusCode, 401);
  const md = await req('GET', `/api/v1/tasks/${t.id}?format=md`, undefined, a.headers);
  assert.match(md.text, /文件：\[图 1\.png\]\(http:\/\/[^)]+\/files\/[\w-]+\)/);
});

test('值守进程上报状态：负责人看到「正在处理」', async () => {
  const { req, join: joinAgent } = await setup();
  const a = await joinAgent('甲');
  await req('POST', '/api/v1/me/activity', { state: 'working', note: '处理 P1-T1' }, a.headers);
  const ev = (await req('GET', '/api/v1/admin/events?limit=1')).json()[0];
  assert.equal(ev.type, 'agent.activity');
  assert.match(ev.summary, /甲（A-1）被唤醒：处理 P1-T1/);
});

test('导出：Markdown 报告和任务 CSV', async () => {
  const { req, project, join: joinAgent } = await setup();
  const a = await joinAgent('甲');
  const t1 = (await req('POST', '/api/v1/admin/tasks', { project: project.id, title: '实现登录, "接口"' })).json();
  const t2 = (await req('POST', '/api/v1/admin/tasks', { project: project.id, title: '写文档' })).json();
  await req('POST', `/api/v1/tasks/${t1.id}/claim`, {}, a.headers);
  await req('POST', `/api/v1/tasks/${t1.id}/submit`, { summary: '登录接口已上线' }, a.headers);
  await req('POST', `/api/v1/admin/tasks/${t1.id}/approve`, {});
  await req('POST', `/api/v1/tasks/${t2.id}/claim`, {}, a.headers);

  const md = await req('GET', `/api/v1/admin/export/report?days=7&project=${project.id}`);
  assert.equal(md.status, 200);
  assert.match(md.text, /## 本期完成/);
  assert.match(md.text, /实现登录[\s\S]*登录接口已上线/);
  assert.match(md.text, /## 进行中[\s\S]*写文档/);
  assert.match(md.text, /甲/);

  const csv = await req('GET', `/api/v1/admin/export/tasks.csv?project=${project.id}`);
  assert.equal(csv.status, 200);
  assert.ok(csv.text.startsWith('﻿'));
  const lines = csv.text.slice(1).split('\r\n').filter(Boolean);
  assert.equal(lines.length, 3);
  assert.ok(lines.some((l) => l.includes('"实现登录, ""接口"""')));
  assert.equal((await req('GET', '/api/v1/admin/export/tasks.csv', undefined, {})).status, 401);
});

test('评论附件：上传后随评论发出，任务详情和 Markdown 里都能看到', async () => {
  const { app, req, project, join: joinAgent } = await setup();
  const a = await joinAgent('甲');
  const t = (await req('POST', '/api/v1/admin/tasks', { project: project.id, title: '修 bug' })).json();
  const up = await app.inject({
    method: 'POST',
    url: '/api/v1/files?name=报错截图.png',
    headers: { authorization: 'Bearer owner_test', 'content-type': 'application/octet-stream' },
    payload: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  });
  assert.equal(up.statusCode, 201);
  const f = up.json();
  // 只有附件、没有文字也可以
  assert.equal((await req('POST', `/api/v1/admin/tasks/${t.id}/comments`, { text: '', files: [f.id] })).status, 200);
  assert.equal((await req('POST', `/api/v1/admin/tasks/${t.id}/comments`, { text: '' })).status, 400);
  assert.equal((await req('POST', `/api/v1/admin/tasks/${t.id}/comments`, { text: 'x', files: ['nope-nope-nope'] })).status, 400);
  const c = (await req('GET', `/api/v1/admin/tasks/${t.id}`)).json().comments[0];
  assert.deepEqual(c.parts.map((p) => p.kind), ['file']);
  assert.equal(c.parts[0].mime, 'image/png');
  const ev = (await req('GET', '/api/v1/admin/events?limit=1')).json()[0];
  assert.match(ev.summary, /〔附件：报错截图\.png〕/);
  // agent 也能带附件评论，详情 Markdown 里给出可下载的链接
  await req('POST', `/api/v1/tasks/${t.id}/comments`, { text: '**看这里**', files: [f.id] }, a.headers);
  const md = await req('GET', `/api/v1/tasks/${t.id}?format=md`, undefined, a.headers);
  assert.match(md.text, /\*\*看这里\*\* 〔附件 \[报错截图\.png\]\(http:\/\/[^)]+\/files\/[\w-]+\)〕/);
});

test('阻塞提问：agent 给出选项，负责人点选后解除阻塞并通知 agent', async () => {
  const { req, project, join: joinAgent } = await setup();
  const a = await joinAgent('甲');
  const t = (await req('POST', '/api/v1/admin/tasks', { project: project.id, title: '建表' })).json();
  await req('POST', `/api/v1/tasks/${t.id}/claim`, {}, a.headers);
  assert.equal((await req('POST', `/api/v1/tasks/${t.id}/block`, { reason: '用哪个数据库？', options: Array(7).fill(0).map((_, i) => `x${i}`) }, a.headers)).status, 400);
  await req('POST', `/api/v1/tasks/${t.id}/block`, { reason: '用哪个数据库？', options: ['MySQL', 'PostgreSQL', 'MySQL'] }, a.headers);
  const blocked = (await req('GET', `/api/v1/admin/tasks/${t.id}`)).json();
  assert.equal(blocked.status, 'input_required');
  assert.deepEqual(blocked.block_options, ['MySQL', 'PostgreSQL']);
  const md = await req('GET', `/api/v1/tasks/${t.id}?format=md`, undefined, a.headers);
  assert.match(md.text, /可选答案：MySQL \/ PostgreSQL/);
  // 先读一遍收件箱，之后只看新事件
  await req('GET', '/api/v1/inbox?ack=1', undefined, a.headers);
  const r = await req('POST', `/api/v1/admin/tasks/${t.id}/answer`, { answer: 'PostgreSQL' });
  assert.equal(r.status, 200);
  const after = (await req('GET', `/api/v1/admin/tasks/${t.id}`)).json();
  assert.equal(after.status, 'working');
  assert.deepEqual(after.block_options, []);
  assert.match(after.comments.at(-1).parts[0].text, /\*\*回答\*\*「用哪个数据库？」：PostgreSQL/);
  const inbox = (await req('GET', '/api/v1/inbox', undefined, a.headers)).json();
  assert.ok(inbox.needs_action.some((e) => e.type === 'task.status_changed' && /负责人回答了 P1-T1 的问题：PostgreSQL/.test(e.summary)));
  assert.equal((await req('POST', `/api/v1/admin/tasks/${t.id}/answer`, { answer: 'x' })).status, 409);
});

test('授权 agent 新建身份：未授权拒绝，授权后新建待启动的身份并 @负责人，评论里不出现身份码', async () => {
  const { req, project, join: joinAgent } = await setup();
  const a = await joinAgent('协调者');
  const t = (await req('POST', '/api/v1/admin/tasks', { project: project.id, title: '审核 PR #12' })).json();
  const body = { task: t.id, note: '需要一个熟悉前端的审核者', name: '审核-前端', tags: ['前端'], harness: 'claude' };
  assert.equal((await req('POST', '/api/v1/invites', body, a.headers)).status, 403);
  assert.equal((await req('PATCH', `/api/v1/admin/agents/${a.agent.id}`, { can_invite: true })).status, 200);
  assert.match((await req('GET', '/api/v1/me?format=md', undefined, a.headers)).text, /已获负责人授权/);
  const r = await req('POST', '/api/v1/invites', body, a.headers);
  assert.equal(r.status, 200);
  const created = r.json();
  assert.equal(created.agent.name, '审核-前端');
  assert.equal(created.agent.pending, true);
  assert.equal(created.code, undefined);
  // 任务下有评论 @负责人，负责人收到提及；身份码只在控制台
  const c = (await req('GET', `/api/v1/admin/tasks/${t.id}`)).json().comments.at(-1);
  assert.match(c.parts[0].text, /^@负责人 需要一个新 agent：需要一个熟悉前端的审核者/);
  const code = (await req('GET', `/api/v1/admin/agents/${created.agent.id}/code`)).json().code;
  assert.ok(!c.parts[0].text.includes(code));
  const events = (await req('GET', '/api/v1/admin/events?limit=10')).json();
  assert.ok(events.some((e) => e.type === 'mention' && e.audience.length === 0));
  // 负责人拉起后用身份码连接，带上标签
  const s = (await req('POST', '/api/v1/sessions', { code, client: 'run' }, {})).json();
  assert.deepEqual(s.agent.projects[0].tags, ['前端']);
  assert.equal(s.agent.pending, false);
  // 取消授权后又被拒绝；agent 不能自己改权限
  assert.equal((await req('PATCH', '/api/v1/me', { can_invite: true }, a.headers)).status, 200);
  await req('PATCH', `/api/v1/admin/agents/${a.agent.id}`, { can_invite: false });
  assert.equal((await req('POST', '/api/v1/invites', body, a.headers)).status, 403);
});

test('授权 ID：同一身份只能一处在线，takeover 顶掉，强制下线、交还、重置身份码', async () => {
  const { req } = await setup();
  const created = (await req('POST', '/api/v1/admin/agents', { project: 'P-1', tags: ['后端'] })).json();
  const code = created.code;
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const open = (body = {}) => req('POST', '/api/v1/sessions', { code, client: 'run', host: 'box-1', ...body }, {});
  const as = (s) => ({ authorization: `Bearer ${s}` });
  // 没有名字的身份第一次连接要起名字
  assert.equal((await open()).status, 400);
  const s1 = (await open({ name: '后端' })).json();
  assert.equal(s1.agent.name, '后端');
  assert.equal(s1.agent.connection.host, 'box-1');
  // 身份码不能直接当授权 ID 用
  const direct = await req('GET', '/api/v1/me', undefined, as(code));
  assert.equal(direct.status, 401);
  assert.equal(direct.json().error.code, 'session_required');
  // 已在线：拒绝；takeover：顶掉旧的
  const busy = await open({ host: 'box-2' });
  assert.equal(busy.status, 409);
  assert.match(busy.json().error.message, /已经在线：box-1，值守/);
  const s2 = (await open({ host: 'box-2', takeover: true })).json();
  const old = await req('GET', '/api/v1/me', undefined, as(s1.session));
  assert.equal(old.json().error.code, 'session_replaced');
  assert.match(old.json().error.message, /box-2/);
  assert.equal((await req('GET', '/api/v1/me', undefined, as(s2.session))).status, 200);
  // 交还后立即可以重新连接
  assert.equal((await req('DELETE', '/api/v1/sessions/current', undefined, as(s2.session))).status, 200);
  assert.equal((await req('GET', '/api/v1/me', undefined, as(s2.session))).json().error.code, 'session_expired');
  const s3 = (await open()).json();
  // 强制下线：吊销授权 ID，身份码仍然可用
  assert.equal((await req('POST', `/api/v1/admin/agents/${created.agent.id}/kick`, { note: '维护' })).status, 200);
  const kicked = (await req('GET', '/api/v1/me', undefined, as(s3.session))).json();
  assert.equal(kicked.error.code, 'session_revoked');
  assert.match(kicked.error.message, /维护/);
  assert.equal((await req('POST', `/api/v1/admin/agents/${created.agent.id}/kick`, {})).status, 409);
  const sessions = (await req('GET', `/api/v1/admin/agents/${created.agent.id}/sessions`)).json();
  assert.deepEqual(sessions.map((x) => x.end_reason), ['revoked', 'released', 'replaced']);
  const s4 = (await open()).json();
  // 重置身份码：旧码作废，当前连接下线
  const fresh = (await req('POST', `/api/v1/admin/agents/${created.agent.id}/reset-code`)).json().code;
  assert.notEqual(fresh, code);
  assert.equal((await req('GET', '/api/v1/me', undefined, as(s4.session))).json().error.code, 'session_revoked');
  assert.equal((await open()).json().error.code, 'invalid_code');
  assert.equal((await req('POST', '/api/v1/sessions', { code: fresh }, {})).status, 201);
  // 停用：连接失效，身份码不能再换
  await req('PATCH', `/api/v1/admin/agents/${created.agent.id}`, { status: 'disabled' });
  assert.equal((await req('POST', '/api/v1/sessions', { code: fresh }, {})).json().error.code, 'agent_disabled');
});

test('授权 ID：身份码错太多次暂时拒绝', async () => {
  const { req } = await setup();
  for (let i = 0; i < 10; i++) assert.equal((await req('POST', '/api/v1/sessions', { code: 'AAAA-BBBB-CCCC' }, {})).status, 401);
  assert.equal((await req('POST', '/api/v1/sessions', { code: 'AAAA-BBBB-CCCC' }, {})).status, 429);
});

test('安装包：/ahub.tgz 是可安装的 npm 包，带构建产物且不再需要构建', async () => {
  const { app } = await setup();
  const res = await app.inject({ method: 'GET', url: '/ahub.tgz' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/gzip');
  const tar = gunzipSync(res.rawPayload);
  const entries = new Map();
  for (let off = 0; off + 512 <= tar.length; ) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const field = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const name = [field(345, 500), field(0, 100)].filter(Boolean).join('/');
    const size = parseInt(field(124, 136), 8);
    entries.set(name, tar.subarray(off + 512, off + 512 + size));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(entries.has('package/dist/cli/ahub.js'));
  assert.ok(entries.has('package/skill/SKILL.md'));
  const pkg = JSON.parse(entries.get('package/package.json').toString());
  assert.equal(pkg.name, 'agent2agent-hub');
  assert.equal(pkg.scripts.prepare, undefined);
});

test('交付物接口：读取带版本号，PATCH 局部修改，过期的 PUT 返回 409', async () => {
  const { req, join } = await setup();
  const a = await join('甲');
  const b = await join('乙');
  const project = (await req('GET', '/api/v1/admin/projects')).json()[0];
  const t = (await req('POST', '/api/v1/admin/tasks', { project: project.id, title: '文档', assignee: 'A-1' })).json();
  await req('POST', `/api/v1/tasks/${t.id}/accept`, {}, a.headers);
  await req('POST', `/api/v1/tasks/${t.id}/submit`, { summary: '好了', artifacts: [{ name: 'a.md', content: '甲乙丙' }] }, a.headers);
  const detail = await req('GET', `/api/v1/tasks/${t.id}?format=md`, undefined, b.headers);
  const id = Number(/### #(\d+) a\.md（第 1 版/.exec(detail.text)?.[1]);
  assert.ok(id);
  assert.match(detail.text, /ahub artifact patch/);
  const md = await req('GET', `/api/v1/tasks/${t.id}/artifacts/${id}?format=md`, undefined, b.headers);
  assert.match(md.text, /--base 1/);
  const p = await req('PATCH', `/api/v1/tasks/${t.id}/artifacts/${id}`, { base_rev: 1, edits: [{ old: '乙', new: '乙乙' }] }, b.headers);
  assert.equal(p.status, 200);
  assert.equal(p.json().rev, 2);
  const stale = await req('PUT', `/api/v1/tasks/${t.id}/artifacts/${id}?format=md`, { base_rev: 1, content: '覆盖' }, a.headers);
  assert.equal(stale.status, 409);
  assert.match(stale.text, /重新读取最新版本|先读取最新版本/);
  const put = await req('PUT', `/api/v1/admin/tasks/${t.id}/artifacts/${id}`, { base_rev: 2, content: '负责人改' });
  assert.equal(put.json().rev, 3);
  const revs = (await req('GET', `/api/v1/admin/tasks/${t.id}/artifacts/${id}/revisions`)).json();
  assert.deepEqual(revs.map((r) => r.author), ['A-1', 'A-2', 'owner']);
  const log = await req('GET', `/api/v1/tasks/${t.id}/artifacts/${id}/revisions?format=md`, undefined, a.headers);
  assert.match(log.text, /第 3 版 .* 负责人/);
});

test('任务引用：发布时带 refs，agent 读到的 Markdown 里列出引用的任务', async () => {
  const { req, join } = await setup();
  const a = await join('甲');
  const project = (await req('GET', '/api/v1/admin/projects')).json()[0];
  const old = (await req('POST', '/api/v1/admin/tasks', { project: project.id, title: '历史任务' })).json();
  const t = (await req('POST', '/api/v1/admin/tasks', { project: project.id, title: '新任务', refs: [old.id] })).json();
  assert.deepEqual(t.refs, [old.id]);
  const md = await req('GET', `/api/v1/tasks/${t.id}?format=md`, undefined, a.headers);
  assert.match(md.text, /## 引用的任务（参考资料）[\s\S]*历史任务/);
  const back = await req('PATCH', `/api/v1/admin/tasks/${t.id}`, { refs: [] });
  assert.deepEqual(back.json().refs, []);
});

test('回执接口：ahub run 按事件号打 👌、跑完打 ✅；inbox?mark=1 也会打；控制台任务详情里能看到', async () => {
  const { req, project, join } = await setup();
  const a = await join('甲');
  const t = (await req('POST', '/api/v1/admin/tasks', { project: project.id, title: '写接口', assignee: a.agent.id })).json();
  const inbox = (await req('GET', '/api/v1/inbox', undefined, a.headers)).json();
  const seqs = inbox.needs_action.map((e) => e.seq);
  const r = await req('POST', '/api/v1/me/receipts', { state: 'working', seqs }, a.headers);
  assert.equal(r.status, 200);
  assert.equal(r.json().updated, 1);
  let detail = (await req('GET', `/api/v1/admin/tasks/${t.id}`)).json();
  assert.deepEqual(detail.receipts.map((x) => [x.agent_name, x.state]), [['甲', 'working']]);
  await req('POST', '/api/v1/me/receipts', { state: 'done' }, a.headers);
  detail = (await req('GET', `/api/v1/admin/tasks/${t.id}`)).json();
  assert.equal(detail.receipts[0].state, 'done');

  await req('POST', `/api/v1/admin/tasks/${t.id}/comments`, { text: '补充一点' });
  await req('GET', '/api/v1/inbox?mark=1', undefined, a.headers);
  detail = (await req('GET', `/api/v1/admin/tasks/${t.id}`)).json();
  assert.equal(detail.comments.at(-1).receipts[0].state, 'working');
  assert.equal((await req('POST', '/api/v1/me/receipts', { state: 'bad' }, a.headers)).status, 400);
});

test('删除 agent：只能删已停用的，任务放回任务池，历史保留，旧令牌给出具体原因', async () => {
  const { req, join, project } = await setup();
  const a = await join('甲');
  const t = (await req('POST', '/api/v1/admin/tasks', { project: project.id, title: '写文档', assignee: a.agent.id })).json();
  await req('POST', `/api/v1/tasks/${t.id}/comments`, { text: '收到' }, a.headers);
  assert.equal((await req('DELETE', `/api/v1/admin/agents/${a.agent.id}`)).status, 409); // 还没停用
  await req('PATCH', `/api/v1/admin/agents/${a.agent.id}`, { status: 'disabled' });
  const disabled = await req('GET', '/api/v1/me', undefined, a.headers);
  assert.equal(disabled.status, 401);
  assert.equal(disabled.json().error.code, 'agent_disabled');
  assert.match(disabled.json().error.message, /甲（A-1）已被负责人停用/);

  const r = await req('DELETE', `/api/v1/admin/agents/${a.agent.id}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json().released, [t.id]);
  const task = (await req('GET', `/api/v1/admin/tasks/${t.id}`)).json();
  assert.equal(task.status, 'open');
  assert.equal(task.assignee, null);
  assert.ok(task.comments.some((c) => c.author === a.agent.id && c.author_name === '甲')); // 评论还在，仍显示名字
  const all = (await req('GET', '/api/v1/admin/agents')).json();
  assert.equal(all.find((x) => x.id === a.agent.id).status, 'deleted'); // 名字留给历史记录显示
  assert.equal((await req('GET', `/api/v1/admin/agents?project=${project.id}`)).json().length, 0);
  const deleted = await req('GET', '/api/v1/me', undefined, a.headers);
  assert.equal(deleted.json().error.code, 'agent_deleted');
  assert.equal((await req('PATCH', `/api/v1/admin/agents/${a.agent.id}`, { status: 'active' })).status, 409); // 删除后不能再启用
});
