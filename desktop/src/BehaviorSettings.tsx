import {useId} from 'react';
import {Keyboard, Power} from 'lucide-react';
import type {DesktopPreferences} from './types';
import type {DesktopPreferencesState} from './useDesktopPreferences';
import {ToggleSwitch} from './ToggleSwitch';
import {SettingsSelect} from './SettingsSelect';
import './behavior-settings.css';

export default function BehaviorSettings({settings}: {settings: DesktopPreferencesState}) {
  const actionId = useId();
  const shortcutId = useId();
  const disabled = settings.loading || settings.pending;
  return <section className="settings-card behavior-settings" aria-labelledby={`${actionId}-title`}>
    <h2 id={`${actionId}-title`}>软件行为</h2>
    <div className="behavior-setting-row">
      <Power size={19} aria-hidden="true"/>
      <label htmlFor={actionId}><strong>关闭主窗口时</strong><small>可随时修改已记住的关闭方式。</small></label>
      <SettingsSelect id={actionId} label="关闭主窗口时" value={settings.preferences.closeAction} disabled={disabled}
        onChange={value => void settings.update({closeAction: value as DesktopPreferences['closeAction']})}
        options={[{value: 'ask', label: '每次询问'}, {value: 'hide', label: '隐藏到托盘'}, {value: 'quit', label: '退出软件'}]}/>
    </div>
    <div className="behavior-setting-row">
      <Keyboard size={19} aria-hidden="true"/>
      <label htmlFor={shortcutId}><strong>启用快捷键</strong><small id={`${shortcutId}-help`}>控制播放器快捷键和桌面歌词全局快捷键。</small></label>
      <ToggleSwitch id={shortcutId} label="启用快捷键" describedBy={`${shortcutId}-help`} checked={settings.preferences.shortcutsEnabled}
        disabled={disabled} onCheckedChange={shortcutsEnabled => void settings.update({shortcutsEnabled})}/>
    </div>
    {settings.error && <p className="behavior-settings-error" role="alert">{settings.error}</p>}
  </section>;
}
