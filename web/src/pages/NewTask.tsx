import { useState } from 'react';
import { post, type Task } from '../api';
import { splitList, useHub } from '../ui';

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
  const [due, setDue] = useState('');
  const [batch, setBatch] = useState('');
  const [busy, setBusy] = useState(false);

  const members = agents.filter((a) => a.status === 'active' && a.projects.some((p) => p.id === target));

  if (active.length === 0) return <p className="muted">请先在「项目」页创建一个项目。</p>;

  const submit = async (draft: boolean) => {
    setBusy(true);
    try {
      if (mode === 'single') {
        const t = await post<Task>('/tasks', {
          project: target,
          title,
          description,
          acceptance: acceptance.split('\n').map((s) => s.trim()).filter(Boolean),
          priority,
          assignee: assignee || null,
          required_tags: splitList(tags),
          depends_on: splitList(depends),
          due_at: due ? new Date(due).toISOString() : null,
          draft,
        });
        toast(`已${draft ? '保存草稿' : '发布'} ${t.id}`);
        setTitle('');
        setDescription('');
        setAcceptance('');
        setAssignee('');
        openTask(t.id);
      } else {
        const titles = batch.split('\n').map((s) => s.trim()).filter(Boolean);
        for (const line of titles) {
          await post<Task>('/tasks', { project: target, title: line, priority, required_tags: splitList(tags), draft });
        }
        toast(`已${draft ? '保存' : '发布'} ${titles.length} 个任务`);
        setBatch('');
      }
      refresh();
    } catch (err) {
      toast((err as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = mode === 'single' ? !!title.trim() : !!batch.trim();

  return (
    <div style={{ maxWidth: 760 }}>
      <h1 className="page-title">发布任务</h1>
      <p className="page-sub">写清楚要做什么、怎样算完成；指派给某个 agent，或放进任务池让匹配的 agent 领取。</p>
      <div className="tabs">
        <button className={`tab ${mode === 'single' ? 'active' : ''}`} onClick={() => setMode('single')}>
          单个任务
        </button>
        <button className={`tab ${mode === 'batch' ? 'active' : ''}`} onClick={() => setMode('batch')}>
          批量创建
        </button>
      </div>
      <div className="card">
        <div className="field-row">
          <div className="field">
            <label htmlFor="nt-project">项目</label>
            <select id="nt-project" className="select" value={target} onChange={(e) => setTarget(e.target.value)}>
              {active.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id} · {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="nt-priority">优先级</label>
            <select id="nt-priority" className="select" value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option value="P0">P0 紧急</option>
              <option value="P1">P1 高</option>
              <option value="P2">P2 普通</option>
              <option value="P3">P3 低</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="nt-tags">需要的能力标签</label>
            <input id="nt-tags" className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="如：前端, 测试" />
          </div>
        </div>
        {mode === 'single' ? (
          <>
            <div className="field">
              <label htmlFor="nt-title">标题</label>
              <input id="nt-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="一句话说清要做什么" />
            </div>
            <div className="field">
              <label htmlFor="nt-desc">描述</label>
              <textarea id="nt-desc" className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="背景、要求、相关文件路径等（支持 Markdown）" />
            </div>
            <div className="field">
              <label htmlFor="nt-acc">验收标准</label>
              <textarea id="nt-acc" className="textarea" style={{ minHeight: 64 }} value={acceptance} onChange={(e) => setAcceptance(e.target.value)} placeholder="每行一条" />
            </div>
            <div className="field-row">
              <div className="field">
                <label htmlFor="nt-assignee">指派给</label>
                <select id="nt-assignee" className="select" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                  <option value="">不指派（放入任务池）</option>
                  {members.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}（{a.id}）
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="nt-deps">前置任务</label>
                <input id="nt-deps" className="input" value={depends} onChange={(e) => setDepends(e.target.value)} placeholder="如：P1-T3, P1-T4" />
              </div>
              <div className="field">
                <label htmlFor="nt-due">截止时间</label>
                <input id="nt-due" type="datetime-local" className="input" value={due} onChange={(e) => setDue(e.target.value)} />
              </div>
            </div>
          </>
        ) : (
          <div className="field">
            <label htmlFor="nt-batch">任务标题</label>
            <textarea id="nt-batch" className="textarea" style={{ minHeight: 180 }} value={batch} onChange={(e) => setBatch(e.target.value)} placeholder={'每行一个任务\n例如：\n设计数据库表\n实现登录接口\n编写接口文档'} />
            <span className="hint">批量创建的任务都放入任务池，使用上面的优先级和能力标签。</span>
          </div>
        )}
        <div className="btn-row">
          <button className="btn primary" disabled={!canSubmit || busy} onClick={() => submit(false)}>
            发布
          </button>
          <button className="btn" disabled={!canSubmit || busy} onClick={() => submit(true)}>
            存为草稿
          </button>
        </div>
      </div>
    </div>
  );
}
