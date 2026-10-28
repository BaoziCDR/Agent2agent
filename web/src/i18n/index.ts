// 控制台的多语言：文案以中文原文为键，t('总览') 在英文下返回 'Overview'。
// 新增语言：在本目录加一个语言包（参照 en.ts），再在 LOCALES 里登记一行。缺的条目先用英文，再用中文。
import { type Dict, type Vars, translate } from '../../../src/shared/i18n';
import en from './en.json';

export interface Locale {
  code: string;
  /** 在语言选择里显示的名字，用该语言自己的写法 */
  name: string;
  /** 日期时间格式用的 BCP 47 标签 */
  tag: string;
  dict: Dict | null;
}

export const LOCALES: Locale[] = [
  { code: 'zh', name: '中文', tag: 'zh-CN', dict: null },
  { code: 'en', name: 'English', tag: 'en-US', dict: en },
];

const KEY = 'ahub.lang';
const FALLBACK = 'en';

const find = (code: string | null | undefined) => (code ? LOCALES.find((l) => l.code === code.toLowerCase().split(/[-_]/)[0]) : undefined);

/** 手动选择的语言（没选过为 null，表示跟随浏览器） */
export function savedLang(): string | null {
  try {
    return find(localStorage.getItem(KEY))?.code ?? null;
  } catch {
    return null;
  }
}

/** 浏览器语言里第一个支持的；都不支持就用英文 */
export function browserLang(): string {
  const list = typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const l of list) {
    const hit = find(l);
    if (hit) return hit.code;
  }
  return FALLBACK;
}

let current: Locale = find(savedLang() ?? browserLang()) ?? LOCALES[0];

export const lang = () => current.code;
export const langTag = () => current.tag;

/** 切换语言；传 null 恢复跟随浏览器。调用方负责重新渲染（App 用 key 重挂整棵树）。 */
export function setLang(code: string | null) {
  try {
    if (code) localStorage.setItem(KEY, code);
    else localStorage.removeItem(KEY);
  } catch {
    // 无痕模式等情况存不了，只在本次生效
  }
  current = find(code ?? browserLang()) ?? LOCALES[0];
  document.documentElement.lang = current.tag;
}

const fallback = LOCALES.find((l) => l.code === FALLBACK)!.dict;

export function t(key: string, vars?: Vars): string {
  return translate(current.dict ? [current.dict, fallback] : [], key, vars);
}

/** 标记一段之后再翻译的文案（如模块级常量表里的标签），原样返回；显示时再用 t() 翻译。 */
export const msg = (key: string) => key;

/** 列表连接：中文用顿号，英文用逗号 */
export const joinList = (items: string[]) => items.join(t('、'));

/** 名字带编号，如「小王（A-3）」/ "Wang (A-3)" */
export const withCode = (name: string, code: string) => t('{name}（{code}）', { name, code });
