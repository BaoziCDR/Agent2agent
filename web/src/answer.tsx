// 阻塞提问：agent 卡住时提的问题和可选答案，负责人点一个答案（或自己写）即解除阻塞并唤起 agent。
import { useState } from 'react';
import { post, type Task } from './api';
import { useHub } from './ui';
import { t } from './i18n';
import { Markdown } from './markdown';

export function AnswerBox({ task, onDone, compact = false }: { task: Task; onDone?: () => void; compact?: boolean }) {
  const { agents, toast, refresh } = useHub();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async (answer: string) => {
    if (!answer.trim() || busy) return;
    setBusy(true);
    try {
      await post(`/tasks/${task.id}/answer`, { answer });
      toast(t('已回答，{who} 会继续处理', { who: task.assignee_name ?? 'agent' }));
      setText('');
      onDone?.();
      refresh();
    } catch (err) {
      toast((err as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`ask ${compact ? 'compact' : ''}`} onClick={(e) => compact && e.stopPropagation()}>
      {!compact && (
        <div className="ask-q">
          <span className="ask-label">{t('{who} 在等你回答', { who: task.assignee_name ?? 'agent' })}</span>
          <Markdown text={task.block_reason} agents={agents} />
        </div>
      )}
      {task.block_options.length > 0 && (
        <div className="ask-options">
          {task.block_options.map((o) => (
            <button key={o} className="btn small" disabled={busy} onClick={() => void send(o)} title={t('选这个答案并解除阻塞')}>
              {o}
            </button>
          ))}
        </div>
      )}
      {!compact && (
        <form
          className="ask-free"
          onSubmit={(e) => {
            e.preventDefault();
            void send(text);
          }}
        >
          <input
            className="input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={task.block_options.length ? t('或者写其他答案') : t('写下你的回答')}
            aria-label={t('回答')}
          />
          <button className="btn primary" disabled={!text.trim() || busy}>
            {t('回答并继续')}
          </button>
        </form>
      )}
    </div>
  );
}
