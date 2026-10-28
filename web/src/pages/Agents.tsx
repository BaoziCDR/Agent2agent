import { useState } from 'react';
import { joinList, msg, t } from '../i18n';
import { type Agent, type Connection, del, get, patch, post, type Run } from '../api';
import { LaunchDialog, NewAgentDialog } from './Invite';
import { Modal, dateTime, platformLabel, presenceLabel, presence, splitList, timeAgo, useData, useHub } from '../ui';

const END_REASON: Record<string, string> = { released: msg('正常退出'), expired: msg('超时自动下线'), replaced: msg('被别处的新连接顶掉'), revoked: msg('被强制下线') };
const where = (c: Connection) => [c.host, c.client_label].filter(Boolean).join(' · ');

const duration = (r: Run) => {
  const s = Math.max(0, Math.round((Date.parse(r.ended_at) - Date.parse(r.started_at)) / 1000));
  return s < 60
    ? t('{s} 秒', { s })
    : s < 3600
      ? t('{m} 分 {s} 秒', { m: Math.floor(s / 60), s: s % 60 })
      : t('{h} 小时 {m} 分', { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) });
};

function daemonState(a: Agent): { text: string; cls: string } {
  if (a.daemon_paused) return { text: a.daemon ? t('已暂停') : t('已暂停（未运行）'), cls: 'warn' };
  if (!a.daemon) return a.resident ? { text: t('常驻等待'), cls: 'good' } : { text: t('未运行'), cls: '' };
  return a.activity ? { text: t('处理中'), cls: 'accent' } : { text: t('值守中'), cls: 'good' };
}

const TIER: Record<string, string> = { L1: msg('命令行/实时'), L2: 'MCP', L3: msg('HTTP 轮询'), L4: msg('人工中继') };

export function Agents({ startInvite = false }: { startInvite?: boolean }) {
  const { agents, project, toast, refresh, openTask, go } = useHub();
  const [runsOf, setRunsOf] = useState<Agent | null>(null);
  const [launchOf, setLaunchOf] = useState<Agent | null>(null);
  const [sessionsOf, setSessionsOf] = useState<Agent | null>(null);
  const [joinOf, setJoinOf] = useState<Agent | null>(null);
  const [inviting, setInviting] = useState(startInvite);
  const closeInvite = () => {
    setInviting(false);
    if (startInvite) go('agents'); // 从旧地址 #/invite 进来的，关掉后回到 Agent 页
  };

  const daemon = async (a: Agent, action: 'pause' | 'resume' | 'wake') => {
    try {
      await post(`/agents/${a.id}/daemon`, { action });
      toast(t({ pause: msg('已暂停 {name} 的值守'), resume: msg('已恢复 {name} 的值守'), wake: msg('已让 {name} 立即检查') }[action], { name: a.name }));
      refresh();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };
  // 删除了的 agent 只为历史任务和评论保留名字，不再列为成员
  const members = agents.filter((a) => a.status !== 'deleted');
  const list = project ? members.filter((a) => a.projects.some((p) => p.id === project)) : members;

  const toggle = async (a: Agent) => {
    try {
      await patch(`/agents/${a.id}`, { status: a.status === 'active' ? 'disabled' : 'active' });
      toast(t(a.status === 'active' ? msg('已停用 {name}') : msg('已启用 {name}'), { name: a.name }));
      refresh();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  const remove = async (a: Agent) => {
    const tasks = a.active_tasks.length ? `\n${t('它手上的 {tasks} 中未提交的会放回任务池。', { tasks: joinList(a.active_tasks) })}` : '';
    if (!confirm(`${t('删除 {name}（{id}）？\n它的身份码永久失效，不再出现在成员列表里；做过的任务、评论和交付物都保留，仍显示它的名字。', { name: a.name, id: a.id })}${tasks}`)) return;
    try {
      const r = await del<{ released: string[] }>(`/agents/${a.id}`);
      toast(r.released.length ? t('已删除 {name}，{tasks} 已放回任务池', { name: a.name, tasks: joinList(r.released) }) : t('已删除 {name}', { name: a.name }));
      refresh();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  const kick = async (a: Agent) => {
    const note = prompt(t('强制 {name}（{id}）下线？\n它当前的授权 ID 立即失效，值守进程会停下正在跑的 harness 并退出，不会自动重连；身份码仍可用于重新启动。\n\n可以写一句原因（会显示在它的终端里）：', { name: a.name, id: a.id }), '');
    if (note === null) return;
    try {
      await post(`/agents/${a.id}/kick`, { note });
      toast(t('已强制 {name} 下线', { name: a.name }));
      refresh();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  const toggleInvite = async (a: Agent) => {
    try {
      await patch(`/agents/${a.id}`, { can_invite: !a.can_invite });
      toast(t(a.can_invite ? msg('已取消 {name} 的邀请权限') : msg('{name} 现在可以为所在项目创建邀请'), { name: a.name }));
      refresh();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  return (
    <div>
      <div className="btn-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'nowrap', marginBottom: 14 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 className="page-title">Agent</h1>
          <p className="page-sub" style={{ margin: 0 }}>
            {t('每个 agent 用自己的身份码连接，每次连接换一个授权 ID，同一身份同时只能在一处在线。在线：保持着实时连接（如值守进程）；活跃：10 分钟内有请求；空闲：还没超时；离线：没有有效的授权 ID（值守断线超过 2 分钟、长时间没有请求、正常退出或被强制下线）。下线和重新上线都会通知你。')}
          </p>
        </div>
        <button className="btn primary" style={{ flexShrink: 0 }} onClick={() => setInviting(true)}>
          {t('新建 Agent')}
        </button>
      </div>
      {inviting && <NewAgentDialog onClose={closeInvite} />}
      {(
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          {list.length === 0 ? (
            <div className="empty">{t('还没有 agent 加入')}</div>
          ) : (
            <div className="table-wrap">
            <table className="table stack">
              <thead>
                <tr>
                  <th>{t('状态')}</th>
                  <th>{t('名称')}</th>
                  <th>{t('平台 / 接入')}</th>
                  <th>{t('项目与标签')}</th>
                  <th>{t('进行中')}</th>
                  <th>{t('值守')}</th>
                  <th>{t('最后出现')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((a) => {
                  const p = presence(a);
                  return (
                    <tr key={a.id} style={{ opacity: a.status === 'active' ? 1 : 0.55 }}>
                      <td data-label={t('状态')}>
                        <span className="btn-row" style={{ gap: 6 }}>
                          <span className={`dot ${p}`} />
                          {a.status !== 'active' ? t('已停用') : a.pending ? t('未连接过') : presenceLabel(p)}
                        </span>
                        {a.connection && (
                          <div className="faint" style={{ maxWidth: 220 }} title={`${a.connection.cwd}\n${t('授权 ID {id}…，{time} 上线', { id: a.connection.id, time: dateTime(a.connection.created_at) })}`}>
                            {where(a.connection)}
                          </div>
                        )}
                        {a.activity && (
                          <div className="faint" style={{ maxWidth: 220 }} title={a.activity.note}>
                            {t('正在处理：{note}', { note: a.activity.note })}
                          </div>
                        )}
                      </td>
                      <td data-label={t('名称')}>
                        <b>{a.name || t('（待命名）')}</b>
                        <div className="faint">{a.id}</div>
                      </td>
                      <td data-label={t('平台 / 接入')}>
                        {platformLabel(a.platform)}
                        <div className="faint">
                          {a.tier} {t(TIER[a.tier] ?? '')}
                        </div>
                      </td>
                      <td data-label={t('项目与标签')}>
                        {a.projects.map((pr) => (
                          <div key={pr.id}>
                            {pr.id} {pr.tags.length > 0 && <span className="faint">· {pr.tags.join('、')}</span>}
                          </div>
                        ))}
                      </td>
                      <td data-label={t('进行中')}>
                        {a.active_tasks.length === 0 && <span className="faint">—</span>}
                        {a.active_tasks.map((t) => (
                          <a key={t} href="#" style={{ marginRight: 6 }} onClick={(e) => (e.preventDefault(), openTask(t))}>
                            {t}
                          </a>
                        ))}
                      </td>
                      <td data-label={t('值守')}>
                        {(() => {
                          const d = daemonState(a);
                          return <span className={`badge ${d.cls}`}>{d.text}</span>;
                        })()}
                        <div className="btn-row" style={{ gap: 4, marginTop: 6 }}>
                          {a.daemon_paused ? (
                            <button className="btn small" onClick={() => daemon(a, 'resume')}>
                              {t('恢复')}
                            </button>
                          ) : (
                            a.daemon && (
                              <>
                                <button className="btn small" onClick={() => daemon(a, 'pause')}>
                                  {t('暂停')}
                                </button>
                                <button className="btn small" disabled={!!a.activity} onClick={() => daemon(a, 'wake')} title={t('让它立即检查一遍收件箱和手上的任务')}>
                                  {t('唤醒')}
                                </button>
                              </>
                            )
                          )}
                          <button className="btn small" onClick={() => setRunsOf(a)}>
                            {t('记录')}
                          </button>
                        </div>
                      </td>
                      <td className="faint" data-label={t('最后出现')}>{timeAgo(a.last_seen_at)}</td>
                      <td className="stack-actions">
                        <div className="btn-row">
                          {a.status === 'active' && (
                            <button className="btn small" title={t('身份码、值守命令和接入提示词；换机器、重启都用同一个身份码')} onClick={() => setLaunchOf(a)}>
                              {t('启动')}
                            </button>
                          )}
                          {a.connection && (
                            <button className="btn small danger" title={t('吊销当前授权 ID，值守进程立即退出')} onClick={() => kick(a)}>
                              {t('强制下线')}
                            </button>
                          )}
                          <button className="btn small" title={t('最近 20 次连接：在哪上线、何时因何下线')} onClick={() => setSessionsOf(a)}>
                            {t('连接记录')}
                          </button>
                          {a.status === 'active' && (
                            <button className="btn small" onClick={() => setJoinOf(a)}>
                              {t('加入项目')}
                            </button>
                          )}
                          <button className="btn small" onClick={() => toggle(a)}>
                            {a.status === 'active' ? t('停用') : t('启用')}
                          </button>
                          {a.status === 'disabled' && (
                            <button className="btn small danger" onClick={() => remove(a)}>
                              {t('删除')}
                            </button>
                          )}
                          <button
                            className={`btn small ${a.can_invite ? 'primary' : ''}`}
                            aria-pressed={a.can_invite}
                            title={t('允许它在找不到合适的 agent 时新建一个待启动的身份，并 @你 去控制台拉起')}
                            onClick={() => toggleInvite(a)}
                          >
                            {a.can_invite ? t('可邀请 ✓') : t('允许邀请')}
                          </button>

                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          )}
        </div>
      )}
      {launchOf && <LaunchDialog agent={launchOf} onClose={() => setLaunchOf(null)} />}
      {runsOf && <RunsDialog agent={runsOf} onClose={() => setRunsOf(null)} />}
      {sessionsOf && <SessionsDialog agent={sessionsOf} onClose={() => setSessionsOf(null)} />}
      {joinOf && <JoinProjectDialog agent={joinOf} onClose={() => setJoinOf(null)} />}
    </div>
  );
}

function RunsDialog({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const { data: runs } = useData(() => get<Run[]>(`/agents/${agent.id}/runs`), [agent.id]);
  return (
    <Modal title={t('{name} 的值守运行记录', { name: agent.name })} onClose={onClose}>
      {!agent.daemon && (
        <p className="faint" style={{ marginTop: 0 }}>
          {t('值守进程未运行。点「启动」复制值守命令，在 agent 所在机器上运行即可开启。')}
        </p>
      )}
      {runs && runs.length === 0 && <div className="empty">{t('还没有运行记录')}</div>}
      <div className="list runs-list">
        {runs?.map((r) => (
          <div key={r.id} className="list-item">
            <span className={`badge ${r.code === 0 ? 'good' : 'bad'}`}>{r.code === 0 ? t('成功') : r.code === null ? t('中断') : t('退出码 {code}', { code: r.code })}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="faint">
                {dateTime(r.started_at)} · {t('用时 {d}', { d: duration(r) })} · {r.harness}
              </div>
              <div>{t('唤起原因：{why}', { why: r.trigger || '—' })}</div>
              {r.session && <div className="faint">{t('会话：{id}', { id: r.session })}</div>}
              {r.summary && <div className="prose faint run-summary">{r.summary}</div>}
            </div>
          </div>
        ))}
      </div>
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn" onClick={onClose}>
          {t('关闭')}
        </button>
      </div>
    </Modal>
  );
}

function SessionsDialog({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const { data: list } = useData(() => get<Connection[]>(`/agents/${agent.id}/sessions`), [agent.id]);
  return (
    <Modal title={t('{name} 的连接记录', { name: agent.name || agent.id })} onClose={onClose}>
      <p className="faint" style={{ marginTop: 0 }}>
        {t('每次连接（值守启动、MCP 桥启动、命令行第一次调用）用身份码换一个授权 ID，同一时间只有一个有效。')}
      </p>
      {list && list.length === 0 && <div className="empty">{t('还没有连接过')}</div>}
      <div className="list runs-list">
        {list?.map((c) => (
          <div key={c.id + c.created_at} className="list-item">
            <span className={`badge ${c.ended_at ? (c.end_reason === 'revoked' || c.end_reason === 'replaced' ? 'warn' : '') : 'good'}`}>{c.ended_at ? t(END_REASON[c.end_reason ?? ''] ?? msg('已结束')) : t('在线')}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div>{where(c) || '—'}</div>
              <div className="faint">
                {t('{time} 上线', { time: dateTime(c.created_at) })} · {t('最后活动 {time}', { time: timeAgo(c.last_seen_at) })}
                {c.ended_at ? ` · ${t('{time} 下线', { time: dateTime(c.ended_at) })}` : ''}
              </div>
              {c.cwd && <div className="faint">{t('目录：{dir}', { dir: c.cwd })}</div>}
              {c.end_note && <div className="faint">{t(c.end_reason === 'replaced' ? msg('新连接：{note}') : msg('原因：{note}'), { note: c.end_note })}</div>}
              <div className="faint">
                {t('授权 ID {id}…', { id: c.id })} · {c.ip}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn" onClick={onClose}>
          {t('关闭')}
        </button>
      </div>
    </Modal>
  );
}

function JoinProjectDialog({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const { projects, toast, refresh } = useHub();
  const options = projects.filter((p) => p.status === 'active' && !agent.projects.some((x) => x.id === p.id));
  const [target, setTarget] = useState(options[0]?.id ?? '');
  const [tags, setTags] = useState('');
  const save = async () => {
    try {
      await post(`/agents/${agent.id}/projects`, { project: target, tags: splitList(tags) });
      toast(t('已把 {name} 加入 {project}', { name: agent.name || agent.id, project: target }));
      refresh();
      onClose();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };
  return (
    <Modal title={t('把 {name} 加入项目', { name: agent.name || agent.id })} onClose={onClose}>
      {options.length === 0 ? (
        <p className="muted">{t('它已经在所有进行中的项目里了。')}</p>
      ) : (
        <>
          <div className="field">
            <label htmlFor="jp-project">{t('项目')}</label>
            <select id="jp-project" className="select" value={target} onChange={(e) => setTarget(e.target.value)}>
              {options.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id} · {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="jp-tags">{t('在这个项目里的能力标签')}</label>
            <input id="jp-tags" className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder={t('如：前端, 审核')} />
          </div>
        </>
      )}
      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>
          {t('取消')}
        </button>
        {options.length > 0 && (
          <button className="btn primary" onClick={save}>
            {t('加入')}
          </button>
        )}
      </div>
    </Modal>
  );
}
