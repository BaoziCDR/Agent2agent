// 控制台怎么呈现一条事件。Hub 存的摘要是写给事件接收者看的（「@了你」的「你」是被 @ 的 agent），
// 而控制台的读者永远是负责人，这里换成负责人的视角。放在 shared 里，Hub 不用改存量数据，旧事件也能正确显示。
import type { HubEvent } from './model.js';

type EventLike = Pick<HubEvent, 'type' | 'task' | 'actor' | 'audience' | 'data'>;

/**
 * 这条事件会不会改变任务列表里显示的内容（看板卡片、关系图）。
 * 评论、回执、agent 活动这些都不显示在卡片上，不用为它们重拉整个列表。
 */
export const changesTaskList = (e: Pick<HubEvent, 'type'>) => e.type.startsWith('task.') || e.type === 'agent.updated';

/** 任务详情里显示着哪些别的任务：只是状态和负责人变了才需要刷新 */
const RELATED_CHANGES = new Set<HubEvent['type']>(['task.status_changed', 'task.assigned', 'task.claimed', 'task.unclaimed', 'task.updated']);

interface OpenTask {
  status: string;
  parent: string | null;
  depends_on: string[];
  subtasks: { id: string }[];
  ref_tasks: { id: string }[];
  referenced_by: { id: string }[];
}

/**
 * 打开着任务详情时，这条事件要不要重新拉取详情。
 * task 是已经载入的详情；刚切换到这个任务、还没载入完时传 null。
 */
export function changesTaskDetail(e: Pick<HubEvent, 'type' | 'task' | 'data'>, id: string, task: OpenTask | null): boolean {
  if (e.type === 'agent.activity' || e.type === 'agent.control') return false;
  if (e.type === 'agent.updated') return true; // 名字显示在负责人、评论、回执上
  // 待领取的任务要显示领取候选，排名和 agent 是否在线有关
  if (e.type === 'agent.online' || e.type === 'agent.offline' || e.type === 'agent.joined') return task?.status === 'open';
  if (e.type === 'task.created') return true; // 新任务可能是它的子任务，或者引用了它
  if (e.task === id) return true;
  if (e.task) {
    if (!task || !RELATED_CHANGES.has(e.type)) return false;
    const related = [task.parent, ...task.depends_on, ...[...task.subtasks, ...task.ref_tasks, ...task.referenced_by].map((t) => t.id)];
    return related.includes(e.task);
  }
  // 一次回执涉及多个任务时事件不挂在具体任务上，只有全是私信才和详情无关
  if (e.type === 'receipt.updated') {
    const targets = Array.isArray(e.data.targets) ? (e.data.targets as { kind?: string }[]) : [];
    return targets.some((t) => t.kind !== 'message');
  }
  return false;
}

/** 发给负责人的 @ 和私信，也就是总览「需要你处理」里的那些。和 Hub 的 OWNER_INBOX_SQL 同一口径。 */
export const isForOwner = (e: Pick<HubEvent, 'type' | 'audience'>) =>
  (e.type === 'mention' || e.type === 'message.direct') && e.audience?.length === 0;

/** 摘要里指代接收者的说法。按模板写死前后文，避免误伤标题或正文里普通的「你」。 */
const YOU: [RegExp, (name: string) => string][] = [
  [/@了你/g, (n) => `@了 ${n}`],
  [/给你发来私信/g, (n) => `给 ${n} 发来私信`],
  [/指派给了你/g, (n) => `指派给了 ${n}`],
  [/从你名下/g, (n) => `从 ${n} 名下`],
  [/负责人让你/g, (n) => `负责人让 ${n} `],
  [/@mentioned you\b/g, (n) => `@mentioned ${n}`],
  [/\bsent you a message/g, (n) => `sent ${n} a message`],
  [/(\bassigned .*?) to you\b/g, (n) => `$1 to ${n}`],
  [/\baway from you\b/g, (n) => `away from ${n}`],
  [/\basked you to\b/g, (n) => `asked ${n} to`],
];

/**
 * 把摘要改成负责人视角：发给某个 agent 的事件，「你」换成它的名字。
 * agent.activity 的说明是值守进程转述的唤起原因，里面的「你」指这个 agent 自己，可能有多条。
 */
export function ownerSummary(text: string, e: EventLike, nameOf: (code: string) => string): string {
  const activity = e.type === 'agent.activity';
  const target = activity ? (typeof e.data.agent === 'string' ? e.data.agent : e.actor) : e.audience?.length === 1 ? e.audience[0] : null;
  if (!target) return text;
  const name = nameOf(target).replace(/\$/g, '$$$$');
  if (activity) return YOU.reduce((out, [re, to]) => out.replace(re, to(name)), text);
  // 普通事件的模板只有一处「你」，正文摘录都在它后面：只换最靠前的一处，不改别人的原话
  const hits = YOU.map(([re, to]) => ({ re, to, at: text.search(re) })).filter((h) => h.at >= 0);
  if (!hits.length) return text;
  const first = hits.reduce((a, b) => (b.at < a.at ? b : a));
  return text.replace(new RegExp(first.re.source), first.to(name));
}

const SECTION: Partial<Record<HubEvent['type'], string>> = {
  'task.progress': 'progress',
  'artifact.updated': 'artifacts',
  'task.deliverable': 'artifacts',
};

/** 任务详情里该定位到哪：评论精确到那一条，老事件没有评论编号的定位到讨论区。 */
function taskAnchor(e: EventLike): string | null {
  if (e.type === 'comment.created' || e.type === 'mention') {
    return typeof e.data.comment_id === 'number' ? `comment-${e.data.comment_id}` : 'discussion';
  }
  return SECTION[e.type] ?? null;
}

/**
 * 点开一条事件要去的地址；没有对应位置的返回 null。
 * 任务详情是当前页上的抽屉，所以需要传入当前页，关掉后还留在原来的页面。
 */
export function eventHref(e: EventLike, page: string): string | null {
  if (e.task) {
    const anchor = taskAnchor(e);
    return `#/${page}/${e.task}${anchor ? `/${anchor}` : ''}`;
  }
  if (e.type === 'message.direct') {
    return typeof e.data.message_id === 'number' ? `#/messages/message-${e.data.message_id}` : '#/messages';
  }
  if (e.type.startsWith('agent.')) {
    const code = typeof e.data.agent === 'string' ? e.data.agent : e.actor;
    return /^A-\d+$/.test(code) ? `#/agents/agent-${code}` : '#/agents';
  }
  if (e.type.startsWith('project.')) return '#/projects';
  return null;
}
