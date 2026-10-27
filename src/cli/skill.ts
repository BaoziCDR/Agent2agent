// 内置的接入说明 skill：随 ahub 一起打包，版本与命令行一致，不需要联网下载。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_NAME = 'ahub-collab';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VERSION_RE = /<!-- ahub-skill: ([0-9a-f]{12}) /;

export type SkillTarget = 'claude' | 'codex';
export const SKILL_TARGETS: SkillTarget[] = ['claude', 'codex'];

function template(): string {
  const file = join(ROOT, 'skill', 'SKILL.md');
  if (!existsSync(file)) throw new Error(`找不到内置的 skill（${file}），请重新安装 ahub`);
  return readFileSync(file, 'utf8');
}

/** 内置 skill 的版本：内容的摘要，Hub 和命令行升级后会变。 */
export function bundledVersion(): string {
  return createHash('sha256').update(template()).digest('hex').slice(0, 12);
}

/** 填好 Hub 地址、加上版本标记的 skill 正文。 */
export function renderSkill(hub?: string): string {
  const version = bundledVersion();
  const text = template().replaceAll('{{HUB_URL}}', hub || '<Hub 地址>');
  const mark = `<!-- ahub-skill: ${version} · 由 ahub skill install 生成，ahub skill update 更新，请勿手改 -->\n`;
  // 版本标记放在 frontmatter 之后，不影响 skill 的识别
  const end = text.startsWith('---') ? text.indexOf('\n---', 3) : -1;
  if (end < 0) return mark + text;
  const cut = text.indexOf('\n', end + 1) + 1;
  return text.slice(0, cut) + mark + text.slice(cut);
}

/** 各 harness 读取 skill 的位置：统一装在用户目录，在哪个目录运行都读同一份。 */
export function skillPath(target: SkillTarget): string {
  return join(homedir(), target === 'claude' ? '.claude' : '.codex', 'skills', SKILL_NAME, 'SKILL.md');
}

export interface SkillState {
  target: SkillTarget;
  path: string;
  /** null 表示没装；'unknown' 表示不是 ahub 生成的 */
  version: string | null;
  current: boolean;
}

function stateOf(target: SkillTarget, path: string, bundled: string): SkillState {
  const version = existsSync(path) ? (VERSION_RE.exec(readFileSync(path, 'utf8'))?.[1] ?? 'unknown') : null;
  return { target, path, version, current: version === bundled };
}

export function skillStates(): SkillState[] {
  const bundled = bundledVersion();
  return SKILL_TARGETS.map((target) => stateOf(target, skillPath(target), bundled));
}

/** 旧版装在工作目录里的 skill（.claude/skills、.codex/skills）：只认 ahub 生成的，会盖住用户目录那份 */
export function projectCopies(dir: string): SkillState[] {
  const bundled = bundledVersion();
  const base = resolve(dir);
  if (base === homedir()) return [];
  return SKILL_TARGETS.map((target) => stateOf(target, join(base, target === 'claude' ? '.claude' : '.codex', 'skills', SKILL_NAME, 'SKILL.md'), bundled)).filter(
    (st) => st.version && st.version !== 'unknown',
  );
}

/** 删掉旧版 ahub 装在工作目录里的 skill，返回删掉的位置 */
export function removeProjectCopies(dir: string): string[] {
  return projectCopies(dir).map((st) => {
    rmSync(dirname(st.path), { recursive: true, force: true });
    return st.path;
  });
}

export function installSkill(path: string, hub?: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderSkill(hub));
}
