import type { HubEvent, Part, Presence, TaskStatus } from '../../src/shared/model';

export type { HubEvent, Part, Presence, TaskStatus };

export interface Project {
  id: string;
  name: string;
  description: string;
  status: string;
  created_at: string;
  counts: Record<TaskStatus, number>;
  members: number;
}

export interface Agent {
  id: string;
  name: string;
  platform: string;
  tier: 'L1' | 'L2' | 'L3' | 'L4';
  description: string;
  skills: string[];
  status: string;
  created_at: string;
  last_seen_at: string | null;
  online: boolean;
  presence: Presence;
  /** 值守进程正在处理时的说明 */
  activity: { state: string; note: string; at: string } | null;
  /** 值守进程（ahub run）是否在线、是否被暂停 */
  daemon: boolean;
  daemon_paused: boolean;
  resident: boolean;
  can_invite: boolean;
  projects: { id: string; name: string; tags: string[] }[];
  active_tasks: string[];
}

export interface Task {
  id: string;
  project: string;
  title: string;
  description: string;
  acceptance: string[];
  status: TaskStatus;
  status_label: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  assignee: string | null;
  assignee_name: string | null;
  created_by: string;
  parent: string | null;
  depends_on: string[];
  /** 引用的同项目任务（参考资料） */
  refs: string[];
  required_tags: string[];
  progress: number;
  progress_note: string;
  notes: string;
  block_reason: string;
  /** 阻塞时 agent 给出的可选答案 */
  block_options: string[];
  /** 疑似原地打转 */
  stalled: boolean;
  lease_until: string | null;
  due_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface TaskBrief {
  id: string;
  title: string;
  status: TaskStatus;
  status_label: string;
  assignee: string | null;
  assignee_name: string | null;
}

export interface TaskDetail extends Task {
  subtasks: Task[];
  ref_tasks: TaskBrief[];
  referenced_by: TaskBrief[];
  comments: { id: number; author: string; author_name: string; parts: Part[]; created_at: string }[];
  artifacts: Artifact[];
  progress_log: { author: string; percent: number; note: string; created_at: string }[];
}

export interface Artifact {
  id: number;
  author: string;
  name: string;
  parts: Part[];
  created_at: string;
  /** 当前版本号 */
  rev: number;
  /** 第几次提交 */
  round: number;
  updated_at: string | null;
  updated_by: string | null;
}

export interface ArtifactRevision {
  rev: number;
  author: string;
  author_name: string;
  parts: Part[];
  note: string;
  created_at: string;
}

export interface Invite {
  code: string;
  project: string;
  tags: string[];
  max_uses: number;
  uses: number;
  expires_at: string;
  note: string;
  /** 预设的 agent 名称（空表示由 agent 自己起名） */
  agent_name: string;
  /** owner 或创建它的 agent 编号 */
  created_by: string;
  created_at: string;
  valid: boolean;
}

export interface Overview {
  counts: { working: number; review: number; input_required: number; open: number; lost: number; overdue: number; stalled: number };
  attention: Task[];
  mentions: HubEvent[];
  agents_online: number;
}

export interface Run {
  id: number;
  harness: string;
  trigger: string;
  started_at: string;
  ended_at: string;
  code: number | null;
  summary: string;
}

export interface Template {
  id: number;
  name: string;
  title: string;
  description: string;
  acceptance: string[];
  priority: Task['priority'];
  required_tags: string[];
  subtasks: string[];
  chain: boolean;
  updated_at: string;
}

export interface Message {
  id: number;
  sender: string;
  recipient: string;
  sender_name: string;
  recipient_name: string;
  body: string;
  created_at: string;
}

const TOKEN_KEY = 'ahub.owner-token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // 无痕模式下忽略
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1/admin${path}`, {
    method,
    headers: {
      authorization: `Bearer ${getToken() ?? ''}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error?.message ?? `请求失败（${res.status}）`);
  return data as T;
}

export const get = <T>(path: string) => api<T>('GET', path);
export const post = <T>(path: string, body: unknown = {}) => api<T>('POST', path, body);
export const patch = <T>(path: string, body: unknown) => api<T>('PATCH', path, body);
export const put = <T>(path: string, body: unknown) => api<T>('PUT', path, body);
export const del = <T>(path: string) => api<T>('DELETE', path);

/** 带令牌下载文件（导出报告、CSV 等），浏览器里另存为 filename。 */
export async function download(path: string, filename: string) {
  const res = await fetch(`/api/v1/admin${path}`, { headers: { authorization: `Bearer ${getToken() ?? ''}` } });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, data?.error?.message ?? `下载失败（${res.status}）`);
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface Uploaded {
  id: string;
  name: string;
  mime: string;
  size: number;
  url: string;
}

/** 上传一个文件（最大 25 MB），返回文件编号，用于评论附件。 */
export async function uploadFile(file: File): Promise<Uploaded> {
  const res = await fetch(`/api/v1/files?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${getToken() ?? ''}`, 'content-type': 'application/octet-stream' },
    body: file,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, res.status === 413 ? `${file.name} 超过 25 MB` : (data?.error?.message ?? `上传失败（${res.status}）`));
  return data as Uploaded;
}

export interface Recommendation {
  id: string;
  name: string;
  score: number;
  reasons: string[];
  warnings: string[];
  presence: Presence;
  load: number;
}
