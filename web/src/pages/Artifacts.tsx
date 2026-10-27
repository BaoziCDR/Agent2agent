import { useState } from 'react';
import { ApiError, get, put, type Agent, type Artifact, type ArtifactRevision, type Part } from '../api';
import { Modal, agentLabel, clock, useData, useHub } from '../ui';
import { Markdown } from '../markdown';
import { foldDiff, lineDiff } from '../diff';

const fileSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const isImage = (p: { mime?: string }) => /^image\/(png|jpeg|gif|webp)$/.test(p.mime ?? '');

/** 只有一段文本的交付物才能逐行对比和在线编辑。 */
const textOf = (parts: Part[]) => (parts.length === 1 && parts[0].kind === 'text' && typeof parts[0].text === 'string' ? parts[0].text : null);

const who = (agents: Agent[], code: string | null) => (!code ? '' : code === 'owner' ? '负责人' : agentLabel(agents, code));

/** 文件：图片显示缩略图，其他显示文件名和大小。 */
export function FilePart({ p }: { p: Part }) {
  if (isImage(p))
    return (
      <a className="file-thumb" href={p.url} target="_blank" rel="noreferrer" title={`${p.name} · ${fileSize(p.size ?? 0)}`}>
        <img src={p.url} alt={p.name} loading="lazy" />
      </a>
    );
  return (
    <div className="file-chip">
      <a href={p.url} target="_blank" rel="noreferrer" download={p.name}>
        {p.name}
      </a>
      <span className="faint">{fileSize(p.size ?? 0)}</span>
    </div>
  );
}

function PartsView({ parts }: { parts: Part[] }) {
  const { agents } = useHub();
  return (
    <>
      {parts.map((p, i) =>
        p.kind === 'file' ? (
          <FilePart key={i} p={p} />
        ) : p.kind === 'link' ? (
          <div key={i}>
            <a href={p.url} target="_blank" rel="noreferrer">
              {p.url}
            </a>
          </div>
        ) : p.text !== undefined ? (
          <Markdown key={i} text={p.text} agents={agents} />
        ) : (
          <pre key={i}>{JSON.stringify(p.data, null, 2)}</pre>
        ),
      )}
    </>
  );
}

function DiffView({ before, after }: { before: string; after: string }) {
  const hunks = foldDiff(lineDiff(before, after));
  const added = hunks.filter((h) => h.kind === 'add').length;
  const removed = hunks.filter((h) => h.kind === 'del').length;
  if (!added && !removed) return <div className="faint">两个版本内容相同</div>;
  return (
    <div>
      <div className="diff-stat">
        <span className="diff-add-n">+{added}</span> <span className="diff-del-n">−{removed}</span> 行
      </div>
      <div className="diff">
        {hunks.map((h, i) =>
          h.kind === 'skip' ? (
            <div key={i} className="diff-skip">
              ⋯ {h.count} 行未改动
            </div>
          ) : (
            <div key={i} className={`diff-line ${h.kind}`}>
              <span className="diff-no">{h.kind === 'add' ? '' : h.a}</span>
              <span className="diff-no">{h.kind === 'del' ? '' : h.b}</span>
              <span className="diff-sign">{h.kind === 'add' ? '+' : h.kind === 'del' ? '−' : ' '}</span>
              <span className="diff-text">{h.text || ' '}</span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

/** 修改历史：左边是版本列表，右边是选中版本相对上一版的改动或完整内容。 */
function HistoryDialog({ task, artifact, onClose }: { task: string; artifact: Artifact; onClose: () => void }) {
  const { agents } = useHub();
  const { data: revs } = useData(() => get<ArtifactRevision[]>(`/tasks/${task}/artifacts/${artifact.id}/revisions`), [task, artifact.id, artifact.rev]);
  const [sel, setSel] = useState<number | null>(null);
  const [mode, setMode] = useState<'diff' | 'full'>('diff');
  const cur = revs?.find((r) => r.rev === (sel ?? artifact.rev));
  const prev = cur && revs?.find((r) => r.rev === cur.rev - 1);
  const curText = cur && textOf(cur.parts);
  const prevText = prev && textOf(prev.parts);
  return (
    <Modal title={`「${artifact.name}」的修改历史`} onClose={onClose} wide>
      <div className="history">
        <div className="history-list">
          {revs
            ?.slice()
            .reverse()
            .map((r) => (
              <button key={r.rev} className={`history-item ${cur?.rev === r.rev ? 'active' : ''}`} onClick={() => setSel(r.rev)}>
                <b>第 {r.rev} 版</b>
                {r.rev === artifact.rev && <span className="badge accent">当前</span>}
                <div className="faint">
                  {who(agents, r.author)} · {clock(r.created_at)}
                </div>
                <div className="faint history-note">{r.note || (r.rev === 1 ? '提交' : '')}</div>
              </button>
            ))}
        </div>
        <div className="history-body">
          {cur && (
            <>
              <div className="btn-row" style={{ marginBottom: 10 }}>
                <div className="tabs" style={{ margin: 0 }}>
                  <button className={`tab ${mode === 'diff' ? 'active' : ''}`} disabled={!prev} onClick={() => setMode('diff')}>
                    与第 {cur.rev - 1 || 1} 版对比
                  </button>
                  <button className={`tab ${mode === 'full' || !prev ? 'active' : ''}`} onClick={() => setMode('full')}>
                    完整内容
                  </button>
                </div>
              </div>
              {mode === 'diff' && prev ? (
                curText !== null && prevText !== null ? (
                  <DiffView before={prevText!} after={curText!} />
                ) : (
                  <div className="faint">这份交付物不是纯文本，不能逐行对比，请看完整内容。</div>
                )
              ) : (
                <div className="artifact-body">
                  <PartsView parts={cur.parts} />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

function CompareDialog({ before, after, onClose }: { before: Artifact; after: Artifact; onClose: () => void }) {
  return (
    <Modal title={`「${after.name}」：第 ${before.round} 次提交 → 第 ${after.round} 次提交`} onClose={onClose} wide>
      <DiffView before={textOf(before.parts) ?? ''} after={textOf(after.parts) ?? ''} />
    </Modal>
  );
}

/** 负责人直接改：整份替换，基于打开时的版本；有人先改了就提示重新加载。 */
function EditDialog({ task, artifact, onClose, onSaved }: { task: string; artifact: Artifact; onClose: () => void; onSaved: () => void }) {
  const { toast } = useHub();
  const [text, setText] = useState(textOf(artifact.parts) ?? '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await put(`/tasks/${task}/artifacts/${artifact.id}`, { base_rev: artifact.rev, content: text, note });
      toast(`已保存为第 ${artifact.rev + 1} 版`);
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setStale(true);
      else toast((err as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`修改「${artifact.name}」（基于第 ${artifact.rev} 版）`} onClose={onClose} wide>
      {stale && (
        <div className="notice warn" style={{ marginBottom: 10 }}>
          在你编辑期间，这份交付物已经被别人改过了。为了不覆盖别人的修改，这次没有保存。请复制你的改动，关闭后重新打开最新版本再改。
        </div>
      )}
      <textarea className="textarea artifact-editor" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      <div className="field" style={{ marginTop: 10 }}>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="改了什么（可选），会写进修改历史" />
      </div>
      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>
          取消
        </button>
        <button className="btn primary" disabled={busy || stale} onClick={save}>
          保存为第 {artifact.rev + 1} 版
        </button>
      </div>
    </Modal>
  );
}

/** 任务详情里的交付物：按提交轮次分组，最新一次展开，更早的折叠。 */
export function Artifacts({ task, artifacts, onChanged }: { task: string; artifacts: Artifact[]; onChanged: () => void }) {
  const { agents } = useHub();
  const rounds = [...new Set(artifacts.map((a) => a.round))].sort((x, y) => y - x);
  const latest = rounds[0];
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const [history, setHistory] = useState<Artifact | null>(null);
  const [compare, setCompare] = useState<{ before: Artifact; after: Artifact } | null>(null);
  const [editing, setEditing] = useState<Artifact | null>(null);

  /** 上一轮里同名的文本交付物，用来对比重新提交改了什么。 */
  const previousOf = (a: Artifact) => {
    if (textOf(a.parts) === null) return null;
    return (
      artifacts
        .filter((x) => x.round < a.round && x.name === a.name && textOf(x.parts) !== null)
        .sort((x, y) => y.round - x.round)[0] ?? null
    );
  };

  const card = (a: Artifact) => {
    const prev = previousOf(a);
    return (
      <div key={a.id} className="artifact" data-source={`「${a.name}」（${a.author}）`}>
        <div className="artifact-meta">
          <div className="artifact-title">
            <b>{a.name}</b>
            <span className="faint">#{a.id}</span>
            <span className={`badge ${a.rev > 1 ? 'accent' : ''}`} title="版本号：每次修改加一">
              v{a.rev}
            </span>
          </div>
          <div className="faint artifact-who">
            {who(agents, a.author)} {clock(a.created_at)} 提交
            {a.rev > 1 && a.updated_at && (
              <>
                {' '}
                · {who(agents, a.updated_by)} {clock(a.updated_at)} 修改
              </>
            )}
          </div>
          <div className="btn-row artifact-actions">
            {prev && (
              <button className="btn small" onClick={() => setCompare({ before: prev, after: a })}>
                与第 {prev.round} 次提交对比
              </button>
            )}
            {a.rev > 1 && (
              <button className="btn small" onClick={() => setHistory(a)}>
                历史（{a.rev} 版）
              </button>
            )}
            {textOf(a.parts) !== null && (
              <button className="btn small" onClick={() => setEditing(a)}>
                修改
              </button>
            )}
          </div>
        </div>
        <PartsView parts={a.parts} />
      </div>
    );
  };

  return (
    <>
      {rounds.map((r) => {
        const items = artifacts.filter((a) => a.round === r);
        const expanded = r === latest || open.has(r);
        const toggle = () =>
          setOpen((s) => {
            const n = new Set(s);
            if (n.has(r)) n.delete(r);
            else n.add(r);
            return n;
          });
        return (
          <div key={r} className={`round ${r === latest ? 'latest' : 'older'}`}>
            {rounds.length > 1 && (
              <button className="round-head" onClick={r === latest ? undefined : toggle} disabled={r === latest} aria-expanded={expanded}>
                {r !== latest && <span className="round-caret">{expanded ? '▾' : '▸'}</span>}
                <b>第 {r} 次提交</b>
                {r === latest && <span className="badge accent">最新</span>}
                <span className="faint">
                  {clock(items[0].created_at)} · {items.length} 份
                </span>
              </button>
            )}
            {expanded && items.map(card)}
          </div>
        );
      })}
      {history && <HistoryDialog task={task} artifact={history} onClose={() => setHistory(null)} />}
      {compare && <CompareDialog before={compare.before} after={compare.after} onClose={() => setCompare(null)} />}
      {editing && <EditDialog task={task} artifact={editing} onClose={() => setEditing(null)} onSaved={onChanged} />}
    </>
  );
}
