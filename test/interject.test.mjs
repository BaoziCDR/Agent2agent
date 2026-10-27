import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, claudeHookSettings, codexHookArgs, deliveredSeqs, hookCommand, queueItems, runHook } from '../dist/cli/interject.js';
import { harnessCommand } from '../dist/cli/run.js';

const spool = () => join(mkdtempSync(join(tmpdir(), 'ahub-interject-')), 'run.jsonl');

test('插话钩子：工具调用后取走待投递事项，作为附加上下文交给模型', () => {
  const file = spool();
  assert.equal(runHook(file, '{"hook_event_name":"PostToolUse"}'), '', '没有事项时什么都不输出');
  queueItems(file, [{ seq: 7, summary: '负责人在 P1-T3 评论：先别改接口' }]);
  const out = JSON.parse(runHook(file, '{"hook_event_name":"PostToolUse","tool_name":"Bash"}'));
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /先别改接口/);
  assert.ok(!existsSync(file), '取走后原文件不在了，之后来的事项写进新文件');
  assert.equal(runHook(file, '{"hook_event_name":"PostToolUse"}'), '', '同一批事项只送一次');
  assert.deepEqual(deliveredSeqs(file), [7]);

  queueItems(file, [{ seq: 9, summary: '王五私信你' }]);
  const stop = JSON.parse(runHook(file, '{"hook_event_name":"Stop"}'));
  assert.equal(stop.decision, 'block', '想结束时还有新事项就先别结束');
  assert.match(stop.reason, /王五私信你/);
  assert.deepEqual(deliveredSeqs(file).sort(), [7, 9]);
  cleanup(file);
  assert.deepEqual(deliveredSeqs(file), []);
});

test('插话钩子：ahub hook 命令从标准输入读事件，输出 JSON', () => {
  const file = spool();
  queueItems(file, [{ seq: 3, summary: '负责人 @ 了你' }]);
  const out = execFileSync(process.execPath, ['dist/cli/ahub.js', 'hook', file], { input: '{"hook_event_name":"PostToolUse"}', encoding: 'utf8' });
  assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /负责人 @ 了你/);
  assert.equal(execFileSync(process.execPath, ['dist/cli/ahub.js', 'hook', file], { input: '', encoding: 'utf8' }), '');
});

test('插话钩子：Claude 用 --settings 装钩子，Codex 用内联配置并跳过钩子信任', () => {
  const command = hookCommand('/tmp/a b/run.jsonl', '/usr/bin/node', '/opt/ahub.js');
  assert.equal(command, '"/usr/bin/node" "/opt/ahub.js" "hook" "/tmp/a b/run.jsonl"');
  const settings = claudeHookSettings(command);
  assert.equal(settings.hooks.PostToolUse[0].hooks[0].command, command);
  assert.ok(settings.hooks.Stop);

  const claude = harnessCommand({ harness: 'claude', cwd: '.' }, 'c-1', { command, settingsFile: '/tmp/s.json' }).args;
  assert.deepEqual(claude.slice(4, 8), ['--resume', 'c-1', '--settings', '/tmp/s.json']);
  assert.ok(!harnessCommand({ harness: 'claude', cwd: '.' }).args.includes('--settings'));

  const codex = harnessCommand({ harness: 'codex', cwd: '.' }, '0199', { command, codexTrust: 'exec' }).args;
  assert.deepEqual(codex.slice(0, 3), ['exec', '--json', '--dangerously-bypass-hook-trust']);
  assert.ok(codex.includes(codexHookArgs(command)[1]));
  assert.deepEqual(codex.slice(-3), ['resume', '0199', '-']);
  assert.equal(harnessCommand({ harness: 'codex', cwd: '.' }, undefined, { command, codexTrust: 'root' }).args[0], '--dangerously-bypass-hook-trust');
  assert.match(codexHookArgs(command)[1], /^hooks\.PostToolUse=\[\{matcher="\.\*",hooks=\[\{type="command",command='"\/usr\/bin\/node" .*',timeout=10\}\]\}\]$/);
});
