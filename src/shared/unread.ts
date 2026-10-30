import { summaryOf, tr } from '../i18n/index.js';

/** 只看不确认的收件箱查询：不打回执、不推进已读位置；peek=1 让 stdio 桥别把读到的事件号记成已读。 */
export function peekInboxPath(since?: number): string {
  const q = new URLSearchParams({ format: 'json', peek: '1' });
  if (since) q.set('since', String(since));
  return `/api/v1/inbox?${q}`;
}

/**
 * 上报进度后附带的未读提醒：已读位置之后还有需要处理的事项（指派、@、私信、退回等）时，
 * 提醒 agent 先去读收件箱。没有未读或解析失败时返回空串。
 */
export function unreadReminder(inboxJson: string, via: 'cli' | 'mcp'): string {
  let needs: { actor: string; summary: string; summary_en?: string }[];
  try {
    needs = (JSON.parse(inboxJson) as { needs_action?: typeof needs }).needs_action ?? [];
  } catch {
    return '';
  }
  if (!needs.length) return '';
  const items = needs
    .slice(0, 5)
    .map((e) => `- ${e.actor === 'owner' ? tr('〔负责人〕') : `〔${e.actor}〕`} ${summaryOf(e)}`)
    .join('\n');
  const more = needs.length > 5 ? '\n' + tr('……还有 {n} 条', { n: needs.length - 5 }) : '';
  const how = via === 'cli' ? tr('请先运行 ahub inbox 读取未读消息') : tr('请先调用 hub_sync 读取未读消息');
  return (
    '\n' +
    tr('【未读提醒】进度已上报，但你还有 {n} 条未读消息需要处理：\n{items}{more}\n{how}，处理完再继续手上的工作。', {
      n: needs.length,
      items,
      more,
      how,
    }) +
    '\n'
  );
}
