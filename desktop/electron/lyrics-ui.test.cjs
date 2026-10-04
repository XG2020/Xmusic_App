const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {JSDOM} = require('jsdom');
const {sanitizeContent} = require('./desktop-lyrics.cjs');

function rendererHarness(t, initialSnapshot) {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, 'lyrics.html'), 'utf8'), {runScripts: 'outside-only'});
  const {window} = dom;
  const reports = [], animations = [], copied = [];
  const frames = new Map(), motionListeners = new Set(), fontListeners = new Set(), timers = new Map();
  let listener, pointerListener, nextFrame = 0, nextTimer = 0, now = 0;
  const geometry = {currentWidth: 310.2, nextWidth: 420.6, height: 108, panelWidth: 560, lineWidth: 300, scrollWidth: 300};
  const motion = {matches: false, addEventListener(_event, callback) {motionListeners.add(callback);}, removeEventListener(_event, callback) {motionListeners.delete(callback);}};
  window.matchMedia = () => motion;
  Object.defineProperty(window.document, 'fonts', {value: {
    addEventListener(_event, callback) {fontListeners.add(callback);},
    removeEventListener(_event, callback) {fontListeners.delete(callback);},
    ready: new Promise(() => {}),
  }});
  window.floatingLyrics = {
    onSnapshot(callback) {listener = callback; return () => {};},
    onPointerInside(callback) {pointerListener = callback; return () => {pointerListener = undefined;};},
    getSnapshot() {return initialSnapshot ? Promise.resolve(initialSnapshot) : new Promise(() => {});},
    command() {},
    reportSize(size) {reports.push({...size});},
    async copyText(text) {copied.push(text);},
  };
  window.performance.now = () => now;
  window.requestAnimationFrame = callback => {const id = ++nextFrame; frames.set(id, callback); return id;};
  window.cancelAnimationFrame = id => frames.delete(id);
  window.setTimeout = (callback, delay) => {const id = ++nextTimer; timers.set(id, {callback, at: now + delay}); return id;};
  window.clearTimeout = id => timers.delete(id);
  window.HTMLElement.prototype.animate = function(keyframes, options) {
    const animation = {element: this, keyframes, options, playState: 'running',
      play() {this.playState = 'running';}, pause() {this.playState = 'paused';}, cancel() {this.playState = 'idle';}};
    animations.push(animation);
    return animation;
  };
  window.HTMLElement.prototype.getBoundingClientRect = function() {
    let width = geometry.lineWidth, height = geometry.height, left = 0;
    if (this.id === 'measure-current') width = geometry.currentWidth;
    else if (this.id === 'measure-next') width = geometry.nextWidth;
    else if (this.id === 'lyrics-panel') width = geometry.panelWidth;
    else if (this.className === 'lyric-word') {
      width = 50;
      left = [...this.parentNode.children].indexOf(this) * 50 - this.parentNode.scrollLeft;
    }
    if (this.id.startsWith('measure-')) {
      const fontSize = parseFloat(window.document.documentElement.style.getPropertyValue('--font-size')) || 30;
      const nextScale = this.id === 'measure-next' && !window.document.body.classList.contains('single-line') ? .65 : 1;
      const wrapWidth = this.style.whiteSpace === 'pre-wrap' ? parseFloat(this.style.width) : 0;
      height = fontSize * nextScale * 1.3 * (wrapWidth ? Math.ceil(width / wrapWidth) : 1);
      if (wrapWidth) width = wrapWidth;
    }
    return {width, height, x: left, y: 0, left, top: 0, right: left + width, bottom: height};
  };
  Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', {configurable: true, get() {return this.className === 'lyric-word' ? 50 : geometry.lineWidth;}});
  const current = window.document.getElementById('current-line');
  Object.defineProperty(current, 'clientWidth', {get: () => geometry.lineWidth});
  Object.defineProperty(current, 'scrollWidth', {get: () => geometry.scrollWidth});
  const style = window.document.createElement('style');
  style.textContent = fs.readFileSync(path.join(__dirname, 'lyrics.css'), 'utf8');
  window.document.head.append(style);
  window.eval(fs.readFileSync(path.join(__dirname, 'lyrics.js'), 'utf8'));
  t.after(() => {window.dispatchEvent(new window.Event('unload')); window.close();});
  return {window, geometry, reports, animations, frames, copied, timers,
    update: snapshot => listener({availableWidth: 1920, ...snapshot}),
    pointer: inside => pointerListener?.(inside),
    advance(milliseconds) {
      const target = now + milliseconds;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]); now = Math.max(now, next[1].at); next[1].callback();
      }
      now = target;
    },
    tick(value = now) {now = value; const pending = [...frames]; frames.clear(); pending.forEach(([, callback]) => callback(now));},
    reduceMotion(value) {motion.matches = value; motionListeners.forEach(callback => callback({matches: value}));},
    fontsLoaded() {fontListeners.forEach(callback => callback());},
  };
}

test('floating toolbar uses SVG controls that preserve commands and playback state', () => {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, 'lyrics.html'), 'utf8'), {runScripts: 'outside-only'});
  const {window} = dom;
  const commands = [];
  let update;
  let unsubscribed = false;
  window.floatingLyrics = {
    onSnapshot(handler) { update = handler; return () => { unsubscribed = true; }; },
    getSnapshot() { return new Promise(() => {}); },
    command(command) { commands.push(command); },
  };
  window.requestAnimationFrame = () => 1;
  window.cancelAnimationFrame = () => {};
  const style = window.document.createElement('style');
  style.textContent = fs.readFileSync(path.join(__dirname, 'lyrics.css'), 'utf8');
  window.document.head.append(style);
  window.eval(fs.readFileSync(path.join(__dirname, 'lyrics.js'), 'utf8'));

  const buttons = [...window.document.querySelectorAll('[data-command]')];
  assert.equal(buttons.length, 6);
  for (const button of buttons) {
    assert.equal(button.textContent.trim(), '');
    assert.ok(button.getAttribute('aria-label'));
    assert.equal(button.querySelector('svg').namespaceURI, 'http://www.w3.org/2000/svg');
    assert.equal(button.querySelector('svg').getAttribute('aria-hidden'), 'true');
    assert.ok(button.querySelector('svg path'));
    button.click();
  }
  assert.deepEqual(commands, ['previous', 'toggle', 'next', 'show-main', 'lock', 'close']);

  const toggle = window.document.getElementById('toggle');
  const play = toggle.querySelector('.icon-play');
  const pause = toggle.querySelector('.icon-pause');
  assert.notEqual(window.getComputedStyle(play).display, 'none');
  assert.equal(window.getComputedStyle(pause).display, 'none');
  update({locked: false, content: sanitizeContent({line: '播放中', playing: true, opacity: 0.4})});
  assert.equal(toggle.getAttribute('aria-label'), '暂停');
  assert.equal(toggle.title, '暂停');
  assert.equal(window.getComputedStyle(play).display, 'none');
  assert.notEqual(window.getComputedStyle(pause).display, 'none');
  update({locked: false, content: {playing: false, opacity: 0.8}});
  assert.equal(toggle.getAttribute('aria-label'), '播放');
  assert.equal(toggle.querySelectorAll('svg').length, 2);
  assert.notEqual(window.getComputedStyle(play).display, 'none');
  assert.equal(window.getComputedStyle(pause).display, 'none');
  assert.equal(window.document.documentElement.style.getPropertyValue('--panel-opacity'), '0.8');

  window.dispatchEvent(new window.Event('unload'));
  assert.equal(unsubscribed, true);
  window.close();
});

test('fixed font sizes report the natural background size and manual resizing does not scale lyrics', t => {
  const ui = rendererHarness(t);
  ui.update({layoutId: 1, locked: false, content: sanitizeContent({line: '当前句', nextLine: '下一句', fontSize: 30})});
  ui.tick();
  const document = ui.window.document;
  const panel = document.getElementById('lyrics-panel');
  const toolbar = document.querySelector('.toolbar');
  assert.equal(panel.contains(toolbar), false);
  assert.equal(ui.window.getComputedStyle(toolbar).opacity, '0');
  assert.equal(ui.window.getComputedStyle(toolbar).pointerEvents, 'none');
  assert.equal(ui.window.getComputedStyle(panel).top, '36px');
  assert.equal(document.documentElement.style.getPropertyValue('--display-font-size'), '30px');
  assert.deepEqual(ui.reports, [{layoutId: 1, width: 447, height: 118}]);
  ui.update({layoutId: 1, content: {position: 2, opacity: .8, borderRadius: 40}});
  assert.equal(ui.frames.size, 0);
  ui.update({layoutId: 2, content: {singleLine: true, fontFamily: '思源黑体 CN'}});
  ui.tick();
  const displayed = parseFloat(document.documentElement.style.getPropertyValue('--display-font-size'));
  assert.equal(displayed, 30);
  assert.deepEqual(ui.reports.at(-1), {layoutId: 2, width: 886, height: 89});
  assert.equal(document.documentElement.style.getPropertyValue('--font-size'), '30px');
  assert.ok(document.documentElement.style.getPropertyValue('--lyric-font-family').includes('思源黑体 CN'));
  assert.equal(ui.window.getComputedStyle(document.getElementById('lyric-lines')).flexDirection, 'row');
  assert.equal(ui.window.getComputedStyle(document.getElementById('next-line')).textOverflow, 'clip');
  assert.equal(document.getElementById('current-line').textContent, '当前句');
  assert.equal(document.getElementById('next-line').textContent, '下一句');
  ui.geometry.panelWidth = 330;
  ui.geometry.height = 44;
  ui.window.dispatchEvent(new ui.window.Event('resize'));
  ui.tick();
  assert.equal(parseFloat(document.documentElement.style.getPropertyValue('--display-font-size')), displayed);
  assert.equal(ui.reports.length, 2, 'manual resizing does not produce a content-size feedback loop');
  ui.update({layoutId: 3, locked: true, content: {fontFamily: 'Arial; color:red'}});
  ui.tick();
  assert.equal(ui.window.getComputedStyle(toolbar).visibility, 'hidden');
  assert.equal(document.documentElement.style.getPropertyValue('--lyric-font-family').includes('color:red'), false);
  assert.equal(panel.dataset.fittedLayoutId, '3');
  assert.equal(ui.reports.length, 3);
  ui.update({layoutId: 4, content: {fontSize: 60}});
  ui.tick();
  assert.equal(document.documentElement.style.getPropertyValue('--display-font-size'), '60px');
  assert.deepEqual(ui.reports.at(-1), {layoutId: 4, width: 886, height: 128});
});

test('sentences wider than the display wrap at the chosen font size and remeasure for a new monitor', t => {
  const ui = rendererHarness(t);
  ui.geometry.currentWidth = 900;
  ui.geometry.nextWidth = 450;
  ui.update({layoutId: 1, availableWidth: 500, content: sanitizeContent({line: '很长的歌词', nextLine: '下一句', fontSize: 40})});
  ui.tick();
  const document = ui.window.document;
  assert.equal(document.body.classList.contains('screen-wrapped'), true);
  assert.equal(document.documentElement.style.getPropertyValue('--display-font-size'), '40px');
  assert.deepEqual(ui.reports.at(-1), {layoutId: 1, width: 926, height: 191});
  assert.equal(document.getElementById('measure-current').style.width, '474px');
  ui.update({layoutId: 1, availableWidth: 1200, content: {position: 1}});
  ui.tick();
  assert.equal(document.body.classList.contains('screen-wrapped'), false);
  assert.deepEqual(ui.reports.at(-1), {layoutId: 1, width: 926, height: 139});
  ui.update({layoutId: 2, availableWidth: 800, content: {singleLine: true}});
  ui.tick();
  assert.equal(document.body.classList.contains('screen-wrapped'), true);
  assert.equal(document.getElementById('measure-current').style.width, '378px');
  assert.deepEqual(ui.reports.at(-1), {layoutId: 2, width: 1844, height: 206});
});

test('initial snapshots provide wrapping limits and loaded fonts can update the same layout measurement', async t => {
  const ui = rendererHarness(t, {layoutId: 8, availableWidth: 300, content: sanitizeContent({line: '歌词', fontSize: 40, fontFamily: '思源黑体 CN'})});
  await Promise.resolve();
  ui.tick();
  assert.equal(ui.window.document.body.classList.contains('screen-wrapped'), true);
  assert.deepEqual(ui.reports.at(-1), {layoutId: 8, width: 337, height: 154});
  ui.geometry.currentWidth = 200;
  ui.fontsLoaded(); ui.tick();
  assert.equal(ui.window.document.body.classList.contains('screen-wrapped'), false);
  assert.deepEqual(ui.reports.at(-1), {layoutId: 8, width: 226, height: 102});
  ui.fontsLoaded(); ui.tick();
  assert.equal(ui.reports.length, 2, 'identical font metrics do not resend geometry');
  assert.equal(ui.window.document.documentElement.style.getPropertyValue('--display-font-size'), '40px');
});

test('single-row sentence transitions promote the right preview, reverse on seek and freeze on pause', t => {
  const ui = rendererHarness(t);
  const sentence = (line, nextLine, time) => sanitizeContent({title: '歌曲', line, nextLine, singleLine: true, playing: true, position: time, lineStart: time, lineEnd: time + 2});
  ui.update({layoutId: 1, content: sentence('第一句', '第二句', 1)});
  ui.tick();
  assert.equal(ui.animations.length, 0);
  ui.update({layoutId: 2, content: sentence('第二句', '第三句', 3)});
  ui.tick();
  const forward = ui.animations.find(animation => animation.element.id === 'current-line');
  assert.equal(forward.keyframes[0].transform, 'translateX(318px)');
  assert.equal(forward.keyframes[0].opacity, 1);
  assert.equal(forward.options.duration, 650);
  assert.equal(ui.window.document.getElementById('next-line').textContent, '第三句');
  assert.equal(ui.window.document.querySelector('.lyric-line-outgoing').getAttribute('aria-hidden'), 'true');
  ui.update({layoutId: 2, content: {playing: false}});
  assert.ok(ui.animations.every(animation => animation.playState === 'paused'));
  assert.equal(ui.frames.size, 0);
  ui.update({layoutId: 2, content: {playing: true}});
  assert.ok(ui.animations.every(animation => animation.playState === 'running'));
  const beforeReverse = ui.animations.length;
  ui.update({layoutId: 3, content: sentence('第一句', '第二句', 1)});
  ui.tick();
  const backward = ui.animations.slice(beforeReverse).find(animation => animation.element.id === 'current-line');
  assert.equal(backward.keyframes[0].transform, 'translateX(-318px)');
  assert.equal(ui.window.document.querySelector('.lyric-line-outgoing'), null);
  ui.reduceMotion(true);
  assert.ok(ui.animations.every(animation => animation.playState === 'idle'));
  const reducedCount = ui.animations.length;
  ui.update({layoutId: 4, content: sentence('第二句', '第三句', 3)});
  ui.tick();
  assert.equal(ui.animations.length, reducedCount);
  assert.equal(ui.window.document.getElementById('current-line').textContent, '第二句');
});

test('native hover reveals controls, delays hiding and keeps them available across the toolbar and keyboard focus', t => {
  const ui = rendererHarness(t);
  ui.update({layoutId: 1, locked: false, content: sanitizeContent({line: '歌词'})});
  ui.tick();
  const body = ui.window.document.body;
  const visible = () => body.classList.contains('controls-visible');
  assert.equal(visible(), false);
  ui.pointer(true);
  assert.equal(visible(), true);
  assert.equal(ui.frames.size, 0, 'hover must not restart playback animation or layout work');
  ui.pointer(false);
  ui.advance(400);
  ui.update({layoutId: 1, content: {position: 2}});
  ui.advance(299);
  assert.equal(visible(), true);
  ui.advance(1);
  assert.equal(visible(), false, 'clock updates do not extend the leave delay');
  ui.pointer(true);
  body.dispatchEvent(new ui.window.MouseEvent('mouseleave'));
  ui.advance(1000);
  assert.equal(visible(), true, 'native whole-window hit testing wins over drag-region DOM leave noise');
  ui.pointer(false);
  const button = ui.window.document.getElementById('toggle');
  body.dispatchEvent(new ui.window.KeyboardEvent('keydown', {key: 'Tab', bubbles: true}));
  button.focus();
  ui.advance(1000);
  assert.equal(visible(), true);
  button.blur();
  ui.advance(700);
  assert.equal(visible(), false);
  ui.pointer(true);
  ui.update({layoutId: 1, locked: true, content: {position: 3}});
  assert.equal(visible(), false);
  assert.equal(ui.timers.size, 0);
  ui.pointer(false);
  ui.update({layoutId: 1, locked: false, content: {position: 3}});
  ui.pointer(true); ui.pointer(false);
  assert.equal(ui.timers.size, 1);
  ui.window.dispatchEvent(new ui.window.Event('unload'));
  assert.equal(ui.timers.size, 0);
});

test('mouse-click focus on playback controls does not prevent hiding after the pointer leaves', t => {
  const ui = rendererHarness(t);
  ui.update({layoutId: 1, locked: false, content: sanitizeContent({line: '歌词'})});
  ui.tick();
  const body = ui.window.document.body;
  const button = ui.window.document.getElementById('toggle');
  // Start with real keyboard focus, then switch to a mouse click on that same button.
  body.dispatchEvent(new ui.window.KeyboardEvent('keydown', {key: 'Tab', bubbles: true}));
  button.focus();
  ui.pointer(true);
  button.dispatchEvent(new ui.window.MouseEvent('pointerdown', {bubbles: true, button: 0}));
  button.focus(); button.click();
  assert.equal(ui.window.document.activeElement, button);
  ui.pointer(false);
  ui.advance(699);
  assert.equal(body.classList.contains('controls-visible'), true);
  ui.advance(1);
  assert.equal(body.classList.contains('controls-visible'), false);
  assert.equal(ui.window.document.activeElement, button, 'mouse focus may remain without pinning the controls open');
  button.dispatchEvent(new ui.window.KeyboardEvent('keydown', {key: ' ', bubbles: true}));
  ui.advance(1000);
  assert.equal(body.classList.contains('controls-visible'), true, 'subsequent keyboard interaction remains accessible');
});

test('DOM mouse enter and leave remain a fallback when no native pointer event is received', t => {
  const ui = rendererHarness(t);
  ui.update({layoutId: 1, locked: false, content: sanitizeContent({line: '歌词'})});
  const body = ui.window.document.body;
  body.dispatchEvent(new ui.window.MouseEvent('mouseenter'));
  assert.equal(body.classList.contains('controls-visible'), true);
  body.dispatchEvent(new ui.window.MouseEvent('mouseleave'));
  ui.advance(700);
  assert.equal(body.classList.contains('controls-visible'), false);
});

test('initial native pointer snapshots survive missed load events and reject drag-region DOM noise', async t => {
  const snapshot = {layoutId: 1, locked: false, pointerInside: true, nativePointerAvailable: true, content: sanitizeContent({line: '歌词'})};
  const ui = rendererHarness(t, snapshot);
  await Promise.resolve();
  const body = ui.window.document.body;
  const visible = () => body.classList.contains('controls-visible');
  assert.equal(visible(), true, 'opening under the cursor must recover a native event sent before preload subscribed');
  body.dispatchEvent(new ui.window.MouseEvent('mouseleave'));
  ui.advance(1000);
  assert.equal(visible(), true, 'a drag-region DOM leave must not override the native initial snapshot');
  ui.pointer(false); ui.advance(700);
  assert.equal(visible(), false);
  body.dispatchEvent(new ui.window.MouseEvent('mouseenter'));
  ui.advance(1000);
  assert.equal(visible(), false, 'DOM enter noise must not pin controls open after native pointer exit');
  ui.pointer(true);
  assert.equal(visible(), true);

  const newer = rendererHarness(t, snapshot);
  newer.pointer(false);
  await Promise.resolve();
  assert.equal(newer.window.document.body.classList.contains('controls-visible'), false, 'a late initial snapshot must not replace a newer native pointer event');
});

test('an initial snapshot without native pointer support preserves DOM hover fallback', async t => {
  const ui = rendererHarness(t, {locked: false, pointerInside: false, nativePointerAvailable: false, content: sanitizeContent({line: '歌词'})});
  await Promise.resolve();
  const body = ui.window.document.body;
  body.dispatchEvent(new ui.window.MouseEvent('mouseenter'));
  assert.equal(body.classList.contains('controls-visible'), true);
  body.dispatchEvent(new ui.window.MouseEvent('mouseleave'));
  ui.advance(700);
  assert.equal(body.classList.contains('controls-visible'), false);
});

test('word timing advances without resending geometry or changing font size', t => {
  const ui = rendererHarness(t);
  ui.geometry.lineWidth = 80;
  ui.geometry.scrollWidth = 400;
  ui.update({layoutId: 1, content: sanitizeContent({line: '逐字歌词', nextLine: '下一句', singleLine: true, playing: true, position: 1.5,
    words: ['逐', '字', '歌', '词'].map((text, index) => ({text, start: index, dur: 1})), lineStart: 0, lineEnd: 4})});
  ui.tick();
  const current = ui.window.document.getElementById('current-line');
  assert.equal(current.scrollLeft, 0);
  assert.equal(ui.reports.length, 1);
  ui.tick(250);
  assert.equal(current.scrollLeft, 0);
  assert.equal(ui.reports.length, 1);
  ui.update({layoutId: 1, content: {playing: false, position: 1.75}});
  ui.tick(1000);
  assert.equal(current.scrollLeft, 0);
  assert.equal(ui.frames.size, 0);
  ui.update({layoutId: 1, content: {playing: true, position: .2}});
  assert.equal(current.scrollLeft, 0);
  assert.equal(current.children[0].style.getPropertyValue('--word-progress'), '20%');
  assert.equal(ui.reports.length, 1);
});

test('right-click copies the selected visible sentence and leaves layout and playback untouched', async t => {
  const ui = rendererHarness(t);
  ui.update({layoutId: 1, locked: false, content: sanitizeContent({line: '正在播放的句子', nextLine: '右边的下一句', singleLine: true})});
  ui.tick();
  const current = ui.window.document.getElementById('current-line');
  const next = ui.window.document.getElementById('next-line');
  const event = new ui.window.MouseEvent('contextmenu', {bubbles: true, cancelable: true});
  current.dispatchEvent(event);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(ui.copied, ['正在播放的句子']);
  next.dispatchEvent(new ui.window.MouseEvent('contextmenu', {bubbles: true, cancelable: true}));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(ui.copied, ['正在播放的句子', '右边的下一句']);
  assert.equal(ui.window.document.getElementById('copy-notice').textContent, '已复制歌词');
  assert.equal(ui.reports.length, 1);
  assert.equal(ui.frames.size, 0);
  ui.update({layoutId: 1, locked: true, content: {position: 2}});
  current.dispatchEvent(new ui.window.MouseEvent('contextmenu', {bubbles: true, cancelable: true}));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.copied.length, 2);
  ui.update({layoutId: 1, locked: false, content: {position: 2}});
  ui.window.floatingLyrics.copyText = async () => {throw new Error('剪贴板暂不可用');};
  next.dispatchEvent(new ui.window.MouseEvent('contextmenu', {bubbles: true, cancelable: true}));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(ui.window.document.getElementById('copy-notice').textContent, /复制失败|剪贴板暂不可用/);
  assert.equal(ui.reports.length, 1);
});

test('the floating preload exposes only the fixed clipboard copy channel', async () => {
  let bridge;
  const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'lyrics-preload.cjs'), 'utf8'), {
    require(name) {
      assert.equal(name, 'electron');
      return {contextBridge: {exposeInMainWorld(name, value) {assert.equal(name, 'floatingLyrics'); bridge = value;}},
        ipcRenderer: {invoke(channel, value) {calls.push([channel, value]); return Promise.resolve();}}};
    },
  });
  await bridge.copyText('歌词\n原样保留');
  assert.deepEqual(calls, [['clipboard:copy', '歌词\n原样保留']]);
  assert.equal(Object.isFrozen(bridge), true);
});
