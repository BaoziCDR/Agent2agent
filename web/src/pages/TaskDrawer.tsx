import { useEffect, useRef, useState } from 'react';
import { joinList, t as tr, withCode } from '../i18n';
import { get, markOwnerRead, patch, post, type Part, type TaskDetail } from '../api';
import { Modal, Receipts, StatusBadge, TagPicker, clock, dateTime, dueInfo, splitList, timeAgo, toLocalInput, useData, useHub } from '../ui';
import { MentionTextarea, agentCandidates } from '../mention';
import { Markdown } from '../markdown';
import { Suggest, useRecommend } from '../suggest';
import { AnswerBox } from '../answer';
import { Artifacts, FilePart } from './Artifacts';
import { TaskPicker } from '../taskpicker';
import { AttachmentChips, AttachmentField, fromParts, renameScreenshot, useAttachments } from '../attach';

const partText = (parts: Part[]) =>
  parts
    .filter((p) => p.kind !== 'file')
    .map((p) => p.text ?? p.url ?? JSON.stringify(p.data))
    .join('\n');

export function TaskDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { agents, toast, refresh, openTask } = useHub();
  const { data: t, error, reload } = useData(() => get<TaskDetail>(`/tasks/${id}`), [id]);
  // 打开任务、看到评论，就当读过这个任务里 @负责人 的话；没有新标记的就不刷新，避免来回请求
  useEffect(() => {
    if (t) markOwnerRead({ task: id }).then((n) => n && refresh());
  }, [t, id, refresh]);
  const [comment, setComment] = useState('');
  const [dialog, setDialog] = useState<null | 'reject' | 'cancel' | 'edit' | 'subtask'>(null);
  const [reason, setReason] = useState('');
  const { files, setFiles, uploading, attach, remove: removeFile } = useAttachments(10, tr('一条评论'));
  const [wide, setWide] = useState(() => {
    try {
      return localStorage.getItem('ahub.drawer-wide') === '1';
    } catch {
      return false;
    }
  });
  // 在交付物上划选文字时，浮出「引用到评论」按钮
  const drawerRef = useRef<HTMLElement>(null);
  const [quote, setQuote] = useState<{ text: string; source: string; x: number; y: number } | null>(null);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const sel = document.getSelection();
        const text = sel && !sel.isCollapsed ? sel.toString().trim() : '';
        const range = text ? sel!.getRangeAt(0) : null;
        const node = range?.commonAncestorContainer;
        const el = node && (node.nodeType === 1 ? (node as Element) : node.parentElement);
        const art = el?.closest<HTMLElement>('.artifact[data-source]');
        if (!range || !art || !drawerRef.current?.contains(art)) return setQuote(null);
        const r = range.getBoundingClientRect();
        setQuote({ text, source: art.dataset.source!, x: r.left + r.width / 2, y: r.top < 70 ? r.bottom + 44 : r.top });
      });
    };
    document.addEventListener('selectionchange', update);
    document.addEventListener('scroll', update, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('selectionchange', update);
      document.removeEventListener('scroll', update, true);
    };
  }, []);
  const insertQuote = () => {
    if (!quote) return;
    const body = quote.text
      .slice(0, 2000)
      .split('\n')
      .map((l) => (l.trim() ? `> ${l}` : '>'))
      .join('\n');
    const block = `> **${tr('引自{source}', { source: quote.source })}**\n${body}\n\n`;
    setComment((c) => (c.trim() ? `${c.replace(/\s*$/, '')}\n\n${block}` : block));
    setQuote(null);
    document.getSelection()?.removeAllRanges();
    setTimeout(() => {
      const ta = drawerRef.current?.querySelector<HTMLTextAreaElement>('.comment-form textarea');
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      ta.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  };

  const toggleWide = () =>
    setWide((w) => {
      try {
        localStorage.setItem('ahub.drawer-wide', w ? '0' : '1');
      } catch {
        // 无痕模式下存不了，只影响这一次
      }
      return !w;
    });
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !dialog && !document.querySelector('.modal-mask') && onClose();
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

  const sendComment = async () => {
    if ((!comment.trim() && !files.length) || uploading) return;
    if (await act('comments', { text: comment, files: files.map((f) => f.id) })) {
      setComment('');
      setFiles([]);
    }
  };

  const recs = useRecommend({ task: id }, t?.status === 'open' && !t.assignee);
  const members = t ? agents.filter((a) => a.status === 'active' && a.projects.some((p) => p.id === t.project)) : [];
  const closed = t && ['completed', 'archived'].includes(t.status);

  return (
    <>
      <div className="drawer-mask" onClick={onClose} />
      <aside ref={drawerRef} className={`drawer${wide ? ' wide' : ''}`} aria-label={tr('任务 {id}', { id })}>
        <div className="drawer-head">
          <div className="btn-row" style={{ justifyContent: 'space-between' }}>
            <span className="faint">
              {id}
              {t?.parent && (
                <>
                  {tr(' · 父任务 ')}
                  <a href="#" onClick={(e) => (e.preventDefault(), openTask(t.parent!))}>
                    {t.parent}
                  </a>
                </>
              )}
            </span>
            <span className="btn-row">
              <button className="btn small ghost drawer-widen" onClick={toggleWide} title={wide ? tr('恢复侧栏宽度') : tr('铺满窗口阅读')}>
                {wide ? tr('收起') : tr('展开')}
              </button>
              <button className="btn small" onClick={onClose} aria-label={tr('关闭')}>
                {tr('关闭')}
              </button>
            </span>
          </div>
          {error && <p style={{ color: 'var(--bad)' }}>{error}</p>}
          {t && (
            <>
              <h2 className="drawer-title">{t.title}</h2>
              <div className="btn-row">
                <StatusBadge task={t} />
                <span className={`badge ${t.priority}`}>{t.priority}</span>
                <span className="faint">
                  {tr('创建者 {who}', { who: t.created_by === 'owner' ? tr('负责人') : t.created_by })} · {tr('更新于 {time}', { time: timeAgo(t.updated_at) })}
                </span>
              </div>
              <Receipts list={t.receipts} />
              <div className="btn-row drawer-actions">
                {t.status === 'draft' && (
                  <button className="btn primary" onClick={() => act('publish', {}, tr('已发布'))}>
                    {tr('发布')}
                  </button>
                )}
                {t.status === 'review' && (
                  <>
                    <button className="btn primary" onClick={() => act('approve', {}, tr('已验收通过'))}>
                      {tr('验收通过')}
                    </button>
                    <button className="btn" onClick={() => (setReason(''), setDialog('reject'))}>
                      {tr('退回修改')}
                    </button>
                  </>
                )}
                {t.status === 'input_required' && (
                  <button className="btn" onClick={() => act('unblock', {}, tr('已解除阻塞'))}>
                    {tr('解除阻塞')}
                  </button>
                )}
                {!closed && (
                  <select
                    className="select"
                    style={{ width: 'auto' }}
                    value=""
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v) void act('assign', { agent: v === '-' ? null : v }, v === '-' ? tr('已放回任务池') : tr('已指派'));
                    }}
                    aria-label={tr('指派')}
                  >
                    <option value="">{t.assignee ? tr('改派给…') : tr('指派给…')}</option>
                    {members
                      .filter((a) => a.id !== t.assignee)
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {withCode(a.name, a.id)}
                        </option>
                      ))}
                    {t.assignee && <option value="-">{tr('放回任务池')}</option>}
                  </select>
                )}
                {!closed && (
                  <button className="btn" onClick={() => setDialog('edit')}>
                    {tr('编辑')}
                  </button>
                )}
                {!closed && (
                  <button className="btn danger" onClick={() => (setReason(''), setDialog('cancel'))}>
                    {tr('归档任务')}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
        {t && (
          <div className="drawer-body drawer-grid">
            <div className="drawer-main">
              {t.status === 'input_required' && <AnswerBox task={t} onDone={reload} />}
              {t.stalled && (
                <p className="due warn stall-hint">
                  {tr('进度停在 {progress}% 已经很久，期间一直在上报，可能在原地打转。可以在下面评论问问卡在哪，或者拆成更小的子任务、改派给别人。', { progress: t.progress })}
                </p>
              )}
              <div className="section">
                <h4>{tr('描述')}</h4>
                {t.description ? <Markdown text={t.description} agents={agents} /> : <span className="faint">{tr('（无）')}</span>}
              </div>

              {t.attachments.length > 0 && (
                <div className="section">
                  <h4>
                    {tr('附件')}<span className="h4-hint">{tr('agent 用 ahub download {id} 下载到本地', { id: t.id })}</span>
                  </h4>
                  <div className="attachments">
                    {t.attachments.map((p, i) => (
                      <FilePart key={i} p={p} />
                    ))}
                  </div>
                </div>
              )}

              {t.acceptance.length > 0 && (
                <div className="section">
                  <h4>{tr('验收标准')}</h4>
                  <ul style={{ margin: 0, paddingLeft: 20 }}>
                    {t.acceptance.map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ul>
                </div>
              )}

              {t.ref_tasks.length > 0 && (
                <div className="section">
                  <h4>
                    {tr('引用的任务')}<span className="h4-hint">{tr('参考资料，agent 可以读取它们的详情、交付物和讨论')}</span>
                  </h4>
                  <div className="list">
                    {t.ref_tasks.map((r) => (
                      <div key={r.id} className="list-item clickable" onClick={() => openTask(r.id)}>
                        <StatusBadge task={r} />
                        <div style={{ flex: 1 }}>
                          <b>{r.id}</b> {r.title}
                          <div className="faint">{r.assignee_name ?? tr('未指派')}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {t.notes && (
                <div className="section">
                  <h4>{tr('工作笔记')}</h4>
                  <Markdown text={t.notes} agents={agents} />
                </div>
              )}

              {t.artifacts.length > 0 && (
                <div className="section">
                  <h4>
                    {tr('交付物')}<span className="h4-hint">{tr('划选文字可以引用到评论')}</span>
                  </h4>
                  <Artifacts task={t.id} artifacts={t.artifacts} onChanged={reload} />
                </div>
              )}

              <div className="section">
                <h4>{tr('讨论')}</h4>
                {t.comments.length === 0 && <div className="faint">{tr('还没有评论')}</div>}
                {t.comments.map((c) => (
                  <div key={c.id} className={`comment ${c.author === 'owner' ? 'owner' : ''}`}>
                    <div className="faint">
                      {c.author === 'owner' ? tr('负责人') : withCode(c.author_name, c.author)} · {clock(c.created_at)}
                    </div>
                    {partText(c.parts) && <Markdown text={partText(c.parts)} agents={agents} />}
                    {c.parts.some((p) => p.kind === 'file') && (
                      <div className="attachments">
                        {c.parts.map((p, i) => p.kind === 'file' && <FilePart key={i} p={p} />)}
                      </div>
                    )}
                    <Receipts list={c.receipts} />
                  </div>
                ))}
                <form
                  className="comment-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void sendComment();
                  }}
                  onPaste={(e) => {
                    const list = [...e.clipboardData.files];
                    if (!list.length) return;
                    e.preventDefault();
                    void attach(list.map(renameScreenshot));
                  }}
                  onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
                  onDrop={(e) => {
                    if (!e.dataTransfer.files.length) return;
                    e.preventDefault();
                    void attach([...e.dataTransfer.files]);
                  }}
                >
                  <MentionTextarea
                    style={{ minHeight: 96 }}
                    value={comment}
                    onChange={setComment}
                    candidates={agentCandidates(members, t.project)}
                    onSubmit={() => void sendComment()}
                    placeholder={tr('写评论，支持 Markdown；输入 @ 提及 agent，可粘贴或拖入截图和文件（Ctrl+Enter 发表）')}
                    aria-label={tr('评论')}
                  />
                  <AttachmentChips files={files} uploading={uploading} onRemove={removeFile} />
                  <div className="btn-row" style={{ marginTop: 6 }}>
                    <button className="btn" disabled={(!comment.trim() && !files.length) || uploading > 0}>
                      {tr('发表评论')}
                    </button>
                    <button type="button" className="btn" onClick={() => fileInput.current?.click()}>
                      {tr('添加附件')}
                    </button>
                    <input
                      ref={fileInput}
                      type="file"
                      multiple
                      hidden
                      onChange={(e) => {
                        void attach([...(e.target.files ?? [])]);
                        e.target.value = '';
                      }}
                    />
                  </div>
                </form>
              </div>
            </div>

            <div className="drawer-side">
              <div className="section side-card">
                <h4>{tr('负责人与进度')}</h4>
                <div>
                  {t.assignee ? withCode(t.assignee_name ?? '', t.assignee) : tr('未指派')}
                  {t.required_tags.length > 0 && <span className="faint"> · {tr('需要：{tags}', { tags: joinList(t.required_tags) })}</span>}
                </div>
                {!t.assignee && t.status === 'open' && (
                  <Suggest list={recs} label={tr('推荐指派')} onPick={(a) => void act('assign', { agent: a }, tr('已指派'))} />
                )}
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
                {t.lease_until && !closed && <div className="faint">{tr('租约到期：{time}', { time: clock(t.lease_until) })}</div>}
                {t.due_at && (
                  <div className="faint">
                    {tr('截止：{time}', { time: dateTime(t.due_at) })}
                    {(() => {
                      const d = dueInfo(t);
                      return d?.cls && <span className={`due ${d.cls}`} style={{ marginLeft: 6 }}>{d.text}</span>;
                    })()}
                  </div>
                )}
                {t.referenced_by.length > 0 && (
                  <div className="faint">
                    {tr('被引用：')}
                    {t.referenced_by.map((r) => (
                      <a key={r.id} href="#" style={{ marginRight: 6 }} title={r.title} onClick={(e) => (e.preventDefault(), openTask(r.id))}>
                        {r.id}
                      </a>
                    ))}
                  </div>
                )}
                {t.depends_on.length > 0 && (
                  <div className="faint">
                    {tr('前置任务：')}
                    {t.depends_on.map((d) => (
                      <a key={d} href="#" style={{ marginRight: 6 }} onClick={(e) => (e.preventDefault(), openTask(d))}>
                        {d}
                      </a>
                    ))}
                  </div>
                )}
              </div>
              {(t.subtasks.length > 0 || !closed) && (
                <div className="section">
                  <div className="btn-row" style={{ justifyContent: 'space-between' }}>
                    <h4>{tr('子任务')}</h4>
                    {!closed && (
                      <button className="btn small" onClick={() => setDialog('subtask')}>
                        {tr('新建子任务')}
                      </button>
                    )}
                  </div>
                  {t.subtasks.length === 0 && <div className="faint">{tr('还没有子任务')}</div>}
                  <div className="list">
                    {t.subtasks.map((s) => (
                      <div key={s.id} className="list-item clickable" onClick={() => openTask(s.id)}>
                        <StatusBadge task={s} />
                        <div style={{ flex: 1 }}>
                          <b>{s.id}</b> {s.title}
                          <div className="faint">{s.assignee_name ?? tr('未指派')}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {t.status === 'open' && !t.assignee && t.candidates && (
                <div className="section">
                  <h4>{tr('领取候选')}</h4>
                  {t.candidates.length === 0 ? (
                    <div className="faint">{tr('现在没有能自动领取的 agent（需要值守进程在线或常驻待命，并且有匹配的能力标签），可以直接指派。')}</div>
                  ) : (
                    <>
                      <div className="faint" style={{ marginBottom: 6 }}>
                        {tr('值守进程按名次错峰唤起：第 1 名立即，之后每靠后一名默认多等 10 分钟{since}；看过后不合适会让给下一名。', { since: t.open_since ? tr('（从 {time} 开始算）', { time: clock(t.open_since) }) : '' })}
                      </div>
                      <div className="list">
                        {t.candidates.map((c) => (
                          <div key={c.agent} className="list-item">
                            <span className="badge">{tr('第 {n} 名', { n: c.rank })}</span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <b>{c.agent_name || c.agent}</b> <span className="faint">{tr('匹配度 {n}', { n: c.score })}</span>
                              {(c.reasons.length > 0 || c.warnings.length > 0) && (
                                <div className="faint">
                                  {joinList([...c.reasons, ...c.warnings.map((w) => `⚠ ${w}`)])}
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
              {t.status === 'open' && !!t.passes?.length && (
                <div className="section">
                  <h4>{tr('让出记录')}</h4>
                  <div className="list">
                    {t.passes.map((p) => (
                      <div key={p.agent} className="list-item">
                        <span className="feed-time">{clock(p.created_at)}</span>
                        <span className="badge">{p.agent_name || p.agent}</span>
                        <div style={{ flex: 1 }}>{p.reason}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {t.progress_log.length > 0 && (
                <div className="section">
                  <h4>{tr('进度记录')}</h4>
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
          </div>
        )}
        {quote && (
          <button
            className="btn small primary quote-btn"
            style={{ left: Math.min(Math.max(quote.x, 70), window.innerWidth - 70), top: quote.y }}
            // 按下时不让浏览器清掉选区
            onMouseDown={(e) => e.preventDefault()}
            onClick={insertQuote}
          >
            {tr('引用到评论')}
          </button>
        )}
      </aside>

      {dialog === 'reject' && (
        <Modal title={tr('退回修改')} onClose={() => setDialog(null)}>
          <div className="field">
            <label htmlFor="reject-reason">{tr('修改意见')}</label>
            <textarea id="reject-reason" className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          </div>
          <div className="btn-row">
            <button
              className="btn primary"
              disabled={!reason.trim()}
              onClick={async () => (await act('reject', { reason }, tr('已退回'))) && setDialog(null)}
            >
              {tr('退回')}
            </button>
            <button className="btn" onClick={() => setDialog(null)}>
              {tr('算了')}
            </button>
          </div>
        </Modal>
      )}
      {dialog === 'cancel' && (
        <Modal title={tr('归档任务')} onClose={() => setDialog(null)}>
          <div className="field">
            <label htmlFor="cancel-reason">{tr('原因（可选）')}</label>
            <input id="cancel-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          </div>
          <div className="btn-row">
            <button className="btn danger" onClick={async () => (await act('cancel', { reason }, tr('已归档'))) && setDialog(null)}>
              {tr('确认归档')}
            </button>
            <button className="btn" onClick={() => setDialog(null)}>
              {tr('返回')}
            </button>
          </div>
        </Modal>
      )}
      {dialog === 'subtask' && t && (
        <NewSubtask
          parent={t}
          onClose={() => setDialog(null)}
          onCreated={() => {
            setDialog(null);
            reload();
            refresh();
          }}
        />
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

/** 负责人在已有任务下拆子任务：直接发布，可以指派，不指派就进任务池 */
function NewSubtask({ parent, onClose, onCreated }: { parent: TaskDetail; onClose: () => void; onCreated: () => void }) {
  const { agents, toast } = useHub();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [priority, setPriority] = useState(parent.priority);
  const [assignee, setAssignee] = useState('');
  const [tags, setTags] = useState(parent.required_tags.join(', '));
  const [busy, setBusy] = useState(false);
  const attachments = useAttachments(10, tr('一个任务'));
  const members = agents.filter((a) => a.status === 'active' && a.projects.some((p) => p.id === parent.project));
  const create = async () => {
    setBusy(true);
    try {
      const sub = await post<{ id: string }>('/tasks', {
        project: parent.project,
        parent: parent.id,
        title,
        description,
        acceptance: acceptance.split('\n').map((x) => x.trim()).filter(Boolean),
        priority,
        assignee: assignee || null,
        required_tags: splitList(tags),
        files: attachments.files.map((f) => f.id),
      });
      toast(tr('已发布子任务 {id}', { id: sub.id }));
      onCreated();
    } catch (err) {
      toast((err as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={tr('在 {id} 下新建子任务', { id: parent.id })} onClose={onClose}>
      <div className="field">
        <label htmlFor="st-title">{tr('标题')}</label>
        <input id="st-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </div>
      <div className="field">
        <label htmlFor="st-desc">{tr('描述')}</label>
        <textarea id="st-desc" className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="st-acc">{tr('验收标准（每行一条）')}</label>
        <textarea id="st-acc" className="textarea" style={{ minHeight: 64 }} value={acceptance} onChange={(e) => setAcceptance(e.target.value)} />
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="st-assignee">{tr('指派给')}</label>
          <select id="st-assignee" className="select" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">{tr('不指派（进入任务池）')}</option>
            {members.map((a) => (
              <option key={a.id} value={a.id}>
                {withCode(a.name || a.id, a.id)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="st-pri">{tr('优先级')}</label>
          <select id="st-pri" className="select" value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)}>
            {['P0', 'P1', 'P2', 'P3'].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="st-tags">{tr('所需能力')}</label>
        <TagPicker id="st-tags" value={tags} onChange={setTags} />
      </div>
      <div className="field">
        <label htmlFor="st-files">{tr('附件')}</label>
        <AttachmentField id="st-files" state={attachments} />
      </div>
      <div className="btn-row">
        <button className="btn primary" disabled={!title.trim() || busy || attachments.uploading > 0} onClick={create}>
          {tr('发布子任务')}
        </button>
        <button className="btn" onClick={onClose}>
          {tr('取消')}
        </button>
      </div>
    </Modal>
  );
}

function EditTask({ task, onClose, onSaved }: { task: TaskDetail; onClose: () => void; onSaved: () => void }) {
  const { toast } = useHub();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [acceptance, setAcceptance] = useState(task.acceptance.join('\n'));
  const [priority, setPriority] = useState(task.priority);
  const [tags, setTags] = useState(task.required_tags.join(', '));
  const [due, setDue] = useState(toLocalInput(task.due_at));
  const [deps, setDeps] = useState(task.depends_on.join(', '));
  const [refs, setRefs] = useState(task.refs);
  const attachments = useAttachments(10, tr('一个任务'), fromParts(task.attachments));
  const fileIds = attachments.files.map((f) => f.id);
  return (
    <Modal title={tr('编辑 {id}', { id: task.id })} onClose={onClose}>
      <div className="field">
        <label htmlFor="ed-title">{tr('标题')}</label>
        <input id="ed-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="ed-desc">{tr('描述')}</label>
        <textarea id="ed-desc" className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="ed-acc">{tr('验收标准（每行一条）')}</label>
        <textarea id="ed-acc" className="textarea" style={{ minHeight: 64 }} value={acceptance} onChange={(e) => setAcceptance(e.target.value)} />
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="ed-pri">{tr('优先级')}</label>
          <select id="ed-pri" className="select" value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)}>
            {['P0', 'P1', 'P2', 'P3'].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ed-tags">{tr('能力标签')}</label>
          <TagPicker id="ed-tags" value={tags} onChange={setTags} />
        </div>
        <div className="field">
          <label htmlFor="ed-due">{tr('截止时间')}</label>
          <input id="ed-due" type="datetime-local" className="input" value={due} onChange={(e) => setDue(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="ed-deps">{tr('前置任务')}</label>
        <input id="ed-deps" className="input" value={deps} onChange={(e) => setDeps(e.target.value)} placeholder={tr('如：P1-T3, P1-T4')} />
        <div className="hint">{tr('前置任务全部完成后，这个任务才能被领取')}</div>
      </div>
      <div className="field">
        <label htmlFor="ed-refs">{tr('引用的任务')}</label>
        <TaskPicker id="ed-refs" project={task.project} value={refs} onChange={setRefs} exclude={task.id} />
        <div className="hint">{tr('同项目的历史任务都可以引用（不限状态），agent 开工前会参考它们')}</div>
      </div>
      <div className="field">
        <label htmlFor="ed-files">{tr('附件')}</label>
        <AttachmentField id="ed-files" state={attachments} />
      </div>
      <div className="btn-row">
        <button
          className="btn primary"
          disabled={!title.trim() || attachments.uploading > 0}
          onClick={async () => {
            try {
              await patch(`/tasks/${task.id}`, {
                title,
                description,
                acceptance: acceptance.split('\n').map((s) => s.trim()).filter(Boolean),
                priority,
                required_tags: splitList(tags),
                ...(due !== toLocalInput(task.due_at) ? { due_at: due ? new Date(due).toISOString() : null } : {}),
                ...(splitList(deps).join(',') !== task.depends_on.join(',') ? { depends_on: splitList(deps).map((d) => d.toUpperCase()) } : {}),
                ...(refs.join(',') !== task.refs.join(',') ? { refs } : {}),
                ...(fileIds.join(',') !== fromParts(task.attachments).map((f) => f.id).join(',') ? { files: fileIds } : {}),
                version: task.version,
              });
              toast(tr('已保存'));
              onSaved();
            } catch (err) {
              toast((err as Error).message, true);
            }
          }}
        >
          {tr('保存')}
        </button>
        <button className="btn" onClick={onClose}>
          {tr('取消')}
        </button>
      </div>
    </Modal>
  );
}
