// Focused, real-Electron checks for tray layout, karaoke colors and lyric sizing.
// Run after building the renderer. All state and artifacts stay in a new test profile.
// XMUSIC_EXECUTABLE: packaged Xmusic executable (does not take an app-directory argument).
// XMUSIC_ELECTRON_EXECUTABLE: bare Electron runtime (launches this desktop directory).
// XMUSIC_EXPERIENCE_OUTPUT: optional parent directory for persistent run artifacts.
import assert from 'node:assert/strict';
import {access, mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {_electron as electron} from 'playwright';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const artifactRoot = path.resolve(process.env.XMUSIC_EXPERIENCE_OUTPUT || path.join(root, '.test-data'));
await mkdir(artifactRoot, {recursive: true});
const output = await mkdtemp(path.join(artifactRoot, 'experience-'));
const profile = path.join(output, 'profile');
const checks = {};
const errors = [];
const requestLog = [];
const processLog = [];
const observedPages = new WeakSet();
const startedAt = new Date().toISOString();
let application;
let mainPage;
let failure;
let stage = 'initialization';
let expiryActive = false;
let expiryResolutions = 0;

const firstLine = '在线歌词已连接';
const longLine = '长句背景向左右展开且保持字体大小不变'.repeat(2);
const shortLine = '短句';
const duration = 24;
const track = {mid: 'experience001', title: '体验回归测试', singer: [{name: 'Xmusic 测试歌手'}], album: {name: '本地测试夹具'}, interval: duration};
const timedLine = (start, text) => `[${start},6000]${Array.from(text, (character, index) => {
  const offset = Math.floor(index * 6000 / text.length);
  const end = Math.floor((index + 1) * 6000 / text.length);
  return `${character}(${start + offset},${end - offset})`;
}).join('')}`;
const qrc = `<QrcInfos><LyricInfo><Lyric_1 LyricContent="[0,6000]在(0,800)线(800,800)歌(1600,800)词(2400,800)已(3200,800)连(4000,800)接(4800,1200)&#10;${timedLine(6000, '继续听歌')}&#10;${timedLine(12000, longLine)}&#10;${timedLine(18000, shortLine)}"/></LyricInfo></QrcInfos>`;
const wav = Buffer.alloc(44 + 16000 * 2 * duration);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
await writeFile(path.join(output, 'fixture.qrc'), qrc);

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  requestLog.push({path: url.pathname, params: Object.fromEntries(url.searchParams)});
  if (url.pathname === '/denied.wav' || (url.pathname === '/expiring.wav' && expiryActive)) {
    response.writeHead(403, {'Cache-Control': 'no-store'}); response.end('Expired test signature'); return;
  }
  if (['/audio.wav', '/expiring.wav', '/refreshed.wav'].includes(url.pathname)) {
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
    if (start > end || start >= wav.length) {
      response.writeHead(416, {'Content-Range': `bytes */${wav.length}`}); response.end(); return;
    }
    response.writeHead(range ? 206 : 200, {'Content-Type': 'audio/wav', 'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', ...(range ? {'Content-Range': `bytes ${start}-${end}/${wav.length}`} : {})});
    response.end(request.method === 'HEAD' ? undefined : wav.subarray(start, end + 1));
    return;
  }
  let data;
  if (url.pathname === '/api/search') data = {list: [track]};
  else if (url.pathname === '/api/song/url') {
    const mid = url.searchParams.get('mid');
    const media = mid === 'expiredFixture' ? (++expiryResolutions === 1 ? 'expiring.wav' : 'refreshed.wav')
      : mid === 'forbiddenFixture' ? 'denied.wav' : 'audio.wav';
    data = {[mid]: `http://127.0.0.1:${server.address().port}/${media}`};
  }
  else if (url.pathname === '/api/lyric') data = {lyric: url.searchParams.get('qrc') === 'true' ? qrc : `[00:00.00]${firstLine}`};
  else if (url.pathname === '/api/song/detail') data = {track_info: track};
  else {
    response.writeHead(404, {'Content-Type': 'application/json'});
    response.end(JSON.stringify({code: 404, message: `Unexpected test endpoint: ${url.pathname}`})); return;
  }
  response.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
  response.end(JSON.stringify({code: 0, data}));
});

function observe(page) {
  if (observedPages.has(page)) return;
  observedPages.add(page);
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push({url: page.url(), message: error.message}));
}

async function screenshot(page, name) {
  const destination = path.join(output, name);
  try {await page.screenshot({path: destination, timeout: 3000});}
  catch (error) {
    if (error.name !== 'TimeoutError' && !error.message?.includes('UnknownVizError')) throw error;
    await page.screenshot({path: destination, timeout: 20000});
  }
}

async function setRange(page, name, value) {
  await page.getByRole('slider', {name, exact: true}).evaluate((input, next) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(next));
    input.dispatchEvent(new Event('input', {bubbles: true}));
    input.dispatchEvent(new Event('change', {bubbles: true}));
  }, value);
}

async function seek(seconds) {
  await setRange(mainPage, '播放进度', seconds);
  await mainPage.waitForFunction(expected => {
    const audio = window.__experienceAudio;
    return !!audio && audio.paused && !audio.seeking && Math.abs(audio.currentTime - expected) < .08;
  }, seconds);
}

async function settings() {
  const close = mainPage.getByRole('button', {name: '收起歌曲详情', exact: true});
  if (await close.count()) await close.click();
  await mainPage.locator('.sidebar .nav-item').filter({hasText: '设置'}).click();
}

async function showLyrics() {
  await mainPage.getByRole('button', {name: '显示歌词', exact: true}).click();
  await mainPage.locator('.detail-lyric-line.word-timed').first().waitFor();
}

async function verifyGradient(name, expectedHex, expectedRgb) {
  await seek(3);
  await mainPage.waitForFunction(() => {
    const words = document.querySelectorAll('.detail-lyric-line.active .detail-lyric-word');
    return words.length === 7 && Math.abs(parseFloat(words[3].style.getPropertyValue('--word-progress')) - 75) < 1;
  });
  const actual = await mainPage.locator('.detail-lyric-line.active .detail-lyric-word').nth(3).evaluate(word => {
    const style = getComputedStyle(word);
    return {theme: document.documentElement.dataset.theme, sung: style.getPropertyValue('--lyric-sung').trim(),
      pending: style.getPropertyValue('--lyric-pending').trim(), background: style.backgroundImage,
      clip: style.backgroundClip, fill: style.webkitTextFillColor,
      progress: parseFloat(word.style.getPropertyValue('--word-progress'))};
  });
  assert.equal(actual.theme, 'light');
  assert.equal(actual.sung, expectedHex);
  assert.notEqual(actual.pending, actual.sung);
  assert.match(actual.background, /linear-gradient/);
  assert.ok(actual.background.includes(expectedRgb), `${name}: expected actual gradient color ${expectedRgb}, got ${actual.background}`);
  assert.equal(actual.clip, 'text');
  assert.equal(actual.fill, 'rgba(0, 0, 0, 0)');
  assert.ok(Math.abs(actual.progress - 75) < 1);
  await screenshot(mainPage, `${name}.png`);
  checks[name] = actual;
}

async function verifyTray() {
  // Capture the already constructed production manager on its next trusted
  // state update. Its real preload and original IPC sender checks remain active.
  await application.evaluate(({app}) => {
    const requireModule = typeof require === 'function' ? require
      : process.mainModule?.require.bind(process.mainModule)
        ?? process.getBuiltinModule?.('module').createRequire(`${app.getAppPath()}/package.json`);
    if (!requireModule) throw new Error('Cannot inspect the production tray manager in this Electron runtime.');
    const path = requireModule('node:path');
    const {TrayMenu} = requireModule(path.join(app.getAppPath(), 'electron/tray-menu.cjs'));
    const update = TrayMenu.prototype.update;
    let accept;
    globalThis.__experienceTrayReady = new Promise(resolve => {accept = resolve;});
    globalThis.__experienceRestoreTrayProbe = () => {TrayMenu.prototype.update = update;};
    TrayMenu.prototype.update = function(value) {
      globalThis.__experienceTrayMenu = this;
      TrayMenu.prototype.update = update;
      const result = update.call(this, value);
      accept(this);
      return result;
    };
  });
  await mainPage.evaluate(() => window.desktop.updateTrayPlayer({title: '体验回归测试', artist: 'Xmusic 测试歌手',
    playing: false, favorite: false, volume: .75, muted: false, hasTrack: false, hasQueue: false}));
  const menuCreated = application.waitForEvent('window');
  assert.equal(await application.evaluate(async () => {
    let timer;
    try {
      const manager = await Promise.race([globalThis.__experienceTrayReady,
        new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('The trusted tray-player update did not reach its production manager.')), 10000);})]);
      return await manager.show();
    } finally {clearTimeout(timer);}
  }), true);
  const menu = await menuCreated;
  await menu.getByRole('dialog', {name: 'Xmusic 托盘菜单'}).waitFor();
  assert.equal(await menu.evaluate(async () => (await window.trayMenu.getSnapshot()).title), '体验回归测试', 'The production preload must successfully pass real IPC sender validation.');
  assert.equal(await menu.evaluate(() => typeof window.require), 'undefined');
  const layout = await menu.evaluate(() => {
    const footer = document.querySelector('footer');
    const buttons = [...footer.querySelectorAll('button')].map(button => {
      const rect = button.getBoundingClientRect();
      return {label: button.textContent.trim(), left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width};
    });
    return {width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
      direction: getComputedStyle(footer).flexDirection, bottom: footer.getBoundingClientRect().bottom, buttons};
  });
  assert.ok(Math.abs(layout.width - 252) <= 3, `Tray content width must be 252 DIP, got ${layout.width}.`);
  assert.equal(layout.direction, 'column');
  assert.deepEqual(layout.buttons.map(button => button.label), ['显示软件', '退出软件']);
  const [show, quit] = layout.buttons;
  assert.ok(Math.abs(show.left - quit.left) <= 1 && Math.abs(show.width - quit.width) <= 1);
  assert.ok(quit.top >= show.bottom, 'Tray commands must occupy separate rows.');
  assert.ok(layout.bottom <= layout.height + 1 && layout.scrollWidth <= layout.width + 1, 'The compact tray must contain all commands without clipping.');
  const native = await application.evaluate(({BrowserWindow}) => {
    const window = BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Xmusic 托盘菜单');
    const options = window.webContents.getLastWebPreferences();
    return {bounds: window.getBounds(), content: window.getContentBounds(), secure: options.contextIsolation && options.sandbox && !options.nodeIntegration && options.webSecurity};
  });
  assert.equal(native.secure, true);
  await screenshot(menu, '01-tray-compact-column.png');
  checks.tray = {layout, native};
  await menu.getByRole('button', {name: '显示软件', exact: true}).click();
  assert.equal(await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Xmusic 托盘菜单').isVisible()), false,
    'The real tray command must dismiss its popup through the production IPC handler.');
}

async function floatingState(overlay, expectedLine) {
  await overlay.waitForFunction(async line => {
    const snapshot = await window.floatingLyrics.getSnapshot();
    const panel = document.getElementById('lyrics-panel');
    return snapshot.content.line === line && document.getElementById('current-line').textContent === line
      && Number(panel.dataset.fittedLayoutId) === snapshot.layoutId;
  }, expectedLine);
  // The renderer reports its measured size asynchronously. Observe the actual
  // native rectangle and content geometry; do not derive sizes from text length.
  await overlay.waitForFunction(() => {
    const panel = document.getElementById('lyrics-panel');
    return document.getElementById('current-line').scrollWidth <= document.getElementById('current-line').clientWidth + 1
      && panel.dataset.displayFontSize === '30';
  });
  return application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Xmusic 桌面歌词').getBounds());
}

async function verifyFloatingSizing() {
  await settings();
  await setRange(mainPage, '悬浮歌词字号', 30);
  await mainPage.getByRole('switch', {name: '单行左右显示', exact: true}).uncheck();
  await seek(3);
  const created = application.waitForEvent('window');
  await mainPage.locator('.player-bar').getByRole('button', {name: '开启桌面歌词', exact: true}).click();
  const overlay = await created;
  await floatingState(overlay, firstLine);
  const manual = await application.evaluate(({BrowserWindow, screen}) => {
    const window = BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Xmusic 桌面歌词');
    const area = screen.getDisplayMatching(window.getBounds()).workArea;
    if (area.width <= 760 || area.height < 220) throw new Error('This check requires a display work area wider than 760 DIP and at least 220 DIP high.');
    const requested = {x: Math.round(area.x + (area.width - 720) / 2), y: area.y + 40, width: 720, height: 180};
    window.setBounds(requested);
    return {requested, area};
  });
  await overlay.waitForFunction(() => Math.abs(innerWidth - 720) <= 3);
  const baseline = await floatingState(overlay, firstLine);
  assert.ok(Math.abs(baseline.width - 720) <= 3);
  assert.equal(await overlay.locator('#current-line').evaluate(element => getComputedStyle(element).fontSize), '30px');
  await screenshot(overlay, '04-floating-manual-720.png');
  const cycles = [];
  for (let cycle = 0; cycle < 2; cycle++) {
    await seek(12);
    await floatingState(overlay, longLine);
    await overlay.waitForFunction(width => innerWidth > width + 20, baseline.width);
    const expanded = await floatingState(overlay, longLine);
    assert.ok(expanded.width > baseline.width + 20);
    assert.ok(expanded.width <= manual.area.width + 3);
    assert.ok(Math.abs((expanded.x + expanded.width / 2) - (baseline.x + baseline.width / 2)) <= 3, 'Long lyrics must expand equally around the chosen center.');
    const typography = await overlay.evaluate(() => [...document.querySelectorAll('#current-line, #next-line')].map(element => ({
      font: getComputedStyle(element).fontSize, client: element.clientWidth, scroll: element.scrollWidth,
    })));
    assert.equal(typography[0].font, '30px');
    assert.ok(typography.every(line => line.scroll <= line.client + 1));
    if (cycle === 0) await screenshot(overlay, '05-floating-expanded-long-line.png');
    await seek(18);
    await floatingState(overlay, shortLine);
    await overlay.waitForFunction(width => Math.abs(innerWidth - width) <= 3, baseline.width);
    const restored = await floatingState(overlay, shortLine);
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(restored[key] - baseline[key]) <= 3,
      `Short lyrics must restore manual ${key}: baseline ${baseline[key]}, actual ${restored[key]}.`);
    assert.equal(await overlay.locator('#current-line').evaluate(element => getComputedStyle(element).fontSize), '30px');
    cycles.push({expanded, restored, typography});
  }
  await screenshot(overlay, '06-floating-restored-short-line.png');
  checks.floating = {manual, baseline, cycles};
  await mainPage.locator('.player-bar').getByRole('button', {name: '关闭桌面歌词', exact: true}).click();
}

async function verifyExpiredLinks() {
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const source = await mainPage.evaluate(baseUrl => window.desktop.resolveOnlineAudio({mid: 'expiredFixture', quality: '320', baseUrl}), baseUrl);
  assert.equal(typeof source, 'string');
  expiryActive = true;
  // Renderer CSP allows these protocols for audio elements, not arbitrary
  // fetch. Inspect Range bytes through Electron's real session protocol.
  const recovered = await application.evaluate(async ({net}, source) => {
    const response = await net.fetch(source, {headers: {Range: 'bytes=12-63'}});
    return {status: response.status, range: response.headers.get('content-range'), bytes: [...new Uint8Array(await response.arrayBuffer())]};
  }, source);
  recovered.failure = await mainPage.evaluate(source => window.desktop.getOnlineAudioFailure(source), source);
  assert.equal(recovered.status, 206);
  assert.deepEqual(Buffer.from(recovered.bytes), wav.subarray(12, 64));
  assert.equal(recovered.failure, undefined);
  assert.equal(expiryResolutions, 2, 'An expired cached URL must resolve once more at the same quality.');
  const terminal = await mainPage.evaluate(baseUrl => window.desktop.resolveOnlineAudio({mid: 'forbiddenFixture', quality: '320', baseUrl}), baseUrl);
  assert.equal(terminal.code, 'AUDIO_URL_EXPIRED', 'The real contextBridge must preserve the terminal expiry code as plain data.');
  const resolutions = requestLog.filter(request => request.path === '/api/song/url' && ['expiredFixture', 'forbiddenFixture'].includes(request.params.mid));
  assert.deepEqual(resolutions.map(request => request.params.quality), ['320', '320', '320', '320']);
  checks.expiredLinks = {recovered, terminal, resolutions};
}

try {
  if (process.env.XMUSIC_EXECUTABLE && process.env.XMUSIC_ELECTRON_EXECUTABLE) throw new Error('Choose either XMUSIC_EXECUTABLE (packaged app) or XMUSIC_ELECTRON_EXECUTABLE (bare runtime), not both.');
  if (!process.env.XMUSIC_EXECUTABLE) await access(path.join(root, 'dist/index.html'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = {...process.env, XMUSIC_USER_DATA: profile, XMUSIC_HEADLESS: '1'};
  delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
  const executablePath = process.env.XMUSIC_EXECUTABLE || process.env.XMUSIC_ELECTRON_EXECUTABLE;
  stage = 'launch';
  application = await electron.launch({...(executablePath ? {executablePath} : {}),
    args: process.env.XMUSIC_EXECUTABLE ? ['--mute-audio'] : [root, '--mute-audio'], cwd: root, env, timeout: 30000});
  application.on('window', observe);
  application.process().stdout?.on('data', chunk => processLog.push(String(chunk)));
  application.process().stderr?.on('data', chunk => processLog.push(String(chunk)));
  mainPage = await application.firstWindow();
  observe(mainPage);
  await mainPage.locator('.track-section').waitFor();
  assert.equal(await mainPage.evaluate(() => typeof window.require), 'undefined');
  checks.runtime = await application.evaluate(({app}) => ({electron: process.versions.electron, node: process.versions.node, appPath: app.getAppPath(), userData: app.getPath('userData')}));
  assert.equal(path.resolve(checks.runtime.userData), path.resolve(profile));
  await mainPage.evaluate(() => {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function(...args) {window.__experienceAudio = this; return Reflect.apply(play, this, args);};
  });

  stage = 'tray';
  await verifyTray();

  stage = 'configure-local-fixture';
  await settings();
  for (let count = 0; count < 5; count++) await mainPage.getByRole('button', {name: /^版本 v/}).click();
  await mainPage.getByRole('dialog', {name: '开发者模式', exact: true}).getByLabel('开发者密钥').fill('XG2020');
  await mainPage.getByRole('button', {name: '进入开发者模式', exact: true}).click();
  await mainPage.getByLabel('自定义音乐接口', {exact: true}).fill(`http://127.0.0.1:${server.address().port}`);
  await mainPage.getByRole('button', {name: '保存设置', exact: true}).click();
  await mainPage.getByRole('radio', {name: '浅色', exact: true}).check();
  await mainPage.getByRole('button', {name: '薄荷绿', exact: true}).click();
  await mainPage.getByRole('textbox', {name: '搜索在线音乐'}).fill('体验回归');
  await mainPage.getByRole('textbox', {name: '搜索在线音乐'}).press('Enter');
  await mainPage.getByRole('button', {name: track.title, exact: true}).click();
  await mainPage.locator('.player-bar').getByRole('button', {name: '暂停', exact: true}).waitFor();
  await mainPage.waitForFunction(() => window.__experienceAudio?.currentTime > .05 && !window.__experienceAudio.paused);
  await mainPage.locator('.player-bar').getByRole('button', {name: '暂停', exact: true}).click();
  await showLyrics();

  stage = 'default-light-karaoke';
  await verifyGradient('02-light-default-green-karaoke', '#16c76b', 'rgb(22, 199, 107)');
  stage = 'custom-light-karaoke';
  await settings();
  await mainPage.getByLabel('自定义主题色', {exact: true}).fill('#ff8800');
  await mainPage.getByLabel('自定义主题色', {exact: true}).press('Enter');
  await showLyrics();
  await verifyGradient('03-light-custom-orange-karaoke', '#ff8800', 'rgb(255, 136, 0)');

  stage = 'fixed-font-long-short';
  await verifyFloatingSizing();
  stage = 'cached-link-expiry';
  await verifyExpiredLinks();
  assert.ok(requestLog.some(request => request.path === '/api/lyric' && request.params.qrc === 'true'));
  assert.ok(requestLog.some(request => request.path === '/audio.wav'));
  assert.deepEqual(errors, []);
  stage = 'complete';
} catch (error) {
  failure = {stage, message: error.message, stack: error.stack};
  if (mainPage && !mainPage.isClosed()) {
    try {await screenshot(mainPage, 'failure.png');} catch { /* Retain the original failure. */ }
  }
  process.exitCode = 1;
} finally {
  if (application) {
    try {await application.evaluate(() => globalThis.__experienceRestoreTrayProbe?.());} catch { /* The app may already have exited. */ }
    try {await application.close();} catch (error) {
      if (!failure) {failure = {stage: 'shutdown', message: error.message}; process.exitCode = 1;}
    }
  }
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(output, 'electron.log'), processLog.join(''));
  const report = {passed: !failure, stage, startedAt, finishedAt: new Date().toISOString(), output, checks, errors, requests: requestLog, failure};
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({passed: !failure, output, checks: Object.keys(checks), failure}, null, 2));
}
