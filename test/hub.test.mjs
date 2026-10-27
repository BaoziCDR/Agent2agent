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
    hub.openSession({ code: r.code, client: 'cli' });
    return { ...r, row: hub.agentByCode(r.code) };
  };
  return { hub, p1, inv, join, advance };
}

test('加入：新身份拿到令牌，邀请码校验', () => {
  const { hub, p1, join } = setup();
  const a = join('甲');
  assert.match(a.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
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
  assert.equal(r.code, null);
  assert.equal(r.agent.projects.length, 2);
  assert.throws(() => hub.join({ invite: hub.createInvite({ project: p2.id }).code }, a.row), /已经是项目/);

  hub.createTask({ kind: 'owner' }, { project: p2.id, title: '只在项目二' });
  const seenByA = hub.inbox(hub.agentByCode(a.code)).events.map((e) => e.summary);
  const seenByB = hub.inbox(hub.agentByCode(b.code)).events.map((e) => e.summary);
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

test('负责人读过的 @ 和私信不再留在「需要你处理」里', () => {
  const { hub, p1, join } = setup();
  const a = join('甲');
  const b = join('乙');
  const t1 = hub.createTask({ kind: 'owner' }, { project: p1.id, title: '一' });
  const t2 = hub.createTask({ kind: 'owner' }, { project: p1.id, title: '二' });
  const t3 = hub.createTask({ kind: 'owner' }, { project: p1.id, title: '三' });
  hub.comment({ kind: 'agent', agent: a.row }, t1.id, '@负责人 第一条');
  hub.comment({ kind: 'agent', agent: a.row }, t1.id, '@负责人 第二条');
  hub.comment({ kind: 'agent', agent: a.row }, t2.id, '@负责人 第三条');
  hub.comment({ kind: 'agent', agent: a.row }, t3.id, '@负责人 第四条');
  hub.message({ kind: 'agent', agent: a.row }, 'owner', '私信一');
  hub.message({ kind: 'agent', agent: b.row }, 'owner', '私信二');
  const pending = () => hub.overview().mentions.map((e) => e.summary.replace(/^.*[：:]/, ''));
  assert.equal(pending().length, 6);

  // 打开任务详情：该任务下的 @ 都算已读，别的任务不受影响
  assert.equal(hub.markOwnerRead({ task: t1.id }).count, 2);
  assert.deepEqual(pending(), ['私信二', '私信一', '@负责人 第四条', '@负责人 第三条']);
  assert.equal(hub.markOwnerRead({ task: t1.id }).count, 0);

  // 负责人在任务下回复，也算读过
  hub.comment({ kind: 'owner' }, t2.id, '好的');
  assert.equal(hub.overview().mentions.some((e) => e.task === t2.id), false);

  // 回复某个 agent 的私信，只清掉它发来的
  hub.message({ kind: 'owner' }, a.agent.id, '收到');
  assert.deepEqual(pending(), ['私信二', '@负责人 第四条']);

  // 点单条
  const seq = hub.overview().mentions.find((e) => e.type === 'message.direct').seq;
  assert.equal(hub.markOwnerRead({ seqs: [seq] }).count, 1);
  assert.deepEqual(pending(), ['@负责人 第四条']);

  // 新的 @ 照样出现；全部已读后清空
  hub.comment({ kind: 'agent', agent: a.row }, t1.id, '@负责人 又来一条');
  assert.equal(pending().length, 2);
  assert.equal(hub.markOwnerRead({ project: p1.id }).count, 2);
  assert.deepEqual(hub.overview().mentions, []);
  assert.throws(() => hub.markOwnerRead({ type: 'bogus' }), /未知的类型/);
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
  assert.equal(mentions(hub.agentByCode(outsider.code)), 0);
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

test('统计：按天完成数、平均用时和退回率', () => {
  const { hub, p1, join, advance } = setup();
  const a = join('甲');
  const t = hub.createTask({ kind: 'owner' }, { project: p1.id, title: 'x' });
  hub.claim(a.row, t.id);
  advance(90);
  hub.submit(a.row, t.id, { summary: '好了' });
  hub.reject(t.id, '再改改');
  advance(30);
  hub.submit(a.row, t.id, { summary: '改好了' });
  hub.approve(t.id);
  const s = hub.stats(undefined, 7);
  assert.equal(s.days.length, 7);
  assert.equal(s.days.at(-1).completed, 1);
  assert.equal(s.totals.completed, 1);
  assert.equal(s.totals.created, 1);
  assert.equal(s.totals.avg_hours, 2);
  assert.equal(s.totals.reject_rate, 50);
  assert.deepEqual(
    { completed: s.agents[0].completed, submitted: s.agents[0].submitted, rejected: s.agents[0].rejected },
    { completed: 1, submitted: 2, rejected: 1 },
  );
});

test('截止提醒：快到期和逾期各提醒一次，改截止时间后重新提醒', () => {
  const { hub, p1, join, advance } = setup();
  const a = join('甲');
  assert.throws(() => hub.createTask({ kind: 'owner' }, { project: p1.id, title: 'x', due_at: '明天' }), /截止时间格式不对/);
  const t = hub.createTask({ kind: 'owner' }, { project: p1.id, title: 'x', due_at: '2026-10-26T12:00:00+08:00' }); // 04:00Z 前已过
  const later = hub.createTask({ kind: 'owner' }, { project: p1.id, title: 'y', due_at: '2026-10-26T11:00:00Z' });
  const sub = hub.createTask({ kind: 'owner' }, { parent: later.id, title: 'y-1' });
  assert.equal(hub.getTask(sub.id).due_at, '2026-10-26T11:00:00.000Z');
  hub.claim(a.row, t.id);
  assert.equal(hub.sweepDue(), 1); // t 已逾期；later 还有 3 小时
  assert.equal(hub.sweepDue(), 0);
  const inbox = hub.inbox(a.row);
  assert.ok(inbox.needs_action.some((e) => e.type === 'task.overdue' && e.task === t.id));
  assert.equal(hub.overview().counts.overdue, 1);
  advance(65); // 09:05，later 还有不到 2 小时
  assert.equal(hub.sweepDue(), 2); // later 和 sub 快到期
  hub.updateTask(t.id, { due_at: '2026-10-27T08:00:00Z' });
  assert.equal(hub.overview().counts.overdue, 0);
  advance(24 * 60);
  assert.equal(hub.sweepDue(), 3);
  assert.equal(hub.sweepDue(), 0);
});

test('前置任务：不能形成循环依赖', () => {
  const { hub, p1 } = setup();
  const a = hub.createTask({ kind: 'owner' }, { project: p1.id, title: 'a' });
  const b = hub.createTask({ kind: 'owner' }, { project: p1.id, title: 'b', depends_on: [a.id] });
  const c = hub.createTask({ kind: 'owner' }, { project: p1.id, title: 'c', depends_on: [b.id] });
  assert.throws(() => hub.updateTask(a.id, { depends_on: [c.id] }), /循环依赖/);
  assert.throws(() => hub.updateTask(a.id, { depends_on: [a.id] }), /不能依赖自己/);
  hub.updateTask(c.id, { depends_on: [a.id, b.id] });
  assert.deepEqual(hub.getTask(c.id).depends_on, [a.id, b.id]);
});

test('值守管理：暂停/恢复/唤醒、运行记录，控制事件不进 harness 收件箱', () => {
  const { hub, join } = setup();
  const a = join('甲');
  assert.throws(() => hub.controlDaemon(a.agent.id, 'wake'), /值守进程不在线/);
  hub.markDaemon(a.row.id, 1);
  assert.equal(hub.agentView(a.row).daemon, true);
  const before = hub.inbox(a.row).last_seq;
  assert.equal(hub.controlDaemon(a.agent.id, 'pause').daemon_paused, true);
  assert.throws(() => hub.controlDaemon(a.agent.id, 'wake'), /已暂停/);
  assert.equal(hub.controlDaemon(a.agent.id, 'resume').daemon_paused, false);
  hub.controlDaemon(a.agent.id, 'wake');
  const inbox = hub.inbox(a.row, { since: before });
  assert.equal(inbox.events.length, 0);
  assert.ok(inbox.last_seq > before);
  assert.equal(hub.eventsForAgent(a.row, before, 50).events.filter((e) => e.type === 'agent.control').length, 3);
  for (let i = 0; i < 105; i++) hub.recordRun(a.row, { code: i % 2, trigger: `第 ${i} 次`, harness: 'codex' });
  const runs = hub.listRuns(a.agent.id, 200);
  assert.equal(runs.length, 100);
  assert.equal(runs[0].trigger, '第 104 次');
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

  hub.openSession({ code: a.code });
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

test('指派推荐：能力匹配、手上任务少、做过类似任务的排前面', () => {
  const { hub, p1, join } = setup();
  const a = join('甲');
  const b = join('乙', { skills: ['前端'] });
  // 甲做过登录接口
  const t0 = hub.createTask({ kind: 'owner' }, { project: p1.id, title: '实现登录接口', assignee: a.agent.id });
  hub.accept(a.row, t0.id);
  hub.submit(a.row, t0.id, { summary: '好了' });
  hub.approve(t0.id);
  const t = hub.createTask({ kind: 'owner' }, { project: p1.id, title: '实现注册接口' });
  const recs = hub.recommend({ task: t.id });
  assert.equal(recs[0].id, a.agent.id);
  assert.ok(recs[0].reasons.some((r) => r.includes(t0.id)), recs[0].reasons.join());
  // 需要前端标签时乙排第一，甲提示缺标签
  const fe = hub.recommend({ project: p1.id, tags: ['前端'], title: '首页' });
  assert.equal(fe[0].id, b.agent.id);
  assert.ok(fe[0].reasons.some((r) => r.includes('能力匹配')));
  assert.ok(fe[1].warnings.some((w) => w.includes('没有能力标签')));
  // 手上任务多会降分
  for (let i = 0; i < 3; i++) hub.createTask({ kind: 'owner' }, { project: p1.id, title: `杂事 ${i}`, assignee: b.agent.id });
  const busy = hub.recommend({ project: p1.id, title: '随便' });
  assert.equal(busy[0].id, a.agent.id);
  assert.ok(busy[1].warnings.some((w) => w.includes('手上 3 个任务')));
});

test('前置任务结束后通知下游：有负责人的唤起负责人，任务池里的通知可以领取', () => {
  const { hub, p1, join } = setup();
  const a = join('甲');
  const b = join('乙');
  const up = hub.createTask({ kind: 'owner' }, { project: p1.id, title: '设计接口', assignee: a.agent.id });
  const up2 = hub.createTask({ kind: 'owner' }, { project: p1.id, title: '准备数据' });
  const down = hub.createTask({ kind: 'owner' }, { project: p1.id, title: '实现接口', assignee: b.agent.id, depends_on: [up.id, up2.id] });
  const pool = hub.createTask({ kind: 'owner' }, { project: p1.id, title: '写文档', depends_on: [up.id] });
  hub.accept(a.row, up.id);
  hub.submit(a.row, up.id, { summary: '好了' });
  hub.approve(up.id);
  const unlocked = () => hub.eventsForOwner({ limit: 50 }).filter((e) => e.type === 'task.unlocked');
  // down 还差 up2，不通知；pool 只依赖 up，通知全员可以领取
  assert.deepEqual(unlocked().map((e) => e.task), [pool.id]);
  assert.equal(unlocked()[0].audience, null);
  assert.match(unlocked()[0].summary, /现在可以领取/);
  hub.cancel(up2.id, '不需要了');
  const ev = unlocked().find((e) => e.task === down.id);
  assert.deepEqual(ev.audience, [b.agent.id]);
  assert.match(ev.summary, /前置任务 P1-T2 已取消，P1-T3「实现接口」的前置任务已全部结束，可以开始了/);
  // 对乙来说这是需要处理的事项
  assert.ok(hub.inbox(b.row).needs_action.some((e) => e.type === 'task.unlocked' && e.task === down.id));
  assert.ok(!hub.inbox(a.row).needs_action.some((e) => e.type === 'task.unlocked'));
});

test('原地打转检测：进度长时间不变但一直在报，提醒负责人一次；进度变化后重新计算', () => {
  const { hub, p1, join, advance } = setup();
  const a = join('甲');
  const t = hub.createTask({ kind: 'owner' }, { project: p1.id, title: '重构', assignee: a.agent.id });
  hub.progress(a.row, t.id, { percent: 30, note: '开始' });
  advance(60);
  hub.progress(a.row, t.id, { percent: 30, note: '还在看' });
  assert.equal(hub.sweepStalls(), 0); // 才 1 小时、只重复 1 次
  advance(70);
  hub.progress(a.row, t.id, { percent: 30, note: '还在看' });
  assert.equal(hub.sweepStalls(), 1);
  assert.equal(hub.sweepStalls(), 0); // 只提醒一次
  const ev = hub.eventsForOwner({ limit: 5 }).find((e) => e.type === 'task.stalled');
  assert.deepEqual(ev.audience, []);
  assert.match(ev.summary, /P1-T1「重构」可能在原地打转：甲 近 2 小时又上报了 2 次进度，进度一直停在 30%/);
  assert.equal(hub.getTask(t.id).stalled, true);
  assert.equal(hub.overview().counts.stalled, 1);
  // 进度变了就清除
  hub.progress(a.row, t.id, { percent: 50, note: '有进展' });
  assert.equal(hub.getTask(t.id).stalled, false);
  assert.equal(hub.overview().counts.stalled, 0);
});

test('交付物修改：局部补丁、整份替换的版本冲突、补丁只在改动区域冲突、重新提交算新一轮', () => {
  const { hub, p1, join } = setup();
  const a = join('甲');
  const b = join('乙');
  const t = hub.createTask({ kind: 'owner' }, { project: p1.id, title: '写文档', assignee: a.agent.id });
  hub.accept(a.row, t.id);
  hub.submit(a.row, t.id, { summary: '好了', artifacts: [{ name: 'doc.md', parts: [{ kind: 'text', text: '# 标题\n\n第一段\n\n第二段\n' }] }] });
  const doc = hub.getTask(t.id).artifacts.find((x) => x.name === 'doc.md');
  assert.equal(doc.rev, 1);
  assert.equal(doc.round, 1);
  const A = { kind: 'agent', agent: a.row };
  const B = { kind: 'agent', agent: b.row };

  // 待验收时直接改，不用退回；负责人和其他成员都能改
  const v2 = hub.updateArtifact(A, t.id, doc.id, { base_rev: 1, edits: [{ old: '第一段', new: '第一段（已补充）' }], note: '补充第一段' });
  assert.equal(v2.rev, 2);
  assert.equal(v2.updated_by, 'A-1');
  assert.equal(hub.getTask(t.id).status, 'review');
  assert.ok(hub.inbox(b.row).events.some((e) => e.type === 'artifact.updated' && e.summary.includes('第 2 版')));

  // 乙基于第 1 版整份替换：被拒绝
  assert.throws(() => hub.updateArtifact(B, t.id, doc.id, { base_rev: 1, content: '全部重写' }), (e) => e.status === 409 && /第 2 版/.test(e.message));
  // 乙基于第 1 版改第二段（没人动过）：可以
  const v3 = hub.updateArtifact(B, t.id, doc.id, { base_rev: 1, edits: [{ old: '第二段', new: '第二段（乙改）' }] });
  assert.equal(v3.rev, 3);
  assert.equal(v3.parts[0].text, '# 标题\n\n第一段（已补充）\n\n第二段（乙改）\n');
  // 乙基于第 1 版改第一段（已被甲改过）：冲突
  assert.throws(() => hub.updateArtifact(B, t.id, doc.id, { base_rev: 1, edits: [{ old: '第一段\n', new: 'x' }] }), (e) => e.status === 409);
  // 版本是最新的但原文找不到：普通错误
  assert.throws(() => hub.updateArtifact(B, t.id, doc.id, { base_rev: 3, edits: [{ old: '不存在', new: 'x' }] }), (e) => e.status === 400);
  assert.throws(() => hub.updateArtifact(B, t.id, doc.id, { content: 'x' }), /base_rev/);
  // 负责人整份替换最新版
  const v4 = hub.updateArtifact({ kind: 'owner' }, t.id, doc.id, { base_rev: 3, content: '负责人定稿' });
  assert.equal(v4.rev, 4);
  const revs = hub.artifactRevisions({ kind: 'owner' }, t.id, doc.id);
  assert.deepEqual(revs.map((r) => [r.rev, r.author]), [[1, 'A-1'], [2, 'A-1'], [3, 'A-2'], [4, 'owner']]);
  assert.equal(revs[1].note, '补充第一段');
  assert.equal(hub.getArtifact(A, t.id, doc.id, 2).parts[0].text, '# 标题\n\n第一段（已补充）\n\n第二段\n');

  // 非项目成员不能改
  const p2 = hub.createProject({ name: '项目二' });
  const c = hub.join({ invite: hub.createInvite({ project: p2.id }).code, name: '丙' }, null);
  assert.throws(() => hub.updateArtifact({ kind: 'agent', agent: hub.agentByCode(c.code) }, t.id, doc.id, { base_rev: 4, content: 'x' }));

  hub.reject(t.id, '再补一节');
  hub.submit(a.row, t.id, { summary: '第二次', artifacts: [{ name: 'doc.md', parts: [{ kind: 'text', text: '新版' }] }] });
  const rounds = hub.getTask(t.id).artifacts.map((x) => [x.name, x.round]);
  assert.deepEqual(rounds, [['交付说明', 1], ['doc.md', 1], ['交付说明', 2], ['doc.md', 2]]);
});

test('交付物迁移：老数据补上版本号、提交轮次和第 1 版记录', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: pj } = await import('node:path');
  const file = pj(mkdtempSync(pj(tmpdir(), 'ahub-mig-')), 'hub.db');
  let db = openDb(file);
  const hub = new Hub(db);
  const p = hub.createProject({ name: '项目' });
  const r = hub.join({ invite: hub.createInvite({ project: p.id }).code, name: '甲' }, null);
  const a = hub.agentByCode(r.code);
  const t = hub.createTask({ kind: 'owner' }, { project: p.id, title: '任务', assignee: r.agent.id });
  hub.accept(a, t.id);
  hub.submit(a, t.id, { summary: '一', artifacts: [{ name: 'x', parts: [{ kind: 'text', text: '1' }] }] });
  hub.reject(t.id, '改');
  hub.submit(a, t.id, { summary: '二' });
  db.exec('DROP TABLE artifact_revisions');
  for (const c of ['rev', 'round', 'updated_at', 'updated_by']) db.exec(`ALTER TABLE artifacts DROP COLUMN ${c}`);
  db.close();
  db = openDb(file);
  const arts = new Hub(db).getTask(t.id).artifacts;
  assert.deepEqual(arts.map((x) => [x.name, x.rev, x.round]), [['交付说明', 1, 1], ['x', 1, 1], ['交付说明', 1, 2]]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM artifact_revisions').get().n, 3);
  db.close();
});

test('任务引用：同项目任意状态可引用，详情列出引用和被引用，指派提醒里带上参考任务', () => {
  const { hub, p1, join } = setup();
  const a = join('甲');
  const old = hub.createTask({ kind: 'owner' }, { project: p1.id, title: '旧方案', assignee: a.agent.id });
  hub.accept(a.row, old.id);
  hub.submit(a.row, old.id, { summary: '旧方案文档' });
  hub.approve(old.id);
  const canceled = hub.createTask({ kind: 'owner' }, { project: p1.id, title: '废弃的尝试' });
  hub.cancel(canceled.id, '不做了');

  const t = hub.createTask({ kind: 'owner' }, { project: p1.id, title: '新方案', assignee: a.agent.id, refs: [old.id, canceled.id, old.id] });
  assert.deepEqual(t.refs, [old.id, canceled.id]);
  const d = hub.getTask(t.id);
  assert.deepEqual(d.ref_tasks.map((r) => [r.id, r.status]), [[old.id, 'completed'], [canceled.id, 'canceled']]);
  assert.deepEqual(hub.getTask(old.id).referenced_by.map((r) => r.id), [t.id]);
  const assigned = hub.inbox(a.row).needs_action.find((e) => e.type === 'task.assigned' && e.summary.includes('新方案'));
  assert.match(assigned.summary, new RegExp(`参考任务：${old.id}、${canceled.id}`));

  // 其他项目的任务、引用自己都不行
  const p2 = hub.createProject({ name: '项目二' });
  const other = hub.createTask({ kind: 'owner' }, { project: p2.id, title: '别的项目' });
  assert.throws(() => hub.createTask({ kind: 'owner' }, { project: p1.id, title: 'x', refs: [other.id] }), /同一个项目/);
  assert.throws(() => hub.updateTask(t.id, { refs: [t.id] }), /不能引用自己/);
  assert.deepEqual(hub.updateTask(t.id, { refs: [canceled.id] }).refs, [canceled.id]);

  // agent 不用被引用也能查看同项目的历史任务（已完成、已取消）
  assert.equal(hub.getTaskFor({ kind: 'agent', agent: a.row }, canceled.id).status, 'canceled');
  const history = hub.listTasks({ kind: 'agent', agent: a.row }, { status: 'completed,canceled' }).map((x) => x.id);
  assert.deepEqual(history, [old.id, canceled.id]);
  // agent 拆子任务时也能引用
  hub.accept(a.row, t.id);
  const sub = hub.createTask({ kind: 'agent', agent: a.row }, { parent: t.id, title: '子任务', refs: [old.id] });
  assert.deepEqual(sub.refs, [old.id]);
});

test('邀请码预设名称：加入时不写 name 就用它，写了以自己写的为准；没有预设也没写则报错', () => {
  const { hub, p1 } = setup();
  const named = hub.createInvite({ project: p1.id, name: ' Claude-前端 ' });
  assert.equal(named.agent_name, 'Claude-前端');
  assert.equal(hub.join({ invite: named.code }, null).agent.name, 'Claude-前端');
  const other = hub.createInvite({ project: p1.id, name: '预设' });
  assert.equal(hub.join({ invite: other.code, name: '自己起的' }, null).agent.name, '自己起的');
  const plain = hub.createInvite({ project: p1.id });
  assert.equal(plain.agent_name, '');
  assert.throws(() => hub.join({ invite: plain.code }, null), /没有预设名称/);
  // 会破坏启动命令的字符被去掉
  assert.equal(hub.createInvite({ project: p1.id, name: 'a"b`c$d' }).agent_name, 'abcd');
});

test('回执：值守进程唤起时打 👌，这一轮跑完统一改成 ✅，中途回复不提前结束；别人的事项打不上', () => {
  const { hub, p1, join } = setup();
  const a = join('甲');
  const b = join('乙');
  const t = hub.createTask({ kind: 'owner' }, { project: p1.id, title: '写接口', assignee: a.agent.id });
  hub.comment({ kind: 'owner' }, t.id, `@甲 先看一下接口文档`);
  hub.message({ kind: 'owner' }, a.agent.id, '今天能交吗');
  const seqs = hub.inbox(a.row).needs_action.map((e) => e.seq);

  // 乙拿甲的事件号来打回执，什么都打不上
  assert.equal(hub.markReceipts(b.row, { state: 'working', seqs }).updated, 0);

  hub.reportActivity(a.row, { state: 'working', note: '处理新事项' });
  const r = hub.markReceipts(a.row, { state: 'working', seqs });
  assert.equal(r.updated, 3); // 指派、评论（评论和 @ 是同一条）、私信
  let d = hub.getTask(t.id);
  assert.deepEqual(d.receipts.map((x) => [x.agent, x.state]), [[a.agent.id, 'working']]);
  assert.deepEqual(d.comments[0].receipts.map((x) => [x.agent_name, x.state]), [['甲', 'working']]);
  assert.equal(hub.listMessages()[0].receipts[0].state, 'working');

  // 这一轮还没跑完：回了一句「收到」也不提前打勾
  hub.comment({ kind: 'agent', agent: a.row }, t.id, '收到，在改');
  hub.accept(a.row, t.id);
  assert.equal(hub.getTask(t.id).comments[0].receipts[0].state, 'working');

  // 回执事件只给负责人，不会再唤醒 agent
  assert.ok(!hub.inbox(a.row).events.some((e) => e.type === 'receipt.updated'));
  assert.ok(hub.eventsForOwner({}).some((e) => e.type === 'receipt.updated' && e.data.state === 'working'));

  assert.equal(hub.markReceipts(a.row, { state: 'done' }).updated, 3);
  hub.reportActivity(a.row, { state: 'idle' });
  d = hub.getTask(t.id);
  assert.equal(d.receipts[0].state, 'done');
  assert.equal(d.comments[0].receipts[0].state, 'done');
  assert.equal(hub.listMessages()[0].receipts[0].state, 'done');
  assert.throws(() => hub.markReceipts(a.row, { state: 'ok' }), /state/);
});

test('回执：交互式会话读收件箱时打 👌，回复评论、回私信、接受任务后自动 ✅', () => {
  const { hub, p1, join } = setup();
  const a = join('甲');
  const t = hub.createTask({ kind: 'owner' }, { project: p1.id, title: '写接口', assignee: a.agent.id });
  hub.comment({ kind: 'owner' }, t.id, '注意兼容老接口');
  hub.message({ kind: 'owner' }, a.agent.id, '今天能交吗');

  hub.inbox(a.row); // 不带 mark（比如钩子里只看不确认）不打回执
  assert.equal(hub.getTask(t.id).receipts.length, 0);
  hub.inbox(a.row, { mark: true });
  assert.equal(hub.getTask(t.id).receipts[0].state, 'working');
  assert.equal(hub.getTask(t.id).comments[0].receipts[0].state, 'working');
  assert.equal(hub.listMessages()[0].receipts[0].state, 'working');

  hub.accept(a.row, t.id);
  assert.equal(hub.getTask(t.id).receipts[0].state, 'done');
  assert.equal(hub.getTask(t.id).comments[0].receipts[0].state, 'working');
  hub.comment({ kind: 'agent', agent: a.row }, t.id, '好的，会兼容');
  assert.equal(hub.getTask(t.id).comments[0].receipts[0].state, 'done');
  hub.message({ kind: 'agent', agent: a.row }, 'owner', '能交');
  assert.equal(hub.listMessages().find((m) => m.sender === 'owner').receipts[0].state, 'done');
});

test('回执：运行失败标 ⚠️ 并带原因；值守进程退出时还在处理中的标 ⏸', () => {
  const { hub, p1, join } = setup();
  const a = join('甲');
  const t1 = hub.createTask({ kind: 'owner' }, { project: p1.id, title: '一', assignee: a.agent.id });
  const t2 = hub.createTask({ kind: 'owner' }, { project: p1.id, title: '二', assignee: a.agent.id });
  hub.markReceipts(a.row, { state: 'working', tasks: [t1.id] });
  hub.markReceipts(a.row, { state: 'failed', note: '运行达到单次上限 30 分钟，已结束' });
  assert.deepEqual(
    hub.getTask(t1.id).receipts.map((r) => [r.state, r.note]),
    [['failed', '运行达到单次上限 30 分钟，已结束']],
  );
  // 下一轮重新接手会再变回处理中
  hub.markReceipts(a.row, { state: 'working', tasks: [t1.id, t2.id] });
  assert.equal(hub.getTask(t1.id).receipts[0].state, 'working');
  hub.reportActivity(a.row, { state: 'stopped' });
  assert.equal(hub.getTask(t1.id).receipts[0].state, 'stopped');
  assert.equal(hub.getTask(t2.id).receipts[0].state, 'stopped');
});

test('授权 ID：长时间没有活动自动下线，之后用身份码重新连接', () => {
  const { hub, join, advance } = setup();
  const a = join('甲');
  const s = hub.activeSession(a.row.id);
  assert.ok(s);
  advance(31);
  assert.equal(hub.sweepPresence(), 1);
  assert.equal(hub.activeSession(a.row.id), null);
  assert.equal(hub.listAgents()[0].connection, null);
  const again = hub.openSession({ code: a.code, client: 'cli' });
  assert.match(again.session, /^as_/);
  assert.equal(again.agent.presence, 'active');
});

test('智能领取：只在能自动响应的 agent 里排名，让出后名次前移，都让出就提醒负责人', () => {
  const { hub, p1, join, advance } = setup();
  const a = join('甲');
  const b = join('乙');
  const c = join('丙'); // 没开值守，不参加排名
  hub.markDaemon(a.row.id, 1);
  hub.markDaemon(b.row.id, 1);
  // 乙手上有一个任务，分数比甲低
  hub.createTask({ kind: 'owner' }, { project: p1.id, title: '杂事', assignee: b.agent.id });
  const t = hub.createTask({ kind: 'owner' }, { project: p1.id, title: '写文档' });
  const fitOf = (who) => hub.inbox(who.row).claimable.find((x) => x.id === t.id).fit;
  assert.deepEqual([fitOf(a).rank, fitOf(a).of], [1, 2]);
  assert.deepEqual([fitOf(b).rank, fitOf(b).of], [2, 2]);
  // 没开值守的丙也能看到自己排第几，但不占别人的名次
  assert.deepEqual([fitOf(c).rank, fitOf(c).of], [3, 3]);
  assert.equal(fitOf(a).open_since, t.created_at);

  // 甲让出：乙变成第 1 名，详情里有让出记录
  advance(1);
  assert.throws(() => hub.pass(a.row, t.id, ' '), /说明/);
  const r = hub.pass(a.row, t.id, '需要 iOS 证书，我这台没有');
  assert.equal(r.remaining, 1);
  assert.equal(fitOf(b).rank, 1);
  assert.equal(fitOf(a).passed, true);
  assert.equal(hub.getTask(t.id).passes[0].reason, '需要 iOS 证书，我这台没有');
  assert.equal(hub.eventsForAgent(b.row, 0, 100).events.at(-1).type, 'task.passed');

  // 乙也让出：没有候选了，提醒负责人
  hub.pass(b.row, t.id, '不熟悉');
  const last = hub.eventsForOwner({ limit: 1 })[0];
  assert.equal(last.type, 'task.unclaimed');
  assert.deepEqual(last.audience, []);

  // 负责人修改了描述：让出记录清空，重新开始计时
  advance(5);
  hub.updateTask(t.id, { description: '证书已放到共享盘' });
  assert.equal(hub.getTask(t.id).passes.length, 0);
  assert.equal(fitOf(a).rank, 1);
  assert.notEqual(fitOf(a).open_since, t.created_at);

  // 已领取的任务不能让出
  hub.claim(a.row, t.id);
  assert.throws(() => hub.pass(b.row, t.id, '晚了'), /只有待领取的任务/);
});

test('智能领取：做过相关任务的加分，正在忙的减分', () => {
  const { hub, p1, join } = setup();
  const a = join('甲');
  const b = join('乙');
  hub.markDaemon(a.row.id, 1);
  hub.markDaemon(b.row.id, 1);
  const parent = hub.createTask({ kind: 'owner' }, { project: p1.id, title: '登录功能', assignee: b.agent.id });
  hub.accept(b.row, parent.id);
  // 乙手上有父任务（−8），但做过父任务（+15），仍然排第一
  const child = hub.createTask({ kind: 'owner' }, { project: p1.id, title: '登录页样式', parent: parent.id });
  const fitB = hub.inbox(b.row).claimable.find((x) => x.id === child.id).fit;
  assert.equal(fitB.rank, 1);
  assert.ok(fitB.reasons.some((x) => x.includes(parent.id)), fitB.reasons.join());
  // 乙正在处理别的事：−15，掉到第二
  hub.reportActivity(b.row, { state: 'working', note: '忙' });
  const busy = hub.inbox(b.row).claimable.find((x) => x.id === child.id).fit;
  assert.equal(busy.rank, 2);
  assert.ok(busy.warnings.includes('正在处理别的事'));
});
