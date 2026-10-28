import { useState } from 'react';
import { joinList, msg, t } from '../i18n';
import { eventSummary, get, type HubEvent } from '../api';
import { agentLabel, clock, useData, useHub } from '../ui';

const TYPE_GROUPS: Record<string, { label: string; types: string[] }> = {
  all: { label: msg('全部'), types: [] },
  progress: { label: msg('进度'), types: ['task.progress'] },
  status: { label: msg('状态变化'), types: ['task.status_changed', 'task.claimed', 'task.assigned', 'task.created', 'task.lease_expiring', 'task.due_soon', 'task.overdue', 'task.unlocked', 'task.stalled', 'task.passed', 'task.unclaimed'] },
  talk: { label: msg('讨论与私信'), types: ['comment.created', 'artifact.updated', 'mention', 'message.direct', 'owner.broadcast'] },
  agents: { label: msg('Agent'), types: ['agent.joined', 'agent.updated', 'agent.online', 'agent.offline', 'agent.activity', 'agent.control'] },
};

export function Feed() {
  const { project, agents, openTask } = useHub();
  const [group, setGroup] = useState('all');
  const [agent, setAgent] = useState('');
  const [limit, setLimit] = useState(200);
  const { data } = useData(() => get<HubEvent[]>(`/events?limit=${limit}${project ? `&project=${project}` : ''}`), [project, limit]);

  const types = TYPE_GROUPS[group].types;
  const events = (data ?? []).filter((e) => e.type !== 'receipt.updated' && (types.length === 0 || types.includes(e.type)) && (!agent || e.actor === agent));

  return (
    <div style={{ maxWidth: 900 }}>
      <h1 className="page-title">{t('实时动态')}</h1>
      <p className="page-sub">{t('Hub 上发生的每一件事，按时间倒序，自动刷新。')}</p>
      <div className="btn-row" style={{ marginBottom: 12 }}>
        <div className="tabs" style={{ marginBottom: 0, borderBottom: 'none' }}>
          {Object.entries(TYPE_GROUPS).map(([k, g]) => (
            <button key={k} className={`tab ${group === k ? 'active' : ''}`} onClick={() => setGroup(k)}>
              {t(g.label)}
            </button>
          ))}
        </div>
        <select className="select" style={{ width: 180 }} value={agent} onChange={(e) => setAgent(e.target.value)} aria-label={t('按 agent 筛选')}>
          <option value="">{t('所有人')}</option>
          <option value="owner">{t('负责人')}</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}{a.status === 'deleted' ? t('（已删除）') : ''}
            </option>
          ))}
        </select>
      </div>
      <div className="card">
        {events.length === 0 && <div className="empty">{t('没有符合条件的动态')}</div>}
        <div className="list">
          {events.map((e) => (
            <div key={e.seq} className={`list-item ${e.task ? 'clickable' : ''}`} onClick={() => e.task && openTask(e.task)}>
              <span className="feed-time">{clock(e.at)}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div>{eventSummary(e)}</div>
                <div className="faint">
                  {agentLabel(agents, e.actor)}
                  {e.project && ` · ${e.project}`}
                  {e.audience && e.audience.length === 0 && t(' · 仅负责人可见')}
                  {e.audience && e.audience.length > 0 && ` · ${t('发给 {who}', { who: joinList(e.audience.map((a) => agentLabel(agents, a))) })}`}
                </div>
              </div>
            </div>
          ))}
        </div>
        {data && data.length >= limit && (
          <button className="btn small" onClick={() => setLimit((l) => l + 200)} style={{ marginTop: 8 }}>
            {t('加载更多')}
          </button>
        )}
      </div>
    </div>
  );
}
