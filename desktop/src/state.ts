import {useEffect, useState, type Dispatch, type SetStateAction} from 'react';
import type {Track} from './types';

export function useStoredState<T>(key: string, fallback: T, validate: (value: unknown) => value is T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(`xmusic:${key}`) ?? 'null');
      return validate(stored) ? stored : fallback;
    } catch { return fallback; }
  });
  useEffect(() => {
    try { localStorage.setItem(`xmusic:${key}`, JSON.stringify(value)); }
    catch { window.dispatchEvent(new CustomEvent('storage-error')); }
  }, [key, value]);
  return [value, setValue];
}

export const isString = (value: unknown): value is string => typeof value === 'string';
export const isVolume = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
export function isTracks(value: unknown): value is Track[] {
  return Array.isArray(value) && value.length <= 10000 && value.every(track =>
    track && typeof track === 'object' && typeof track.key === 'string' && track.key.trim().length > 0 &&
    typeof track.title === 'string' && typeof track.artist === 'string' &&
    (track.source === 'local' || track.source === 'online') &&
    ['album', 'coverUrl', 'mid', 'localId'].every(field => track[field] === undefined || typeof track[field] === 'string') &&
    ['duration', 'songId'].every(field => track[field] === undefined || (typeof track[field] === 'number' && Number.isFinite(track[field]) && track[field] >= 0)));
}
