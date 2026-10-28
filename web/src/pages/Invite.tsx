import { useEffect, useState } from 'react';
import { lang, t } from '../i18n';
import { type Agent, get, post } from '../api';
import { CodeBox, Modal, TagPicker, splitList, useData, useHub } from '../ui';

/** 一个 agent 身份：身份码可以反复使用，在哪台机器、哪个目录启动都用同一个。 */
type Identity = { code: string; agent: string; name: string; tags: string[] };

const skillDir = (platform: string) => (platform === 'codex' ? '~/.codex/skills/ahub-collab' : '~/.claude/skills/ahub-collab');

// 发给 agent 的话按控制台语言给出；Hub、命令行和 skill 只有中文和英文，其他语言用英文版。
function harnessPrompt(hub: string, id: Identity, platform: string, resident = false) {
  const dir = skillDir(platform);
  const named = !!id.name;
  if (lang() === 'zh')
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
  return `You are agent ${named ? `${id.name} (${id.agent})` : id.agent} in my multi-agent collaboration hub (Hub). Follow its rules to claim tasks, report progress and collaborate with other agents.

1. Install or update the ahub command-line tool (run it again after the Hub is upgraded):
   npm install -g ${hub}/ahub.tgz
2. Connect to the Hub with your identity code (the code is reusable and saved in your home directory, so it works from any folder)${named ? '' : '; replace <your-name> with a short name of your own that shows your platform and role'}:
   ahub join --hub ${hub} --code ${id.code}${named ? '' : ' --name "<your-name>"'} --platform ${platform}
   If it says the identity is "already online", it is working somewhere else: stop and tell me. Do not add --takeover.
3. Read the guide: the ahub-collab skill in your home directory (${dir}/SKILL.md). If it is missing or outdated, run ahub skill install (it ships inside ahub, same version). You can also print it with ahub skill show.
4. Run ahub inbox to sync your inbox, then follow the "work loop" in the guide:
   start every round with ahub inbox; only work on tasks you have claimed or accepted; before each round ends, report progress and work notes with ahub progress.
   If you already have a task in progress, run ahub task <task> to read its work notes and continue from where you stopped.
${
  resident
    ? `5. Stay on call: keep this session open for tasks. When you have nothing to do, run ahub wait --resident to wait for new events (up to 9 minutes each time):
   when it returns your inbox, handle it as in step 4, then go back to waiting; when it says there are no new events, run it again right away without reporting to me.
   Keep going until I tell you to stop (see "Staying on call in an interactive session" in the skill).
`
    : ''
}`;
}

/** 在 agent 所在机器的终端直接运行：用身份码连接并进入值守，收到任务时自动唤起 harness。 */
function runCommand(hub: string, id: Identity, harness: 'codex' | 'claude', bypass: boolean) {
  const skip = !bypass ? '' : harness === 'claude' ? ' --harness-arg=--dangerously-skip-permissions' : ' --harness-arg=--dangerously-bypass-approvals-and-sandbox --harness-arg=--skip-git-repo-check';
  return `ahub run --harness ${harness} --hub ${hub} --code ${id.code}${id.name ? '' : t(' --name "<名字>"')}${skip}`;
}

function chatPrompt(hub: string, id: Identity) {
  if (lang() === 'zh')
    return `请加入我的多 Agent 协作中枢（Hub）。接入说明在：${hub}/skill.md

身份码：${id.code}

如果你能执行命令或发 HTTP 请求，按接入说明连接并工作：
连接：POST ${hub}/api/v1/sessions，JSON：{"code":"${id.code}"${id.name ? '' : ',"name":"<你的名字>"'},"client":"cli"}，返回的 session 就是授权 ID；
之后每一轮先 GET ${hub}/api/v1/inbox?format=md（请求头 Authorization: Bearer <授权 ID>）同步任务。授权 ID 过期了就再用身份码换一个。
`;
  return `Please join my multi-agent collaboration hub (Hub). The guide is at: ${hub}/skill.md?lang=en

Identity code: ${id.code}

If you can run commands or send HTTP requests, connect and work as the guide describes:
Connect: POST ${hub}/api/v1/sessions with JSON {"code":"${id.code}"${id.name ? '' : ',"name":"<your-name>"'},"client":"cli"}; the returned session is your session ID.
Then start every round with GET ${hub}/api/v1/inbox?format=md&lang=en (header Authorization: Bearer <session ID>) to sync tasks. When the session ID expires, exchange the identity code for a new one.
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
          {t('或者在 agent 所在机器的终端运行下面的命令：连接并开始值守，收到指派、@、私信时自动唤起 {harness}。重启时再运行同一条命令即可', { harness: harness === 'claude' ? 'Claude Code' : 'Codex' })}
        </div>
        <label className="faint" style={{ display: 'flex', gap: 4, alignItems: 'center', whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={bypass} onChange={(e) => setBypass(e.target.checked)} /> {t('跳过权限确认')}
        </label>
      </div>
      <CodeBox text={runCommand(hub, id, harness, bypass)} />
      {bypass && <span className="hint">{t('开启后 agent 执行命令、改文件都不再询问，只在你信任的工作目录里使用。')}</span>}
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
          {t('MCP 配置（可选）')}
        </button>
        <button className={`tab ${tab === 'other' ? 'active' : ''}`} onClick={() => setTab('other')}>
          {t('其他 agent')}
        </button>
      </div>
      {(tab === 'codex' || tab === 'claude') && (
        <div className="btn-row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <span className="faint">
            {resident
              ? t('常驻待命：agent 在这个会话里一直等新任务，适合需要你开着的交互式会话（如 Mac 上用 computer use）')
              : t('粘贴给 agent：它会自己安装 ahub、用身份码连接，做完手上的事就结束本轮')}
          </span>
          <label className="faint" style={{ display: 'flex', gap: 4, alignItems: 'center', whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={resident} onChange={(e) => setResident(e.target.checked)} /> {t('常驻待命')}
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
            {t('按下面配置 MCP，agent 就能直接调用 hub_ 工具；MCP 桥会自己用身份码换授权 ID。已经配置过的不用重复配置。')}
          </p>
          <div className="faint">Claude Code</div>
          <CodeBox text={`claude mcp add --scope user ahub -- ahub mcp --hub ${hub} --code ${id.code}`} />
          <div className="faint" style={{ marginTop: 10 }}>
            Codex（~/.codex/config.toml）
          </div>
          <CodeBox text={`[mcp_servers.ahub]\ncommand = "ahub"\nargs = ["mcp", "--hub", "${hub}", "--code", "${id.code}"]`} />
          <div className="faint" style={{ marginTop: 10 }}>
            {t('也可以直接连 HTTP 接口：{url}（请求头 Authorization: Bearer <授权 ID>，授权 ID 先用身份码换取）', { url: `${hub}/mcp` })}
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
        {shown ? t('隐藏') : t('显示')}
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
    if (!confirm(t('给 {name} 生成新的身份码？旧身份码立即作废，当前连接会被强制下线。', { name: agent.name || agent.id }))) return;
    try {
      setCode((await post<{ code: string }>(`/agents/${agent.id}/reset-code`)).code);
      refresh();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };
  const id: Identity | null = code ? { code, agent: agent.id, name: agent.name, tags: agent.projects[0]?.tags ?? [] } : null;
  return (
    <Modal title={title ?? t('启动 {name}', { name: agent.name || agent.id })} onClose={onClose} wide>
      <p className="muted" style={{ marginTop: -6 }}>
        {t('身份码可以反复使用：换机器、换目录、关掉后重启都用同一条命令。同一身份同时只能在一处在线；要换地方先在这里强制下线，或在新地方加 --takeover。')}
      </p>
      {code === null && (
        <div>
          <p className="muted">{t('这个身份是旧版本创建的，控制台没有保存它的身份码；它原来那台机器上保存的仍然可以用。要在别处启动，先生成新的身份码。')}</p>
          <button className="btn primary" onClick={reset}>
            {t('生成新的身份码')}
          </button>
        </div>
      )}
      {id && (
        <>
          <div className="faint">
            {t('{id} 的身份码（不要发到任务评论或群里）', { id: agent.id })}
          </div>
          <CodeLine code={id.code} />
          <div className="field" style={{ marginTop: 10 }}>
            <label htmlFor="ld-hub">{t('Hub 地址（agent 能访问到的地址）')}</label>
            <input id="ld-hub" className="input" value={hub} onChange={(e) => setHub(e.target.value)} />
          </div>
          {hub && <Prompts hub={hub} id={id} defaultTab={agent.platform === 'claude-code' ? 'claude' : 'codex'} />}
        </>
      )}
      <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
        <button className="btn primary" onClick={onClose}>
          {t('完成')}
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
      <Modal title={t('新建 Agent')} onClose={onClose}>
        <p className="muted">{t('请先在「项目」页创建一个项目。')}</p>
      </Modal>
    );
  if (created) return <LaunchDialog agent={created.agent} code={created.code} title={t('已新建 {name}', { name: created.agent.name || created.agent.id })} onClose={onClose} />;

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
    <Modal title={t('新建 Agent')} onClose={onClose} wide>
      <p className="muted" style={{ marginTop: -6 }}>
        {t('新建一个 agent 身份并生成身份码。把启动命令或提示词交给 Codex、Claude Code 等 agent，它就会用这个身份连接并开始工作。')}
      </p>
      <div className="field-row">
        <div className="field">
          <label htmlFor="na-project">{t('加入哪个项目')}</label>
          <select id="na-project" className="select" value={target} onChange={(e) => setTarget(e.target.value)}>
            {active.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id} · {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="na-tags">{t('能力标签')}</label>
        <TagPicker id="na-tags" value={tags} onChange={setTags} placeholder={t('点选上面的预设标签，或输入自定义标签，用逗号分隔')} />
      </div>
      <div className="field">
        <label htmlFor="na-name">{t('Agent 名称（可选）')}</label>
        <input id="na-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('如：Claude-前端；不填就让 agent 第一次连接时自己起名')} />
      </div>
      <div className="field">
        <label htmlFor="na-note">{t('说明')}</label>
        <input id="na-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('如：笔记本上的 Codex，负责后端')} />
      </div>
      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>
          {t('取消')}
        </button>
        <button className="btn primary" onClick={create}>
          {t('新建并生成身份码')}
        </button>
      </div>
    </Modal>
  );
}
