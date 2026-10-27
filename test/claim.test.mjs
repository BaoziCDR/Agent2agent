import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CLAIM_SETTINGS as CFG, claimKey, planClaims } from '../dist/cli/claim.js';
import { buildPrompt } from '../dist/cli/run.js';

const NOW = Date.parse('2026-10-27T09:20:00Z');
const task = (id, fit) => ({ id, title: `任务 ${id}`, fit: fit && { reasons: [], warnings: [], open_since: '2026-10-27T09:20:00Z', passed: false, of: 3, ...fit } });

test('第 1 名立即唤起，后面的名次错峰', () => {
  const p = planClaims([task('T1', { score: 80, rank: 1 }), task('T2', { score: 60, rank: 2 }), task('T3', { score: 50, rank: 3 })], 0, CFG, NOW);
  assert.deepEqual(p.wake.map((w) => w.id), ['T1']);
  assert.match(p.wake[0].why, /匹配度 80，第 1\/3 名/);
  assert.deepEqual(p.later.map((l) => [l.id, (l.at - NOW) / 60_000]), [['T2', 10], ['T3', 20]]);
  // 10 分钟后第 2 名到点
  assert.deepEqual(planClaims([task('T2', { score: 60, rank: 2 })], 0, CFG, NOW + 10 * 60_000).wake.map((w) => w.id), ['T2']);
  assert.equal(p.capacity, 2);
});

test('手上忙、匹配度低、让出过的都不唤起', () => {
  const t = task('T1', { score: 80, rank: 1 });
  const busy = planClaims([t], 2, CFG, NOW);
  assert.equal(busy.wake.length, 0);
  assert.match(busy.skipped[0].why, /手上已有 2 个进行中的任务/);
  assert.equal(planClaims([t], 1, CFG, NOW).capacity, 1);
  const low = planClaims([task('T1', { score: 20, rank: 1, warnings: ['没有能力标签 前端'] })], 0, CFG, NOW);
  assert.match(low.skipped[0].why, /匹配度 20 低于 30（没有能力标签 前端）/);
  assert.match(planClaims([task('T1', { score: 90, rank: 0, passed: true })], 0, CFG, NOW).skipped[0].why, /让出过/);
});

test('策略：always 一有就唤起，off 从不唤起；老版 Hub 没有名次时只看忙闲', () => {
  const ts = [task('T1', { score: 10, rank: 3 })];
  assert.equal(planClaims(ts, 5, { ...CFG, policy: 'always' }, NOW).wake.length, 1);
  assert.equal(planClaims(ts, 0, { ...CFG, policy: 'off' }, NOW).wake.length, 0);
  assert.equal(planClaims([task('T9')], 0, CFG, NOW).wake.length, 1);
  assert.equal(planClaims([task('T9')], 2, CFG, NOW).wake.length, 0);
});

test('同一个任务重新变成可领取后才会再次唤起', () => {
  const a = task('T1', { score: 80, rank: 1 });
  const b = { ...a, fit: { ...a.fit, open_since: '2026-10-27T10:00:00Z' } };
  assert.notEqual(claimKey(a), claimKey(b));
});

test('提示词：任务池里的任务要求先判断，适合就领、不适合就让出', () => {
  const p = buildPrompt({ name: 'a', agent: 'A-1' }, [], [{ id: 'T1', title: '写文档', kind: '任务池里有适合你的任务，匹配度 80，第 1/2 名' }], false, 1);
  assert.match(p, /匹配度 80，第 1\/2 名：T1「写文档」/);
  assert.match(p, /ahub pass <任务> "理由"/);
  assert.match(p, /这次最多领 1 个/);
  const mine = buildPrompt({ name: 'a', agent: 'A-1' }, [], [{ id: 'T1', title: '写文档', kind: '你进行中', mine: true }]);
  assert.doesNotMatch(mine, /ahub pass/);
});

test('匹配度刚过门槛的任务标为灰区，唤起前可以先问小模型', async () => {
  const p = planClaims([task('T1', { score: 80, rank: 1 }), task('T2', { score: 35, rank: 1 })], 0, CFG, NOW);
  assert.deepEqual(p.wake.map((w) => [w.id, w.gray]), [['T1', false], ['T2', true]]);
  const { shouldJudgeClaim, claimPrompt, parseClaimVerdict, judgeCommand } = await import('../dist/cli/judge.js');
  const opts = { mode: 'gray', harness: 'claude', timeoutSeconds: 60 };
  assert.equal(shouldJudgeClaim(true, opts), true);
  assert.equal(shouldJudgeClaim(false, opts), false);
  assert.equal(shouldJudgeClaim(false, { ...opts, mode: 'always' }), true);
  assert.equal(shouldJudgeClaim(true, { ...opts, mode: 'off' }), false);
  assert.equal(shouldJudgeClaim(true, { ...opts, harness: 'codex' }), false); // Codex 没指定模型不判断

  const prompt = claimPrompt({
    agent: { name: 'Claude-后端', platform: 'claude', tags: ['后端'], cwd: '/repo' },
    task: { id: 'P1-T2', title: '做 iOS 推送', description: '需要 Xcode', required_tags: [], acceptance: ['真机收到推送'] },
    fit: { score: 35, rank: 1, of: 2, reasons: ['在线'], warnings: ['正在处理别的事'] },
    active: 1,
  });
  assert.match(prompt, /能力标签：后端/);
  assert.match(prompt, /P1-T2：做 iOS 推送/);
  assert.match(prompt, /- 真机收到推送/);
  assert.match(prompt, /注意：正在处理别的事/);

  // Claude 的结构化输出和 Codex 的 agent_message 都能解析，答非所问返回 null
  assert.deepEqual(parseClaimVerdict(JSON.stringify({ type: 'result', structured_output: { decision: 'pass', reason: '需要 Mac。' } })), { decision: 'pass', reason: '需要 Mac' });
  assert.deepEqual(
    parseClaimVerdict(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"decision":"claim","reason":"后端改动"}' } })),
    { decision: 'claim', reason: '后端改动' },
  );
  assert.equal(parseClaimVerdict('{"decision":"reuse","reason":"x"}'), null);
  // 领取判断用自己的输出格式
  const c = judgeCommand(opts, '/x', '系统', { type: 'object', properties: { decision: { enum: ['claim', 'pass'] } } });
  assert.ok(c.args.includes('系统'));
  assert.match(c.args.at(-1), /claim/);
});
