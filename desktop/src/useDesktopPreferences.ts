import {useCallback, useEffect, useRef, useState} from 'react';
import type {DesktopPreferences} from './types';

const defaults: DesktopPreferences = {closeAction: 'ask', shortcutsEnabled: true};

export function useDesktopPreferences() {
  const [preferences, setPreferences] = useState<DesktopPreferences>(defaults);
  const [loading, setLoading] = useState(!!window.desktop);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const revision = useRef(0);
  const alive = useRef(false);
  const saving = useRef(false);
  useEffect(() => {
    alive.current = true;
    const desktop = window.desktop;
    if (!desktop) return () => {alive.current = false;};
    let disposed = false;
    const unsubscribe = desktop.onPreferencesChanged(value => {
      revision.current++;
      setPreferences(value);
      setLoading(false);
      setError('');
    });
    const initialRevision = revision.current;
    void desktop.getPreferences().then(value => {
      if (!disposed && revision.current === initialRevision) setPreferences(value);
    }).catch(cause => {
      if (!disposed && revision.current === initialRevision) setError(cause instanceof Error ? cause.message : '无法读取软件行为设置。');
    }).finally(() => {if (!disposed) setLoading(false);});
    return () => {disposed = true; alive.current = false; unsubscribe();};
  }, []);

  const update = useCallback(async (patch: Partial<DesktopPreferences>) => {
    if (saving.current) return;
    if (!window.desktop) {setPreferences(value => ({...value, ...patch})); return;}
    const sentRevision = revision.current;
    saving.current = true;
    setPending(true);
    setError('');
    try {
      const next = await window.desktop.setPreferences(patch);
      if (alive.current && revision.current === sentRevision) setPreferences(next);
    } catch (cause) {
      if (alive.current && revision.current === sentRevision) setError(cause instanceof Error ? cause.message : '设置保存失败，请重试。');
    } finally {
      saving.current = false;
      if (alive.current) setPending(false);
    }
  }, []);

  return {preferences, loading, pending, error, update};
}

export type DesktopPreferencesState = ReturnType<typeof useDesktopPreferences>;
