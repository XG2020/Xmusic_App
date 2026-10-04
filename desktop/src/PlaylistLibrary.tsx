import {useEffect, useId, useRef, useState, type FormEvent, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {ArrowLeft, Check, Heart, Import, ListMusic, LoaderCircle, Pencil, Play, Plus, Search, Trash2, X} from 'lucide-react';
import {DiscoveryTrackList} from './ExploreMusic';
import {MAX_PLAYLIST_TRACKS, type PlaylistController, type LocalPlaylist} from './playlists';
import {isTracks} from './state';
import {matchesText} from './lib/textSearch';
import {getPlaylistForImport, resolvePlaylistId, type PlaylistDetail, type PlaylistInfo} from './services/discovery';
import type {Track} from './types';
import './playlists.css';

export interface PlaylistLibraryProps {
  library: PlaylistController;
  baseUrl?: string;
  onPlay(tracks: Track[], startIndex?: number): void;
  onQueue(track: Track): void;
  onPlayNext?(track: Track): void;
  onFavorite(track: Track): void;
  onAddFavorites?(tracks: Track[]): void;
  onDownload?(track: Track): void;
  onAddToPlaylist(tracks: Track[]): void;
  onOpenOnlinePlaylist(playlist: PlaylistInfo): void;
  favoriteKeys: Set<string>;
  currentKey?: string;
}

function PlaylistArtwork({src}: {src?: string}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return <div className="playlist-artwork" aria-hidden="true">
    {src && !failed ? <img src={src} alt="" loading="lazy" onError={() => setFailed(true)}/> : <ListMusic size={45} strokeWidth={1.2}/>}
  </div>;
}

function DialogFrame({title, onClose, children}: {title: string; onClose(): void; children: ReactNode}) {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = dialog.current;
    (panel?.querySelector<HTMLElement>('[data-autofocus]') ?? panel)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); close.current(); return;}
      if (event.key !== 'Tab' || !panel) return;
      const controls = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex="0"]')];
      const first = controls[0], last = controls.at(-1);
      if (!first || !last) {event.preventDefault(); panel.focus(); return;}
      if (!panel.contains(document.activeElement) || (!event.shiftKey && document.activeElement === last)) {event.preventDefault(); first.focus();}
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {event.preventDefault(); last.focus();}
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      if (previous?.isConnected) previous.focus();
      else document.querySelector<HTMLElement>('.playlist-library button, .main-area button')?.focus();
    };
  }, []);
  return createPortal(<div className="playlist-dialog-backdrop" onPointerDown={event => {if (event.target === event.currentTarget) onClose();}}>
    <div ref={dialog} className="playlist-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" aria-label="关闭对话框" onClick={onClose}><X size={20}/></button></header>
      {children}
    </div>
  </div>, document.body);
}

function PlaylistNameDialog({playlist, onSave, onClose}: {playlist?: LocalPlaylist; onSave(name: string): void; onClose(): void}) {
  const [name, setName] = useState(playlist?.name ?? '');
  const [error, setError] = useState('');
  const inputId = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {onSave(name);} catch (cause) {setError(cause instanceof Error ? cause.message : '保存失败，请重试。');}
  };
  return <DialogFrame title={playlist ? '重命名歌单' : '新建歌单'} onClose={onClose}>
    <form onSubmit={submit}>
      <label className="playlist-field-label" htmlFor={inputId}>歌单名称</label>
      <input data-autofocus id={inputId} className="playlist-name-input" value={name} maxLength={80} placeholder="给歌单取个名字" onChange={event => {setName(event.target.value); setError('');}}/>
      {error && <p className="playlist-inline-error" role="alert">{error}</p>}
      <footer><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button">{playlist ? '保存' : '创建'}</button></footer>
    </form>
  </DialogFrame>;
}

export interface AddToPlaylistDialogProps {
  library: PlaylistController;
  tracks: Track[];
  onClose(): void;
  onAdded?(message: string, playlistId: string): void;
  title?: string;
  summary?: ReactNode;
  initialName?: string;
  initialPlaylistId?: string;
  onBack?(): void;
}

export function AddToPlaylistDialog({library, tracks, onClose, onAdded, title = '添加到歌单', summary, initialName, initialPlaylistId, onBack}: AddToPlaylistDialogProps) {
  const [mode, setMode] = useState<'existing' | 'new'>(initialPlaylistId ? 'existing' : initialName || !library.playlists.length ? 'new' : 'existing');
  const [selectedId, setSelectedId] = useState(initialPlaylistId ?? library.playlists[0]?.id ?? '');
  const [name, setName] = useState(initialName?.slice(0, 80) ?? '');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const inputId = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (success) {onClose(); return;}
    try {
      if (!tracks.length) throw new Error('请先选择要添加的歌曲。');
      if (!isTracks(tracks)) throw new Error('歌曲信息不完整，请重新选择。');
      let target = library.playlists.find(playlist => playlist.id === selectedId);
      if (mode === 'new') target = library.createPlaylist(name);
      if (!target) throw new Error('请选择一个歌单。');
      const result = library.addTracks(target.id, tracks);
      const skipped = tracks.length - result.added - result.duplicates;
      const message = result.added
        ? `已添加 ${result.added} 首到「${target.name}」${result.duplicates ? `，跳过 ${result.duplicates} 首重复歌曲` : ''}${result.limitReached ? `；歌单最多容纳 ${MAX_PLAYLIST_TRACKS} 首，另有 ${skipped} 首未添加` : ''}。`
        : result.limitReached ? `「${target.name}」已满，歌单最多容纳 ${MAX_PLAYLIST_TRACKS} 首。` : `所选歌曲已在「${target.name}」中，无需重复添加。`;
      setSuccess(message);
      setError('');
      onAdded?.(message, target.id);
    } catch (cause) {setError(cause instanceof Error ? cause.message : '添加失败，请重试。');}
  };
  return <DialogFrame title={title} onClose={onClose}>
    <form onSubmit={submit}>
      {summary ?? <p className="playlist-dialog-summary">已选择 {tracks.length} 首歌曲</p>}
      {success ? <div className="playlist-add-success" role="status"><Check size={24}/><p>{success}</p></div> : <>
        <p className="playlist-capacity-hint">每个自建歌单最多 {MAX_PLAYLIST_TRACKS} 首，重复歌曲会自动跳过。</p>
        <div className="playlist-dialog-tabs" aria-label="添加方式">
          <button type="button" className={`discovery-capsule ${mode === 'existing' ? 'is-active' : ''}`} aria-pressed={mode === 'existing'} onClick={() => {setMode('existing'); setError('');}}>已有歌单</button>
          <button type="button" className={`discovery-capsule ${mode === 'new' ? 'is-active' : ''}`} aria-pressed={mode === 'new'} onClick={() => {setMode('new'); setError('');}}>新建歌单</button>
        </div>
        {mode === 'existing' ? <div className="playlist-destination-list" role="group" aria-label="选择目标歌单">
          {library.playlists.length ? library.playlists.map((playlist, index) => <label key={playlist.id} className={`playlist-destination ${selectedId === playlist.id ? 'is-selected' : ''}`}>
            <input data-autofocus={index === 0 ? true : undefined} type="radio" name="playlist-destination" value={playlist.id} checked={selectedId === playlist.id} onChange={() => {setSelectedId(playlist.id); setError('');}}/>
            <PlaylistArtwork src={playlist.tracks.find(track => track.coverUrl)?.coverUrl}/><span><strong>{playlist.name}</strong><small>{playlist.tracks.length} / {MAX_PLAYLIST_TRACKS} 首{playlist.tracks.length >= MAX_PLAYLIST_TRACKS ? ' · 已满' : ''}</small></span>
          </label>) : <p className="playlist-dialog-empty">还没有自建歌单，先新建一个吧。</p>}
        </div> : <><label className="playlist-field-label" htmlFor={inputId}>歌单名称</label><input data-autofocus id={inputId} className="playlist-name-input" maxLength={80} value={name} placeholder="给歌单取个名字" onChange={event => {setName(event.target.value); setError('');}}/></>}
      </>}
      {error && <p className="playlist-inline-error" role="alert">{error}</p>}
      <footer>{!success && <>{onBack && <button type="button" className="secondary-button" onClick={onBack}>返回</button>}<button type="button" className="secondary-button" onClick={onClose}>取消</button></>}<button type="submit" className="primary-button">{success ? '完成' : mode === 'new' ? '创建并添加' : '添加'}</button></footer>
    </form>
  </DialogFrame>;
}

export function ImportPlaylistDialog({library, baseUrl, initialPlaylistId, onClose, onAdded}: {
  library: PlaylistController;
  baseUrl?: string;
  initialPlaylistId?: string;
  onClose(): void;
  onAdded?(message: string, playlistId: string): void;
}) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<PlaylistDetail>();
  const inputId = useId();
  const activeRequest = useRef(0);
  const pending = useRef(false);
  useEffect(() => () => {activeRequest.current += 1;}, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending.current) return;
    if (!input.trim()) {setError('请粘贴 QQ 音乐歌单分享链接或输入歌单 ID。'); return;}
    const request = ++activeRequest.current;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const id = await resolvePlaylistId(input);
      if (request !== activeRequest.current) return;
      if (!id) throw new Error('无法识别这个歌单，请粘贴 QQ 音乐歌单分享链接或输入歌单 ID。');
      const playlist = await getPlaylistForImport(id, baseUrl);
      if (request !== activeRequest.current) return;
      if (!playlist.tracks.length) throw new Error('歌单为空或没有可导入的歌曲，请确认歌单存在且已公开。');
      setDetail(playlist);
    } catch (cause) {
      if (request === activeRequest.current) setError(cause instanceof Error ? cause.message : '导入失败，请检查网络并确认歌单已公开。');
    } finally {
      if (request === activeRequest.current) {pending.current = false; setBusy(false);}
    }
  };
  if (detail) return <AddToPlaylistDialog library={library} tracks={detail.tracks} title="导入 QQ 音乐歌单"
    initialName={detail.title === '歌单' ? `歌单 ${detail.id}` : detail.title} initialPlaylistId={initialPlaylistId}
    onClose={onClose} onAdded={onAdded} onBack={() => setDetail(undefined)} summary={<>
      <div className="playlist-import-preview"><PlaylistArtwork src={detail.coverUrl}/><div><strong>{detail.title}</strong><span>{detail.tracks.length} 首歌曲{detail.creatorName ? ` · ${detail.creatorName}` : ''}</span></div></div>
      {detail.songCount !== undefined && detail.songCount > detail.tracks.length && <p className="playlist-import-count-note" role="status">源歌单约 {detail.songCount} 首，本次获取 {detail.tracks.length} 首，将导入已获取的歌曲。</p>}
      {detail.tracks.length > MAX_PLAYLIST_TRACKS && <p className="playlist-import-count-note">本次歌曲超过容量，最多添加前 {MAX_PLAYLIST_TRACKS} 首不重复歌曲；已有歌单按剩余容量添加。</p>}
    </>}/>;
  return <DialogFrame title="导入 QQ 音乐歌单" onClose={onClose}>
    <form onSubmit={submit} aria-busy={busy}>
      <p className="playlist-dialog-summary">粘贴 QQ 音乐的歌单分享链接、完整分享文本或歌单 ID，解析后可新建歌单或合并到已有歌单。</p>
      <label className="playlist-field-label" htmlFor={inputId}>分享链接或歌单 ID</label>
      <textarea data-autofocus id={inputId} className="playlist-name-input playlist-import-input" value={input} maxLength={4096} disabled={busy} rows={4}
        placeholder="https://y.qq.com/n/ryqq/playlist/1234567890" onChange={event => {setInput(event.target.value); setError('');}}/>
      {busy && <p className="playlist-import-progress" role="status"><LoaderCircle size={16}/>正在解析并获取歌单…</p>}
      {error && <p className="playlist-inline-error" role="alert">{error}</p>}
      <footer><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy}>{busy ? '正在解析…' : '解析歌单'}</button></footer>
    </form>
  </DialogFrame>;
}

export default function PlaylistLibrary(props: PlaylistLibraryProps) {
  const {library} = props;
  const [tab, setTab] = useState<'created' | 'saved'>('created');
  const [selectedId, setSelectedId] = useState<string>();
  const [nameDialog, setNameDialog] = useState<{playlist?: LocalPlaylist}>();
  const [importDialog, setImportDialog] = useState<{playlistId?: string}>();
  const [deleteTarget, setDeleteTarget] = useState<LocalPlaylist>();
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const selected = library.playlists.find(playlist => playlist.id === selectedId);
  const matchingPlaylists = library.playlists.filter(playlist => matchesText(query, [playlist.name]));
  const matchingFavorites = library.favoritePlaylists.filter(playlist => matchesText(query, [playlist.title, playlist.creatorName]));

  return <div className="playlist-library">
    <div className="playlist-library-heading"><div><h1>我的歌单</h1><p>{library.playlists.length} 个自建 · {library.favoritePlaylists.length} 个收藏</p></div><div className="playlist-library-heading-actions"><button type="button" className="secondary-button" onClick={() => setImportDialog({})}><Import size={16}/>导入 QQ 歌单</button><button type="button" className="primary-button" onClick={() => setNameDialog({})}><Plus size={16}/>新建歌单</button></div></div>
    {notice && <p className="playlist-notice" role="status">{notice}</p>}
    {selected ? <>
      <button type="button" className="discovery-back" onClick={() => setSelectedId(undefined)}><ArrowLeft size={15}/>返回我的歌单</button>
      <section className="playlist-detail-header">
        <PlaylistArtwork src={selected.tracks.find(track => track.coverUrl)?.coverUrl}/>
        <div><span className="playlist-kind">自建歌单</span><h2>{selected.name}</h2><p>{selected.tracks.length} / {MAX_PLAYLIST_TRACKS} 首歌曲</p><div className="playlist-detail-actions">
          <button type="button" className="primary-button" disabled={!selected.tracks.length} onClick={() => props.onPlay(selected.tracks, 0)}><Play size={15} fill="currentColor"/>播放全部</button>
          <button type="button" className="secondary-button" onClick={() => setImportDialog({playlistId: selected.id})}><Import size={14}/>导入歌曲</button>
          <button type="button" className="secondary-button" onClick={() => setNameDialog({playlist: selected})}><Pencil size={14}/>重命名</button>
          <button type="button" className="secondary-button playlist-delete-button" onClick={() => setDeleteTarget(selected)}><Trash2 size={14}/>删除歌单</button>
        </div></div>
      </section>
      <DiscoveryTrackList searchable key={selected.id} baseUrl={props.baseUrl} tracks={selected.tracks} onPlay={props.onPlay} onQueue={props.onQueue} onPlayNext={props.onPlayNext} onFavorite={props.onFavorite} onAddFavorites={props.onAddFavorites} onDownload={props.onDownload} onAddToPlaylist={props.onAddToPlaylist} favoriteKeys={props.favoriteKeys} currentKey={props.currentKey} onRemoveTracks={tracks => {library.removeTracks(selected.id, tracks.map(track => track.key)); setNotice(`已从「${selected.name}」移除 ${tracks.length} 首歌曲。`);}}/>
    </> : <>
      <div className="discovery-tabs" aria-label="歌单分类"><button type="button" className={`discovery-capsule ${tab === 'created' ? 'is-active' : ''}`} aria-pressed={tab === 'created'} onClick={() => {setTab('created'); setNotice('');}}>自建歌单</button><button type="button" className={`discovery-capsule ${tab === 'saved' ? 'is-active' : ''}`} aria-pressed={tab === 'saved'} onClick={() => {setTab('saved'); setNotice('');}}>收藏歌单</button></div>
      <div className="discovery-filter-bar"><div className="discovery-list-search"><Search size={15} aria-hidden="true"/>
        <input type="search" aria-label="搜索我的歌单" placeholder="搜索歌单名称或创建者" value={query} maxLength={200} onChange={event => setQuery(event.target.value)}/>
        {query && <button type="button" className="icon-button" aria-label="清空歌单搜索" onClick={() => setQuery('')}><X size={14}/></button>}
      </div></div>
      {query.trim() && (tab === 'created' ? !!library.playlists.length && !matchingPlaylists.length : !!library.favoritePlaylists.length && !matchingFavorites.length) && <p className="playlist-notice" role="status">没有找到匹配的歌单，换个关键词试试。</p>}
      {(tab === 'created' ? library.playlists.length : library.favoritePlaylists.length) ? <div className="playlist-library-grid">
        {tab === 'created' ? matchingPlaylists.map(playlist => <article className="playlist-library-card" key={playlist.id}>
          <button type="button" className="playlist-card-open" onClick={() => {setSelectedId(playlist.id); setNotice('');}}><PlaylistArtwork src={playlist.tracks.find(track => track.coverUrl)?.coverUrl}/><strong>{playlist.name}</strong><small>{playlist.tracks.length} 首歌曲</small></button>
          <div className="playlist-card-actions"><button type="button" className="icon-button" title="播放歌单" aria-label={`播放歌单 ${playlist.name}`} disabled={!playlist.tracks.length} onClick={() => props.onPlay(playlist.tracks, 0)}><Play size={15}/></button><button type="button" className="icon-button" title="重命名" aria-label={`重命名 ${playlist.name}`} onClick={() => setNameDialog({playlist})}><Pencil size={15}/></button><button type="button" className="icon-button playlist-delete-button" title="删除歌单" aria-label={`删除歌单 ${playlist.name}`} onClick={() => setDeleteTarget(playlist)}><Trash2 size={15}/></button></div>
        </article>) : matchingFavorites.map(playlist => <article className="playlist-library-card" key={playlist.id}>
          <button type="button" className="playlist-card-open" onClick={() => props.onOpenOnlinePlaylist(playlist)}><PlaylistArtwork src={playlist.coverUrl}/><strong>{playlist.title}</strong><small>{playlist.songCount === undefined ? '在线歌单' : `${playlist.songCount} 首歌曲`}{playlist.creatorName ? ` · ${playlist.creatorName}` : ''}</small></button>
          <div className="playlist-card-actions"><button type="button" className="icon-button active" title="取消收藏" aria-label={`取消收藏 ${playlist.title}`} onClick={() => {library.toggleFavoritePlaylist(playlist); setNotice(`已取消收藏「${playlist.title}」。`);}}><Heart size={15} fill="currentColor"/></button></div>
        </article>)}
      </div> : <div className="playlist-library-empty"><ListMusic size={38} strokeWidth={1.2}/><h2>{tab === 'created' ? '还没有自建歌单' : '还没有收藏歌单'}</h2><p>{tab === 'created' ? '新建歌单后，可以从歌曲列表中添加喜欢的歌曲。' : '在探索音乐里打开歌单，即可收藏到这里。'}</p>{tab === 'created' && <button type="button" className="secondary-button" onClick={() => setNameDialog({})}><Plus size={15}/>新建歌单</button>}</div>}
    </>}
    {importDialog && <ImportPlaylistDialog library={library} baseUrl={props.baseUrl} initialPlaylistId={importDialog.playlistId} onClose={() => setImportDialog(undefined)} onAdded={(message, playlistId) => {setNotice(message); setSelectedId(playlistId); setTab('created');}}/>}
    {nameDialog && <PlaylistNameDialog playlist={nameDialog.playlist} onClose={() => setNameDialog(undefined)} onSave={name => {
      if (nameDialog.playlist) {library.renamePlaylist(nameDialog.playlist.id, name); setNotice('歌单名称已更新。');}
      else {const created = library.createPlaylist(name); setSelectedId(created.id); setTab('created'); setNotice('歌单已创建，可以从歌曲列表添加歌曲。');}
      setNameDialog(undefined);
    }}/>}
    {deleteTarget && <DialogFrame title="删除歌单" onClose={() => setDeleteTarget(undefined)}><p className="playlist-delete-description">确定删除「{deleteTarget.name}」及其中的歌曲列表？已下载的音乐文件会保留。</p><footer><button data-autofocus type="button" className="secondary-button" onClick={() => setDeleteTarget(undefined)}>取消</button><button type="button" className="primary-button playlist-delete-confirm" onClick={() => {library.deletePlaylist(deleteTarget.id); if (selectedId === deleteTarget.id) setSelectedId(undefined); setNotice(`已删除「${deleteTarget.name}」。`); setDeleteTarget(undefined);}}>删除歌单</button></footer></DialogFrame>}
  </div>;
}
