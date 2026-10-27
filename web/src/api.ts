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
  required_tags: string[];
  progress: number;
  progress_note: string;
  notes: string;
  block_reason: string;
  lease_until: string | null;
  due_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface TaskDetail extends Task {
  subtasks: Task[];
  comments: { id: number; author: string; author_name: string; parts: Part[]; created_at: string }[];
  artifacts: { id: number; author: string; name: string; parts: Part[]; created_at: string }[];
  progress_log: { author: string; percent: number; note: string; created_at: string }[];
}

export interface Invite {
  code: string;
  project: string;
  tags: string[];
  max_uses: number;
  uses: number;
  expires_at: string;
  note: string;
  created_at: string;
  valid: boolean;
}

export interface Overview {
  counts: { working: number; review: number; input_required: number; open: number; lost: number; overdue: number };
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
export const del = <T>(path: string) => api<T>('DELETE', path);
