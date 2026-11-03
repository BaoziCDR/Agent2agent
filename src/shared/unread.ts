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
  type Item = { actor: string; seq?: number; summary: string; summary_en?: string };
  let needs: Item[];
  let unanswered: Item[];
  try {
    const r = JSON.parse(inboxJson) as { needs_action?: Item[]; unanswered?: Item[] };
    needs = r.needs_action ?? [];
    unanswered = r.unanswered ?? [];
  } catch {
    return '';
  }
  const line = (e: Item) => `- ${e.actor === 'owner' ? tr('〔负责人〕') : `〔${e.actor}〕`} ${e.seq ? `#${e.seq} ` : ''}${summaryOf(e)}`;
  const list = (items: Item[]) =>
    items.slice(0, 5).map(line).join('\n') + (items.length > 5 ? '\n' + tr('……还有 {n} 条', { n: items.length - 5 }) : '');
  const out: string[] = [];
  if (needs.length) {
    const how = via === 'cli' ? tr('请先运行 ahub inbox 读取未读消息') : tr('请先调用 hub_sync 读取未读消息');
    out.push(
      tr('【未读提醒】进度已上报，但你还有 {n} 条未读消息需要处理：\n{items}{more}\n{how}，处理完再继续手上的工作。', {
        n: needs.length,
        items: list(needs),
        more: '',
        how,
      }),
    );
  }
  if (unanswered.length) {
    const how = via === 'cli' ? tr('运行 ahub inbox 看全文') : tr('调用 hub_sync 看全文');
    out.push(
      tr('【未回复提醒】之前读到的这 {n} 条 @ 或私信，你还没回复，也没标为已读：\n{items}\n{how}；需要回答或行动的去回复，只是告知的标为已读（ahub seen / hub_seen）。', {
        n: unanswered.length,
        items: list(unanswered),
        how,
      }),
    );
  }
  return out.length ? '\n' + out.join('\n\n') + '\n' : '';
}
