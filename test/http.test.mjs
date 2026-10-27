import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
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
    return { ...r, headers: { authorization: `Bearer ${r.token}` } };
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
