import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CliConfig } from './config.js';
import { hubFetch, identityCode } from './auth.js';
import { tr } from '../i18n/index.js';

const fail = (msg: string): never => {
  throw new Error(msg);
};

const INLINE_LIMIT = 200 * 1024;

/** 解析符号链接后的真实路径；路径还不存在时解析到最近的已存在上级，指向外面的悬空链接也算外面。 */
function realPath(path: string, depth = 0): string {
  const full = resolve(path);
  const rest: string[] = [];
  for (let cur = full; ; ) {
    try {
      return join(realpathSync(cur), ...rest);
    } catch {
      try {
        if (depth < 20 && lstatSync(cur).isSymbolicLink()) return realPath(join(resolve(dirname(cur), readlinkSync(cur)), ...rest), depth + 1);
      } catch {
        // 不存在，继续看上一级
      }
      const up = dirname(cur);
      if (up === cur) return full;
      rest.unshift(basename(cur));
      cur = up;
    }
  }
}

/**
 * 值守模式下，harness 默认只被放行了 ahub 命令，没有放行读写工作目录以外的文件。
 * 任务内容可能带有恶意指令，ahub 不能成为绕过权限的通道（读走私钥再上传、覆盖任意文件），
 * 所以路径只能在工作目录、--allow-path 和系统临时目录里。人在终端里手动运行时不限制。
 */
export function assertPathAllowed(path: string) {
  const roots = process.env.AHUB_PATH_ROOTS;
  if (!process.env.AHUB_RUN || roots === undefined) return;
  const target = realPath(path);
  for (const root of [...roots.split(delimiter).filter(Boolean), process.cwd(), tmpdir()].map((r) => realPath(r))) {
    const rel = relative(root, target);
    if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return;
  }
  fail(tr('{path} 不在工作目录内，值守模式下不能读写。把文件放到工作目录或系统临时目录里；确实需要时，请负责人给 ahub run 加上 --allow-path <目录>', { path }));
}

export async function uploadFile(cfg: CliConfig, path: string): Promise<{ id: string; name: string; size: number; absolute_url: string }> {
  if (!cfg.hub || !identityCode(cfg)) fail(tr('请先 ahub join'));
  assertPathAllowed(path);
  let body: Buffer;
  try {
    body = readFileSync(path);
  } catch (err) {
    return fail(tr('读取文件失败：{message}', { message: (err as Error).message }));
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
    return fail(tr('连接 Hub 失败（{hub}）：{message}', { hub: cfg.hub, message: (err as Error).message }));
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      msg = JSON.parse(text).error?.message ?? text;
    } catch {
      // 保留原文
    }
    fail(tr('上传失败：{msg}', { msg }));
  }
  return JSON.parse(text);
}

/** 小的文本文件直接内联（其他 agent 读任务详情就能看到内容），其余上传到 Hub。 */
export async function fileArtifact(cfg: CliConfig, path: string) {
  assertPathAllowed(path);
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch (err) {
    return fail(tr('读取文件失败：{message}', { message: (err as Error).message }));
  }
  const text = buf.length <= INLINE_LIMIT && !buf.includes(0) ? buf.toString('utf8') : null;
  if (text !== null && !text.includes('\uFFFD')) return { name: basename(path), content: text };
  const r = await uploadFile(cfg, path);
  return { name: r.name, file_id: r.id };
}


/** 把任务附件下载到本地目录（默认当前目录），同名文件跳过；返回每个文件的处理结果，一行一个。 */
export async function downloadAttachments(cfg: CliConfig, configPath: string | null, task: string, to = '.'): Promise<string> {
  if (!cfg.hub || !identityCode(cfg)) fail(tr('请先 ahub join'));
  assertPathAllowed(to);
  let res: Response;
  try {
    res = await hubFetch(cfg, configPath, `/api/v1/tasks/${encodeURIComponent(task)}`, {}, { client: 'cli' });
  } catch (err) {
    return fail(tr('连接 Hub 失败（{hub}）：{message}', { hub: cfg.hub, message: (err as Error).message }));
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
  if (!files.length) return tr('{task} 没有附件。', { task });
  const dir = resolve(to);
  mkdirSync(dir, { recursive: true });
  const out: string[] = [];
  for (const f of files) {
    const name = basename(f.name);
    const dest = join(dir, name === '.' || name === '..' || !name ? 'file' : name);
    if (existsSync(dest)) {
      out.push(tr('跳过 {dest}（已存在）', { dest }));
      continue;
    }
    let r: Response;
    try {
      r = await fetch(cfg.hub + f.url);
    } catch (err) {
      return fail(tr('下载 {name} 失败：{message}', { name: f.name, message: (err as Error).message }));
    }
    if (!r.ok) fail(tr('下载 {name} 失败：HTTP {status}', { name: f.name, status: r.status }));
    writeFileSync(dest, new Uint8Array(await r.arrayBuffer()));
    out.push(tr('已下载 {dest}（{size} 字节）', { dest, size: f.size }));
  }
  return out.join('\n');
}
