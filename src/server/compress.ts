// 响应压缩：控制台的任务列表、任务详情、前端代码都是文本，压缩后通常只剩三分之一，
// 而 Hub 常常隔着跨境线路访问，放在 Hub 这一层，有没有反向代理都能受益。
// 事件流和 MCP 用 reply.hijack() 直接写响应，不经过这里；上传的文件原样提供，可能很大，图片和压缩包也压不动。
import { pipeline, type Readable } from 'node:stream';
import { createGzip, gzip } from 'node:zlib';
import type { FastifyInstance } from 'fastify';

/** 太小的响应压缩后省不了多少，还要多花一次线程池调度 */
const MIN_BYTES = 1024;
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml)\b|image\/svg\+xml\b)/i;

/** Accept-Encoding 里是否接受 gzip（q=0 表示明确拒绝） */
export function acceptsGzip(header: unknown): boolean {
  if (typeof header !== 'string') return false;
  return header.split(',').some((item) => {
    const [name, ...params] = item.trim().split(';');
    if (name.trim().toLowerCase() !== 'gzip') return false;
    const q = params.map((p) => /^\s*q=([\d.]+)\s*$/i.exec(p)?.[1]).find((v) => v !== undefined);
    return q === undefined || Number(q) > 0;
  });
}

const gzipBuffer = (input: string | Buffer) =>
  new Promise<Buffer>((resolve, reject) => gzip(input, (err, out) => (err ? reject(err) : resolve(out))));

const isStream = (v: unknown): v is Readable => typeof (v as Readable | null)?.pipe === 'function';

export function addCompression(app: FastifyInstance) {
  app.addHook('onSend', async (req, reply, payload) => {
    if (reply.statusCode !== 200 || req.method === 'HEAD' || req.url.startsWith('/files/')) return payload;
    if (reply.hasHeader('content-encoding')) return payload;
    if (!COMPRESSIBLE.test(String(reply.getHeader('content-type') ?? ''))) return payload;
    if (/\bno-transform\b/i.test(String(reply.getHeader('cache-control') ?? ''))) return payload;

    const text = typeof payload === 'string' || Buffer.isBuffer(payload);
    if (!text && !isStream(payload)) return payload;
    const size = text ? Buffer.byteLength(payload) : Number(reply.getHeader('content-length') ?? MIN_BYTES);
    if (size < MIN_BYTES) return payload;

    // 同一地址按 Accept-Encoding 返回不同内容，缓存要分开存
    const vary = reply.getHeader('vary');
    if (!vary) reply.header('vary', 'Accept-Encoding');
    else if (!/accept-encoding/i.test(String(vary))) reply.header('vary', `${vary}, Accept-Encoding`);
    if (!acceptsGzip(req.headers['accept-encoding'])) return payload;

    reply.header('content-encoding', 'gzip');
    reply.removeHeader('content-length');
    if (text) return gzipBuffer(payload);
    const gz = createGzip();
    pipeline(payload, gz, () => undefined); // 读取出错或客户端断开时两边一起销毁
    return gz;
  });
}
