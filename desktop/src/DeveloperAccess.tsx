import {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';

function UnlockDialog({onUnlock, onClose}: {onUnlock(): void; onClose(): void}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  return createPortal(<dialog ref={dialog} className="developer-dialog" aria-label="开发者模式" onCancel={event => {event.preventDefault(); onClose();}}>
    <form onSubmit={event => {
      event.preventDefault();
      if (key !== 'XG2020') {setError('密钥不正确，请重试。'); return;}
      onUnlock(); onClose();
    }}>
      <h2>开发者模式</h2><p>请输入密钥，以显示自定义音乐接口设置。</p>
      <label>开发者密钥<input autoFocus type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} maxLength={80}/></label>
      {error && <p className="theme-field-error" role="alert">{error}</p>}
      <footer><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button">进入开发者模式</button></footer>
    </form>
  </dialog>, document.body);
}

export function DeveloperAccess({version, enabled, onUnlock}: {version: string; enabled: boolean; onUnlock(): void}) {
  const taps = useRef({count: 0, at: 0});
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="nav-count version-access" aria-label={`版本 v${version}`} title={`v${version}`} onClick={() => {
      if (enabled) return;
      const now = Date.now();
      taps.current = {count: now - taps.current.at < 3000 ? taps.current.count + 1 : 1, at: now};
      if (taps.current.count >= 5) {taps.current.count = 0; setOpen(true);}
    }}>v{version}</button>
    {open && <UnlockDialog onUnlock={onUnlock} onClose={() => setOpen(false)}/>}
  </>;
}
