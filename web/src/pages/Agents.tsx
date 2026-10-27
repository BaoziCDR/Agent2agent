import { useState } from 'react';
import { type Agent, del, get, patch, post, type Run } from '../api';
import { InviteDialog, InviteList, RestartDialog } from './Invite';
import { CodeBox, Modal, PLATFORM_LABEL, PRESENCE_LABEL, dateTime, presence, timeAgo, useData, useHub } from '../ui';

const duration = (r: Run) => {
  const s = Math.max(0, Math.round((Date.parse(r.ended_at) - Date.parse(r.started_at)) / 1000));
  return s < 60 ? `${s} 秒` : s < 3600 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
};

function daemonState(a: Agent): { text: string; cls: string } {
  if (a.daemon_paused) return { text: a.daemon ? '已暂停' : '已暂停（未运行）', cls: 'warn' };
  if (!a.daemon) return a.resident ? { text: '常驻等待', cls: 'good' } : { text: '未运行', cls: '' };
  return a.activity ? { text: '处理中', cls: 'accent' } : { text: '值守中', cls: 'good' };
}

const TIER: Record<string, string> = { L1: '命令行/实时', L2: 'MCP', L3: 'HTTP 轮询', L4: '人工中继' };

export function Agents({ startInvite = false }: { startInvite?: boolean }) {
  const { agents, project, toast, refresh, openTask, go } = useHub();
  const [token, setToken] = useState<{ agent: Agent; token: string } | null>(null);
  const [runsOf, setRunsOf] = useState<Agent | null>(null);
  const [restartOf, setRestartOf] = useState<Agent | null>(null);
  const [tab, setTab] = useState<'members' | 'invites'>('members');
  const [inviting, setInviting] = useState(startInvite);
  const [inviteVersion, setInviteVersion] = useState(0);
  const closeInvite = () => {
    setInviting(false);
    if (startInvite) go('agents'); // 从旧地址 #/invite 进来的，关掉后回到 Agent 页
  };

  const daemon = async (a: Agent, action: 'pause' | 'resume' | 'wake') => {
    try {
      await post(`/agents/${a.id}/daemon`, { action });
      toast({ pause: `已暂停 ${a.name} 的值守`, resume: `已恢复 ${a.name} 的值守`, wake: `已让 ${a.name} 立即检查` }[action]);
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
      toast(a.status === 'active' ? `已停用 ${a.name}` : `已启用 ${a.name}`);
      refresh();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  const remove = async (a: Agent) => {
    const tasks = a.active_tasks.length ? `\n它手上的 ${a.active_tasks.join('、')} 中未提交的会放回任务池。` : '';
    if (!confirm(`删除 ${a.name}（${a.id}）？\n它的令牌永久失效，不再出现在成员列表里；做过的任务、评论和交付物都保留，仍显示它的名字。${tasks}`)) return;
    try {
      const r = await del<{ released: string[] }>(`/agents/${a.id}`);
      toast(`已删除 ${a.name}${r.released.length ? `，${r.released.join('、')} 已放回任务池` : ''}`);
      refresh();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  const toggleInvite = async (a: Agent) => {
    try {
      await patch(`/agents/${a.id}`, { can_invite: !a.can_invite });
      toast(a.can_invite ? `已取消 ${a.name} 的邀请权限` : `${a.name} 现在可以为所在项目创建邀请`);
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
            在线：保持着实时连接（如值守进程）；活跃：10 分钟内有请求；空闲：2 小时内出现过；离线：更久没出现，或值守进程断线超过 2 分钟。下线和重新上线都会通知你。值守列可以暂停、恢复或立即唤醒 ahub run，并查看每次运行的记录。
          </p>
        </div>
        <button className="btn primary" style={{ flexShrink: 0 }} onClick={() => setInviting(true)}>
          邀请 Agent
        </button>
      </div>
      <div className="tabs">
        <button className={`tab ${tab === 'members' ? 'active' : ''}`} onClick={() => setTab('members')}>
          成员 <span className="faint">{list.length}</span>
        </button>
        <button className={`tab ${tab === 'invites' ? 'active' : ''}`} onClick={() => setTab('invites')}>
          邀请码记录
        </button>
      </div>
      {inviting && (
        <InviteDialog
          onClose={closeInvite}
          onCreated={() => {
            setInviteVersion((v) => v + 1);
            setTab('invites');
          }}
        />
      )}
      {tab === 'invites' && <InviteList version={inviteVersion} />}
      {tab === 'members' && (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          {list.length === 0 ? (
            <div className="empty">还没有 agent 加入</div>
          ) : (
            <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>状态</th>
                  <th>名称</th>
                  <th>平台 / 接入</th>
                  <th>项目与标签</th>
                  <th>进行中</th>
                  <th>值守</th>
                  <th>最后出现</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((a) => {
                  const p = presence(a);
                  return (
                    <tr key={a.id} style={{ opacity: a.status === 'active' ? 1 : 0.55 }}>
                      <td>
                        <span className="btn-row" style={{ gap: 6 }}>
                          <span className={`dot ${p}`} />
                          {a.status === 'active' ? PRESENCE_LABEL[p] : '已停用'}
                        </span>
                        {a.activity && (
                          <div className="faint" style={{ maxWidth: 220 }} title={a.activity.note}>
                            正在处理：{a.activity.note}
                          </div>
                        )}
                      </td>
                      <td>
                        <b>{a.name}</b>
                        <div className="faint">{a.id}</div>
                      </td>
                      <td>
                        {PLATFORM_LABEL[a.platform] ?? a.platform}
                        <div className="faint">
                          {a.tier} {TIER[a.tier]}
                        </div>
                      </td>
                      <td>
                        {a.projects.map((pr) => (
                          <div key={pr.id}>
                            {pr.id} {pr.tags.length > 0 && <span className="faint">· {pr.tags.join('、')}</span>}
                          </div>
                        ))}
                      </td>
                      <td>
                        {a.active_tasks.length === 0 && <span className="faint">—</span>}
                        {a.active_tasks.map((t) => (
                          <a key={t} href="#" style={{ marginRight: 6 }} onClick={(e) => (e.preventDefault(), openTask(t))}>
                            {t}
                          </a>
                        ))}
                      </td>
                      <td>
                        {(() => {
                          const d = daemonState(a);
                          return <span className={`badge ${d.cls}`}>{d.text}</span>;
                        })()}
                        <div className="btn-row" style={{ gap: 4, marginTop: 6 }}>
                          {a.daemon_paused ? (
                            <button className="btn small" onClick={() => daemon(a, 'resume')}>
                              恢复
                            </button>
                          ) : (
                            a.daemon && (
                              <>
                                <button className="btn small" onClick={() => daemon(a, 'pause')}>
                                  暂停
                                </button>
                                <button className="btn small" disabled={!!a.activity} onClick={() => daemon(a, 'wake')} title="让它立即检查一遍收件箱和手上的任务">
                                  唤醒
                                </button>
                              </>
                            )
                          )}
                          <button className="btn small" onClick={() => setRunsOf(a)}>
                            记录
                          </button>
                        </div>
                      </td>
                      <td className="faint">{timeAgo(a.last_seen_at)}</td>
                      <td>
                        <div className="btn-row">
                          {a.status === 'active' && (
                            <button className="btn small" title="关掉后重新启动：续用已有身份的提示词和值守命令" onClick={() => setRestartOf(a)}>
                              提示词
                            </button>
                          )}
                          <button className="btn small" onClick={() => toggle(a)}>
                            {a.status === 'active' ? '停用' : '启用'}
                          </button>
                          {a.status === 'disabled' && (
                            <button className="btn small danger" onClick={() => remove(a)}>
                              删除
                            </button>
                          )}
                          <button
                            className={`btn small ${a.can_invite ? 'primary' : ''}`}
                            aria-pressed={a.can_invite}
                            title="允许它在找不到合适的 agent 时创建一次性邀请，并 @你 去运行新 agent"
                            onClick={() => toggleInvite(a)}
                          >
                            {a.can_invite ? '可邀请 ✓' : '允许邀请'}
                          </button>
                          <button
                            className="btn small"
                            onClick={async () => {
                              if (!confirm(`重置 ${a.name} 的令牌？旧令牌会立即失效。`)) return;
                              try {
                                const r = await post<{ token: string }>(`/agents/${a.id}/reset-token`);
                                setToken({ agent: a, token: r.token });
                              } catch (err) {
                                toast((err as Error).message, true);
                              }
                            }}
                          >
                            重置令牌
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
      {restartOf && <RestartDialog agent={restartOf} onClose={() => setRestartOf(null)} />}
      {runsOf && <RunsDialog agent={runsOf} onClose={() => setRunsOf(null)} />}
      {token && (
        <Modal title={`${token.agent.name} 的新令牌`} onClose={() => setToken(null)}>
          <p className="muted">把新令牌交给这个 agent，让它更新 .ahub/config.json 里的 token 字段。关闭后不会再显示。</p>
          <CodeBox text={token.token} />
          <div className="btn-row" style={{ marginTop: 12 }}>
            <button className="btn" onClick={() => setToken(null)}>
              关闭
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function RunsDialog({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const { data: runs } = useData(() => get<Run[]>(`/agents/${agent.id}/runs`), [agent.id]);
  return (
    <Modal title={`${agent.name} 的值守运行记录`} onClose={onClose}>
      {!agent.daemon && (
        <p className="faint" style={{ marginTop: 0 }}>
          值守进程未运行。在 agent 的工作目录运行 <code>ahub run --harness codex</code>（或 claude）即可开启。
        </p>
      )}
      {runs && runs.length === 0 && <div className="empty">还没有运行记录</div>}
      <div className="list runs-list">
        {runs?.map((r) => (
          <div key={r.id} className="list-item">
            <span className={`badge ${r.code === 0 ? 'good' : 'bad'}`}>{r.code === 0 ? '成功' : r.code === null ? '中断' : `退出码 ${r.code}`}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="faint">
                {dateTime(r.started_at)} · 用时 {duration(r)} · {r.harness}
              </div>
              <div>唤起原因：{r.trigger || '—'}</div>
              {r.session && <div className="faint">会话：{r.session}</div>}
              {r.summary && <div className="prose faint run-summary">{r.summary}</div>}
            </div>
          </div>
        ))}
      </div>
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn" onClick={onClose}>
          关闭
        </button>
      </div>
    </Modal>
  );
}
