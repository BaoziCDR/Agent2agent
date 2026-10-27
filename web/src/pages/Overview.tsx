import { get, markOwnerRead, type Overview as OverviewData } from '../api';
import { AnswerBox } from '../answer';
import { StatusBadge, clock, dueInfo, presence, PRESENCE_LABEL, timeAgo, useData, useHub, agentLabel } from '../ui';

export function Overview() {
  const { project, projects, agents, events, openTask, go, refresh } = useHub();
  const { data, reload } = useData(() => get<OverviewData>(`/overview${project ? `?project=${project}` : ''}`), [project]);
  const scopeName = project ? projects.find((p) => p.id === project)?.name : '全部项目';
  const scopedAgents = project ? agents.filter((a) => a.projects.some((p) => p.id === project)) : agents.filter((a) => a.status !== 'deleted');
  // 只看面向全体或负责人的事件；发给某个 agent 的定向事件（如「指派给了你」）在实时动态页里看
  const feed = events
    .filter((e) => (!project || e.project === project || e.project === null) && (e.type === 'task.overdue' || !(e.audience && e.audience.length > 0)))
    .slice(0, 12);

  if (projects.length === 0) {
    return (
      <div>
        <h1 className="page-title">欢迎使用协作中枢</h1>
        <p className="page-sub">先创建一个项目，再邀请 agent 加入、发布任务。</p>
        <button className="btn primary" onClick={() => go('projects')}>
          创建第一个项目
        </button>
      </div>
    );
  }

  const c = data?.counts;
  return (
    <div>
      <h1 className="page-title">总览</h1>
      <p className="page-sub">{scopeName}</p>

      <div className="grid stats">
        <div className="card stat">
          <div className="stat-label">进行中</div>
          <div className="stat-value">{c?.working ?? '–'}</div>
        </div>
        <div className={`card stat ${c?.review ? 'warn' : ''}`}>
          <div className="stat-label">待验收</div>
          <div className="stat-value">{c?.review ?? '–'}</div>
        </div>
        <div className={`card stat ${c?.input_required ? 'bad' : ''}`}>
          <div className="stat-label">阻塞</div>
          <div className="stat-value">{c?.input_required ?? '–'}</div>
        </div>
        <div className={`card stat ${c?.lost ? 'bad' : ''}`}>
          <div className="stat-label">可能失联</div>
          <div className="stat-value">{c?.lost ?? '–'}</div>
        </div>
        <div className={`card stat ${c?.stalled ? 'warn' : ''}`} title="一直在报进度，但百分比 2 小时以上没变">
          <div className="stat-label">原地打转</div>
          <div className="stat-value">{c?.stalled ?? '–'}</div>
        </div>
        <div className={`card stat ${c?.overdue ? 'bad' : ''}`}>
          <div className="stat-label">已逾期</div>
          <div className="stat-value">{c?.overdue ?? '–'}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">待领取</div>
          <div className="stat-value">{c?.open ?? '–'}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">在线 agent</div>
          <div className="stat-value">
            {data?.agents_online ?? '–'}
            <span className="faint"> / {scopedAgents.length}</span>
          </div>
        </div>
      </div>

      <div className="grid two-col">
        <div className="grid" style={{ alignContent: 'start' }}>
          <div className="card">
            <div className="btn-row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
              <h3 style={{ margin: 0 }}>需要你处理</h3>
              {data && data.mentions.length > 0 && (
                <button className="btn small" onClick={() => markOwnerRead({ project: project ?? undefined }).then(reload)}>
                  @ 和私信全部已读
                </button>
              )}
            </div>
            {data && data.attention.length === 0 && data.mentions.length === 0 && <div className="empty">暂时没有需要你处理的事</div>}
            <div className="list">
              {data?.attention.map((t) => (
                <div key={t.id} className="list-item clickable" onClick={() => openTask(t.id)}>
                  <StatusBadge task={t} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div>
                      <b>{t.id}</b> {t.title}
                    </div>
                    <div className="faint">
                      {t.status === 'review' && `${t.assignee_name ?? ''} 已提交，等待验收`}
                      {t.status === 'input_required' && `${t.block_options.length ? '等你回答' : '阻塞原因'}：${t.block_reason}`}
                      {t.status === 'draft' && `${t.created_by === 'owner' ? '你' : t.created_by} 的草稿，尚未发布`}
                      {t.status === 'working' && t.lease_until && new Date(t.lease_until) < new Date() && `${t.assignee_name ?? ''} 很久没有上报进度，可能已失联`}
                      {t.stalled && `${t.assignee_name ?? ''} 一直在报进度，但停在 ${t.progress}% 很久了，可能在原地打转`}
                      {(() => {
                        const d = dueInfo(t);
                        return d?.cls === 'bad' && <span className="due bad">{t.status === 'working' || t.status === 'input_required' ? ' · ' : ''}{d.text}</span>;
                      })()}
                    </div>
                    {t.status === 'input_required' && t.block_options.length > 0 && <AnswerBox task={t} compact />}
                  </div>
                </div>
              ))}
              {data?.mentions.map((e) => (
                <div key={e.seq} className="list-item clickable" onClick={() => {
                    // 点开就算读过；打开任务详情时也会把该任务下的 @ 一并标为已读
                    markOwnerRead({ seqs: [e.seq] }).then((n) => n && refresh());
                    if (e.task) openTask(e.task);
                    else go('messages');
                  }}>
                  <span className="badge accent">{e.type === 'mention' ? '@你' : '私信'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div>{e.summary}</div>
                    <div className="faint">{timeAgo(e.at)}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="card">
            <h3>Agent 状态</h3>
            {scopedAgents.length === 0 && (
              <div className="empty">
                还没有 agent。<a href="#/invite">邀请一个</a>
              </div>
            )}
            <div className="list">
              {scopedAgents.map((a) => {
                const p = presence(a);
                return (
                  <div key={a.id} className="list-item">
                    <span className={`dot ${p}`} style={{ marginTop: 7 }} title={PRESENCE_LABEL[p]} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div>
                        <b>{a.name}</b> <span className="faint">{a.id}</span>
                      </div>
                      <div className="faint">
                        {PRESENCE_LABEL[p]} · 最后出现 {timeAgo(a.last_seen_at)}
                        {a.active_tasks.length > 0 && ` · 手上：${a.active_tasks.join('、')}`}
                      </div>
                      {a.activity && <div className="faint">正在处理：{a.activity.note}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <div className="card" style={{ alignSelf: 'start' }}>
          <h3>实时动态</h3>
          {feed.length === 0 && <div className="empty">打开控制台后的新动态会实时出现在这里</div>}
          <div className="list">
            {feed.map((e) => (
              <div
                key={e.seq}
                className={`list-item ${e.task ? 'clickable' : ''}`}
                onClick={() => e.task && openTask(e.task)}
              >
                <span className="feed-time">{clock(e.at)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {e.summary}
                  {e.actor !== 'owner' && !e.summary.startsWith(agentLabel(agents, e.actor)) && <span className="faint"> · {agentLabel(agents, e.actor)}</span>}
                </div>
              </div>
            ))}
          </div>
          {feed.length > 0 && (
            <button className="btn small" onClick={() => go('feed')} style={{ marginTop: 8 }}>
              查看全部动态
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
