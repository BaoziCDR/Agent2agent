import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  const app = buildApp(hub, { webDir: '/nonexistent', maxWaitSeconds: 2 });
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
