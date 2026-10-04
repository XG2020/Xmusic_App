import {memo, useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent, type Ref} from 'react';
import {ChevronDown, Copy, Disc3, Heart, Minus, Play, Plus, RotateCcw} from 'lucide-react';
import {findActiveLine, formatTime, getLyricWordProgress, type LyricLine} from './lib/music';
import {useStoredState} from './state';
import {fetchSongDetails} from './services/musicApi';
import type {Track} from './types';
import {ContextMenu} from './ContextMenu';
import {lyricFontCss} from './LyricFontSettings';
import './expanded-player.css';

interface Props {
  track?: Track;
  baseUrl?: string;
  fontFamily?: string;
  playing: boolean;
  lyrics: LyricLine[];
  position: number;
  getPosition?(): number;
  duration: number;
  rawLyric: string;
  lyricStatus: string;
  favorite: boolean;
  onFavorite(): void;
  onSeek(seconds: number): void;
  onClose(): void;
}
const validSize = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 18 && value <= 40;
const infoValue = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : '未提供';

function SongInfoCard({title, rows}: {title: string; rows: {label: string; value: string}[]}) {
  return <section className="detail-info-card" aria-label={title}>
    <h3>{title}</h3>
    <dl>{rows.map(row => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>
  </section>;
}

const LyricRow = memo(function LyricRow({line, index, active, position, lineRef, onSeek, showTime, onBrowse, onContextMenu}: {
  line: LyricLine;
  index: number;
  active: boolean;
  position: number;
  lineRef?: Ref<HTMLButtonElement>;
  onSeek(seconds: number): void;
  showTime: boolean;
  onBrowse(index: number): void;
  onContextMenu(event: MouseEvent<HTMLButtonElement>, text: string, index: number): void;
}) {
  const timed = !!line.words?.length;
  return <button type="button" ref={lineRef} data-lyric-index={index} className={`detail-lyric-line ${active ? 'active' : ''} ${timed ? 'word-timed' : ''} ${showTime ? 'browsing' : ''}`} aria-current={active ? 'true' : undefined} title={`跳转到 ${formatTime(line.time)}`} onClick={() => onSeek(line.time)} onFocus={() => onBrowse(index)} onContextMenu={event => onContextMenu(event, line.text, index)}>
    {timed ? line.words!.map((word, index) => <span key={index} className="detail-lyric-word" style={{'--word-progress': `${(active ? getLyricWordProgress(word, position) : 0) * 100}%`} as CSSProperties}>{word.text}</span>) : line.text || '♪'}
    {showTime && <span className="detail-lyric-time" aria-label={`跳转到 ${formatTime(line.time)}`}><Play size={11} fill="currentColor"/>{formatTime(line.time)}</span>}
  </button>;
});

export default function ExpandedPlayer(props: Props) {
  const {track, baseUrl, fontFamily, playing, lyrics, position, getPosition, duration, rawLyric, lyricStatus, favorite, onFavorite, onSeek, onClose} = props;
  const [tab, setTab] = useState<'lyrics' | 'info'>('lyrics');
  const infoKey = JSON.stringify([track?.key, track?.source, track?.mid, track?.songId, baseUrl?.trim() || '']);
  const [songInfo, setSongInfo] = useState<{key: string; data?: Track; error?: string; loading: boolean}>({key: '', loading: false});
  const [infoAttempt, setInfoAttempt] = useState(0);
  const visibleInfo = songInfo.key === infoKey ? songInfo : undefined;
  const detail = track?.source === 'local' ? track : visibleInfo?.data ?? track;
  const detailDuration = detail?.duration || duration;
  const infoLoading = tab === 'info' && track?.source === 'online' && (!visibleInfo || visibleInfo.loading);
  const [fontSize, setFontSize] = useStoredState('lyricFontSize', 26, validSize);
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  const resumeTimer = useRef<number | undefined>(undefined);
  const noticeTimer = useRef<number | undefined>(undefined);
  const copyVersion = useRef(0);
  const [browseIndex, setBrowseIndex] = useState(-1);
  const [lyricMenu, setLyricMenu] = useState<{x: number; y: number; text: string} | null>(null);
  const menuOpen = useRef(false);
  const [copyNotice, setCopyNotice] = useState('');
  const [coverFailed, setCoverFailed] = useState(false);
  useEffect(() => setCoverFailed(false), [track]);
  const scroller = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [clock, setClock] = useState({key: track?.key, position});
  const lyricPosition = playing && getPosition && clock.key === track?.key ? clock.position : position;
  const active = findActiveLine(lyrics, lyricPosition);
  const resumeFollowing = useCallback(() => {
    window.clearTimeout(resumeTimer.current);
    followingRef.current = true;
    setFollowing(true);
  }, []);
  const scheduleResume = useCallback(() => {
    window.clearTimeout(resumeTimer.current);
    if (!menuOpen.current) resumeTimer.current = window.setTimeout(resumeFollowing, 2000);
  }, [resumeFollowing]);
  const browse = useCallback((index = active) => {
    followingRef.current = false;
    setFollowing(false);
    setBrowseIndex(index);
    scheduleResume();
  }, [active, scheduleResume]);
  const seekLine = useCallback((seconds: number) => {resumeFollowing(); onSeek(seconds);}, [onSeek, resumeFollowing]);
  const browseFocusedLine = useCallback((index: number) => {if (!followingRef.current) browse(index);}, [browse]);
  const openLyricMenu = useCallback((event: MouseEvent<HTMLElement>, text: string, index = active) => {
    event.preventDefault(); event.stopPropagation();
    menuOpen.current = true;
    browse(index);
    event.currentTarget.focus({preventScroll: true});
    const rect = event.currentTarget.getBoundingClientRect();
    setLyricMenu({x: event.clientX || rect.left + 12, y: event.clientY || rect.top + Math.min(rect.height, 32), text});
  }, [active, browse]);
  const closeLyricMenu = useCallback(() => {menuOpen.current = false; setLyricMenu(null); scheduleResume();}, [scheduleResume]);
  const copyLyrics = useCallback(async (text: string) => {
    const request = ++copyVersion.current;
    window.clearTimeout(noticeTimer.current);
    let message: string;
    try {
      if (window.desktop?.copyText) await window.desktop.copyText(text);
      else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else throw new Error('当前环境无法访问剪贴板。');
      message = '已复制歌词';
    } catch (error) {message = error instanceof Error ? error.message : '复制失败，请重试。';}
    if (request !== copyVersion.current) return;
    setCopyNotice(message);
    noticeTimer.current = window.setTimeout(() => setCopyNotice(''), 3000);
  }, []);
  useEffect(() => {
    if (tab !== 'info' || !track || track.source === 'local') return;
    let disposed = false;
    setSongInfo({key: infoKey, loading: true});
    void fetchSongDetails(track, baseUrl).then(
      data => {if (!disposed) setSongInfo({key: infoKey, data, loading: false});},
      error => {if (!disposed) setSongInfo({key: infoKey, loading: false, error: error instanceof Error ? error.message : '暂时无法加载歌曲信息，请稍后重试。'});},
    );
    return () => {disposed = true;};
  }, [tab, infoKey, infoAttempt]);
  useEffect(() => {
    if (!playing || !getPosition || tab !== 'lyrics' || !lyrics.length) return;
    let frame = 0;
    const tick = () => {
      // Read the media clock instead of extrapolating time while audio buffers.
      const seconds = getPosition();
      if (Number.isFinite(seconds)) setClock(previous => previous.key === track?.key && previous.position === seconds ? previous : {key: track?.key, position: seconds});
      frame = window.requestAnimationFrame(tick);
    };
    tick();
    return () => window.cancelAnimationFrame(frame);
  }, [playing, getPosition, track?.key, tab, lyrics.length]);
  useEffect(() => { closeRef.current?.focus(); }, []);
  useEffect(() => {resumeFollowing(); setCoverFailed(false); copyVersion.current++; setCopyNotice(''); menuOpen.current = false; setLyricMenu(null);}, [track?.key, resumeFollowing]);
  useEffect(() => () => {copyVersion.current++; window.clearTimeout(resumeTimer.current); window.clearTimeout(noticeTimer.current);}, []);
  useEffect(() => {
    const container = scroller.current, line = lineRef.current;
    if (!following || tab !== 'lyrics' || !line || !container) return;
    const top = container.scrollTop + line.getBoundingClientRect().top - container.getBoundingClientRect().top - container.clientHeight / 2 + line.clientHeight / 2;
    container.scrollTo({top, behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
  }, [active, following, tab, fontSize, lyrics, track?.key]);

  return <section className="expanded-player" aria-label="歌曲详情与歌词" style={{'--lyric-font-family': lyricFontCss(fontFamily)} as CSSProperties}>
    <header className="expanded-header">
      <button ref={closeRef} className="detail-close" onClick={onClose} aria-label="收起歌曲详情"><ChevronDown size={21} /><span>正在播放</span></button>
      <span className="detail-state">{playing ? '音乐正在流动' : track ? '等待继续播放' : '选择一首喜欢的音乐'}</span>
    </header>
    <div className="expanded-body">
      <div className="expanded-track">
        <div className={`expanded-cover ${playing ? 'playing' : ''}`}>
          {track?.coverUrl && !coverFailed ? <img src={track.coverUrl} alt={`${track.title} 封面`} onError={() => setCoverFailed(true)}/> : <><div className="detail-record"/><Disc3 size={100} strokeWidth={1}/><span>XMUSIC</span></>}
        </div>
        <h1>{track?.title || '还没有正在播放的音乐'}</h1>
        <p className="expanded-artist">{track?.artist || '让旋律陪伴此刻'}</p>
        {track?.album && <p className="expanded-album">专辑 · {track.album}</p>}
        <div className="detail-track-actions"><button onClick={onFavorite} disabled={!track} aria-pressed={favorite}><Heart size={18} fill={favorite ? 'currentColor' : 'none'}/>{favorite ? '已喜欢' : '喜欢这首歌'}</button><span>{track?.source === 'local' ? '本地音乐' : track ? '在线音乐' : 'Xmusic'}</span></div>
      </div>
      <div className="expanded-content">
        <div className="detail-tabs" role="tablist" aria-label="播放详情内容">
          <button role="tab" id="lyrics-tab" aria-controls="detail-lyrics" aria-selected={tab === 'lyrics'} onClick={() => setTab('lyrics')}>歌词</button>
          <button role="tab" id="info-tab" aria-controls="detail-info" aria-selected={tab === 'info'} onClick={() => setTab('info')}>歌曲详情</button>
          {tab === 'lyrics' && <div className="lyric-size-control"><button aria-label="缩小歌词字号" disabled={fontSize <= 18} onClick={() => setFontSize(size => Math.max(18, size - 2))}><Minus size={15}/></button><span aria-label="歌词字号">{fontSize}</span><button aria-label="放大歌词字号" disabled={fontSize >= 40} onClick={() => setFontSize(size => Math.min(40, size + 2))}><Plus size={15}/></button><button aria-label="重置歌词字号" onClick={() => setFontSize(26)}><RotateCcw size={14}/></button></div>}
        </div>
        {tab === 'lyrics' ? <div className="detail-lyrics-area" id="detail-lyrics" role="tabpanel" aria-labelledby="lyrics-tab">
          <div className="detail-lyrics-scroll" ref={scroller} tabIndex={0} aria-label="完整歌词" onWheel={() => browse()} onTouchStart={() => browse()} onPointerDown={event => {if (event.target === event.currentTarget) browse();}} onKeyDown={event => {if (['ArrowDown','ArrowUp','PageDown','PageUp','Home','End'].includes(event.key)) browse();}} onScroll={event => {
            if (followingRef.current) return;
            const container = event.currentTarget;
            const center = container.getBoundingClientRect().top + container.clientHeight * .4;
            let nearest = active, distance = Infinity;
            container.querySelectorAll<HTMLElement>('[data-lyric-index]').forEach(row => {
              const rect = row.getBoundingClientRect();
              const delta = Math.abs(rect.top + rect.height / 2 - center);
              if (delta < distance) {nearest = Number(row.dataset.lyricIndex); distance = delta;}
            });
            setBrowseIndex(nearest); scheduleResume();
          }} style={{'--lyric-size': `${fontSize}px`} as React.CSSProperties}>
            {lyrics.length ? <div className="detail-lyric-lines">{lyrics.map((line, index) => <LyricRow key={`${index}-${line.time}`} line={line} index={index} active={index === active} position={index === active ? lyricPosition : 0} lineRef={index === active ? lineRef : undefined} onSeek={seekLine} showTime={!following && index === browseIndex} onBrowse={browseFocusedLine} onContextMenu={openLyricMenu}/>)}</div> : <div className="detail-lyric-empty"><p tabIndex={rawLyric ? 0 : undefined} onContextMenu={event => {if (rawLyric) openLyricMenu(event, rawLyric);}}>{rawLyric || lyricStatus}</p>{track?.source === 'local' && !rawLyric && <small>把同名 .lrc 歌词放在音频文件旁即可显示。</small>}</div>}
          </div>
          {!following && lyrics.length > 0 && <button className="follow-lyric" onClick={resumeFollowing}><RotateCcw size={14}/>回到当前歌词</button>}
          {copyNotice && <p className="lyric-copy-notice" role="status">{copyNotice}</p>}
        </div> : <div className="detail-song-info" id="detail-info" role="tabpanel" aria-labelledby="info-tab">
          <h2>{detail?.title || '歌曲信息'}</h2>
          {infoLoading && <p className="detail-info-status" role="status">正在加载歌曲信息…</p>}
          {visibleInfo?.error && track?.source === 'online' && <div className="detail-info-error" role="alert"><p>{visibleInfo.error}</p><button type="button" onClick={() => setInfoAttempt(value => value + 1)}>重新加载</button></div>}
          <SongInfoCard title="基础信息" rows={[
            {label: '歌曲名', value: infoValue(detail?.title)},
            {label: '歌手', value: infoValue(detail?.artist)},
            {label: '语种', value: infoValue(detail?.language)},
            {label: '流派', value: infoValue(detail?.genre)},
            {label: '专辑', value: infoValue(detail?.album)},
            {label: '专辑发行时间', value: infoValue(detail?.releaseDate)},
          ]}/>
          <SongInfoCard title="更多信息" rows={[
            {label: '时长', value: Number.isFinite(detailDuration) && detailDuration > 0 ? formatTime(detailDuration) : '未提供'},
            {label: '唱片公司', value: infoValue(detail?.recordLabel)},
            {label: '来源', value: track?.source === 'local' ? '本地文件' : track ? '在线播放' : '未提供'},
          ]}/>
          {typeof detail?.introduction === 'string' && detail.introduction.trim() && <section className="detail-info-card" aria-label="简介"><h3>简介</h3><p className="detail-info-introduction">{detail.introduction}</p></section>}
        </div>}
      </div>
    </div>
    {lyricMenu && <ContextMenu position={lyricMenu} ariaLabel="歌词操作" onClose={closeLyricMenu} items={[
      {id: 'copy-line', label: '复制这句歌词', icon: <Copy/>, disabled: !lyricMenu.text.trim(), onSelect: () => void copyLyrics(lyricMenu.text)},
      {id: 'copy-all', label: '复制全部歌词', icon: <Copy/>, disabled: !lyrics.length && !rawLyric.trim(), onSelect: () => void copyLyrics(lyrics.length ? lyrics.map(line => line.text).join('\n') : rawLyric)},
    ]}/>}
  </section>;
}
