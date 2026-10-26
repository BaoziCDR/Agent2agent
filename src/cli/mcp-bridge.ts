import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createHubMcpServer, type HubCall } from '../shared/mcp-tools.js';
import { type CliConfig, saveConfig } from './config.js';
import { fileArtifact } from './files.js';
import { bindHeaders } from './binding.js';

const LAST_SEQ_RE = /本次读到第 (\d+) 号事件/;

/** stdio MCP 桥：工具调用转发到 Hub 的 REST 接口，并像命令行一样自动保存事件确认位置。 */
export async function runStdioBridge(cfg: CliConfig, configPath: string) {
  const call: HubCall = async (method, path, body) => {
    if (!cfg.hub) return { ok: false, text: '还没有配置 Hub 地址。请用 hub_join，或在启动参数里加 --hub <地址>。' };
    if (!cfg.token) return { ok: false, text: '还没有加入任何项目。请向负责人要邀请码，然后调用 hub_join。' };
    let url = path;
    if (path.startsWith('/api/v1/inbox') && !/[?&](ack|since)=/.test(path) && cfg.last_seq) {
      url += `${path.includes('?') ? '&' : '?'}ack=${cfg.last_seq}`;
    }
    try {
      const res = await fetch(cfg.hub + url, {
        method,
        headers: {
          authorization: `Bearer ${cfg.token}`,
          ...bindHeaders(),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      const seq = path.startsWith('/api/v1/inbox') ? Number(LAST_SEQ_RE.exec(text)?.[1] ?? 0) : 0;
      if (seq && seq !== cfg.last_seq) {
        cfg.last_seq = seq;
        saveConfig(configPath, cfg);
      }
      return { ok: res.ok, text };
    } catch (err) {
      return { ok: false, text: `连接 Hub 失败（${cfg.hub}）：${(err as Error).message}` };
    }
  };

  const server = createHubMcpServer(call, {
    fileArtifact: (path) => fileArtifact(cfg, path),
    register: async (input) => {
      if (!cfg.hub) throw new Error('还没有配置 Hub 地址，请在 MCP 启动参数里加 --hub <地址>');
      if (cfg.token) throw new Error(`这里已经有身份 ${cfg.name ?? ''}（${cfg.agent ?? ''}），一个位置只能有一个身份`);
      const res = await fetch(`${cfg.hub}/api/v1/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...bindHeaders() },
        body: JSON.stringify({ ...input, tier: 'L2', platform: input.platform ?? 'other' }),
      });
      const data = (await res.json()) as { error?: { message: string }; agent: { id: string; name: string; binding?: { label: string } }; token: string };
      if (!res.ok) throw new Error(data.error?.message ?? `HTTP ${res.status}`);
      cfg.token = data.token;
      cfg.agent = data.agent.id;
      cfg.name = data.agent.name;
      saveConfig(configPath, cfg);
      return (
        `已创建身份 ${data.agent.name}（${data.agent.id}），绑定在 ${data.agent.binding?.label ?? '当前目录'}，令牌已保存在 ${configPath}。` +
        '这个位置不能再创建别的身份。下一步：向负责人要邀请码，调用 hub_join 加入项目。'
      );
    },
    join: async (input) => {
      if (!cfg.hub) throw new Error('还没有配置 Hub 地址，请在 MCP 启动参数里加 --hub <地址>');
      const res = await fetch(`${cfg.hub}/api/v1/join`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...bindHeaders(),
          ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
        },
        body: JSON.stringify({ ...input, tier: 'L2', platform: input.platform ?? 'other' }),
      });
      const data = (await res.json()) as {
        error?: { message: string };
        agent: { id: string; name: string };
        token: string | null;
        project: { id: string; name: string };
      };
      if (!res.ok) throw new Error(data.error?.message ?? `HTTP ${res.status}`);
      if (data.token) cfg.token = data.token;
      cfg.agent = data.agent.id;
      cfg.name = data.agent.name;
      cfg.project = data.project.id;
      saveConfig(configPath, cfg);
      return (
        `已加入项目 ${data.project.id}「${data.project.name}」，身份 ${data.agent.name}（${data.agent.id}）。` +
        `令牌已保存在 ${configPath}。下一步：调用 hub_sync 同步收件箱。`
      );
    },
  });
  await server.connect(new StdioServerTransport());
}
