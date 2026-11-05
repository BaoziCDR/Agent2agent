import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../dist/server/db.js';
import { Hub } from '../dist/server/hub.js';
import { buildApp } from '../dist/server/app.js';
import { openEventStream, sseParser } from '../dist/shared/event-stream.js';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'dist', 'cli', 'ahub.js');
process.removeAllListeners('warning');

async function setup(t) {
  const hub = new Hub(openDb(':memory:'));
  hub.ensureOwnerToken('owner_test');
  const app = buildApp(hub, { webDir: '/nonexistent', maxWaitSeconds: 1, filesDir: mkdtempSync(join(tmpdir(), 'ahub-files-')) });
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  // 事件流是长连接，要主动断开，否则 close 一直等
  t.after(() => {
    const closing = app.close();
    app.server.closeAllConnections();
    return closing;
  });
  const owner = { authorization: 'Bearer owner_test' };
  const admin = async (method, path, body) =>
    (await fetch(url + path, { method, headers: { ...owner, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  return { url, app, owner, admin };
}

const until = async (cond, what) => {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`等待超时：${what}`);
};

test('令牌只认请求头：URL 里的 ?token= 一律 401', async (t) => {
  const { url, owner, admin } = await setup(t);
  const project = await admin('POST', '/api/v1/admin/projects', { name: '演示' });
  const invite = await admin('POST', '/api/v1/admin/invites', { project: project.id });
  const joined = await (await fetch(`${url}/api/v1/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite: invite.code, name: '甲', platform: 'codex' }) })).json();
  const { session } = await (await fetch(`${url}/api/v1/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: joined.code, client: 'cli' }) })).json();

  for (const path of ['/api/v1/admin/stream?token=owner_test', '/api/v1/admin/projects?token=owner_test']) {
    assert.equal((await fetch(url + path)).status, 401, path);
  }
  for (const path of [`/api/v1/inbox?token=${session}`, `/api/v1/stream?token=${session}`, `/mcp?token=${session}`]) {
    assert.equal((await fetch(url + path)).status, 401, path);
  }
  assert.equal((await fetch(`${url}/api/v1/files?token=owner_test`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'x' })).status, 401);

  // 请求头照常可用
  assert.equal((await fetch(`${url}/api/v1/admin/projects`, { headers: owner })).status, 200);
  assert.equal((await fetch(`${url}/api/v1/inbox`, { headers: { authorization: `Bearer ${session}` } })).status, 200);
});

test('控制台的代码里没有把令牌放进 URL 的写法', () => {
  const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
  for (const file of walk(join(ROOT, 'web', 'src')).filter((f) => /\.tsx?$/.test(f))) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /[?&]token=/, file);
    assert.doesNotMatch(text, /new EventSource\(/, file);
  }
});

test('SSE 解析：跨分片、注释、CRLF、多行 data', () => {
  const feed = sseParser();
  assert.deepEqual(feed(': 心跳\n\nid: 7\nevent: task.cre'), []);
  assert.deepEqual(feed('ated\ndata: {"a"'), []);
  assert.deepEqual(feed(':1}\n\n'), [{ id: '7', event: 'task.created', data: '{"a":1}' }]);
  assert.deepEqual(feed('event: x\r\ndata: 一\r\ndata: 二\r\n\r\n'), [{ id: '7', event: 'x', data: '一\n二' }]);
  assert.deepEqual(feed('data: 没有事件名\n\n'), [{ id: '7', event: 'message', data: '没有事件名' }]);
});

test('事件流客户端：令牌走请求头，断开后用 Last-Event-ID 补事件', async (t) => {
  const { url, app, owner, admin } = await setup(t);
  const seen = [];
  let opened = 0;
  const close = openEventStream({
    url: `${url}/api/v1/admin/stream`,
    headers: () => owner,
    retryMs: 20,
    onOpen: () => opened++,
    onEvent: (m) => seen.push(m),
  });
  t.after(close);
  await until(() => opened === 1, '首次连接');
  await admin('POST', '/api/v1/admin/projects', { name: '第一个' });
  await until(() => seen.some((m) => m.event === 'project.created'), '收到实时事件');
  assert.ok(seen.every((m) => m.id));

  // 服务端断开连接：客户端自动重连；断开期间的事件靠 Last-Event-ID 补上
  app.server.closeAllConnections();
  await admin('POST', '/api/v1/admin/projects', { name: '断开期间' });
  await until(() => opened >= 2, '自动重连');
  await until(() => seen.filter((m) => m.event === 'project.created').length === 2, '补上断开期间的事件');
});

test('事件流客户端：令牌被拒绝时报错一次，不再重试', async (t) => {
  const { url } = await setup(t);
  let errors = 0;
  let opened = 0;
  const close = openEventStream({
    url: `${url}/api/v1/admin/stream`,
    headers: () => ({ authorization: 'Bearer wrong' }),
    retryMs: 5,
    onOpen: () => opened++,
    onError: () => errors++,
    onEvent: () => undefined,
  });
  t.after(close);
  await until(() => errors > 0, '报错');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(errors, 1);
  assert.equal(opened, 0);
});

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

/** 启动一次 ahub serve，读到启动信息后退出，返回全部输出 */
async function serveOutput(t, data, extra = []) {
  const child = spawn(process.execPath, [CLI, 'serve', '--host', '127.0.0.1', '--port', String(await freePort()), '--data', data, '--lang', 'zh', ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  await until(() => /负责人令牌/.test(out), `ahub serve 启动：${out}`);
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
  return out;
}

test('ahub serve：首次生成和重置令牌时都不打印令牌，只写进文件', async (t) => {
  const data = mkdtempSync(join(tmpdir(), 'ahub-data-'));
  const tokenFile = join(data, 'owner-token.txt');
  const first = await serveOutput(t, data);
  const token = readFileSync(tokenFile, 'utf8').trim();
  assert.match(token, /^owner_/);
  assert.ok(!first.includes(token), '首次启动不应打印令牌');
  assert.ok(first.includes(tokenFile));

  const reset = await serveOutput(t, data, ['--reset-owner-token']);
  const next = readFileSync(tokenFile, 'utf8').trim();
  assert.notEqual(next, token);
  assert.ok(!reset.includes(next), '重置时不应打印新令牌');
  assert.ok(!reset.includes(token));
});

test('--identity 配合 --hub：同一个编号优先用这个 Hub 上的身份', async (t) => {
  const { url, admin } = await setup(t);
  const project = await admin('POST', '/api/v1/admin/projects', { name: '演示' });
  const invite = await admin('POST', '/api/v1/admin/invites', { project: project.id });
  const joined = await (await fetch(`${url}/api/v1/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite: invite.code, name: '甲', platform: 'codex' }) })).json();

  const home = mkdtempSync(join(tmpdir(), 'ahub-home-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const k of ['AHUB_URL', 'AHUB_TOKEN', 'AHUB_CODE', 'AHUB_IDENTITY', 'AHUB_SESSION']) delete env[k];
  const run = (args) => new Promise((resolve) => execFile(process.execPath, [CLI, ...args, '--lang', 'zh'], { cwd: home, env, encoding: 'utf8' }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr })));

  assert.equal((await run(['join', '--hub', url, '--code', joined.code, '--platform', 'codex'])).code, 0);
  // 另一个 Hub 上有同编号的身份，目录名排在前面
  const other = join(home, '.ahub', 'identities', '0000000000');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'config.json'), JSON.stringify({ hub: 'http://127.0.0.1:9', code: 'ZZZZ-ZZZZ-ZZZZ', agent: joined.agent.id, name: '别的 Hub' }));

  const me = await run(['whoami', '--hub', `${url}/`, '--identity', joined.agent.id]);
  assert.equal(me.code, 0, me.stderr);
  assert.match(me.stdout, /甲/);
  // 没给 --hub 时维持原来的查找规则
  assert.match((await run(['identities'])).stdout, /别的 Hub/);
});

test('控制台的值守命令：join --save-only 之后，run --identity 不会撞上「已经在线」', async (t) => {
  const { url, admin } = await setup(t);
  const project = await admin('POST', '/api/v1/admin/projects', { name: '演示' });
  const invite = await admin('POST', '/api/v1/admin/invites', { project: project.id });
  const joined = await (await fetch(`${url}/api/v1/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite: invite.code, name: '甲', platform: 'codex' }) })).json();

  const home = mkdtempSync(join(tmpdir(), 'ahub-home-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const k of ['AHUB_URL', 'AHUB_TOKEN', 'AHUB_CODE', 'AHUB_IDENTITY', 'AHUB_SESSION']) delete env[k];
  const run = (args) => new Promise((resolve) => execFile(process.execPath, [CLI, ...args, '--lang', 'zh'], { cwd: home, env, encoding: 'utf8' }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr })));

  const saved = await run(['join', '--hub', url, '--code', joined.code, '--platform', 'codex', '--save-only']);
  assert.equal(saved.code, 0, saved.stderr);
  assert.match(saved.stdout, /不占用在线状态/);
  const dir = join(home, '.ahub', 'identities', readdirSync(join(home, '.ahub', 'identities'))[0]);
  const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  assert.equal(config.code, joined.code);
  assert.equal(config.session, undefined);

  // 值守连上后不会自己退出，等一会儿就结束它，只看连接结果
  const daemon = await new Promise((resolve) =>
    execFile(process.execPath, [CLI, 'run', '--harness', 'codex', '--hub', url, '--identity', joined.agent.id, '--dry-run', '--lang', 'zh'], { cwd: home, env, encoding: 'utf8', timeout: 2500, killSignal: 'SIGKILL' }, (err, stdout, stderr) => resolve({ stdout, stderr })),
  );
  assert.doesNotMatch(daemon.stderr, /已经在线/);
  assert.match(daemon.stdout, /已连接 Hub，身份 甲/);
  assert.ok(!daemon.stdout.includes(joined.code), '值守的输出不应带身份码');
});

test('ahub：身份码不留在进程列表里', { skip: process.platform !== 'linux' }, async (t) => {
  const code = 'ABCD-EFGH-JKLM';
  const home = mkdtempSync(join(tmpdir(), 'ahub-home-'));
  const env = { ...process.env, HOME: home };
  for (const k of ['AHUB_URL', 'AHUB_TOKEN', 'AHUB_CODE', 'AHUB_IDENTITY', 'AHUB_SESSION']) delete env[k];
  const child = spawn(process.execPath, [CLI, 'mcp', '--hub', 'http://127.0.0.1:9', '--code', code], { env, stdio: ['pipe', 'ignore', 'ignore'] });
  t.after(() => child.kill('SIGKILL'));
  const cmdline = () => readFileSync(`/proc/${child.pid}/cmdline`, 'utf8');
  await until(() => cmdline().startsWith('ahub mcp'), '改写进程标题');
  assert.ok(!cmdline().includes(code));
});
