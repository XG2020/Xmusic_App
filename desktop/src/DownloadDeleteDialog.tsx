import {useEffect, useId, useRef} from 'react';
import {createPortal} from 'react-dom';
import {FileX2, ListX, LoaderCircle, X} from 'lucide-react';
import {isDownloadActive, type DownloadTask} from './downloads';
import './close-prompt.css';

export function DownloadDeleteDialog({task, pending, error, onChoose, onClose}: {
  task: DownloadTask;
  pending: boolean;
  error: string;
  onChoose(deleteFiles: boolean): void;
  onClose(): void;
}) {
  const panel = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const dialog = panel.current;
    if (!dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>('[data-delete-cancel]')?.focus();
    const keydown = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === 'Escape') {event.preventDefault(); close.current(); return;}
      if (event.key !== 'Tab') return;
      const controls = [...dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const first = controls[0], last = controls.at(-1);
      if (!first || !last) {event.preventDefault(); dialog.focus(); return;}
      if (!dialog.contains(document.activeElement) || (!event.shiftKey && document.activeElement === last)) {event.preventDefault(); first.focus();}
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {event.preventDefault(); last.focus();}
    };
    window.addEventListener('keydown', keydown, true);
    return () => {
      window.removeEventListener('keydown', keydown, true);
      dialog.close();
      if (previous?.isConnected) previous.focus();
      else document.querySelector<HTMLElement>('[data-downloads-title]')?.focus();
    };
  }, []);
  const files = [task.fileName, task.coverFileName, task.lyricsFileName].filter((name): name is string => !!name);
  return createPortal(<dialog ref={panel} className="close-prompt download-delete-dialog" role="dialog" aria-modal="true"
    aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={pending} tabIndex={-1}
    onCancel={event => {event.preventDefault(); onClose();}} onClick={event => {if (event.target === event.currentTarget) onClose();}}>
    <div className="close-prompt-content">
      <header className="download-delete-heading"><h2 id={titleId}>删除下载</h2><button type="button" className="icon-button" aria-label="关闭删除对话框" disabled={pending} onClick={onClose}><X size={19}/></button></header>
      <p id={descriptionId} className="close-prompt-description">选择如何处理「{task.track.title}」。{isDownloadActive(task) && '删除记录也会停止这项正在进行的下载。'}</p>
      {!!files.length && <ul className="download-delete-files" aria-label="此任务的已保存文件">{files.map(name => <li key={name}>{name}</li>)}</ul>}
      <div className="close-prompt-options">
        <button type="button" className="close-prompt-option" disabled={pending} onClick={() => onChoose(false)}>
          <span className="close-prompt-option-icon"><ListX size={21}/></span><span><strong>仅删除记录</strong><small>保留已下载的音频、封面和歌词文件</small></span>
        </button>
        <button type="button" className="close-prompt-option download-delete-files-option" disabled={pending} onClick={() => onChoose(true)}>
          <span className="close-prompt-option-icon"><FileX2 size={21}/></span><span><strong>同时删除音频、封面和歌词</strong><small>删除这项任务保存的文件，并移除对应的本地音乐记录</small></span>
        </button>
      </div>
      {error && <p className="close-prompt-error" role="alert">{error}</p>}
      <footer><span className="close-prompt-progress" role="status">{pending && <><LoaderCircle size={14}/>正在删除…</>}</span>
        <button type="button" data-delete-cancel className="secondary-button" disabled={pending} onClick={onClose}>取消</button></footer>
    </div>
  </dialog>, document.body);
}
