import {useEffect, useState} from 'react';
import {SettingsSelect} from './SettingsSelect';

export const isLyricFont = (value: unknown): value is string => typeof value === 'string' && (value === '' || /^[\p{L}\p{N}\p{M} ._+\-]{1,80}$/u.test(value));
export const lyricFontCss = (name = '') => name && isLyricFont(name) ? `${JSON.stringify(name)}, "Microsoft YaHei UI", sans-serif` : '"Segoe UI", "Microsoft YaHei UI", sans-serif';
const fonts = ['', 'Microsoft YaHei UI', 'Microsoft YaHei', 'SimSun', 'KaiTi', 'SimHei', 'Segoe UI'];
const labels = ['默认字体', '微软雅黑 UI', '微软雅黑', '宋体', '楷体', '黑体', 'Segoe UI'];

export function LyricFontSettings({value, onChange}: {value: string; onChange(value: string): void}) {
  const [custom, setCustom] = useState(!!value && !fonts.includes(value));
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState('');
  useEffect(() => setDraft(value), [value]);
  return <div className="lyric-font-setting">
    <label className="setting-row"><span>歌词字体<small>同时应用于展开歌词页和桌面歌词。</small></span>
      <SettingsSelect label="歌词字体" value={custom ? 'custom' : value} onChange={next => {
        setError(''); setCustom(next === 'custom');
        if (next !== 'custom') onChange(next);
      }} options={[...fonts.map((font, index) => ({value: font, label: labels[index]})), {value: 'custom', label: '自定义字体名称…'}]}/>
    </label>
    {custom && <div className="lyric-font-custom">
      <input aria-label="自定义歌词字体名称" value={draft} maxLength={80} placeholder="输入已安装的字体名称" onChange={event => setDraft(event.target.value)}/>
      <button type="button" className="secondary-button" onClick={() => {
        const name = draft.trim();
        if (!name || !isLyricFont(name)) {setError('请输入有效的字体名称，可使用中文、英文和数字。'); return;}
        setError(''); onChange(name);
      }}>应用字体</button>
      <small>字体需已安装在 Windows 中；找不到时使用系统字体。</small>
      {error && <p role="alert" className="theme-field-error">{error}</p>}
    </div>}
  </div>;
}
