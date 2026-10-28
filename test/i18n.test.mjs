import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSync } from 'rolldown/utils';
import { STATUS_LABELS } from '../dist/shared/model.js';

const ROOT = join(import.meta.dirname, '..');
const FUNCS = new Set(['t', 'tr', 'msg']);

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));

const FN = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/** 找出源码里 t('…') / tr('…') / msg('…') 的文案键；t/tr 写在模块顶层（导入时就翻译，切换语言不生效）的记为问题。 */
function scan(files) {
  const keys = new Map();
  const topLevel = [];
  for (const file of files) {
    const code = readFileSync(file, 'utf8');
    const { program, errors } = parseSync(file, code);
    assert.deepEqual(errors.map((e) => e.message), [], file);
    const line = (pos) => code.slice(0, pos).split('\n').length;
    const visit = (node, inFn) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach((n) => visit(n, inFn));
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && FUNCS.has(node.callee.name)) {
        const arg = node.arguments[0];
        const text = arg?.type === 'Literal' && typeof arg.value === 'string' ? arg.value : arg?.type === 'TemplateLiteral' && arg.expressions.length === 0 ? arg.quasis[0].value.cooked : null;
        if (text !== null) {
          const where = `${file.slice(ROOT.length + 1)}:${line(node.start)}`;
          if (!keys.has(text)) keys.set(text, where);
          if (!inFn && node.callee.name !== 'msg') topLevel.push(where);
        }
      }
      const fn = inFn || FN.has(node.type);
      for (const [k, v] of Object.entries(node)) if (k !== 'type' && v && typeof v === 'object') visit(v, fn);
    };
    visit(program, false);
  }
  return { keys, topLevel };
}

const holes = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

function check(name, files, dict, extra = []) {
  const { keys, topLevel } = scan(files);
  for (const k of extra) if (!keys.has(k)) keys.set(k, '(extra)');
  assert.ok(keys.size > 50, `${name}：没找到文案，检查扫描范围`);
  assert.deepEqual(topLevel, [], `${name}：模块顶层不能直接调用 t()，改用 msg() 标记、显示时再 t()`);
  const missing = [...keys].filter(([k]) => dict[k] === undefined).map(([k, w]) => `${w}  ${k}`);
  assert.deepEqual(missing, [], `${name}：缺少英文译文`);
  const bad = Object.entries(dict).filter(([k, v]) => holes(k) !== holes(v)).map(([k]) => k);
  assert.deepEqual(bad, [], `${name}：译文的占位符和原文不一致`);
}

test('控制台的文案都有英文译文', () => {
  const en = JSON.parse(readFileSync(join(ROOT, 'web/src/i18n/en.json'), 'utf8'));
  // 任务状态在界面上按枚举翻译（statusLabel），不用 Hub 返回的中文
  check('web', walk(join(ROOT, 'web/src')), en, Object.values(STATUS_LABELS));
});
