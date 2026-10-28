import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { CliConfig } from './config.js';
import { hubFetch, identityCode } from './auth.js';

const fail = (msg: string): never => {
  throw new Error(msg);
};

const INLINE_LIMIT = 200 * 1024;

export async function uploadFile(cfg: CliConfig, path: string): Promise<{ id: string; name: string; size: number; absolute_url: string }> {
  if (!cfg.hub || !identityCode(cfg)) fail('请先 ahub join');
  let body: Buffer;
  try {
    body = readFileSync(path);
  } catch (err) {
    return fail(`读取文件失败：${(err as Error).message}`);
  }
  let res: Response;
  try {
    res = await hubFetch(
      cfg,
      null,
      `/api/v1/files?name=${encodeURIComponent(basename(path))}`,
      { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(body) },
      { client: 'cli' },
    );
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


/** 把任务附件下载到本地目录（默认当前目录），同名文件跳过；返回每个文件的处理结果，一行一个。 */
export async function downloadAttachments(cfg: CliConfig, configPath: string | null, task: string, to = '.'): Promise<string> {
  if (!cfg.hub || !identityCode(cfg)) fail('请先 ahub join');
  let res: Response;
  try {
    res = await hubFetch(cfg, configPath, `/api/v1/tasks/${encodeURIComponent(task)}`, {}, { client: 'cli' });
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
    fail(msg);
  }
  const files = (JSON.parse(text) as { attachments?: { name: string; size: number; url: string }[] }).attachments ?? [];
  if (!files.length) return `${task} 没有附件。`;
  const dir = resolve(to);
  mkdirSync(dir, { recursive: true });
  const out: string[] = [];
  for (const f of files) {
    const name = basename(f.name);
    const dest = join(dir, name === '.' || name === '..' || !name ? 'file' : name);
    if (existsSync(dest)) {
      out.push(`跳过 ${dest}（已存在）`);
      continue;
    }
    let r: Response;
    try {
      r = await fetch(cfg.hub + f.url);
    } catch (err) {
      return fail(`下载 ${f.name} 失败：${(err as Error).message}`);
    }
    if (!r.ok) fail(`下载 ${f.name} 失败：HTTP ${r.status}`);
    writeFileSync(dest, new Uint8Array(await r.arrayBuffer()));
    out.push(`已下载 ${dest}（${f.size} 字节）`);
  }
  return out.join('\n');
}
