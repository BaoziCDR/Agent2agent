import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../dist/server/db.js';
import { Hub } from '../dist/server/hub.js';
import { buildApp } from '../dist/server/app.js';

const CLI = join(import.meta.dirname, '..', 'dist', 'cli', 'ahub.js');
process.removeAllListeners('warning');

/** 起一个真实监听的 Hub，在临时目录里运行 ahub；目录里预先写好一个已停用的身份。 */
async function setup(t) {
  const hub = new Hub(openDb(':memory:'));
  hub.ensureOwnerToken('owner_test');
  const app = buildApp(hub, { webDir: '/nonexistent', maxWaitSeconds: 2, filesDir: mkdtempSync(join(tmpdir(), 'ahub-files-')) });
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(() => app.close());
  const owner = { authorization: 'Bearer owner_test' };
  const call = async (method, path, body) => (await fetch(url + path, { method, headers: body ? { ...owner, 'content-type': 'application/json' } : owner, body: body && JSON.stringify(body) })).json();
  const project = await call('POST', '/api/v1/admin/projects', { name: '演示' });
  const invite = async () => (await call('POST', '/api/v1/admin/invites', { project: project.id })).code;
  const joined = await (await fetch(url + '/api/v1/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite: await invite(), name: '旧身份' }) })).json();
  await call('PATCH', `/api/v1/admin/agents/${joined.agent.id}`, { status: 'disabled' });

  const home = mkdtempSync(join(tmpdir(), 'ahub-home-'));
  const dir = join(home, 'work');
  const configPath = join(dir, '.ahub', 'config.json');
  mkdirSync(join(dir, '.ahub'), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ hub: url, token: joined.code, agent: joined.agent.id, name: '旧身份', project: project.id, last_seq: 3 }));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const k of ['AHUB_URL', 'AHUB_TOKEN', 'AHUB_CODE', 'AHUB_IDENTITY', 'AHUB_SESSION']) delete env[k];
  const run = (args, timeout = 0) =>
    new Promise((resolve) => {
      execFile(process.execPath, [CLI, ...args], { cwd: dir, env, encoding: 'utf8', timeout, killSignal: 'SIGKILL' }, (err, stdout, stderr) =>
        resolve({ code: err?.code ?? 0, stdout, stderr }),
      );
    });
  const ids = join(home, '.ahub', 'identities');
  /** 本机保存的身份（用户目录） */
  const identities = () => (existsSync(ids) ? readdirSync(ids).map((k) => JSON.parse(readFileSync(join(ids, k, 'config.json'), 'utf8'))) : []);
  /** 默认身份的配置 */
  const config = () => JSON.parse(readFileSync(join(ids, readFileSync(join(home, '.ahub', 'current'), 'utf8').trim(), 'config.json'), 'utf8'));
  return { url, call, invite, joined, run, config, identities, home, dir, configPath };
}

test('旧的目录配置自动导入用户目录；续用已停用的身份：报错并给出提示，从本机删掉', async (t) => {
  const { run, identities, configPath } = await setup(t);
  const r = await run(['run', '--harness', 'codex', '--dry-run']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /已把旧的目录配置里的身份 旧身份（A-1）.*导入到/);
  assert.match(r.stderr, /身份 旧身份 不能再使用：身份 旧身份（A-1）已被负责人停用/);
  assert.match(r.stderr, /ahub run --harness codex --code <身份码>/);
  assert.ok(!existsSync(configPath) && existsSync(configPath + '.migrated'));
  assert.deepEqual(identities(), []);
});

test('ahub join / run 带旧邀请码：清掉失效身份后以新身份加入，不报错', async (t) => {
  const { invite, run, config, call, joined, identities } = await setup(t);
  const r = await run(['join', '--invite', await invite(), '--name', '新身份']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /已从本机删除/);
  assert.equal(config().name, '新身份');
  assert.equal(config().agent, 'A-2');

  // 新身份也被停用、删除后，ahub run --invite 同样换成新身份继续
  await call('PATCH', '/api/v1/admin/agents/A-2', { status: 'disabled' });
  await call('DELETE', '/api/v1/admin/agents/A-2');
  const code = await invite();
  const out = await run(['run', '--harness', 'codex', '--invite', code, '--name', '第三个', '--dry-run'], 2500);
  assert.match(out.stdout, /已被负责人删除/);
  assert.match(out.stdout, /已连接 Hub，身份 第三个（A-3）/);
  assert.equal(config().agent, 'A-3');
  assert.notEqual(config().code, joined.code);
  assert.deepEqual(identities().map((i) => i.agent), ['A-3']);
  assert.equal(config().token, undefined);
  assert.match(config().session, /^as_/);
});

test('ahub 用身份码连接：同一身份只能一处在线，--takeover 顶掉；身份码可以反复使用', async (t) => {
  const { url, call, run, config } = await setup(t);
  const created = await call('POST', '/api/v1/admin/agents', { project: 'P-1', name: '审核' });
  const r = await run(['join', '--hub', url, '--code', created.code.toLowerCase().replaceAll('-', '')]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /已连接 Hub，身份 审核（A-2）/);
  assert.equal(config().agent, 'A-2');
  const first = config().session;
  // 后续命令直接用保存的授权 ID
  assert.equal((await run(['whoami'])).code, 0);
  assert.equal(config().session, first);
  // 已在线时再用身份码连接被拒绝，--takeover 顶掉
  const again = await run(['join', '--code', created.code]);
  assert.notEqual(again.code, 0);
  assert.match(again.stderr, /已经在线[\s\S]*--takeover/);
  const take = await run(['join', '--code', created.code, '--takeover']);
  assert.equal(take.code, 0, take.stderr);
  assert.notEqual(config().session, first);
  // 强制下线后命令行不会自动重连
  await call('POST', '/api/v1/admin/agents/A-2/kick', { note: '先停一下' });
  const kicked = await run(['whoami']);
  assert.notEqual(kicked.code, 0);
  assert.match(kicked.stderr, /负责人已强制你下线：先停一下/);
  assert.equal(config().session, undefined);
  // 身份码仍然有效：再次运行就重新上线
  assert.equal((await run(['whoami'])).code, 0);
  assert.match(config().session, /^as_/);
});

test('多个身份：在任何目录都能用，按 --identity / 默认身份选择，值守要求明确指定', async (t) => {
  const { url, call, run, home, identities } = await setup(t);
  const a = await call('POST', '/api/v1/admin/agents', { project: 'P-1', name: '甲' });
  const b = await call('POST', '/api/v1/admin/agents', { project: 'P-1', name: '乙' });
  assert.equal((await run(['join', '--hub', url, '--code', a.code])).code, 0);
  assert.equal((await run(['join', '--hub', url, '--code', b.code])).code, 0);
  // 加上从旧目录配置导入的 A-1，本机共三个身份
  assert.deepEqual(identities().map((i) => i.agent).sort(), ['A-1', 'A-2', 'A-3']);
  // 默认身份是最后 join 的乙；--identity 临时切换；换个目录也一样
  assert.match((await run(['whoami'])).stdout, /乙/);
  assert.match((await run(['whoami', '--identity', '甲'])).stdout, /甲/);
  assert.match((await run(['identities'])).stdout, /\* 乙（A-3）/);
  assert.equal((await run(['use', 'A-2'])).code, 0);
  assert.match((await run(['whoami'])).stdout, /甲/);
  // 值守没指定身份时不猜
  const r = await run(['run', '--harness', 'codex', '--dry-run']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /本机有多个身份/);
  // 旧版装在工作目录里的 skill 会被清掉，改装到用户目录
  mkdirSync(join(home, 'work', '.claude', 'skills', 'ahub-collab'), { recursive: true });
  writeFileSync(join(home, 'work', '.claude', 'skills', 'ahub-collab', 'SKILL.md'), '---\nname: ahub-collab\n---\n<!-- ahub-skill: 000000000000 · x -->\n');
  assert.match((await run(['skill', 'install'])).stdout, /已删除旧版装在工作目录里的/);
  assert.ok(existsSync(join(home, '.claude', 'skills', 'ahub-collab', 'SKILL.md')));
  assert.ok(!existsSync(join(home, 'work', '.claude', 'skills', 'ahub-collab')));
  assert.equal((await run(['forget', '乙'])).code, 0);
  assert.deepEqual(identities().map((i) => i.agent).sort(), ['A-1', 'A-2']);
});

test('ahub download 下载任务附件，subtask --file 带附件拆子任务', async (t) => {
  const { url, call, run, dir } = await setup(t);
  const created = await call('POST', '/api/v1/admin/agents', { project: 'P-1', name: '前端' });
  assert.equal((await run(['join', '--hub', url, '--code', created.code])).code, 0);
  const up = await (
    await fetch(url + '/api/v1/files?name=' + encodeURIComponent('需求.md'), {
      method: 'POST',
      headers: { authorization: 'Bearer owner_test', 'content-type': 'application/octet-stream' },
      body: '# 需求',
    })
  ).json();
  const task = await call('POST', '/api/v1/admin/tasks', { project: 'P-1', title: '做页面', assignee: 'A-2', files: [up.id] });
  const none = await call('POST', '/api/v1/admin/tasks', { project: 'P-1', title: '没附件' });
  assert.match((await run(['download', none.id])).stdout, /没有附件/);
  const r = await run(['download', task.id, '--to', 'att']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(join(dir, 'att', '需求.md'), 'utf8'), '# 需求');
  assert.match((await run(['download', task.id, '--to', 'att'])).stdout, /跳过/);

  await run(['accept', task.id]);
  writeFileSync(join(dir, 'log.txt'), 'boom');
  const sub = await run(['subtask', task.id, '查日志', '--file', 'log.txt']);
  assert.equal(sub.code, 0, sub.stderr);
  const detail = await call('GET', `/api/v1/admin/tasks/${task.id}`);
  const child = await call('GET', `/api/v1/admin/tasks/${detail.subtasks[0].id}`);
  assert.deepEqual(child.attachments.map((p) => p.name), ['log.txt']);
});
