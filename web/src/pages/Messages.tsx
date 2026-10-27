import { useEffect, useRef, useState } from 'react';
import { get, markOwnerRead, type Message, post } from '../api';
import { clock, useData, useHub } from '../ui';
import { Markdown } from '../markdown';

export function Messages() {
  const { agents, projects, project, toast, refresh } = useHub();
  const [to, setTo] = useState('');
  const [text, setText] = useState('');
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [bProjectChoice, setBProject] = useState('');
  const bProject = bProjectChoice || (project ?? projects[0]?.id ?? '');
  const [bText, setBText] = useState('');
  const { data: messages, reload } = useData(() => get<Message[]>('/messages'), []);
  // 打开私信页看到了，发给负责人的私信就算已读
  useEffect(() => {
    if (messages) markOwnerRead({ type: 'message.direct' }).then((n) => n && refresh());
  }, [messages, refresh]);

  return (
    <div style={{ maxWidth: 900 }}>
      <h1 className="page-title">私信与广播</h1>
      <p className="page-sub">agent 之间的私信你都能看到。广播会出现在项目所有成员下一次同步的「需要你处理」里。</p>
      <div className="grid two-col" style={{ marginBottom: 16 }}>
        <div className="card">
          <h3>发私信</h3>
          <div className="field">
            <label htmlFor="msg-to">发给</label>
            <select id="msg-to" className="select" value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">选择 agent</option>
              {agents
                .filter((a) => a.status === 'active')
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}（{a.id}）
                  </option>
                ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="msg-text">内容</label>
            <textarea id="msg-text" ref={textRef} className="textarea" value={text} onChange={(e) => setText(e.target.value)} />
          </div>
          <button
            className="btn primary"
            disabled={!to || !text.trim()}
            onClick={async () => {
              try {
                await post('/messages', { to, text });
                setText('');
                toast('已发送');
                reload();
              } catch (err) {
                toast((err as Error).message, true);
              }
            }}
          >
            发送
          </button>
        </div>
        <div className="card">
          <h3>项目广播</h3>
          <div className="field">
            <label htmlFor="b-project">项目</label>
            <select id="b-project" className="select" value={bProject} onChange={(e) => setBProject(e.target.value)}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id} · {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="b-text">内容</label>
            <textarea id="b-text" className="textarea" value={bText} onChange={(e) => setBText(e.target.value)} placeholder="如：接口规范改了，请大家先看项目说明" />
          </div>
          <button
            className="btn primary"
            disabled={!bProject || !bText.trim()}
            onClick={async () => {
              try {
                await post('/broadcast', { project: bProject, text: bText });
                setBText('');
                toast('已广播');
              } catch (err) {
                toast((err as Error).message, true);
              }
            }}
          >
            广播
          </button>
        </div>
      </div>
      <div className="card">
        <h3>私信记录</h3>
        {messages && messages.length === 0 && <div className="empty">还没有私信</div>}
        <div className="list">
          {messages?.map((m) => (
            <div key={m.id} className="list-item">
              <span className="feed-time">{clock(m.created_at)}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="faint">
                  {m.sender_name} → {m.recipient_name}
                </div>
                <Markdown text={m.body} agents={agents} />
              </div>
              {m.sender !== 'owner' && agents.some((a) => a.id === m.sender && a.status === 'active') && (
                <button
                  className="btn small"
                  onClick={() => {
                    setTo(m.sender);
                    textRef.current?.focus();
                    textRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                  }}
                >
                  回复
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
