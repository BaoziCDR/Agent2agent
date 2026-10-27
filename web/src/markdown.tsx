// 轻量 Markdown 渲染：任务描述、工作笔记、评论、交付说明、私信都用它。
// 只生成 React 元素，不拼 HTML，所以 agent 写进来的任何内容都不会变成脚本。
// 支持：标题、段落（单个换行即换行）、列表/任务列表、引用、代码块、表格、分隔线；
// 行内：`代码`、**粗体**、*斜体*、~~删除线~~、[链接](url)、裸链接、@提及。
import type { ReactNode } from 'react';
import type { Agent } from './api';

const SAFE_URL = /^(https?:\/\/|\/files\/|#)/i;

const INLINE =
  /(`[^`\n]+`)|(\*\*[^\n]+?\*\*)|(~~[^~\n]+?~~)|(\*[^*\s](?:[^*\n]*[^*\s])?\*)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()（）「」，。]+[^\s<>()（）「」，。.,;:!?'"])|(@(?:A-\d+|负责人|owner))/gi;

function inline(text: string, agents: Agent[], key = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    out.push(text.slice(last, m.index));
    const k = `${key}-${n++}`;
    const [s] = m;
    if (m[1]) out.push(<code key={k}>{s.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{inline(s.slice(2, -2), agents, k)}</strong>);
    else if (m[3]) out.push(<del key={k}>{inline(s.slice(2, -2), agents, k)}</del>);
    else if (m[4]) out.push(<em key={k}>{inline(s.slice(1, -1), agents, k)}</em>);
    else if (m[5]) {
      const [, label, url] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(s)!;
      out.push(
        SAFE_URL.test(url) ? (
          <a key={k} href={url} target={url.startsWith('#') ? undefined : '_blank'} rel="noreferrer">
            {inline(label, agents, k)}
          </a>
        ) : (
          s
        ),
      );
    } else if (m[6])
      out.push(
        <a key={k} href={s} target="_blank" rel="noreferrer">
          {s}
        </a>,
      );
    else {
      const code = /^@A-\d+$/i.test(s) ? s.slice(1).toUpperCase() : null;
      const name = code ? agents.find((a) => a.id === code)?.name : '负责人';
      out.push(
        <span key={k} className="mention" title={code ?? '负责人'}>
          @{name ?? s.slice(1)}
        </span>,
      );
    }
    last = m.index + s.length;
  }
  out.push(text.slice(last));
  return out;
}

/** 段落里的单个换行保留为换行：agent 和人写评论时都习惯这样。 */
function lines(text: string, agents: Agent[], key: string): ReactNode[] {
  return text.split('\n').flatMap((l, i) => (i === 0 ? inline(l, agents, `${key}.${i}`) : [<br key={`${key}br${i}`} />, ...inline(l, agents, `${key}.${i}`)]));
}

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));

export function Markdown({ text, agents = [], className = '' }: { text: string; agents?: Agent[]; className?: string }) {
  const src = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < src.length) {
    const line = src[i];
    const key = `b${i}`;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^\s*(```+|~~~+)\s*([\w+-]*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < src.length && !src[i].trim().startsWith(fence[1])) body.push(src[i++]);
      i++;
      blocks.push(
        <pre key={key} data-lang={fence[2] || undefined}>
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push(
        <div key={key} className={`md-h md-h${Math.min(h[1].length, 3)}`}>
          {inline(h[2].replace(/\s+#+\s*$/, ''), agents, key)}
        </div>,
      );
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push(<hr key={key} />);
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < src.length && /^\s*>/.test(src[i])) body.push(src[i++].replace(/^\s*>\s?/, ''));
      blocks.push(
        <blockquote key={key}>
          <Markdown text={body.join('\n')} agents={agents} />
        </blockquote>,
      );
      continue;
    }
    if (line.includes('|') && i + 1 < src.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(src[i + 1])) {
      const head = cells(line);
      const align = cells(src[i + 1]).map((c) => (c.endsWith(':') ? (c.startsWith(':') ? 'center' : 'right') : undefined));
      i += 2;
      const rows: string[][] = [];
      while (i < src.length && src[i].includes('|') && src[i].trim()) rows.push(cells(src[i++]));
      blocks.push(
        <div key={key} className="md-table">
          <table>
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j} style={{ textAlign: align[j] }}>
                    {inline(c, agents, `${key}h${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {head.map((_, j) => (
                    <td key={j} style={{ textAlign: align[j] }}>
                      {inline(r[j] ?? '', agents, `${key}r${ri}c${j}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }
    if (LIST.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: { text: string; checked: boolean | null; depth: number }[] = [];
      while (i < src.length) {
        const m = LIST.exec(src[i]);
        if (m) {
          const task = /^\[([ xX])\]\s+(.*)$/.exec(m[3]);
          items.push({ text: task ? task[2] : m[3], checked: task ? task[1] !== ' ' : null, depth: Math.min(Math.floor(m[1].length / 2), 3) });
          i++;
        } else if (src[i].trim() && /^\s{2,}/.test(src[i]) && items.length) items[items.length - 1].text += `\n${src[i++].trim()}`;
        else break;
      }
      const Tag = ordered ? 'ol' : 'ul';
      blocks.push(
        <Tag key={key} className={items.some((it) => it.checked !== null) ? 'md-tasks' : undefined}>
          {items.map((it, j) => (
            <li key={j} style={it.depth ? { marginLeft: it.depth * 18 } : undefined}>
              {it.checked !== null && <input type="checkbox" checked={it.checked} readOnly tabIndex={-1} />}
              {lines(it.text, agents, `${key}l${j}`)}
            </li>
          ))}
        </Tag>,
      );
      continue;
    }
    const para = [src[i++]];
    while (i < src.length && src[i].trim() && !/^\s*(```|~~~|#{1,6}\s|>)/.test(src[i]) && !LIST.test(src[i])) para.push(src[i++]);
    blocks.push(<p key={key}>{lines(para.join('\n'), agents, key)}</p>);
  }
  return <div className={`md ${className}`}>{blocks}</div>;
}
