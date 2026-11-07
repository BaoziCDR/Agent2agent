import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../dist/server/db.js';
import { Hub } from '../dist/server/hub.js';
import { changesTaskDetail, changesTaskList, eventHref, isForOwner, ownerSummary } from '../dist/shared/event-view.js';

const nameOf = (code) => ({ 'A-1': 'Claude-Linux', 'A-2': 'Co$1dex' })[code] ?? code;
const event = (over) => ({ type: 'mention', task: 'P1-T3', actor: 'A-2', audience: ['A-1'], data: {}, ...over });

test('控制台摘要：发给 agent 的「你」换成它的名字', () => {
  const view = (text, over) => ownerSummary(text, event(over), nameOf);
  assert.equal(view('Codex在 P1-T3 里 @了你：@A-1 你看下'), 'Codex在 P1-T3 里 @了 Claude-Linux：@A-1 你看下');
  assert.equal(view('Codex @mentioned you in P1-T3: can you check'), 'Codex @mentioned Claude-Linux in P1-T3: can you check');
  assert.equal(view('Codex给你发来私信：@了你', { type: 'message.direct', task: null }), 'Codex给 Claude-Linux 发来私信：@了你');
  assert.equal(view('负责人把 P1-T3「你好」指派给了你', { type: 'task.assigned', actor: 'owner' }), '负责人把 P1-T3「你好」指派给了 Claude-Linux');
  assert.equal(view('The owner assigned P1-T3 "x" to you', { type: 'task.assigned', actor: 'owner' }), 'The owner assigned P1-T3 "x" to Claude-Linux');
  // 名字里的 $ 不能被当成替换语法
  assert.equal(view('甲在 P1-T3 里 @了你：x', { audience: ['A-2'] }), '甲在 P1-T3 里 @了 Co$1dex：x');
});

test('控制台摘要：唤起说明里的「你」指被唤起的 agent，可能有多处', () => {
  const e = event({ type: 'agent.activity', task: null, actor: 'A-1', audience: [], data: { agent: 'A-1', state: 'working' } });
  assert.equal(
    ownerSummary('Claude-Linux被唤醒：甲 @mentioned you in P1-T1: x；乙在 P1-T2 里 @了你：y', e, nameOf),
    'Claude-Linux被唤醒：甲 @mentioned Claude-Linux in P1-T1: x；乙在 P1-T2 里 @了 Claude-Linux：y',
  );
});

test('控制台摘要：发给负责人的和面向所有人的不变', () => {
  const text = '甲在 P1-T3 里 @了负责人：你看下';
  assert.equal(ownerSummary(text, event({ audience: [] }), nameOf), text);
  assert.equal(ownerSummary('甲在 P1-T3 下评论：@了你', event({ type: 'comment.created', audience: null }), nameOf), '甲在 P1-T3 下评论：@了你');
});

test('只有发给负责人的 @ 和私信算「发给我」', () => {
  assert.equal(isForOwner(event({ audience: [] })), true);
  assert.equal(isForOwner(event({ type: 'message.direct', audience: [] })), true);
  assert.equal(isForOwner(event({ audience: ['A-1'] })), false);
  assert.equal(isForOwner(event({ type: 'agent.activity', audience: [] })), false);
  assert.equal(isForOwner(event({ type: 'comment.created', audience: null })), false);
});

test('点动态跳到对应位置', () => {
  const href = (over) => eventHref(event(over), 'feed');
  assert.equal(href({ data: { comment_id: 7 } }), '#/feed/P1-T3/comment-7');
  assert.equal(href({ type: 'comment.created', data: { comment_id: 7 } }), '#/feed/P1-T3/comment-7');
  assert.equal(href({ data: {} }), '#/feed/P1-T3/discussion', '老事件没有评论编号，定位到讨论区');
  assert.equal(href({ type: 'task.progress' }), '#/feed/P1-T3/progress');
  assert.equal(href({ type: 'artifact.updated' }), '#/feed/P1-T3/artifacts');
  assert.equal(href({ type: 'task.claimed' }), '#/feed/P1-T3');
  assert.equal(href({ type: 'message.direct', task: null, data: { message_id: 5 } }), '#/messages/message-5');
  assert.equal(href({ type: 'message.direct', task: null }), '#/messages');
  assert.equal(href({ type: 'agent.activity', task: null, actor: 'A-1', data: { agent: 'A-1' } }), '#/agents/agent-A-1');
  assert.equal(href({ type: 'agent.control', task: null, actor: 'owner', data: {} }), '#/agents');
  assert.equal(href({ type: 'owner.broadcast', task: null }), null);
});

test('负责人事件列表：带已读状态，可以只取发给负责人的；点开 @ 的事件能定位到真实评论', () => {
  const hub = new Hub(openDb(':memory:'));
  const p = hub.createProject({ name: '项目', description: '' });
  const inv = hub.createInvite({ project: p.id, max_uses: 5, tags: [] });
  const join = (name) => {
    const r = hub.join({ invite: inv.code, name }, null);
    return { ...r, row: hub.agentByCode(r.code) };
  };
  const a = join('甲');
  const b = join('乙');
  const t = hub.createTask({ kind: 'owner' }, { project: p.id, title: '任务' });
  hub.comment({ kind: 'agent', agent: a.row }, t.id, `@${b.agent.id} 看下`);
  hub.comment({ kind: 'agent', agent: a.row }, t.id, '@负责人 拍板');

  const inbox = hub.eventsForOwner({ inbox: true });
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].owner_read, false);
  assert.match(inbox[0].summary, /@了负责人/);

  const toAgent = hub.eventsForOwner({}).find((e) => e.type === 'mention' && e.audience.length === 1);
  assert.equal(toAgent.owner_read, undefined);
  assert.match(ownerSummary(toAgent.summary, toAgent, () => '乙'), /@了 乙：/);

  const comment = hub.getTask(t.id).comments.at(-1);
  assert.equal(eventHref(inbox[0], 'feed'), `#/feed/${t.id}/comment-${comment.id}`);

  hub.markOwnerRead({ task: t.id });
  assert.equal(hub.eventsForOwner({ inbox: true })[0].owner_read, true);
});

test('看板只为改变卡片的事件刷新', () => {
  for (const type of ['task.created', 'task.progress', 'task.status_changed', 'task.assigned', 'task.updated', 'agent.updated']) {
    assert.equal(changesTaskList({ type }), true, type);
  }
  for (const type of ['receipt.updated', 'agent.activity', 'agent.online', 'agent.offline', 'comment.created', 'mention', 'message.direct', 'artifact.updated']) {
    assert.equal(changesTaskList({ type }), false, type);
  }
});

test('任务详情只为相关事件刷新', () => {
  const open = {
    status: 'working',
    parent: 'P1-T1',
    depends_on: ['P1-T2'],
    subtasks: [{ id: 'P1-T4' }],
    ref_tasks: [{ id: 'P1-T5' }],
    referenced_by: [{ id: 'P1-T6' }],
  };
  const changes = (over, task = open) => changesTaskDetail({ type: 'task.progress', task: 'P1-T3', data: {}, ...over }, 'P1-T3', task);

  // 本任务的事件都要刷新，包括回执（评论下的标签）；任务详情还没载入完也一样
  for (const type of ['task.progress', 'comment.created', 'mention', 'artifact.updated', 'receipt.updated', 'task.deliverable']) {
    assert.equal(changes({ type }), true, type);
    assert.equal(changes({ type }, null), true, `${type}（未载入）`);
  }
  // agent 活动不显示在详情里，哪怕挂在本任务上
  assert.equal(changes({ type: 'agent.activity' }), false);

  // 其他任务的事件：无关的不刷新
  assert.equal(changes({ task: 'P1-T9' }), false);
  assert.equal(changes({ type: 'task.status_changed', task: 'P1-T9' }), false);
  assert.equal(changes({ type: 'comment.created', task: 'P1-T9' }), false);

  // 详情里显示的任务：状态、负责人变了才刷新，子任务报进度不用
  for (const task of ['P1-T1', 'P1-T2', 'P1-T4', 'P1-T5', 'P1-T6']) {
    assert.equal(changes({ type: 'task.status_changed', task }), true, task);
    assert.equal(changes({ type: 'task.progress', task }), false, task);
    assert.equal(changes({ type: 'comment.created', task }), false, task);
  }
  assert.equal(changes({ type: 'task.status_changed', task: 'P1-T4' }, null), false);

  // 新任务可能是它的子任务；agent 改名显示在评论和负责人上
  assert.equal(changes({ type: 'task.created', task: 'P1-T9' }), true);
  assert.equal(changes({ type: 'agent.updated', task: null }), true);

  // 领取候选只在待领取时显示
  assert.equal(changes({ type: 'agent.online', task: null }), false);
  assert.equal(changes({ type: 'agent.offline', task: null }, { ...open, status: 'open' }), true);

  // 回执跨多个任务时事件不挂任务；全是私信才和详情无关
  assert.equal(changes({ type: 'receipt.updated', task: null, data: { targets: [{ kind: 'comment', id: 1 }, { kind: 'task', id: 2 }] } }), true);
  assert.equal(changes({ type: 'receipt.updated', task: null, data: { targets: [{ kind: 'message', id: 1 }] } }), false);
  assert.equal(changes({ type: 'message.direct', task: null }), false);
});
