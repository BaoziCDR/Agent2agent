// 导出：给人看的 Markdown 报告（周报），以及给表格软件用的任务 CSV。
import { json } from './db.js';
import { type Hub, type TaskView, taskCode } from './hub.js';
import type { Part } from '../shared/model.js';
import { dueNote } from './format.js';

const LIVE = ['open', 'assigned', 'working', 'input_required'];

const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hours = (h: number | null) => (h === null ? '—' : h < 1 ? `${Math.max(1, Math.round(h * 60))} 分钟` : h < 48 ? `${h} 小时` : `${Math.round(h / 24)} 天`);
const oneLine = (s: string, n = 80) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
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
    .filter((x): x is { task: TaskView; id: number } => !!x.task && x.task.status === 'completed');

  const by = (st: string) => tasks.filter((t) => t.status === st);
  const nowIso = now.toISOString();
  const overdue = tasks.filter((t) => LIVE.includes(t.status) && t.due_at && t.due_at < nowIso);
  const who = (t: TaskView) => t.assignee_name ?? '未指派';
  const L: string[] = [];
  L.push(`# 协作中枢报告：${scope ? `${scope.id}「${scope.name}」` : '全部项目'}`);
  L.push('');
  L.push(`统计区间：${from} 至 ${day(now)}（${opts.days} 天）· 生成于 ${day(now)} ${now.toTimeString().slice(0, 5)}`);
  L.push('');
  L.push('## 概览');
  L.push('');
  L.push(`- 新建任务 ${s.totals.created} 个，完成 ${s.totals.completed} 个`);
  L.push(`- 平均用时（开工到验收）：${hours(s.totals.avg_hours)}；退回率：${s.totals.reject_rate === null ? '—' : `${s.totals.reject_rate}%`}`);
  L.push(
    `- 当前：进行中 ${by('working').length}，待验收 ${by('review').length}，阻塞 ${by('input_required').length}，待领取 ${by('open').length}，已逾期 ${overdue.length}`,
  );
  L.push('');
  const section = (title: string, list: string[]) => {
    L.push(`## ${title}（${list.length}）`, '');
    L.push(list.length ? list.join('\n') : '（无）', '');
  };
  section(
    '本期完成',
    completed.map(({ task: t, id }) => {
      const d = delivery(id);
      return `- **${t.id}** ${t.title} — ${who(t)} · ${finished.get(id)!.slice(0, 10)}${d ? `\n  - 交付：${d}` : ''}`;
    }),
  );
  section(
    '进行中',
    by('working').map((t) => `- **${t.id}** ${t.title} — ${who(t)} · ${t.progress}%${t.progress_note ? ` · ${oneLine(t.progress_note, 60)}` : ''}${dueNote(t)}`),
  );
  section('待验收', by('review').map((t) => `- **${t.id}** ${t.title} — ${who(t)}`));
  section('阻塞', by('input_required').map((t) => `- **${t.id}** ${t.title} — ${who(t)} · 原因：${oneLine(t.block_reason, 60)}`));
  section('已逾期', overdue.map((t) => `- **${t.id}** ${t.title} — ${who(t)}${dueNote(t)}`));
  L.push('## 各 agent', '');
  L.push('| Agent | 完成 | 平均用时 | 提交 / 被退回 | 进行中 | 逾期 |');
  L.push('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const a of s.agents) {
    L.push(`| ${cell(a.name)}（${a.id}） | ${a.completed} | ${hours(a.avg_hours)} | ${a.submitted} / ${a.rejected} | ${a.working} | ${a.overdue} |`);
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
    ['编号', (t) => t.id],
    ['项目', (t) => t.project],
    ['标题', (t) => t.title],
    ['状态', (t) => t.status_label],
    ['优先级', (t) => t.priority],
    ['负责人', (t) => (t.assignee ? `${t.assignee_name}（${t.assignee}）` : '')],
    ['进度', (t) => `${t.progress}%`],
    ['最近进展', (t) => t.progress_note],
    ['能力标签', (t) => t.required_tags],
    ['父任务', (t) => t.parent],
    ['前置任务', (t) => t.depends_on],
    ['截止时间', (t) => t.due_at],
    ['创建时间', (t) => t.created_at],
    ['更新时间', (t) => t.updated_at],
  ];
  const tasks = hub.listTasks({ kind: 'owner' }, { project });
  const lines = [cols.map((c) => c[0]).join(','), ...tasks.map((t) => cols.map(([, f]) => csvCell(f(t))).join(','))];
  return '﻿' + lines.join('\r\n') + '\r\n';
}
