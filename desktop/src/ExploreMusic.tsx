import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, AudioLines, ChevronDown, ChevronUp, Copy, Disc3, Download, Heart, ListChecks, ListEnd, ListMusic, ListPlus, ListStart, LoaderCircle, MoreHorizontal, Play, RefreshCw, Search, Trash2, Trophy, X } from 'lucide-react';
import {ContextMenu, type ContextMenuItem} from './ContextMenu';
import { formatTime } from './lib/music';
import {matchesText} from './lib/textSearch';
import { resolveTrackById } from './services/musicApi';
import { CATEGORY_ALL, getCategoryPlaylists, getPlaylist, getPlaylistCategories, getRanks, getRankTracks, resolveDiscoveryTracks, type PlaylistCategory, type PlaylistCategoryGroup, type PlaylistInfo, type PlaylistPage, type RankInfo } from './services/discovery';
import type { Track } from './types';
import './explore-music.css';

export interface ExploreMusicProps {
  baseUrl?: string;
  onPlay: (tracks: Track[], startIndex?: number) => void;
  onQueue: (track: Track) => void;
  onPlayNext?: (track: Track) => void;
  onFavorite: (track: Track) => void;
  onAddFavorites?: (tracks: Track[]) => void;
  onDownload?: (track: Track) => void | Promise<void>;
  onAddToPlaylist?: (tracks: Track[]) => void;
  favoritePlaylistIds?: Set<string>;
  onTogglePlaylistFavorite?: (playlist: PlaylistInfo) => void;
  playlistToOpen?: PlaylistInfo | null;
  onPlaylistOpened?: () => void;
  favoriteKeys: Set<string>;
  currentKey?: string;
}

type Resource<T> = { key: string | null; data?: T; error?: string; loading: boolean };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '暂时无法加载，请检查网络后重试。';
}

/** Keyed results hide previous content immediately, and disposed requests cannot overwrite a new selection. */
function useResource<T>(key: string | null, load: () => Promise<T>) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<Resource<T>>({ key: null, loading: false });
  useEffect(() => {
    if (key === null) return;
    let disposed = false;
    setState({ key, loading: true });
    void load().then(
      data => { if (!disposed) setState({ key, data, loading: false }); },
      error => { if (!disposed) setState({ key, error: errorMessage(error), loading: false }); },
    );
    return () => { disposed = true; };
  }, [key, load, attempt]);
  const visible: Resource<T> = key === null ? { key, loading: false } : state.key === key ? state : { key, loading: true };
  return { ...visible, retry: () => setAttempt(value => value + 1) };
}

function formatListen(value?: number): string {
  if (!value) return '';
  if (value >= 100000000) return `${(value / 100000000).toFixed(1)}亿`;
  if (value >= 10000) return `${(value / 10000).toFixed(1)}万`;
  return String(value);
}

function Artwork({ src, refreshKey, className = '' }: { src?: string; refreshKey?: Track; className?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src, refreshKey]);
  return <div className={`discovery-artwork ${className}`} aria-hidden="true">
    {src && !failed ? <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} /> : <Disc3 />}
  </div>;
}

function Status({ loading, error, retry, children, compact = false }: { loading?: boolean; error?: string; retry?: () => void; children?: ReactNode; compact?: boolean }) {
  return <div className={`discovery-status ${compact ? 'is-compact' : ''}`} role={error ? 'alert' : 'status'}>
    {loading ? <><LoaderCircle size={22} className="spin" /><span>加载中…</span></> : error ? <>
      <p>{error}</p>
      <button type="button" className="secondary-button" onClick={retry}><RefreshCw size={14} />重新加载</button>
    </> : <><ListMusic size={26} /><p>{children || '暂无内容'}</p></>}
  </div>;
}

function Capsule({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" className={`discovery-capsule ${active ? 'is-active' : ''}`} aria-pressed={active} onClick={onClick}>{children}</button>;
}

type TrackAction = 'queue' | 'next' | 'favorite' | 'download' | 'playlist';
const actionLabels: Record<TrackAction, string> = { queue: '加入队列', next: '下一曲播放', favorite: '喜欢', download: '下载', playlist: '添加到歌单' };

export function DiscoveryTrackList({ tracks: allTracks, searchable = false, onRemoveTracks, removeLabel = '移出歌单', showRemoveButton = false, listLabel = '歌曲列表', ...props }: ExploreMusicProps & {
  tracks: Track[];
  searchable?: boolean;
  onRemoveTracks?: (tracks: Track[]) => void | Promise<void>;
  removeLabel?: string;
  showRemoveButton?: boolean;
  listLabel?: string;
}) {
  const [pendingKey, setPendingKey] = useState('');
  const [progress, setProgress] = useState('');
  const [notice, setNotice] = useState('');
  const [batchMode, setBatchMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const tracks = useMemo(() => searchable && query.trim() ? allTracks.filter(track => matchesText(query, [track.title, track.artist, track.album])) : allTracks, [allTracks, query, searchable]);
  const [menu, setMenu] = useState<{track: Track; index: number; x: number; y: number}>();
  const [actionError, setActionError] = useState<{ message: string; retry: () => void }>();
  const actionGeneration = useRef(0);
  const busy = useRef(false);
  const latestProps = useRef(props);
  latestProps.current = props;
  useEffect(() => () => { actionGeneration.current += 1; }, []);
  const selectedTracks = tracks.filter(track => selectedKeys.has(track.key));
  const selectTrack = (track: Track) => setSelectedKeys(previous => {
    const next = new Set(previous);
    if (next.has(track.key)) next.delete(track.key); else next.add(track.key);
    return next;
  });
  const perform = async (track: Track, action: TrackAction) => {
    if (busy.current) return;
    if (action === 'favorite' && props.favoriteKeys.has(track.key)) { props.onFavorite(track); return; }
    busy.current = true;
    const generation = actionGeneration.current;
    setPendingKey(track.key);
    setProgress('正在获取歌曲信息…');
    setNotice('');
    setActionError(undefined);
    try {
      const resolved = await resolveTrackById(track, props.baseUrl);
      if (generation !== actionGeneration.current) return;
      if (action === 'queue') props.onQueue(resolved);
      else if (action === 'next') props.onPlayNext?.(resolved);
      else if (action === 'favorite') props.onFavorite(resolved);
      else if (action === 'download') await props.onDownload?.(resolved);
      else props.onAddToPlaylist?.([resolved]);
    } catch (error) {
      if (generation === actionGeneration.current) setActionError({ message: errorMessage(error), retry: () => { void perform(track, action); } });
    } finally {
      busy.current = false;
      if (generation === actionGeneration.current) setPendingKey('');
    }
  };
  const performBatch = async (action: Exclude<TrackAction, 'next'>, selection = selectedTracks) => {
    if (busy.current || !selection.length) return;
    const candidates = action === 'favorite' ? selection.filter(track => !latestProps.current.favoriteKeys.has(track.key)) : action === 'download' ? selection.filter(track => track.source === 'online') : selection;
    if (!candidates.length) { setNotice(action === 'favorite' ? '所选歌曲已在我喜欢中' : '所选歌曲已经是本地音乐'); return; }
    busy.current = true;
    const generation = actionGeneration.current;
    const isMounted = () => generation === actionGeneration.current;
    // Changing pages dismisses a pending picker, but already requested persistent
    // actions (download, queue and favorite) must finish outside this view.
    const shouldContinue = () => action !== 'playlist' || isMounted();
    setPendingKey('batch');
    setProgress(`正在获取歌曲信息 0 / ${candidates.length}`);
    setActionError(undefined);
    setNotice('');
    try {
      const result = await resolveDiscoveryTracks(candidates, props.baseUrl,
        (completed, total) => {if (isMounted()) setProgress(`正在获取歌曲信息 ${completed} / ${total}`);},
        shouldContinue,
      );
      if (!shouldContinue()) return;
      const failuresByKey = new Map(result.failed.map(item => [item.track.key, item]));
      let succeeded = 0;
      if (action === 'playlist') {
        if (result.tracks.length) { props.onAddToPlaylist?.(result.tracks); succeeded = result.tracks.length; }
      } else if (action === 'favorite' && latestProps.current.onAddFavorites) {
        try {
          if (result.tracks.length) latestProps.current.onAddFavorites(result.tracks);
          succeeded = result.tracks.length;
        } catch (error) {
          for (const track of result.tracks) failuresByKey.set(track.key, {track, error: errorMessage(error)});
        }
      } else for (const track of result.tracks) {
        if (action === 'download' && isMounted()) setProgress(`正在加入下载队列 ${succeeded + failuresByKey.size - result.failed.length} / ${result.tracks.length}`);
        try {
          if (action === 'queue') props.onQueue(track);
          else if (action === 'favorite') {
            // Compatibility for callers without a bulk add callback: do not
            // toggle off a favorite added from the player while lookup waited.
            if (!latestProps.current.favoriteKeys.has(track.key)) latestProps.current.onFavorite(track);
          }
          else await props.onDownload?.(track);
          succeeded += 1;
        } catch (error) { failuresByKey.set(track.key, { track, error: errorMessage(error) }); }
      }
      if (generation !== actionGeneration.current) return;
      if (succeeded) setNotice(action === 'playlist' ? `已选好 ${succeeded} 首歌曲，请选择目标歌单` : `${succeeded} 首歌曲已${action === 'favorite' ? '加入我喜欢' : action === 'download' ? '加入下载队列' : actionLabels[action]}`);
      const failures = candidates.flatMap(track => failuresByKey.has(track.key) ? [failuresByKey.get(track.key)!] : []);
      if (failures.length) {
        setSelectedKeys(new Set(failures.map(item => item.track.key)));
        setActionError({ message: `${failures.length} 首歌曲未完成：${failures[0].error}`, retry: () => { void performBatch(action, failures.map(item => item.track)); } });
      }
    } catch (error) {
      if (generation === actionGeneration.current) setActionError({ message: errorMessage(error), retry: () => { void performBatch(action, candidates); } });
    } finally {
      busy.current = false;
      if (generation === actionGeneration.current) setPendingKey('');
    }
  };
  const removeTracks = async (selection: Track[]) => {
    if (!onRemoveTracks || busy.current || !selection.length) return;
    busy.current = true;
    const generation = actionGeneration.current;
    setPendingKey('remove'); setProgress('正在更新歌曲列表…'); setActionError(undefined);
    try {
      await onRemoveTracks(selection);
      if (generation === actionGeneration.current) {
        setSelectedKeys(new Set());
        setNotice(`已${removeLabel} ${selection.length} 首歌曲`);
      }
    } catch (error) {
      if (generation === actionGeneration.current) setActionError({message: errorMessage(error), retry: () => {void removeTracks(selection);}});
    } finally {
      busy.current = false;
      if (generation === actionGeneration.current) setPendingKey('');
    }
  };
  const copyName = async (track: Track) => {
    try {
      if (!window.desktop?.copyText) throw new Error('请在 Windows 客户端中复制歌名。');
      await window.desktop.copyText(`${track.title} - ${track.artist}`);
      setNotice('已复制歌名');
    } catch (error) {setActionError({message: errorMessage(error), retry: () => {void copyName(track);}});}
  };
  const menuItems: ContextMenuItem[] = menu ? [
    {id: 'play', label: '立即播放', icon: <Play size={16}/>, onSelect: () => props.onPlay(tracks, menu.index)},
    ...(props.onPlayNext ? [{id: 'next', label: '下一曲播放', icon: <ListStart size={16}/>, onSelect: () => {void perform(menu.track, 'next');}}] : []),
    {id: 'queue', label: '加入播放队列', icon: <ListEnd size={16}/>, onSelect: () => {void perform(menu.track, 'queue');}},
    {id: 'favorite', label: props.favoriteKeys.has(menu.track.key) ? '取消收藏' : '收藏到我喜欢', icon: <Heart size={16}/>, onSelect: () => {void perform(menu.track, 'favorite');}},
    ...(props.onAddToPlaylist ? [{id: 'playlist', label: '添加到歌单…', icon: <ListPlus size={16}/>, onSelect: () => {void perform(menu.track, 'playlist');}}] : []),
    ...(props.onDownload && menu.track.source === 'online' ? [{id: 'download', label: '下载', icon: <Download size={16}/>, onSelect: () => {void perform(menu.track, 'download');}}] : []),
    {id: 'copy', label: '复制歌名', icon: <Copy size={16}/>, onSelect: () => {void copyName(menu.track);}},
    {id: 'batch', label: '批量操作', icon: <ListChecks size={16}/>, onSelect: () => {setBatchMode(true); setSelectedKeys(new Set([menu.track.key]));}},
    ...(onRemoveTracks ? [{id: 'remove', label: removeLabel, icon: <Trash2 size={16}/>, danger: true, onSelect: () => {void removeTracks([menu.track]);}}] : []),
  ].map(item => ({...item, disabled: !!pendingKey})) : [];
  const actionCount = 3 + (props.onAddToPlaylist ? 1 : 0) + (props.onDownload && tracks.some(track => track.source === 'online') ? 1 : 0) + (showRemoveButton ? 1 : 0);
  const updateQuery = (value: string) => {setQuery(value); setSelectedKeys(new Set()); setMenu(undefined); setNotice(''); setActionError(undefined);};
  if (!allTracks.length) return <Status>这里还没有歌曲</Status>;
  return <>
    {searchable && <div className="discovery-filter-bar">
      <div className="discovery-list-search"><Search size={15} aria-hidden="true"/>
        <input type="search" aria-label="搜索歌单歌曲" placeholder="搜索歌名、歌手或专辑" maxLength={200} value={query} disabled={!!pendingKey} onChange={event => updateQuery(event.target.value)}/>
        {query && <button type="button" className="icon-button" aria-label="清空歌单歌曲搜索" disabled={!!pendingKey} onClick={() => updateQuery('')}><X size={14}/></button>}
      </div>
      {query.trim() && <button type="button" className="text-button" disabled={!tracks.length || !!pendingKey} onClick={() => props.onPlay(tracks, 0)}><Play size={14}/>播放筛选结果</button>}
    </div>}
    <div className="discovery-list-toolbar">
      {batchMode ? <><label className="discovery-select-all"><input type="checkbox" checked={tracks.length > 0 && selectedTracks.length === tracks.length} disabled={!tracks.length || !!pendingKey} onChange={() => setSelectedKeys(selectedTracks.length === tracks.length ? new Set() : new Set(tracks.map(track => track.key)))} />全选</label><span>已选 {selectedTracks.length} 首</span>
        <button type="button" className="secondary-button" disabled={!selectedTracks.length || !!pendingKey} onClick={() => props.onPlay(selectedTracks, 0)}><Play size={13} />播放</button>
        <button type="button" className="secondary-button" disabled={!selectedTracks.length || !!pendingKey} onClick={() => void performBatch('queue')}><ListEnd size={14} />加入队列</button>
        <button type="button" className="secondary-button" disabled={!selectedTracks.length || !!pendingKey} onClick={() => void performBatch('favorite')}><Heart size={13} />喜欢</button>
        {props.onDownload && <button type="button" className="secondary-button" disabled={!selectedTracks.some(track => track.source === 'online') || !!pendingKey} onClick={() => void performBatch('download')}><Download size={13} />下载</button>}
        {props.onAddToPlaylist && <button type="button" className="secondary-button" disabled={!selectedTracks.length || !!pendingKey} onClick={() => void performBatch('playlist')}><ListPlus size={14} />添加到歌单</button>}
        {onRemoveTracks && <button type="button" className="secondary-button" disabled={!selectedTracks.length || !!pendingKey} onClick={() => void removeTracks(selectedTracks)}>{removeLabel}</button>}
      </> : <span>{tracks.length}{query.trim() ? ` / ${allTracks.length}` : ''} 首歌曲</span>}
      <button type="button" className="discovery-batch-toggle" disabled={!!pendingKey} aria-pressed={batchMode} onClick={() => { setBatchMode(value => !value); setSelectedKeys(new Set()); }}><ListChecks size={15} />{batchMode ? '完成' : '批量操作'}</button>
    </div>
    {pendingKey && <div className="discovery-action-status" role="status"><LoaderCircle size={14} className="spin" />{progress}</div>}
    {notice && <div className="discovery-action-status" role="status">{notice}</div>}
    {actionError && <div className="discovery-action-status" role="alert"><span>{actionError.message}</span><button type="button" className="text-button" onClick={actionError.retry}><RefreshCw size={13} />重试</button></div>}
    {!tracks.length ? <Status>没有找到匹配的歌曲，换个关键词试试。</Status> : <div className="discovery-track-list" style={{'--track-actions-width': `${actionCount * 31}px`} as React.CSSProperties} role="table" aria-label={listLabel}>
    <div className="discovery-track-row discovery-track-head" role="row">
      <span role="columnheader">#</span><span role="columnheader">歌曲</span><span role="columnheader" className="discovery-album">专辑</span><span role="columnheader">时长</span><span role="columnheader" className="align-right">操作</span>
    </div>
    {tracks.map((track, index) => {
      const favorite = props.favoriteKeys.has(track.key);
      const current = track.key === props.currentKey;
      return <div key={track.key} role="row" tabIndex={0} className={`discovery-track-row ${current ? 'is-current' : ''}`} onContextMenu={event => {
        event.preventDefault(); event.currentTarget.focus({preventScroll: true});
        const rect = event.currentTarget.getBoundingClientRect();
        setMenu({track, index, x: event.clientX || rect.left + 40, y: event.clientY || rect.top + rect.height / 2});
      }} onDoubleClick={event => {
        if ((event.target as HTMLElement).closest('button,input') || pendingKey) return;
        if (batchMode) selectTrack(track); else props.onPlay(tracks, index);
      }}>
        <div role="cell">{batchMode ? <input type="checkbox" className="discovery-track-select" aria-label={`选择 ${track.title}`} checked={selectedKeys.has(track.key)} disabled={!!pendingKey} onChange={() => selectTrack(track)} /> : <button type="button" className="discovery-track-number" aria-label={`播放 ${track.title}`} onClick={() => props.onPlay(tracks, index)}>
          {current ? <AudioLines size={18} /> : <><span>{String(index + 1).padStart(2, '0')}</span><Play size={15} fill="currentColor" /></>}
        </button>}</div>
        <div className="discovery-track-info" role="cell">
          <Artwork src={track.coverUrl} refreshKey={track} />
          <div><button type="button" className="discovery-track-title" title={track.title} disabled={batchMode && !!pendingKey} onClick={() => batchMode ? selectTrack(track) : props.onPlay(tracks, index)}>{track.title}</button><span>{track.source === 'local' && <small className="track-local-badge">本地</small>}{track.artist}</span></div>
        </div>
        <span className="discovery-album" role="cell" title={track.album}>{track.album || '未知专辑'}</span>
        <span className="discovery-duration" role="cell">{track.duration ? formatTime(track.duration) : '—'}</span>
        <div className="discovery-track-actions" role="cell">
          <button type="button" className={`icon-button ${favorite ? 'active' : ''}`} disabled={!!pendingKey} aria-label={`${favorite ? '取消喜欢' : '喜欢'} ${track.title}`} title={favorite ? '取消喜欢' : '喜欢'} onClick={() => void perform(track, 'favorite')}><Heart size={16} fill={favorite ? 'currentColor' : 'none'} /></button>
          <button type="button" className="icon-button" disabled={!!pendingKey} aria-label={`加入队列 ${track.title}`} title="加入队列" onClick={() => void perform(track, 'queue')}><ListEnd size={16} /></button>
          {props.onAddToPlaylist && <button type="button" className="icon-button" disabled={!!pendingKey} aria-label={`添加到歌单 ${track.title}`} title="添加到歌单" onClick={() => void perform(track, 'playlist')}><ListPlus size={16} /></button>}
          {props.onDownload && track.source === 'online' && <button type="button" className="icon-button" disabled={!!pendingKey} aria-label={`下载 ${track.title}`} title="下载" onClick={() => void perform(track, 'download')}><Download size={16} /></button>}
          {showRemoveButton && onRemoveTracks && <button type="button" className="icon-button" disabled={!!pendingKey} aria-label={`${removeLabel} ${track.title}`} title={removeLabel} onClick={() => void removeTracks([track])}><Trash2 size={15}/></button>}
          <button type="button" className="icon-button" aria-label={`更多操作 ${track.title}`} title="更多操作" onClick={event => {const rect = event.currentTarget.getBoundingClientRect(); setMenu({track, index, x: rect.left, y: rect.bottom});}}><MoreHorizontal size={17}/></button>
        </div>
      </div>;
    })}
  </div>}
  {menu && <ContextMenu ariaLabel="歌曲操作" items={menuItems} position={menu} onClose={() => setMenu(undefined)}/>}
  </>;
}

export function PlaylistGrid({playlists, onSelect}: {playlists: PlaylistInfo[]; onSelect: (playlist: PlaylistInfo) => void}) {
  return <div className="discovery-playlist-grid">
    {playlists.map(item => <button key={item.id} type="button" className="discovery-playlist-card" onClick={() => onSelect(item)} aria-label={`打开歌单 ${item.title}`}>
      <div className="discovery-playlist-cover"><Artwork src={item.coverUrl} /><span className="discovery-card-play"><ListMusic size={19} /></span>{!!item.listenNum && <span className="discovery-listen"><Play size={10} fill="currentColor" />{formatListen(item.listenNum)}</span>}</div>
      <h3 title={item.title}>{item.title}</h3>
      <p title={item.creatorName ?? item.introduction}>{item.creatorName || item.introduction || '精选歌单'}</p>
      {item.songCount !== undefined && <p>{item.songCount} 首歌曲</p>}
    </button>)}
  </div>;
}

function PlaylistCollection({ category, onSelect, preview = false, onMore }: { category: PlaylistCategory; onSelect: (playlist: PlaylistInfo) => void; preview?: boolean; onMore?: () => void }) {
  const [result, setResult] = useState<PlaylistPage>({ list: [], hasMore: false });
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const requestId = useRef(0);
  const busy = useRef(false);
  const load = useCallback(async (nextPage: number) => {
    if (busy.current) return;
    busy.current = true;
    const id = ++requestId.current;
    setLoading(true);
    setError('');
    try {
      const response = await getCategoryPlaylists(category.id, nextPage);
      if (id !== requestId.current) return;
      setResult(previous => {
        if (nextPage === 1) return response;
        const seen = new Set(previous.list.map(item => item.id));
        return { ...response, list: [...previous.list, ...response.list.filter(item => !seen.has(item.id))] };
      });
      setPage(nextPage);
    } catch (cause) {
      if (id === requestId.current) setError(errorMessage(cause));
    } finally {
      if (id === requestId.current) { busy.current = false; setLoading(false); }
    }
  }, [category.id]);

  useEffect(() => {
    busy.current = false;
    void load(1);
    return () => { requestId.current += 1; busy.current = false; };
  }, [load]);

  return <section className="discovery-section" aria-label={preview ? '热门歌单' : `${category.name}歌单`}>
    <div className="discovery-section-heading"><h2>{category.id === CATEGORY_ALL.id ? '热门歌单' : `${category.name} · 歌单`}</h2>
      {preview ? <button type="button" className="discovery-more" onClick={onMore}>全部歌单<ArrowRight size={15} /></button> : <span>{result.total === undefined ? '' : `${result.total.toLocaleString()} 张歌单`}</span>}
    </div>
    {!result.list.length ? <Status loading={loading} error={error} retry={() => void load(1)}>没有找到相关歌单</Status> : <>
      <PlaylistGrid playlists={preview ? result.list.slice(0, 10) : result.list} onSelect={onSelect}/>
      {!preview && <div className="discovery-pagination">
        {error && <p role="alert">{error}</p>}
        {result.hasMore || error ? <button type="button" className="secondary-button" disabled={loading} onClick={() => void load(page + 1)}>{loading ? <LoaderCircle size={15} className="spin" /> : error ? <RefreshCw size={15} /> : <ChevronDown size={15} />}{loading ? '加载中…' : error ? '重试加载更多' : '加载更多歌单'}</button> : <span>已显示全部歌单</span>}
      </div>}
    </>}
  </section>;
}

function CategoryPicker({ groups, selected, onSelect }: { groups: PlaylistCategoryGroup[]; selected: PlaylistCategory; onSelect: (category: PlaylistCategory) => void }) {
  const [expanded, setExpanded] = useState(false);
  const flat = [CATEGORY_ALL, ...groups.flatMap(group => group.items)];
  const choose = (category: PlaylistCategory) => { onSelect(category); setExpanded(false); };
  return <div className="discovery-categories">
    <div className="discovery-capsule-bar"><div className="discovery-capsule-scroll" aria-label="歌单分类">
      {flat.map(category => <Capsule key={category.id} active={category.id === selected.id} onClick={() => choose(category)}>{category.name}</Capsule>)}
    </div><button type="button" className="discovery-expand" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : '全部分类'}{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button></div>
    {expanded && <div className="discovery-category-panel">
      {groups.map(group => <div className="discovery-category-group" key={group.name}><h3>{group.name}</h3><div>{group.items.map(category => <Capsule key={category.id} active={category.id === selected.id} onClick={() => choose(category)}>{category.name}</Capsule>)}</div></div>)}
    </div>}
  </div>;
}

export function PlaylistView({ playlist, onBack, backLabel, ...props }: ExploreMusicProps & { playlist: PlaylistInfo; onBack: () => void; backLabel?: string }) {
  const load = useCallback(() => getPlaylist(playlist.id, props.baseUrl), [playlist.id, props.baseUrl]);
  const result = useResource(`${props.baseUrl ?? ''}:playlist:${playlist.id}`, load);
  const tracks = result.data?.tracks ?? [];
  const title = result.data?.title && result.data.title !== '歌单' ? result.data.title : playlist.title;
  const favorite = props.favoritePlaylistIds?.has(playlist.id) ?? false;
  const favoriteSummary: PlaylistInfo = {
    ...playlist, title,
    coverUrl: result.data?.coverUrl ?? playlist.coverUrl,
    songCount: result.data?.songCount ?? playlist.songCount ?? (result.data ? tracks.length : undefined),
    creatorName: result.data?.creatorName ?? playlist.creatorName,
    introduction: result.data?.introduction ?? playlist.introduction,
  };
  return <section className="discovery-playlist-detail">
    <button type="button" className="discovery-back" onClick={onBack}><ArrowLeft size={16} />{backLabel ?? `返回${playlist.title ? '歌单' : '探索'}`}</button>
    <div className="discovery-detail-header">
      <Artwork src={result.data?.coverUrl ?? playlist.coverUrl} />
      <div className="discovery-detail-copy"><span className="discovery-eyebrow">歌单</span><h2>{title}</h2>
        <p>{[result.data?.creatorName ?? playlist.creatorName, tracks.length ? `${tracks.length} 首歌曲` : '', playlist.listenNum ? `${formatListen(playlist.listenNum)} 次播放` : ''].filter(Boolean).join(' · ')}</p>
        {(result.data?.introduction ?? playlist.introduction) && <p className="discovery-introduction">{result.data?.introduction ?? playlist.introduction}</p>}
        <div className="discovery-detail-actions"><button type="button" className="primary-button" disabled={!tracks.length || result.loading} onClick={() => props.onPlay(tracks, 0)}><Play size={15} fill="currentColor" />播放全部</button>
          {props.onTogglePlaylistFavorite && <button type="button" className="secondary-button" aria-pressed={favorite} onClick={() => props.onTogglePlaylistFavorite?.(favoriteSummary)}><Heart size={15} fill={favorite ? 'currentColor' : 'none'} />{favorite ? '取消收藏歌单' : '收藏歌单'}</button>}
          {props.onAddToPlaylist && <button type="button" className="secondary-button" disabled={!tracks.length || result.loading} onClick={() => props.onAddToPlaylist?.(tracks)}><ListPlus size={15} />添加到自建歌单</button>}
        </div>
      </div>
    </div>
    {result.loading || result.error ? <Status loading={result.loading} error={result.error} retry={result.retry} /> : <DiscoveryTrackList key={playlist.id} {...props} tracks={tracks} searchable />}
  </section>;
}

export default function ExploreMusic(props: ExploreMusicProps) {
  const [tab, setTab] = useState<'recommended' | 'ranks' | 'playlists'>('recommended');
  const [rankId, setRankId] = useState<number>();
  const [category, setCategory] = useState<PlaylistCategory>(CATEGORY_ALL);
  const [selectedPlaylist, setSelectedPlaylist] = useState<PlaylistInfo>();
  const [ranksExpanded, setRanksExpanded] = useState(false);
  const section = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!props.playlistToOpen) return;
    setSelectedPlaylist(props.playlistToOpen);
    setTab('playlists');
    props.onPlaylistOpened?.();
  }, [props.playlistToOpen, props.onPlaylistOpened]);
  useEffect(() => {
    if (selectedPlaylist || tab !== 'recommended') section.current?.scrollIntoView?.({ block: 'start' });
  }, [selectedPlaylist?.id, tab]);
  const loadRanks = useCallback(() => getRanks(props.baseUrl), [props.baseUrl]);
  const ranks = useResource(`${props.baseUrl ?? ''}:ranks`, loadRanks);
  const categories = useResource(tab === 'playlists' && !selectedPlaylist ? 'categories' : null, getPlaylistCategories);
  const selectedRank = ranks.data?.find(rank => rank.id === rankId) ?? ranks.data?.[0];
  const loadRankTracks = useCallback(() => getRankTracks(selectedRank!.id, props.baseUrl), [selectedRank?.id, props.baseUrl]);
  const rankTracks = useResource(tab === 'ranks' && selectedRank ? `${props.baseUrl ?? ''}:rank:${selectedRank.id}` : null, loadRankTracks);
  const switchTab = (next: typeof tab) => { setTab(next); setSelectedPlaylist(undefined); };
  const openRank = (rank: RankInfo) => { setRankId(rank.id); switchTab('ranks'); setRanksExpanded(false); };

  return <div className="discovery" ref={section}>
    <nav className="discovery-tabs" aria-label="探索音乐分类">
      <Capsule active={tab === 'recommended'} onClick={() => switchTab('recommended')}>推荐</Capsule>
      <Capsule active={tab === 'ranks'} onClick={() => switchTab('ranks')}>排行榜</Capsule>
      <Capsule active={tab === 'playlists'} onClick={() => switchTab('playlists')}>歌单</Capsule>
    </nav>
    {selectedPlaylist ? <PlaylistView key={`${props.baseUrl ?? ''}:${selectedPlaylist.id}`} {...props} playlist={selectedPlaylist} onBack={() => setSelectedPlaylist(undefined)} /> : <>
      {tab === 'recommended' && <>
        <section className="discovery-section" aria-label="官方榜单">
          <div className="discovery-section-heading"><h2>官方榜单</h2><button type="button" className="discovery-more" onClick={() => switchTab('ranks')}>全部榜单<ArrowRight size={15} /></button></div>
          {ranks.loading || ranks.error || !ranks.data?.length ? <Status loading={ranks.loading} error={ranks.error} retry={ranks.retry}>暂无榜单</Status> : <div className="discovery-rank-grid">
            {ranks.data.slice(0, 6).map(rank => <button type="button" className="discovery-rank-card" key={rank.id} onClick={() => openRank(rank)} aria-label={`打开榜单 ${rank.title}`}>
              <Artwork src={rank.coverUrl} /><div><h3>{rank.title}</h3>{rank.top3.length ? <ol>{rank.top3.map((song, index) => <li key={index} title={`${song.title} · ${song.artist}`}><span>{index + 1}</span>{song.title}{song.artist && <small> · {song.artist}</small>}</li>)}</ol> : <p>{rank.period ? `${rank.period} 更新` : '查看榜单歌曲'}</p>}</div><ArrowRight size={16} className="discovery-rank-arrow" />
            </button>)}
          </div>}
        </section>
        <PlaylistCollection key="recommended-playlists" category={CATEGORY_ALL} preview onSelect={setSelectedPlaylist} onMore={() => switchTab('playlists')} />
      </>}
      {tab === 'ranks' && <section className="discovery-section" aria-label="排行榜">
        {ranks.loading || ranks.error || !ranks.data?.length ? <Status loading={ranks.loading} error={ranks.error} retry={ranks.retry}>暂无榜单</Status> : <>
          <div className={`discovery-capsule-bar ${ranksExpanded ? 'is-expanded' : ''}`}><div className="discovery-capsule-scroll" aria-label="榜单分类">{ranks.data.map(rank => <Capsule key={rank.id} active={selectedRank?.id === rank.id} onClick={() => openRank(rank)}>{rank.title}</Capsule>)}</div><button type="button" className="discovery-expand" aria-expanded={ranksExpanded} onClick={() => setRanksExpanded(value => !value)}>{ranksExpanded ? '收起' : '全部榜单'}{ranksExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button></div>
          {selectedRank && <div className="discovery-detail-header discovery-rank-header"><Artwork src={selectedRank.coverUrl} /><div className="discovery-detail-copy"><span className="discovery-eyebrow"><Trophy size={13} />{selectedRank.group || '官方榜单'}</span><h2>{selectedRank.title}</h2><p>{[selectedRank.period ? `${selectedRank.period} 更新` : '', selectedRank.listenNum ? `${formatListen(selectedRank.listenNum)} 次播放` : ''].filter(Boolean).join(' · ')}</p><button type="button" className="primary-button" disabled={!rankTracks.data?.length || rankTracks.loading} onClick={() => props.onPlay(rankTracks.data ?? [], 0)}><Play size={15} fill="currentColor" />播放全部</button></div></div>}
          {rankTracks.loading || rankTracks.error ? <Status loading={rankTracks.loading} error={rankTracks.error} retry={rankTracks.retry} /> : <DiscoveryTrackList key={selectedRank?.id} {...props} tracks={rankTracks.data ?? []} />}
        </>}
      </section>}
      {tab === 'playlists' && <>
        {categories.error ? <Status compact error={categories.error} retry={categories.retry} /> : categories.loading ? <Status compact loading /> : <CategoryPicker groups={categories.data ?? []} selected={category} onSelect={setCategory} />}
        <PlaylistCollection key={`category:${category.id}`} category={category} onSelect={setSelectedPlaylist} />
      </>}
    </>}
  </div>;
}
