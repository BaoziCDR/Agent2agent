// 导出：给人看的 Markdown 报告（周报），以及给表格软件用的任务 CSV。
import { json } from './db.js';
import { type Hub, type TaskView, taskCode } from './hub.js';
import type { Part } from '../shared/model.js';
import { dueNote } from './format.js';
import { tr } from '../i18n/index.js';

const LIVE = ['open', 'assigned', 'working', 'input_required'];

const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hours = (h: number | null) => (h === null ? '—' : h < 1 ? tr('{n} 分钟', { n: Math.max(1, Math.round(h * 60)) }) : h < 48 ? tr('{h} 小时', { h }) : tr('{n} 天', { n: Math.round(h / 24) }));
const oneLine = (s: string, n = 80) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
/** 表格软件里看本地时间：2026-10-27 11:03 */
const localTime = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${day(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const cell = (s: string) => s.replace(/\|/g, '\\|');

export function renderReport(hub: Hub, opts: { project?: string; days: number; now?: Date }) {
  const now = opts.now ?? new Date();
  const s = hub.stats(opts.project, opts.days);
  const from = s.days[0]?.date ?? day(now);
  const scope = opts.project ? hub.getProject(opts.project) : null;
  const tasks = hub.listTasks({ kind: 'owner' }, { project: opts.project });
  const projectId = scope ? Number(scope.id.slice(2)) : null;

  // 本期完成的任务：完成时间、交付说明
  const done = hub.db
    .prepare(
      `SELECT e.at, e.task_id FROM events e WHERE e.type = 'task.status_changed' AND json_extract(e.data, '$.to') = 'completed'
         AND e.at >= ? ${projectId === null ? '' : 'AND e.project_id = ?'} ORDER BY e.seq`,
    )
    .all(new Date(`${from}T00:00:00`).toISOString(), ...(projectId === null ? [] : [projectId])) as { at: string; task_id: number }[];
  const finished = new Map<number, string>();
  for (const d of done) finished.set(d.task_id, d.at);
  const delivery = (taskId: number) => {
    const row = hub.db.prepare("SELECT parts FROM artifacts WHERE task_id = ? AND name = '交付说明' ORDER BY id DESC LIMIT 1").get(taskId) as
      | { parts: string }
      | undefined;
    return row ? oneLine(json<Part[]>(row.parts, []).map((p) => p.text ?? '').join(' ')) : '';
  };
  const rowsOf = [...finished.keys()].map((id) => hub.db.prepare('SELECT project_id, num FROM tasks WHERE id = ?').get(id) as { project_id: number; num: number });
  const completed = rowsOf
    .map((r, i) => ({ task: tasks.find((t) => t.id === taskCode(r.project_id, r.num)), id: [...finished.keys()][i] }))
    .filter((x): x is { task: TaskView; id: number } => !!x.task && (x.task.status === 'completed' || x.task.archive_kind === 'auto'));

  const by = (st: string) => tasks.filter((t) => t.status === st);
  const nowIso = now.toISOString();
  const overdue = tasks.filter((t) => LIVE.includes(t.status) && t.due_at && t.due_at < nowIso);
  const who = (t: TaskView) => t.assignee_name ?? tr('未指派');
  const L: string[] = [];
  L.push(tr('# 协作中枢报告：{v}', { v: scope ? tr('{id}「{name}」', { id: scope.id, name: scope.name }) : tr('全部项目') }));
  L.push('');
  L.push(tr('统计区间：{from} 至 {day}（{days} 天）· 生成于 {day} {v}', { from, day: day(now), days: opts.days, v: now.toTimeString().slice(0, 5) }));
  L.push('');
  L.push(tr('## 概览'));
  L.push('');
  L.push(tr('- 新建任务 {created} 个，完成 {completed} 个', { created: s.totals.created, completed: s.totals.completed }));
  L.push(tr('- 平均用时（开工到验收）：{hours}；退回率：{v}', { hours: hours(s.totals.avg_hours), v: s.totals.reject_rate === null ? '—' : `${s.totals.reject_rate}%` }));
  L.push(
    tr('- 当前：进行中 {n}，待验收 {n2}，阻塞 {n3}，待领取 {n4}，已逾期 {n5}', { n: by('working').length, n2: by('review').length, n3: by('input_required').length, n4: by('open').length, n5: overdue.length }),
  );
  L.push('');
  const section = (title: string, list: string[]) => {
    L.push(tr('## {title}（{n}）', { title, n: list.length }), '');
    L.push(list.length ? list.join('\n') : tr('（无）'), '');
  };
  section(
    tr('本期完成'),
    completed.map(({ task: t, id }) => {
      const d = delivery(id);
      return `- **${t.id}** ${t.title} — ${who(t)} · ${finished.get(id)!.slice(0, 10)}${d ? tr('\n  - 交付：{d}', { d }) : ''}`;
    }),
  );
  section(
    tr('进行中'),
    by('working').map((t) => `- **${t.id}** ${t.title} — ${who(t)} · ${t.progress}%${t.progress_note ? ` · ${oneLine(t.progress_note, 60)}` : ''}${dueNote(t)}`),
  );
  section(tr('待验收'), by('review').map((t) => `- **${t.id}** ${t.title} — ${who(t)}`));
  section(tr('阻塞'), by('input_required').map((t) => tr('- **{id}** {title} — {who} · 原因：{v}', { id: t.id, title: t.title, who: who(t), v: oneLine(t.block_reason, 60) })));
  section(tr('已逾期'), overdue.map((t) => `- **${t.id}** ${t.title} — ${who(t)}${dueNote(t)}`));
  L.push(tr('## 各 agent'), '');
  L.push(tr('| Agent | 完成 | 平均用时 | 提交 / 被退回 | 进行中 | 逾期 |'));
  L.push('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const a of s.agents) {
    L.push(tr('| {cell}（{id}） | {completed} | {hours} | {submitted} / {rejected} | {working} | {overdue} |', { cell: cell(a.name), id: a.id, completed: a.completed, hours: hours(a.avg_hours), submitted: a.submitted, rejected: a.rejected, working: a.working, overdue: a.overdue }));
  }
  return L.join('\n') + '\n';
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : Array.isArray(v) ? v.join(' ') : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** 所有任务一行一个；带 BOM，Excel 直接打开不会乱码 */
export function tasksCsv(hub: Hub, project?: string) {
  const cols: [string, (t: TaskView) => unknown][] = [
    [tr('编号'), (t) => t.id],
    [tr('项目'), (t) => t.project],
    [tr('标题'), (t) => t.title],
    [tr('状态'), (t) => t.status_label],
    [tr('优先级'), (t) => t.priority],
    [tr('负责人'), (t) => (t.assignee ? tr('{assignee_name}（{assignee}）', { assignee_name: t.assignee_name, assignee: t.assignee }) : '')],
    [tr('进度'), (t) => `${t.progress}%`],
    [tr('最近进展'), (t) => t.progress_note],
    [tr('能力标签'), (t) => t.required_tags],
    [tr('父任务'), (t) => t.parent],
    [tr('前置任务'), (t) => t.depends_on],
    [tr('截止时间'), (t) => localTime(t.due_at)],
    [tr('创建时间'), (t) => localTime(t.created_at)],
    [tr('更新时间'), (t) => localTime(t.updated_at)],
  ];
  const tasks = hub.listTasks({ kind: 'owner' }, { project });
  const lines = [cols.map((c) => c[0]).join(','), ...tasks.map((t) => cols.map(([, f]) => csvCell(f(t))).join(','))];
  return '﻿' + lines.join('\r\n') + '\r\n';
}
