import { useState } from 'react';
import { t } from '../i18n';
import { patch, post, type Project } from '../api';
import { Modal, useHub } from '../ui';

export function Projects() {
  const { projects, setProject, toast, refresh, go } = useHub();
  const [creating, setCreating] = useState(projects.length === 0);
  const [editing, setEditing] = useState<Project | null>(null);

  return (
    <div style={{ maxWidth: 900 }}>
      <div className="btn-row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <h1 className="page-title">{t('项目')}</h1>
          <p className="page-sub" style={{ margin: 0 }}>
            {t('每个项目有独立的任务板和成员。项目说明会出现在 agent 的入职简报里，写清背景、约定和代码位置。')}
          </p>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}>
          {t('新建项目')}
        </button>
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
        {projects.map((p) => {
          const active = p.counts.assigned + p.counts.working + p.counts.input_required + p.counts.review;
          return (
            <div key={p.id} className="card" style={{ opacity: p.status === 'active' ? 1 : 0.6 }}>
              <div className="faint">
                {p.id}
                {p.status === 'archived' && t(' · 已归档')}
              </div>
              <h3 style={{ margin: '2px 0 6px', fontSize: 16 }}>{p.name}</h3>
              <p className="muted" style={{ margin: '0 0 10px', whiteSpace: 'pre-wrap', maxHeight: 66, overflow: 'hidden' }}>
                {p.description || t('（还没有项目说明）')}
              </p>
              <div className="faint" style={{ marginBottom: 10 }}>
                {t('{members} 个成员 · 进行中 {active} · 待领取 {open} · 已完成 {completed}', { members: p.members, active, open: p.counts.open, completed: p.counts.completed })}
              </div>
              <div className="btn-row">
                <button
                  className="btn small"
                  onClick={() => {
                    setProject(p.id);
                    go('board');
                  }}
                >
                  {t('打开看板')}
                </button>
                <button className="btn small" onClick={() => setEditing(p)}>
                  {t('编辑')}
                </button>
                <button
                  className="btn small"
                  onClick={async () => {
                    try {
                      await patch(`/projects/${p.id}`, { status: p.status === 'active' ? 'archived' : 'active' });
                      refresh();
                    } catch (err) {
                      toast((err as Error).message, true);
                    }
                  }}
                >
                  {p.status === 'active' ? t('归档') : t('恢复')}
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {creating && (
        <ProjectForm
          title={t('新建项目')}
          onClose={() => setCreating(false)}
          onSave={async (name, description) => {
            const p = await post<Project>('/projects', { name, description });
            setProject(p.id);
            toast(t('已创建 {id}', { id: p.id }));
            refresh();
            setCreating(false);
          }}
        />
      )}
      {editing && (
        <ProjectForm
          title={t('编辑 {id}', { id: editing.id })}
          initial={editing}
          onClose={() => setEditing(null)}
          onSave={async (name, description) => {
            await patch(`/projects/${editing.id}`, { name, description });
            toast(t('已保存'));
            refresh();
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function ProjectForm({
  title,
  initial,
  onClose,
  onSave,
}: {
  title: string;
  initial?: Project;
  onClose: () => void;
  onSave: (name: string, description: string) => Promise<void>;
}) {
  const { toast } = useHub();
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  return (
    <Modal title={title} onClose={onClose}>
      <div className="field">
        <label htmlFor="pf-name">{t('名称')}</label>
        <input id="pf-name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </div>
      <div className="field">
        <label htmlFor="pf-desc">{t('项目说明')}</label>
        <textarea
          id="pf-desc"
          className="textarea"
          style={{ minHeight: 140 }}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('目标、背景、代码仓库位置、约定（分支命名、提交规范）等')}
        />
      </div>
      <div className="btn-row">
        <button
          className="btn primary"
          disabled={!name.trim()}
          onClick={() => onSave(name, description).catch((err: Error) => toast(err.message, true))}
        >
          {t('保存')}
        </button>
        <button className="btn" onClick={onClose}>
          {t('取消')}
        </button>
      </div>
    </Modal>
  );
}
