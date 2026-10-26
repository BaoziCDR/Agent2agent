import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../dist/server/db.js';
import { Hub } from '../dist/server/hub.js';

process.removeAllListeners('warning');

function setup() {
  let now = new Date('2026-10-26T08:00:00Z');
  const hub = new Hub(openDb(':memory:'), { now: () => now });
  const advance = (minutes) => (now = new Date(now.getTime() + minutes * 60_000));
  const p1 = hub.createProject({ name: '项目一', description: '说明' });
  const inv = hub.createInvite({ project: p1.id, max_uses: 10, tags: ['后端'] });
  const join = (name, extra = {}) => {
    const r = hub.join({ invite: inv.code, name, ...extra }, null);
    return { ...r, row: hub.authAgent(r.token) };
  };
  return { hub, p1, inv, join, advance };
}

test('加入：新身份拿到令牌，邀请码校验', () => {
  const { hub, p1, join } = setup();
  const a = join('甲');
  assert.match(a.token, /^ahub_/);
  assert.equal(a.agent.id, 'A-1');
  assert.deepEqual(a.agent.projects, [{ id: p1.id, name: '项目一', tags: ['后端'] }]);
  assert.throws(() => hub.join({ invite: 'XXX-XXX', name: '乙' }, null), /邀请码无效/);
  const one = hub.createInvite({ project: p1.id, max_uses: 1 });
  hub.join({ invite: one.code, name: '乙' }, null);
  assert.throws(() => hub.join({ invite: one.code, name: '丙' }, null), /已用完/);
});

test('多项目：同一身份用新邀请码加入第二个项目，事件按项目隔离', () => {
  const { hub, join } = setup();
  const a = join('甲');
  const b = join('乙');
  const p2 = hub.createProject({ name: '项目二' });
  const inv2 = hub.createInvite({ project: p2.id });
  const r = hub.join({ invite: inv2.code }, a.row);
  assert.equal(r.token, null);
  assert.equal(r.agent.projects.length, 2);
  assert.throws(() => hub.join({ invite: hub.createInvite({ project: p2.id }).code }, a.row), /已经是项目/);

  hub.createTask({ kind: 'owner' }, { project: p2.id, title: '只在项目二' });
  const seenByA = hub.inbox(hub.authAgent(a.token)).events.map((e) => e.summary);
  const seenByB = hub.inbox(hub.authAgent(b.token)).events.map((e) => e.summary);
  assert.ok(seenByA.some((s) => s.includes('只在项目二')));
  assert.ok(!seenByB.some((s) => s.includes('只在项目二')));
  assert.throws(() => hub.listTasks({ kind: 'agent', agent: b.row }, { project: p2.id }), /不是项目/);
});

test('领取：只有一个 agent 能领到，能力标签和前置任务会被检查', () => {
  const { hub, p1, join } = setup();
  const a = join('甲');
  const b = join('乙');
  const t = hub.createTask({ kind: 'owner' }, { project: p1.id, title: '任务' });
  hub.claim(a.row, t.id);
  assert.throws(() => hub.claim(b.row, t.id), /不能领取/);

  const fe = hub.createTask({ kind: 'owner' }, { project: p1.id, title: '前端活', required_tags: ['前端'] });
  assert.throws(() => hub.claim(b.row, fe.id), /需要能力标签/);

  const first = hub.createTask({ kind: 'owner' }, { project: p1.id, title: '先做' });
  const second = hub.createTask({ kind: 'owner' }, { project: p1.id, title: '后做', depends_on: [first.id] });
  assert.ok(!hub.inbox(b.row).claimable.some((x) => x.id === second.id));
  assert.throws(() => hub.claim(b.row, second.id), /前置任务/);
  hub.claim(b.row, first.id);
  hub.submit(b.row, first.id, { summary: '好了' });
  hub.approve(first.id);
  assert.equal(hub.claim(b.row, second.id).status, 'working');
});

test('指派、接受、进度、提交、退回、验收', () => {
  const { hub, p1, join } = setup();
  const a = join('甲');
  const t = hub.createTask({ kind: 'owner' }, { project: p1.id, title: '写接口', assignee: a.agent.id });
  assert.equal(t.status, 'assigned');
  assert.equal(hub.inbox(a.row).pending_assignments[0].id, t.id);

  hub.accept(a.row, t.id);
  const p = hub.progress(a.row, t.id, { percent: 40, note: '一半', notes: '下一步写测试' });
  assert.equal(p.progress, 40);
  assert.equal(p.notes, '下一步写测试');
  assert.ok(p.lease_until);

  hub.submit(a.row, t.id, { summary: '完成', artifacts: [{ name: '说明', parts: [{ kind: 'text', text: 'x' }] }] });
  assert.throws(() => hub.approve('P1-T99'), /找不到/);
  const back = hub.reject(t.id, '缺测试');
  assert.equal(back.status, 'working');
  const inbox = hub.inbox(a.row);
  assert.ok(inbox.needs_action.some((e) => e.summary.includes('退回')));

  hub.submit(a.row, t.id, { summary: '补了测试' });
  assert.equal(hub.approve(t.id).status, 'completed');
  assert.equal(hub.getTask(t.id).artifacts.length, 3);
});

test('拒绝指派会回到任务池；只有负责人能改派', () => {
  const { hub, p1, join } = setup();
  const a = join('甲');
  const b = join('乙');
  const t = hub.createTask({ kind: 'owner' }, { project: p1.id, title: 'x', assignee: a.agent.id });
  assert.throws(() => hub.decline(a.row, t.id, ''), /理由/);
  assert.equal(hub.decline(a.row, t.id, '没空').status, 'open');
  hub.assign(t.id, b.agent.id);
  assert.throws(() => hub.accept(a.row, t.id), /不在你名下/);
  hub.accept(b.row, t.id);
  hub.assign(t.id, a.agent.id);
  assert.ok(hub.inbox(b.row).events.some((e) => e.summary.includes('改派走了')));
});

test('子任务：只能为自己负责的任务创建，直接发布并指派', () => {
  const { hub, p1, join } = setup();
  const a = join('甲');
  const b = join('乙');
  const parent = hub.createTask({ kind: 'owner' }, { project: p1.id, title: '父任务' });
  assert.throws(() => hub.createTask({ kind: 'agent', agent: a.row }, { parent: parent.id, title: '子' }), /自己负责/);
  assert.throws(() => hub.createTask({ kind: 'agent', agent: a.row }, { project: p1.id, title: '顶层' }), /只能创建子任务/);
  hub.claim(a.row, parent.id);
  const sub = hub.createTask({ kind: 'agent', agent: a.row }, { parent: parent.id, title: '子', assignee: b.agent.id });
  assert.equal(sub.status, 'assigned');
  assert.equal(sub.parent, parent.id);
  assert.equal(sub.created_by, a.agent.id);
  assert.equal(hub.inbox(b.row).pending_assignments[0].id, sub.id);
  const open = hub.createTask({ kind: 'agent', agent: a.row }, { parent: parent.id, title: '子2' });
  assert.equal(open.status, 'open');
});

test('@提及只发给被提及的成员；@负责人只给负责人', () => {
  const { hub, p1, join } = setup();
  const a = join('甲');
  const b = join('乙');
  const c = join('丙');
  const t = hub.createTask({ kind: 'owner' }, { project: p1.id, title: 'x' });
  hub.comment({ kind: 'agent', agent: a.row }, t.id, `@${b.agent.id} 看一下，@负责人 确认`);
  const bNeeds = hub.inbox(b.row).needs_action.filter((e) => e.type === 'mention');
  const cNeeds = hub.inbox(c.row).needs_action.filter((e) => e.type === 'mention');
  assert.equal(bNeeds.length, 1);
  assert.equal(cNeeds.length, 0);
  const ownerMentions = hub.overview().mentions;
  assert.equal(ownerMentions.length, 1);
});

test('@完整名字 也能提及，长名字优先匹配，非成员不算', () => {
  const { hub, p1, join } = setup();
  const a = join('Codex');
  const b = join('Codex-后端');
  const c = join('丙');
  const p2 = hub.createProject({ name: '项目二' });
  const outsider = hub.join({ invite: hub.createInvite({ project: p2.id }).code, name: '外人' }, null);
  const t = hub.createTask({ kind: 'owner' }, { project: p1.id, title: 'x' });
  hub.comment({ kind: 'owner' }, t.id, '@Codex-后端 看一下，@外人 也看看');
  const mentions = (row) => hub.inbox(row).needs_action.filter((e) => e.type === 'mention').length;
  assert.equal(mentions(b.row), 1);
  assert.equal(mentions(a.row), 0);
  assert.equal(mentions(c.row), 0);
  assert.equal(mentions(hub.authAgent(outsider.token)), 0);
  hub.comment({ kind: 'agent', agent: c.row }, t.id, '@Codex 和 @A-2 一起');
  assert.equal(mentions(a.row), 1);
  assert.equal(mentions(b.row), 2);
});

test('收件箱：未确认前重复读到同样的事件，确认后不再出现', () => {
  const { hub, p1, join } = setup();
  const a = join('甲');
  hub.createTask({ kind: 'owner' }, { project: p1.id, title: '一' });
  const first = hub.inbox(a.row);
  assert.equal(first.events.length, 1);
  assert.equal(hub.inbox(a.row).events.length, 1);
  hub.ack(a.row, first.last_seq);
  assert.equal(hub.inbox(a.row).events.length, 0);
  hub.createTask({ kind: 'owner' }, { project: p1.id, title: '二' });
  assert.equal(hub.inbox(a.row).events.length, 1);
});

test('租约到期只提醒一次，不自动收回', () => {
  const { hub, p1, join, advance } = setup();
  const a = join('甲');
  const t = hub.createTask({ kind: 'owner' }, { project: p1.id, title: 'x' });
  hub.claim(a.row, t.id);
  advance(10);
  assert.equal(hub.sweepLeases(), 0);
  advance(30);
  assert.equal(hub.sweepLeases(), 1);
  assert.equal(hub.sweepLeases(), 0);
  assert.equal(hub.getTask(t.id).assignee, a.agent.id);
  assert.equal(hub.overview().counts.lost, 1);
  hub.progress(a.row, t.id, { note: '还在' });
  assert.equal(hub.overview().counts.lost, 0);
});

test('乐观锁：版本号不一致时拒绝修改', () => {
  const { hub, p1 } = setup();
  const t = hub.createTask({ kind: 'owner' }, { project: p1.id, title: 'x' });
  hub.updateTask(t.id, { title: 'y', version: t.version });
  assert.throws(() => hub.updateTask(t.id, { title: 'z', version: t.version }), /其他人修改/);
});

test('在线状态：活跃 → 空闲 → 离线只通知一次，回来时再通知', () => {
  const { hub, p1, join, advance } = setup();
  const a = join('甲');
  const t = hub.createTask({ kind: 'owner' }, { project: p1.id, title: 'x' });
  hub.claim(a.row, t.id);
  const presence = () => hub.listAgents().find((x) => x.id === a.agent.id).presence;
  assert.equal(presence(), 'active');
  advance(30);
  assert.equal(presence(), 'idle');
  assert.equal(hub.sweepPresence(), 0);
  advance(100);
  assert.equal(presence(), 'offline');
  assert.equal(hub.sweepPresence(), 1);
  assert.equal(hub.sweepPresence(), 0);
  const offline = hub.eventsForOwner({ limit: 5 }).filter((e) => e.type === 'agent.offline');
  assert.equal(offline.length, 1);
  assert.match(offline[0].summary, /甲（A-1）很久没有出现，已离线；手上还有 P1-T1/);
  assert.ok(!hub.inbox(a.row).events.some((e) => e.type === 'agent.offline'), 'agent 自己看不到');

  hub.touchAgent(hub.authAgent(a.token));
  assert.equal(presence(), 'active');
  assert.ok(hub.eventsForOwner({ limit: 5 }).some((e) => e.type === 'agent.online'));
});

test('在线状态：守护进程断线超过宽限期就算离线', () => {
  const { hub, join, advance } = setup();
  const a = join('甲');
  const presence = () => hub.listAgents().find((x) => x.id === a.agent.id).presence;
  hub.markLive(a.row.id, 1, 'stream');
  advance(60);
  assert.equal(presence(), 'online');
  hub.markLive(a.row.id, -1, 'stream');
  advance(1);
  assert.equal(presence(), 'active');
  hub.markLive(a.row.id, 1, 'stream'); // 重连
  hub.markLive(a.row.id, -1, 'stream');
  advance(3);
  assert.equal(presence(), 'offline');
  assert.equal(hub.sweepPresence(), 1);
  assert.match(hub.eventsForOwner({ limit: 1 })[0].summary, /断开了连接/);
});

test('自助注册：不用邀请码创建身份并绑定，同一位置不能再创建', () => {
  const { hub, inv } = setup();
  const here = { key: 'k'.repeat(43), label: 'mac:/work/a' };
  const r = hub.register({ name: '自助甲', platform: 'codex' }, here);
  assert.match(r.token, /^ahub_/);
  assert.deepEqual(r.agent.projects, []);
  assert.equal(r.agent.binding.label, 'mac:/work/a');
  assert.throws(() => hub.register({ name: '自助乙' }, here), /已经绑定了身份 自助甲（A-1）/);
  assert.throws(() => hub.join({ invite: inv.code, name: '丙' }, null, here), /已经绑定了身份/);
  assert.throws(() => hub.register({ name: '无绑定' }, null), /绑定标识/);
  // 用邀请码加入项目后才有项目
  const row = hub.authAgent(r.token);
  assert.equal(hub.join({ invite: inv.code }, row, here).agent.projects.length, 1);
  assert.ok(hub.eventsForOwner({ limit: 5 }).some((e) => e.type === 'agent.registered'));
});

test('绑定：不能换绑；旧身份第一次带标识时绑定；负责人解绑后可以换位置', () => {
  const { hub, join } = setup();
  const a = join('甲'); // 旧方式加入，没有绑定
  const here = { key: 'h'.repeat(43), label: 'mac:/work/a' };
  const there = { key: 't'.repeat(43), label: 'pc:/work/b' };
  hub.checkBinding(hub.authAgent(a.token), null); // 未绑定、没带标识：放行
  hub.checkBinding(hub.authAgent(a.token), here); // 第一次带标识：绑定
  assert.equal(hub.listAgents()[0].binding.label, 'mac:/work/a');
  assert.ok(hub.eventsForOwner({ limit: 1 })[0].type === 'agent.bound');
  hub.checkBinding(hub.authAgent(a.token), here);
  assert.throws(() => hub.checkBinding(hub.authAgent(a.token), there), /已绑定在 mac:\/work\/a，不能在这里使用/);
  assert.throws(() => hub.checkBinding(hub.authAgent(a.token), null), /已绑定/);
  const b = join('乙');
  assert.throws(() => hub.checkBinding(hub.authAgent(b.token), here), /这个位置已经绑定了身份 甲/);

  hub.unbindAgent(a.agent.id);
  assert.equal(hub.listAgents()[0].binding, null);
  hub.checkBinding(hub.authAgent(a.token), there);
  assert.equal(hub.listAgents()[0].binding.label, 'pc:/work/b');
  assert.throws(() => hub.unbindAgent(b.agent.id), /还没有绑定/);
});
