import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb } from './db.js';
import { Hub } from './hub.js';
import { buildApp } from './app.js';
import { Notifier } from './notify.js';
import { Tagger } from './tagger.js';

export interface ServeOptions {
  port: number;
  host: string;
  dataDir: string;
  publicUrl?: string;
  resetOwnerToken?: boolean;
  ownerToken?: string;
  /** 多久没有任何请求算离线（分钟） */
  offlineAfterMinutes?: number;
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

export async function serve(opts: ServeOptions) {
  const dataDir = resolve(opts.dataDir);
  mkdirSync(dataDir, { recursive: true });
  const db = openDb(join(dataDir, 'hub.db'));
  const hub = new Hub(db, { offlineAfterMinutes: opts.offlineAfterMinutes });

  let token = hub.ensureOwnerToken(opts.ownerToken);
  if (opts.resetOwnerToken) token = hub.resetOwnerToken();
  const tokenFile = join(dataDir, 'owner-token.txt');
  if (token) {
    writeFileSync(tokenFile, token + '\n');
    try {
      chmodSync(tokenFile, 0o600);
    } catch {
      // Windows 上忽略
    }
  }

  const notifier = new Notifier(hub, db);
  notifier.start();
  const tagger = new Tagger(hub, db);
  tagger.start();
  const app = buildApp(hub, { publicUrl: opts.publicUrl, logger: false, filesDir: join(dataDir, 'files'), notifier, tagger });
  await app.listen({ port: opts.port, host: opts.host });

  const sweep = setInterval(() => {
    try {
      hub.sweepLeases();
      hub.sweepDue();
      hub.sweepStalls();
      hub.sweepPresence();
    } catch (err) {
      console.error('租约/在线状态检查失败：', err);
    }
  }, 30_000);
  sweep.unref();

  const urls =
    opts.host === '0.0.0.0' || opts.host === '::'
      ? ['127.0.0.1', ...lanAddresses()].map((ip) => `http://${ip}:${opts.port}`)
      : [`http://${opts.host}:${opts.port}`];
  console.log('ahub 协作中枢已启动');
  console.log(`  控制台：${urls.join('  ')}`);
  console.log(`  数据目录：${dataDir}`);
  if (token) {
    console.log(`  负责人令牌：${token}`);
    console.log(`  （已保存到 ${tokenFile}，用它登录控制台；丢失后可用 --reset-owner-token 重置）`);
  } else {
    console.log(`  负责人令牌：见 ${tokenFile}（首次启动时生成）`);
  }

  const shutdown = async () => {
    clearInterval(sweep);
    notifier.stop();
    tagger.stop();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return { app, hub };
}
