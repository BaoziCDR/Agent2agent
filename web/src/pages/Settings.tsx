import { useState } from 'react';
import { del, get, patch, post, put } from '../api';
import { Modal, dateTime, resetTagOptions, splitList, timeAgo, useData, useHub } from '../ui';

interface Channel {
  id: number;
  kind: string;
  name: string;
  webhook_masked: string;
  has_secret: boolean;
  topics: string[];
  projects: string[];
  console_url: string;
  enabled: boolean;
  last_error: string;
  last_sent_at: string | null;
}

export function Settings() {
  const { toast } = useHub();
  const { data, reload } = useData(() => get<{ channels: Channel[]; topics: Record<string, string> }>('/notify/channels'), []);
  const [editing, setEditing] = useState<Channel | 'new' | null>(null);
  const topics = data?.topics ?? {};

  const run = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast(done);
      reload();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  return (
    <div style={{ maxWidth: 900 }}>
      <h1 className="page-title">设置</h1>
      <p className="page-sub">把需要你关注的事推送到外部，不打开控制台也不会错过；调整 agent 自动下线的时长和已完成任务自动归档的时长；配置外部模型给任务自动打标签；维护创建 agent 时可选的标签。</p>
      <PresenceCard />
      <ArchiveCard />
      <div className="card">
        <div className="btn-row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>钉钉机器人</h3>
          <button className="btn primary small" onClick={() => setEditing('new')}>
            添加机器人
          </button>
        </div>
        <p className="faint" style={{ marginTop: 0 }}>
          在钉钉群里打开「群设置 → 机器人 → 添加机器人 → 自定义」，安全设置选「加签」，把 Webhook 地址和加签密钥填到这里。几秒内的多条动态会合并成一条消息。
        </p>
        {data && data.channels.length === 0 && <div className="empty">还没有添加机器人</div>}
        <div className="list">
          {data?.channels.map((c) => (
            <div key={c.id} className="list-item" style={{ alignItems: 'center' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div>
                  <b>{c.name}</b> {!c.enabled && <span className="badge">已停用</span>}
                  {c.enabled && c.last_error && <span className="badge bad">发送失败</span>}
                </div>
                <div className="faint" style={{ wordBreak: 'break-all' }}>
                  {c.webhook_masked}
                  {c.has_secret ? ' · 已加签' : ' · 未加签'}
                </div>
                <div className="faint">
                  推送：{c.topics.map((t) => topics[t] ?? t).join('、')} · 项目：{c.projects.length ? c.projects.join('、') : '全部'}
                </div>
                {c.last_error ? (
                  <div className="faint" style={{ color: 'var(--bad)' }}>
                    最近一次失败：{c.last_error}
                  </div>
                ) : (
                  c.last_sent_at && (
                    <div className="faint" title={dateTime(c.last_sent_at)}>
                      最近一次推送：{timeAgo(c.last_sent_at)}
                    </div>
                  )
                )}
              </div>
              <div className="btn-row">
                <button className="btn small" onClick={() => run(() => post(`/notify/channels/${c.id}/test`), '测试消息已发送，去钉钉群里看看')}>
                  测试
                </button>
                <button className="btn small" onClick={() => run(() => patch(`/notify/channels/${c.id}`, { enabled: !c.enabled }), c.enabled ? '已停用' : '已启用')}>
                  {c.enabled ? '停用' : '启用'}
                </button>
                <button className="btn small" onClick={() => setEditing(c)}>
                  编辑
                </button>
                <button
                  className="btn small danger"
                  onClick={() => confirm(`删除「${c.name}」？`) && run(() => del(`/notify/channels/${c.id}`), '已删除')}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
      <LlmCard />
      <PresetTagsCard />
      {editing && (
        <ChannelForm
          channel={editing === 'new' ? null : editing}
          topics={topics}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function ChannelForm({
  channel,
  topics,
  onClose,
  onSaved,
}: {
  channel: Channel | null;
  topics: Record<string, string>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { projects, toast } = useHub();
  const [name, setName] = useState(channel?.name ?? '钉钉群');
  const [webhook, setWebhook] = useState('');
  const [secret, setSecret] = useState('');
  const [picked, setPicked] = useState<string[]>(channel?.topics ?? ['review', 'blocked', 'message', 'overdue', 'lost', 'stalled', 'offline']);
  const [scope, setScope] = useState<string[]>(channel?.projects ?? []);
  const [consoleUrl, setConsoleUrl] = useState(channel?.console_url || location.origin);
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return (
    <Modal title={channel ? `编辑「${channel.name}」` : '添加钉钉机器人'} onClose={onClose}>
      <div className="field">
        <label htmlFor="ch-name">名称</label>
        <input id="ch-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="ch-hook">Webhook 地址</label>
        <input
          id="ch-hook"
          className="input"
          value={webhook}
          onChange={(e) => setWebhook(e.target.value)}
          placeholder={channel ? `${channel.webhook_masked}（留空不改）` : 'https://oapi.dingtalk.com/robot/send?access_token=…'}
        />
      </div>
      <div className="field">
        <label htmlFor="ch-secret">加签密钥（SEC 开头）</label>
        <input
          id="ch-secret"
          className="input"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder={channel?.has_secret ? '已设置，留空不改' : '安全设置选「自定义关键词」时可以不填'}
        />
        {!channel && <span className="hint">选「自定义关键词」的话，把关键词设成「协作中枢」，每条消息的标题都带这四个字。</span>}
      </div>
      <div className="field">
        <label>推送哪些事</label>
        <div className="check-grid">
          {Object.entries(topics).map(([k, label]) => (
            <label key={k}>
              <input type="checkbox" checked={picked.includes(k)} onChange={() => setPicked(toggle(picked, k))} /> {label}
            </label>
          ))}
        </div>
      </div>
      <div className="field">
        <label>只推送这些项目（都不选表示全部）</label>
        <div className="check-grid">
          {projects.map((p) => (
            <label key={p.id}>
              <input type="checkbox" checked={scope.includes(p.id)} onChange={() => setScope(toggle(scope, p.id))} /> {p.id} {p.name}
            </label>
          ))}
        </div>
      </div>
      <div className="field">
        <label htmlFor="ch-url">控制台地址</label>
        <input id="ch-url" className="input" value={consoleUrl} onChange={(e) => setConsoleUrl(e.target.value)} />
        <span className="hint">消息里「查看」链接的前缀。手机上要能打开，就填局域网 IP 地址而不是 127.0.0.1。</span>
      </div>
      <div className="btn-row">
        <button
          className="btn primary"
          disabled={(!channel && !webhook.trim()) || picked.length === 0}
          onClick={async () => {
            const body = {
              name,
              ...(webhook.trim() ? { webhook: webhook.trim() } : {}),
              ...(secret.trim() ? { secret: secret.trim() } : {}),
              topics: picked,
              projects: scope,
              console_url: consoleUrl,
            };
            try {
              if (channel) await patch(`/notify/channels/${channel.id}`, body);
              else await post('/notify/channels', body);
              toast('已保存，可以点「测试」确认能收到');
              onSaved();
            } catch (err) {
              toast((err as Error).message, true);
            }
          }}
        >
          保存
        </button>
        <button className="btn" onClick={onClose}>
          取消
        </button>
      </div>
    </Modal>
  );
}

/** 自动下线：超过时长授权 ID 失效，agent 判为离线 */
function PresenceCard() {
  const { toast } = useHub();
  const { data, reload } = useData(() => get<{ idle_minutes: number; stream_grace_minutes: number }>('/presence-settings'), []);
  const [idle, setIdle] = useState('');
  const [grace, setGrace] = useState('');
  const save = async () => {
    try {
      await patch('/presence-settings', { idle_minutes: idle || undefined, stream_grace_minutes: grace || undefined });
      toast('已保存');
      setIdle('');
      setGrace('');
      reload();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ margin: '0 0 8px' }}>自动下线</h3>
      <p className="faint" style={{ marginTop: 0 }}>
        超过下面的时长，agent 的授权 ID 自动失效、判为离线并通知你。命令行和 MCP 下次调用时会用身份码自动重新连接；值守进程断线重连也一样。
      </p>
      <div className="field-row">
        <div className="field">
          <label htmlFor="ps-idle">多久没有任何请求（分钟）</label>
          <input id="ps-idle" type="number" min={5} max={1440} className="input" value={idle} placeholder={data ? String(data.idle_minutes) : ''} onChange={(e) => setIdle(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ps-grace">值守进程断线多久（分钟）</label>
          <input id="ps-grace" type="number" min={1} max={60} className="input" value={grace} placeholder={data ? String(data.stream_grace_minutes) : ''} onChange={(e) => setGrace(e.target.value)} />
        </div>
      </div>
      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn primary small" disabled={!idle && !grace} onClick={save}>
          保存
        </button>
      </div>
    </div>
  );
}

/** 自动归档：已完成的任务多久没有动静就收进归档 */
function ArchiveCard() {
  const { toast } = useHub();
  const { data, reload } = useData(() => get<{ auto_archive_hours: number }>('/archive-settings'), []);
  const [hours, setHours] = useState('');
  const save = async () => {
    try {
      await patch('/archive-settings', { auto_archive_hours: Number(hours) });
      toast('已保存');
      setHours('');
      reload();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ margin: '0 0 8px' }}>自动归档</h3>
      <p className="faint" style={{ marginTop: 0 }}>
        已完成的任务超过下面的时长没有任何动静（评论、交付物修改、状态变化等），会自动收进「已归档」，标为自动归档；你在任务详情里点「归档任务」的是手动归档。填 0 表示不自动归档。
        {data && (data.auto_archive_hours > 0 ? `当前：${data.auto_archive_hours} 小时。` : '当前：不自动归档。')}
      </p>
      <div className="field-row">
        <div className="field">
          <label htmlFor="as-hours">完成后多久没有动静（小时）</label>
          <input
            id="as-hours"
            type="number"
            min={0}
            max={8760}
            className="input"
            value={hours}
            placeholder={data ? String(data.auto_archive_hours) : ''}
            onChange={(e) => setHours(e.target.value)}
          />
        </div>
      </div>
      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn primary small" disabled={hours.trim() === ''} onClick={save}>
          保存
        </button>
      </div>
    </div>
  );
}

interface LlmView {
  base_url: string;
  model: string;
  auto_tag: boolean;
  has_key: boolean;
  key_masked: string;
  configured: boolean;
}

/** 外部模型（Chat Completions 接口）：发布任务时自动打能力标签；不配置就不开启 */
function LlmCard() {
  const { toast } = useHub();
  const { data, reload } = useData(() => get<LlmView>('/llm'), []);
  const [form, setForm] = useState<{ base_url: string; model: string; api_key: string; auto_tag: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const f = form ?? { base_url: data?.base_url ?? '', model: data?.model ?? '', api_key: '', auto_tag: data?.auto_tag ?? true };
  const set = (patchv: Partial<typeof f>) => setForm({ ...f, ...patchv });
  const body = () => ({ base_url: f.base_url, model: f.model, auto_tag: f.auto_tag, ...(f.api_key ? { api_key: f.api_key } : {}) });

  const save = async () => {
    try {
      await put('/llm', body());
      toast('已保存');
      setForm(null);
      reload();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };
  const test = async () => {
    setBusy(true);
    try {
      const r = await post<{ ok: boolean; ms: number; tags: string[]; reason: string; raw: string }>('/llm/test', body());
      if (r.ok) toast(`可以用：${(r.ms / 1000).toFixed(1)} 秒，示例任务打上了「${r.tags.join('、') || '无'}」${r.reason ? `（${r.reason}）` : ''}`);
      else toast(`接口能连上，但回答不是预期的格式：${r.raw.slice(0, 80)}`, true);
    } catch (err) {
      toast((err as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="btn-row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>智能打标签（外部模型）</h3>
        {data && <span className={`badge ${data.configured && data.auto_tag ? 'good' : ''}`}>{data.configured ? (data.auto_tag ? '已开启' : '已配置，未开启') : '未配置'}</span>}
      </div>
      <p className="faint" style={{ marginTop: 0 }}>
        发布任务时，如果没有手动填能力标签，就用这里配置的模型从项目成员已有的标签里挑出任务需要的（最多 3 个，通用任务不打）。打上的标签决定谁能领取。接口兼容 OpenAI 的 Chat Completions 格式，不配置就不开启。
      </p>
      <div className="field">
        <label htmlFor="llm-url">接口地址</label>
        <input id="llm-url" className="input" value={f.base_url} onChange={(e) => set({ base_url: e.target.value })} placeholder="https://api.openai.com/v1（会请求 /chat/completions）" />
      </div>
      <div className="field">
        <label htmlFor="llm-model">模型</label>
        <input id="llm-model" className="input" value={f.model} onChange={(e) => set({ model: e.target.value })} placeholder="例如 gpt-4o-mini、deepseek-chat、qwen-turbo" />
      </div>
      <div className="field">
        <label htmlFor="llm-key">API Key</label>
        <input
          id="llm-key"
          className="input"
          type="password"
          autoComplete="off"
          value={f.api_key}
          onChange={(e) => set({ api_key: e.target.value })}
          placeholder={data?.has_key ? `已设置（${data.key_masked}），留空不改` : '本地部署的模型不需要可以不填'}
        />
      </div>
      <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <input type="checkbox" checked={f.auto_tag} onChange={(e) => set({ auto_tag: e.target.checked })} /> 发布任务时自动打标签
      </label>
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn primary small" onClick={save}>
          保存
        </button>
        <button className="btn small" disabled={busy || !f.base_url || !f.model} onClick={test}>
          {busy ? '测试中…' : '测试'}
        </button>
        {data?.has_key && (
          <button className="btn small" onClick={() => put('/llm', { api_key: null }).then(() => (toast('已清除 API Key'), reload()))}>
            清除 API Key
          </button>
        )}
      </div>
    </div>
  );
}

/** 创建 agent（邀请码）和任务时可以直接点选的标签 */
function PresetTagsCard() {
  const { toast } = useHub();
  const { data, reload } = useData(() => get<{ presets: string[]; in_use: string[] }>('/tags'), []);
  const [text, setText] = useState<string | null>(null);
  const value = text ?? data?.presets.join(', ') ?? '';
  const save = async () => {
    try {
      await put('/tags/presets', { presets: splitList(value) });
      resetTagOptions();
      toast('已保存');
      setText(null);
      reload();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3 style={{ marginTop: 0 }}>预设标签</h3>
      <p className="faint" style={{ marginTop: 0 }}>
        创建 agent 和任务时可以直接点选这些标签，也可以输入自定义的。改动不影响已经打上的标签。
      </p>
      <div className="field">
        <label htmlFor="preset-tags">预设标签（逗号分隔）</label>
        <textarea id="preset-tags" className="textarea" rows={2} value={value} onChange={(e) => setText(e.target.value)} />
        {data && data.in_use.length > 0 && <span className="hint">正在使用、但不在预设里的：{data.in_use.join('、')}</span>}
      </div>
      <button className="btn primary small" onClick={save}>
        保存
      </button>
    </div>
  );
}
