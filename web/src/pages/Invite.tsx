import { useEffect, useState } from 'react';
import { del, get, type Invite as InviteData, post } from '../api';
import { CodeBox, Modal, agentLabel, clock, splitList, useData, useHub } from '../ui';

function harnessPrompt(hub: string, code: string, platform: string, name: string, tags: string[]) {
  const dir = platform === 'codex' ? '.codex/skills/ahub-collab' : '.claude/skills/ahub-collab';
  const join = `ahub join --hub ${hub} --invite ${code} --name "${name || '<你的名字>'}" --platform ${platform}${tags.length ? ` --tags ${tags.join(',')}` : ''}`;
  return `请加入我的多 Agent 协作中枢（Hub），按它的规则领取任务、汇报进度、和其他 agent 协作。

1. 安装命令行工具 ahub（已安装可跳过；Hub 升级后重新运行一次即可更新）：
   npm install -g ${hub}/ahub.tgz
2. 在当前工作目录加入项目${name ? `（你的名字已经定好：${name}）` : '（把 <你的名字> 换成你自己起的名字：简短、能看出你的平台和分工）'}：
   ${join}
3. 阅读接入说明：优先使用本地已安装的 ahub-collab skill（${dir}/SKILL.md）；没有的话运行
   ahub skill install
   安装（skill 内置在 ahub 里，版本与 ahub 一致），然后阅读它。也可以用 ahub skill show 直接查看。
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

/** 「Agent」页里的「邀请 Agent」弹窗：先填表生成邀请码，再给出各平台的接入提示词。 */
export function InviteDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { projects, project, toast } = useHub();
  const active = projects.filter((p) => p.status === 'active');
  const [targetChoice, setTarget] = useState('');
  const target = targetChoice || (project ?? active[0]?.id ?? '');
  const [tags, setTags] = useState('');
  const [uses, setUses] = useState(1);
  const [hours, setHours] = useState(24);
  const [note, setNote] = useState('');
  const [name, setName] = useState('');
  const [created, setCreated] = useState<InviteData | null>(null);
  const [tab, setTab] = useState<'codex' | 'claude' | 'mcp' | 'other'>('codex');
  const { data: info } = useData(() => get<{ urls: string[] }>('/info'), []);
  const [hub, setHub] = useState('');

  useEffect(() => {
    if (!hub && info) setHub(info.urls.find((u) => !u.includes('127.0.0.1')) ?? info.urls[0] ?? location.origin);
  }, [info, hub]);

  if (active.length === 0)
    return (
      <Modal title="邀请 Agent" onClose={onClose}>
        <p className="muted">请先在「项目」页创建一个项目。</p>
      </Modal>
    );

  const create = async () => {
    try {
      const inv = await post<InviteData>('/invites', { project: target, tags: splitList(tags), max_uses: uses, hours, note, name: uses === 1 ? name : '' });
      setCreated(inv);
      onCreated();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  const tagList = created?.tags ?? [];
  const prompts = created && {
    codex: harnessPrompt(hub, created.code, 'codex', created.agent_name, tagList),
    claude: harnessPrompt(hub, created.code, 'claude-code', created.agent_name, tagList),
    other: chatPrompt(hub, created.code),
  };

  return (
    <Modal title={created ? '邀请码已生成' : '邀请 Agent'} onClose={onClose} wide>
      <p className="muted" style={{ marginTop: -6 }}>
        {created ? '把对应平台的提示词粘贴给 agent，它会自己安装 ahub、加入项目并开始工作。' : '生成邀请码，把接入提示词粘贴给 Codex、Claude Code 等 agent，它就会自己加入并开始工作。'}
      </p>
      {!created && (
        <div>
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
            <label htmlFor="iv-name">Agent 名称（可选）</label>
            <input
              id="iv-name"
              className="input"
              value={uses === 1 ? name : ''}
              disabled={uses !== 1}
              onChange={(e) => setName(e.target.value)}
              placeholder={uses === 1 ? '如：Claude-前端；不填就让 agent 自己起名' : '可用多次的邀请码由每个 agent 自己起名'}
            />
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
          <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={onClose}>
              取消
            </button>
            <button className="btn primary" onClick={create}>
              生成邀请码
            </button>
          </div>
        </div>
      )}
      {created && prompts && (
        <div>
          <div className="btn-row" style={{ justifyContent: 'space-between' }}>
            <div>
              <div className="faint">
                邀请码（{created.project}，可用 {created.max_uses} 次，{clock(created.expires_at)} 前有效{created.agent_name ? `，预设名称 ${created.agent_name}` : ''}）
              </div>
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
          <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
            <button className="btn" onClick={() => setCreated(null)}>
              再生成一个
            </button>
            <button className="btn primary" onClick={onClose}>
              完成
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** 邀请码记录：负责人生成的和授权 agent 创建的都在这里，可以撤销还有效的。 */
export function InviteList({ version }: { version: number }) {
  const { project, agents } = useHub();
  const { data: invites, reload } = useData(() => get<InviteData[]>(`/invites${project ? `?project=${project}` : ''}`), [project, version]);
  return (
    <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
      {invites && invites.length === 0 && <div className="empty">还没有邀请码，点右上角「邀请 Agent」生成一个</div>}
      {invites && invites.length > 0 && (
        <div className="table-wrap">
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
                <td>
                  {i.note || (i.agent_name ? '' : '—')}
                  {i.agent_name && <div className="faint">预设名称：{i.agent_name}</div>}
                  {i.created_by !== 'owner' && <div className="faint">由 {agentLabel(agents, i.created_by)} 创建</div>}
                </td>
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
        </div>
      )}
    </div>
  );
}
