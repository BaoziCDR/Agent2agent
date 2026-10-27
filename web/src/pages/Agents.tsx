import { useState } from 'react';
import { type Agent, type Connection, del, get, patch, post, type Run } from '../api';
import { LaunchDialog, NewAgentDialog } from './Invite';
import { Modal, PLATFORM_LABEL, PRESENCE_LABEL, dateTime, presence, splitList, timeAgo, useData, useHub } from '../ui';

const END_REASON: Record<string, string> = { released: '正常退出', expired: '超时自动下线', replaced: '被别处的新连接顶掉', revoked: '被强制下线' };
const where = (c: Connection) => [c.host, c.client_label].filter(Boolean).join(' · ');

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
    if (!confirm(`删除 ${a.name}（${a.id}）？\n它的身份码永久失效，不再出现在成员列表里；做过的任务、评论和交付物都保留，仍显示它的名字。${tasks}`)) return;
    try {
      const r = await del<{ released: string[] }>(`/agents/${a.id}`);
      toast(`已删除 ${a.name}${r.released.length ? `，${r.released.join('、')} 已放回任务池` : ''}`);
      refresh();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  const kick = async (a: Agent) => {
    const note = prompt(`强制 ${a.name}（${a.id}）下线？\n它当前的授权 ID 立即失效，值守进程会停下正在跑的 harness 并退出，不会自动重连；身份码仍可用于重新启动。\n\n可以写一句原因（会显示在它的终端里）：`, '');
    if (note === null) return;
    try {
      await post(`/agents/${a.id}/kick`, { note });
      toast(`已强制 ${a.name} 下线`);
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
            每个 agent 用自己的身份码连接，每次连接换一个授权 ID，同一身份同时只能在一处在线。在线：保持着实时连接（如值守进程）；活跃：10 分钟内有请求；空闲：还没超时；离线：没有有效的授权 ID（值守断线超过 2 分钟、长时间没有请求、正常退出或被强制下线）。下线和重新上线都会通知你。
          </p>
        </div>
        <button className="btn primary" style={{ flexShrink: 0 }} onClick={() => setInviting(true)}>
          新建 Agent
        </button>
      </div>
      {inviting && <NewAgentDialog onClose={closeInvite} />}
      {(
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
                          {a.status !== 'active' ? '已停用' : a.pending ? '未连接过' : PRESENCE_LABEL[p]}
                        </span>
                        {a.connection && (
                          <div className="faint" style={{ maxWidth: 220 }} title={`${a.connection.cwd}\n授权 ID ${a.connection.id}…，${dateTime(a.connection.created_at)} 上线`}>
                            {where(a.connection)}
                          </div>
                        )}
                        {a.activity && (
                          <div className="faint" style={{ maxWidth: 220 }} title={a.activity.note}>
                            正在处理：{a.activity.note}
                          </div>
                        )}
                      </td>
                      <td>
                        <b>{a.name || '（待命名）'}</b>
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
                            <button className="btn small" title="身份码、值守命令和接入提示词；换机器、重启都用同一个身份码" onClick={() => setLaunchOf(a)}>
                              启动
                            </button>
                          )}
                          {a.connection && (
                            <button className="btn small danger" title="吊销当前授权 ID，值守进程立即退出" onClick={() => kick(a)}>
                              强制下线
                            </button>
                          )}
                          <button className="btn small" title="最近 20 次连接：在哪上线、何时因何下线" onClick={() => setSessionsOf(a)}>
                            连接记录
                          </button>
                          {a.status === 'active' && (
                            <button className="btn small" onClick={() => setJoinOf(a)}>
                              加入项目
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
                            title="允许它在找不到合适的 agent 时新建一个待启动的身份，并 @你 去控制台拉起"
                            onClick={() => toggleInvite(a)}
                          >
                            {a.can_invite ? '可邀请 ✓' : '允许邀请'}
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
    <Modal title={`${agent.name} 的值守运行记录`} onClose={onClose}>
      {!agent.daemon && (
        <p className="faint" style={{ marginTop: 0 }}>
          值守进程未运行。点「启动」复制值守命令，在 agent 所在机器上运行即可开启。
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

function SessionsDialog({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const { data: list } = useData(() => get<Connection[]>(`/agents/${agent.id}/sessions`), [agent.id]);
  return (
    <Modal title={`${agent.name || agent.id} 的连接记录`} onClose={onClose}>
      <p className="faint" style={{ marginTop: 0 }}>
        每次连接（值守启动、MCP 桥启动、命令行第一次调用）用身份码换一个授权 ID，同一时间只有一个有效。
      </p>
      {list && list.length === 0 && <div className="empty">还没有连接过</div>}
      <div className="list runs-list">
        {list?.map((c) => (
          <div key={c.id + c.created_at} className="list-item">
            <span className={`badge ${c.ended_at ? (c.end_reason === 'revoked' || c.end_reason === 'replaced' ? 'warn' : '') : 'good'}`}>{c.ended_at ? END_REASON[c.end_reason ?? ''] ?? '已结束' : '在线'}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div>{where(c) || '—'}</div>
              <div className="faint">
                {dateTime(c.created_at)} 上线 · 最后活动 {timeAgo(c.last_seen_at)}
                {c.ended_at ? ` · ${dateTime(c.ended_at)} 下线` : ''}
              </div>
              {c.cwd && <div className="faint">目录：{c.cwd}</div>}
              {c.end_note && <div className="faint">{c.end_reason === 'replaced' ? `新连接：${c.end_note}` : `原因：${c.end_note}`}</div>}
              <div className="faint">
                授权 ID {c.id}… · {c.ip}
              </div>
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

function JoinProjectDialog({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const { projects, toast, refresh } = useHub();
  const options = projects.filter((p) => p.status === 'active' && !agent.projects.some((x) => x.id === p.id));
  const [target, setTarget] = useState(options[0]?.id ?? '');
  const [tags, setTags] = useState('');
  const save = async () => {
    try {
      await post(`/agents/${agent.id}/projects`, { project: target, tags: splitList(tags) });
      toast(`已把 ${agent.name || agent.id} 加入 ${target}`);
      refresh();
      onClose();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };
  return (
    <Modal title={`把 ${agent.name || agent.id} 加入项目`} onClose={onClose}>
      {options.length === 0 ? (
        <p className="muted">它已经在所有进行中的项目里了。</p>
      ) : (
        <>
          <div className="field">
            <label htmlFor="jp-project">项目</label>
            <select id="jp-project" className="select" value={target} onChange={(e) => setTarget(e.target.value)}>
              {options.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id} · {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="jp-tags">在这个项目里的能力标签</label>
            <input id="jp-tags" className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="如：前端, 审核" />
          </div>
        </>
      )}
      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>
          取消
        </button>
        {options.length > 0 && (
          <button className="btn primary" onClick={save}>
            加入
          </button>
        )}
      </div>
    </Modal>
  );
}
