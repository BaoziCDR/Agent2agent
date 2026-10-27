import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../dist/server/db.js';
import { Hub } from '../dist/server/hub.js';
import { Tagger, parseTags } from '../dist/server/tagger.js';

process.removeAllListeners('warning');

function setup(answer = '{"tags":["前端"],"reason":"要改页面"}') {
  const db = openDb(':memory:');
  const hub = new Hub(db);
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify({ choices: [{ message: { content: answer } }] }), { status: 200 });
  };
  const tagger = new Tagger(hub, db, { fetch: fakeFetch, timeoutMs: 1000 });
  const p = hub.createProject({ name: '项目' });
  const inv = hub.createInvite({ project: p.id, max_uses: 10 });
  const join = (name, skills) => {
    const r = hub.join({ invite: inv.code, name, skills }, null);
    hub.openSession({ code: r.code, client: 'cli' });
    return hub.agentByCode(r.code);
  };
  return { hub, db, tagger, p, calls, rowA: join('甲', ['前端']), rowB: join('乙', ['后端']) };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test('没有配置外部模型时不打标签', async () => {
  const { hub, tagger, p, calls } = setup();
  tagger.start();
  const t = hub.createTask({ kind: 'owner' }, { project: p.id, title: '首页深色模式' });
  await settle();
  assert.equal(calls.length, 0);
  assert.deepEqual(hub.getTask(t.id).required_tags, []);
  assert.equal(tagger.view().configured, false);
});

test('发布任务时从成员已有的标签里自动打标签，打标签期间先不放进可领取列表', async () => {
  const { hub, tagger, p, calls, rowA, rowB } = setup();
  assert.throws(() => tagger.update({ base_url: 'api.example.com' }), /http/);
  const v = tagger.update({ base_url: 'https://api.example.com/v1/', api_key: 'sk-test-123456', model: 'small-model' });
  assert.equal(v.key_masked, 'sk-…3456');
  assert.equal(v.base_url, 'https://api.example.com/v1');
  tagger.start();
  const t = hub.createTask({ kind: 'owner' }, { project: p.id, title: '首页深色模式' });
  // 打标签还没完成：谁都看不到这个可领取任务
  assert.equal(hub.inbox(rowB).claimable.length, 0);
  await settle();
  assert.equal(calls[0].url, 'https://api.example.com/v1/chat/completions');
  assert.equal(calls[0].auth, 'Bearer sk-test-123456');
  assert.equal(calls[0].body.model, 'small-model');
  assert.match(calls[0].body.messages[1].content, /前端（1）、后端（1）/);
  assert.deepEqual(hub.getTask(t.id).required_tags, ['前端']);
  assert.equal(hub.inbox(rowA).claimable.length, 1);
  assert.equal(hub.inbox(rowB).claimable.length, 0);
  assert.match(hub.eventsForOwner({ limit: 1 })[0].summary, /自动给 .* 打了能力标签：前端（要改页面）/);

  // 手动打了标签、草稿、已指派的任务不调用模型
  hub.createTask({ kind: 'owner' }, { project: p.id, title: '接口', required_tags: ['后端'] });
  hub.createTask({ kind: 'owner' }, { project: p.id, title: '草稿', draft: true });
  await settle();
  assert.equal(calls.length, 1);
});

test('模型选了没人有的标签就丢掉；接口出错时放行任务', async () => {
  const s1 = setup('```json\n{"tags":["iOS","前端"],"reason":"x"}\n```');
  s1.tagger.update({ base_url: 'https://x.test/v1', model: 'm' });
  s1.tagger.start();
  const t1 = s1.hub.createTask({ kind: 'owner' }, { project: s1.p.id, title: '页面' });
  await settle();
  assert.deepEqual(s1.hub.getTask(t1.id).required_tags, ['前端']);

  const s2 = setup(new Error('connect ECONNREFUSED'));
  s2.tagger.update({ base_url: 'https://x.test/v1', model: 'm' });
  s2.tagger.start();
  const t2 = s2.hub.createTask({ kind: 'owner' }, { project: s2.p.id, title: '页面' });
  await settle();
  assert.deepEqual(s2.hub.getTask(t2.id).required_tags, []);
  assert.equal(s2.hub.inbox(s2.rowB).claimable.length, 1);
  assert.match(s2.hub.eventsForOwner({ limit: 1 })[0].summary, /打标签失败/);
});

test('预设标签：默认值、修改、和在用的标签一起列出', () => {
  const { hub } = setup();
  assert.ok(hub.tagOptions().presets.includes('前端'));
  hub.setPresetTags(['前端', ' 后端 ', '前端', '算法']);
  const o = hub.tagOptions();
  assert.deepEqual(o.presets, ['前端', '后端', '算法']);
  assert.deepEqual(o.in_use, []);
  assert.throws(() => hub.setPresetTags(['这是一个特别特别特别特别特别特别长的标签名字啊']), /20/);
});

test('解析模型回答', () => {
  assert.deepEqual(parseTags('{"tags":[],"reason":"通用"}'), { tags: [], reason: '通用' });
  assert.equal(parseTags('不知道'), null);
  assert.equal(parseTags('{"tag":"前端"}'), null);
});
