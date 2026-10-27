import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Agent } from './api';

export interface MentionCandidate {
  code: string; // 插入到文本里的编号，如 A-3、负责人
  name: string;
  tags?: string[]; // 能力标签，也参与筛选
  hint?: string; // 只用于显示，如平台
  online?: boolean;
}

export const agentCandidates = (agents: Agent[], project?: string): MentionCandidate[] =>
  agents.filter((a) => a.status !== 'deleted').map((a) => ({
    code: a.id,
    name: a.name,
    tags: a.projects.find((p) => p.id === project)?.tags ?? [],
    hint: a.platform,
    online: a.online,
  }));

/** 光标前的「@关键字」；没有则返回 null。 */
function activeQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|[\s(（,，。:：;；])@([^\s@]{0,20})$/.exec(before);
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}

function match(c: MentionCandidate, q: string) {
  if (!q) return true;
  const s = q.toLowerCase();
  return [c.code, c.name, ...(c.tags ?? [])].some((v) => v.toLowerCase().includes(s));
}

/** 带 @ 自动补全的多行输入框：输入 @ 后按编号、名字或能力标签筛选成员。 */
export function MentionTextarea({
  value,
  onChange,
  candidates,
  onSubmit,
  ...rest
}: {
  value: string;
  onChange: (v: string) => void;
  candidates: MentionCandidate[];
  onSubmit?: () => void;
  placeholder?: string;
  'aria-label'?: string;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [q, setQ] = useState<{ start: number; query: string } | null>(null);
  const [sel, setSel] = useState(0);
  const caretAfter = useRef<number | null>(null);

  // 插入提及后，在新文本渲染完成时立即把光标放到提及后面
  useLayoutEffect(() => {
    if (caretAfter.current === null || !ref.current) return;
    ref.current.focus();
    ref.current.setSelectionRange(caretAfter.current, caretAfter.current);
    caretAfter.current = null;
  }, [value]);

  const list = useMemo(() => (q ? candidates.filter((c) => match(c, q.query)).slice(0, 8) : []), [q, candidates]);
  const open = q !== null && list.length > 0;

  const sync = (el: HTMLTextAreaElement) => {
    const next = activeQuery(el.value, el.selectionStart ?? el.value.length);
    setQ(next);
    if (next?.query !== q?.query) setSel(0);
  };

  const pick = (c: MentionCandidate) => {
    if (!q) return;
    const el = ref.current!;
    const caret = el.selectionStart ?? value.length;
    const insert = `@${c.code} `;
    const next = value.slice(0, q.start) + insert + value.slice(caret);
    caretAfter.current = q.start + insert.length;
    onChange(next);
    setQ(null);
  };

  return (
    <div className="mention-wrap">
      <textarea
        ref={ref}
        className="textarea"
        value={value}
        {...rest}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls="mention-list"
        onChange={(e) => {
          onChange(e.target.value);
          sync(e.target);
        }}
        onClick={(e) => sync(e.currentTarget)}
        onKeyUp={(e) => ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) && sync(e.currentTarget)}
        onBlur={() => setTimeout(() => setQ(null), 120)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return; // 中文输入法选词中，回车不算选择
          if (open) {
            if (e.key === 'ArrowDown') return e.preventDefault(), setSel((sel + 1) % list.length);
            if (e.key === 'ArrowUp') return e.preventDefault(), setSel((sel - 1 + list.length) % list.length);
            if (e.key === 'Enter' || e.key === 'Tab') return e.preventDefault(), pick(list[Math.min(sel, list.length - 1)]);
            if (e.key === 'Escape') return e.preventDefault(), e.stopPropagation(), setQ(null);
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && onSubmit) {
            e.preventDefault();
            onSubmit();
          }
        }}
      />
      {open && (
        <ul className="mention-list" id="mention-list" role="listbox">
          {list.map((c, i) => (
            <li
              key={c.code}
              role="option"
              aria-selected={i === sel}
              className={i === sel ? 'active' : ''}
              onMouseDown={(e) => (e.preventDefault(), pick(c))}
              onMouseEnter={() => setSel(i)}
            >
              {c.online !== undefined && <span className={`dot ${c.online ? 'online' : ''}`} />}
              <b>{c.name}</b>
              <span className="faint">{c.code}</span>
              {(c.hint || c.tags?.length) && <span className="faint mention-hint">{[c.hint, ...(c.tags ?? [])].filter(Boolean).join(' · ')}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 把评论里的 @A-3 显示成带名字的高亮。 */
export function MentionText({ text, agents }: { text: string; agents: Agent[] }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(/@(A-\d+|负责人|owner)/gi)) {
    const code = m[1].toUpperCase().startsWith('A-') ? m[1].toUpperCase() : null;
    const name = code ? agents.find((a) => a.id === code)?.name : '负责人';
    out.push(text.slice(last, m.index));
    out.push(
      <span key={m.index} className="mention" title={code ?? '负责人'}>
        @{name ?? m[1]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}
