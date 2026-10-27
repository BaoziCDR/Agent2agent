import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 浏览器支持 CSS 嵌套，少一个右括号不会报错，只会让后面的样式悄悄失效
test('样式表的大括号配平', () => {
  const css = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0;
  css.split('\n').forEach((line, i) => {
    depth += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
    assert.ok(depth >= 0 && depth <= 2, `第 ${i + 1} 行附近括号不配平`);
  });
  assert.equal(depth, 0);
});
