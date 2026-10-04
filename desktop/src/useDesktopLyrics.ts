import {useCallback, useEffect, useRef, useState} from 'react';
import type {DesktopLyricsContent, DesktopLyricsState} from './types';

export function useDesktopLyrics(content: DesktopLyricsContent, togglePlayback: () => void, next: (direction: 1 | -1) => void, report: (message: string) => void, getPosition?: () => number) {
  const [state, setState] = useState<DesktopLyricsState>({visible: false, locked: false});
  const [pending, setPending] = useState(false);
  const stateRef = useRef(state);
  const pendingRef = useRef(false);
  const controls = useRef({togglePlayback, next, report});
  controls.current = {togglePlayback, next, report};
  const liveContent = useRef(content);
  liveContent.current = content;
  const acceptState = useCallback((value: DesktopLyricsState) => { stateRef.current = value; setState(value); }, []);

  useEffect(() => {
    const bridge = window.desktop;
    if (!bridge?.getDesktopLyricsState) return;
    let alive = true, changed = false;
    const unsubscribe = bridge.onDesktopLyricsState(value => {changed = true; if (alive) acceptState(value);});
    const uncommands = bridge.onDesktopPlaybackCommand(command => {
      if (command === 'toggle') controls.current.togglePlayback();
      else if (command === 'previous') controls.current.next(-1);
      else if (command === 'next') controls.current.next(1);
    });
    bridge.getDesktopLyricsState().then(value => {if (alive && !changed) acceptState(value);}).catch(() => {});
    return () => { alive = false; unsubscribe(); uncommands(); };
  }, [acceptState]);

  // Images can be much larger than the timing payload. Send them only when changed.
  useEffect(() => {
    const {backgroundImage: _image, ...rest} = liveContent.current;
    window.desktop?.updateDesktopLyrics?.({...rest, position: getPosition?.() ?? rest.position});
  }, [content.title, content.artist, content.line, content.nextLine, content.playing, content.accentColor, content.fontSize, content.fontFamily, content.opacity, content.singleLine, content.borderRadius, content.words, content.lineStart, content.lineEnd, content.position, content.playbackRate, content.loading, getPosition]);
  useEffect(() => {
    window.desktop?.updateDesktopLyrics?.({backgroundImage: content.backgroundImage});
  }, [content.backgroundImage]);
  useEffect(() => {
    if (!state.visible || !content.playing || content.loading || !getPosition) return;
    const timer = window.setInterval(() => {
      window.desktop?.updateDesktopLyrics?.({position: getPosition()});
    }, 100);
    return () => window.clearInterval(timer);
  }, [state.visible, content.playing, content.loading, getPosition]);

  const toggleVisible = useCallback(async () => {
    if (pendingRef.current) return;
    if (!window.desktop?.setDesktopLyricsVisible) { controls.current.report('请在 Windows 客户端中使用桌面悬浮歌词。'); return; }
    pendingRef.current = true; setPending(true);
    try { acceptState(await window.desktop.setDesktopLyricsVisible(!stateRef.current.visible)); }
    catch (error) { controls.current.report(error instanceof Error ? error.message : '无法打开桌面歌词。'); }
    finally { pendingRef.current = false; setPending(false); }
  }, [acceptState]);

  const setLocked = useCallback(async (locked: boolean) => {
    if (!window.desktop?.setDesktopLyricsLocked) return;
    try { acceptState(await window.desktop.setDesktopLyricsLocked(locked)); }
    catch (error) { controls.current.report(error instanceof Error ? error.message : '无法修改桌面歌词锁定状态。'); }
  }, [acceptState]);

  return {...state, pending, toggleVisible, setLocked};
}
