import { useEffect, useState } from 'react';
import { get, patch, post, type Part, type TaskDetail } from '../api';
import { Modal, StatusBadge, clock, splitList, timeAgo, useData, useHub } from '../ui';

const partText = (parts: Part[]) => parts.map((p) => p.text ?? p.url ?? JSON.stringify(p.data)).join('\n');

export function TaskDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { agents, toast, refresh, openTask } = useHub();
  const { data: t, error, reload } = useData(() => get<TaskDetail>(`/tasks/${id}`), [id]);
  const [comment, setComment] = useState('');
  const [dialog, setDialog] = useState<null | 'reject' | 'cancel' | 'edit'>(null);
  const [reason, setReason] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !dialog && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, dialog]);

  const act = async (path: string, body: unknown = {}, done?: string) => {
    try {
      await post(`/tasks/${id}/${path}`, body);
      if (done) toast(done);
      reload();
      refresh();
      return true;
    } catch (err) {
      toast((err as Error).message, true);
      return false;
    }
  };

  const members = t ? agents.filter((a) => a.status === 'active' && a.projects.some((p) => p.id === t.project)) : [];
  const closed = t && ['completed', 'canceled'].includes(t.status);

  return (
    <>
      <div className="drawer-mask" onClick={onClose} />
      <aside className="drawer" aria-label={`任务 ${id}`}>
        <div className="drawer-head">
          <div className="btn-row" style={{ justifyContent: 'space-between' }}>
            <span className="faint">
              {id}
              {t?.parent && (
                <>
                  {' · 父任务 '}
                  <a href="#" onClick={(e) => (e.preventDefault(), openTask(t.parent!))}>
                    {t.parent}
                  </a>
                </>
              )}
            </span>
            <button className="btn small" onClick={onClose} aria-label="关闭">
              关闭
            </button>
          </div>
          {error && <p style={{ color: 'var(--bad)' }}>{error}</p>}
          {t && (
            <>
              <h2 style={{ margin: '6px 0 8px', fontSize: 18 }}>{t.title}</h2>
              <div className="btn-row">
                <StatusBadge task={t} />
                <span className={`badge ${t.priority}`}>{t.priority}</span>
                <span className="faint">
                  创建者 {t.created_by === 'owner' ? '负责人' : t.created_by} · 更新于 {timeAgo(t.updated_at)}
                </span>
              </div>
            </>
          )}
        </div>
        {t && (
          <div className="drawer-body">
            <div className="section">
              <div className="btn-row">
                {t.status === 'draft' && (
                  <button className="btn primary" onClick={() => act('publish', {}, '已发布')}>
                    发布
                  </button>
                )}
                {t.status === 'review' && (
                  <>
                    <button className="btn primary" onClick={() => act('approve', {}, '已验收通过')}>
                      验收通过
                    </button>
                    <button className="btn" onClick={() => (setReason(''), setDialog('reject'))}>
                      退回修改
                    </button>
                  </>
                )}
                {t.status === 'input_required' && (
                  <button className="btn" onClick={() => act('unblock', {}, '已解除阻塞')}>
                    解除阻塞
                  </button>
                )}
                {!closed && (
                  <select
                    className="select"
                    style={{ width: 'auto' }}
                    value=""
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v) void act('assign', { agent: v === '-' ? null : v }, v === '-' ? '已放回任务池' : '已指派');
                    }}
                    aria-label="指派"
                  >
                    <option value="">{t.assignee ? '改派给…' : '指派给…'}</option>
                    {members
                      .filter((a) => a.id !== t.assignee)
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}（{a.id}）
                        </option>
                      ))}
                    {t.assignee && <option value="-">放回任务池</option>}
                  </select>
                )}
                {!closed && (
                  <button className="btn" onClick={() => setDialog('edit')}>
                    编辑
                  </button>
                )}
                {!closed && (
                  <button className="btn danger" onClick={() => (setReason(''), setDialog('cancel'))}>
                    取消任务
                  </button>
                )}
              </div>
            </div>

            <div className="section">
              <h4>负责人与进度</h4>
              <div>
                {t.assignee ? `${t.assignee_name}（${t.assignee}）` : '未指派'}
                {t.required_tags.length > 0 && <span className="faint"> · 需要：{t.required_tags.join('、')}</span>}
              </div>
              {t.status !== 'open' && t.status !== 'draft' && (
                <div style={{ marginTop: 8 }}>
                  <div className="progress">
                    <div style={{ width: `${t.progress}%` }} />
                  </div>
                  <div className="faint" style={{ marginTop: 4 }}>
                    {t.progress}% {t.progress_note && `· ${t.progress_note}`}
                  </div>
                </div>
              )}
              {t.status === 'input_required' && <p style={{ color: 'var(--bad)' }}>阻塞原因：{t.block_reason}</p>}
              {t.lease_until && !closed && <div className="faint">租约到期：{clock(t.lease_until)}</div>}
              {t.due_at && <div className="faint">截止：{clock(t.due_at)}</div>}
              {t.depends_on.length > 0 && (
                <div className="faint">
                  前置任务：
                  {t.depends_on.map((d) => (
                    <a key={d} href="#" style={{ marginRight: 6 }} onClick={(e) => (e.preventDefault(), openTask(d))}>
                      {d}
                    </a>
                  ))}
                </div>
              )}
            </div>

            <div className="section">
              <h4>描述</h4>
              <div className="prose">{t.description || <span className="faint">（无）</span>}</div>
            </div>

            {t.acceptance.length > 0 && (
              <div className="section">
                <h4>验收标准</h4>
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  {t.acceptance.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </div>
            )}

            {t.notes && (
              <div className="section">
                <h4>工作笔记</h4>
                <div className="prose">{t.notes}</div>
              </div>
            )}

            {t.subtasks.length > 0 && (
              <div className="section">
                <h4>子任务</h4>
                <div className="list">
                  {t.subtasks.map((s) => (
                    <div key={s.id} className="list-item clickable" onClick={() => openTask(s.id)}>
                      <StatusBadge task={s} />
                      <div style={{ flex: 1 }}>
                        <b>{s.id}</b> {s.title}
                        <div className="faint">{s.assignee_name ?? '未指派'}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {t.artifacts.length > 0 && (
              <div className="section">
                <h4>交付物</h4>
                {t.artifacts.map((a) => (
                  <div key={a.id} style={{ marginBottom: 10 }}>
                    <div className="faint">
                      {a.name} · {a.author} · {clock(a.created_at)}
                    </div>
                    {a.parts.map((p, i) =>
                      p.kind === 'link' ? (
                        <div key={i}>
                          <a href={p.url} target="_blank" rel="noreferrer">
                            {p.url}
                          </a>
                        </div>
                      ) : (
                        <pre key={i}>{p.text ?? JSON.stringify(p.data, null, 2)}</pre>
                      ),
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="section">
              <h4>讨论</h4>
              {t.comments.length === 0 && <div className="faint">还没有评论</div>}
              {t.comments.map((c) => (
                <div key={c.id} className={`comment ${c.author === 'owner' ? 'owner' : ''}`}>
                  <div className="faint">
                    {c.author === 'owner' ? '负责人' : `${c.author_name}（${c.author}）`} · {clock(c.created_at)}
                  </div>
                  <div className="prose">{partText(c.parts)}</div>
                </div>
              ))}
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (await act('comments', { text: comment })) setComment('');
                }}
              >
                <textarea
                  className="textarea"
                  style={{ minHeight: 64 }}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="写评论，可用 @A-3 提及 agent"
                  aria-label="评论"
                />
                <button className="btn" style={{ marginTop: 6 }} disabled={!comment.trim()}>
                  发表评论
                </button>
              </form>
            </div>

            {t.progress_log.length > 0 && (
              <div className="section">
                <h4>进度记录</h4>
                <div className="list">
                  {[...t.progress_log].reverse().map((p, i) => (
                    <div key={i} className="list-item">
                      <span className="feed-time">{clock(p.created_at)}</span>
                      <span className="badge">{p.percent}%</span>
                      <div style={{ flex: 1 }}>{p.note}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </aside>

      {dialog === 'reject' && (
        <Modal title="退回修改" onClose={() => setDialog(null)}>
          <div className="field">
            <label htmlFor="reject-reason">修改意见</label>
            <textarea id="reject-reason" className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          </div>
          <div className="btn-row">
            <button
              className="btn primary"
              disabled={!reason.trim()}
              onClick={async () => (await act('reject', { reason }, '已退回')) && setDialog(null)}
            >
              退回
            </button>
            <button className="btn" onClick={() => setDialog(null)}>
              算了
            </button>
          </div>
        </Modal>
      )}
      {dialog === 'cancel' && (
        <Modal title="取消任务" onClose={() => setDialog(null)}>
          <div className="field">
            <label htmlFor="cancel-reason">原因（可选）</label>
            <input id="cancel-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          </div>
          <div className="btn-row">
            <button className="btn danger" onClick={async () => (await act('cancel', { reason }, '已取消')) && setDialog(null)}>
              确认取消
            </button>
            <button className="btn" onClick={() => setDialog(null)}>
              返回
            </button>
          </div>
        </Modal>
      )}
      {dialog === 'edit' && t && (
        <EditTask
          task={t}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            reload();
            refresh();
          }}
        />
      )}
    </>
  );
}

function EditTask({ task, onClose, onSaved }: { task: TaskDetail; onClose: () => void; onSaved: () => void }) {
  const { toast } = useHub();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [acceptance, setAcceptance] = useState(task.acceptance.join('\n'));
  const [priority, setPriority] = useState(task.priority);
  const [tags, setTags] = useState(task.required_tags.join(', '));
  return (
    <Modal title={`编辑 ${task.id}`} onClose={onClose}>
      <div className="field">
        <label htmlFor="ed-title">标题</label>
        <input id="ed-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="ed-desc">描述</label>
        <textarea id="ed-desc" className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="ed-acc">验收标准（每行一条）</label>
        <textarea id="ed-acc" className="textarea" style={{ minHeight: 64 }} value={acceptance} onChange={(e) => setAcceptance(e.target.value)} />
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="ed-pri">优先级</label>
          <select id="ed-pri" className="select" value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)}>
            {['P0', 'P1', 'P2', 'P3'].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ed-tags">能力标签</label>
          <input id="ed-tags" className="input" value={tags} onChange={(e) => setTags(e.target.value)} />
        </div>
      </div>
      <div className="btn-row">
        <button
          className="btn primary"
          disabled={!title.trim()}
          onClick={async () => {
            try {
              await patch(`/tasks/${task.id}`, {
                title,
                description,
                acceptance: acceptance.split('\n').map((s) => s.trim()).filter(Boolean),
                priority,
                required_tags: splitList(tags),
                version: task.version,
              });
              toast('已保存');
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
