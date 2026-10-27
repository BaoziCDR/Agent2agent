import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';

const root = new URL('../', import.meta.url);

// 仓库自带的开发 skill 放在 .agents/skills，.claude/skills 是指向它的软链接，Codex 和 Claude Code 读到的是同一份
test('仓库 skill：.claude/skills 软链接到 .agents/skills，每个 skill 的 name 与目录名一致', () => {
  const link = new URL('.claude/skills', root);
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(readlinkSync(link), '../.agents/skills');
  const dirs = readdirSync(new URL('.agents/skills/', root));
  for (const want of ['ahub-dev', 'ahub-deploy', 'ahub-troubleshoot']) assert.ok(dirs.includes(want), `缺少 ${want}`);
  for (const dir of dirs) {
    const file = new URL(`.claude/skills/${dir}/SKILL.md`, root);
    assert.ok(existsSync(file), `${dir} 缺少 SKILL.md`);
    const text = readFileSync(file, 'utf8');
    const front = text.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(front, `${dir} 缺少 frontmatter`);
    assert.match(front[1], new RegExp(`^name: ${dir}$`, 'm'));
    assert.match(front[1], /^description: \S.+$/m);
  }
});
