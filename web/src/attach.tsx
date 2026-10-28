import { useRef, useState } from 'react';
import { type Part, type Uploaded, uploadFile } from './api';
import { useHub } from './ui';
import { t } from './i18n';

export const fileSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** 截图粘贴进来通常都叫 image.png，加上时间区分 */
export const renameScreenshot = (f: File) =>
  f.name === 'image.png' ? new File([f], `${t('截图')}-${new Date().toLocaleTimeString('sv').replaceAll(':', '')}.png`, { type: f.type }) : f;

/** 任务里已有的附件（/files/<编号>）换成可以继续编辑的上传记录 */
export const fromParts = (parts: Part[]): Uploaded[] =>
  parts.map((p) => ({ id: (p.url ?? '').replace(/^\/files\//, ''), name: p.name ?? 'file', mime: p.mime ?? '', size: p.size ?? 0, url: p.url ?? '' }));

/** 上传附件：选择、拖入或粘贴文件，逐个上传，最多 limit 个 */
export function useAttachments(limit: number, what: string, initial: Uploaded[] = []) {
  const { toast } = useHub();
  const [files, setFiles] = useState<Uploaded[]>(initial);
  const [uploading, setUploading] = useState(0);
  const attach = async (list: File[]) => {
    if (!list.length) return;
    if (files.length + list.length > limit) return toast(t('{what}最多带 {limit} 个附件', { what, limit }), true);
    setUploading((n) => n + list.length);
    for (const f of list) {
      try {
        const up = await uploadFile(f);
        setFiles((cur) => [...cur, up]);
      } catch (err) {
        toast((err as Error).message, true);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };
  const remove = (id: string) => setFiles((cur) => cur.filter((x) => x.id !== id));
  return { files, setFiles, uploading, attach, remove };
}

/** 已选附件的小标签，带移除按钮 */
export function AttachmentChips({ files, uploading, onRemove }: { files: Uploaded[]; uploading: number; onRemove: (id: string) => void }) {
  if (!files.length && !uploading) return null;
  return (
    <div className="attachments">
      {files.map((f) => (
        <span key={f.id} className="file-chip">
          {f.name}
          <span className="faint">{fileSize(f.size)}</span>
          <button type="button" className="chip-x" aria-label={t('移除 {name}', { name: f.name })} onClick={() => onRemove(f.id)}>
            ×
          </button>
        </span>
      ))}
      {uploading > 0 && <span className="faint">{t('正在上传 {n} 个文件…', { n: uploading })}</span>}
    </div>
  );
}

/** 表单里的附件区域：拖入、粘贴或点按钮选择文件 */
export function AttachmentField({ id, state, hint }: { id: string; state: ReturnType<typeof useAttachments>; hint?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      className={`attach-drop ${over ? 'over' : ''}`}
      tabIndex={0}
      onPaste={(e) => {
        const list = [...e.clipboardData.files];
        if (!list.length) return;
        e.preventDefault();
        void state.attach(list.map(renameScreenshot));
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        void state.attach([...e.dataTransfer.files]);
      }}
    >
      <div className="attach-bar">
        <button id={id} type="button" className="btn small" onClick={() => input.current?.click()}>
          {t('添加附件')}
        </button>
        <span className="faint">{hint ?? t('也可以把文件拖到这里，或点一下这里再粘贴截图；每个最大 25 MB')}</span>
      </div>
      <AttachmentChips files={state.files} uploading={state.uploading} onRemove={state.remove} />
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          void state.attach([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
    </div>
  );
}
