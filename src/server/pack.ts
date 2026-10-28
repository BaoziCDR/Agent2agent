// 安装包：把 Hub 自身已构建好的文件打成 npm 能直接安装的 tgz，agent 用 npm install -g <hub>/ahub.tgz 安装，版本始终与 Hub 一致。
// 不依赖 GitHub 和 npm 发布；也避开了 npm install -g github:... 在全局模式下构建时找不到 tsc 的问题。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { tr } from '../i18n/index.js';

/** 写一个 ustar 文件头；路径超过 100 字节时拆到 prefix 字段。 */
function header(path: string, size: number, mtime: number): Buffer {
  const h = Buffer.alloc(512);
  let name = path;
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    let i = name.indexOf('/');
    while (i > 0 && Buffer.byteLength(name.slice(i + 1)) > 100) i = name.indexOf('/', i + 1);
    if (i <= 0 || Buffer.byteLength(name.slice(0, i)) > 155) throw new Error(tr('路径太长，无法打包：{path}', { path }));
    prefix = name.slice(0, i);
    name = name.slice(i + 1);
  }
  const put = (s: string, off: number, len: number) => h.write(s, off, len, 'utf8');
  const oct = (n: number, off: number, len: number) => put(n.toString(8).padStart(len - 1, '0') + '\0', off, len);
  put(name, 0, 100);
  oct(0o644, 100, 8);
  oct(0, 108, 8);
  oct(0, 116, 8);
  oct(size, 124, 12);
  oct(mtime, 136, 12);
  h.fill(' ', 148, 156);
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

function walk(dir: string, out: string[]) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.isFile()) out.push(p);
  }
}

/** 按 package.json 的 files 字段收集文件，打成 tgz。缺少构建产物时返回 null。 */
export function buildInstallPackage(root: string): Buffer | null {
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath) || !existsSync(join(root, 'dist', 'cli', 'ahub.js'))) return null;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { files?: string[]; scripts?: Record<string, string> };
  // 包里已经是构建好的文件，安装时不需要再构建
  if (pkg.scripts) delete pkg.scripts.prepare;

  const files: string[] = [];
  for (const f of [...(pkg.files ?? []), 'README.md', 'LICENSE']) {
    const p = join(root, f);
    if (!existsSync(p)) continue;
    if (statSync(p).isDirectory()) walk(p, files);
    else files.push(p);
  }

  const mtime = Math.floor(Date.now() / 1000);
  const chunks: Buffer[] = [];
  const add = (path: string, data: Buffer) => {
    chunks.push(header(`package/${path}`, data.length, mtime), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad));
  };
  add('package.json', Buffer.from(JSON.stringify(pkg, null, 2) + '\n'));
  for (const f of [...new Set(files)].sort()) add(relative(root, f).split(sep).join('/'), readFileSync(f));
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}
