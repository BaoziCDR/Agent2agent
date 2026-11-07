import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../dist/server/db.js';
import { Hub } from '../dist/server/hub.js';
import { buildApp, parseTrustProxy } from '../dist/server/app.js';
import { tasksCsv } from '../dist/server/report.js';
import { harnessEnv } from '../dist/cli/run.js';

const CLI = join(import.meta.dirname, '..', 'dist', 'cli', 'ahub.js');
process.removeAllListeners('warning');

async function setup(t, opts = {}) {
  const hub = new Hub(openDb(':memory:'), opts.hub);
  hub.ensureOwnerToken('owner_test');
  const app = buildApp(hub, { webDir: '/nonexistent', maxWaitSeconds: 1, filesDir: mkdtempSync(join(tmpdir(), 'ahub-files-')), ...opts, hub: undefined });
  t.after(() => app.close());
  const owner = { authorization: 'Bearer owner_test' };
  const req = async (method, url, body, headers = owner, extra = {}) => {
    const res = await app.inject({ method, url, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, payload: body ? JSON.stringify(body) : undefined, ...extra });
    return { status: res.statusCode, headers: res.headers, text: res.body, json: () => res.json() };
  };
  const project = (await req('POST', '/api/v1/admin/projects', { name: '演示' })).json();
  const invite = async (body = {}) => (await req('POST', '/api/v1/admin/invites', { project: project.id, max_uses: 5, ...body })).json().code;
  const join_ = async (name) => {
    const r = (await req('POST', '/api/v1/join', { invite: await invite(), name, platform: 'codex' }, {})).json();
    const s = (await req('POST', '/api/v1/sessions', { code: r.code, client: 'cli' }, {})).json();
    return { ...r, session: s.session, headers: { authorization: `Bearer ${s.session}` } };
  };
  return { hub, app, req, project, invite, join: join_ };
}

/**
 * 只发请求头、一个字节的请求体都不发，看 Hub 回什么。
 * 能在这种情况下直接回应，说明它没有等请求体；等请求体的话会一直挂着，这里返回 null。
 */
function statusWithoutBody(url, method, path, headers) {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const s = connect(Number(port), hostname);
    let got = '';
    const finish = (v) => {
      clearTimeout(timer);
      s.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), 800);
    s.on('error', reject);
    s.on('data', (d) => {
      got += d;
      const m = got.match(/^HTTP\/1\.1 (\d+)/);
      if (m) finish(Number(m[1]));
    });
    const lines = Object.entries({ host: 'x', ...headers }).map(([k, v]) => `${k}: ${v}`);
    s.write(`${method} ${path} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);
  });
}

const HUGE = { 'content-type': 'application/octet-stream', 'content-length': String(25 * 1024 * 1024) };
const JSON_5M = { 'content-type': 'application/json', 'content-length': String(4 * 1024 * 1024) };

test('上传接口：不带令牌或令牌无效时，不读请求体就拒绝', async (t) => {
  const { app } = await setup(t);
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  assert.equal(await statusWithoutBody(url, 'POST', '/api/v1/files?name=a', HUGE), 401);
  assert.equal(await statusWithoutBody(url, 'POST', '/api/v1/files?name=a', { ...HUGE, authorization: 'Bearer nope' }), 401);
});

test('其他接口：鉴权同样在读请求体之前；对不存在的接口发请求体也不读', async (t) => {
  const { app } = await setup(t);
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  for (const [method, path] of [
    ['PATCH', '/api/v1/me'],
    ['POST', '/api/v1/tasks/P1-T1/progress'],
    ['POST', '/api/v1/admin/projects'],
    ['POST', '/mcp'],
  ]) {
    assert.equal(await statusWithoutBody(url, method, path, JSON_5M), 401, `${method} ${path} JSON`);
    assert.equal(await statusWithoutBody(url, method, path, HUGE), 401, `${method} ${path} 二进制`);
  }
  assert.equal(await statusWithoutBody(url, 'POST', '/api/nope', JSON_5M), 404);
  assert.equal(await statusWithoutBody(url, 'POST', '/api/nope', HUGE), 404);
  assert.equal(await statusWithoutBody(url, 'POST', '/skill.md', HUGE), 404);
});

test('带控制台时：对不存在的接口发请求体也不读，GET 仍然回到控制台页面', async (t) => {
  const webDir = mkdtempSync(join(tmpdir(), 'ahub-web-'));
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>x</title>');
  const { app, req } = await setup(t, { webDir });
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  assert.equal(await statusWithoutBody(url, 'POST', '/nope', HUGE), 404);
  assert.equal(await statusWithoutBody(url, 'POST', '/api/nope', JSON_5M), 404);
  const page = await req('GET', '/agents', undefined, {});
  assert.equal(page.status, 200);
  assert.match(page.text, /doctype/);
});

test('不用登录的接口：请求体上限很小，大请求不读就拒绝', async (t) => {
  const { app } = await setup(t);
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  for (const path of ['/api/v1/sessions', '/api/v1/join']) {
    assert.equal(await statusWithoutBody(url, 'POST', path, JSON_5M), 413, `${path} JSON`);
    assert.equal(await statusWithoutBody(url, 'POST', path, HUGE), 413, `${path} 二进制`);
  }
});

/** 登录框的请求；from 是直接连接的地址，xff 是代理转发的来源 */
const ownerLogin = (req, token, from = '1.1.1.1', xff) =>
  req('POST', '/api/v1/admin/login', undefined, {}, {
    remoteAddress: from,
    payload: '{}',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(xff ? { 'x-forwarded-for': xff } : {}) },
  });

test('登录框：输错三次封禁这个 IP，正确的令牌也进不来，到时间后恢复，别的 IP 不受影响', async (t) => {
  let now = new Date('2026-11-07T00:00:00Z');
  const { req } = await setup(t, { hub: { now: () => now } });
  assert.equal((await ownerLogin(req, 'wrong')).status, 401);
  assert.equal((await ownerLogin(req, 'wrong')).status, 401);
  const third = await ownerLogin(req, 'wrong');
  assert.equal(third.status, 429);
  assert.equal(third.json().error.code, 'too_many_attempts');
  assert.match(third.json().error.message, /请 5 分钟后再试/);
  assert.equal(third.headers['retry-after'], '300');
  assert.equal((await ownerLogin(req, 'owner_test')).status, 429);
  assert.equal((await ownerLogin(req, 'owner_test', '2.2.2.2')).status, 200);
  now = new Date(now.getTime() + 299_000);
  assert.equal((await ownerLogin(req, 'owner_test')).status, 429);
  now = new Date(now.getTime() + 2_000);
  assert.equal((await ownerLogin(req, 'owner_test')).status, 200);
  // 成功后重新计数，封禁结束后再错一次不会马上又被封
  assert.equal((await ownerLogin(req, 'wrong')).status, 401);
  assert.equal((await ownerLogin(req, 'wrong')).status, 401);
  assert.equal((await ownerLogin(req, 'owner_test')).status, 200);
  assert.equal((await ownerLogin(req, 'wrong')).status, 401);
});

test('负责人令牌：逐级加长封禁，最多 12 小时；登录成功或 24 小时没有新错误才从头算', async (t) => {
  let now = new Date('2026-11-07T00:00:00Z');
  const { req } = await setup(t, { hub: { now: () => now } });
  const later = (ms) => (now = new Date(now.getTime() + ms));
  const round = async () => {
    assert.equal((await ownerLogin(req, 'wrong')).status, 401);
    assert.equal((await ownerLogin(req, 'wrong')).status, 401);
    const r = await ownerLogin(req, 'wrong');
    assert.equal(r.status, 429);
    return Number(r.headers['retry-after']);
  };
  const steps = [];
  for (let i = 0; i < 6; i++) {
    const s = await round();
    steps.push(s);
    later(s * 1000 + 1000);
  }
  assert.deepEqual(steps, [300, 1800, 7200, 43200, 43200, 43200]);
  // 封禁中继续输错不会延长，也不会跳级
  await ownerLogin(req, 'wrong');
  await ownerLogin(req, 'wrong');
  assert.equal((await ownerLogin(req, 'wrong')).headers['retry-after'], '43200');
  later(10_000);
  assert.equal((await ownerLogin(req, 'wrong')).headers['retry-after'], '43190');
  // 封禁结束后 24 小时内再错，还是 12 小时；超过 24 小时没有错误，从 5 分钟开始
  later(43_190_000 + 23 * 3_600_000);
  assert.equal(await round(), 43200);
  later((43_200 + 24 * 3600) * 1000);
  assert.equal(await round(), 300);
  // 登录成功后也从头算
  later(301_000);
  assert.equal(await round(), 1800);
  later(1_801_000);
  assert.equal((await ownerLogin(req, 'owner_test')).status, 200);
  assert.equal(await round(), 300);
  // 错误信息显示剩余时间
  later(301_000);
  await round();
  assert.match((await ownerLogin(req, 'wrong')).json().error.message, /请 30 分钟后再试/);
  later(1_801_000);
  await round();
  assert.match((await ownerLogin(req, 'wrong')).json().error.message, /请 2 小时后再试/);
});

test('负责人令牌：旧页面反复用同一个旧令牌不会封 IP，不同的错误令牌会；没带令牌不算', async (t) => {
  const { req } = await setup(t);
  const from = { remoteAddress: '1.1.1.1' };
  const call = (token, ip = from) => req('GET', '/api/v1/admin/projects', undefined, token ? { authorization: `Bearer ${token}` } : {}, ip);
  for (let i = 0; i < 10; i++) assert.equal((await call('old-token')).status, 401);
  for (let i = 0; i < 10; i++) assert.equal((await call(null)).status, 401);
  assert.equal((await call('owner_test')).status, 200);
  assert.equal((await call('guess-1')).status, 401);
  assert.equal((await call('guess-2')).status, 429);
  assert.equal((await call('owner_test')).status, 429);
  assert.equal((await call(null)).status, 429);
});

test('负责人令牌：封禁不影响同一 IP 上的 agent；上传接口也不能绕过', async (t) => {
  const { req, app, join: joinAgent } = await setup(t);
  const a = await joinAgent('甲');
  const ip = { remoteAddress: '127.0.0.1' };
  const upload = (token) => app.inject({ method: 'POST', url: '/api/v1/files?name=a', remoteAddress: '127.0.0.1', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, payload: Buffer.from('x') });
  assert.equal((await upload('guess-1')).statusCode, 401);
  assert.equal((await upload('guess-2')).statusCode, 401);
  assert.equal((await upload('guess-3')).statusCode, 401);
  assert.equal((await upload('owner_test')).statusCode, 429);
  assert.equal((await req('GET', '/api/v1/admin/projects', undefined, undefined, ip)).status, 429);
  assert.equal((await req('GET', '/api/v1/me', undefined, a.headers, ip)).status, 200);
  assert.equal((await upload(a.session)).statusCode, 201);
});

test('负责人令牌：代理后面没配置 AHUB_TRUST_PROXY 时，别人输错不能把负责人关在外面', async (t) => {
  const { req } = await setup(t);
  const proxy = '172.18.0.2';
  for (const token of ['g1', 'g2', 'g3']) await ownerLogin(req, token, proxy, '6.6.6.6');
  assert.equal((await ownerLogin(req, 'wrong', proxy, '6.6.6.6')).status, 429);
  assert.equal((await ownerLogin(req, 'owner_test', proxy, '7.7.7.7')).status, 200);
});

test('负责人令牌：配置了信任的代理时按真实 IP 封禁，伪造转发头绕不过去', async (t) => {
  const { req } = await setup(t, { trustProxy: '172.18.0.0/16' });
  const proxy = '172.18.0.2';
  for (const token of ['g1', 'g2', 'g3']) await ownerLogin(req, token, proxy, '6.6.6.6');
  assert.equal((await ownerLogin(req, 'owner_test', proxy, '6.6.6.6')).status, 429);
  assert.equal((await ownerLogin(req, 'owner_test', proxy, '9.9.9.9, 6.6.6.6')).status, 429);
  assert.equal((await ownerLogin(req, 'owner_test', proxy, '7.7.7.7')).status, 200);
});

test('登录框：是密码框，里面没有任何提示', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'web', 'src', 'App.tsx'), 'utf8');
  const input = src.match(/<input id="token"[^>]*>/)[0];
  assert.match(input, /type="password"/);
  assert.doesNotMatch(input, /placeholder/);
});

test('上传：有效令牌仍然能传大文件；令牌失效的客户端能正常拿到 401，不会连接报错', async (t) => {
  const { app, join: joinAgent } = await setup(t);
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  const a = await joinAgent('甲');
  const big = new Uint8Array(6 * 1024 * 1024);
  const ok = await fetch(`${url}/api/v1/files?name=big.bin`, { method: 'POST', headers: { ...a.headers, 'content-type': 'application/octet-stream' }, body: big });
  assert.equal(ok.status, 201);
  assert.equal((await ok.json()).size, big.length);
  const bad = await fetch(`${url}/api/v1/files?name=big.bin`, { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/octet-stream' }, body: big });
  assert.equal(bad.status, 401);
  // 同一个地址接着发请求：连接状态没有被没读完的请求体弄乱
  const next = await fetch(`${url}/api/v1/me`, { headers: a.headers });
  assert.equal(next.status, 200);
  const wrong = await fetch(`${url}/api/v1/files?name=a`, { method: 'POST', headers: { ...a.headers, 'content-type': 'text/plain' }, body: 'x' });
  assert.equal(wrong.status, 400);
});

test('鉴权提前后：收件箱确认和活动时间照常，请求体格式错误不算确认', async (t) => {
  const { req, join: joinAgent, hub } = await setup(t);
  const a = await joinAgent('甲');
  const before = hub.lastSeq();
  await req('GET', `/api/v1/me?ack=${before}`, undefined, a.headers);
  assert.equal((await req('GET', '/api/v1/me', undefined, a.headers)).json().ack_seq, before);
  const lower = before - 1;
  const res = await req('PATCH', `/api/v1/me?ack=${lower}`, undefined, a.headers, { payload: '{坏的', headers: { ...a.headers, 'content-type': 'application/json' } });
  assert.equal(res.status, 400);
  assert.equal((await req('GET', '/api/v1/me', undefined, a.headers)).json().ack_seq, before);
});

test('登录锁定：正确的身份码不受影响，错误的码仍然被限制', async (t) => {
  const { req, join: joinAgent } = await setup(t);
  const a = await joinAgent('甲');
  await req('DELETE', '/api/v1/sessions/current', undefined, a.headers);
  for (let i = 0; i < 10; i++) assert.equal((await req('POST', '/api/v1/sessions', { code: 'AAAA-BBBB-CCCC' }, {})).status, 401);
  assert.equal((await req('POST', '/api/v1/sessions', { code: 'AAAA-BBBB-CCCC' }, {})).status, 429);
  assert.equal((await req('POST', '/api/v1/sessions', { code: a.code }, {})).status, 201);
  // 还在锁定期内，旧邀请码（只有 6 位，能猜）不能绕过去
  const { invite } = await (async () => ({ invite: (await req('POST', '/api/v1/admin/invites', { project: 'P-1', max_uses: 1 })).json().code }))();
  assert.equal((await req('POST', '/api/v1/sessions', { code: invite, name: '乙' }, {})).status, 429);
});

test('反向代理：配置了信任的代理才取真实 IP，按真实 IP 分别计数，伪造的请求头没用', async (t) => {
  const { req, join: joinAgent } = await setup(t, { trustProxy: '172.18.0.0/16' });
  const a = await joinAgent('甲');
  await req('DELETE', '/api/v1/sessions/current', undefined, a.headers);
  const viaProxy = (xff) => ({ remoteAddress: '172.18.0.2', headers: { 'x-forwarded-for': xff, 'content-type': 'application/json' } });
  const login = (code, extra) => req('POST', '/api/v1/sessions', { code }, {}, extra);
  for (let i = 0; i < 10; i++) assert.equal((await login('AAAA-BBBB-CCCC', viaProxy('1.1.1.1'))).status, 401);
  assert.equal((await login('AAAA-BBBB-CCCC', viaProxy('1.1.1.1'))).status, 429);
  // 另一个来源不受牵连
  assert.equal((await login('AAAA-BBBB-CCCC', viaProxy('2.2.2.2'))).status, 401);
  // 攻击者在请求里伪造 X-Forwarded-For，Nginx 会把真实地址接在最后，取到的还是真实地址
  assert.equal((await login('AAAA-BBBB-CCCC', viaProxy('9.9.9.9, 1.1.1.1'))).status, 429);
  // 不是从信任的代理来的，请求头不算数
  const direct = { remoteAddress: '8.8.8.8', headers: { 'x-forwarded-for': '1.1.1.1', 'content-type': 'application/json' } };
  assert.equal((await login('AAAA-BBBB-CCCC', direct)).status, 401);
  // 连接记录里是真实 IP
  assert.equal((await login(a.code, viaProxy('3.3.3.3'))).status, 201);
  const sessions = (await req('GET', `/api/v1/admin/agents/${a.agent.id}/sessions`)).json();
  assert.equal(sessions[0].ip, '3.3.3.3');
});

test('反向代理：没有配置时不看 X-Forwarded-For', async (t) => {
  const { req } = await setup(t);
  const from = (ip) => ({ remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': ip, 'content-type': 'application/json' } });
  for (let i = 0; i < 10; i++) assert.equal((await req('POST', '/api/v1/sessions', { code: 'AAAA-BBBB-CCCC' }, {}, from(`1.1.1.${i}`))).status, 401);
  assert.equal((await req('POST', '/api/v1/sessions', { code: 'AAAA-BBBB-CCCC' }, {}, from('2.2.2.2'))).status, 429);
});

test('AHUB_TRUST_PROXY：只接受 IP 和网段，写错时启动就报错', () => {
  assert.equal(parseTrustProxy(undefined), undefined);
  assert.equal(parseTrustProxy('  '), undefined);
  assert.equal(parseTrustProxy('172.18.0.0/16'), '172.18.0.0/16');
  assert.equal(parseTrustProxy('172.18.0.2, ::1 ,10.0.0.0/8'), '172.18.0.2,::1,10.0.0.0/8');
  for (const bad of ['true', '*', '1', '172.18.0.0/99', 'nginx', '10.0.0.1,']) assert.throws(() => parseTrustProxy(bad), /AHUB_TRUST_PROXY/, bad);
});

test('保留名字：agent 不能把自己叫成负责人，名字里带这个词的不受影响', async (t) => {
  const { req, join: joinAgent, invite } = await setup(t);
  const a = await joinAgent('甲');
  for (const name of ['负责人', ' 负责人 ', '【负责人】', '负​责人', 'OWNER', 'Owner!', 'ｏｗｎｅｒ']) {
    const r = await req('PATCH', '/api/v1/me', { name }, a.headers);
    assert.equal(r.status, 400, name);
    assert.equal(r.json().error.code, 'invalid');
  }
  assert.equal((await req('GET', '/api/v1/me', undefined, a.headers)).json().name, '甲');
  assert.equal((await req('PATCH', '/api/v1/me', { name: '后端负责人' }, a.headers)).status, 200);
  assert.equal((await req('POST', '/api/v1/join', { invite: await invite(), name: '负责人' }, {})).status, 400);
  // 负责人预留的身份第一次连接时自己起名
  const created = (await req('POST', '/api/v1/admin/agents', { project: 'P-1' })).json();
  assert.equal((await req('POST', '/api/v1/sessions', { code: created.code, name: '负责人' }, {})).status, 400);
  assert.equal((await req('POST', '/api/v1/sessions', { code: created.code, name: '乙' }, {})).status, 201);
});

test('交付物：结构不对的返回 400，不写入数据库', async (t) => {
  const { req, join: joinAgent } = await setup(t);
  const a = await joinAgent('甲');
  const task = (await req('POST', '/api/v1/admin/tasks', { project: 'P-1', title: '任务', assignee: 'A-1' })).json();
  await req('POST', `/api/v1/tasks/${task.id}/accept`, {}, a.headers);
  const submit = (artifacts) => req('POST', `/api/v1/tasks/${task.id}/submit`, { summary: '好了', artifacts }, a.headers);
  const bad = [
    [{ name: 'x', parts: [{ kind: 'text', text: { a: 1 } }] }],
    [{ name: 'x', parts: [{ kind: 'text', text: 123 }] }],
    [{ name: 'x', parts: [{ kind: 'link', url: { a: 1 } }] }],
    [{ name: 'x', parts: [null] }],
    [{ name: 'x', parts: ['字符串'] }],
    [{ name: 'x', parts: [{ kind: '别的' }] }],
    [{ name: { a: 1 }, parts: [] }],
    [null],
    ['字符串'],
    [{ name: 'x', parts: [{ kind: 'link', url: 'javascript:alert(1)' }] }],
    [{ name: 'x', parts: [{ kind: 'link', url: ' JavaScript:alert(1)' }] }],
    [{ name: 'x', parts: [{ kind: 'link', url: 'java\tscript:alert(1)' }] }],
    [{ name: 'x', url: 'data:text/html,<script>alert(1)</script>' }],
    [{ name: 'x', url: 'vbscript:x' }],
  ];
  for (const artifacts of bad) {
    const r = await submit(artifacts);
    assert.equal(r.status, 400, JSON.stringify(artifacts));
    assert.equal(r.json().error.code, 'invalid');
  }
  assert.equal((await req('GET', `/api/v1/tasks/${task.id}`, undefined, a.headers)).json().status, 'working');
});

test('交付物：正常的文本、链接和数据照常保存，客户端拼的文件部分仍被去掉', async (t) => {
  const { req, join: joinAgent } = await setup(t);
  const a = await joinAgent('甲');
  const task = (await req('POST', '/api/v1/admin/tasks', { project: 'P-1', title: '任务', assignee: 'A-1' })).json();
  await req('POST', `/api/v1/tasks/${task.id}/accept`, {}, a.headers);
  const r = await req(
    'POST',
    `/api/v1/tasks/${task.id}/submit`,
    {
      summary: '好了',
      artifacts: [
        { name: '文本', content: '正文' },
        { name: 'https://example.com/a', url: 'https://example.com/a' },
        { name: '没写协议的链接', url: 'github.com/foo/bar' },
        { name: '相对地址', parts: [{ kind: 'link', url: '/files/abc' }] },
        { name: '邮件', parts: [{ kind: 'link', url: 'mailto:a@example.com' }] },
        { name: '结构', parts: [{ kind: 'data', data: { a: 1 } }, { kind: 'text', text: '说明' }, { kind: 'file', url: '/files/别人的' }] },
      ],
    },
    a.headers,
  );
  assert.equal(r.status, 200, r.text);
  const parts = Object.fromEntries((await req('GET', `/api/v1/tasks/${task.id}`, undefined, a.headers)).json().artifacts.map((x) => [x.name, x.parts]));
  assert.equal(parts['文本'][0].text, '正文');
  assert.equal(parts['https://example.com/a'][0].url, 'https://example.com/a');
  assert.equal(parts['没写协议的链接'][0].url, 'github.com/foo/bar');
  assert.equal(parts['邮件'][0].url, 'mailto:a@example.com');
  assert.deepEqual(parts['结构'].map((p) => p.kind), ['data', 'text']);
});

test('CSV：以公式字符开头的内容不会被 Excel 当成公式', async (t) => {
  const { hub, req } = await setup(t);
  const titles = ['=HYPERLINK("http://x","点我")', '+1+1', '-1+1', '@SUM(A1)', '  =1+1', '\t=1+1', '＝1+1', '普通标题 = 不是公式'];
  for (const title of titles) assert.equal((await req('POST', '/api/v1/admin/tasks', { project: 'P-1', title })).status, 201);
  const csv = tasksCsv(hub);
  const rows = csv.replace(/^﻿/, '').split('\r\n').slice(1, -1);
  assert.equal(rows.length, titles.length);
  assert.match(rows[0], /^P1-T1,P-1,"'=HYPERLINK\(""http:\/\/x"",""点我""\)",/);
  assert.match(rows[1], /,'\+1\+1,/);
  assert.match(rows[2], /,'-1\+1,/);
  assert.match(rows[3], /,'@SUM\(A1\),/);
  assert.match(rows[4], /,'=1\+1,/);
  assert.match(rows[6], /,'＝1\+1,/);
  assert.match(rows[7], /,普通标题 = 不是公式,/);
});

test('响应头：控制台、接口和错误都带安全头，下载文件保留更严格的 CSP', async (t) => {
  const webDir = mkdtempSync(join(tmpdir(), 'ahub-web-'));
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>x</title>');
  const { req, join: joinAgent, app } = await setup(t, { webDir });
  const check = (r) => {
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.match(r.headers['content-security-policy'], /default-src 'self'/);
    assert.match(r.headers['content-security-policy'], /script-src 'self'(;|$)/);
    assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.match(r.headers['content-security-policy'], /object-src 'none'/);
    assert.match(r.headers['content-security-policy'], /base-uri 'none'/);
  };
  check(await req('GET', '/', undefined, {}));
  check(await req('GET', '/agents', undefined, {}));
  check(await req('GET', '/api/v1/health', undefined, {}));
  check(await req('GET', '/api/v1/inbox', undefined, {}));
  check(await req('GET', '/api/nope', undefined, {}));
  const a = await joinAgent('甲');
  const up = await app.inject({ method: 'POST', url: '/api/v1/files?name=a.txt', headers: { ...a.headers, 'content-type': 'application/octet-stream' }, payload: Buffer.from('hi') });
  const file = await req('GET', `/files/${up.json().id}`, undefined, {});
  assert.equal(file.status, 200);
  assert.equal(file.headers['content-security-policy'], "default-src 'none'");
  assert.equal(file.headers['x-frame-options'], 'DENY');
});

test('值守模式的文件路径：工作目录和临时目录可以，别的地方不行；手动运行不限制', async (t) => {
  const { app, join: joinAgent, req } = await setup(t);
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  const a = await joinAgent('甲');
  await req('DELETE', '/api/v1/sessions/current', undefined, a.headers);
  const task = (await req('POST', '/api/v1/admin/tasks', { project: 'P-1', title: '任务', assignee: 'A-1' })).json();

  const home = mkdtempSync(join(tmpdir(), 'ahub-home-'));
  const work = join(home, 'work');
  const extra = join(home, 'extra');
  const temp = join(home, 'tmp');
  for (const d of [work, extra, temp]) mkdirSync(d);
  const secret = join(home, 'secret.txt');
  writeFileSync(secret, '秘密');
  writeFileSync(join(work, 'ok.txt'), '可以');
  writeFileSync(join(temp, 'shot.txt'), '临时');
  writeFileSync(join(extra, 'more.txt'), '放开的');
  symlinkSync(secret, join(work, 'link.txt'));
  symlinkSync(home, join(work, 'up'));

  const env = { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: temp, TEMP: temp, TMP: temp, AHUB_LANG: 'zh' };
  for (const k of ['AHUB_CODE', 'AHUB_URL', 'AHUB_IDENTITY', 'AHUB_RUN', 'AHUB_PATH_ROOTS']) delete env[k];
  const run = (args, more = {}) =>
    new Promise((resolve) =>
      execFile(process.execPath, [CLI, ...args], { cwd: work, env: { ...env, ...more }, encoding: 'utf8', timeout: 15000 }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr })),
    );
  const joined = await run(['join', '--hub', url, '--code', a.code, '--save-only']);
  assert.equal(joined.code, 0, joined.stderr);
  // 先用普通命令连接一次，把授权 ID 存下来，后面的命令才能共用
  assert.equal((await run(['inbox'])).code, 0);
  const guarded = harnessEnv('', work, [extra]);
  assert.equal(guarded.AHUB_RUN, '1');
  const inRun = { AHUB_RUN: '1', AHUB_PATH_ROOTS: guarded.AHUB_PATH_ROOTS };
  const refused = (r, what) => {
    assert.notEqual(r.code, 0, what);
    assert.match(r.stderr, /不在工作目录内/, what);
  };

  refused(await run(['upload', secret], inRun), '外面的文件');
  refused(await run(['upload', '../secret.txt'], inRun), '相对路径跳出去');
  refused(await run(['upload', 'link.txt'], inRun), '指向外面的符号链接');
  refused(await run(['upload', 'up/secret.txt'], inRun), '符号链接目录');
  assert.equal((await run(['upload', 'ok.txt'], inRun)).code, 0, '工作目录');
  const shot = await run(['upload', join(temp, 'shot.txt')], inRun);
  assert.equal(shot.code, 0, shot.stderr);
  assert.equal((await run(['upload', join(extra, 'more.txt')], inRun)).code, 0, '--allow-path 放开的目录');

  refused(await run(['comment', task.id, '看', '--file', secret], inRun), 'comment --file');
  refused(await run(['download', task.id, '--to', join(home, 'elsewhere')], inRun), 'download --to');
  assert.ok(!existsSync(join(home, 'elsewhere')), '被拒绝时不应该建目录');
  refused(await run(['artifact', 'patch', task.id, '1', '--base', '1', '--edits', secret], inRun), 'artifact patch --edits');

  await run(['accept', task.id]);
  refused(await run(['submit', task.id, '好了', '--file', secret], inRun), 'submit --file');
  const done = await run(['submit', task.id, '好了', '--file', 'ok.txt'], inRun);
  assert.equal(done.code, 0, done.stderr);
  const artifacts = (await req('GET', `/api/v1/admin/tasks/${task.id}`)).json().artifacts;
  const id = artifacts.find((x) => x.name === 'ok.txt').id;
  refused(await run(['artifact', 'show', task.id, String(id), '--out', secret], inRun), 'artifact show --out');
  assert.equal(readFileSync(secret, 'utf8'), '秘密');
  refused(await run(['artifact', 'show', task.id, String(id), '--out', join(work, 'up', 'new.txt')], inRun), '写到符号链接目录外');
  assert.equal((await run(['artifact', 'show', task.id, String(id), '--out', 'draft.md'], inRun)).code, 0, '写到工作目录');
  assert.equal(readFileSync(join(work, 'draft.md'), 'utf8'), '可以');

  // 不是值守进程唤起的：人自己在终端用，不限制
  assert.equal((await run(['upload', secret])).code, 0, '手动运行');
});
