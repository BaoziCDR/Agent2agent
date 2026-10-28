import { useState } from 'react';
import { msg, t as tr, withCode } from '../i18n';
import { del, get, post, type Task, type Template } from '../api';
import { Modal, TagPicker, splitList, useData, useHub } from '../ui';
import { Suggest, useRecommend } from '../suggest';
import { TaskPicker } from '../taskpicker';
import { AttachmentField, useAttachments } from '../attach';

const lines = (s: string) =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

export function NewTask() {
  const { projects, project, agents, toast, openTask, refresh } = useHub();
  const active = projects.filter((p) => p.status === 'active');
  const [targetChoice, setTarget] = useState('');
  const target = targetChoice || (project ?? active[0]?.id ?? '');
  const [mode, setMode] = useState<'single' | 'batch'>('single');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [priority, setPriority] = useState('P2');
  const [assignee, setAssignee] = useState('');
  const [tags, setTags] = useState('');
  const [depends, setDepends] = useState('');
  const [refs, setRefs] = useState<string[]>([]);
  const attachments = useAttachments(10, tr('一个任务'));
  const [due, setDue] = useState('');
  const [batch, setBatch] = useState('');
  const [subtasks, setSubtasks] = useState('');
  const [chain, setChain] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tplId, setTplId] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const { data: templates, reload: reloadTemplates } = useData(() => get<Template[]>('/templates'), []);
  const tpl = templates?.find((t) => String(t.id) === tplId);
  const recs = useRecommend({ project: target, tags, title }, mode === 'single');

  const applyTemplate = (id: string) => {
    setTplId(id);
    const t = templates?.find((x) => String(x.id) === id);
    if (!t) return;
    setMode('single');
    setTitle(t.title);
    setDescription(t.description);
    setAcceptance(t.acceptance.join('\n'));
    setPriority(t.priority);
    setTags(t.required_tags.join(', '));
    setSubtasks(t.subtasks.join('\n'));
    setChain(t.chain);
  };

  const saveTemplate = async (name: string) => {
    try {
      await post<Template>('/templates', {
        name,
        title,
        description,
        acceptance: lines(acceptance),
        priority,
        required_tags: splitList(tags),
        subtasks: lines(subtasks),
        chain,
      });
      toast(tr('已保存模板「{name}」', { name }));
      setSaving(null);
      reloadTemplates();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  const members = agents.filter((a) => a.status === 'active' && a.projects.some((p) => p.id === target));

  if (active.length === 0) return <p className="muted">{tr('请先在「项目」页创建一个项目。')}</p>;

  const submit = async (draft: boolean) => {
    setBusy(true);
    try {
      if (mode === 'single') {
        const t = await post<Task>('/tasks', {
          project: target,
          title,
          description,
          acceptance: lines(acceptance),
          priority,
          assignee: assignee || null,
          required_tags: splitList(tags),
          depends_on: splitList(depends),
          refs,
          files: attachments.files.map((f) => f.id),
          due_at: due ? new Date(due).toISOString() : null,
          draft,
        });
        let prev: string | null = null;
        const subs = lines(subtasks);
        for (const line of subs) {
          const st: Task = await post<Task>('/tasks', {
            project: target,
            parent: t.id,
            title: line,
            priority,
            required_tags: splitList(tags),
            depends_on: chain && prev ? [prev] : [],
            draft,
          });
          prev = st.id;
        }
        toast(tr(draft ? msg('已保存草稿 {id}') : msg('已发布 {id}'), { id: t.id }) + (subs.length ? tr('，含 {n} 个子任务', { n: subs.length }) : ''));
        setTitle('');
        setDescription('');
        setAcceptance('');
        setAssignee('');
        setSubtasks('');
        setRefs([]);
        attachments.setFiles([]);
        setTplId('');
        openTask(t.id);
      } else {
        const titles = batch.split('\n').map((s) => s.trim()).filter(Boolean);
        for (const line of titles) {
          await post<Task>('/tasks', { project: target, title: line, priority, required_tags: splitList(tags), draft });
        }
        toast(tr(draft ? msg('已保存 {n} 个任务') : msg('已发布 {n} 个任务'), { n: titles.length }));
        setBatch('');
      }
      refresh();
    } catch (err) {
      toast((err as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = (mode === 'single' ? !!title.trim() : !!batch.trim()) && attachments.uploading === 0;

  return (
    <div style={{ maxWidth: 760 }}>
      <h1 className="page-title">{tr('发布任务')}</h1>
      <p className="page-sub">{tr('写清楚要做什么、怎样算完成；指派给某个 agent，或放进任务池让匹配的 agent 领取。')}</p>
      <div className="tabs">
        <button className={`tab ${mode === 'single' ? 'active' : ''}`} onClick={() => setMode('single')}>
          {tr('单个任务')}
        </button>
        <button className={`tab ${mode === 'batch' ? 'active' : ''}`} onClick={() => setMode('batch')}>
          {tr('批量创建')}
        </button>
      </div>
      <div className="card">
        {mode === 'single' && (
          <div className="template-bar">
            <select className="select" value={tplId} onChange={(e) => applyTemplate(e.target.value)} aria-label={tr('从模板创建')}>
              <option value="">{templates?.length ? tr('从模板创建…') : tr('还没有模板')}</option>
              {templates?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.subtasks.length ? tr('（含 {n} 个子任务）', { n: t.subtasks.length }) : ''}
                </option>
              ))}
            </select>
            <button className="btn small" disabled={!title.trim()} onClick={() => setSaving(tpl?.name ?? title.trim())}>
              {tpl ? tr('更新模板') : tr('存为模板')}
            </button>
            {tpl && (
              <button
                className="btn small danger"
                onClick={async () => {
                  if (!confirm(tr('删除模板「{name}」？', { name: tpl.name }))) return;
                  await del(`/templates/${tpl.id}`);
                  setTplId('');
                  reloadTemplates();
                  toast(tr('已删除模板'));
                }}
              >
                {tr('删除模板')}
              </button>
            )}
          </div>
        )}
        <div className="field-row">
          <div className="field">
            <label htmlFor="nt-project">{tr('项目')}</label>
            <select id="nt-project" className="select" value={target} onChange={(e) => (setTarget(e.target.value), setRefs([]))}>
              {active.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id} · {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="nt-priority">{tr('优先级')}</label>
            <select id="nt-priority" className="select" value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option value="P0">{tr('P0 紧急')}</option>
              <option value="P1">{tr('P1 高')}</option>
              <option value="P2">{tr('P2 普通')}</option>
              <option value="P3">{tr('P3 低')}</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="nt-tags">{tr('需要的能力标签')}</label>
            <TagPicker id="nt-tags" value={tags} onChange={setTags} placeholder={tr('留空则所有成员都能领取；设置里配置了外部模型时，发布后会自动打标签')} />
          </div>
        </div>
        {mode === 'single' ? (
          <>
            <div className="field">
              <label htmlFor="nt-title">{tr('标题')}</label>
              <input id="nt-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={tr('一句话说清要做什么')} />
            </div>
            <div className="field">
              <label htmlFor="nt-desc">{tr('描述')}</label>
              <textarea id="nt-desc" className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={tr('背景、要求、相关文件路径等（支持 Markdown）')} />
            </div>
            <div className="field">
              <label htmlFor="nt-acc">{tr('验收标准')}</label>
              <textarea id="nt-acc" className="textarea" style={{ minHeight: 64 }} value={acceptance} onChange={(e) => setAcceptance(e.target.value)} placeholder={tr('每行一条')} />
            </div>
            <div className="field">
              <label htmlFor="nt-files">{tr('附件（可选）')}</label>
              <AttachmentField id="nt-files" state={attachments} hint={tr('需求文档、设计稿、截图等；可以拖到这里或点一下这里再粘贴，每个最大 25 MB，最多 10 个')} />
              <span className="hint">{tr('agent 接到任务后会用 ahub download 把附件下载到本地再开工')}</span>
            </div>
            <div className="field">
              <label htmlFor="nt-refs">{tr('引用历史任务（可选）')}</label>
              <TaskPicker id="nt-refs" project={target} value={refs} onChange={setRefs} />
              <span className="hint">{tr('同项目的任何任务都可以引用，不限状态；agent 开工前会读它们的详情、交付物和讨论')}</span>
            </div>
            <div className="field-row">
              <div className="field">
                <label htmlFor="nt-assignee">{tr('指派给')}</label>
                <select id="nt-assignee" className="select" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                  <option value="">{tr('不指派（放入任务池）')}</option>
                  {members.map((a) => (
                    <option key={a.id} value={a.id}>
                      {withCode(a.name, a.id)}
                    </option>
                  ))}
                </select>
                <Suggest list={recs} selected={assignee} onPick={(id) => setAssignee(assignee === id ? '' : id)} />
              </div>
              <div className="field">
                <label htmlFor="nt-deps">{tr('前置任务')}</label>
                <input id="nt-deps" className="input" value={depends} onChange={(e) => setDepends(e.target.value)} placeholder={tr('如：P1-T3, P1-T4')} />
              </div>
              <div className="field">
                <label htmlFor="nt-due">{tr('截止时间')}</label>
                <input id="nt-due" type="datetime-local" className="input" value={due} onChange={(e) => setDue(e.target.value)} />
              </div>
            </div>
            <div className="field">
              <label htmlFor="nt-subs">{tr('子任务（可选）')}</label>
              <textarea
                id="nt-subs"
                className="textarea"
                value={subtasks}
                onChange={(e) => setSubtasks(e.target.value)}
                placeholder={tr('每行一个子任务标题，发布时一起创建，沿用上面的优先级和能力标签')}
              />
              <label className="faint" style={{ display: 'flex', gap: 4, alignItems: 'center', fontWeight: 400 }}>
                <input type="checkbox" checked={chain} onChange={(e) => setChain(e.target.checked)} /> {tr('按顺序依次进行（后一个以前一个为前置任务）')}
              </label>
            </div>
          </>
        ) : (
          <div className="field">
            <label htmlFor="nt-batch">{tr('任务标题')}</label>
            <textarea id="nt-batch" className="textarea" style={{ minHeight: 180 }} value={batch} onChange={(e) => setBatch(e.target.value)} placeholder={tr('每行一个任务\n例如：\n设计数据库表\n实现登录接口\n编写接口文档')} />
            <span className="hint">{tr('批量创建的任务都放入任务池，使用上面的优先级和能力标签。')}</span>
          </div>
        )}
        <div className="btn-row">
          <button className="btn primary" disabled={!canSubmit || busy} onClick={() => submit(false)}>
            {tr('发布')}
          </button>
          <button className="btn" disabled={!canSubmit || busy} onClick={() => submit(true)}>
            {tr('存为草稿')}
          </button>
        </div>
      </div>
      {saving !== null && (
        <Modal title={tpl ? tr('更新模板') : tr('存为模板')} onClose={() => setSaving(null)}>
          <div className="field">
            <label htmlFor="tpl-name">{tr('模板名称')}</label>
            <input
              id="tpl-name"
              className="input"
              value={saving}
              onChange={(e) => setSaving(e.target.value)}
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && saving.trim() && saveTemplate(saving.trim())}
            />
            <span className="hint">{tr('保存标题、描述、验收标准、优先级、能力标签和子任务；同名模板会被覆盖。')}</span>
          </div>
          <div className="btn-row">
            <button className="btn primary" disabled={!saving.trim()} onClick={() => saveTemplate(saving.trim())}>
              {tr('保存')}
            </button>
            <button className="btn" onClick={() => setSaving(null)}>
              {tr('取消')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
