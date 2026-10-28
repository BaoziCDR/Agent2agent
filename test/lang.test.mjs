import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../dist/server/db.js';
import { Hub } from '../dist/server/hub.js';
import { buildApp } from '../dist/server/app.js';
import { detectLang, normalizeLang } from '../dist/i18n/index.js';

const CLI = join(import.meta.dirname, '..', 'dist', 'cli', 'ahub.js');
process.removeAllListeners('warning');

test('语言写法归一：zh-CN、en_US.UTF-8 等，C/POSIX 视为没设', () => {
  assert.equal(normalizeLang('zh_CN.UTF-8'), 'zh');
  assert.equal(normalizeLang('zh-Hant-TW'), 'zh');
  assert.equal(normalizeLang('en_US.UTF-8'), 'en');
  assert.equal(normalizeLang('de-DE'), 'en');
  assert.equal(normalizeLang('C.UTF-8'), null);
  assert.equal(normalizeLang('POSIX'), null);
  assert.equal(normalizeLang(''), null);
});

test('命令行语言判断：--lang > AHUB_LANG > 本机设置 > LC_ALL > LC_MESSAGES > LANG > 系统语言 > 时区 > 英文', () => {
  const linux = { platform: 'linux', timeZone: 'UTC' };
  assert.deepEqual(detectLang({ ...linux, flag: 'en', env: { AHUB_LANG: 'zh' } }), { lang: 'en', from: '--lang' });
  assert.deepEqual(detectLang({ ...linux, env: { AHUB_LANG: 'zh', LANG: 'en_US.UTF-8' } }), { lang: 'zh', from: 'AHUB_LANG' });
  assert.deepEqual(detectLang({ ...linux, config: 'en', env: { LANG: 'zh_CN.UTF-8' } }), { lang: 'en', from: 'config' });
  assert.deepEqual(detectLang({ ...linux, env: { LC_ALL: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' } }), { lang: 'zh', from: 'LC_ALL' });
  assert.deepEqual(detectLang({ ...linux, env: { LC_MESSAGES: 'en_GB', LANG: 'zh_CN' } }), { lang: 'en', from: 'LC_MESSAGES' });
  assert.deepEqual(detectLang({ ...linux, env: { LANG: 'zh_CN.UTF-8' } }), { lang: 'zh', from: 'LANG' });
  // 终端没设 LANG（Windows、macOS 常见）：看系统界面语言
  assert.deepEqual(detectLang({ platform: 'win32', env: {}, systemLocale: 'zh-CN', timeZone: 'UTC' }), { lang: 'zh', from: 'system' });
  // LANG=C 视为没设；最后才看时区
  assert.deepEqual(detectLang({ platform: 'linux', env: { LANG: 'C.UTF-8' }, timeZone: 'Asia/Shanghai' }), { lang: 'zh', from: 'timezone' });
  assert.deepEqual(detectLang({ platform: 'linux', env: {}, timeZone: 'Europe/Berlin' }), { lang: 'en', from: 'default' });
});

async function setup() {
  const hub = new Hub(openDb(':memory:'));
  hub.ensureOwnerToken('owner_test');
  const app = buildApp(hub, { webDir: '/nonexistent', maxWaitSeconds: 2, filesDir: mkdtempSync(join(tmpdir(), 'ahub-files-')) });
  const owner = { authorization: 'Bearer owner_test' };
  const req = async (method, url, body, headers = owner) => {
    const res = await app.inject({ method, url, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, payload: body ? JSON.stringify(body) : undefined });
    return { status: res.statusCode, json: () => res.json(), text: res.body };
  };
  const project = (await req('POST', '/api/v1/admin/projects', { name: '演示' })).json();
  const invite = (await req('POST', '/api/v1/admin/invites', { project: project.id, max_uses: 5 })).json();
  const r = (await req('POST', '/api/v1/join', { invite: invite.code, name: '甲', platform: 'codex' }, {})).json();
  const s = (await req('POST', '/api/v1/sessions', { code: r.code, client: 'cli' }, {})).json();
  return { app, req, project, agent: { authorization: `Bearer ${s.session}` } };
}

test('Hub 按请求语言回复：x-ahub-lang、?lang、Accept-Language，旧客户端默认中文', async () => {
  const { req, agent } = await setup();
  const en = { ...agent, 'x-ahub-lang': 'en' };
  const md = await req('GET', '/api/v1/inbox?format=md', undefined, en);
  assert.match(md.text, /# Inbox of A-1/);
  assert.match(md.text, /Read up to event #\d+/);
  assert.match((await req('GET', '/api/v1/inbox?format=md&lang=en', undefined, agent)).text, /# Inbox of A-1/);
  assert.match((await req('GET', '/api/v1/inbox?format=md', undefined, { ...agent, 'accept-language': 'en-US,en;q=0.9' })).text, /# Inbox of A-1/);
  assert.match((await req('GET', '/api/v1/inbox?format=md', undefined, agent)).text, /# A-1 的收件箱/);
  const err = await req('POST', '/api/v1/tasks/P1-T9/claim?format=md', {}, en);
  assert.equal(err.status, 404);
  assert.doesNotMatch(err.text, /[一-鿿]/);
  assert.match((await req('GET', '/skill.md?lang=en', undefined, {})).text, /^---[\s\S]*## 1\. /);
  assert.doesNotMatch((await req('GET', '/skill.md?lang=en', undefined, {})).text.split('\n').slice(0, 20).join('\n'), /[一-鿿]/);
});

test('事件描述同时存中文和英文，按客户端语言显示', async () => {
  const { req, project } = await setup();
  await req('POST', '/api/v1/admin/tasks', { project: project.id, title: 'Weekly report' });
  const events = (await req('GET', `/api/v1/admin/events?project=${project.id}`)).json();
  const list = Array.isArray(events) ? events : events.events;
  const created = list.find((e) => e.type === 'task.created');
  assert.ok(created, JSON.stringify(list).slice(0, 300));
  assert.match(created.summary, /[一-鿿]/);
  assert.doesNotMatch(created.summary_en, /[\u4e00-\u9fff]{2}/);
  assert.notEqual(created.summary_en, created.summary);
});

test('ahub lang：查看、固定为英文后帮助变成英文，auto 恢复自动判断', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ahub-home-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, LANG: 'zh_CN.UTF-8' };
  for (const k of ['AHUB_LANG', 'LC_ALL', 'LC_MESSAGES']) delete env[k];
  const run = (args, extra = {}) =>
    new Promise((resolve) => execFile(process.execPath, [CLI, ...args], { env: { ...env, ...extra }, encoding: 'utf8' }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr })));
  assert.match((await run(['lang'])).stdout, /当前语言：中文（依据：LANG）/);
  assert.match((await run(['lang', 'en'])).stdout, /CLI and skill now use English/);
  assert.equal(JSON.parse(readFileSync(join(home, '.ahub', 'settings.json'), 'utf8')).lang, 'en');
  assert.match((await run(['help'])).stdout, /Multi-agent/i);
  assert.match((await run(['help'], { AHUB_LANG: 'zh' })).stdout, /多 Agent 协作中枢命令行/);
  assert.match((await run(['--lang', 'zh', 'lang'])).stdout, /当前语言：中文（依据：--lang）/);
  assert.match((await run(['lang', 'auto'])).stdout, /命令行和 skill 现在用中文/);
  assert.match((await run(['skill', 'show'], { AHUB_LANG: 'en' })).stdout, /## 1\. /);
  assert.equal((await run(['lang', 'fr'])).code, 1);
});
