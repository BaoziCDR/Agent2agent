import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { bundledVersion, renderSkill } from '../dist/cli/skill.js';
import { buildInstallPackage } from '../dist/server/pack.js';

const CLI = join(import.meta.dirname, '..', 'dist', 'cli', 'ahub.js');

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'ahub-home-'));
  const dir = join(home, 'work');
  mkdirSync(join(dir, '.ahub'), { recursive: true });
  writeFileSync(join(dir, '.ahub', 'config.json'), JSON.stringify({ hub: 'http://10.0.0.5:7788', code: 'AAAA-BBBB-CCCC', agent: 'A-1', name: '甲' }));
  const run = (...args) => execFileSync(process.execPath, [CLI, ...args], { cwd: run.cwd ?? dir, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { home, dir, run };
}

test('内置 skill：填好 Hub 地址，版本标记在 frontmatter 之后', () => {
  const text = renderSkill('http://10.0.0.5:7788');
  assert.match(text, /^---\nname: ahub-collab\n/);
  assert.ok(!text.includes('{{HUB_URL}}'));
  assert.ok(text.includes('http://10.0.0.5:7788/ahub.tgz'));
  assert.match(text, new RegExp(`\\n---\\n<!-- ahub-skill: ${bundledVersion()} `));
});

test('ahub skill：统一装到用户目录、更新旧版本、不覆盖别人写的', () => {
  const { home, dir, run } = sandbox();
  assert.match(run('skill', 'status'), /未安装/);
  run('skill', 'install');
  const claude = join(home, '.claude', 'skills', 'ahub-collab', 'SKILL.md');
  const codex = join(home, '.codex', 'skills', 'ahub-collab', 'SKILL.md');
  assert.ok(existsSync(claude) && existsSync(codex));
  assert.ok(!existsSync(join(dir, '.claude')));
  assert.ok(readFileSync(claude, 'utf8').includes('http://10.0.0.5:7788'));
  assert.match(run('skill', 'install'), /已是最新/);
  // 在别的目录运行，仍然是同一份
  run.cwd = join(dir, '.ahub', 'worktrees', 'P1-T3');
  mkdirSync(run.cwd, { recursive: true });
  assert.match(run('skill', 'install'), /已是最新/);
  run.cwd = undefined;

  // 旧版本：update 后换成当前版本
  writeFileSync(claude, readFileSync(claude, 'utf8').replace(bundledVersion(), '000000000000'));
  assert.match(run('skill', 'status'), /版本 000000000000，可以 ahub skill update/);
  run('skill', 'update');
  assert.ok(readFileSync(claude, 'utf8').includes(bundledVersion()));

  // 别人手写的不覆盖，除非 --force
  writeFileSync(codex, '---\nname: ahub-collab\n---\n自己写的\n');
  assert.match(run('skill', 'install', '--target', 'codex'), /跳过/);
  assert.equal(readFileSync(codex, 'utf8'), '---\nname: ahub-collab\n---\n自己写的\n');
  run('skill', 'install', '--target', 'codex', '--force');
  assert.ok(readFileSync(codex, 'utf8').includes(bundledVersion()));

  assert.match(run('skill', 'show'), /# 协作中枢（ahub）接入说明/);
});

test('安装包里带着 skill，版本与命令行一致', () => {
  const tgz = buildInstallPackage(join(import.meta.dirname, '..'));
  assert.ok(gunzipSync(tgz).includes('package/skill/SKILL.md'));
});

test('子命令 --help 只显示该命令的用法，写错参数给中文提示', () => {
  const { run } = sandbox();
  const help = run('skill', '--help');
  assert.match(help, /ahub skill install/);
  assert.ok(!help.includes('ahub serve'));
  assert.match(run('artifact', 'patch', '-h'), /ahub artifact patch/);
  assert.throws(() => run('skill', '--bogus'), (e) => /Unknown option '--bogus'/.test(e.stderr) && !/at /.test(e.stderr));
});
