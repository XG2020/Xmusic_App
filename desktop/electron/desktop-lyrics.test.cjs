'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { DesktopLyrics, sanitizeContent, fitBounds } = require('./desktop-lyrics.cjs');
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1kAAAAASUVORK5CYII=';

class FakeWindow extends EventEmitter {
  constructor(options) {
    super(); this.options = options; this.bounds = options; this.hidden = true; this.destroyed = false;
    this.webContents = new EventEmitter(); this.messages = [];
    this.webContents.send = (...args) => this.messages.push(args);
    this.webContents.setWindowOpenHandler = callback => { this.openHandler = callback; };
    this.webContents.isLoading = () => false;
    this.webContents.mainFrame = { url: '' };
  }
  setAlwaysOnTop() {}
  isDestroyed() { return this.destroyed; }
  getBounds() { return this.bounds; }
  setBounds(bounds) { this.bounds = bounds; }
  setMinimumSize(width, height) { this.minimum = { width, height }; }
  setIgnoreMouseEvents(value) { this.clickThrough = value; }
  setFocusable(value) { this.focusable = value; this.skipTaskbar = !value; }
  setSkipTaskbar(value) { this.skipTaskbar = value; }
  loadFile() { return Promise.resolve(); }
  showInactive() { this.hidden = false; }
  hide() { this.hidden = true; }
  destroy() { this.destroyed = true; this.emit('closed'); }
}
function setup(options = {}) {
  const events = [], commands = [];
  const screen = new EventEmitter();
  screen.getPrimaryDisplay = () => ({ workArea: { x: -1920, y: 0, width: 1920, height: 1040 } });
  screen.getDisplayMatching = () => screen.getPrimaryDisplay();
  const manager = new DesktopLyrics({ BrowserWindow: FakeWindow, screen, notify: value => events.push(value), playback: value => commands.push(value), showMain: () => commands.push('main'), ...options });
  return { manager, events, commands, screen };
}

test('floating lyrics sanitizes hostile text, colors and numeric options before IPC', () => {
  const value = sanitizeContent({ line: 'x'.repeat(4000), title: '<script>not executable</script>', accentColor: 'url(javascript:evil)', fontSize: 500, opacity: -1, playing: 'yes', singleLine: 'yes', borderRadius: 90 });
  assert.equal(value.line.length, 2000); assert.equal(value.accentColor, '#63da9d'); assert.equal(value.fontSize, 60); assert.equal(value.opacity, 0); assert.equal(value.playing, false);
  assert.equal(value.singleLine, false); assert.equal(value.borderRadius, 40);
  assert.equal(sanitizeContent({singleLine: true, borderRadius: -1}).singleLine, true);
  assert.equal(sanitizeContent({borderRadius: -1}).borderRadius, 0);
  assert.equal(sanitizeContent({borderRadius: NaN}).borderRadius, 12);
  assert.equal(sanitizeContent({}).borderRadius, 12);
  assert.equal(sanitizeContent({fontFamily: ' 思源黑体 CN '}).fontFamily, '思源黑体 CN');
  assert.equal(sanitizeContent({fontFamily: 'Segoe UI Variable'}).fontFamily, 'Segoe UI Variable');
  for (const fontFamily of ['A'.repeat(81), 'Arial; color:red', 'url(secret)', 'bad\nfont', '\"Arial\"', null]) assert.equal(sanitizeContent({fontFamily}).fontFamily, '');
  assert.throws(() => sanitizeContent(null));
});
test('floating bounds support negative-coordinate monitors and clamp oversized windows', () => {
  assert.deepEqual(fitBounds({x: 9999, y: 9999, width: 2500, height: 2000}, {x: -1280, y: 40, width: 1280, height: 720}), { x: -1280, y: 40, width: 1280, height: 720 });
});
test('floating content validates timed words, local raster images and playback clocks', () => {
  const words = [{text: '逐', start: 1, dur: 0.4}, {text: '字', start: 1.4, dur: 0.6}];
  const value = sanitizeContent({line: '逐字', words, position: 1.6, lineStart: 1, lineEnd: 2, backgroundImage: image, playbackRate: 1.25});
  assert.deepEqual(value.words, words);
  assert.equal(value.backgroundImage, image);
  assert.equal(value.position, 1.6);
  assert.equal(value.playbackRate, 1.25);
  for (const bad of ['https://example.com/image.jpg', 'data:image/svg+xml;base64,AAAA', 'data:image/png;base64,' + 'A'.repeat(850000)]) {
    assert.equal(sanitizeContent({backgroundImage: bad}).backgroundImage, null);
  }
  for (const bad of [[{text: '逐字', start: -1, dur: 1}], [{text: '逐字', start: 0, dur: Infinity}], [{text: '不同文字', start: 0, dur: 1}], [words[1], words[0]]]) {
    assert.deepEqual(sanitizeContent({line: '逐字', words: bad}).words, []);
  }
  assert.equal(sanitizeContent({position: Infinity}).position, 0);
});
test('clock patches preserve custom backgrounds and avoid resending image data', () => {
  const {manager} = setup();
  manager.update({line: '歌词', backgroundImage: image, fontSize: 34});
  manager.setVisible(true);
  assert.equal(manager.snapshot().content.backgroundImage, image);
  manager.update({position: 4.5, playing: true});
  assert.equal(manager.content.line, '歌词');
  assert.equal(manager.content.fontSize, 34);
  assert.equal(manager.content.backgroundImage, image);
  assert.equal(manager.window.messages.at(-1)[1].content.backgroundImage, undefined);
  manager.setLocked(true);
  assert.equal(manager.window.messages.at(-1)[1].content.backgroundImage, undefined);
  manager.setVisible(false); manager.setVisible(true);
  assert.equal(manager.window.messages.at(-1)[1].content.backgroundImage, undefined);
  manager.window.webContents.emit('did-finish-load');
  assert.equal(manager.window.messages.at(-1)[1].content.backgroundImage, image, 'a fresh renderer still receives the full image');
  manager.update({backgroundImage: null});
  assert.equal(manager.window.messages.at(-1)[1].content.backgroundImage, null);
  assert.equal(manager.content.position, 4.5);
  manager.dispose();
});
test('sufficient manual dimensions stay fixed when lyrics, mode, font size or font family change', () => {
  const {manager} = setup();
  manager.setVisible(true);
  assert.equal(manager.window.options.resizable, true);
  assert.equal(manager.bounds.height, 144);
  assert.deepEqual(manager.window.minimum, {width: 240, height: 89});
  const manual = {...manager.bounds, y: 400, width: 710, height: 190};
  manager.window.setBounds(manual); manager.window.emit('resize');
  for (const update of [{fontSize: 60}, {singleLine: true, nextLine: '下一句'}, {fontFamily: '思源黑体 CN'}, {fontSize: 18, singleLine: false}, {line: '更长的歌词不会改变窗口大小'}]) {
    manager.update(update);
    assert.deepEqual(manager.window.getBounds(), manual);
  }
  for (let count = 0; count < 10; count++) {manager.setVisible(false); manager.setVisible(true);}
  assert.deepEqual(manager.window.getBounds(), manual);
  manager.dispose();
});

test('invalid and stale renderer reports cannot change window geometry', () => {
  const {manager} = setup(); manager.setVisible(true);
  const bounds = {...manager.bounds};
  const messages = manager.window.messages.length;
  for (const report of [null, {}, {width: 999999, height: 999999, layoutId: 1}, {width: NaN, height: 51, layoutId: manager.layoutId}, {width: 900, height: 140, layoutId: manager.layoutId + 1}]) {
    manager.resizeToContent(report);
    assert.deepEqual(manager.window.getBounds(), bounds);
  }
  assert.deepEqual(manager.window.getBounds(), bounds);
  assert.equal(manager.window.messages.length, messages);
  manager.dispose();
});

test('long sentences expand around the manual center and short sentences restore the saved backdrop', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xmusic-lyrics-expansion-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const preferencesPath = path.join(directory, 'desktop-lyrics.json');
  const {manager} = setup({preferencesPath}); manager.setVisible(true);
  const manual = {x: -1500, y: 400, width: 560, height: 144};
  manager.window.setBounds(manual); manager.window.emit('resize');
  manager.update({line: '这一句歌词需要更宽的背景', nextLine: '下一句'});
  manager.resizeToContent({layoutId: manager.layoutId, width: 900, height: 118});
  assert.deepEqual(manager.window.getBounds(), {...manual, x: -1670, width: 900});
  assert.deepEqual(manager.bounds, manual);
  assert.deepEqual(manager.window.minimum, {width: 900, height: 118});
  manager.update({line: '短句', nextLine: ''});
  manager.resizeToContent({layoutId: manager.layoutId, width: 100, height: 89});
  assert.deepEqual(manager.window.getBounds(), manual);
  manager.update({line: '长句'});
  manager.resizeToContent({layoutId: manager.layoutId, width: 1100, height: 89});
  manager.dispose();
  assert.deepEqual(JSON.parse(fs.readFileSync(preferencesPath, 'utf8')).bounds, manual);
  const restored = setup({preferencesPath}).manager; restored.setVisible(true);
  assert.deepEqual(restored.window.getBounds(), manual);
  restored.dispose();
});

test('font changes establish a readable minimum height without overwriting the manual height', () => {
  const {manager} = setup(); manager.setVisible(true);
  const manual = {...manager.bounds, y: 300, height: 100};
  manager.window.setBounds(manual); manager.window.emit('resize');
  manager.update({fontSize: 60, nextLine: '下一句'});
  assert.equal(manager.window.minimum.height, 182);
  assert.equal(manager.window.getBounds().height, 182);
  assert.equal(manager.bounds.height, 100);
  manager.update({singleLine: true});
  assert.equal(manager.window.getBounds().height, 128);
  manager.update({fontSize: 18});
  assert.deepEqual(manager.window.getBounds(), manual);
  manager.dispose();
});

test('moving an expanded backdrop preserves its baseline while manual resizing chooses a new baseline', () => {
  const {manager} = setup(); manager.setVisible(true);
  manager.window.setBounds({x: -1500, y: 300, width: 560, height: 144}); manager.window.emit('resize');
  manager.resizeToContent({layoutId: manager.layoutId, width: 900, height: 118});
  manager.window.setBounds({...manager.window.getBounds(), x: -1570}); manager.window.emit('move');
  assert.equal(manager.bounds.width, 560); assert.equal(manager.bounds.x, -1400);
  manager.window.emit('will-resize');
  manager.window.setBounds({...manager.window.getBounds(), width: 1000}); manager.window.emit('resized');
  assert.equal(manager.bounds.width, 1000); assert.equal(manager.bounds.x, -1570);
  manager.resizeToContent({layoutId: manager.layoutId, width: 100, height: 89});
  assert.deepEqual(manager.window.getBounds(), manager.bounds);
  assert.equal(manager.window.getBounds().width, 1000);
  manager.dispose();
});

test('moving a backdrop expanded against a display edge follows the pointer without snapping back', () => {
  const {manager, screen} = setup();
  screen.getPrimaryDisplay = screen.getDisplayMatching = () => ({id: 1, workArea: {x: 0, y: 0, width: 1920, height: 1040}});
  manager.setVisible(true);
  manager.window.setBounds({x: 100, y: 890, width: 560, height: 144}); manager.window.emit('resize');
  manager.resizeToContent({layoutId: manager.layoutId, width: 900, height: 240});
  assert.deepEqual(manager.window.getBounds(), {x: 0, y: 800, width: 900, height: 240});
  manager.window.setBounds({...manager.window.getBounds(), x: 100, y: 700}); manager.window.emit('move');
  assert.deepEqual(manager.window.getBounds(), {x: 100, y: 700, width: 900, height: 240});
  assert.deepEqual(manager.bounds, {x: 270, y: 700, width: 560, height: 144});
  manager.resizeToContent({layoutId: manager.layoutId, width: 100, height: 89});
  assert.deepEqual(manager.window.getBounds(), {x: 270, y: 700, width: 560, height: 144});
  manager.dispose();
});

test('auto expansion respects display bounds and sends new wrapping width after a display change', () => {
  const {manager, screen} = setup(); manager.setVisible(true);
  const manual = {...manager.bounds};
  manager.resizeToContent({layoutId: manager.layoutId, width: 10000, height: 230});
  assert.equal(manager.window.getBounds().width, 1920);
  assert.equal(manager.bounds.width, manual.width);
  screen.getDisplayMatching = () => ({id: 2, workArea: {x: 0, y: 0, width: 800, height: 600}});
  screen.emit('display-removed');
  assert.equal(manager.window.getBounds().width, 800);
  assert.equal(manager.window.getBounds().x, 0);
  assert.equal(manager.snapshot().availableWidth, 800);
  assert.equal(manager.window.messages.at(-1)[1].availableWidth, 800);
  assert.equal(manager.bounds.width, manual.width);
  manager.resizeToContent({layoutId: manager.layoutId, width: 10000, height: 900});
  assert.equal(manager.window.getBounds().height, 600);
  assert.equal(manager.bounds.height, manual.height);
  manager.dispose();
});

test('manual bounds clamp only to minimums and the available display work area', () => {
  assert.deepEqual(fitBounds({x: -100, y: -100, width: 1400, height: 700}, {x: 0, y: 0, width: 1920, height: 1040}), {x: 0, y: 0, width: 1400, height: 700});
  assert.deepEqual(fitBounds({x: 0, y: 0, width: 10, height: 10}, {x: 0, y: 0, width: 1920, height: 1040}), {x: 0, y: 0, width: 240, height: 80});
  const {manager, screen} = setup(); manager.setVisible(true);
  screen.getDisplayMatching = () => ({id: 2, workArea: {x: 0, y: 0, width: 180, height: 60}});
  screen.emit('display-removed');
  assert.deepEqual(manager.bounds, {x: 0, y: 0, width: 180, height: 60});
  manager.dispose();
});

test('fractional DPI readback never accumulates over manual resizes, font changes or restart', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xmusic-lyrics-manual-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const preferencesPath = path.join(directory, 'desktop-lyrics.json');
  class RoundedWindow extends FakeWindow {
    constructor(options) {super(options); this.bounds = {...options, width: options.width + 8, height: options.height + 5}; this.boundsWrites = 0;}
    setBounds(bounds) {this.boundsWrites++; this.bounds = {...bounds, width: bounds.width + 2, height: bounds.height + 3}; this.emit('resize');}
  }
  const makeManager = () => setup({BrowserWindow: RoundedWindow, preferencesPath}).manager;
  let manager = makeManager(); manager.setVisible(true);
  manager.window.emit('will-resize');
  manager.window.setBounds({...manager.bounds, y: 400, width: 710, height: 190});
  manager.window.emit('resized');
  const native = {...manager.window.getBounds()};
  assert.equal(manager.bounds.width, 710); assert.equal(manager.bounds.height, 190);
  const writes = manager.window.boundsWrites;
  for (let count = 0; count < 20; count++) {
    manager.setVisible(false); manager.setVisible(true);
    manager.update({fontSize: 60}); manager.update({fontSize: 18, fontFamily: 'Segoe UI'});
  }
  assert.deepEqual(manager.window.getBounds(), native);
  assert.equal(manager.window.boundsWrites, writes);
  manager.dispose();
  const saved = JSON.parse(fs.readFileSync(preferencesPath, 'utf8'));
  assert.equal(saved.version, 5); assert.equal(saved.bounds.width, 710); assert.equal(saved.bounds.height, 190);
  manager = makeManager(); manager.setVisible(true);
  assert.deepEqual(manager.window.getBounds(), native);
  manager.dispose();
});

test('DPI notifications preserve manual DIP targets while subsequent real resizing remains effective', () => {
  for (const firstEvent of ['metrics', 'resize']) {
    const display = {id: 1, scaleFactor: 1.25, workArea: {x: 0, y: 0, width: 1920, height: 1040}};
    class DpiWindow extends FakeWindow {
      constructor(options) {super(options); this.setBounds(options);}
      setBounds(bounds) {const offset = display.scaleFactor === 1.25 ? 3 : 0; this.bounds = {...bounds, width: bounds.width + offset, height: bounds.height + offset}; this.emit('resize');}
    }
    const {manager, screen} = setup({BrowserWindow: DpiWindow});
    screen.getDisplayMatching = screen.getPrimaryDisplay = () => display;
    manager.setVisible(true);
    manager.window.setBounds({...manager.bounds, y: 400, width: 710, height: 190});
    const logical = {...manager.bounds};
    for (let count = 0; count < 10; count++) {
      display.scaleFactor = display.scaleFactor === 1.25 ? 1 : 1.25;
      const offset = display.scaleFactor === 1.25 ? 3 : 0;
      manager.window.bounds = {...manager.bounds, width: manager.bounds.width + offset, height: manager.bounds.height + offset};
      const metrics = () => screen.emit('display-metrics-changed', {}, display, ['scaleFactor']);
      const resize = () => manager.window.emit('resize');
      if (firstEvent === 'metrics') {metrics(); resize();} else {resize(); metrics();}
      assert.deepEqual(manager.bounds, logical);
    }
    manager.window.emit('will-resize');
    manager.window.setBounds({...manager.bounds, width: 780, height: 210});
    manager.window.emit('resized');
    assert.equal(manager.bounds.width, 780); assert.equal(manager.bounds.height, 210);
    manager.dispose();
  }
});

test('fractional DPI readback does not grow the baseline over repeated automatic expansion', () => {
  class RoundedWindow extends FakeWindow {
    setBounds(bounds) {this.bounds = {...bounds, width: bounds.width + 2, height: bounds.height + 3}; this.emit('resize');}
  }
  const {manager} = setup({BrowserWindow: RoundedWindow}); manager.setVisible(true);
  manager.window.setBounds({...manager.appliedBounds, y: 400, width: 700, height: 180}); manager.window.emit('resized');
  const manual = {...manager.bounds};
  for (let count = 0; count < 20; count++) {
    manager.resizeToContent({layoutId: manager.layoutId, width: 1200, height: 250});
    assert.deepEqual(manager.bounds, manual);
    assert.equal(manager.window.getBounds().width, 1202);
    manager.resizeToContent({layoutId: manager.layoutId, width: 240, height: 89});
    assert.deepEqual(manager.bounds, manual);
    assert.deepEqual(manager.window.getBounds(), {...manual, width: manual.width + 2, height: manual.height + 3});
  }
  manager.dispose();
});

test('floating renderer paints timed words, freezes on pause/buffering, seeks backward and merges image patches', () => {
  const element = () => ({textContent: '', dataset: {}, children: [], values: {}, scrollWidth: 0, clientWidth: 560, scrollLeft: 0,
    style: {setProperty(name, value) { this[name] = value; }},
    setAttribute(name, value) { this.values[name] = value; },
    append(child) { this.children.push(child); }, replaceChildren() { this.children = []; },
  });
  const elements = Object.fromEntries(['current-line', 'next-line', 'song-title', 'toggle'].map(id => [id, element()]));
  const root = element();
  let listener;
  let now = 0;
  let nextFrame = 0;
  const frames = new Map();
  const context = {
    document: {getElementById: id => elements[id], createElement: element, documentElement: root, body: {classList: {toggle() {}}}, querySelectorAll: () => []},
    window: {floatingLyrics: {onSnapshot(callback) { listener = callback; return () => {}; }, getSnapshot: () => new Promise(() => {})}, addEventListener() {}},
    performance: {now: () => now},
    requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'lyrics.js'), 'utf8'), context);
  const base = sanitizeContent({line: '逐字', words: [{text: '逐', start: 0, dur: 1}, {text: '字', start: 1, dur: 1}], position: 0.5, playing: true, backgroundImage: image});
  listener({locked: false, content: base});
  const progress = index => parseFloat(elements['current-line'].children[index].style['--word-progress']);
  assert.equal(progress(0), 50);
  assert.equal(progress(1), 0);
  now = 250;
  const [id, tick] = frames.entries().next().value;
  frames.delete(id); tick(now);
  assert.equal(progress(0), 75);
  listener({locked: false, content: {position: 1.5, playing: false}});
  assert.equal(progress(0), 100); assert.equal(progress(1), 50);
  assert.equal(frames.size, 0);
  assert.ok(root.style['--background-image'].includes(image));
  listener({locked: false, content: {position: 0.25, playing: true, loading: true}});
  assert.equal(progress(0), 25); assert.equal(progress(1), 0);
  assert.equal(frames.size, 0);
  listener({locked: false, content: {line: '普通歌词', words: [], lineStart: 0, lineEnd: 4, position: 2, backgroundImage: null}});
  assert.equal(elements['current-line'].children.length, 1);
  assert.equal(progress(0), 50);
  assert.equal(root.style['--background-image'], 'none');
});
test('floating window is lazy, receives latest content on load and can reopen after hide', () => {
  const { manager } = setup();
  manager.update({ line: '最新歌词', fontSize: 36 });
  assert.equal(manager.window, null);
  assert.deepEqual(manager.setVisible(true), {visible: true, locked: false});
  const window = manager.window;
  assert.equal(window.options.transparent, true); assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(window.options.skipTaskbar, true);
  assert.equal(window.skipTaskbar, true);
  assert.equal(window.messages.at(-1)[1].content.line, '最新歌词');
  window.webContents.emit('did-finish-load');
  manager.setVisible(false); assert.equal(window.hidden, true);
  manager.setVisible(true); assert.equal(manager.window, window); assert.equal(window.hidden, false);
  assert.equal(window.skipTaskbar, true);
});
test('lock is mouse-through, close notifies main, and dispose destroys the native window', () => {
  const { manager, events } = setup();
  manager.setVisible(true); const window = manager.window;
  manager.setLocked(true); assert.equal(window.clickThrough, true); assert.equal(window.focusable, false);
  manager.setLocked(false); assert.equal(window.clickThrough, false);
  assert.equal(window.focusable, true); assert.equal(window.skipTaskbar, true);
  window.emit('close', {preventDefault() {}}); assert.equal(events.at(-1).visible, false);
  manager.dispose(); assert.equal(window.destroyed, true); assert.equal(manager.window, null);
});
test('only the overlay top frame can read content or request bounded playback commands', () => {
  const { manager, commands } = setup(); manager.setVisible(true);
  const window = manager.window; window.webContents.mainFrame.url = manager.pageUrl;
  assert.equal(manager.trusted({sender: window.webContents, senderFrame: window.webContents.mainFrame}), true);
  assert.equal(manager.trusted({sender: {}, senderFrame: window.webContents.mainFrame}), false);
  assert.equal(manager.trusted({sender: window.webContents, senderFrame: {url: manager.pageUrl}}), false);
  manager.command('next'); manager.command('show-main');
  assert.deepEqual(commands, ['next', 'main']);
  assert.throws(() => manager.command('library:list'));
  assert.throws(() => manager.setVisible('yes'));
});

test('position, manual size and lock persist across restart', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xmusic-lyrics-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const preferencesPath = path.join(directory, 'desktop-lyrics.json');
  const { manager } = setup({ preferencesPath });
  manager.setVisible(true);
  const bounds = { x: -1700, y: 400, width: 350, height: 150 };
  manager.window.bounds = bounds;
  manager.window.emit('move');
  manager.setLocked(true);
  manager.dispose();
  const restored = setup({ preferencesPath }).manager;
  assert.deepEqual(restored.state(), { visible: false, locked: true });
  restored.setVisible(true);
  assert.deepEqual(restored.window.getBounds(), bounds);
  assert.equal(restored.window.clickThrough, true);
  restored.dispose();
});

test('corrupt saved geometry is ignored and disconnected displays move lyrics back into view', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xmusic-lyrics-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const preferencesPath = path.join(directory, 'desktop-lyrics.json');
  fs.writeFileSync(preferencesPath, JSON.stringify({ bounds: { x: 'bad', y: 20, width: -4, height: null } }));
  const { manager, screen } = setup({ preferencesPath });
  assert.equal(manager.bounds, null);
  manager.setVisible(true);
  screen.getDisplayMatching = () => ({ workArea: { x: 0, y: 0, width: 800, height: 600 } });
  screen.emit('display-removed');
  const bounds = manager.window.getBounds();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 800);
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 600);
  manager.update({ line: '大字号歌词', fontSize: 60 });
  assert.equal(manager.window.getBounds().height, 144);
  manager.dispose();
  assert.equal(screen.listenerCount('display-removed'), 0);
  assert.equal(screen.listenerCount('display-metrics-changed'), 0);
});

test('pointer tracking covers the whole window without sending lyric snapshots and stops when inactive', t => {
  t.mock.timers.enable({apis: ['setInterval']});
  const {manager, screen} = setup();
  let cursor = {x: -1100, y: 900}, checks = 0;
  screen.getCursorScreenPoint = () => {checks++; return cursor;};
  manager.setVisible(true);
  const window = manager.window;
  const pointerEvents = () => window.messages.filter(([channel]) => channel === 'desktop-lyrics:pointer').map(([, inside]) => inside);
  assert.deepEqual(pointerEvents(), [true]);
  assert.equal(manager.snapshot().pointerInside, true);
  assert.equal(manager.snapshot().nativePointerAvailable, true);
  const snapshotCount = window.messages.filter(([channel]) => channel === 'desktop-lyrics:snapshot').length;
  t.mock.timers.tick(480);
  assert.deepEqual(pointerEvents(), [true]);
  cursor = {x: 9000, y: 9000};
  t.mock.timers.tick(120);
  assert.deepEqual(pointerEvents(), [true, false]);
  const bounds = window.getBounds();
  cursor = {x: bounds.x + 20, y: bounds.y + 5};
  t.mock.timers.tick(120);
  assert.deepEqual(pointerEvents(), [true, false, true], 'the transparent toolbar strip is part of the hit area');
  assert.equal(window.messages.filter(([channel]) => channel === 'desktop-lyrics:snapshot').length, snapshotCount);
  manager.setLocked(true);
  assert.equal(manager.pointerTimer, null);
  const lockedChecks = checks;
  t.mock.timers.tick(500);
  assert.equal(checks, lockedChecks);
  manager.setLocked(false);
  assert.notEqual(manager.pointerTimer, null);
  manager.setVisible(false);
  assert.equal(manager.pointerTimer, null);
  const hiddenChecks = checks;
  t.mock.timers.tick(500);
  assert.equal(checks, hiddenChecks);
  manager.setVisible(true);
  manager.dispose();
  assert.equal(manager.pointerTimer, null);
  const disposedChecks = checks;
  t.mock.timers.tick(500);
  assert.equal(checks, disposedChecks);
});

test('headless screens without a cursor API do not start a pointer poll', () => {
  const {manager} = setup(); manager.setVisible(true);
  assert.equal(manager.snapshot().nativePointerAvailable, false);
  assert.equal(manager.pointerTimer, null);
  manager.dispose();
});

test('legacy manual geometry is restored and v4 position-only records acquire the default size', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xmusic-lyrics-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const preferencesPath = path.join(directory, 'desktop-lyrics.json');
  for (const version of [undefined, 2, 3, 4]) {
    fs.writeFileSync(preferencesPath, JSON.stringify(version === 4 ? {version, locked: true, position: {x: -1400, y: 500}} : {version, locked: true, bounds: {x: -1400, y: 500, width: 850, height: 300}}));
    const {manager} = setup({preferencesPath});
    manager.setVisible(true);
    const expected = {x: -1400, y: 500, width: version === 4 ? 560 : 850, height: version === 4 ? 144 : 300};
    assert.deepEqual(manager.window.getBounds(), expected);
    assert.equal(manager.locked, true);
    manager.dispose();
    assert.deepEqual(JSON.parse(fs.readFileSync(preferencesPath, 'utf8')), {version: 5, bounds: expected, locked: true});
  }
});

test('a crashed or failed lyric renderer can be reopened in a fresh window', async () => {
  const { manager, events } = setup();
  manager.setVisible(true);
  const crashed = manager.window;
  crashed.webContents.emit('render-process-gone');
  assert.equal(crashed.isDestroyed(), true);
  assert.equal(events.at(-1).visible, false);
  manager.setVisible(true);
  assert.notEqual(manager.window, crashed);
  manager.dispose();

  class FailedWindow extends FakeWindow {
    loadFile() { return Promise.reject(new Error('load failed')); }
  }
  const failed = setup({ BrowserWindow: FailedWindow }).manager;
  failed.setVisible(true);
  await Promise.resolve();
  assert.equal(failed.visible, false);
  assert.equal(failed.window, null);
  failed.dispose();
});
