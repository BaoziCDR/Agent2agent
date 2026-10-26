import { useEffect, useState } from 'react';
import { del, get, type Invite as InviteData, post } from '../api';
import { CodeBox, clock, splitList, useData, useHub } from '../ui';

const INSTALL = 'npm install -g github:BaoziCDR/Agent2agent';

function harnessPrompt(hub: string, code: string, platform: string, example: string, tags: string[]) {
  return `请加入我的多 Agent 协作中枢（Hub），按它的规则领取任务、汇报进度、和其他 agent 协作。

1. 先阅读接入说明：${hub}/skill.md
   （不能直接打开网址的话，运行 curl -s ${hub}/skill.md）
2. 安装命令行工具 ahub（已安装可跳过）：
   ${INSTALL}
3. 在当前工作目录加入项目（名字自己起，简短、能区分）：
   ahub join --hub ${hub} --invite ${code} --name "${example}" --platform ${platform}${tags.length ? ` --tags ${tags.join(',')}` : ''}
4. 运行 ahub inbox 同步收件箱，然后按接入说明里的「每轮工作循环」工作：
   每轮开始先 ahub inbox；只做已领取或已接受的任务；每轮结束前 ahub progress 上报进度和工作笔记。
`;
}

function chatPrompt(hub: string, code: string) {
  return `请加入我的多 Agent 协作中枢（Hub）。接入说明在：${hub}/skill.md

邀请码：${code}

如果你能执行命令或发 HTTP 请求，按接入说明加入并工作；
加入：POST ${hub}/api/v1/join，JSON：{"invite":"${code}","name":"<你的名字>","platform":"<平台>","tier":"L1"}
之后每一轮先 GET ${hub}/api/v1/inbox?format=md（请求头 Authorization: Bearer <令牌>）同步任务。
`;
}

export function Invite() {
  const { projects, project, toast } = useHub();
  const active = projects.filter((p) => p.status === 'active');
  const [targetChoice, setTarget] = useState('');
  const target = targetChoice || (project ?? active[0]?.id ?? '');
  const [tags, setTags] = useState('');
  const [uses, setUses] = useState(1);
  const [hours, setHours] = useState(24);
  const [note, setNote] = useState('');
  const [created, setCreated] = useState<InviteData | null>(null);
  const [tab, setTab] = useState<'codex' | 'claude' | 'mcp' | 'other'>('codex');
  const { data: info } = useData(() => get<{ urls: string[] }>('/info'), []);
  const [hub, setHub] = useState('');
  const { data: invites, reload } = useData(() => get<InviteData[]>(`/invites${project ? `?project=${project}` : ''}`), [project]);

  useEffect(() => {
    if (!hub && info) setHub(info.urls.find((u) => !u.includes('127.0.0.1')) ?? info.urls[0] ?? location.origin);
  }, [info, hub]);

  if (active.length === 0) return <p className="muted">请先在「项目」页创建一个项目。</p>;

  const create = async () => {
    try {
      const inv = await post<InviteData>('/invites', { project: target, tags: splitList(tags), max_uses: uses, hours, note });
      setCreated(inv);
      reload();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  const tagList = created?.tags ?? [];
  const prompts = created && {
    codex: harnessPrompt(hub, created.code, 'codex', 'Codex-后端', tagList),
    claude: harnessPrompt(hub, created.code, 'claude-code', 'Claude-前端', tagList),
    other: chatPrompt(hub, created.code),
  };

  return (
    <div style={{ maxWidth: 860 }}>
      <h1 className="page-title">邀请 Agent</h1>
      <p className="page-sub">生成邀请码，把接入提示词粘贴给 Codex、Claude Code 等 agent，它就会自己加入并开始工作。</p>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="field-row">
          <div className="field">
            <label htmlFor="iv-project">加入哪个项目</label>
            <select id="iv-project" className="select" value={target} onChange={(e) => setTarget(e.target.value)}>
              {active.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id} · {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="iv-tags">能力标签</label>
            <input id="iv-tags" className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="如：后端, 测试" />
          </div>
          <div className="field">
            <label htmlFor="iv-uses">可用次数</label>
            <input id="iv-uses" type="number" min={1} className="input" value={uses} onChange={(e) => setUses(Number(e.target.value) || 1)} />
          </div>
          <div className="field">
            <label htmlFor="iv-hours">有效期（小时）</label>
            <input id="iv-hours" type="number" min={1} className="input" value={hours} onChange={(e) => setHours(Number(e.target.value) || 24)} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="iv-note">备注</label>
          <input id="iv-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="如：给笔记本上的 Codex" />
        </div>
        <div className="field">
          <label htmlFor="iv-hub">Hub 地址（agent 能访问到的地址）</label>
          <input id="iv-hub" className="input" value={hub} onChange={(e) => setHub(e.target.value)} />
          {info && info.urls.length > 1 && <span className="hint">本机可用地址：{info.urls.join('  ')}。其他机器上的 agent 请用局域网地址。</span>}
        </div>
        <button className="btn primary" onClick={create}>
          生成邀请码
        </button>
      </div>

      {created && prompts && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="btn-row" style={{ justifyContent: 'space-between' }}>
            <div>
              <div className="faint">邀请码（{created.project}，可用 {created.max_uses} 次，{clock(created.expires_at)} 前有效）</div>
              <div className="invite-code">{created.code}</div>
            </div>
          </div>
          <div className="tabs" style={{ marginTop: 12 }}>
            <button className={`tab ${tab === 'codex' ? 'active' : ''}`} onClick={() => setTab('codex')}>
              Codex
            </button>
            <button className={`tab ${tab === 'claude' ? 'active' : ''}`} onClick={() => setTab('claude')}>
              Claude Code
            </button>
            <button className={`tab ${tab === 'mcp' ? 'active' : ''}`} onClick={() => setTab('mcp')}>
              MCP 配置（可选）
            </button>
            <button className={`tab ${tab === 'other' ? 'active' : ''}`} onClick={() => setTab('other')}>
              其他 agent
            </button>
          </div>
          {tab === 'codex' && <CodeBox text={prompts.codex} />}
          {tab === 'claude' && <CodeBox text={prompts.claude} />}
          {tab === 'other' && <CodeBox text={prompts.other} />}
          {tab === 'mcp' && (
            <div>
              <p className="muted" style={{ marginTop: 0 }}>
                agent 先用上面的提示词加入（会在工作目录生成 .ahub/config.json），再按下面配置 MCP，就能直接调用 hub_ 工具。
              </p>
              <div className="faint">Claude Code（在工作目录运行）</div>
              <CodeBox text="claude mcp add ahub -- ahub mcp" />
              <div className="faint" style={{ marginTop: 10 }}>
                Codex（~/.codex/config.toml）
              </div>
              <CodeBox text={'[mcp_servers.ahub]\ncommand = "ahub"\nargs = ["mcp"]'} />
              <div className="faint" style={{ marginTop: 10 }}>
                也可以直接连 HTTP 接口：{hub}/mcp（请求头 Authorization: Bearer &lt;agent 令牌&gt;）
              </div>
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h3>邀请码记录</h3>
        {invites && invites.length === 0 && <div className="empty">还没有邀请码</div>}
        {invites && invites.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>邀请码</th>
                <th>项目</th>
                <th>标签</th>
                <th>已用</th>
                <th>有效期至</th>
                <th>备注</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {invites.map((i) => (
                <tr key={i.code}>
                  <td>
                    <code>{i.code}</code> {!i.valid && <span className="badge">已失效</span>}
                  </td>
                  <td>{i.project}</td>
                  <td>{i.tags.join('、') || '—'}</td>
                  <td>
                    {i.uses} / {i.max_uses}
                  </td>
                  <td>{clock(i.expires_at)}</td>
                  <td>{i.note || '—'}</td>
                  <td>
                    {i.valid && (
                      <button
                        className="btn small danger"
                        onClick={async () => {
                          await del(`/invites/${i.code}`);
                          reload();
                        }}
                      >
                        撤销
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
