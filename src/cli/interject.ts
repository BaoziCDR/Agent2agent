import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * 运行中插话：harness 跑着的时候 Hub 上来了新评论、@、私信，值守进程把它们追加到一个待投递文件；
 * harness 每调用完一次工具，PostToolUse 钩子运行 `ahub hook <文件>` 把文件整个取走，内容作为附加上下文交给模型。
 * 取走的文件改名为 <文件>.taken-*，值守进程据此知道哪些事项已经送到，下一轮不再为它们唤起。
 */

export interface InterjectItem {
  seq: number;
  summary: string;
}

/** 钩子要执行的命令：用当前的 node 和 ahub 脚本，不依赖 PATH，也不依赖 harness 透传环境变量 */
export function hookCommand(file: string, node = process.execPath, script = process.argv[1]): string {
  return [node, script, 'hook', file].map((s) => `"${s.replace(/"/g, '\\"')}"`).join(' ');
}

/** Claude Code 的 --settings 内容：每次工具调用后取一次；想结束时还有没取走的事项就先别结束 */
export function claudeHookSettings(command: string) {
  const hook = [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 10 }] }];
  return { hooks: { PostToolUse: hook, Stop: [{ hooks: hook[0].hooks }] } };
}

/** Codex 的 -c 覆盖：用内联 TOML 定义 PostToolUse 钩子 */
export function codexHookArgs(command: string): string[] {
  const lit = command.includes("'") ? JSON.stringify(command) : `'${command}'`;
  return ['-c', `hooks.PostToolUse=[{matcher=".*",hooks=[{type="command",command=${lit},timeout=10}]}]`];
}

/** 本机的 Codex 支不支持跳过钩子信任；不支持说明版本太旧，没有钩子可用。返回参数应放在 exec 前还是后 */
export function probeCodexHookTrust(): 'exec' | 'root' | null {
  const has = (args: string[]) => {
    const r = spawnSync('codex', args, { encoding: 'utf8', timeout: 15_000, shell: process.platform === 'win32' });
    return `${r.stdout ?? ''}${r.stderr ?? ''}`.includes('--dangerously-bypass-hook-trust');
  };
  if (has(['exec', '--help'])) return 'exec';
  if (has(['--help'])) return 'root';
  return null;
}

export function queueItems(file: string, items: InterjectItem[]) {
  if (items.length) appendFileSync(file, items.map((i) => JSON.stringify(i) + '\n').join(''));
}

const takenFiles = (file: string) => {
  try {
    const name = basename(file);
    return readdirSync(dirname(file))
      .filter((n) => n.startsWith(`${name}.taken-`))
      .map((n) => join(dirname(file), n));
  } catch {
    return [];
  }
};

const parse = (text: string): InterjectItem[] =>
  text
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as InterjectItem];
      } catch {
        return [];
      }
    });

/** 已经被钩子取走、送到 harness 的事项编号 */
export function deliveredSeqs(file: string): number[] {
  return takenFiles(file).flatMap((f) => parse(readFileSync(f, 'utf8')).map((i) => i.seq));
}

export function cleanup(file: string) {
  for (const f of [file, ...takenFiles(file)]) rmSync(f, { force: true });
}

export function interjectText(items: InterjectItem[], stopping: boolean): string {
  return [
    stopping ? '【值守进程】先别结束：你这一轮运行期间，Hub 上来了新事项：' : '【值守进程插话】你运行期间，Hub 上刚来了新事项：',
    '',
    ...items.map((i) => `- ${i.summary}`),
    '',
    '如果和你手上的工作有关，先看一下再继续（`ahub task <任务>` 可读全文），需要调整做法就调整；需要回复就用 `ahub comment` / `ahub msg`。和当前工作无关的，也在结束本轮前处理。',
  ].join('\n');
}

/** `ahub hook <文件>`：取走待投递的事项，按钩子类型输出 JSON；没有事项时什么都不输出 */
export function runHook(file: string, input: string): string {
  let event = 'PostToolUse';
  try {
    event = String((JSON.parse(input) as { hook_event_name?: string }).hook_event_name ?? event);
  } catch {
    // 读不到输入就按工具调用后处理
  }
  if (!file || !existsSync(file)) return '';
  // 加随机后缀：同一毫秒里取走两次时不会改成同一个名字、覆盖掉上一批的送达记录
  const taken = `${file}.taken-${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    renameSync(file, taken); // 改名是原子的：值守进程之后追加的事项会写进新文件，留给下一次
  } catch {
    return '';
  }
  const items = parse(readFileSync(taken, 'utf8'));
  if (!items.length) return '';
  if (event === 'Stop') return JSON.stringify({ decision: 'block', reason: interjectText(items, true) });
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: interjectText(items, false) } });
}

export function writeClaudeSettings(file: string, command: string) {
  writeFileSync(file, JSON.stringify(claudeHookSettings(command), null, 2));
}
