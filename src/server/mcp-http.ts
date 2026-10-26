import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createHubMcpServer, type HubCall } from '../shared/mcp-tools.js';
import type { Binding } from './hub.js';

/** 无状态 MCP：每个请求新建一个 server，工具通过进程内调用复用 REST 接口。 */
export async function handleMcpRequest(app: FastifyInstance, req: FastifyRequest, reply: FastifyReply, token: string, bind: Binding | null) {
  const call: HubCall = async (method, path, body) => {
    const res = await app.inject({
      method,
      url: path,
      headers: {
        authorization: `Bearer ${token}`,
        ...(bind ? { 'x-ahub-bind': bind.key, 'x-ahub-bind-label': encodeURIComponent(bind.label) } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      payload: body === undefined ? undefined : JSON.stringify(body),
    });
    return { ok: res.statusCode < 400, text: res.body };
  };
  const server = createHubMcpServer(call);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  reply.hijack();
  reply.raw.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req.raw, reply.raw, req.body);
}
