import { useEffect, useState } from 'react';
import { type Agent, get, post } from '../api';
import { CodeBox, Modal, splitList, useData, useHub } from '../ui';

/** 一个 agent 身份：身份码可以反复使用，在哪台机器、哪个目录启动都用同一个。 */
type Identity = { code: string; agent: string; name: string; tags: string[] };

const skillDir = (platform: string) => (platform === 'codex' ? '~/.codex/skills/ahub-collab' : '~/.claude/skills/ahub-collab');

function harnessPrompt(hub: string, id: Identity, platform: string, resident = false) {
  const dir = skillDir(platform);
  const named = !!id.name;
  return `你是我的多 Agent 协作中枢（Hub）里的 agent ${named ? `${id.name}（${id.agent}）` : id.agent}，请按它的规则领取任务、汇报进度、和其他 agent 协作。

1. 安装或更新命令行工具 ahub（Hub 升级后重新运行一次即可更新）：
   npm install -g ${hub}/ahub.tgz
2. 用身份码连接 Hub（身份码可以反复使用，保存在用户目录，在哪个目录运行都一样）${named ? '' : '；把 <你的名字> 换成你自己起的名字：简短、能看出你的平台和分工'}：
   ahub join --hub ${hub} --code ${id.code}${named ? '' : ' --name "<你的名字>"'} --platform ${platform}
   提示「已经在线」时说明这个身份正在别处工作，停下来告诉我，不要加 --takeover。
3. 阅读接入说明：用户目录的 ahub-collab skill（${dir}/SKILL.md）；没有或版本旧时运行 ahub skill install 安装（内置在 ahub 里，版本一致）。也可以用 ahub skill show 直接查看。
4. 运行 ahub inbox 同步收件箱，然后按接入说明里的「每轮工作循环」工作：
   每轮开始先 ahub inbox；只做已领取或已接受的任务；每轮结束前 ahub progress 上报进度和工作笔记。
   手上已有进行中的任务时，先 ahub task <任务> 读工作笔记，从上次停下的地方接着做。
${
  resident
    ? `5. 常驻待命：这个会话要一直开着接任务。手上没有可做的事时，运行 ahub wait --resident 等待新事件（每次最多 9 分钟）：
   返回了收件箱就按第 4 步处理，处理完再回到等待；提示没有新事件就立即再运行一次，不用向我汇报。
   直到我让你停下为止（规则见 skill 里的「交互式会话里常驻待命」）。
`
    : ''
}`;
}

/** 在 agent 所在机器的终端直接运行：用身份码连接并进入值守，收到任务时自动唤起 harness。 */
function runCommand(hub: string, id: Identity, harness: 'codex' | 'claude', bypass: boolean) {
  const skip = !bypass ? '' : harness === 'claude' ? ' --harness-arg=--dangerously-skip-permissions' : ' --harness-arg=--dangerously-bypass-approvals-and-sandbox --harness-arg=--skip-git-repo-check';
  return `ahub run --harness ${harness} --hub ${hub} --code ${id.code}${id.name ? '' : ' --name "<名字>"'}${skip}`;
}

function chatPrompt(hub: string, id: Identity) {
  return `请加入我的多 Agent 协作中枢（Hub）。接入说明在：${hub}/skill.md

身份码：${id.code}

如果你能执行命令或发 HTTP 请求，按接入说明连接并工作：
连接：POST ${hub}/api/v1/sessions，JSON：{"code":"${id.code}"${id.name ? '' : ',"name":"<你的名字>"'},"client":"cli"}，返回的 session 就是授权 ID；
之后每一轮先 GET ${hub}/api/v1/inbox?format=md（请求头 Authorization: Bearer <授权 ID>）同步任务。授权 ID 过期了就再用身份码换一个。
`;
}

/** 默认给 agent 的 Hub 地址：优先局域网地址。 */
function useHubUrl() {
  const { data: info } = useData(() => get<{ urls: string[] }>('/info'), []);
  return {
    info,
    url: info ? (info.urls.find((u) => !u.includes('127.0.0.1')) ?? info.urls[0] ?? location.origin) : '',
  };
}

function Prompts({ hub, id, defaultTab = 'codex' }: { hub: string; id: Identity; defaultTab?: 'codex' | 'claude' }) {
  const [tab, setTab] = useState<'codex' | 'claude' | 'mcp' | 'other'>(defaultTab);
  const [bypass, setBypass] = useState(false);
  const [resident, setResident] = useState(false);
  const run = (harness: 'codex' | 'claude') => (
    <div style={{ marginTop: 14 }}>
      <div className="btn-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="faint">
          或者在 agent 所在机器的终端运行下面的命令：连接并开始值守，收到指派、@、私信时自动唤起 {harness === 'claude' ? 'Claude Code' : 'Codex'}。重启时再运行同一条命令即可
        </div>
        <label className="faint" style={{ display: 'flex', gap: 4, alignItems: 'center', whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={bypass} onChange={(e) => setBypass(e.target.checked)} /> 跳过权限确认
        </label>
      </div>
      <CodeBox text={runCommand(hub, id, harness, bypass)} />
      {bypass && <span className="hint">开启后 agent 执行命令、改文件都不再询问，只在你信任的工作目录里使用。</span>}
    </div>
  );
  return (
    <>
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
      {(tab === 'codex' || tab === 'claude') && (
        <div className="btn-row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <span className="faint">
            {resident
              ? '常驻待命：agent 在这个会话里一直等新任务，适合需要你开着的交互式会话（如 Mac 上用 computer use）'
              : '粘贴给 agent：它会自己安装 ahub、用身份码连接，做完手上的事就结束本轮'}
          </span>
          <label className="faint" style={{ display: 'flex', gap: 4, alignItems: 'center', whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={resident} onChange={(e) => setResident(e.target.checked)} /> 常驻待命
          </label>
        </div>
      )}
      {tab === 'codex' && (
        <>
          <CodeBox text={harnessPrompt(hub, id, 'codex', resident)} />
          {run('codex')}
        </>
      )}
      {tab === 'claude' && (
        <>
          <CodeBox text={harnessPrompt(hub, id, 'claude-code', resident)} />
          {run('claude')}
        </>
      )}
      {tab === 'other' && <CodeBox text={chatPrompt(hub, id)} />}
      {tab === 'mcp' && (
        <div>
          <p className="muted" style={{ marginTop: 0 }}>
            按下面配置 MCP，agent 就能直接调用 hub_ 工具；MCP 桥会自己用身份码换授权 ID。已经配置过的不用重复配置。
          </p>
          <div className="faint">Claude Code</div>
          <CodeBox text={`claude mcp add --scope user ahub -- ahub mcp --hub ${hub} --code ${id.code}`} />
          <div className="faint" style={{ marginTop: 10 }}>
            Codex（~/.codex/config.toml）
          </div>
          <CodeBox text={`[mcp_servers.ahub]\ncommand = "ahub"\nargs = ["mcp", "--hub", "${hub}", "--code", "${id.code}"]`} />
          <div className="faint" style={{ marginTop: 10 }}>
            也可以直接连 HTTP 接口：{hub}/mcp（请求头 Authorization: Bearer &lt;授权 ID&gt;，授权 ID 先用身份码换取）
          </div>
        </div>
      )}
    </>
  );
}

/** 身份码一行：默认遮住，点击显示 */
function CodeLine({ code }: { code: string }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="btn-row" style={{ alignItems: 'center' }}>
      <div className="invite-code">{shown ? code : code.replace(/[A-Z0-9]/g, '•')}</div>
      <button className="btn small" onClick={() => setShown((s) => !s)}>
        {shown ? '隐藏' : '显示'}
      </button>
    </div>
  );
}

/** 某个 agent 的身份码和启动命令：新建后、重置后、重新启动时都用这个 */
export function LaunchDialog({ agent, code: given, title, onClose }: { agent: Agent; code?: string; title?: string; onClose: () => void }) {
  const { toast, refresh } = useHub();
  const { url } = useHubUrl();
  const [hub, setHub] = useState('');
  const [code, setCode] = useState<string | null | undefined>(given);
  useEffect(() => {
    if (!hub && url) setHub(url);
  }, [url, hub]);
  useEffect(() => {
    if (given) return;
    get<{ code: string | null }>(`/agents/${agent.id}/code`)
      .then((r) => setCode(r.code))
      .catch((err) => toast((err as Error).message, true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id, given]);
  const reset = async () => {
    if (!confirm(`给 ${agent.name || agent.id} 生成新的身份码？旧身份码立即作废，当前连接会被强制下线。`)) return;
    try {
      setCode((await post<{ code: string }>(`/agents/${agent.id}/reset-code`)).code);
      refresh();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };
  const id: Identity | null = code ? { code, agent: agent.id, name: agent.name, tags: agent.projects[0]?.tags ?? [] } : null;
  return (
    <Modal title={title ?? `启动 ${agent.name || agent.id}`} onClose={onClose} wide>
      <p className="muted" style={{ marginTop: -6 }}>
        身份码可以反复使用：换机器、换目录、关掉后重启都用同一条命令。同一身份同时只能在一处在线；要换地方先在这里强制下线，或在新地方加 --takeover。
      </p>
      {code === null && (
        <div>
          <p className="muted">这个身份是旧版本创建的，控制台没有保存它的身份码；它原来那台机器上保存的仍然可以用。要在别处启动，先生成新的身份码。</p>
          <button className="btn primary" onClick={reset}>
            生成新的身份码
          </button>
        </div>
      )}
      {id && (
        <>
          <div className="faint">
            {agent.id} 的身份码（不要发到任务评论或群里）
          </div>
          <CodeLine code={id.code} />
          <div className="field" style={{ marginTop: 10 }}>
            <label htmlFor="ld-hub">Hub 地址（agent 能访问到的地址）</label>
            <input id="ld-hub" className="input" value={hub} onChange={(e) => setHub(e.target.value)} />
          </div>
          {hub && <Prompts hub={hub} id={id} defaultTab={agent.platform === 'claude-code' ? 'claude' : 'codex'} />}
        </>
      )}
      <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
        <button className="btn primary" onClick={onClose}>
          完成
        </button>
      </div>
    </Modal>
  );
}

/** 「Agent」页里的「新建 Agent」：填表新建身份，再给出身份码和各平台的启动方式。 */
export function NewAgentDialog({ onClose }: { onClose: () => void }) {
  const { projects, project, toast, refresh } = useHub();
  const active = projects.filter((p) => p.status === 'active');
  const [targetChoice, setTarget] = useState('');
  const target = targetChoice || (project ?? active[0]?.id ?? '');
  const [tags, setTags] = useState('');
  const [note, setNote] = useState('');
  const [name, setName] = useState('');
  const [created, setCreated] = useState<{ agent: Agent; code: string } | null>(null);

  if (active.length === 0)
    return (
      <Modal title="新建 Agent" onClose={onClose}>
        <p className="muted">请先在「项目」页创建一个项目。</p>
      </Modal>
    );
  if (created) return <LaunchDialog agent={created.agent} code={created.code} title={`已新建 ${created.agent.name || created.agent.id}`} onClose={onClose} />;

  const create = async () => {
    try {
      const r = await post<{ agent: Agent; code: string }>('/agents', { project: target, tags: splitList(tags), note, name });
      setCreated(r);
      refresh();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  return (
    <Modal title="新建 Agent" onClose={onClose} wide>
      <p className="muted" style={{ marginTop: -6 }}>
        新建一个 agent 身份并生成身份码。把启动命令或提示词交给 Codex、Claude Code 等 agent，它就会用这个身份连接并开始工作。
      </p>
      <div className="field-row">
        <div className="field">
          <label htmlFor="na-project">加入哪个项目</label>
          <select id="na-project" className="select" value={target} onChange={(e) => setTarget(e.target.value)}>
            {active.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id} · {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="na-tags">能力标签</label>
          <input id="na-tags" className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="如：后端, 测试" />
        </div>
      </div>
      <div className="field">
        <label htmlFor="na-name">Agent 名称（可选）</label>
        <input id="na-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：Claude-前端；不填就让 agent 第一次连接时自己起名" />
      </div>
      <div className="field">
        <label htmlFor="na-note">说明</label>
        <input id="na-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="如：笔记本上的 Codex，负责后端" />
      </div>
      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>
          取消
        </button>
        <button className="btn primary" onClick={create}>
          新建并生成身份码
        </button>
      </div>
    </Modal>
  );
}
