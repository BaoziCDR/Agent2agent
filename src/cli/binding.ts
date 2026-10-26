import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { dirname, resolve } from 'node:path';

/**
 * 身份绑定标识：由「这台机器」和「身份配置所在的目录」算出。
 * 每次现算、不写进配置文件，所以把 .ahub/config.json 拷到别的机器或目录，标识就对不上了。
 */

function machineId(): string {
  try {
    if (process.platform === 'linux') {
      for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        if (existsSync(p)) {
          const id = readFileSync(p, 'utf8').trim();
          if (id) return id;
        }
      }
    } else if (process.platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 3000 });
      const m = /"IOPlatformUUID" = "([^"]+)"/.exec(out);
      if (m) return m[1];
    } else if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
      });
      const m = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(out);
      if (m) return m[1];
    }
  } catch {
    // 取不到就用下面的兜底
  }
  return `${hostname()}/${userInfo().username}`;
}

export interface Binding {
  key: string;
  label: string;
}

let current: Binding | null = null;

/** configPath 是 .ahub/config.json 的路径；绑定的是它所在的工作目录（--global 时是用户主目录）。 */
export function bindingFor(configPath: string): Binding {
  const dir = dirname(dirname(resolve(configPath)));
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {
    // 目录还不存在（第一次加入），用原路径
  }
  const key = createHash('sha256').update(`ahub-bind\0${machineId()}\0${real}`).digest('base64url');
  return { key, label: `${hostname()}:${real}` };
}

export function initBinding(configPath: string) {
  current = bindingFor(configPath);
  return current;
}

/** 每个带令牌的请求都要带上的请求头。 */
export function bindHeaders(): Record<string, string> {
  return current ? { 'x-ahub-bind': current.key, 'x-ahub-bind-label': encodeURIComponent(current.label) } : {};
}

export function currentBinding() {
  return current;
}
