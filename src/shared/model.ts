// 任务状态沿用 A2A 协议的英文枚举名，界面上显示中文。
export const TASK_STATUSES = [
  'draft',
  'open',
  'assigned',
  'working',
  'input_required',
  'review',
  'completed',
  'canceled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const STATUS_LABELS: Record<TaskStatus, string> = {
  draft: '草稿',
  open: '待领取',
  assigned: '已指派',
  working: '进行中',
  input_required: '阻塞',
  review: '待验收',
  completed: '已完成',
  canceled: '已取消',
};

export const ACTIVE_STATUSES: TaskStatus[] = ['assigned', 'working', 'input_required', 'review'];

export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const TIERS = ['L1', 'L2', 'L3', 'L4'] as const;
export type Tier = (typeof TIERS)[number];

export const TIER_LABELS: Record<Tier, string> = {
  L1: '实时连接',
  L2: 'MCP',
  L3: 'HTTP 轮询',
  L4: '人工中继',
};

// 默认租约时长（分钟），每次上报进度时续期。
export const LEASE_MINUTES: Record<Tier, number> = {
  L1: 30,
  L2: 240,
  L3: 240,
  L4: 1440,
};

// 在线状态：online 有实时连接；active 10 分钟内有请求；idle 更久没出现但未超过离线阈值；offline 离线
export const PRESENCES = ['online', 'active', 'idle', 'offline'] as const;
export type Presence = (typeof PRESENCES)[number];
export const PRESENCE_LABELS: Record<Presence, string> = {
  online: '在线',
  active: '活跃',
  idle: '空闲',
  offline: '离线',
};

export type EventType =
  | 'project.created'
  | 'project.updated'
  | 'agent.joined'
  | 'agent.updated'
  | 'agent.online'
  | 'agent.offline'
  | 'agent.activity'
  | 'agent.control'
  | 'task.created'
  | 'task.updated'
  | 'task.assigned'
  | 'task.claimed'
  | 'task.status_changed'
  | 'task.progress'
  | 'task.lease_expiring'
  | 'task.due_soon'
  | 'task.overdue'
  | 'task.unlocked'
  | 'task.stalled'
  | 'task.passed'
  | 'task.unclaimed'
  | 'task.deliverable'
  | 'artifact.updated'
  | 'comment.created'
  | 'message.direct'
  | 'mention'
  | 'owner.broadcast'
  | 'receipt.updated';

export interface HubEvent {
  seq: number;
  type: EventType;
  at: string;
  actor: string; // 'owner' 或 agent 编号，如 'A-3'
  project: string | null; // 项目编号，如 'P-1'
  task: string | null; // 任务编号，如 'P1-T12'
  audience: string[] | null; // null 表示项目内所有成员可见；否则为 agent 编号列表（负责人总是可见）
  data: Record<string, unknown>;
  summary: string;
}

export interface Part {
  kind: 'text' | 'data' | 'link' | 'file';
  text?: string;
  data?: unknown;
  url?: string; // link 为外部地址；file 为 Hub 上的相对地址 /files/<id>
  name?: string;
  mime?: string;
  size?: number;
}
