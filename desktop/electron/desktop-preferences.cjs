'use strict';

const fs = require('node:fs');

const DEFAULT_PREFERENCES = Object.freeze({closeAction: 'ask', shortcutsEnabled: true});
const CLOSE_ACTIONS = ['ask', 'hide', 'quit'];
const SHORTCUTS = Object.freeze({toggleLyrics: 'CommandOrControl+Alt+L', unlockLyrics: 'CommandOrControl+Alt+U'});

class DesktopPreferencesController {
  constructor({preferencesPath, notify = () => {}} = {}) {
    this.preferencesPath = preferencesPath;
    this.notify = notify;
    this.value = {...DEFAULT_PREFERENCES};
    try {
      const saved = JSON.parse(fs.readFileSync(preferencesPath, 'utf8'));
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        if (CLOSE_ACTIONS.includes(saved.closeAction)) this.value.closeAction = saved.closeAction;
        if (typeof saved.shortcutsEnabled === 'boolean') this.value.shortcutsEnabled = saved.shortcutsEnabled;
      }
    } catch { /* Missing or invalid preferences start with the normal interactive defaults. */ }
  }

  snapshot() {return {...this.value};}

  update(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
        Object.keys(patch).some(key => !Object.hasOwn(DEFAULT_PREFERENCES, key)) ||
        Object.hasOwn(patch, 'closeAction') && !CLOSE_ACTIONS.includes(patch.closeAction) ||
        Object.hasOwn(patch, 'shortcutsEnabled') && typeof patch.shortcutsEnabled !== 'boolean') {
      throw new Error('软件行为设置无效');
    }
    const next = {...this.value, ...patch};
    if (next.closeAction === this.value.closeAction && next.shortcutsEnabled === this.value.shortcutsEnabled) return this.snapshot();
    if (this.preferencesPath) {
      const temporary = `${this.preferencesPath}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify(next), 'utf8');
        fs.renameSync(temporary, this.preferencesPath);
      } catch {
        throw new Error('设置保存失败，请检查文件权限后重试。');
      }
    }
    this.value = next;
    // Persistence succeeds independently of a renderer closing or reloading during notification.
    try {this.notify(this.snapshot());} catch { /* A later getPreferences reads the saved value. */ }
    return this.snapshot();
  }
}

/** Synchronize only Xmusic's shortcuts; unrelated application bindings remain intact. */
function syncDesktopShortcuts(globalShortcut, enabled, actions) {
  if (typeof enabled !== 'boolean') throw new Error('快捷键状态无效');
  let available = true;
  for (const [action, accelerator] of Object.entries(SHORTCUTS)) {
    try {
      if (!enabled) globalShortcut.unregister(accelerator);
      else if (!globalShortcut.isRegistered(accelerator) && !globalShortcut.register(accelerator, actions[action])) available = false;
    } catch {available = false; /* One unavailable native shortcut must not prevent saving preferences. */ }
  }
  return available;
}

module.exports = {DesktopPreferencesController, DEFAULT_PREFERENCES, syncDesktopShortcuts, SHORTCUTS};
