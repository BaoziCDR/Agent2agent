import { eventSummary, type HubEvent } from './api';
import { msg, t } from './i18n';

const KEY = 'ahub.notify';

export const notifySupported = () => typeof window !== 'undefined' && 'Notification' in window;

export function notifyEnabled(): boolean {
  try {
    return notifySupported() && Notification.permission === 'granted' && localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export async function setNotify(on: boolean): Promise<boolean> {
  if (!notifySupported()) return false;
  if (on && Notification.permission !== 'granted') {
    const p = await Notification.requestPermission();
    if (p !== 'granted') return false;
  }
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    // 无痕模式下忽略
  }
  return on;
}

const TITLES: Partial<Record<string, string>> = {
  mention: msg('有人 @ 了你'),
  'message.direct': msg('收到私信'),
  'task.lease_expiring': msg('任务可能失联'),
  'agent.offline': msg('Agent 下线了'),
  'task.overdue': msg('任务逾期'),
  'task.stalled': msg('任务疑似原地打转'),
  'task.unclaimed': msg('没有 agent 愿意领取'),
};

/** 需要负责人处理或知晓的事件才弹通知。 */
export function notificationTitle(e: HubEvent): string | null {
  if ((e.type === 'mention' || e.type === 'message.direct') && e.audience?.length === 0) return t(TITLES[e.type]!);
  if (e.type === 'task.lease_expiring' || e.type === 'agent.offline' || e.type === 'task.overdue' || e.type === 'task.stalled' || e.type === 'task.unclaimed') return t(TITLES[e.type]!);
  if (e.type === 'task.status_changed') {
    if (e.data.to === 'review') return t('有任务待验收');
    if (e.data.to === 'input_required') return t('有任务被阻塞');
  }
  return null;
}

/** 控制台不在前台时，用系统通知提醒负责人。 */
export function maybeNotify(e: HubEvent, onClick: () => void) {
  if (!notifyEnabled() || (document.visibilityState === 'visible' && document.hasFocus())) return;
  const title = notificationTitle(e);
  if (!title) return;
  try {
    const n = new Notification(`${t('协作中枢')} · ${title}`, { body: eventSummary(e), tag: `ahub-${e.seq}` });
    n.onclick = () => {
      window.focus();
      onClick();
      n.close();
    };
  } catch {
    // 部分浏览器（如移动端）不允许直接 new Notification
  }
}
