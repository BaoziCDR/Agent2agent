// 选择同项目的任务（发布任务时引用历史任务）：输入编号或标题搜索，选中的显示为可移除的标签。
import { useMemo, useState } from 'react';
import { get, type Task } from './api';
import { StatusBadge, useData } from './ui';

export function TaskPicker({
  project,
  value,
  onChange,
  exclude,
  id,
}: {
  project: string;
  value: string[];
  onChange: (v: string[]) => void;
  exclude?: string;
  id?: string;
}) {
  const { data: tasks } = useData(() => (project ? get<Task[]>(`/tasks?project=${project}`) : Promise.resolve([] as Task[])), [project]);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const byId = useMemo(() => new Map((tasks ?? []).map((t) => [t.id, t])), [tasks]);
  const query = q.trim().toLowerCase();
  // 最近的任务排在前面；已选的和当前任务不再出现
  const matches = (tasks ?? [])
    .filter((t) => t.id !== exclude && !value.includes(t.id))
    .filter((t) => !query || t.id.toLowerCase().includes(query) || t.title.toLowerCase().includes(query))
    .slice()
    .reverse()
    .slice(0, 8);
  const add = (tid: string) => {
    onChange([...value, tid]);
    setQ('');
  };
  return (
    <div className="task-picker">
      {value.length > 0 && (
        <div className="picked">
          {value.map((tid) => {
            const t = byId.get(tid);
            return (
              <span key={tid} className="picked-item">
                {t && <StatusBadge task={t} />}
                <b>{tid}</b>
                {t && <span className="picked-title">{t.title}</span>}
                <button type="button" aria-label={`移除 ${tid}`} onClick={() => onChange(value.filter((x) => x !== tid))}>
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}
      <input
        id={id}
        className="input"
        value={q}
        placeholder="输入编号或标题搜索同项目的任务（任意状态）"
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && matches[0]) {
            e.preventDefault();
            add(matches[0].id);
          }
        }}
      />
      {open && matches.length > 0 && (
        <div className="picker-menu" role="listbox">
          {matches.map((t) => (
            <button key={t.id} type="button" role="option" aria-selected={false} className="picker-option" onMouseDown={(e) => e.preventDefault()} onClick={() => add(t.id)}>
              <StatusBadge task={t} />
              <b>{t.id}</b>
              <span className="picked-title">{t.title}</span>
              {t.assignee_name && <span className="faint">{t.assignee_name}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
