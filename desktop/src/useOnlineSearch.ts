import {useEffect, useRef, useState} from 'react';
import {mergeTracks} from './lib/music';
import {searchSongsPage} from './services/musicApi';
import {searchPlaylistsPage, type PlaylistInfo} from './services/discovery';
import type {Track} from './types';

export type SearchType = 'song' | 'playlist';
interface SearchPage {
  tracks: Track[];
  playlists: PlaylistInfo[];
  page: number;
  hasMore: boolean;
  loaded: boolean;
  error: string;
}
interface SearchState {
  query: string;
  type: SearchType;
  loading: boolean;
  pages: Record<SearchType, SearchPage>;
}
const emptyPage = (): SearchPage => ({tracks: [], playlists: [], page: 0, hasMore: false, loaded: false, error: ''});
const emptyState = (type: SearchType = 'song'): SearchState => ({query: '', type, loading: false, pages: {song: emptyPage(), playlist: emptyPage()}});

/** Cache each category for this query, and never let an earlier request replace a newer selection. */
export function useOnlineSearch(baseUrl: string) {
  const [state, setState] = useState(emptyState);
  const current = useRef(state);
  const generation = useRef(0);
  const service = useRef(baseUrl);
  const commit = (next: SearchState) => { current.current = next; setState(next); };
  const reset = () => { generation.current += 1; commit(emptyState(current.current.type)); };
  useEffect(() => {
    if (service.current !== baseUrl) { service.current = baseUrl; reset(); }
    return () => { generation.current += 1; };
  }, [baseUrl]);

  const load = async (type: SearchType, query: string, page: number) => {
    const request = ++generation.current;
    const before = current.current;
    commit({...before, loading: true, pages: {...before.pages, [type]: {...before.pages[type], error: ''}}});
    try {
      const response = type === 'song' ? await searchSongsPage(query, baseUrl, page) : await searchPlaylistsPage(query, baseUrl, page);
      if (request !== generation.current) return;
      const latest = current.current;
      const previous = latest.pages[type];
      const next: SearchPage = {...previous, page, loaded: true, error: '', hasMore: response.hasMore};
      if ('tracks' in response) next.tracks = page === 1 ? response.tracks : mergeTracks(previous.tracks, response.tracks);
      else {
        const seen = new Set(page === 1 ? [] : previous.playlists.map(item => item.id));
        next.playlists = [...(page === 1 ? [] : previous.playlists), ...response.list.filter(item => {
          if (seen.has(item.id)) return false;
          seen.add(item.id);
          return true;
        })];
      }
      commit({...latest, loading: false, pages: {...latest.pages, [type]: next}});
    } catch (cause) {
      if (request !== generation.current) return;
      const latest = current.current;
      commit({...latest, loading: false, pages: {...latest.pages, [type]: {...latest.pages[type],
        error: cause instanceof Error ? cause.message : '搜索失败，请稍后重试。'}}});
    }
  };
  const search = (keyword: string) => {
    const query = keyword.trim();
    if (!query) return;
    const type = current.current.type;
    commit({...emptyState(type), query});
    return load(type, query, 1);
  };
  const switchType = (type: SearchType) => {
    const latest = current.current;
    if (type === latest.type) return;
    generation.current += 1;
    commit({...latest, type, loading: false});
    if (latest.query && !latest.pages[type].loaded) return load(type, latest.query, 1);
  };
  const nextPage = () => {
    const latest = current.current;
    if (!latest.query || latest.loading) return;
    return load(latest.type, latest.query, latest.pages[latest.type].page + 1);
  };
  return {...state.pages[state.type], query: state.query, type: state.type, loading: state.loading,
    search, switchType, loadMore: nextPage, retry: nextPage, reset};
}
