// 多语言的公共部分：文案以中文原文为键（类似 gettext 的 msgid），各语言包把中文映射成译文。
// 占位符写成 {name}，翻译时原样保留。
export type Dict = Record<string, string>;
export type Vars = Record<string, string | number | null | undefined>;

export function fill(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k] ?? '') : m));
}

/** 按顺序在几个语言包里找译文，都没有就用中文原文。 */
export function translate(dicts: (Dict | null | undefined)[], key: string, vars?: Vars): string {
  for (const d of dicts) {
    const hit = d?.[key];
    if (hit !== undefined) return fill(hit, vars);
  }
  return fill(key, vars);
}
