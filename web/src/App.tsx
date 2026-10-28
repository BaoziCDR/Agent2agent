import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Agent, ApiError, get, getToken, type HubEvent, type Project, setToken } from './api';
import { Ctx, type HubCtx } from './ui';
import { maybeNotify, notifyEnabled, notifySupported, setNotify } from './notify';
import { Overview } from './pages/Overview';
import { Board } from './pages/Board';
import { NewTask } from './pages/NewTask';
import { Agents } from './pages/Agents';
import { Messages } from './pages/Messages';
import { GlobalSearch } from './search';
import { Stats } from './pages/Stats';
import { Settings } from './pages/Settings';
import { Feed } from './pages/Feed';
import { Projects } from './pages/Projects';
import { TaskDrawer } from './pages/TaskDrawer';
import { LOCALES, lang, msg, t } from './i18n';

const InviteRoute = () => <Agents startInvite />;

const PAGES = [
  { id: 'overview', label: msg('总览') },
  { id: 'board', label: msg('任务看板') },
  { id: 'new', label: msg('发布任务') },
  { id: 'agents', label: msg('Agent') },
  // 旧地址：邀请已并入「Agent」页，保留这个入口直接打开邀请弹窗，不在导航里显示
  { id: 'invite', label: msg('邀请 Agent'), hidden: true },
  { id: 'messages', label: msg('私信与广播') },
  { id: 'feed', label: msg('实时动态') },
  { id: 'stats', label: msg('统计') },
  { id: 'projects', label: msg('项目') },
  { id: 'settings', label: msg('设置') },
] as const;
type PageId = (typeof PAGES)[number]['id'];

// 手机上导航放到底部：常用的四页直接点，其余收进「更多」
const TABBAR: { id: PageId; label: string }[] = [
  { id: 'overview', label: msg('总览') },
  { id: 'board', label: msg('看板') },
  { id: 'new', label: msg('发布') },
  { id: 'feed', label: msg('动态') },
];

function readHash(): { page: PageId; task: string | null } {
  const [page, task] = location.hash.replace(/^#\/?/, '').split('/');
  const valid = PAGES.some((p) => p.id === page);
  return { page: (valid ? page : 'overview') as PageId, task: task || null };
}

function LangSelect({ onLang }: { onLang: (code: string) => void }) {
  return (
    <select className="select" style={{ width: 'auto' }} value={lang()} onChange={(e) => onLang(e.target.value)} aria-label={t('界面语言')}>
      {LOCALES.map((l) => (
        <option key={l.code} value={l.code}>
          {l.name}
        </option>
      ))}
    </select>
  );
}

function Login({ onLogin, onLang }: { onLogin: () => void; onLang: (code: string) => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="login">
      <form
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          setToken(value.trim());
          try {
            await get('/projects');
            onLogin();
          } catch (err) {
            setToken(null);
            setError(err instanceof ApiError && err.status === 401 ? t('令牌不正确') : (err as Error).message);
          }
        }}
      >
        <div className="btn-row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ fontSize: 17 }}>{t('登录协作中枢控制台')}</h3>
          <LangSelect onLang={onLang} />
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          {t('负责人令牌在 Hub 首次启动时打印在终端里，也保存在数据目录的 owner-token.txt。')}
        </p>
        <div className="field">
          <label htmlFor="token">{t('负责人令牌')}</label>
          <input id="token" className="input" value={value} onChange={(e) => setValue(e.target.value)} placeholder="owner_..." autoFocus />
        </div>
        {error && <p style={{ color: 'var(--bad)' }}>{error}</p>}
        <button className="btn primary" type="submit" disabled={!value.trim()}>
          {t('登录')}
        </button>
      </form>
    </div>
  );
}

export function App({ onLang }: { onLang: (code: string | null) => void }) {
  const [authed, setAuthed] = useState(!!getToken());
  const [route, setRoute] = useState(readHash);
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [project, setProjectState] = useState<string | null>(() => {
    try {
      return localStorage.getItem('ahub.project');
    } catch {
      return null;
    }
  });
  const [tick, setTick] = useState(0);
  const [events, setEvents] = useState<HubEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [notifyOn, setNotifyOn] = useState(notifyEnabled);
  const [toastMsg, setToastMsg] = useState<{ text: string; error: boolean } | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const toastTimer = useRef<number>(0);

  useEffect(() => {
    const onHash = () => setRoute(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const toast = useCallback((text: string, error = false) => {
    setToastMsg({ text, error });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(null), error ? 4000 : 2200);
  }, []);

  const loadBase = useCallback(async () => {
    try {
      const [p, a] = await Promise.all([get<Project[]>('/projects'), get<Agent[]>('/agents')]);
      setProjects(p);
      setAgents(a);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setToken(null);
        setAuthed(false);
      }
    }
  }, []);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!authed) return;
    void loadBase();
  }, [authed, tick, loadBase]);

  // 打开控制台时先载入最近的动态
  useEffect(() => {
    if (!authed) return;
    get<HubEvent[]>('/events?limit=100')
      .then((list) => setEvents((cur) => [...cur, ...list.filter((e) => !cur.some((c) => c.seq === e.seq))].sort((a, b) => b.seq - a.seq)))
      .catch(() => undefined);
  }, [authed]);

  // 实时事件：收到事件后合并刷新（每 300ms 至多一次）
  useEffect(() => {
    if (!authed) return;
    let timer = 0;
    const es = new EventSource(`/api/v1/admin/stream?token=${encodeURIComponent(getToken() ?? '')}`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    const onEvent = (msg: MessageEvent) => {
      const e = JSON.parse(msg.data) as HubEvent;
      // 回执只用来刷新评论和私信下的标签，不进动态列表
      if (e.type !== 'receipt.updated') setEvents((list) => [e, ...list].slice(0, 300));
      maybeNotify(e, () => {
        location.hash = e.task ? `#/${readHash().page}/${e.task}` : e.type === 'agent.offline' ? '#/agents' : '#/overview';
      });
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setTick((t) => t + 1), 300);
    };
    const types = [
      'project.created', 'project.updated', 'agent.joined', 'agent.updated', 'task.created', 'task.updated', 'task.assigned',
      'task.claimed', 'task.status_changed', 'task.progress', 'task.lease_expiring', 'task.due_soon', 'task.overdue', 'task.unlocked', 'task.stalled', 'task.passed', 'task.unclaimed', 'task.deliverable', 'comment.created', 'artifact.updated',
      'message.direct', 'mention', 'owner.broadcast', 'agent.online', 'agent.offline', 'agent.activity', 'agent.control',
      'receipt.updated',
    ];
    for (const t of types) es.addEventListener(t, onEvent);
    // 在线状态依赖时间推移，定期刷新
    const interval = window.setInterval(() => setTick((t) => t + 1), 60_000);
    return () => {
      es.close();
      window.clearInterval(interval);
      window.clearTimeout(timer);
    };
  }, [authed]);

  const setProject = useCallback((p: string | null) => {
    setProjectState(p);
    try {
      if (p) localStorage.setItem('ahub.project', p);
      else localStorage.removeItem('ahub.project');
    } catch {
      // 忽略
    }
  }, []);

  // 选中的项目被删除或不存在时回到全部
  useEffect(() => {
    if (project && projects.length && !projects.some((p) => p.id === project)) setProject(null);
  }, [project, projects, setProject]);

  const go = useCallback((page: string) => {
    setMoreOpen(false);
    location.hash = `#/${page}`;
  }, []);
  const openTask = useCallback((id: string) => {
    location.hash = `#/${readHash().page}/${id}`;
  }, []);
  const closeTask = useCallback(() => {
    location.hash = `#/${readHash().page}`;
  }, []);

  const ctx: HubCtx = useMemo(
    () => ({ projects, project, setProject, agents, tick, events, refresh, toast, openTask, go, onLang }),
    [projects, project, setProject, agents, tick, events, refresh, toast, openTask, go, onLang],
  );

  if (!authed) return <Login onLogin={() => setAuthed(true)} onLang={onLang} />;

  const reviewCount = projects
    .filter((p) => !project || p.id === project)
    .reduce((n, p) => n + (p.counts.review ?? 0) + (p.counts.input_required ?? 0), 0);

  const toggleNotify = async () => {
    const on = await setNotify(!notifyOn);
    setNotifyOn(on);
    if (!notifyOn && !on) toast(t('浏览器没有允许通知，请在地址栏左侧的网站设置里打开'), true);
  };
  const logout = () => {
    setToken(null);
    setAuthed(false);
  };
  const isActive = (id: string) => route.page === id || (id === 'agents' && route.page === 'invite');
  const moreActive = !TABBAR.some((tab) => isActive(tab.id));

  const Page = {
    overview: Overview,
    board: Board,
    new: NewTask,
    agents: Agents,
    invite: InviteRoute,
    messages: Messages,
    feed: Feed,
    stats: Stats,
    projects: Projects,
    settings: Settings,
  }[route.page];

  return (
    <Ctx.Provider value={ctx}>
      <div className="app">
        <header className="topbar">
          <div className="brand">
            <span className="brand-dot" />
            <span className="brand-name">{t('协作中枢')}</span>
          </div>
          <select
            className="select"
            style={{ width: 'auto', minWidth: 200 }}
            value={project ?? ''}
            onChange={(e) => setProject(e.target.value || null)}
            aria-label={t('当前项目')}
          >
            <option value="">{t('全部项目')}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id} · {p.name}
                {p.status === 'archived' ? t('（已归档）') : ''}
              </option>
            ))}
          </select>
          <div className="spacer" />
          <GlobalSearch />
          {notifySupported() && (
            <button
              className="btn small topbar-extra"
              title={t('控制台在后台时，用系统通知提醒你：待验收、阻塞、@你、私信、agent 下线、任务可能失联')}
              onClick={toggleNotify}
            >
              {notifyOn ? t('通知：开') : t('通知：关')}
            </button>
          )}
          <span className="conn" title={connected ? t('实时连接正常') : t('实时连接已断开，正在重连')}>
            <span className={`dot ${connected ? 'online' : ''}`} />
            <span className="conn-label">{connected ? t('实时') : t('重连中')}</span>
          </span>
          <button className="btn small topbar-extra" onClick={logout}>
            {t('退出')}
          </button>
        </header>
        <nav className="sidebar">
          {PAGES.filter((p) => !('hidden' in p)).map((p) => (
            <button key={p.id} className={`nav-item ${isActive(p.id) ? 'active' : ''}`} onClick={() => go(p.id)}>
              <span>{t(p.label)}</span>
              {p.id === 'overview' && reviewCount > 0 && <span className="badge warn">{reviewCount}</span>}
            </button>
          ))}
        </nav>
        <main className="main">
          <Page />
        </main>
        <nav className="tabbar" aria-label={t('主导航')}>
          {TABBAR.map((tab) => (
            <button key={tab.id} className={`tabbar-item ${isActive(tab.id) && !moreOpen ? 'active' : ''}`} onClick={() => go(tab.id)}>
              {t(tab.label)}
              {tab.id === 'overview' && reviewCount > 0 && <span className="tabbar-badge">{reviewCount}</span>}
            </button>
          ))}
          <button className={`tabbar-item ${moreActive || moreOpen ? 'active' : ''}`} aria-expanded={moreOpen} onClick={() => setMoreOpen((v) => !v)}>
            {t('更多')}
          </button>
        </nav>
      </div>
      {moreOpen && (
        <div className="sheet-mask" onClick={() => setMoreOpen(false)}>
          <div className="sheet" role="menu" onClick={(e) => e.stopPropagation()}>
            {PAGES.filter((p) => !('hidden' in p) && !TABBAR.some((tab) => tab.id === p.id)).map((p) => (
              <button key={p.id} role="menuitem" className={`sheet-item ${isActive(p.id) ? 'active' : ''}`} onClick={() => go(p.id)}>
                {t(p.label)}
              </button>
            ))}
            <div className="sheet-sep" />
            {notifySupported() && (
              <button role="menuitem" className="sheet-item" onClick={toggleNotify}>
                <span>{t('系统通知')}</span>
                <span className="faint">{notifyOn ? t('已开') : t('已关')}</span>
              </button>
            )}
            <button role="menuitem" className="sheet-item" onClick={logout}>
              {t('退出登录')}
            </button>
          </div>
        </div>
      )}
      {route.task && <TaskDrawer id={route.task} onClose={closeTask} />}
      {toastMsg && <div className={`toast ${toastMsg.error ? 'error' : ''}`}>{toastMsg.text}</div>}
    </Ctx.Provider>
  );
}
