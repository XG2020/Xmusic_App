'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {DesktopPreferencesController, syncDesktopShortcuts, SHORTCUTS} = require('./desktop-preferences.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xmusic-preferences-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return path.join(directory, 'preferences.json');
}

test('preferences persist partial updates across restart and publish only committed changes', t => {
  const preferencesPath = fixture(t), changes = [];
  const preferences = new DesktopPreferencesController({preferencesPath, notify: value => changes.push(value)});
  assert.deepEqual(preferences.snapshot(), {closeAction: 'ask', shortcutsEnabled: true});
  preferences.update({closeAction: 'hide'});
  preferences.update({shortcutsEnabled: false});
  preferences.update({closeAction: 'hide'});
  assert.deepEqual(changes, [{closeAction: 'hide', shortcutsEnabled: true}, {closeAction: 'hide', shortcutsEnabled: false}]);
  assert.deepEqual(JSON.parse(fs.readFileSync(preferencesPath, 'utf8')), {closeAction: 'hide', shortcutsEnabled: false});
  const restored = new DesktopPreferencesController({preferencesPath});
  const snapshot = restored.snapshot();
  snapshot.closeAction = 'quit';
  assert.deepEqual(restored.snapshot(), {closeAction: 'hide', shortcutsEnabled: false});
  restored.update({closeAction: 'ask'});
  assert.deepEqual(new DesktopPreferencesController({preferencesPath}).snapshot(), {closeAction: 'ask', shortcutsEnabled: false});
});

test('malformed preferences use interactive defaults and invalid IPC patches cannot change them', t => {
  const preferencesPath = fixture(t);
  for (const serialized of ['{broken', 'null', '[]', '{"closeAction":"shutdown","shortcutsEnabled":"false"}']) {
    fs.writeFileSync(preferencesPath, serialized);
    const preferences = new DesktopPreferencesController({preferencesPath});
    assert.deepEqual(preferences.snapshot(), {closeAction: 'ask', shortcutsEnabled: true});
    for (const patch of [null, [], {closeAction: ''}, {closeAction: 'cancel'}, {shortcutsEnabled: 0}, {shortcutsEnabled: undefined}, {unknown: true}, JSON.parse('{"__proto__":{}}')]) {
      assert.throws(() => preferences.update(patch), /设置无效/);
      assert.deepEqual(preferences.snapshot(), {closeAction: 'ask', shortcutsEnabled: true});
    }
  }
  fs.writeFileSync(preferencesPath, '{"shortcutsEnabled":false}');
  assert.deepEqual(new DesktopPreferencesController({preferencesPath}).snapshot(), {closeAction: 'ask', shortcutsEnabled: false});
});

test('failed persistence leaves the existing preference and observers unchanged', t => {
  const preferencesPath = path.join(path.dirname(fixture(t)), 'missing-directory', 'preferences.json');
  let notified = false;
  const preferences = new DesktopPreferencesController({preferencesPath, notify: () => {notified = true;}});
  assert.throws(() => preferences.update({closeAction: 'quit'}), /设置保存失败/);
  assert.deepEqual(preferences.snapshot(), {closeAction: 'ask', shortcutsEnabled: true});
  assert.equal(notified, false);
});

test('shortcut preference unregisters both global lyrics keys and can enable them again without duplicates', () => {
  const callbacks = new Map([['MediaPlayPause', () => {}]]), commands = [];
  let registrations = 0;
  const globalShortcut = {
    isRegistered: key => callbacks.has(key),
    register(key, callback) {registrations++; callbacks.set(key, callback); return true;},
    unregister: key => callbacks.delete(key),
  };
  const actions = {toggleLyrics: () => commands.push('toggle'), unlockLyrics: () => commands.push('unlock')};
  syncDesktopShortcuts(globalShortcut, false, actions);
  assert.equal(registrations, 0);
  syncDesktopShortcuts(globalShortcut, true, actions);
  syncDesktopShortcuts(globalShortcut, true, actions);
  assert.equal(registrations, 2);
  callbacks.get(SHORTCUTS.toggleLyrics)(); callbacks.get(SHORTCUTS.unlockLyrics)();
  assert.deepEqual(commands, ['toggle', 'unlock']);
  syncDesktopShortcuts(globalShortcut, false, actions);
  assert.equal(callbacks.has(SHORTCUTS.toggleLyrics), false);
  assert.equal(callbacks.has(SHORTCUTS.unlockLyrics), false);
  assert.equal(callbacks.has('MediaPlayPause'), true);
  syncDesktopShortcuts(globalShortcut, true, actions);
  assert.equal(registrations, 4);
  assert.throws(() => syncDesktopShortcuts(globalShortcut, 'true', actions), /快捷键状态无效/);
});

test('an unavailable global accelerator does not crash or prevent registering the other lyrics shortcut', () => {
  const registered = [];
  const globalShortcut = {
    isRegistered: () => false,
    register(key) {if (key === SHORTCUTS.toggleLyrics) throw new Error('OS shortcut unavailable'); registered.push(key); return true;},
    unregister() {},
  };
  assert.equal(syncDesktopShortcuts(globalShortcut, true, {toggleLyrics() {}, unlockLyrics() {}}), false);
  assert.deepEqual(registered, [SHORTCUTS.unlockLyrics]);
  globalShortcut.register = () => false;
  assert.equal(syncDesktopShortcuts(globalShortcut, true, {}), false);
});
