import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowRight,
  AudioLines,
  Check,
  ChevronDown,
  Copy,
  Disc3,
  Download,
  FolderOpen,
  Heart,
  History,
  Library,
  ListMusic,
  ListEnd,
  ListPlus,
  ListStart,
  LoaderCircle,
  Maximize2,
  Mic2,
  Monitor,
  Moon,
  Minus,
  Music2,
  Pause,
  Play,
  Plus,
  Radio,
  Repeat,
  Repeat1,
  Search,
  Settings2,
  Shuffle,
  SkipBack,
  SkipForward,
  Sun,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { fetchLyrics } from "./services/musicApi";
import { findActiveLine, formatTime, mergeTracks, parseLyrics } from "./lib/music";
import { isString, isTracks, useStoredState } from "./state";
import { usePlayer } from "./usePlayer";
import ExpandedPlayer from "./ExpandedPlayer";
import ExploreMusic, {DiscoveryTrackList, PlaylistGrid, PlaylistView} from "./ExploreMusic";
import PlaylistLibrary, { AddToPlaylistDialog } from './PlaylistLibrary';
import { usePlaylists } from './playlists';
import type { PlaylistInfo } from './services/discovery';
import { ThemeSettings, FloatingLyricsBackgroundSettings } from "./ThemeSettings";
import ClosePrompt from './ClosePrompt';
import {ToggleSwitch} from './ToggleSwitch';
import {SettingsSelect} from './SettingsSelect';
import {CacheSettings} from './CacheSettings';
import BehaviorSettings from './BehaviorSettings';
import {useDesktopPreferences} from './useDesktopPreferences';
import {ContextMenu} from './ContextMenu';
import {DeveloperAccess} from './DeveloperAccess';
import {LyricFontSettings, isLyricFont} from './LyricFontSettings';
import { createThemePalette, useTheme } from "./theme";
import { useDesktopLyrics } from "./useDesktopLyrics";
import {useTrayPlayer} from './useTrayPlayer';
import {useOnlineSearch} from './useOnlineSearch';
import Downloads, { DownloadSettings } from './DownloadManagerView';
import { isDownloadActive, useDownloads } from './downloads';
import { PlaybackSettings } from './PlaybackSettings';
import type { PlayMode, Quality, Track } from "./types";
import appIcon from '../resources/icon.png';

type Page = "library" | "search" | "favorites" | "playlists" | "recent" | "downloads" | "settings";
const isQuality = (value: unknown): value is Quality =>
  value === "128" || value === "320" || value === "flac";
const pageNames: Record<Page, string> = {
  library: "本地音乐",
  search: "探索音乐",
  favorites: "我喜欢的音乐",
  playlists: "我的歌单",
  recent: "最近播放",
  downloads: "下载管理",
  settings: "设置",
};
const modes: Record<PlayMode, string> = {
  list: "列表循环",
  single: "单曲循环",
  shuffle: "随机播放",
};

function IconButton({
  label,
  children,
  onClick,
  active = false,
  disabled = false,
  className = "",
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`icon-button ${active ? "active" : ""} ${className}`}
    >
      {children}
    </button>
  );
}

function Cover({
  track,
  large = false,
  playing = false,
}: {
  track?: Track;
  large?: boolean;
  playing?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [track]);
  return (
    <div
      className={`cover ${large ? "large-cover" : ""} ${
        playing ? "is-playing" : ""
      }`}
    >
      {track?.coverUrl && !failed ? (
        <img src={track.coverUrl} alt="" onError={() => setFailed(true)} />
      ) : (
        <>
          <div className="record-groove" />
          <Disc3 aria-hidden="true" />
        </>
      )}
    </div>
  );
}

export default function App() {
  const theme = useTheme();
  const behavior = useDesktopPreferences();
  const playlistLibrary = usePlaylists();
  const [playlistToOpen, setPlaylistToOpen] = useState<PlaylistInfo | null>(null);
  const [pendingPlaylistTracks, setPendingPlaylistTracks] = useState<Track[] | null>(null);
  const [page, setPage] = useState<Page>("library");
  const [library, setLibrary] = useState<Track[]>([]);
  const [favorites, setFavorites] = useStoredState<Track[]>(
    "favorites",
    [],
    isTracks
  );
  const [recent, setRecent] = useStoredState<Track[]>("recent", [], isTracks);
  const [quality, setQuality] = useStoredState<Quality>(
    "quality",
    "320",
    isQuality
  );
  const [baseUrl, setBaseUrl] = useStoredState("apiBaseUrl", "", isString);
  const [apiDraft, setApiDraft] = useState(baseUrl);
  const [version, setVersion] = useState("0.3.0");
  const [developerMode, setDeveloperMode] = useState(false);
  const [toast, setToast] = useState("");
  const [importing, setImporting] = useState(false);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [keyword, setKeyword] = useState("");
  const onlineSearch = useOnlineSearch(baseUrl);
  const {query, tracks: results, playlists: playlistResults, type: searchType, loading: searching, error: searchError, hasMore} = onlineSearch;
  const [searchPlaylist, setSearchPlaylist] = useState<PlaylistInfo>();
  const [filter, setFilter] = useState("");
  const [panel, setPanel] = useState<"queue" | null>(null);
  const [queueMenu, setQueueMenu] = useState<{track: Track; x: number; y: number}>();
  const [expanded, setExpanded] = useState(false);
  const [floatingSize, setFloatingSize] = useStoredState('floatingLyricsSize', 30, (v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 18 && v <= 60);
  const [floatingOpacity, setFloatingOpacity] = useStoredState('floatingLyricsOpacity', 0.55, (v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 0.95);
  const [floatingSingleLine, setFloatingSingleLine] = useStoredState('floatingLyricsSingleLine', false, (v): v is boolean => typeof v === 'boolean');
  const [floatingRadius, setFloatingRadius] = useStoredState('floatingLyricsRadius', 12, (v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 40);
  const [lyricFontFamily, setLyricFontFamily] = useStoredState('lyricFontFamily', '', isLyricFont);
  const [lyric, setLyric] = useState("");
  const [lyricStatus, setLyricStatus] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const detailsTrigger = useRef<HTMLButtonElement>(null);
  const notePlayed = useCallback(
    (track: Track) =>
      setRecent((items) =>
        [track, ...items.filter((item) => item.key !== track.key)].slice(0, 200)
      ),
    [setRecent]
  );
  const player = usePlayer(quality, baseUrl, notePlayed);
  useTrayPlayer({title: player.current?.title ?? '', artist: player.current?.artist ?? '', playing: player.playing,
    favorite: !!player.current && favorites.some(track => track.key === player.current!.key),
    volume: player.volume, muted: player.muted, hasTrack: !!player.current, hasQueue: !!player.queue.length}, command => {
    if (command.action === 'favorite' && player.current) toggleFavorite(player.current);
    else if (command.action === 'queue') {setExpanded(false); setPanel('queue');}
    else if (command.action === 'mute') player.setMuted(!player.muted);
    else if (command.action === 'volume' && typeof command.value === 'number' && Number.isFinite(command.value) && command.value >= 0 && command.value <= 1) {
      player.setVolume(command.value); player.setMuted(false);
    }
  });
  const queueNext = (track: Track) => {
    setToast(player.enqueueNext(track) ? `已设为下一曲播放：${track.title}` : '这首歌正在播放');
  };
  useEffect(() => {
    if (panel !== 'queue' || queueMenu && !player.queue.some(track => track.key === queueMenu.track.key)) setQueueMenu(undefined);
  }, [panel, player.queue, queueMenu]);
  const changeQuality = (value: Quality) => {
    void player.changeQuality(value);
    setQuality(value);
  };
  const importDownloads = useCallback((tracks: Track[]) => {
    const updated = new Map(tracks.map(track => [track.key, track]));
    setLibrary(items => mergeTracks(items.map(track => updated.get(track.key) ?? track), tracks));
    setToast(`已将 ${tracks.length} 首下载的歌曲导入本地音乐。`);
  }, []);
  const removeDownloadedTracks = useCallback((ids: string[]) => {
    const removed = new Set(ids);
    const keep = (track: Track) => !track.localId || !removed.has(track.localId);
    setLibrary(items => items.filter(keep));
    setFavorites(items => items.filter(keep));
    setRecent(items => items.filter(keep));
    for (const playlist of playlistLibrary.playlists) playlistLibrary.removeTracks(playlist.id, playlist.tracks.filter(track => !keep(track)).map(track => track.key));
    for (const track of player.queue) if (!keep(track)) player.remove(track.key);
  }, [playlistLibrary.playlists, playlistLibrary.removeTracks, player.queue, player.remove, setFavorites, setRecent]);
  const downloads = useDownloads({baseUrl, onError: setToast, onImported: importDownloads, onRemovedLocalIds: removeDownloadedTracks});
  const activeDownloads = downloads.tasks.filter(isDownloadActive).length;
  const startDownload = (track: Track) => {
    void downloads.start(track).then(task => {
      if (task) { setPage('downloads'); setExpanded(false); setPanel(null); }
    });
  };
  const queueDownload = async (track: Track) => {
    const task = await downloads.start(track);
    if (!task) throw new Error(`无法将「${track.title}」加入下载队列，请检查提示后重试。`);
  };
  const favoriteKeys = useMemo(
    () => new Set(favorites.map((track) => track.key)),
    [favorites]
  );
  const lyrics = useMemo(() => parseLyrics(lyric), [lyric]);
  const activeLine = findActiveLine(lyrics, player.position);
  const floatingAccent = useMemo(() => createThemePalette('dark', theme.accent)['--accent'], [theme.accent]);
  const floating = useDesktopLyrics({
    title: player.current?.title ?? 'Xmusic', artist: player.current?.artist ?? '',
    line: !player.current ? '播放一首喜欢的歌' : lyrics.length ? lyrics[activeLine]?.text || '♪' : lyric.split(/\r?\n/).find(line => line.trim()) || lyricStatus,
    nextLine: lyrics.length ? lyrics[activeLine + 1]?.text || '' : player.current?.title ?? '',
    playing: player.playing, accentColor: floatingAccent, fontSize: floatingSize, fontFamily: lyricFontFamily, opacity: floatingOpacity,
    singleLine: floatingSingleLine, borderRadius: floatingRadius,
    backgroundImage: theme.floatingBackgroundImage,
    words: lyrics[activeLine]?.words ?? [],
    lineStart: lyrics[activeLine]?.time ?? 0,
    lineEnd: lyrics[activeLine]?.end ?? lyrics[activeLine + 1]?.time ?? player.duration,
    position: player.position, playbackRate: player.playbackRate, loading: player.loading,
  }, player.toggle, player.next, setToast, player.getPosition);
  const closeDetails = useCallback(() => {setExpanded(false); requestAnimationFrame(() => detailsTrigger.current?.focus());}, []);

  useEffect(() => {
    let alive = true;
    let libraryChanged = false;
    const unsubscribeLibrary = window.desktop?.onLocalTracksChanged?.(tracks => {
      if (!alive || !isTracks(tracks)) return;
      libraryChanged = true;
      setLibrary(tracks);
    });
    if (window.desktop) {
      window.desktop
        .getLocalTracks()
        .then((tracks) => {
          if (alive && !libraryChanged) setLibrary(tracks);
        })
        .catch((error) => {
          if (alive)
            setToast(error instanceof Error ? error.message : "音乐库读取失败");
        })
        .finally(() => {
          if (alive) setLibraryLoading(false);
        });
      window.desktop
        .getVersion()
        .then((value) => {
          if (alive) setVersion(value);
        })
        .catch(() => {});
    } else {
      setLibraryLoading(false);
    }
    const onStorageError = () =>
      setToast("本地存储空间不足，部分设置未能保存。");
    window.addEventListener("storage-error", onStorageError);
    return () => {
      alive = false;
      unsubscribeLibrary?.();
      window.removeEventListener("storage-error", onStorageError);
    };
  }, []);

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(""), 4500);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  useEffect(() => {
    setFilter("");
  }, [page]);
  useEffect(() => {
    let alive = true;
    setLyric("");
    if (!player.current) {
      setLyricStatus("播放一首歌，让歌词陪你一起。");
      return;
    }
    setLyricStatus("正在寻找歌词…");
    fetchLyrics(player.current, baseUrl)
      .then((text) => {
        if (alive) {
          setLyric(text);
          setLyricStatus(text ? "" : "暂无歌词，静静欣赏音乐吧。");
        }
      })
      .catch((error) => {
        if (alive)
          setLyricStatus(
            error instanceof Error ? error.message : "歌词加载失败"
          );
      });
    return () => {
      alive = false;
    };
  }, [player.current?.key, baseUrl]);
  const importMusic = useCallback(async (folders = false) => {
    if (importing) return;
    if (!window.desktop) {
      setToast("请在 Windows 客户端中打开，以导入本地音乐。");
      return;
    }
    setImporting(true);
    try {
      const result = folders ? await window.desktop.importAudioFolders() : null;
      const tracks = result ? result.tracks : await window.desktop.importAudio();
      if (tracks.length) {
        const updated = new Map(tracks.map(track => [track.key, track]));
        setLibrary(items => mergeTracks(items.map(track => updated.get(track.key) ?? track), tracks));
        setPage("library");
        setToast(`已导入 ${tracks.length} 首音乐，重复文件会自动合并。${result?.truncated ? '本次扫描已达上限，请分批选择子文件夹继续导入。' : ''}${result?.skippedDirectories ? `已跳过 ${result.skippedDirectories} 个无法读取的文件夹。` : ''}`);
      } else if (result && !result.canceled) {
        setToast(result.skippedDirectories ? '部分文件夹无法读取，未找到可导入的音频。' : '所选文件夹中没有找到支持的音频文件。');
      }
    } catch (error) {
      setToast(error instanceof Error ? error.message : "导入失败，请重试。");
    } finally {
      setImporting(false);
    }
  }, [importing]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (behavior.loading || !behavior.preferences.shortcutsEnabled) return;
      if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
      const target = event.target as HTMLElement;
      const typing =
        target.matches("input, textarea, select, button") ||
        target.isContentEditable;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
        event.preventDefault();
        void importMusic();
      } else if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault();
        setExpanded(false);
        setPanel(null);
        // Wait for React to remove `inert` from the main area before focusing it.
        requestAnimationFrame(() => searchInput.current?.focus());
      } else if (!typing && event.code === "Space") {
        event.preventDefault();
        player.toggle();
      } else if (!typing && event.ctrlKey && event.key === "ArrowRight") {
        event.preventDefault();
        player.next(1);
      } else if (!typing && event.ctrlKey && event.key === "ArrowLeft") {
        event.preventDefault();
        player.next(-1);
      } else if (event.key === "Escape") { if (panel) setPanel(null); else if (expanded) closeDetails(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [importMusic, player.toggle, player.next, panel, expanded, closeDetails, behavior.loading, behavior.preferences.shortcutsEnabled]);

  function toggleFavorite(track: Track) {
    setFavorites((items) =>
      items.some((item) => item.key === track.key)
        ? items.filter((item) => item.key !== track.key)
        : [track, ...items]
    );
  }

  async function doSearch(event?: FormEvent) {
    event?.preventDefault();
    const term = keyword.trim();
    if (!term) {
      searchInput.current?.focus();
      return;
    }
    setPage("search");
    setSearchPlaylist(undefined);
    await onlineSearch.search(term);
  }

  async function removeLocal(track: Track) {
    if (!track.localId || !window.desktop) return;
    try {
      await window.desktop.removeLocalTrack(track.localId);
      setLibrary((items) => items.filter((item) => item.key !== track.key));
      setFavorites((items) => items.filter((item) => item.key !== track.key));
      setRecent((items) => items.filter((item) => item.key !== track.key));
      for (const playlist of playlistLibrary.playlists) playlistLibrary.removeTracks(playlist.id, [track.key]);
      player.remove(track.key);
      setToast("已从音乐库移除，原文件保留在电脑中。");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "移除失败");
      throw error;
    }
  }

  function saveSettings(event: FormEvent) {
    event.preventDefault();
    const clean = apiDraft.trim().replace(/\/+$/, "");
    if (clean) {
      try {
        const url = new URL(clean);
        if (
          !["https:", "http:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error();
      } catch {
        setToast(
          "请输入完整的 HTTP 或 HTTPS 接口地址，不含账号、查询参数或片段。"
        );
        return;
      }
    }
    if (clean !== baseUrl) {
      onlineSearch.reset();
      setSearchPlaylist(undefined);
    }
    setBaseUrl(clean);
    setApiDraft(clean);
    setToast("设置已保存，下次搜索和播放时生效。");
  }

  const tracks =
    page === "favorites"
      ? favorites
      : page === "recent"
      ? recent
      : page === "search"
      ? results
      : library;
  const filtered = useMemo(() => {
    const value = filter.trim().toLocaleLowerCase();
    return value
      ? tracks.filter((track) =>
          `${track.title} ${track.artist} ${track.album ?? ""}`
            .toLocaleLowerCase()
            .includes(value)
        )
      : tracks;
  }, [tracks, filter]);
  const cycleMode = () =>
    player.setMode(
      player.mode === "list"
        ? "single"
        : player.mode === "single"
        ? "shuffle"
        : "list"
    );

  return (
    <div className="app-shell">
      <header className="titlebar">
        <span className="titlebar-name">
          <img className="titlebar-icon" src={appIcon} alt="" /> Xmusic
        </span>
        <div className="window-actions">
          <IconButton
            label={theme.resolvedMode === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
            className="theme-quick-toggle"
            onClick={() => theme.setMode(theme.resolvedMode === 'dark' ? 'light' : 'dark')}
          >
            {theme.resolvedMode === 'dark' ? <Sun size={16}/> : <Moon size={16}/>}
          </IconButton>
          <IconButton label="最小化" onClick={() => window.desktop?.minimize()}>
            <Minus size={16} />
          </IconButton>
          <IconButton
            label="最大化 / 还原"
            onClick={() => window.desktop?.maximize()}
          >
            <Maximize2 size={13} />
          </IconButton>
          <IconButton
            label="关闭窗口"
            className="close-window"
            onClick={() => window.desktop?.close()}
          >
            <X size={17} />
          </IconButton>
        </div>
      </header>

      <aside className="sidebar" inert={expanded} aria-hidden={expanded}>
        <a
          className="brand"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            setPage("library");
          }}
        >
          <span className="brand-mark">
            <img src={appIcon} alt="" />
          </span>
          <span>
            Xmusic<span className="brand-caption">听 见 热 爱</span>
          </span>
        </a>
        <div className="nav-label">发现</div>
        <button
          className={`nav-item ${page === "search" ? "selected" : ""}`}
          onClick={() => {
            setPage("search");
            onlineSearch.reset();
            setSearchPlaylist(undefined);
          }}
        >
          <Radio size={19} />
          探索音乐
          <ArrowRight size={14} className="nav-arrow" />
        </button>
        <div className="nav-label library-label">我的音乐</div>
        <button className={`nav-item ${page === 'playlists' ? 'selected' : ''}`} onClick={() => setPage('playlists')}>
          <ListMusic size={19} />我的歌单<span className="nav-count">{playlistLibrary.playlists.length + playlistLibrary.favoritePlaylists.length}</span>
        </button>
        <button
          className={`nav-item ${page === "library" ? "selected" : ""}`}
          onClick={() => setPage("library")}
        >
          <Library size={19} />
          本地音乐<span className="nav-count">{library.length}</span>
        </button>
        <button
          className={`nav-item ${page === "favorites" ? "selected" : ""}`}
          onClick={() => setPage("favorites")}
        >
          <Heart size={19} />
          我喜欢的音乐<span className="nav-count">{favorites.length}</span>
        </button>
        <button
          className={`nav-item ${page === "recent" ? "selected" : ""}`}
          onClick={() => setPage("recent")}
        >
          <History size={19} />
          最近播放
        </button>
        <button className={`nav-item ${page === 'downloads' ? 'selected' : ''}`} onClick={() => setPage('downloads')}>
          <Download size={19}/>下载管理<span className="nav-count">{activeDownloads || downloads.tasks.length}</span>
        </button>
        <div className="sidebar-bottom">
          <div className="offline-note">
            <span className="status-dot" />
            <span>
              让好音乐，留在身边<small>本地音乐随时畅听</small>
            </span>
          </div>
          <div className="sidebar-settings-entry"><button
            className={`nav-item ${page === "settings" ? "selected" : ""}`}
            onClick={() => setPage("settings")}
          >
            <Settings2 size={18} />
            设置
          </button><DeveloperAccess version={version} enabled={developerMode} onUnlock={() => {setDeveloperMode(true); setPage('settings'); setToast('已进入开发者模式');}}/></div>
        </div>
      </aside>

      <main className="main-area" inert={expanded} aria-hidden={expanded}>
        <div className="topbar">
          <form
            className="global-search"
            onSubmit={(event) => void doSearch(event)}
          >
            <Search size={17} />
            <input
              ref={searchInput}
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              maxLength={100}
              aria-label="搜索在线音乐"
              placeholder={searchType === 'playlist' ? '搜索歌单…' : '搜索歌曲、歌手、歌单…'}
            />
            <kbd>Ctrl F</kbd>
          </form>
          <button
            className="small-import"
            aria-label="导入本地音乐"
            onClick={() => void importMusic()}
            disabled={importing}
          >
            {importing ? (
              <LoaderCircle size={17} className="spin" />
            ) : (
              <Plus size={17} />
            )}
            导入音乐
          </button>
        </div>

        <div className="page-scroll">
          {!window.desktop && (
            <div className="notice">
              当前为浏览器预览。请运行 Windows
              客户端使用本地导入和在线音乐服务。
            </div>
          )}
          {page === "settings" ? (
            <section className="settings-page">
              <span className="eyebrow">MAKE IT YOURS</span>
              <h1>听歌，按你的习惯。</h1>
              <p className="page-description">
                调整主题、歌词和音质，打造自己的音乐空间。
              </p>
              <ThemeSettings theme={theme} />
              <BehaviorSettings settings={behavior}/>
              <CacheSettings/>
              <DownloadSettings controller={downloads}/>
              <section className="settings-card floating-settings" aria-label="桌面歌词设置">
                <div className="section-heading"><Monitor size={20}/><h2>桌面悬浮歌词</h2></div>
                <div className="setting-row"><span>独立置顶歌词<small>主窗口最小化后，歌词仍会跟随播放。</small></span><ToggleSwitch label="桌面悬浮歌词" checked={floating.visible} disabled={floating.pending} onCheckedChange={() => void floating.toggleVisible()}/></div>
                <div className="setting-row"><span>锁定与鼠标穿透<small>锁定后可在这里解锁，或按 Ctrl + Alt + U。</small></span><ToggleSwitch label="锁定与鼠标穿透" checked={floating.locked} disabled={!floating.visible} onCheckedChange={locked => void floating.setLocked(locked)}/></div>
                <div className="setting-row"><span>单行左右显示<small>左边当前句，右边下一句；两句完整显示，缓慢滑动换句。</small></span><ToggleSwitch label="单行左右显示" checked={floatingSingleLine} onCheckedChange={setFloatingSingleLine}/></div>
                <LyricFontSettings value={lyricFontFamily} onChange={setLyricFontFamily}/>
                <label className="setting-row"><span>悬浮歌词字号</span><div className="floating-setting-actions"><input type="range" aria-label="悬浮歌词字号" aria-valuetext={`${floatingSize} 像素`} min={18} max={60} step={2} value={floatingSize} style={{'--range-fill': `${(floatingSize - 18) / 42 * 100}%`} as React.CSSProperties} onChange={event => setFloatingSize(Number(event.target.value))}/><output>{floatingSize}px</output></div></label>
                <label className="setting-row"><span>悬浮背景不透明度</span><div className="floating-setting-actions"><input type="range" aria-label="悬浮背景不透明度" aria-valuetext={`${Math.round(floatingOpacity * 100)}%`} min={0} max={0.95} step={0.05} value={floatingOpacity} style={{'--range-fill': `${floatingOpacity / 0.95 * 100}%`} as React.CSSProperties} onChange={event => setFloatingOpacity(Number(event.target.value))}/><output>{Math.round(floatingOpacity * 100)}%</output></div></label>
                <label className="setting-row"><span>悬浮背景圆角</span><div className="floating-setting-actions"><input type="range" aria-label="悬浮背景圆角" aria-valuetext={`${floatingRadius} 像素`} min={0} max={40} step={1} value={floatingRadius} style={{'--range-fill': `${floatingRadius / 40 * 100}%`} as React.CSSProperties} onChange={event => setFloatingRadius(Number(event.target.value))}/><output>{floatingRadius}px</output></div></label>
                <FloatingLyricsBackgroundSettings theme={theme} opacity={floatingOpacity} borderRadius={floatingRadius}/>
                <p className="floating-help">拖动窗口边缘可调整背景大小，字号保持设置值。长句会自动扩宽背景，短句恢复手动宽度；超出屏幕宽度时换行显示。拖动背景边缘或标题可移动，鼠标进入时显示上方控件，移开后自动隐藏；右键歌词可复制。</p>
              </section>
              <form onSubmit={saveSettings} className="settings-card">
                <div className="section-heading">
                  <AudioLines size={21} />
                  <h2>播放设置</h2>
                </div>
                <label className="setting-row">
                  <span>
                    在线播放音质
                    <small>所选音质不可用时，自动尝试较低音质。</small>
                  </span>
                  <SettingsSelect label="在线播放音质" value={quality} onChange={value => changeQuality(value as Quality)}
                    options={[{value: '128', label: '标准 · 128 kbps'}, {value: '320', label: '高清 · 320 kbps（默认）'}, {value: 'flac', label: '无损 · FLAC'}]}/>
                </label>
                {developerMode && <><label className="api-label" htmlFor="api-url">
                  自定义音乐接口
                </label>
                <p className="setting-help">
                  兼容移动端接口，留空使用内置服务。
                </p>
                <input
                  id="api-url"
                  type="url"
                  value={apiDraft}
                  onChange={(event) => setApiDraft(event.target.value)}
                  placeholder="https://your-music-api.example.com"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button className="primary-button" type="submit">
                  <Check size={17} />
                  保存设置
                </button>
                </>}
              </form>
              <div className="settings-card shortcuts">
                <h2>快捷键</h2>
                <div>
                  <span>播放 / 暂停</span>
                  <kbd>Space</kbd>
                </div>
                <div>
                  <span>导入本地音乐</span>
                  <kbd>Ctrl O</kbd>
                </div>
                <div>
                  <span>搜索音乐</span>
                  <kbd>Ctrl F</kbd>
                </div>
                <div>
                  <span>上一首 / 下一首</span>
                  <kbd>Ctrl ← / →</kbd>
                </div>
              </div>
              <p className="about-text">
                Xmusic for Windows · {version}
                <a className="author-link" href="https://github.com/XG2020/Xmusic_App" target="_blank" rel="noreferrer" onClick={event => {
                  if (window.desktop) {event.preventDefault(); void window.desktop.openProjectPage().catch(error => setToast(error instanceof Error ? error.message : '无法打开项目主页'));}
                }}>by XG.GM</a>
                <span>音乐库与收藏保存在这台电脑上。</span>
              </p>
            </section>
          ) : page === 'downloads' ? <Downloads controller={downloads}/>
            : page === 'playlists' ? <PlaylistLibrary library={playlistLibrary} baseUrl={baseUrl}
              currentKey={player.current?.key} favoriteKeys={favoriteKeys}
              onPlay={(items, index = 0) => { if (items[index]) void player.playTrack(items[index], items); }}
              onFavorite={toggleFavorite} onDownload={queueDownload} onQueue={player.enqueue} onPlayNext={queueNext}
              onAddFavorites={items => setFavorites(current => mergeTracks(current, items))}
              onAddToPlaylist={setPendingPlaylistTracks}
              onOpenOnlinePlaylist={info => { onlineSearch.reset(); setSearchPlaylist(undefined); setPlaylistToOpen(info); setPage('search'); }} />
            : page === 'search' && !query ? <ExploreMusic baseUrl={baseUrl}
              currentKey={player.current?.key} favoriteKeys={favoriteKeys}
              onPlay={(items, index = 0) => { if (items[index]) void player.playTrack(items[index], items); }}
              onFavorite={toggleFavorite} onDownload={queueDownload} onPlayNext={queueNext}
              onAddFavorites={items => setFavorites(current => mergeTracks(current, items))}
              favoritePlaylistIds={playlistLibrary.favoritePlaylistIds} onTogglePlaylistFavorite={info => {
                try { playlistLibrary.toggleFavoritePlaylist(info); }
                catch (error) { setToast(error instanceof Error ? error.message : '歌单收藏失败，请重试。'); }
              }}
              onAddToPlaylist={setPendingPlaylistTracks} playlistToOpen={playlistToOpen} onPlaylistOpened={() => setPlaylistToOpen(null)}
              onQueue={track => { player.enqueue(track); setToast(`已加入队列：${track.title}`); }} />
            : page === 'search' && searchPlaylist ? <PlaylistView key={`${baseUrl}:${searchPlaylist.id}`} playlist={searchPlaylist} baseUrl={baseUrl}
              backLabel="返回搜索结果" onBack={() => setSearchPlaylist(undefined)}
              currentKey={player.current?.key} favoriteKeys={favoriteKeys}
              onPlay={(items, index = 0) => {if (items[index]) void player.playTrack(items[index], items);}}
              onQueue={track => {player.enqueue(track); setToast(`已加入队列：${track.title}`);}}
              onPlayNext={queueNext} onFavorite={toggleFavorite} onDownload={queueDownload}
              onAddFavorites={items => setFavorites(current => mergeTracks(current, items))}
              onAddToPlaylist={setPendingPlaylistTracks} favoritePlaylistIds={playlistLibrary.favoritePlaylistIds}
              onTogglePlaylistFavorite={info => {
                try {playlistLibrary.toggleFavoritePlaylist(info);}
                catch (error) {setToast(error instanceof Error ? error.message : '歌单收藏失败，请重试。');}
              }}/> : (
            <>
              <section className="track-section">
                <div className="list-heading">
                  <div>
                    <h2>
                      {page === "search" && query
                        ? `“${query}” 的搜索结果`
                        : pageNames[page]}
                    </h2>
                    <span>
                      {page === 'search' && searchType === 'playlist' ? `${playlistResults.length} 张歌单` : `${tracks.length} 首歌曲`}
                      {page === "search" && hasMore ? " · 可继续加载" : ""}
                    </span>
                  </div>
                  <div className="list-tools">
                    {page === 'library' && <button className="text-button" disabled={importing} onClick={() => void importMusic(true)}><FolderOpen size={15}/>{importing ? '正在导入…' : '导入文件夹'}</button>}
                    {page === 'recent' && <button className="text-button" disabled={!recent.length} onClick={() => {setRecent([]); setToast('已清空最近播放记录。');}}><Trash2 size={14}/>清空最近播放</button>}
                    {page === 'search' && query && <button className="text-button" onClick={() => {onlineSearch.reset(); setSearchPlaylist(undefined);}}>返回探索</button>}
                    {page !== "search" && (
                      <div className="list-search">
                        <Search size={15} />
                        <input
                          value={filter}
                          onChange={(event) => setFilter(event.target.value)}
                          aria-label="筛选当前列表"
                          placeholder="在列表中搜索"
                        />
                      </div>
                    )}
                    {(page !== 'search' || searchType === 'song') && <button
                      className="text-button"
                      disabled={!filtered.length}
                      onClick={() =>
                        void player.playTrack(filtered[0], filtered)
                      }
                    >
                      <Play size={14} />
                      播放全部
                    </button>}
                  </div>
                </div>
                {page === 'search' && query && <div className="discovery-tabs search-type-tabs" role="group" aria-label="搜索类型">
                  <button type="button" className={`discovery-capsule ${searchType === 'song' ? 'is-active' : ''}`} aria-pressed={searchType === 'song'} onClick={() => void onlineSearch.switchType('song')}>歌曲</button>
                  <button type="button" className={`discovery-capsule ${searchType === 'playlist' ? 'is-active' : ''}`} aria-pressed={searchType === 'playlist'} onClick={() => void onlineSearch.switchType('playlist')}>歌单</button>
                </div>}
                {searchError && page === "search" && (
                  <div className="error-message" role="alert">
                    {searchError}
                    <button
                      onClick={() => void onlineSearch.retry()}
                    >
                      重试
                    </button>
                  </div>
                )}
                {(page === "library" && libraryLoading) ||
                (page === "search" && searching && !(searchType === 'playlist' ? playlistResults.length : results.length)) ? (
                  <div className="empty-state">
                    <LoaderCircle className="spin" size={30} />
                    <h3>{searching ? "正在寻找好音乐…" : "正在打开音乐库…"}</h3>
                  </div>
                ) : page === 'search' && searchType === 'playlist' ? (
                  playlistResults.length ? <PlaylistGrid playlists={playlistResults} onSelect={setSearchPlaylist}/> : <div className="empty-state">
                    <div className="empty-icon"><ListMusic/></div>
                    <h3>{searchError ? '暂时无法获取搜索结果' : '没有找到相关歌单'}</h3>
                    <p>可以换个关键词，或检查音乐服务设置。</p>
                  </div>
                ) : filtered.length ? (
                  <DiscoveryTrackList key={`${page}:${query}:${baseUrl}`} tracks={filtered} baseUrl={baseUrl} listLabel={pageNames[page]}
                    currentKey={player.current?.key} favoriteKeys={favoriteKeys}
                    onPlay={(items, index = 0) => {if (items[index]) void player.playTrack(items[index], items);}}
                    onQueue={track => {player.enqueue(track); setToast(`已加入队列：${track.title}`);}}
                    onPlayNext={queueNext}
                    onFavorite={toggleFavorite} onAddFavorites={items => setFavorites(previous => mergeTracks(previous, items))}
                    onDownload={queueDownload} onAddToPlaylist={setPendingPlaylistTracks}
                    removeLabel={page === 'library' ? '从音乐库移除' : '取消喜欢'} showRemoveButton={page === 'library'}
                    onRemoveTracks={page === 'library' ? async items => {for (const track of items) await removeLocal(track);}
                      : page === 'favorites' ? items => {const keys = new Set(items.map(track => track.key)); setFavorites(previous => previous.filter(track => !keys.has(track.key)));}
                      : undefined}
                  />
                ) : (
                  <div className="empty-state">
                    <div className="empty-icon">
                      {page === "favorites" ? (
                        <Heart />
                      ) : page === "search" ? (
                        <Search />
                      ) : page === "recent" ? (
                        <History />
                      ) : (
                        <Music2 />
                      )}
                    </div>
                    <h3>
                      {filter
                        ? "没有找到匹配的音乐"
                        : page === "library"
                        ? "把你的第一首音乐放进来"
                        : page === "favorites"
                        ? "从一首喜欢的歌开始"
                        : page === "recent"
                        ? "你的听歌故事，即将开始"
                        : query
                        ? searchError
                          ? "暂时无法获取搜索结果"
                          : "没有找到相关歌曲"
                        : "下一首喜欢的歌，等你发现"}
                    </h3>
                    <p>
                      {filter
                        ? "试试其他歌曲名、歌手或专辑。"
                        : page === "library"
                        ? "点击「导入本地音乐」，或按 Ctrl + O 选择音频文件。"
                        : page === "favorites"
                        ? "点击歌曲旁的爱心，就能在这里再次遇见。"
                        : page === "recent"
                        ? "播放过的音乐，会为你保留在这里。"
                        : query
                        ? "可以换个关键词，或检查音乐服务设置。"
                        : "在上方搜索框输入歌曲名或歌手，按 Enter 开始。"}
                    </p>
                    {page === "library" && !filter && (
                      <button
                        className="secondary-button"
                        onClick={() => void importMusic()}
                        disabled={importing}
                      >
                        <Plus size={17} />
                        添加音乐
                      </button>
                    )}
                  </div>
                )}
                {page === "search" && hasMore && (
                  <button
                    className="load-more secondary-button"
                    disabled={searching}
                    onClick={() => void onlineSearch.loadMore()}
                  >
                    {searching ? (
                      <LoaderCircle className="spin" size={16} />
                    ) : (
                      <ChevronDown size={16} />
                    )}
                    {searching ? "加载中…" : searchType === 'playlist' ? '加载更多歌单' : '加载更多歌曲'}
                  </button>
                )}
              </section>
              <footer className="page-footer">
                <AudioLines size={13} />
                <span>把日常，调成喜欢的频率。</span>
                <span>XMUSIC / WINDOWS</span>
              </footer>
            </>
          )}
        </div>
      </main>

      {expanded && <ExpandedPlayer track={player.current} baseUrl={baseUrl} fontFamily={lyricFontFamily} playing={player.playing} lyrics={lyrics} position={player.position} getPosition={player.getPosition} duration={player.duration} rawLyric={lyric} lyricStatus={lyricStatus} favorite={!!player.current && favoriteKeys.has(player.current.key)} onFavorite={() => player.current && toggleFavorite(player.current)} onSeek={player.seek} onClose={closeDetails}/>}
      {panel === "queue" && (
        <aside className="side-panel" aria-label="播放队列">
          <div className="panel-heading"><h2>正在播放<span>{player.queue.length} 首</span></h2><IconButton label="收起面板" onClick={() => setPanel(null)}><X size={19}/></IconButton></div>
          <div className="queue-tools"><span>{modes[player.mode]}</span><button className="text-button" disabled={!player.queue.length} onClick={player.clear}><Trash2 size={14}/>清空队列</button></div>
          <div className="queue-scroll">{player.queue.length ? player.queue.map((track, index) => (
            <div key={track.key} tabIndex={0} className={`queue-item ${player.current?.key === track.key ? "selected" : ""}`} onContextMenu={event => {
              event.preventDefault(); event.currentTarget.focus({preventScroll: true});
              const bounds = event.currentTarget.getBoundingClientRect();
              setQueueMenu({track, x: event.clientX || bounds.left + 35, y: event.clientY || bounds.top + 20});
            }}>
              <span>{player.current?.key === track.key ? <AudioLines size={15}/> : index + 1}</span>
              <button onClick={() => void player.playTrack(track)}><strong>{track.title}</strong><small>{track.artist}</small></button>
              <IconButton label={`从队列移除 ${track.title}`} onClick={() => player.remove(track.key)}><X size={15}/></IconButton>
            </div>
          )) : <div className="empty-state"><ListMusic size={32}/><h3>队列还是空的</h3><p>选择一首歌，开始播放。</p></div>}</div>
        </aside>
      )}
      {queueMenu && panel === 'queue' && <ContextMenu ariaLabel="歌曲操作" position={queueMenu} onClose={() => setQueueMenu(undefined)} items={[
        {id: 'play', label: '立即播放', icon: <Play size={16}/>, onSelect: () => {void player.playTrack(queueMenu.track);}},
        {id: 'next', label: '下一曲播放', icon: <ListStart size={16}/>, onSelect: () => queueNext(queueMenu.track)},
        {id: 'queue', label: '加入播放队列', icon: <ListEnd size={16}/>, onSelect: () => {player.enqueue(queueMenu.track); setToast('已在播放队列中');}},
        {id: 'favorite', label: favoriteKeys.has(queueMenu.track.key) ? '取消收藏' : '收藏到我喜欢', icon: <Heart size={16}/>, onSelect: () => toggleFavorite(queueMenu.track)},
        {id: 'playlist', label: '添加到歌单…', icon: <ListPlus size={16}/>, onSelect: () => setPendingPlaylistTracks([queueMenu.track])},
        ...(queueMenu.track.source === 'online' ? [{id: 'download', label: '下载', icon: <Download size={16}/>, onSelect: () => startDownload(queueMenu.track)}] : []),
        {id: 'copy', label: '复制歌名', icon: <Copy size={16}/>, onSelect: () => {
          if (!window.desktop) {setToast('请在 Windows 客户端中复制歌名。'); return;}
          void window.desktop.copyText(`${queueMenu.track.title} - ${queueMenu.track.artist}`).then(() => setToast('已复制歌名'), error => setToast(error instanceof Error ? error.message : '复制失败'));
        }},
        {id: 'remove', label: '从队列移除', icon: <Trash2 size={16}/>, danger: true, onSelect: () => player.remove(queueMenu.track.key)},
      ]}/>}

      {player.error && (
        <div className="playback-error" role="alert">
          <span>{player.error}</span>
          <IconButton label="关闭播放提示" onClick={() => player.setError("")}>
            <X size={16} />
          </IconButton>
        </div>
      )}
      <footer className="player-bar">
        <div className="now-playing">
          <button
            className="cover-button"
            ref={detailsTrigger}
            aria-label="展开歌曲详情与歌词"
            aria-expanded={expanded}
            onClick={() => {setExpanded(!expanded); setPanel(null);}}
          >
            <Cover track={player.current} playing={player.playing} />
          </button>
          <button className="now-playing-text details-trigger" aria-label="查看歌曲详情" onClick={() => {setExpanded(true); setPanel(null);}}>
            <strong>{player.current?.title ?? "准备好，听点喜欢的"}</strong>
            <span>{player.current?.artist ?? "让音乐填满这一刻"}</span>
          </button>
          {player.current && (
            <IconButton
              label="喜欢当前歌曲"
              active={favoriteKeys.has(player.current.key)}
              onClick={() => player.current && toggleFavorite(player.current)}
            >
              <Heart
                size={18}
                fill={
                  favoriteKeys.has(player.current.key) ? "currentColor" : "none"
                }
              />
            </IconButton>
          )}
          {player.current?.source === 'online' && <IconButton label="下载当前歌曲" onClick={() => player.current && startDownload(player.current)}><Download size={17}/></IconButton>}
        </div>
        <div className="playback-center">
          <div className="playback-buttons">
            <IconButton label={modes[player.mode]} onClick={cycleMode}>
              {player.mode === "shuffle" ? (
                <Shuffle size={18} />
              ) : player.mode === "single" ? (
                <Repeat1 size={18} />
              ) : (
                <Repeat size={18} />
              )}
            </IconButton>
            <IconButton
              label="上一首"
              disabled={!player.queue.length}
              onClick={() => player.next(-1)}
            >
              <SkipBack size={20} fill="currentColor" />
            </IconButton>
            <IconButton
              className="play-button"
              label={
                player.loading ? "取消加载" : player.playing ? "暂停" : "播放"
              }
              disabled={!player.queue.length}
              onClick={player.toggle}
            >
              {player.loading ? (
                <LoaderCircle className="spin" size={23} />
              ) : player.playing ? (
                <Pause size={23} fill="currentColor" />
              ) : (
                <Play size={23} fill="currentColor" />
              )}
            </IconButton>
            <IconButton
              label="下一首"
              disabled={!player.queue.length}
              onClick={() => player.next(1)}
            >
              <SkipForward size={20} fill="currentColor" />
            </IconButton>
            <IconButton
              label="显示歌词"
              active={expanded}
              onClick={() => {setExpanded(!expanded); setPanel(null);}}
            >
              <Mic2 size={18} />
            </IconButton>
            <IconButton label={floating.visible ? '关闭桌面歌词' : '开启桌面歌词'} active={floating.visible} disabled={floating.pending} onClick={() => void floating.toggleVisible()}><Monitor size={18}/></IconButton>
          </div>
          <div className="progress-row">
            <span>{formatTime(player.position)}</span>
            <input
              type="range"
              min={0}
              max={player.duration || 0}
              step={0.1}
              value={Math.min(player.position, player.duration || 0)}
              disabled={!player.duration}
              onChange={(event) => player.seek(Number(event.target.value))}
              aria-label="播放进度"
              style={
                {
                  "--range-fill": `${
                    player.duration
                      ? (player.position / player.duration) * 100
                      : 0
                  }%`,
                } as React.CSSProperties
              }
            />
            <span>
              {formatTime(player.duration || player.current?.duration)}
            </span>
          </div>
        </div>
        <div className="player-extras">
          <PlaybackSettings quality={quality} onQualityChange={changeQuality} playbackRate={player.playbackRate} onPlaybackRateChange={player.setPlaybackRate} local={player.current?.source === 'local'} pause={player.pause}/>
          <IconButton
            label={player.muted ? "取消静音" : "静音"}
            onClick={() => player.setMuted(!player.muted)}
          >
            {player.muted || player.volume === 0 ? (
              <VolumeX size={19} />
            ) : (
              <Volume2 size={19} />
            )}
          </IconButton>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={player.muted ? 0 : player.volume}
            onChange={(event) => {
              player.setVolume(Number(event.target.value));
              player.setMuted(false);
            }}
            aria-label="音量"
            style={
              {
                "--range-fill": `${player.muted ? 0 : player.volume * 100}%`,
              } as React.CSSProperties
            }
          />
          <span className="player-divider" />
          <IconButton
            label={`播放队列，${player.queue.length} 首`}
            active={panel === "queue"}
            onClick={() => setPanel(panel === "queue" ? null : "queue")}
          >
            <ListMusic size={22} />
          </IconButton>
        </div>
      </footer>
      {pendingPlaylistTracks && <AddToPlaylistDialog library={playlistLibrary} tracks={pendingPlaylistTracks}
        onClose={() => setPendingPlaylistTracks(null)} onAdded={setToast} />}
      <ClosePrompt />
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
        </div>
      )}
    </div>
  );
}
