import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { openDb } from '../dist/server/db.js';
import { Hub } from '../dist/server/hub.js';
import { buildApp } from '../dist/server/app.js';
import { acceptsGzip } from '../dist/server/compress.js';

process.removeAllListeners('warning');

const owner = { authorization: 'Bearer owner_test' };
const BIG_JS = `console.log(${JSON.stringify('压缩'.repeat(5000))});`;

function setup() {
  const hub = new Hub(openDb(':memory:'));
  hub.ensureOwnerToken('owner_test');
  const webDir = mkdtempSync(join(tmpdir(), 'ahub-web-'));
  mkdirSync(join(webDir, 'assets'));
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>ahub</title>');
  writeFileSync(join(webDir, 'assets', 'index-abc123.js'), BIG_JS);
  const filesDir = mkdtempSync(join(tmpdir(), 'ahub-files-'));
  const app = buildApp(hub, { webDir, filesDir, maxWaitSeconds: 1 });
  const get = (url, headers = {}) => app.inject({ method: 'GET', url, headers: { ...owner, ...headers } });
  return { hub, app, get };
}

async function seed(app) {
  const post = (url, body) =>
    app.inject({ method: 'POST', url, headers: { ...owner, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
  const project = (await post('/api/v1/admin/projects', { name: '演示' })).json();
  const parent = (await post('/api/v1/admin/tasks', { project: project.id, title: '父任务', description: '父任务正文', acceptance: ['验收'] })).json();
  const description = '很长的任务正文。'.repeat(500);
  await post('/api/v1/admin/tasks', { project: project.id, parent: parent.id, title: '子任务', description, acceptance: ['子任务验收'] });
  return { project, parent, description };
}

test('Accept-Encoding：识别 gzip，q=0 视为拒绝', () => {
  assert.equal(acceptsGzip('gzip, deflate, br'), true);
  assert.equal(acceptsGzip('br;q=1.0, GZIP;q=0.5'), true);
  assert.equal(acceptsGzip('gzip;q=0'), false);
  assert.equal(acceptsGzip('gzip;q=0.0, br'), false);
  assert.equal(acceptsGzip('deflate, br'), false);
  assert.equal(acceptsGzip(undefined), false);
});

test('接口响应：客户端接受 gzip 才压缩，内容不变', async () => {
  const { app, get } = setup();
  const { project } = await seed(app);
  const url = `/api/v1/admin/tasks?project=${project.id}`;

  const plain = await get(url);
  assert.equal(plain.statusCode, 200);
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.match(String(plain.headers.vary), /accept-encoding/i);

  const zipped = await get(url, { 'accept-encoding': 'gzip, deflate, br' });
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.match(String(zipped.headers.vary), /accept-encoding/i);
  assert.ok(zipped.rawPayload.length < plain.rawPayload.length / 2, '压缩后应明显变小');
  assert.equal(Number(zipped.headers['content-length']), zipped.rawPayload.length);
  assert.deepEqual(JSON.parse(gunzipSync(zipped.rawPayload).toString()), plain.json());
});

test('小响应和错误响应不压缩', async () => {
  const { get } = setup();
  assert.equal((await get('/api/v1/admin/projects', { 'accept-encoding': 'gzip' })).headers['content-encoding'], undefined);
  assert.equal((await get('/api/v1/admin/tasks/P9-T9', { 'accept-encoding': 'gzip' })).statusCode, 404);
  assert.equal((await get('/api/v1/admin/tasks/P9-T9', { 'accept-encoding': 'gzip' })).headers['content-encoding'], undefined);
});

test('静态资源：压缩，带哈希的文件长期缓存，首页每次确认', async () => {
  const { get } = setup();
  const js = await get('/assets/index-abc123.js', { 'accept-encoding': 'gzip' });
  assert.equal(js.statusCode, 200);
  assert.equal(js.headers['content-encoding'], 'gzip');
  assert.equal(js.headers['content-length'], undefined, '流式压缩不能带原文件的长度');
  assert.match(String(js.headers['cache-control']), /immutable/);
  assert.equal(gunzipSync(js.rawPayload).toString(), BIG_JS);

  const page = await get('/', { 'accept-encoding': 'gzip' });
  assert.equal(page.statusCode, 200);
  assert.doesNotMatch(String(page.headers['cache-control']), /immutable/);

  // 协商缓存不受压缩影响
  const again = await get('/assets/index-abc123.js', { 'accept-encoding': 'gzip', 'if-none-match': js.headers.etag });
  assert.equal(again.statusCode, 304);
  assert.equal(again.rawPayload.length, 0);

  // 不接受压缩时原样返回，长度准确
  const raw = await get('/assets/index-abc123.js');
  assert.equal(raw.headers['content-encoding'], undefined);
  assert.equal(raw.body, BIG_JS);
});

test('真实连接：fetch 能解压，事件流和上传文件不压缩', async (t) => {
  const { app } = setup();
  const { project, description } = await seed(app);
  const base = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(() => app.close());

  const list = await fetch(`${base}/api/v1/admin/tasks?project=${project.id}`, { headers: owner });
  assert.equal(list.headers.get('content-encoding'), 'gzip');
  assert.equal((await list.json()).at(-1).description, description);

  const content = '文件内容'.repeat(2000);
  const file = await fetch(`${base}/api/v1/files?name=a.txt`, {
    method: 'POST',
    headers: { ...owner, 'content-type': 'application/octet-stream' },
    body: Buffer.from(content),
  });
  assert.equal(file.ok, true);
  const down = await fetch(`${base}${(await file.json()).url}`);
  assert.equal(down.headers.get('content-encoding'), null);
  assert.equal(await down.text(), content);

  const ctrl = new AbortController();
  const stream = await fetch(`${base}/api/v1/admin/stream`, { headers: { ...owner, 'accept-encoding': 'gzip' }, signal: ctrl.signal });
  assert.equal(stream.headers.get('content-encoding'), null);
  assert.match(String(stream.headers.get('content-type')), /event-stream/);
  ctrl.abort();
});

test('负责人接口 view=summary：不带正文；默认和 agent 接口不变', async () => {
  const { app, get } = setup();
  const { project, parent, description } = await seed(app);

  const brief = (await get(`/api/v1/admin/tasks?project=${project.id}&view=summary`)).json();
  assert.equal(brief.length, 2);
  for (const t of brief) {
    assert.equal(t.description, undefined);
    assert.equal(t.notes, undefined);
    assert.equal(t.acceptance, undefined);
    assert.ok(t.id && t.title && t.status && t.priority && t.updated_at);
  }
  const full = (await get(`/api/v1/admin/tasks?project=${project.id}`)).json();
  assert.equal(full[1].description, description);

  // 详情：自己的正文还在，子任务只留摘要
  const detail = (await get(`/api/v1/admin/tasks/${parent.id}?view=summary`)).json();
  assert.equal(detail.description, '父任务正文');
  assert.deepEqual(detail.acceptance, ['验收']);
  assert.equal(detail.subtasks.length, 1);
  assert.equal(detail.subtasks[0].title, '子任务');
  assert.equal(detail.subtasks[0].description, undefined);
  assert.equal((await get(`/api/v1/admin/tasks/${parent.id}`)).json().subtasks[0].description, description);
});
