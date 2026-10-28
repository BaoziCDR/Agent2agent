// 命令行和 Hub 的多语言：只有中文和英文。文案以中文原文为键，tr('…') 按当前语言取译文。
// 当前语言：Hub 处理请求时用请求方的语言（x-ahub-lang 请求头等，见 app.ts）；
// 其他时候（命令行、后台任务）用进程的语言，命令行启动时按 detectLang() 设定。
import { AsyncLocalStorage } from 'node:async_hooks';
import { type Vars, fill } from '../shared/i18n.js';
import { en } from './en.js';

export type Lang = 'zh' | 'en';
export const LANGS: Lang[] = ['zh', 'en'];

const als = new AsyncLocalStorage<Lang>();
let processLang: Lang = 'zh';

export const setProcessLang = (lang: Lang) => {
  processLang = lang;
};
export const currentLang = (): Lang => als.getStore() ?? processLang;

/** 在指定语言下运行 fn（Hub 用它按请求方的语言处理每个请求） */
export const withLang = <T>(lang: Lang, fn: () => T): T => als.run(lang, fn);

export function tl(lang: Lang, key: string, vars?: Vars): string {
  return fill(lang === 'zh' ? key : (en[key] ?? key), vars);
}

export const tr = (key: string, vars?: Vars) => tl(currentLang(), key, vars);

/** 标记一段之后再翻译的文案（模块级常量），原样返回 */
export const msg = (key: string) => key;

/** 列表连接：中文用顿号，英文用逗号 */
export const joinList = (items: string[]) => items.join(tr('、'));

/** 中英文各一份：fn 里的 tr() 分别按中文和英文求值。事件描述这类存下来给不同语言读者看的文字用它。 */
export interface Bilingual {
  zh: string;
  en: string;
}
export const bi = (fn: () => string): Bilingual => ({ zh: withLang('zh', fn), en: withLang('en', fn) });

/** 把 zh-CN、en_US.UTF-8、Chinese 之类的写法归到 zh/en；认不出返回 null */
export function normalizeLang(v: string | null | undefined): Lang | null {
  const s = (v ?? '').trim().toLowerCase();
  if (!s || s === 'c' || s === 'posix' || s.startsWith('c.')) return null;
  if (s.startsWith('zh') || s.startsWith('chinese')) return 'zh';
  if (/^[a-z]{2,3}([-_.@]|$)/.test(s) || s.startsWith('english')) return 'en';
  return null;
}

// 中文地区的时区：环境变量和系统语言都判断不出时才看它
const ZH_ZONES = new Set(['Asia/Shanghai', 'Asia/Chongqing', 'Asia/Chungking', 'Asia/Harbin', 'Asia/Urumqi', 'Asia/Kashgar', 'Asia/Hong_Kong', 'Asia/Macau', 'Asia/Taipei', 'PRC', 'ROC', 'Hongkong']);

export interface LangSource {
  flag?: string;
  env?: NodeJS.ProcessEnv;
  config?: string;
  platform?: NodeJS.Platform;
  /** 系统界面语言（Intl 读到的 locale） */
  systemLocale?: string;
  timeZone?: string;
}

/**
 * 命令行用哪种语言，按优先级：
 * --lang > AHUB_LANG > ~/.ahub 里保存的 lang > LC_ALL > LC_MESSAGES > LANG（C/POSIX 视为没设）
 * > 系统界面语言（Windows、macOS 上终端常常不设 LANG）> 时区（中国大陆、港澳台算中文）> 英文
 */
export function detectLang(src: LangSource = {}): { lang: Lang; from: string } {
  const env = src.env ?? process.env;
  const explicit: [string, string | undefined][] = [
    ['--lang', src.flag],
    ['AHUB_LANG', env.AHUB_LANG],
    ['config', src.config],
  ];
  for (const [from, v] of explicit) {
    const lang = normalizeLang(v);
    if (lang) return { lang, from };
  }
  for (const name of ['LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const lang = normalizeLang(env[name]);
    if (lang) return { lang, from: name };
  }
  const platform = src.platform ?? process.platform;
  if (platform !== 'linux') {
    const locale = src.systemLocale ?? Intl.DateTimeFormat().resolvedOptions().locale;
    const lang = normalizeLang(locale);
    if (lang) return { lang, from: 'system' };
  }
  const zone = src.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (zone && ZH_ZONES.has(zone)) return { lang: 'zh', from: 'timezone' };
  return { lang: 'en', from: 'default' };
}

/** 事件的一句话描述，按当前语言取中文或英文版 */
export const summaryOf = (e: { summary: string; summary_en?: string }) => (currentLang() === 'en' ? (e.summary_en ?? e.summary) : e.summary);

/** 命令行发给 Hub 的请求头：让 Hub 用同一种语言回复（报错、收件箱、任务详情） */
export const langHeaders = () => ({ 'x-ahub-lang': currentLang() });

/** 从收件箱 Markdown 里读出本次读到的事件号（中英文两种写法，见 format.ts 的 renderInbox） */
export const LAST_SEQ_RE = /(?:本次读到第 |Read up to event #)(\d+)/;
