import {useEffect, useId, useRef, useState, type FormEvent} from 'react';
import {Check, Timer, X} from 'lucide-react';
import {playbackRates} from './usePlayer';
import {useSleepTimer} from './useSleepTimer';
import type {Quality} from './types';
import './playback-settings.css';

const qualities: {value: Quality; label: string; detail: string}[] = [
  {value: '128', label: '标准音质', detail: '128 kbps'},
  {value: '320', label: '高清音质', detail: '320 kbps · 默认'},
  {value: 'flac', label: '无损音质', detail: 'FLAC'},
];

function countdown(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const tail = String(seconds % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${tail}` : `${minutes}:${tail}`;
}

interface PlaybackSettingsProps {
  quality: Quality;
  onQualityChange: (value: Quality) => void;
  playbackRate: number;
  onPlaybackRateChange: (value: number) => void;
  local: boolean;
  pause: () => void;
}

export function PlaybackSettings({quality, onQualityChange, playbackRate, onPlaybackRateChange, local, pause}: PlaybackSettingsProps) {
  const [panel, setPanel] = useState<'quality' | 'speed' | 'sleep' | null>(null);
  const [minutes, setMinutes] = useState('30');
  const [validation, setValidation] = useState('');
  const [expired, setExpired] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();
  const sleep = useSleepTimer(() => { pause(); setExpired(true); });
  const activeTimer = sleep.deadline !== null;
  const remaining = countdown(sleep.remainingSeconds);

  useEffect(() => {
    if (!panel) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setPanel(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setPanel(null);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, [panel]);

  function toggle(next: typeof panel, button: HTMLButtonElement) {
    trigger.current = button;
    setPanel(value => value === next ? null : next);
  }

  function startTimer(value: number) {
    if (!sleep.start(value)) { setValidation('请输入 1–1440 之间的整数分钟。'); return; }
    setExpired(false);
    setValidation('');
  }

  function customTimer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTimer(Number(minutes));
  }

  return <div className="playback-settings" ref={root}>
    <button type="button" className={`playback-setting-trigger quality-trigger ${panel === 'quality' ? 'selected' : ''}`}
      title="选择音质" aria-label="选择音质" aria-expanded={panel === 'quality'} aria-controls={panel === 'quality' ? panelId : undefined}
      onClick={event => toggle('quality', event.currentTarget)}>
      {local ? 'LOCAL' : quality === 'flac' ? 'FLAC' : `${quality}K`}
    </button>
    <button type="button" className={`playback-setting-trigger speed-trigger ${playbackRate !== 1 || panel === 'speed' ? 'selected' : ''}`}
      title="播放速度" aria-label={`播放速度，当前 ${playbackRate} 倍`} aria-expanded={panel === 'speed'} aria-controls={panel === 'speed' ? panelId : undefined}
      onClick={event => toggle('speed', event.currentTarget)}>{playbackRate}×</button>
    <button type="button" className={`playback-setting-trigger sleep-trigger ${activeTimer || panel === 'sleep' ? 'selected' : ''}`}
      title={activeTimer ? `睡眠定时，${remaining} 后暂停` : '睡眠定时'} aria-label={activeTimer ? `睡眠定时，剩余 ${remaining}` : '睡眠定时'}
      aria-expanded={panel === 'sleep'} aria-controls={panel === 'sleep' ? panelId : undefined}
      onClick={event => toggle('sleep', event.currentTarget)}>
      <Timer size={16} />{activeTimer && <span>{remaining}</span>}
    </button>

    {panel && <section id={panelId} className="playback-settings-panel" role="dialog" aria-label={panel === 'quality' ? '选择音质' : panel === 'speed' ? '播放速度' : '睡眠定时'}>
      <header><strong>{panel === 'quality' ? '选择音质' : panel === 'speed' ? '播放速度' : '睡眠定时'}</strong>
        <button type="button" className="settings-panel-close" aria-label="关闭播放设置" onClick={() => { setPanel(null); trigger.current?.focus(); }}><X size={16} /></button>
      </header>
      {panel === 'quality' && <>
        <div className="quality-options" role="group" aria-label="在线播放首选音质">
          {qualities.map(item => <button type="button" key={item.value} aria-pressed={quality === item.value}
            onClick={() => { onQualityChange(item.value); setPanel(null); trigger.current?.focus(); }}>
            <span>{item.label}<small>{item.detail}</small></span>{quality === item.value && <Check size={16} />}
          </button>)}
        </div>
        <p>{local ? '本地音乐使用文件原始音质。此选项用于在线播放和下载。' : '切换后重新载入当前歌曲并保留播放进度。音源不可用时可能自动降级。'}</p>
      </>}
      {panel === 'speed' && <>
        <div className="speed-options" role="group" aria-label="播放倍速">
          {playbackRates.map(rate => <button type="button" key={rate} aria-pressed={rate === playbackRate}
            onClick={() => { onPlaybackRateChange(rate); setPanel(null); trigger.current?.focus(); }}>{rate}×</button>)}
        </div>
        <p>改变播放速度并保持原音高，设置会自动保存。</p>
      </>}
      {panel === 'sleep' && <>
        <div className={`sleep-timer-status ${activeTimer ? 'active' : ''}`}>
          <Timer size={19} />
          <div><strong>{activeTimer ? remaining : expired ? '已暂停播放' : '倒计时后暂停播放'}</strong>
            <span>{activeTimer ? '后自动暂停' : expired ? '睡眠定时已结束' : '选择时长，安心入睡'}</span></div>
        </div>
        <div className="sleep-presets" role="group" aria-label="睡眠定时时长">
          {[15, 30, 60, 90].map(value => <button type="button" key={value} onClick={() => startTimer(value)}>{value} 分钟</button>)}
        </div>
        <form className="sleep-custom" onSubmit={customTimer} noValidate>
          <label htmlFor={`${panelId}-minutes`}>自定义分钟</label>
          <div><input id={`${panelId}-minutes`} type="number" inputMode="numeric" min={1} max={1440} step={1} value={minutes}
            aria-describedby={validation ? `${panelId}-error` : undefined} aria-invalid={Boolean(validation)}
            onChange={event => { setMinutes(event.target.value); setValidation(''); }} />
          <button type="submit">{activeTimer ? '重新计时' : '开始计时'}</button></div>
        </form>
        {validation && <p id={`${panelId}-error`} className="sleep-validation" role="alert">{validation}</p>}
        {activeTimer && <button type="button" className="sleep-cancel" onClick={() => { sleep.cancel(); setExpired(false); setValidation(''); }}>取消定时</button>}
      </>}
    </section>}
    <span className="playback-settings-announcement" role="status">{expired ? '睡眠定时已结束，播放已暂停。' : ''}</span>
  </div>;
}
