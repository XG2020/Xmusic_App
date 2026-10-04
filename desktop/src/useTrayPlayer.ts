import {useEffect, useRef} from 'react';
import type {TrayPlayerCommand, TrayPlayerState} from './types';

export function useTrayPlayer(state: TrayPlayerState, onCommand: (command: TrayPlayerCommand) => void) {
  const handler = useRef(onCommand);
  handler.current = onCommand;
  useEffect(() => window.desktop?.onTrayPlayerCommand?.(command => handler.current(command)), []);
  useEffect(() => {
    window.desktop?.updateTrayPlayer?.(state);
  }, [state.title, state.artist, state.playing, state.favorite, state.volume, state.muted, state.hasTrack, state.hasQueue]);
}
