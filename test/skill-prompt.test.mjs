import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPrompt, harnessCommand, showArgs } from '../dist/cli/run.js';
import { renderSkill, skillSystemPrompt } from '../dist/cli/skill.js';

test('系统提示里的接入说明去掉了安装连接和其他接入方式', () => {
  const text = skillSystemPrompt('http://hub:7788');
  assert.ok(text.includes('## 2. 每一轮的工作循环'));
  assert.ok(text.includes('## 6. 规则'));
  assert.ok(!text.includes('## 1. 安装与连接'));
  assert.ok(!text.includes('## 7. 其他接入方式'));
  assert.ok(!text.startsWith('---'), '不带 frontmatter');
  assert.ok(text.includes('Hub 地址：http://hub:7788'));
  assert.ok(!text.includes('{{HUB_URL}}'));
  assert.ok(text.length < renderSkill('http://hub:7788').length);
});

test('Claude 用 --append-system-prompt-file，续用时也带上', () => {
  const args = harnessCommand({ harness: 'claude', cwd: '.' }, 'c-1', undefined, { file: '/tmp/sp.md' }).args;
  const i = args.indexOf('--append-system-prompt-file');
  assert.equal(args[i + 1], '/tmp/sp.md');
  assert.ok(!harnessCommand({ harness: 'claude', cwd: '.' }).args.includes('--append-system-prompt-file'));
});

test('Codex 用 -c developer_instructions，值是合法的 TOML 字符串，放在 resume 之前', () => {
  const text = '第一行\n带 "引号" 和 \\ 反斜杠';
  const args = harnessCommand({ harness: 'codex', cwd: '.' }, '0199', undefined, { text }).args;
  const c = args.find((a) => a.startsWith('developer_instructions='));
  assert.equal(args[args.indexOf(c) - 1], '-c');
  assert.equal(JSON.parse(c.slice('developer_instructions='.length)), text);
  assert.ok(args.indexOf(c) < args.indexOf('resume'));
  assert.ok(!showArgs(args).includes('引号') || c.length <= 300);
  assert.match(showArgs(['-c', `developer_instructions=${JSON.stringify('字'.repeat(500))}`]), /developer_instructions=<\d+ 字>/);
});

test('说明在系统提示里时，唤起提示不再让 agent 去读 skill 文件', () => {
  const cfg = { name: 'A', agent: 'A-1' };
  const ev = [{ seq: 1, type: 'task.assigned', task: 'T-1', summary: '指派了 T-1' }];
  assert.ok(buildPrompt(cfg, ev, []).includes('~/.claude/skills/ahub-collab'));
  const p = buildPrompt(cfg, ev, [], false, undefined, true);
  assert.ok(p.includes('已经在系统提示里'));
  assert.ok(!p.includes('~/.claude/skills/ahub-collab'));
});
