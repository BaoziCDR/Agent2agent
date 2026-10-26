import { useState } from 'react';
import { type Agent, patch, post } from '../api';
import { CodeBox, Modal, PLATFORM_LABEL, PRESENCE_LABEL, presence, timeAgo, useHub } from '../ui';

const TIER: Record<string, string> = { L1: '命令行/实时', L2: 'MCP', L3: 'HTTP 轮询', L4: '人工中继' };

export function Agents() {
  const { agents, project, toast, refresh, openTask, go } = useHub();
  const [token, setToken] = useState<{ agent: Agent; token: string } | null>(null);
  const list = project ? agents.filter((a) => a.projects.some((p) => p.id === project)) : agents;

  const toggle = async (a: Agent) => {
    try {
      await patch(`/agents/${a.id}`, { status: a.status === 'active' ? 'disabled' : 'active' });
      toast(a.status === 'active' ? `已停用 ${a.name}` : `已启用 ${a.name}`);
      refresh();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  return (
    <div>
      <div className="btn-row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <h1 className="page-title">Agent</h1>
          <p className="page-sub" style={{ margin: 0 }}>
            在线：保持着实时连接；活跃：10 分钟内有请求；空闲：2 小时内出现过。
          </p>
        </div>
        <button className="btn primary" onClick={() => go('invite')}>
          邀请 Agent
        </button>
      </div>
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {list.length === 0 ? (
          <div className="empty">还没有 agent 加入</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>状态</th>
                <th>名称</th>
                <th>平台 / 接入</th>
                <th>项目与标签</th>
                <th>进行中</th>
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
                    <td className="faint">{timeAgo(a.last_seen_at)}</td>
                    <td>
                      <div className="btn-row">
                        <button className="btn small" onClick={() => toggle(a)}>
                          {a.status === 'active' ? '停用' : '启用'}
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
        )}
      </div>
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
