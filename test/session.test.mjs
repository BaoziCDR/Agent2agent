import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_SESSION_SETTINGS as CFG,
  decideSession,
  parseClaudeOutput,
  parseCodexOutput,
  recordSession,
} from '../dist/cli/session.js';
import { buildPrompt, codexRolloutUsage, harnessCommand } from '../dist/cli/run.js';

const NOW = Date.parse('2026-10-27T12:00:00Z');
const ago = (min) => new Date(NOW - min * 60_000).toISOString();

const session = (over = {}) => ({
  id: 'sess-aaaaaaaa',
  harness: 'claude',
  tasks: ['T-1'],
  created_at: ago(120),
  last_used_at: ago(10),
  runs: 3,
  context_tokens: 20_000,
  context_window: 200_000,
  cache_ttl_minutes: 60,
  outcomes: [true, true],
  ...over,
});

const wake = (tasks, over = {}) => ({
  tasks,
  relations: tasks.map((id) => ({ id, family: [], links: [] })),
  followups: [],
  closed: [],
  ...over,
});

const decide = (sessions, w, cfg = {}) => decideSession(sessions, 'claude', w, { ...CFG, ...cfg }, NOW);

test('同一任务、缓存还热：续用', () => {
  const d = decide([session()], wake(['T-1']));
  assert.equal(d.action, 'reuse');
  assert.equal(d.session.id, 'sess-aaaaaaaa');
  // 同一任务 50 + 缓存 15 − 上下文 10% 10
  assert.equal(d.score, 55);
  assert.match(d.reason, /续用会话 sess-aaa/);
});

test('退回或评论的跟进再加分', () => {
  const d = decide([session()], wake(['T-1'], { followups: ['T-1'] }));
  assert.equal(d.score, 65);
});

test('和会话无关的新任务：新开', () => {
  const d = decide([session()], wake(['T-9']));
  assert.equal(d.action, 'new');
  assert.match(d.reason, /没有处理过相关任务的会话/);
});

test('上下文用到 60% 以上：硬性新开', () => {
  const d = decide([session({ context_tokens: 130_000 })], wake(['T-1']));
  assert.equal(d.action, 'new');
  assert.match(d.reason, /上下文已用 65%/);
  // 阈值可以调
  assert.equal(decide([session({ context_tokens: 130_000 })], wake(['T-1']), { contextMaxRatio: 0.8 }).action, 'new'); // 得分太低
  assert.equal(decide([session({ context_tokens: 130_000, last_used_at: ago(1) })], wake(['T-1'], { followups: ['T-1'] }), { contextMaxRatio: 0.8 }).action, 'new');
});

test('上下文很大且很久没用：分数不够，新开', () => {
  // 同一任务 50 − 上下文 40% 40 − 空闲 20 小时 30 = −20
  const d = decide([session({ context_tokens: 80_000, last_used_at: ago(20 * 60) })], wake(['T-1']));
  assert.equal(d.action, 'new');
  assert.equal(d.score, -20);
  assert.equal(d.gray, false);
});

test('父子任务、缓存热：续用；引用任务、缓存已凉：新开', () => {
  const child = wake(['T-2'], { relations: [{ id: 'T-2', family: ['T-1'], links: [] }] });
  const d1 = decide([session({ context_tokens: 10_000 })], child);
  assert.equal(d1.action, 'reuse');
  assert.equal(d1.score, 30 + 15 - 5);
  const ref = wake(['T-3'], { relations: [{ id: 'T-3', family: [], links: ['T-1'] }] });
  const d2 = decide([session({ last_used_at: ago(3 * 60) })], ref);
  assert.equal(d2.action, 'new');
  assert.equal(d2.score, 20 - 10 - 6);
});

test('灰区：分数在阈值上下 10 分以内会标出来', () => {
  const child = wake(['T-2'], { relations: [{ id: 'T-2', family: ['T-1'], links: [] }] });
  const d = decide([session({ context_tokens: 10_000, last_used_at: ago(90) })], child); // 30 − 5 − 2 = 23
  assert.equal(d.action, 'new');
  assert.equal(d.score, 23);
  assert.equal(d.gray, true);
});

test('不涉及任务的唤起（私信、广播）：新开', () => {
  assert.equal(decide([session()], wake([])).action, 'new');
});

test('一次涉及多个任务：只有覆盖全部任务的会话才续用', () => {
  const both = session({ id: 'both-0000', tasks: ['T-1', 'T-2'] });
  const one = session({ id: 'one-00000', tasks: ['T-1'], last_used_at: ago(1) });
  assert.equal(decide([one, both], wake(['T-1', 'T-2'])).session.id, 'both-0000');
  assert.equal(decide([one], wake(['T-1', 'T-2'])).action, 'new');
});

test('会话里的任务都结束了、这次是相关的新任务：新开', () => {
  const child = wake(['T-2'], { relations: [{ id: 'T-2', family: ['T-1'], links: [] }], closed: ['T-1'] });
  const d = decide([session()], child);
  assert.equal(d.action, 'new');
  assert.match(d.reason, /任务都已结束/);
  // 同一任务被退回重做不受影响
  assert.equal(decide([session()], wake(['T-1'], { closed: ['T-1'] })).action, 'reuse');
});

test('最近两次都异常、续用失败过、太老、跑太多次：硬性新开', () => {
  assert.match(decide([session({ outcomes: [true, false, false] })], wake(['T-1'])).reason, /两次运行都没有正常结束/);
  assert.match(decide([session({ broken: true })], wake(['T-1'])).reason, /续用失败/);
  assert.match(decide([session({ created_at: ago(73 * 60) })], wake(['T-1'])).reason, /超过 72 小时/);
  assert.match(decide([session({ runs: 30 })], wake(['T-1'])).reason, /达到上限 30/);
  // 只有上次异常：扣 20 分但还能续用
  const d = decide([session({ outcomes: [true, false] })], wake(['T-1']));
  assert.equal(d.action, 'reuse');
  assert.equal(d.score, 35);
});

test('读不到 Hub 时只按同一任务匹配', () => {
  const child = wake(['T-2'], { relations: [{ id: 'T-2', family: ['T-1'], links: [] }], offline: true });
  assert.equal(decide([session()], child).action, 'new');
});

test('只看同一种 harness 的会话', () => {
  assert.equal(decideSession([session({ harness: 'codex' })], 'claude', wake(['T-1']), CFG, NOW).action, 'new');
});

test('策略：new 每次新开，shared 共用最近的会话，task 只续用同一任务', () => {
  assert.equal(decide([session()], wake(['T-1']), { policy: 'new' }).action, 'new');
  const shared = decide([session({ tasks: ['T-5'] })], wake([]), { policy: 'shared' });
  assert.equal(shared.action, 'reuse');
  assert.equal(decide([session({ context_tokens: 150_000 })], wake([]), { policy: 'shared' }).action, 'new');
  const child = wake(['T-2'], { relations: [{ id: 'T-2', family: ['T-1'], links: [] }] });
  assert.equal(decide([session()], child, { policy: 'task' }).action, 'new');
  assert.equal(decide([session({ last_used_at: ago(30 * 60), context_tokens: 100_000 })], wake(['T-1']), { policy: 'task' }).action, 'reuse');
});

test('记录会话：合并任务、续用后换号、拿不到用量时估算、最多 50 条', () => {
  const defaults = { contextWindow: 200_000, cacheTtlMinutes: 60 };
  let list = recordSession([], { id: 's1', harness: 'claude', tasks: ['T-1'], ok: true, contextTokens: 30_000, now: NOW }, defaults);
  assert.equal(list[0].runs, 1);
  list = recordSession(list, { id: 's1b', previousId: 's1', harness: 'claude', tasks: ['T-2'], ok: false, now: NOW }, defaults);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 's1b');
  assert.deepEqual(list[0].tasks, ['T-1', 'T-2']);
  assert.equal(list[0].context_tokens, 45_000);
  assert.deepEqual(list[0].outcomes, [true, false]);
  for (let i = 0; i < 60; i++) list = recordSession(list, { id: `x${i}`, harness: 'codex', tasks: [], ok: true }, defaults);
  assert.equal(list.length, 50);
  assert.equal(list[0].id, 'x59');
});

test('解析 Claude 的 stream-json：会话号、当前上下文、窗口、缓存类型和费用', () => {
  const lines = [
    { type: 'system', subtype: 'init', session_id: 'c-1' },
    { type: 'assistant', session_id: 'c-1', message: { usage: { input_tokens: 10, cache_read_input_tokens: 5000, cache_creation_input_tokens: 1000, output_tokens: 200, cache_creation: { ephemeral_1h_input_tokens: 1000 } } } },
    { type: 'assistant', session_id: 'c-1', parent_tool_use_id: 'tool', message: { usage: { input_tokens: 99999 } } },
    { type: 'assistant', session_id: 'c-1', message: { usage: { input_tokens: 20, cache_read_input_tokens: 6000, cache_creation_input_tokens: 500, output_tokens: 300 } } },
    {
      type: 'result',
      session_id: 'c-1',
      result: '做完了',
      total_cost_usd: 0.0123,
      usage: { input_tokens: 30, cache_read_input_tokens: 11000, cache_creation_input_tokens: 1500 },
      modelUsage: { 'some-model': { contextWindow: 1_000_000 } },
    },
  ];
  const p = parseClaudeOutput(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  assert.equal(p.sessionId, 'c-1');
  assert.equal(p.result, '做完了');
  assert.equal(p.contextTokens, 6820);
  assert.equal(p.contextWindow, 1_000_000);
  assert.equal(p.cacheTtlMinutes, 60);
  assert.equal(p.cost, 0.0123);
  assert.ok(p.cacheHit > 0.87 && p.cacheHit < 0.89);
});

test('解析 Codex 的 --json 事件流和会话文件', () => {
  const out = [
    { type: 'thread.started', thread_id: '0199-abcd' },
    { type: 'item.completed', item: { type: 'agent_message', text: '已提交 T-1' } },
    { type: 'turn.completed', usage: { input_tokens: 40_000, cached_input_tokens: 30_000, output_tokens: 1000 } },
  ];
  const p = parseCodexOutput(out.map((l) => JSON.stringify(l)).join('\n'));
  assert.equal(p.sessionId, '0199-abcd');
  assert.equal(p.result, '已提交 T-1');
  assert.equal(p.contextTokens, 41_000);
  assert.equal(p.cacheHit, 0.75);

  const home = mkdtempSync(join(tmpdir(), 'codex-home-'));
  const dir = join(home, 'sessions', '2026', '10', '27');
  mkdirSync(dir, { recursive: true });
  const rollout = [
    { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 9000, output_tokens: 100 }, model_context_window: 272_000 } } },
    { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 12_000, output_tokens: 500 }, model_context_window: 272_000 } } },
  ];
  writeFileSync(join(dir, 'rollout-2026-10-27T10-00-00-0199-abcd.jsonl'), rollout.map((l) => JSON.stringify(l)).join('\n'));
  assert.deepEqual(codexRolloutUsage('0199-abcd', home), { contextTokens: 12_500, contextWindow: 272_000 });
  assert.deepEqual(codexRolloutUsage('missing', home), {});
});

test('harness 命令：Claude 用 --resume，Codex 用 exec resume', () => {
  const opts = { harness: 'codex', cwd: '.' };
  assert.deepEqual(harnessCommand(opts).args.slice(0, 2), ['exec', '--json']);
  const resumed = harnessCommand(opts, '0199-abcd').args;
  assert.deepEqual(resumed.slice(-3), ['resume', '0199-abcd', '-']);
  assert.deepEqual(harnessCommand({ harness: 'claude', cwd: '.' }, 'c-1').args.slice(4, 6), ['--resume', 'c-1']);
  assert.ok(!harnessCommand({ harness: 'claude', cwd: '.' }).args.includes('--resume'));
});

test('提示词：续用时只给新事项，新开时提醒先读工作笔记', () => {
  const reasons = [{ seq: 1, type: 'comment.created', task: 'T-1', summary: '负责人在 T-1 评论了' }];
  const cfg = { name: 'a', agent: 'A-1' };
  const short = buildPrompt(cfg, reasons, [], true);
  assert.match(short, /续用本会话/);
  assert.match(short, /ahub inbox/);
  assert.doesNotMatch(short, /工作循环处理：\n1\./);
  const full = buildPrompt(cfg, reasons, [], false);
  assert.match(full, /这是一个新会话/);
  assert.match(full, /1\. 先运行 `ahub inbox`/);
});

test('小模型判断：只在灰区、有候选会话时判断，Codex 需指定模型', async () => {
  const { shouldJudge } = await import('../dist/cli/judge.js');
  const gray = { action: 'new', session: session(), score: 23, gray: true, reason: 'r', breakdown: ['父子任务 +30'] };
  const clear = { ...gray, score: 55, gray: false, action: 'reuse' };
  const none = { action: 'new', gray: false, reason: 'r', breakdown: [] };
  const o = { mode: 'gray', harness: 'claude', timeoutSeconds: 60 };
  assert.equal(shouldJudge(gray, o), true);
  assert.equal(shouldJudge(clear, o), false);
  assert.equal(shouldJudge(clear, { ...o, mode: 'always' }), true);
  assert.equal(shouldJudge(none, { ...o, mode: 'always' }), false);
  assert.equal(shouldJudge(gray, { ...o, mode: 'off' }), false);
  assert.equal(shouldJudge(gray, { ...o, harness: 'codex' }), false);
  assert.equal(shouldJudge(gray, { ...o, harness: 'codex', model: 'gpt-mini' }), true);
});

test('小模型判断：提示词带上会话摘要和打分，能解析 Claude 和 Codex 的回答', async () => {
  const { judgePrompt, parseVerdict, applyVerdict, judgeCommand } = await import('../dist/cli/judge.js');
  const d = { action: 'new', session: session({ summary: '写完了首页初稿' }), score: 23, gray: true, reason: '最相关的会话得分 23', breakdown: ['P1-T2 的父子任务 P1-T1 +30', '空闲 1 小时 -2'] };
  const prompt = judgePrompt(d, ['负责人把 P1-T2 指派给了你'], 25, NOW);
  assert.match(prompt, /写完了首页初稿/);
  assert.match(prompt, /规则打分：23/);
  assert.match(prompt, /上下文已用 10%/);

  const claudeOut = JSON.stringify({ type: 'result', result: 'x', structured_output: { decision: 'reuse', reason: '子任务紧接着父任务' } });
  assert.deepEqual(parseVerdict(claudeOut), { decision: 'reuse', reason: '子任务紧接着父任务' });
  const codexOut = [
    JSON.stringify({ type: 'thread.started', thread_id: 't' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"decision":"new","reason":"上下文无关"}' } }),
  ].join('\n');
  assert.deepEqual(parseVerdict(codexOut), { decision: 'new', reason: '上下文无关' });
  assert.equal(parseVerdict('不知道'), null);
  assert.equal(parseVerdict(JSON.stringify({ type: 'result', structured_output: { decision: 'maybe' } })), null);

  const applied = applyVerdict(d, { decision: 'reuse', reason: '子任务紧接着父任务' });
  assert.equal(applied.action, 'reuse');
  assert.match(applied.reason, /小模型判断续用会话 sess-aaa：子任务紧接着父任务；规则得分 23/);
  const kept = applyVerdict(d, null);
  assert.equal(kept.action, 'new');
  assert.match(kept.reason, /按规则处理/);

  const c = judgeCommand({ harness: 'claude', mode: 'gray', timeoutSeconds: 60 }, '/x');
  assert.deepEqual(c.args.slice(0, 3), ['-p', '--model', 'haiku']);
  assert.ok(c.args.includes('--json-schema'));
  const x = judgeCommand({ harness: 'codex', mode: 'gray', model: 'gpt-mini', timeoutSeconds: 60 }, '/s.json');
  assert.deepEqual(x.args.slice(-3), ['--output-schema', '/s.json', '-']);
});
