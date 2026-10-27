import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { openDb } from '../dist/server/db.js';
import { Hub } from '../dist/server/hub.js';
import { Notifier, dingtalkUrl, renderMessage } from '../dist/server/notify.js';

process.removeAllListeners('warning');

test('钉钉加签：timestamp 和 sign 参数', () => {
  const url = dingtalkUrl('https://oapi.dingtalk.com/robot/send?access_token=abc', 'SECxyz', 1700000000000);
  const sign = createHmac('sha256', 'SECxyz').update('1700000000000\nSECxyz').digest('base64');
  assert.equal(url, `https://oapi.dingtalk.com/robot/send?access_token=abc&timestamp=1700000000000&sign=${encodeURIComponent(sign)}`);
  assert.equal(dingtalkUrl('https://x/y?access_token=abc', ''), 'https://x/y?access_token=abc');
});

test('钉钉通知：按类别和项目过滤、合并发送、记录失败', async () => {
  const db = openDb(':memory:');
  const hub = new Hub(db);
  const sent = [];
  let fail = false;
  const fakeFetch = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(fail ? { errcode: 310000, errmsg: 'sign not match' } : { errcode: 0, errmsg: 'ok' }), { status: 200 });
  };
  const n = new Notifier(hub, db, { delayMs: 10, fetch: fakeFetch });
  n.start();
  assert.throws(() => n.create({ webhook: 'not a url' }), /Webhook/);
  const p1 = hub.createProject({ name: '一' });
  const p2 = hub.createProject({ name: '二' });
  const ch = n.create({ webhook: 'https://oapi.dingtalk.com/robot/send?access_token=abcdefghijk', secret: 'SEC1', projects: [p1.id], console_url: 'http://10.0.0.2:7788/' });
  assert.equal(ch.webhook_masked, 'https://oapi.dingtalk.com/robot/send?access_token=abcdef…');
  assert.equal(ch.has_secret, true);
  assert.deepEqual(ch.topics, ['review', 'blocked', 'message', 'overdue', 'lost', 'stalled', 'offline']);

  const inv = hub.createInvite({ project: p1.id });
  const a = hub.join({ invite: inv.code, name: '甲' }, null);
  const row = hub.authAgent(a.token);
  const t = hub.createTask({ kind: 'owner' }, { project: p1.id, title: '写接口' });
  hub.claim(row, t.id);
  hub.block(row, t.id, '缺少设计稿');
  hub.unblock({ kind: 'owner' }, t.id);
  hub.submit(row, t.id, { summary: '好了' });
  hub.createTask({ kind: 'owner' }, { project: p2.id, title: '别的项目' }); // 不推送
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /timestamp=\d+&sign=/);
  const md = sent[0].body.markdown;
  assert.equal(sent[0].body.msgtype, 'markdown');
  assert.equal(md.title, '协作中枢：2 条新动态');
  assert.match(md.text, /阻塞/);
  assert.match(md.text, /\[查看\]\(http:\/\/10\.0\.0\.2:7788\/#\/board\/P1-T1\)/);

  fail = true;
  await assert.rejects(n.test(ch.id), /sign not match/);
  assert.match(n.list()[0].last_error, /310000/);
  fail = false;
  await n.test(ch.id);
  assert.equal(n.list()[0].last_error, '');

  n.update(ch.id, { enabled: false });
  hub.reject(t.id, '再改改');
  hub.submit(row, t.id, { summary: '改好了' });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(sent.length, 3); // 只有两次测试消息，停用后不推送
  n.stop();
});

test('消息渲染：超过 10 条只显示最后 10 条', () => {
  const events = Array.from({ length: 12 }, (_, i) => ({
    seq: i, type: 'task.status_changed', at: '', actor: 'A-1', project: 'P-1', task: `P1-T${i}`, audience: null, data: { to: 'review' }, summary: `第 ${i} 条`,
  }));
  const { title, text } = renderMessage(events, '');
  assert.equal(title, '协作中枢：12 条新动态');
  assert.match(text, /前面还有 2 条/);
  assert.doesNotMatch(text, /第 1 条/);
  assert.match(text, /第 11 条/);
});
