import { useState } from 'react';
import { del, get, patch, post } from '../api';
import { Modal, dateTime, timeAgo, useData, useHub } from '../ui';

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
      <p className="page-sub">把需要你关注的事推送到外部，不打开控制台也不会错过；调整 agent 自动下线的时长。</p>
      <PresenceCard />
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
    <div className="card">
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
