import {useEffect, useId, useRef, useState, type CSSProperties} from 'react';
import {Check, ImagePlus, Monitor, Moon, Music2, Palette, Play, RotateCcw, Sun, Trash2} from 'lucide-react';
import {ACCENT_PRESETS, DEFAULT_BACKGROUNDS, normalizeHex, textOnColor, type ThemeController, type ThemeMode} from './theme';
import {ToggleSwitch} from './ToggleSwitch';
import './ThemeSettings.css';

function ColorField({label, value, onChange, disabled = false}: {label: string; value: string; onChange: (color: string) => void; disabled?: boolean}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState('');
  const id = useId();
  useEffect(() => { setDraft(value); setError(''); }, [value]);
  const commit = () => {
    const color = normalizeHex(draft);
    if (!color) { setError('请输入 3 位或 6 位十六进制颜色，例如 #7C8CF8。'); return; }
    setDraft(color);
    setError('');
    onChange(color);
  };
  return <div className="theme-color-field">
    <label htmlFor={id}>{label}</label>
    <div className="theme-color-inputs">
      <input type="color" aria-label={`${label}取色器`} value={value} disabled={disabled} onChange={event => { setDraft(event.target.value); setError(''); onChange(event.target.value); }}/>
      <input id={id} type="text" value={draft} maxLength={7} spellCheck={false} autoComplete="off" disabled={disabled} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} onChange={event => { setDraft(event.target.value); setError(''); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }}/>
      <button type="button" className="secondary-button" disabled={disabled} onClick={commit}>应用</button>
    </div>
    {error && <p className="theme-field-error" id={`${id}-error`} role="alert">{error}</p>}
  </div>;
}

const modes: {value: ThemeMode; label: string; Icon: typeof Sun}[] = [
  {value: 'light', label: '浅色', Icon: Sun},
  {value: 'dark', label: '深色', Icon: Moon},
  {value: 'system', label: '跟随系统', Icon: Monitor},
];

export function ThemeSettings({theme}: {theme: ThemeController}) {
  const modeName = useId();
  const imageInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  return <section className="settings-card theme-settings" aria-labelledby={`${modeName}-heading`}>
    <div className="theme-settings-heading">
      <div className="section-heading"><Palette size={19}/><h2 id={`${modeName}-heading`}>外观与主题</h2></div>
      <button type="button" className="text-button" disabled={importing} onClick={theme.reset}><RotateCcw size={13}/>恢复默认</button>
    </div>
    <p className="setting-help">选择喜欢的外观，让每一次播放都有自己的颜色。</p>
    <fieldset className="theme-mode-fieldset">
      <legend>外观模式</legend>
      <div className="theme-modes">
        {modes.map(({value, label, Icon}) => <label key={value} className={`theme-mode ${theme.mode === value ? 'selected' : ''}`}>
          <input type="radio" name={modeName} value={value} checked={theme.mode === value} onChange={() => theme.setMode(value)}/>
          <Icon size={19}/><span>{label}</span><Check className="theme-mode-check" size={14}/>
        </label>)}
      </div>
      <p className="setting-help">{theme.mode === 'system' ? `正在跟随系统使用${theme.resolvedMode === 'dark' ? '深色' : '浅色'}外观。` : '外观设置会在下次启动时保留。'}</p>
    </fieldset>
    <div className="theme-accent-section">
      <h3>主题色</h3>
      <div className="theme-swatches" role="group" aria-label="预设主题色">
        {ACCENT_PRESETS.map(preset => <button type="button" key={preset.color} className={`theme-swatch ${theme.accent === preset.color ? 'selected' : ''}`} style={{'--swatch': preset.color, '--swatch-text': textOnColor(preset.color)} as CSSProperties} aria-label={preset.name} aria-pressed={theme.accent === preset.color} title={preset.name} onClick={() => theme.setAccent(preset.color)}><span>{theme.accent === preset.color && <Check size={17}/>}</span><small>{preset.name}</small></button>)}
      </div>
      <ColorField label="自定义主题色" value={theme.accent} onChange={theme.setAccent}/>
      <p className="setting-help">按钮保留你选择的颜色；文字、选中状态和背景层次会自动适配，保持清晰易读。</p>
    </div>
    <div className="theme-background-section">
      <div className="theme-background-toggle"><span>自定义{theme.resolvedMode === 'dark' ? '深色' : '浅色'}背景</span><ToggleSwitch label={`自定义${theme.resolvedMode === 'dark' ? '深色' : '浅色'}背景`} checked={theme.background !== null} onCheckedChange={checked => theme.setBackground(checked ? DEFAULT_BACKGROUNDS[theme.resolvedMode] : null)}/></div>
      <p className="setting-help">深色、浅色背景分别保存，切换外观时自动使用对应底色。</p>
      {theme.background !== null && <ColorField label="背景底色" value={theme.background} onChange={theme.setBackground}/>}
    </div>
    <div className="theme-background-section theme-image-section">
      <h3>自定义{theme.resolvedMode === 'dark' ? '深色' : '浅色'}背景图片</h3>
      <p className="setting-help">深浅外观分别保存图片，并自动添加主题遮罩。</p>
      <input ref={imageInput} className="theme-image-input" type="file" accept="image/jpeg,image/png,image/webp" aria-label="选择背景图片" disabled={importing} onChange={async event => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        setImporting(true);
        try { await theme.importBackgroundImage(file, theme.resolvedMode); }
        finally { setImporting(false); }
      }}/>
      {theme.backgroundImage && <div className="theme-image-preview" style={{backgroundImage: `linear-gradient(var(--page-image-mask), var(--page-image-mask)), url("${theme.backgroundImage}")`}} aria-label="背景图片与遮罩预览"><span>听见热爱，让音乐陪伴每一刻</span></div>}
      <div className="theme-image-actions">
        <button type="button" className="secondary-button" disabled={importing} onClick={() => imageInput.current?.click()}><ImagePlus size={14}/>{importing ? '正在处理…' : theme.backgroundImage ? '更换图片' : '选择图片'}</button>
        {theme.backgroundImage && <button type="button" className="text-button" disabled={importing} onClick={() => theme.setBackgroundImage(null)}><Trash2 size={13}/>移除图片</button>}
        <span>JPG / PNG / WebP · 最大 8 MB</span>
      </div>
    </div>
    {theme.themeError && <p className="theme-field-error" role="alert">{theme.themeError}</p>}
    <div className="theme-preview" aria-label="当前主题预览">
      <div className="theme-preview-cover"><Music2 size={23}/></div>
      <div><strong>你的音乐，你的颜色</strong><span>当前主题预览 · {theme.resolvedMode === 'dark' ? '深色' : '浅色'}</span></div>
      <span className="theme-preview-play" aria-hidden="true"><Play size={18} fill="currentColor"/></span>
    </div>
  </section>;
}

export function FloatingLyricsBackgroundSettings({theme, opacity, borderRadius = 12}: {theme: ThemeController; opacity: number; borderRadius?: number}) {
  const imageInput = useRef<HTMLInputElement>(null);
  const headingId = useId();
  const [importing, setImporting] = useState(false);
  return <div className="theme-background-section theme-image-section floating-image-settings" role="group" aria-labelledby={headingId}>
    <h3 id={headingId}>悬浮歌词背景图片</h3>
    <p className="setting-help">为桌面歌词单独选择图片，切换深浅外观时也会保留。上方不透明度滑杆可即时调整背景效果。</p>
    <input ref={imageInput} className="theme-image-input" type="file" accept="image/jpeg,image/png,image/webp" aria-label="选择悬浮歌词背景图片" disabled={importing} onChange={async event => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      setImporting(true);
      try { await theme.importFloatingBackgroundImage(file); }
      finally { setImporting(false); }
    }}/>
    {theme.floatingBackgroundImage && <div className="floating-image-preview" role="img" aria-label={`悬浮歌词背景预览，不透明度 ${Math.round(opacity * 100)}%`}>
      <div className="floating-image-preview-background" aria-hidden="true" style={{backgroundImage: `linear-gradient(#0c110fa6, #0c110fa6), url("${theme.floatingBackgroundImage}")`, opacity, borderRadius}}/>
      <span>听见热爱，让音乐陪伴每一刻</span>
    </div>}
    <div className="theme-image-actions">
      <button type="button" className="secondary-button" disabled={importing} onClick={() => imageInput.current?.click()}><ImagePlus size={14}/>{importing ? '正在处理…' : theme.floatingBackgroundImage ? '更换悬浮背景' : '选择悬浮背景'}</button>
      {theme.floatingBackgroundImage && <button type="button" className="text-button" disabled={importing} onClick={() => theme.setFloatingBackgroundImage(null)}><Trash2 size={13}/>移除悬浮背景</button>}
      <span>JPG / PNG / WebP · 最大 8 MB</span>
    </div>
    {theme.floatingBackgroundError && <p className="theme-field-error" role="alert">{theme.floatingBackgroundError}</p>}
  </div>;
}
