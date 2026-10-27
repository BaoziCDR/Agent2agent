import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  writeFileSync(configPath, JSON.stringify({ hub: url, token: joined.token, agent: joined.agent.id, name: '旧身份', project: project.id, last_seq: 3 }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, AHUB_URL: '', AHUB_TOKEN: '' };
  delete env.AHUB_URL;
  delete env.AHUB_TOKEN;
  const run = (args, timeout = 0) =>
    new Promise((resolve) => {
      execFile(process.execPath, [CLI, ...args], { cwd: dir, env, encoding: 'utf8', timeout, killSignal: 'SIGKILL' }, (err, stdout, stderr) =>
        resolve({ code: err?.code ?? 0, stdout, stderr }),
      );
    });
  const config = () => JSON.parse(readFileSync(configPath, 'utf8'));
  return { url, call, invite, joined, run, config };
}

test('ahub run 续用已停用的身份：报错并给出提示，清掉配置里的身份，保留 Hub 地址', async (t) => {
  const { url, run, config } = await setup(t);
  const r = await run(['run', '--harness', 'codex', '--dry-run']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /身份 旧身份 不能再使用：身份 旧身份（A-1）已被负责人停用/);
  assert.match(r.stderr, /ahub run --harness codex --invite <邀请码> --name <名字>/);
  assert.deepEqual(config(), { hub: url });
});

test('ahub join / run 带新邀请码：清掉失效身份后以新身份加入，不报错', async (t) => {
  const { invite, run, config, call, joined } = await setup(t);
  const r = await run(['join', '--invite', await invite(), '--name', '新身份']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /已从配置中清除/);
  assert.equal(config().name, '新身份');
  assert.equal(config().agent, 'A-2');

  // 新身份也被停用、删除后，ahub run --invite 同样换成新身份继续
  await call('PATCH', '/api/v1/admin/agents/A-2', { status: 'disabled' });
  await call('DELETE', '/api/v1/admin/agents/A-2');
  const code = await invite();
  const out = await run(['run', '--harness', 'codex', '--invite', code, '--name', '第三个', '--dry-run'], 2500);
  assert.match(out.stdout, /已被负责人删除/);
  assert.match(out.stdout, /已加入项目 P-1，身份 第三个（A-3）/);
  assert.equal(config().agent, 'A-3');
  assert.notEqual(config().token, joined.token);
});
