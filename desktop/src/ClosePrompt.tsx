import {useCallback, useEffect, useId, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {ArrowDownToLine, LoaderCircle, Power, X} from 'lucide-react';
import type {ClosePromptAction, ClosePromptState} from './types';
import appIcon from '../resources/icon.png';
import './close-prompt.css';

function ClosePromptDialog({prompt, pending, error, onChoose}: {
  prompt: ClosePromptState;
  pending: boolean;
  error: string;
  onChoose(action: ClosePromptAction, remember?: boolean): void;
}) {
  const [remember, setRemember] = useState(false);
  const titleId = useId();
  const descriptionId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const choice = useRef(onChoose);
  choice.current = onChoose;
  useEffect(() => {
    const panel = dialog.current;
    if (!panel) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.showModal();
    panel.querySelector<HTMLButtonElement>('[data-close-default]')?.focus();
    // Keep player shortcuts and any underlying dialog out of this modal's keyboard interaction.
    const onKeyDown = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === 'Escape') {event.preventDefault(); choice.current('cancel'); return;}
      if (event.key !== 'Tab') return;
      const controls = [...panel.querySelectorAll<HTMLElement>(':is(button, input):not(:disabled)')];
      const first = controls[0], last = controls.at(-1);
      if (!first || !last) {event.preventDefault(); panel.focus(); return;}
      if (!panel.contains(document.activeElement) || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault(); first.focus();
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        event.preventDefault(); last.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      panel.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return createPortal(<dialog ref={dialog} className="close-prompt" aria-labelledby={titleId} aria-describedby={descriptionId}
    aria-modal="true" tabIndex={-1} onCancel={event => {event.preventDefault(); onChoose('cancel');}}
    onClick={event => {if (event.target === event.currentTarget) onChoose('cancel');}}>
    <div className="close-prompt-content">
      <header className="close-prompt-header">
        <div className="close-prompt-brand"><img src={appIcon} alt=""/><span>Xmusic</span></div>
        <button type="button" className="icon-button" aria-label="取消关闭" disabled={pending} onClick={() => onChoose('cancel')}><X size={19}/></button>
      </header>
      <h2 id={titleId}>关闭 Xmusic</h2>
      <p id={descriptionId} className="close-prompt-description">{prompt.canHide ? '让音乐继续，还是暂时告别？' : '退出后将停止播放，并结束后台任务。'}</p>
      <div className="close-prompt-options">
        {prompt.canHide && <button type="button" data-close-default className="close-prompt-option close-prompt-hide" disabled={pending} onClick={() => onChoose('hide', remember)}>
          <span className="close-prompt-option-icon"><ArrowDownToLine size={21}/></span>
          <span><strong>隐藏到托盘</strong><small>音乐和下载继续，点击托盘图标即可返回</small></span>
        </button>}
        <button type="button" className="close-prompt-option close-prompt-quit" disabled={pending} onClick={() => onChoose('quit', remember)}>
          <span className="close-prompt-option-icon"><Power size={21}/></span>
          <span><strong>退出软件</strong><small>停止播放并关闭 Xmusic</small></span>
        </button>
      </div>
      <label className="close-prompt-remember"><input type="checkbox" checked={remember} disabled={pending} onChange={event => setRemember(event.target.checked)}/><span>记住我的选择</span></label>
      <p className="close-prompt-remember-help">之后可在「设置 · 软件行为」中修改。</p>
      {!prompt.canHide && <p className="close-prompt-notice" role="status">当前系统托盘不可用，可取消并继续使用主窗口。</p>}
      {error && <p className="close-prompt-error" role="alert">{error}</p>}
      <footer>
        <span className="close-prompt-progress" role="status">{pending && <><LoaderCircle size={14}/>正在处理…</>}</span>
        <button type="button" data-close-default={prompt.canHide ? undefined : true} className="secondary-button" disabled={pending} onClick={() => onChoose('cancel')}>取消</button>
      </footer>
    </div>
  </dialog>, document.body);
}

/** Subscribe before reading state so a close during renderer startup is never lost. */
export default function ClosePrompt() {
  const [prompt, setPrompt] = useState<ClosePromptState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const revision = useRef(0);
  const active = useRef(false);
  const request = useRef<object | null>(null);
  useEffect(() => {
    const desktop = window.desktop;
    if (!desktop) return;
    let disposed = false;
    active.current = true;
    const unsubscribe = desktop.onClosePrompt(value => {
      revision.current++;
      request.current = null;
      setPrompt(value);
      setPending(false);
      setError('');
    });
    const initialRevision = revision.current;
    void desktop.getClosePrompt().then(value => {
      if (!disposed && revision.current === initialRevision) setPrompt(value);
    }).catch(() => { /* A later close event can still open the prompt after a startup read fails. */ });
    return () => {disposed = true; active.current = false; unsubscribe();};
  }, []);
  const choose = useCallback((action: ClosePromptAction, remember = false) => {
    if (!prompt || !window.desktop || request.current) return;
    const token = {};
    const sentRevision = revision.current;
    request.current = token;
    setPending(true);
    setError('');
    void window.desktop.respondToClosePrompt({id: prompt.id, action, ...(remember && action !== 'cancel' ? {remember: true} : {})}).then(value => {
      if (active.current && revision.current === sentRevision) setPrompt(value);
    }).catch(cause => {
      if (active.current && revision.current === sentRevision) {
        setError(cause instanceof Error ? cause.message : '操作失败，请重试。');
      }
    }).finally(() => {
      if (request.current === token) {
        request.current = null;
        if (active.current) setPending(false);
      }
    });
  }, [prompt]);
  return prompt ? <ClosePromptDialog key={prompt.id} prompt={prompt} pending={pending} error={error} onChoose={choose}/> : null;
}
