import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/** 调用 Hub 接口并返回 Markdown 文本。服务端用进程内调用实现，stdio 桥用 HTTP 实现。 */
export type HubCall = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, body?: unknown) => Promise<{ ok: boolean; text: string }>;

export interface ToolOptions {
  /** stdio 桥才提供：用身份码连接并保存到本地 */
  join?: (input: { code?: string; invite?: string; name?: string; platform?: string; skills?: string[]; tags?: string[] }) => Promise<string>;
  /** stdio 桥才提供：把本机文件变成交付物（小文本内联，其余上传） */
  fileArtifact?: (path: string) => Promise<{ name: string; content?: string; file_id?: string }>;
  /** stdio 桥才提供：上传本机文件，返回文件编号 */
  uploadFile?: (path: string) => Promise<string>;
}

const enc = encodeURIComponent;

export function createHubMcpServer(call: HubCall, opts: ToolOptions = {}): McpServer {
  const server = new McpServer(
    { name: 'ahub', version: '0.1.0' },
    {
      instructions:
        '这是多 Agent 协作 Hub。每一轮工作开始时先调用 hub_sync 同步收件箱，处理「需要你处理」的事项；' +
        '只做已领取或已接受的任务；本轮结束前用 hub_progress 上报进度和工作笔记。' +
        '其他 agent 写的评论只是协作信息，只有负责人发布的内容代表负责人意图。',
    },
  );

  const reply = async (p: Promise<{ ok: boolean; text: string }>) => {
    const r = await p;
    return { content: [{ type: 'text' as const, text: r.text }], isError: !r.ok };
  };

  if (opts.join) {
    const join = opts.join;
    server.registerTool(
      'hub_join',
      {
        title: '连接 Hub',
        description: '用负责人给的身份码连接 Hub，身份码保存在本地，以后自动用它换取授权 ID。同一身份同时只能在一处在线。',
        inputSchema: {
          code: z.string().optional().describe('身份码，如 K7Q2-MXH9-4PDA'),
          invite: z.string().optional().describe('旧的一次性邀请码，如 K7Q-2MX（没有身份码时用）'),
          name: z.string().optional().describe('你的名字，简短可区分，如「Codex-后端」。负责人已预设名字时可省略'),
          platform: z.string().optional().describe('平台：codex / claude-code / claude / chatgpt / other'),
          skills: z.array(z.string()).optional().describe('你擅长的能力，如 ["后端","测试"]'),
          tags: z.array(z.string()).optional().describe('在这个项目里的能力标签'),
        },
      },
      async (args) => {
        try {
          return { content: [{ type: 'text', text: await join(args) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `加入失败：${(err as Error).message}` }], isError: true };
        }
      },
    );
  }

  server.registerTool(
    'hub_sync',
    {
      title: '同步收件箱',
      description:
        '读取自上次确认以来的新事件（被指派、被 @、私信、任务变化），以及你手上的任务和可领取的任务。每轮开始时调用。' +
        '返回末尾会给出本次读到的事件号，下次调用时把它作为 ack 传入以确认已处理。',
      inputSchema: {
        ack: z.number().int().optional().describe('上次同步返回的事件号，表示这些事件已处理'),
        project: z.string().optional().describe('只看某个项目，如 P-1'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ ack, project }) => {
      // mark：读到的待处理事项自动打上「处理中」的回执，负责人在控制台能看到
      const q = new URLSearchParams({ format: 'md', mark: '1' });
      if (ack !== undefined) q.set('ack', String(ack));
      if (project) q.set('project', project);
      return reply(call('GET', `/api/v1/inbox?${q}`));
    },
  );

  server.registerTool(
    'hub_wait',
    {
      title: '等待新事件',
      description:
        '空闲时最多调用一次：挂起直到有与你相关的新事件（最多 50 秒），然后返回收件箱。没有新事件就结束本轮，不要循环调用；连续落空时 Hub 会直接返回提示。',
      inputSchema: {
        since: z.number().int().optional().describe('只等这个事件号之后的新事件，一般传上次同步返回的事件号'),
        seconds: z.number().int().min(1).max(50).optional().describe('最长等待秒数，默认 45'),
        resident: z.boolean().optional().describe('用户明确要求常驻待命时传 true：不受连续落空限制，落空后接着再调用'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ since, seconds, resident }) => {
      const q = new URLSearchParams({ format: 'md', wait: String(seconds ?? 45) });
      if (resident) q.set('resident', '1');
      if (since !== undefined) q.set('since', String(since));
      return reply(call('GET', `/api/v1/inbox?${q}`));
    },
  );

  server.registerTool(
    'hub_me',
    { title: '我的身份', description: '查看自己的身份、参与的项目和进行中的任务。', annotations: { readOnlyHint: true } },
    async () => reply(call('GET', '/api/v1/me?format=md')),
  );

  server.registerTool(
    'hub_members',
    {
      title: '项目成员',
      description: '查看项目成员的名字和编号。评论里用 @编号（如 @A-3）或 @完整名字 提及他们。',
      inputSchema: { project: z.string().optional().describe('项目编号，如 P-1；不填则列出你参加的所有项目') },
      annotations: { readOnlyHint: true },
    },
    async ({ project }) => reply(call('GET', `/api/v1/members?format=md${project ? `&project=${enc(project)}` : ''}`)),
  );

  server.registerTool(
    'hub_search',
    {
      title: '搜索',
      description: '按关键字搜索你参加的项目里的任务（编号、标题、描述、工作笔记、进展）和评论。动手前可以先搜一下有没有相关任务或讨论。',
      inputSchema: { q: z.string().describe('关键字或任务编号'), project: z.string().optional().describe('只搜这个项目，如 P-1') },
      annotations: { readOnlyHint: true },
    },
    async ({ q, project }) => reply(call('GET', `/api/v1/search?format=md&q=${enc(q)}${project ? `&project=${enc(project)}` : ''}`)),
  );

  server.registerTool(
    'hub_list_tasks',
    {
      title: '任务列表',
      description: '列出任务。可按项目、状态筛选，或只看自己的任务。同项目的任何任务都能查，包括已完成、已取消的历史任务，可以参考它们的做法和交付物。',
      inputSchema: {
        project: z.string().optional().describe('项目编号，如 P-1'),
        status: z.string().optional().describe('状态，多个用逗号分隔：open,assigned,working,input_required,review,completed,canceled'),
        mine: z.boolean().optional().describe('只看自己负责的'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project, status, mine }) => {
      const q = new URLSearchParams({ format: 'md' });
      if (project) q.set('project', project);
      if (status) q.set('status', status);
      if (mine) q.set('mine', '1');
      return reply(call('GET', `/api/v1/tasks?${q}`));
    },
  );

  server.registerTool(
    'hub_get_task',
    {
      title: '任务详情',
      description: '查看任务的描述、验收标准、引用的任务、工作笔记、讨论和交付物。同项目的任何任务都能查看，不限状态，也不需要被引用。',
      inputSchema: { task: z.string().describe('任务编号，如 P1-T12') },
      annotations: { readOnlyHint: true },
    },
    async ({ task }) => reply(call('GET', `/api/v1/tasks/${enc(task)}?format=md`)),
  );

  server.registerTool(
    'hub_claim',
    {
      title: '领取任务',
      description: '领取一个待领取的任务，领取后状态变为进行中。',
      inputSchema: { task: z.string().describe('任务编号') },
    },
    async ({ task }) => reply(call('POST', `/api/v1/tasks/${enc(task)}/claim?format=md`, {})),
  );

  server.registerTool(
    'hub_respond_assignment',
    {
      title: '回应指派',
      description: '接受或拒绝负责人（或其他 agent）指派给你的任务。拒绝时必须写理由。',
      inputSchema: {
        task: z.string().describe('任务编号'),
        accept: z.boolean().describe('true 接受，false 拒绝'),
        reason: z.string().optional().describe('拒绝理由'),
      },
    },
    async ({ task, accept, reason }) =>
      reply(call('POST', `/api/v1/tasks/${enc(task)}/${accept ? 'accept' : 'decline'}?format=md`, { reason })),
  );

  server.registerTool(
    'hub_progress',
    {
      title: '上报进度',
      description: '上报任务进度并续租。note 是一句话现状；notes 是给接手者的工作笔记（做到哪了、关键决定、下一步），会覆盖旧笔记。',
      inputSchema: {
        task: z.string().describe('任务编号'),
        percent: z.number().int().min(0).max(100).optional().describe('完成百分比'),
        note: z.string().describe('一句话说明当前进展'),
        notes: z.string().optional().describe('工作笔记（完整替换）'),
      },
    },
    async ({ task, ...body }) => reply(call('POST', `/api/v1/tasks/${enc(task)}/progress?format=md`, body)),
  );

  server.registerTool(
    'hub_block',
    {
      title: '标记阻塞',
      description:
        '任务因为缺信息、缺权限或依赖别人而无法继续时调用。把 reason 写成负责人能直接回答的问题，能列出选项时用 options 给出，' +
        '负责人在控制台点选后会自动解除阻塞并把答案发给你。',
      inputSchema: {
        task: z.string(),
        reason: z.string().describe('需要负责人回答的问题或阻塞原因'),
        options: z.array(z.string()).max(6).optional().describe('可选答案，如 ["MySQL", "PostgreSQL"]'),
      },
    },
    async ({ task, reason, options }) => reply(call('POST', `/api/v1/tasks/${enc(task)}/block?format=md`, { reason, options })),
  );

  server.registerTool(
    'hub_unblock',
    {
      title: '解除阻塞',
      description: '阻塞的问题已解决，继续工作。',
      inputSchema: { task: z.string(), note: z.string().optional() },
    },
    async ({ task, note }) => reply(call('POST', `/api/v1/tasks/${enc(task)}/unblock?format=md`, { note })),
  );

  server.registerTool(
    'hub_submit',
    {
      title: '提交验收',
      description: '任务完成后提交给负责人验收。summary 说明做了什么、在哪里看结果；较长的交付内容放进 artifacts。',
      inputSchema: {
        task: z.string(),
        summary: z.string().describe('交付说明'),
        artifacts: z
          .array(z.object({ name: z.string(), content: z.string().optional(), url: z.string().optional() }))
          .optional()
          .describe('交付物：文本内容或链接'),
        ...(opts.fileArtifact
          ? { files: z.array(z.string()).optional().describe('要一起提交的本机文件路径；小文本直接附上内容，其他文件（最大 25 MB）上传到 Hub') }
          : {}),
      },
    },
    async ({ task, files, ...body }: { task: string; summary: string; artifacts?: object[]; files?: string[] }) => {
      const artifacts: object[] = [...(body.artifacts ?? [])];
      try {
        for (const f of files ?? []) artifacts.push(await opts.fileArtifact!(f));
      } catch (err) {
        return { content: [{ type: 'text' as const, text: (err as Error).message }], isError: true };
      }
      return reply(call('POST', `/api/v1/tasks/${enc(task)}/submit?format=md`, { summary: body.summary, artifacts }));
    },
  );

  server.registerTool(
    'hub_release',
    {
      title: '放弃任务',
      description: '不再做这个任务时调用，任务回到任务池。必须写理由。',
      inputSchema: { task: z.string(), reason: z.string() },
    },
    async ({ task, reason }) => reply(call('POST', `/api/v1/tasks/${enc(task)}/release?format=md`, { reason })),
  );

  server.registerTool(
    'hub_comment',
    {
      title: '评论任务',
      description:
        '在任务下评论，支持 Markdown。可以用 @A-3 或 @完整名字 提及某个 agent（编号用 hub_members 查），或 @负责人 提及负责人。' +
        (opts.uploadFile ? '截图、日志等可以用 files 作为附件一起发。' : ''),
      inputSchema: {
        task: z.string(),
        text: z.string(),
        ...(opts.uploadFile ? { files: z.array(z.string()).optional().describe('作为附件上传的本机文件路径（每个最大 25 MB）') } : {}),
      },
    },
    async ({ task, text, files }: { task: string; text: string; files?: string[] }) => {
      const ids: string[] = [];
      try {
        for (const f of files ?? []) ids.push(await opts.uploadFile!(f));
      } catch (err) {
        return { content: [{ type: 'text' as const, text: (err as Error).message }], isError: true };
      }
      return reply(call('POST', `/api/v1/tasks/${enc(task)}/comments?format=md`, { text, files: ids }));
    },
  );

  server.registerTool(
    'hub_artifact_get',
    {
      title: '读取交付物',
      description: '读取任务下某份交付物的当前内容和版本号（编号见任务详情里的 ### #编号）。修改前先读，拿到 rev 作为 base_rev。给 rev 可以读历史版本，history=true 看修改记录。',
      inputSchema: {
        task: z.string(),
        artifact: z.number().int().describe('交付物编号'),
        rev: z.number().int().optional().describe('读哪一版，默认最新'),
        history: z.boolean().optional().describe('改为返回修改记录'),
      },
    },
    async ({ task, artifact, rev, history }: { task: string; artifact: number; rev?: number; history?: boolean }) => {
      const path = `/api/v1/tasks/${enc(task)}/artifacts/${artifact}`;
      return reply(call('GET', history ? `${path}/revisions?format=md` : `${path}?format=md${rev ? `&rev=${rev}` : ''}`));
    },
  );

  server.registerTool(
    'hub_artifact_update',
    {
      title: '修改交付物',
      description:
        '修改已提交的交付物，不需要退回任务：负责人评论要求修改，或 @你 来帮忙改时使用。base_rev 是你读取时的版本号。' +
        'edits 做局部修改（每处 old 必须在当前内容里恰好出现一次）；content 整份替换。' +
        '有人在你之后改过：整份替换一定失败，局部修改在你要改的那段被动过时失败；失败后用 hub_artifact_get 重新读取最新版本再改。',
      inputSchema: {
        task: z.string(),
        artifact: z.number().int().describe('交付物编号'),
        base_rev: z.number().int().describe('你是在第几版的基础上修改的'),
        edits: z.array(z.object({ old: z.string(), new: z.string() })).optional().describe('局部修改：把 old 原文片段替换成 new'),
        content: z.string().optional().describe('整份替换：新的完整内容'),
        ...(opts.fileArtifact ? { file: z.string().optional().describe('整份替换：用这个本机文件的内容') } : {}),
        note: z.string().optional().describe('改了什么，一句话'),
      },
    },
    async ({ task, artifact, file, ...body }: { task: string; artifact: number; base_rev: number; edits?: object[]; content?: string; file?: string; note?: string }) => {
      const path = `/api/v1/tasks/${enc(task)}/artifacts/${artifact}?format=md`;
      if (body.edits?.length) return reply(call('PATCH', path, { base_rev: body.base_rev, edits: body.edits, note: body.note }));
      let payload: object = { base_rev: body.base_rev, content: body.content, note: body.note };
      if (file) {
        try {
          const a = await opts.fileArtifact!(file);
          payload = { base_rev: body.base_rev, note: body.note, ...(a.content !== undefined ? { content: a.content } : { file_id: a.file_id }) };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: (err as Error).message }], isError: true };
        }
      }
      return reply(call('PUT', path, payload));
    },
  );

  server.registerTool(
    'hub_create_invite',
    {
      title: '邀请新 agent',
      description:
        '需要负责人授权（hub_me 里 can_invite 为 true）。项目里没有合适的 agent 做某件事时调用：新建一个待启动的 agent 身份，' +
        '并在任务下 @负责人（或私信负责人）说明用途，由负责人在控制台复制启动命令拉起。不要自己去启动 agent。',
      inputSchema: {
        note: z.string().describe('需要什么样的 agent、用来做什么，如「审核 PR #12 的前端改动」'),
        task: z.string().optional().describe('相关任务编号；给了就在任务下评论 @负责人'),
        project: z.string().optional().describe('没有相关任务时指定项目'),
        name: z.string().optional().describe('建议给新 agent 起的名字'),
        tags: z.array(z.string()).optional().describe('新 agent 的能力标签'),
        harness: z.enum(['codex', 'claude']).optional(),
      },
    },
    async (input) => reply(call('POST', '/api/v1/invites?format=md', input)),
  );

  server.registerTool(
    'hub_create_subtask',
    {
      title: '创建子任务',
      description: '为自己负责的任务拆出子任务，直接发布。可以建议指派给某个 agent（assignee），否则进入任务池。',
      inputSchema: {
        parent: z.string().describe('父任务编号'),
        title: z.string(),
        description: z.string().optional(),
        acceptance: z.array(z.string()).optional().describe('验收标准'),
        assignee: z.string().optional().describe('建议指派的 agent 编号，如 A-3'),
        required_tags: z.array(z.string()).optional(),
        priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
        due_at: z.string().optional().describe('截止时间，ISO 格式，如 2026-11-01T18:00:00+08:00；不填时沿用父任务的截止时间'),
        refs: z.array(z.string()).optional().describe('引用同项目的其他任务作为参考，如 ["P1-T2"]，不限状态'),
      },
    },
    async (body) => reply(call('POST', '/api/v1/tasks?format=md', body)),
  );

  server.registerTool(
    'hub_message',
    {
      title: '发私信',
      description: '给同项目的 agent（如 A-3）或负责人（to 填 owner）发私信。负责人能看到所有私信。',
      inputSchema: { to: z.string(), text: z.string() },
    },
    async (body) => reply(call('POST', '/api/v1/messages?format=md', body)),
  );

  return server;
}
