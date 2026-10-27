import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createHubMcpServer, type HubCall } from '../shared/mcp-tools.js';
import { type CliConfig, saveConfig } from './config.js';
import { AuthError, hubFetch, identityCode, openSession } from './auth.js';
import { fileArtifact, uploadFile } from './files.js';

const LAST_SEQ_RE = /本次读到第 (\d+) 号事件/;

/** stdio MCP 桥：工具调用转发到 Hub 的 REST 接口，并像命令行一样自动保存事件确认位置。 */
export async function runStdioBridge(cfg: CliConfig, configPath: string) {
  const call: HubCall = async (method, path, body) => {
    if (!cfg.hub) return { ok: false, text: '还没有配置 Hub 地址。请用 hub_join，或在启动参数里加 --hub <地址>。' };
    if (!identityCode(cfg)) return { ok: false, text: '还没有身份码。请向负责人要身份码，然后调用 hub_join。' };
    let url = path;
    if (path.startsWith('/api/v1/inbox') && !/[?&](ack|since)=/.test(path) && cfg.last_seq) {
      url += `${path.includes('?') ? '&' : '?'}ack=${cfg.last_seq}`;
    }
    try {
      const res = await hubFetch(
        cfg,
        configPath,
        url,
        { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) },
        { client: 'mcp' },
      );
      const text = await res.text();
      const seq = path.startsWith('/api/v1/inbox') ? Number(LAST_SEQ_RE.exec(text)?.[1] ?? 0) : 0;
      if (seq && seq !== cfg.last_seq) {
        cfg.last_seq = seq;
        saveConfig(configPath, cfg);
      }
      return { ok: res.ok, text };
    } catch (err) {
      return { ok: false, text: err instanceof AuthError ? err.message : `连接 Hub 失败（${cfg.hub}）：${(err as Error).message}` };
    }
  };

  const server = createHubMcpServer(call, {
    fileArtifact: (path) => fileArtifact(cfg, path),
    uploadFile: async (path) => (await uploadFile(cfg, path)).id,
    join: async (input) => {
      if (!cfg.hub) throw new Error('还没有配置 Hub 地址，请在 MCP 启动参数里加 --hub <地址>');
      const given = (input.code ?? input.invite ?? '').trim();
      if (!given) throw new Error('请提供身份码（code）');
      if (given !== identityCode(cfg)) {
        for (const k of ['token', 'session', 'agent', 'name', 'project', 'last_seq'] as const) delete cfg[k];
        cfg.code = given;
      }
      await openSession(cfg, configPath, { client: 'mcp', name: input.name, platform: input.platform ?? 'other', skills: input.skills, tags: input.tags });
      return `已连接 Hub，身份 ${cfg.name}（${cfg.agent}）${cfg.project ? `，当前项目 ${cfg.project}` : ''}。身份码已保存在 ${configPath}。下一步：调用 hub_sync 同步收件箱。`;
    },
  });
  await server.connect(new StdioServerTransport());
}
