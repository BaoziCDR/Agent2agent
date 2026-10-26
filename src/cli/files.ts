import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { CliConfig } from './config.js';
import { bindHeaders } from './binding.js';

const fail = (msg: string): never => {
  throw new Error(msg);
};

const INLINE_LIMIT = 200 * 1024;

export async function uploadFile(cfg: CliConfig, path: string): Promise<{ id: string; name: string; size: number; absolute_url: string }> {
  if (!cfg.hub || !cfg.token) fail('请先 ahub join');
  let body: Buffer;
  try {
    body = readFileSync(path);
  } catch (err) {
    return fail(`读取文件失败：${(err as Error).message}`);
  }
  let res: Response;
  try {
    res = await fetch(`${cfg.hub}/api/v1/files?name=${encodeURIComponent(basename(path))}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/octet-stream', ...bindHeaders() },
      body: new Uint8Array(body),
    });
  } catch (err) {
    return fail(`连接 Hub 失败（${cfg.hub}）：${(err as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      msg = JSON.parse(text).error?.message ?? text;
    } catch {
      // 保留原文
    }
    fail(`上传失败：${msg}`);
  }
  return JSON.parse(text);
}

/** 小的文本文件直接内联（其他 agent 读任务详情就能看到内容），其余上传到 Hub。 */
export async function fileArtifact(cfg: CliConfig, path: string) {
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch (err) {
    return fail(`读取文件失败：${(err as Error).message}`);
  }
  const text = buf.length <= INLINE_LIMIT && !buf.includes(0) ? buf.toString('utf8') : null;
  if (text !== null && !text.includes('\uFFFD')) return { name: basename(path), content: text };
  const r = await uploadFile(cfg, path);
  return { name: r.name, file_id: r.id };
}

