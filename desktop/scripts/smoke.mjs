// Exercise the packaged renderer and real Electron bridge without a visible window.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { _electron as electron } from "playwright";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const artifactRoot = path.join(root, ".test-data");
await mkdir(artifactRoot, { recursive: true });
const testRoot = await mkdtemp(path.join(artifactRoot, "smoke-"));
const userData = path.join(testRoot, "profile");
const downloadDirectory = path.join(testRoot, 'downloads');
await mkdir(downloadDirectory);
const audioDirectory = path.join(testRoot, '音乐');
await mkdir(path.join(audioDirectory, '子目录'), {recursive: true});
const audioPath = path.join(audioDirectory, '子目录', "Windows 播放测试.wav");
const backgroundPath = path.join(testRoot, '背景图片测试.png');
const floatingBackgroundPath = path.join(testRoot, '悬浮歌词独立背景.png');
const CUSTOM_PLAYLIST_NAME = 'Windows 歌单测试';
const wav = Buffer.alloc(44 + 16000 * 2 * 18);
wav.write("RIFF", 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24);
wav.writeUInt32LE(32000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(wav.length - 44, 40);
await writeFile(audioPath, wav);
await writeFile(
  audioPath.replace(/\.wav$/, ".lrc"),
  "[00:00.00]此刻，音乐开始\n[00:05.00]听见 Windows 的旋律\n[00:12.00]让好音乐留在身边"
);
const requests = [];
const qualityRequests = [];
const requestDetails = [];
const qrc = '<QrcInfos><LyricInfo><Lyric_1 LyricContent="[0,6000]在(0,800)线(800,800)歌(1600,800)词(2400,800)已(3200,800)连(4000,800)接(4800,1200)&#10;[6000,6000]逐(6000,1200)字(7200,1200)渲(8400,1200)染(9600,1200)中(10800,1200)&#10;[12000,6000]让(12000,1000)音(13000,1000)乐(14000,1000)陪(15000,1000)伴(16000,1000)你(17000,1000)"/></LyricInfo></QrcInfos>';
const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  requests.push(url.pathname);
  requestDetails.push({path: url.pathname, params: Object.fromEntries(url.searchParams)});
  if (url.pathname === '/api/song/url') qualityRequests.push(url.searchParams.get('quality'));
  if (url.pathname === "/audio.wav") {
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
    if (start > end || start >= wav.length) {
      response.writeHead(416, {'Content-Range': `bytes */${wav.length}`});
      response.end();
      return;
    }
    response.writeHead(range ? 206 : 200, {
      "Content-Type": "audio/wav",
      "Content-Length": end - start + 1,
      'Accept-Ranges': 'bytes',
      ...(range ? {'Content-Range': `bytes ${start}-${end}/${wav.length}`} : {}),
    });
    response.end(request.method === 'HEAD' ? undefined : wav.subarray(start, end + 1));
    return;
  }
  const port = server.address().port;
  let result;
  if (url.pathname === '/api/search' && url.searchParams.get('type') === 'playlist') result = {
    list: [{dissid: '1001', dissname: '午后搜索歌单', nickname: 'Xmusic 编辑部', songnum: 3, listennum: 56000}], total: 1,
  };
  else if (url.pathname === '/api/search') result = {
          list: [
            {
              mid: "smoke001",
              title: "在线播放测试",
              singer: [{ name: "Xmusic 测试歌手" }],
              album: { name: "桌面测试专辑" },
              interval: 18,
            },
          ],
        };
  else if (url.pathname === '/api/song/url') result = {[url.searchParams.get('mid')]: `http://127.0.0.1:${port}/audio.wav`};
  else if (url.pathname === '/api/lyric') result = {lyric: url.searchParams.get('mid') === 'smoke001' && url.searchParams.get('qrc') === 'true' ? qrc : '[00:00.00]在线歌词已连接'};
  else if (url.pathname === '/api/top' && !url.searchParams.has('id')) result = {group: [{groupName: '官方榜', toplist: [
    {topId: 26, title: '热歌榜', period: '2026-10-02', listenNum: 1280000, song: [{title: '榜单测试歌曲', singerName: '榜单歌手'}]},
    {topId: 27, title: '新歌榜', period: '2026-10-02', song: [{title: '新歌榜测试歌曲', singerName: '新歌歌手'}]},
    {topId: 99, title: 'Global-K Chart'},
  ]}]};
  else if (url.pathname === '/api/top') result = {song: url.searchParams.get('id') === '26'
    ? [{songId: 201, title: '榜单测试歌曲', singerName: '榜单歌手', interval: 18}]
    : [{id: 202, mid: 'rank002', title: '新歌榜测试歌曲', singerName: '新歌歌手', interval: 18}]};
  else if (url.pathname === '/api/song/detail') result = url.searchParams.get('mid') === 'smoke001' ? {
    track_info: {id: 401, mid: 'smoke001', title: '在线播放测试', singer: [{name: 'Xmusic 测试歌手'}], album: {name: '桌面测试专辑'}, interval: 18},
    info: {
      lan: {content: [{value: '国语'}]}, genre: {content: [{value: '流行'}]},
      pub_time: {content: [{value: '2026-10-02'}]}, company: {content: [{value: 'Xmusic 测试唱片'}]},
      intro: {content: [{value: '用于验证与移动端一致的歌曲信息。'}]},
    },
  } : {id: 201, mid: 'rank001', title: '榜单测试歌曲', singer: [{name: '榜单歌手'}], interval: 18};
  else if (url.pathname === '/api/playlist') result = {dirinfo: {title: url.searchParams.get('id') === '1002' ? '华语精选' : '午后精选', desc: '收藏值得反复聆听的好音乐'}, songlist: [
    {id: 301, mid: 'playlist001', title: '歌单测试歌曲', singer: [{name: '歌单歌手'}], album: {name: '精选专辑'}, interval: 18},
    {id: 302, mid: 'playlist002', title: '歌单第二首', singer: [{name: '歌单歌手'}], album: {name: '精选专辑'}, interval: 18},
    {id: 303, mid: 'playlist003', title: '歌单第三首', singer: [{name: '歌单歌手'}], album: {name: '精选专辑'}, interval: 18},
  ]};
  else if (url.pathname === '/qq/categories') result = {categories: [
    {categoryGroupName: '语种', items: [{categoryId: 1, categoryName: '华语'}, {categoryId: 2, categoryName: '欧美'}]},
    {categoryGroupName: '心情', items: [{categoryId: 3, categoryName: '放松'}]},
  ]};
  else if (url.pathname === '/qq/playlists') {
    const category = url.searchParams.get('categoryId');
    const later = Number(url.searchParams.get('sin')) > 0;
    const item = category === '1' ? {dissid: later ? '1003' : '1002', dissname: later ? '华语续集' : '华语精选'} : category === '2' ? {dissid: '2001', dissname: '欧美精选'} : {dissid: '1001', dissname: '午后精选'};
    result = {list: [{...item, creator: {name: 'Xmusic 编辑部'}, listennum: 56000, songnum: 3}], sum: category === '1' ? 21 : 1};
  } else {
    response.writeHead(404, {'Content-Type': 'application/json'});
    response.end(JSON.stringify({code: 404, message: `Unknown smoke endpoint: ${url.pathname}`}));
    return;
  }
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ code: 0, data: result }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const environment = {
  ...process.env,
  XMUSIC_USER_DATA: userData,
  XMUSIC_HEADLESS: "1",
};
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.VITE_DEV_SERVER_URL;
let application;
const errors = [];

async function capture(page, name) {
  const target = path.join(testRoot, name);
  try {
    await page.screenshot({path: target, timeout: 2000});
  } catch (error) {
    // Static hidden Windows surfaces may need the first capture request to produce a frame.
    // Retry only that transient capture failure; a second failure still fails the test.
    if (error.name !== 'TimeoutError' && !error.message?.includes('UnknownVizError')) throw error;
    console.log(`Retrying hidden window capture: ${name}`);
    await page.screenshot({path: target, timeout: 20000});
  }
}

async function setRange(page, name, value) {
  await page.getByRole('slider', {name, exact: true}).evaluate((input, next) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(next));
    input.dispatchEvent(new Event('input', {bubbles: true}));
    input.dispatchEvent(new Event('change', {bubbles: true}));
  }, value);
}

async function waitForSwitch(page, name, checked) {
  await page.waitForFunction(({name, checked}) => {
    const control = [...document.querySelectorAll('[role="switch"]')].find(element => element.getAttribute('aria-label') === name);
    return control && !control.disabled && control.getAttribute('aria-checked') === String(checked);
  }, {name, checked});
}

async function seek(page, position) {
  await setRange(page, '播放进度', position);
  await page.waitForFunction(expected => !window.__smokeAudio.seeking && Math.abs(window.__smokeAudio.currentTime - expected) < 0.08, position);
}

async function fittedFloatingBounds(overlay) {
  await overlay.waitForFunction(async () => {
    const element = document.querySelector('.lyrics-window');
    const snapshot = await window.floatingLyrics.getSnapshot();
    return Number(element.dataset.fittedLayoutId) === snapshot.layoutId;
  });
  return application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Xmusic 桌面歌词').getBounds());
}

async function testClosePrompt(page, theme) {
  await page.getByRole('button', {name: '关闭窗口', exact: true}).click();
  const prompt = page.getByRole('dialog', {name: '关闭 Xmusic', exact: true});
  await prompt.waitFor();
  await prompt.getByRole('checkbox', {name: '记住我的选择', exact: true}).check();
  assert.equal(await page.evaluate(async () => (await window.desktop.getClosePrompt()).canHide), false);
  assert.equal(await prompt.getByRole('button', {name: '隐藏到托盘', exact: true}).count(), 0);
  assert.equal(await prompt.evaluate(element => {
    const reference = document.createElement('span');
    reference.style.background = 'var(--surface-raised)'; document.body.append(reference);
    const expected = getComputedStyle(reference).backgroundColor; reference.remove();
    return getComputedStyle(element).backgroundColor === expected;
  }), true, 'Close prompt uses the current theme surface');
  const initial = await page.evaluate(() => window.desktop.getClosePrompt());
  await page.evaluate(() => {window.desktop.close(); window.desktop.close();});
  assert.equal((await page.evaluate(() => window.desktop.getClosePrompt())).id, initial.id);
  assert.equal(await prompt.count(), 1);
  await capture(page, `19-close-prompt-${theme}.png`);
  await page.keyboard.press('Escape');
  await prompt.waitFor({state: 'detached'});
  assert.equal(await page.evaluate(() => window.desktop.getClosePrompt()), null);
  assert.equal(await page.evaluate(async () => (await window.desktop.getPreferences()).closeAction), 'ask', 'Cancel must never remember a close action');
  await page.getByRole('button', {name: '关闭窗口', exact: true}).click();
  await prompt.getByRole('button', {name: '取消', exact: true}).click();
  await prompt.waitFor({state: 'detached'});
}

async function assertFloatingTaskbarStyle(stage) {
  if (process.platform !== 'win32') return;
  const hwnd = await application.evaluate(({BrowserWindow}) => {
    const window = BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Xmusic 桌面歌词');
    const handle = window.getNativeWindowHandle();
    return (handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString();
  });
  assert.match(hwnd, /^\d{1,20}$/);
  // The command is fixed source, not interpolated shell text. Pass the native
  // handle as data in an environment variable and inspect its style read-only.
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class XmusicWindowStyle {
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
  private static extern IntPtr GetWindowLongPtr64(IntPtr window, int index);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
  private static extern int GetWindowLong32(IntPtr window, int index);
  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool IsWindow(IntPtr window);
  public static long Read(long handle) {
    IntPtr window = new IntPtr(handle);
    if (!IsWindow(window)) throw new InvalidOperationException("Floating HWND is no longer valid");
    return IntPtr.Size == 8 ? GetWindowLongPtr64(window, -20).ToInt64() : GetWindowLong32(window, -20);
  }
}
'@
$handleValue = [Int64]::Parse($env:XMUSIC_SMOKE_HWND, [Globalization.CultureInfo]::InvariantCulture)
$style = [XmusicWindowStyle]::Read($handleValue)
[pscustomobject]@{exStyle = $style; appWindow = (($style -band 0x40000) -ne 0); toolWindow = (($style -band 0x80) -ne 0)} | ConvertTo-Json -Compress
`;
  const {stdout} = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: {...process.env, XMUSIC_SMOKE_HWND: hwnd}, windowsHide: true, timeout: 15000, maxBuffer: 65536, encoding: 'utf8',
  });
  const style = JSON.parse(stdout.trim());
  assert.equal(style.appWindow, false, `${stage}: WS_EX_APPWINDOW must be absent (${style.exStyle})`);
  assert.equal(style.toolWindow, true, `${stage}: WS_EX_TOOLWINDOW must be present (${style.exStyle})`);
}

async function testDiscovery(page) {
  await page.locator('.sidebar .nav-item').filter({hasText: '我的歌单'}).click();
  await page.locator('.playlist-library-heading').getByRole('button', {name: '新建歌单', exact: true}).click();
  const createDialog = page.getByRole('dialog', {name: '新建歌单', exact: true});
  await createDialog.getByLabel('歌单名称', {exact: true}).fill(CUSTOM_PLAYLIST_NAME);
  await createDialog.getByRole('button', {name: '创建', exact: true}).click();
  await page.locator('.playlist-detail-header').getByRole('heading', {name: CUSTOM_PLAYLIST_NAME, exact: true}).waitFor();
  await page.waitForFunction(name => JSON.parse(localStorage.getItem('xmusic:playlistLibrary')).playlists.some(playlist => playlist.name === name && playlist.tracks.length === 0), CUSTOM_PLAYLIST_NAME);
  await page.locator('.sidebar .nav-item').filter({hasText: '探索音乐'}).click();
  await page.getByRole('region', {name: '官方榜单', exact: true}).getByRole('button', {name: '打开榜单 热歌榜', exact: true}).waitFor();
  await page.getByRole('button', {name: '打开歌单 午后精选', exact: true}).waitFor();
  assert.equal(await page.getByText('Global-K Chart', {exact: true}).count(), 0);
  assert.equal(await page.locator('.discovery-tabs .discovery-capsule').count(), 3);
  assert.equal(await page.locator('.hero').count(), 0);
  await capture(page, '11-explore-ranks-and-playlists.png');
  await page.getByRole('button', {name: '打开榜单 热歌榜', exact: true}).click();
  await page.getByRole('button', {name: '榜单测试歌曲', exact: true}).waitFor();
  await page.getByRole('button', {name: '新歌榜', exact: true}).click();
  await page.getByRole('button', {name: '新歌榜测试歌曲', exact: true}).waitFor();
  assert.equal(await page.getByRole('button', {name: '新歌榜', exact: true}).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByRole('button', {name: '榜单测试歌曲', exact: true}).count(), 0);
  await page.getByRole('button', {name: '热歌榜', exact: true}).click();
  await page.getByRole('button', {name: '榜单测试歌曲', exact: true}).click();
  await page.locator('.player-bar').getByRole('button', {name: '暂停', exact: true}).waitFor();
  await page.locator('.now-playing-text strong').filter({hasText: '榜单测试歌曲'}).waitFor();
  await page.locator('.player-bar').getByRole('button', {name: '暂停', exact: true}).click();
  assert.ok(requestDetails.some(request => request.path === '/api/song/detail' && request.params.id === '201'), 'ID-only chart tracks resolve through the real bridge');
  await page.locator('.discovery-tabs').getByRole('button', {name: '歌单', exact: true}).click();
  await page.getByRole('button', {name: '华语', exact: true}).click();
  await page.getByRole('button', {name: '打开歌单 华语精选', exact: true}).waitFor();
  assert.equal(await page.getByRole('button', {name: '华语', exact: true}).getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', {name: '加载更多歌单', exact: true}).click();
  await page.getByRole('button', {name: '打开歌单 华语续集', exact: true}).waitFor();
  await page.getByRole('button', {name: '欧美', exact: true}).click();
  await page.getByRole('button', {name: '打开歌单 欧美精选', exact: true}).waitFor();
  assert.equal(await page.getByRole('button', {name: '打开歌单 华语续集', exact: true}).count(), 0);
  await page.getByRole('button', {name: '全部分类', exact: true}).click();
  await page.locator('.discovery-category-panel').getByRole('heading', {name: '语种', exact: true}).waitFor();
  await capture(page, '12-playlist-category-capsules.png');
  await page.locator('.discovery-category-panel').getByRole('button', {name: '华语', exact: true}).click();
  await page.getByRole('button', {name: '打开歌单 华语精选', exact: true}).click();
  await page.locator('.discovery-playlist-detail').getByRole('heading', {name: '华语精选', exact: true}).waitFor();
  await page.getByRole('button', {name: '歌单测试歌曲', exact: true}).waitFor();
  await capture(page, '13-playlist-details.png');
  await page.locator('.discovery-playlist-detail').getByRole('button', {name: '收藏歌单', exact: true}).click();
  await page.locator('.discovery-playlist-detail').getByRole('button', {name: '取消收藏歌单', exact: true}).waitFor();
  await page.locator('.sidebar .nav-item').filter({hasText: '我的歌单'}).click();
  await page.locator('.playlist-library .discovery-tabs').getByRole('button', {name: '收藏歌单', exact: true}).click();
  await page.locator('.playlist-card-open').filter({hasText: '华语精选'}).click();
  await page.locator('.discovery-playlist-detail').getByRole('heading', {name: '华语精选', exact: true}).waitFor();
  assert.equal(await page.locator('.discovery-playlist-detail').getByRole('button', {name: '取消收藏歌单', exact: true}).getAttribute('aria-pressed'), 'true');
  await page.locator('.discovery-playlist-detail').getByRole('button', {name: '批量操作', exact: true}).click();
  await page.locator('.discovery-playlist-detail').getByRole('checkbox', {name: '全选', exact: true}).check();
  await page.locator('.discovery-playlist-detail .discovery-list-toolbar').getByRole('button', {name: '添加到歌单', exact: true}).click();
  const addDialog = page.getByRole('dialog', {name: '添加到歌单', exact: true});
  await addDialog.getByRole('radio', {name: new RegExp(CUSTOM_PLAYLIST_NAME)}).check();
  await addDialog.getByRole('button', {name: '添加', exact: true}).click();
  await addDialog.getByRole('status').filter({hasText: `已添加 3 首到「${CUSTOM_PLAYLIST_NAME}」`}).waitFor();
  await capture(page, '16-batch-add-to-custom-playlist.png');
  await addDialog.getByRole('button', {name: '完成', exact: true}).click();
  await page.locator('.discovery-playlist-detail').getByRole('button', {name: '播放全部', exact: true}).click();
  await page.locator('.now-playing-text strong').filter({hasText: '歌单测试歌曲'}).waitFor();
  await page.locator('.player-bar').getByRole('button', {name: '暂停', exact: true}).click();
  assert.ok(requestDetails.some(request => request.path === '/qq/playlists' && request.params.categoryId === '1' && request.params.sin === '20'));
  assert.ok(requestDetails.some(request => request.path === '/qq/categories'));
  assert.ok(requestDetails.some(request => request.path === '/api/playlist' && request.params.id === '1002'));
  await page.locator('.sidebar .nav-item').filter({hasText: '我的歌单'}).click();
  await page.locator('.playlist-card-open').filter({hasText: CUSTOM_PLAYLIST_NAME}).click();
  assert.equal(await page.locator('.playlist-library .discovery-track-row:not(.discovery-track-head)').count(), 3);
  await page.locator('.playlist-library').getByRole('button', {name: '批量操作', exact: true}).click();
  await page.locator('.playlist-library').getByRole('checkbox', {name: '选择 歌单第二首', exact: true}).check();
  await page.locator('.playlist-library').getByRole('checkbox', {name: '选择 歌单第三首', exact: true}).check();
  await page.locator('.playlist-library').getByRole('button', {name: '移出歌单', exact: true}).click();
  await page.waitForFunction(name => {
    const state = JSON.parse(localStorage.getItem('xmusic:playlistLibrary'));
    const playlist = state.playlists.find(item => item.name === name);
    return playlist?.tracks.length === 1 && playlist.tracks[0].mid === 'playlist001' && state.favoritePlaylists.some(item => item.id === '1002');
  }, CUSTOM_PLAYLIST_NAME);
  assert.equal(await page.locator('.playlist-library').getByRole('button', {name: '歌单第二首', exact: true}).count(), 0);
  assert.equal(await page.locator('.playlist-library').getByRole('button', {name: '歌单第三首', exact: true}).count(), 0);
  await page.locator('.playlist-library').getByRole('button', {name: '完成', exact: true}).click();
  await capture(page, '17-custom-playlist-after-batch-remove.png');
}

async function launch() {
  const executablePath = process.env.XMUSIC_EXECUTABLE;
  application = await electron.launch({
    ...(executablePath
      ? { executablePath, args: ["--mute-audio"] }
      : { args: [root, "--mute-audio"] }),
    cwd: root,
    env: environment,
    timeout: 30000,
  });
  const page = await application.firstWindow();
  // Keep the production IPC validation and response parsing. Only the two fixed
  // QQ discovery endpoints are redirected to deterministic local HTTP fixtures.
  await application.evaluate((_electron, fixtureBase) => {
    const fetch = globalThis.fetch;
    const routes = new Map([
      ['/splcloud/fcgi-bin/fcg_get_diss_tag_conf.fcg', '/qq/categories'],
      ['/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg', '/qq/playlists'],
    ]);
    globalThis.fetch = (input, options) => {
      const url = new URL(String(input));
      const route = url.hostname === 'c.y.qq.com' ? routes.get(url.pathname) : undefined;
      return fetch(route ? `${fixtureBase}${route}${url.search}` : input, options);
    };
  }, `http://127.0.0.1:${server.address().port}`);
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator(".track-section").waitFor();
  assert.equal(await page.locator('.hero').count(), 0);
  assert.equal((await page.locator('.titlebar-name').innerText()).trim(), 'Xmusic');
  await page.evaluate(() => {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      window.__smokeAudio = this;
      return play.apply(this, args);
    };
  });
  return page;
}

try {
  let page = await launch();
  await page.getByRole('button', {name: '切换到浅色主题', exact: true}).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.getByRole('button', {name: '切换到深色主题', exact: true}).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.equal(
    await page.evaluate(() => typeof window.desktop?.importAudio),
    "function"
  );
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  await page.getByText("把你的第一首音乐放进来", { exact: true }).waitFor();
  await capture(page, "01-empty.png");
  await application.evaluate(({ dialog }, selectedPath) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [selectedPath],
    });
  }, audioPath);
  await page.getByRole("button", { name: "导入本地音乐", exact: true }).click();
  await page
    .getByRole("button", { name: "Windows 播放测试", exact: true })
    .waitFor();
  assert.equal(
    await page.locator(".track-section .discovery-track-row:not(.discovery-track-head)").count(),
    1
  );
  assert.equal(await page.evaluate(async () => (await window.desktop.getLocalTracks())[0].duration), 18);
  // A newly downloaded sidecar should appear immediately when reimported by folder.
  await writeFile(audioPath.replace(/\.wav$/, '.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1kAAAAASUVORK5CYII=', 'base64'));
  await application.evaluate(({dialog}, directory) => {
    dialog.showOpenDialog = async () => ({canceled: false, filePaths: [directory]});
  }, audioDirectory);
  await page.getByRole('button', {name: '导入文件夹', exact: true}).click();
  await page.waitForFunction(() => {
    const cover = document.querySelector('.track-section img[src^="xmusic-audio://cover/"]');
    return cover?.complete && cover.naturalWidth > 0;
  });
  assert.equal(await page.evaluate(async () => (await window.desktop.getLocalTracks()).length), 1);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.track-section h2')).userSelect), 'none');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.global-search input')).userSelect), 'text');
  await page
    .getByRole("button", { name: "Windows 播放测试", exact: true })
    .click();
  await page.getByRole("button", { name: "暂停", exact: true }).waitFor();
  await page.waitForFunction(
    () => Number(document.querySelector('[aria-label="播放进度"]').value) > 0.1
  );
  assert.ok(
    Number(
      await page.getByRole("slider", { name: "播放进度" }).getAttribute("max")
    ) >= 17
  );
  await page.getByRole("button", { name: "显示歌词", exact: true }).click();
  assert.equal(await page.locator('.expanded-header button').count(), 1);
  await page.locator('.player-bar').getByRole('button', {name: '开启桌面歌词', exact: true}).waitFor();
  await page
    .getByRole("button", { name: "听见 Windows 的旋律", exact: true })
    .click();
  await page.waitForFunction(
    () => Number(document.querySelector('[aria-label="播放进度"]').value) >= 5
  );
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  const pausedAt = Number(
    await page.getByRole("slider", { name: "播放进度" }).inputValue()
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(
    Math.abs(
      Number(
        await page.getByRole("slider", { name: "播放进度" }).inputValue()
      ) - pausedAt
    ) < 0.15
  );
  await page.getByRole("button", { name: "喜欢当前歌曲", exact: true }).click();
  assert.ok((await page.locator('.expanded-player').boundingBox()).width >= 990);
  await page.getByRole('button', {name: '放大歌词字号', exact: true}).click();
  assert.equal(await page.getByLabel('歌词字号', {exact: true}).textContent(), '28');
  await page.getByRole('tab', {name: '歌曲详情', exact: true}).click();
  await page.getByRole('tabpanel', {name: '歌曲详情', exact: true}).getByText('本地文件', {exact: true}).waitFor();
  await page.getByRole('tab', {name: '歌词', exact: true}).click();
  await capture(page, "02-local-lyrics.png");
  await page.getByRole("button", { name: "收起歌曲详情", exact: true }).click();
  await page.getByRole("button", { name: "显示歌词", exact: true }).click();
  await page.keyboard.press('Control+f');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '搜索在线音乐');
  assert.equal(await page.locator('.expanded-player').count(), 0);
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('textbox', {name: '搜索在线音乐'}).evaluate(input => input === document.activeElement), true);
  await page
    .getByRole("button", { name: "播放队列，1 首", exact: true })
    .click();
  assert.equal(await page.locator(".queue-item").count(), 1);
  await page.getByRole("button", { name: "收起面板", exact: true }).click();

  // Canceled native import must leave both library and current song intact.
  await application.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await page.getByRole("button", { name: "导入本地音乐", exact: true }).click();
  assert.equal(
    await page.locator(".track-section .discovery-track-row:not(.discovery-track-head)").count(),
    1
  );

  await page.locator(".sidebar .nav-item").filter({ hasText: "设置" }).click();
  assert.equal(await page.getByLabel('自定义音乐接口', {exact: true}).count(), 0);
  for (let count = 0; count < 5; count++) await page.getByRole('button', {name: /^版本 v/}).click();
  await page.getByRole('dialog', {name: '开发者模式', exact: true}).getByLabel('开发者密钥').fill('XG2020');
  await page.getByRole('button', {name: '进入开发者模式', exact: true}).click();
  await page.getByLabel('自定义音乐接口', {exact: true}).waitFor();
  assert.equal(await page.getByRole('link', {name: 'by XG.GM', exact: true}).getAttribute('href'), 'https://github.com/XG2020/Xmusic_App');
  assert.match(await page.getByRole('combobox', {name: '默认下载音质', exact: true}).innerText(), /无损/);
  await page.getByRole('combobox', {name: '默认下载音质', exact: true}).click();
  await page.getByRole('option', {name: '标准 · 128 kbps', exact: true}).click();
  await page.getByRole('combobox', {name: '歌词字体', exact: true}).click();
  await page.getByRole('option', {name: '宋体', exact: true}).click();
  await page.getByRole('switch', {name: '下载时同时下载封面', exact: true}).uncheck();
  await page.getByRole('switch', {name: '下载时同时下载歌词', exact: true}).uncheck();
  // Native preferences update after IPC and disk persistence, so check the
  // rendered switch once the save completes instead of immediately on click.
  await page.getByRole('switch', {name: '启用快捷键', exact: true}).click();
  await waitForSwitch(page, '启用快捷键', false);
  await page.waitForFunction(async () => !(await window.desktop.getPreferences()).shortcutsEnabled);
  assert.equal(await application.evaluate(({globalShortcut}) => globalShortcut.isRegistered('CommandOrControl+Alt+L') || globalShortcut.isRegistered('CommandOrControl+Alt+U')), false);
  await page.getByRole('switch', {name: '启用快捷键', exact: true}).click();
  await waitForSwitch(page, '启用快捷键', true);
  await page.waitForFunction(async () => (await window.desktop.getPreferences()).shortcutsEnabled);
  await page.getByRole('radio', {name: '浅色', exact: true}).check();
  await page.getByLabel('自定义主题色', {exact: true}).fill('#ff8800');
  await page.getByLabel('自定义主题色', {exact: true}).press('Enter');
  await page.getByRole('switch', {name: '自定义浅色背景', exact: true}).check();
  await page.getByLabel('背景底色', {exact: true}).fill('#f7f2ff');
  await page.getByLabel('背景底色', {exact: true}).press('Enter');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent-fill').trim()), '#ff8800');
  const imageBytes = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1280; canvas.height = 720;
    const context = canvas.getContext('2d');
    const gradient = context.createLinearGradient(0, 0, 1280, 720);
    gradient.addColorStop(0, '#f5b76e'); gradient.addColorStop(0.45, '#8f7adc'); gradient.addColorStop(1, '#184657');
    context.fillStyle = gradient; context.fillRect(0, 0, 1280, 720);
    context.fillStyle = '#ffffffcc'; context.beginPath(); context.arc(950, 220, 170, 0, Math.PI * 2); context.fill();
    context.fillStyle = '#132536cc'; context.beginPath(); context.moveTo(0, 620); context.lineTo(400, 200); context.lineTo(790, 720); context.lineTo(0, 720); context.fill();
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await writeFile(backgroundPath, Buffer.from(imageBytes, 'base64'));
  const floatingImageBytes = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 180;
    const context = canvas.getContext('2d');
    const gradient = context.createLinearGradient(0, 0, 800, 180);
    gradient.addColorStop(0, '#204c65'); gradient.addColorStop(1, '#a55867');
    context.fillStyle = gradient; context.fillRect(0, 0, 800, 180);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await writeFile(floatingBackgroundPath, Buffer.from(floatingImageBytes, 'base64'));
  await page.getByLabel('选择背景图片', {exact: true}).setInputFiles({name: 'invalid.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')});
  await page.getByRole('alert').filter({hasText: '请选择 JPG、PNG 或 WebP 图片。'}).waitFor();
  await page.getByLabel('选择背景图片', {exact: true}).setInputFiles(backgroundPath);
  await page.waitForFunction(() => document.documentElement.dataset.backgroundImage === 'true');
  const customBackground = await page.evaluate(() => JSON.parse(localStorage.getItem('xmusic:theme')).backgroundImages.light);
  assert.match(customBackground, /^data:image\/(png|jpeg|webp);base64,/);
  assert.ok(customBackground.length <= 850000);
  assert.equal(await page.locator('.app-shell').evaluate(element => getComputedStyle(element, '::before').backgroundImage.includes('data:image/')), true);
  assert.ok(await page.evaluate(() => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--page-image-mask').trim().slice(-2), 16) >= 166));
  await page.getByRole('radio', {name: '深色', exact: true}).check();
  await page.waitForFunction(() => document.documentElement.dataset.backgroundImage === 'false');
  await page.getByRole('radio', {name: '浅色', exact: true}).check();
  await page.waitForFunction(() => document.documentElement.dataset.backgroundImage === 'true');
  await capture(page, '04-custom-light-theme.png');
  await testClosePrompt(page, 'light');

  const overlayCreated = application.waitForEvent('window');
  await page.locator('.player-bar').getByRole('button', {name: '开启桌面歌词', exact: true}).click();
  const overlay = await overlayCreated;
  overlay.setDefaultTimeout(20000);
  overlay.on('pageerror', error => errors.push(error.message));
  await overlay.locator('#current-line').filter({hasText: '听见 Windows 的旋律'}).waitFor();
  await overlay.waitForFunction(async () => (await window.floatingLyrics.getSnapshot()).content.fontFamily === 'SimSun');
  assert.equal(await overlay.evaluate(() => typeof window.desktop), 'undefined');
  assert.equal(await overlay.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Xmusic 桌面歌词').isAlwaysOnTop()), true);
  const compactBounds = await fittedFloatingBounds(overlay);
  // Windows fractional scaling rounds logical bounds through native pixels.
  // Permit that fixed 0–3 DIP adjustment, but never growth on repeated opens.
  assert.ok(compactBounds.width >= 560 && compactBounds.width <= 563);
  assert.ok(compactBounds.height >= 144 && compactBounds.height <= 147, 'Manual window size reserves space for the toolbar above its background');
  assert.equal(await overlay.locator('.toolbar').evaluate(element => getComputedStyle(element).position), 'absolute');
  assert.equal(await overlay.evaluate(() => document.querySelector('.toolbar').getBoundingClientRect().bottom <= document.querySelector('.lyrics-background').getBoundingClientRect().top), true);
  assert.equal(await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Xmusic 桌面歌词').isResizable()), true);
  for (let count = 0; count < 3; count++) {
    await page.evaluate(() => window.desktop.setDesktopLyricsVisible(false));
    await page.evaluate(() => window.desktop.setDesktopLyricsVisible(true));
    assert.deepEqual(await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Xmusic 桌面歌词').getBounds()), compactBounds, 'Reopening must not accumulate DPI readback rounding');
  }
  await assertFloatingTaskbarStyle('first open');
  assert.equal(await overlay.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--background-image').trim()), 'none', 'Main background must not become the floating background');
  await page.getByLabel('选择悬浮歌词背景图片', {exact: true}).setInputFiles(floatingBackgroundPath);
  await overlay.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--background-image').includes('data:image/'));
  const floatingBackground = await page.evaluate(() => JSON.parse(localStorage.getItem('xmusic:theme')).floatingBackgroundImage);
  assert.notEqual(floatingBackground, customBackground);
  assert.equal(await overlay.locator('[data-command]').evaluateAll(buttons => buttons.every(button => button.querySelector('svg') && !button.textContent.trim())), true);
  await setRange(page, '悬浮背景不透明度', 0);
  await overlay.waitForFunction(() => getComputedStyle(document.querySelector('.lyrics-background')).opacity === '0');
  assert.equal(await overlay.locator('#current-line').evaluate(element => getComputedStyle(element).opacity), '1');
  assert.equal(await overlay.locator('.lyrics-window').evaluate(element => getComputedStyle(element).opacity), '1');
  await setRange(page, '悬浮背景不透明度', 0.35);
  await overlay.waitForFunction(() => getComputedStyle(document.querySelector('.lyrics-background')).opacity === '0.35');
  await page.getByRole('button', {name: '移除图片', exact: true}).click();
  assert.equal(await overlay.evaluate(expected => getComputedStyle(document.documentElement).getPropertyValue('--background-image').includes(expected), floatingBackground), true);
  await page.getByLabel('选择背景图片', {exact: true}).setInputFiles(backgroundPath);
  await page.getByRole('button', {name: '移除悬浮背景', exact: true}).click();
  await overlay.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--background-image').trim() === 'none');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('xmusic:theme')).backgroundImages.light), customBackground);
  await page.getByLabel('选择悬浮歌词背景图片', {exact: true}).setInputFiles(floatingBackgroundPath);
  await overlay.waitForFunction(() => getComputedStyle(document.querySelector('.lyrics-background')).backgroundImage.includes('data:image/'));
  await page.getByRole('radio', {name: '深色', exact: true}).check();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('xmusic:theme')).floatingBackgroundImage), floatingBackground);
  await testClosePrompt(page, 'dark');
  await page.getByRole('radio', {name: '浅色', exact: true}).check();
  await capture(overlay, '05-desktop-lyrics.png');
  await page.getByRole('switch', {name: '单行左右显示', exact: true}).check();
  await overlay.waitForFunction(async () => (await window.floatingLyrics.getSnapshot()).content.singleLine);
  const singleBounds = await fittedFloatingBounds(overlay);
  assert.equal(singleBounds.height, compactBounds.height, 'Line mode must preserve the manually chosen size');
  assert.equal(await overlay.evaluate(() => {
    const current = document.getElementById('current-line').getBoundingClientRect();
    const next = document.getElementById('next-line').getBoundingClientRect();
    return Math.abs(current.top - next.top) < 2 && next.left > current.left && next.width > 0;
  }), true, 'Single-line mode shows the current sentence left and the next sentence right');
  assert.equal(await overlay.evaluate(() => [...document.querySelectorAll('#current-line, #next-line')].every(line => line.scrollLeft === 0 && line.scrollWidth <= line.clientWidth + 1)), true, 'Both sentences fit completely without scrolling');
  await setRange(page, '悬浮背景圆角', 28);
  await overlay.waitForFunction(() => getComputedStyle(document.querySelector('.lyrics-background')).borderTopLeftRadius === '28px');
  await capture(overlay, '20-single-row-rounded-lyrics.png');
  await page.getByRole('switch', {name: '单行左右显示', exact: true}).uncheck();
  await overlay.waitForFunction(async () => !(await window.floatingLyrics.getSnapshot()).content.singleLine);
  await fittedFloatingBounds(overlay);
  await page.getByRole('slider', {name: '悬浮歌词字号', exact: true}).focus();
  await page.keyboard.press('End');
  await overlay.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--font-size').trim() === '60px');
  const largeHeight = (await fittedFloatingBounds(overlay)).height;
  assert.ok(largeHeight >= 182, 'The background must expand enough to fit both lines at the configured 60px font');
  assert.equal(await overlay.locator('#current-line').evaluate(element => getComputedStyle(element).fontSize), '60px', 'Increasing font size must affect actual text, not only the setting');
  await capture(overlay, '07-large-desktop-lyrics.png');
  await setRange(page, '悬浮歌词字号', 30);
  await overlay.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--font-size').trim() === '30px');
  const compactAfterFontChange = await fittedFloatingBounds(overlay);
  assert.equal(compactAfterFontChange.width, compactBounds.width);
  assert.ok(Math.abs(compactAfterFontChange.height - compactBounds.height) <= 1, 'Reducing the font must restore the compact height');
  // Click-through lock is recovered from the main window, never requiring overlay input.
  await overlay.locator('#current-line').hover();
  await overlay.getByRole('button', {name: '锁定并穿透鼠标', exact: true}).click({force: true});
  await waitForSwitch(page, '锁定与鼠标穿透', true);
  await page.getByRole('switch', {name: '锁定与鼠标穿透', exact: true}).click();
  await waitForSwitch(page, '锁定与鼠标穿透', false);
  assert.equal(await page.evaluate(async () => (await window.desktop.getDesktopLyricsState()).locked), false);
  await assertFloatingTaskbarStyle('after unlocking');
  await overlay.locator('#current-line').hover();
  await overlay.getByRole('button', {name: '播放', exact: true}).click({force: true});
  await page.getByRole('button', {name: '暂停', exact: true}).waitFor();
  await page.getByRole('button', {name: '暂停', exact: true}).click();
  await overlay.getByRole('button', {name: '关闭桌面歌词', exact: true}).click({force: true});
  await page.waitForFunction(async () => !(await window.desktop.getDesktopLyricsState()).visible);
  await page
    .getByLabel("自定义音乐接口", { exact: true })
    .fill(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await testDiscovery(page);
  await page.getByRole("textbox", { name: "搜索在线音乐" }).fill("测试");
  await page.getByRole("textbox", { name: "搜索在线音乐" }).press("Enter");
  await page.getByRole('group', {name: '搜索类型'}).getByRole('button', {name: '歌单', exact: true}).click();
  await page.getByRole('button', {name: '打开歌单 午后搜索歌单', exact: true}).click();
  await page.getByRole('button', {name: '返回搜索结果', exact: true}).click();
  await page.getByRole('button', {name: '打开歌单 午后搜索歌单', exact: true}).waitFor();
  await page.getByRole('group', {name: '搜索类型'}).getByRole('button', {name: '歌曲', exact: true}).click();
  assert.ok(requestDetails.some(request => request.path === '/api/search' && request.params.type === 'playlist' && request.params.num === '20'));
  await page.getByRole("button", { name: "在线播放测试", exact: true }).click();
  await page.getByRole("button", { name: "暂停", exact: true }).waitFor();
  await page.waitForFunction(
    () => Number(document.querySelector('[aria-label="播放进度"]').value) > 0.1
  );
  await page.getByRole("button", { name: "显示歌词", exact: true }).click();
  await page
    .getByRole("button", { name: "在线歌词已连接", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  assert.ok(requestDetails.some(request => request.path === '/api/lyric' && request.params.mid === 'smoke001' && request.params.qrc === 'true'));
  assert.equal(await page.getByText('通过底部播放栏切歌、拖动进度或调整音量。', {exact: true}).count(), 0);
  assert.equal(await page.getByText('点击歌词跳转播放 · 滚动可自由浏览', {exact: true}).count(), 0);
  assert.notEqual(await page.locator('.expanded-player').evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)', 'The expanded player must cover the underlying page');
  assert.equal(await page.locator('.expanded-player').evaluate(element => getComputedStyle(element).backgroundImage.includes('linear-gradient') && getComputedStyle(element).backgroundImage.includes('data:image/')), true);
  await page.locator('.player-bar').getByRole('button', {name: '开启桌面歌词', exact: true}).click();
  await overlay.locator('#current-line').filter({hasText: '在线歌词已连接'}).waitFor();
  await seek(page, 3);
  await page.waitForFunction(() => {
    const words = document.querySelectorAll('.detail-lyric-line.active .detail-lyric-word');
    return words.length === 7 && Math.abs(parseFloat(words[3].style.getPropertyValue('--word-progress')) - 75) < 1;
  });
  await overlay.waitForFunction(() => {
    const words = document.querySelectorAll('#current-line .lyric-word');
    return words.length === 7 && Math.abs(parseFloat(words[3].style.getPropertyValue('--word-progress')) - 75) < 1;
  });
  const mainProgress = () => page.locator('.detail-lyric-line.active .detail-lyric-word').evaluateAll(words => words.map(word => parseFloat(word.style.getPropertyValue('--word-progress'))));
  const floatingProgress = () => overlay.locator('#current-line .lyric-word').evaluateAll(words => words.map(word => parseFloat(word.style.getPropertyValue('--word-progress'))));
  const pausedWords = await mainProgress();
  const pausedFloatingWords = await floatingProgress();
  assert.deepEqual(pausedWords.slice(0, 3), [100, 100, 100]);
  assert.deepEqual(pausedWords.slice(4), [0, 0, 0]);
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.deepEqual(await mainProgress(), pausedWords, 'QRC progress must freeze when paused');
  assert.deepEqual(await floatingProgress(), pausedFloatingWords, 'Floating QRC progress must freeze when paused');
  await capture(page, '14-qrc-word-progress.png');
  await capture(overlay, '15-qrc-floating-progress.png');
  await page.locator('.player-bar').getByRole('button', {name: '播放', exact: true}).click();
  await page.waitForFunction(() => parseFloat(document.querySelectorAll('.detail-lyric-line.active .detail-lyric-word')[3]?.style.getPropertyValue('--word-progress')) > 80);
  await overlay.waitForFunction(() => parseFloat(document.querySelectorAll('#current-line .lyric-word')[3]?.style.getPropertyValue('--word-progress')) > 80);
  await page.locator('.player-bar').getByRole('button', {name: '暂停', exact: true}).click();
  await seek(page, 0.4);
  await page.waitForFunction(() => {
    const words = document.querySelectorAll('.detail-lyric-line.active .detail-lyric-word');
    return words.length === 7 && Math.abs(parseFloat(words[0].style.getPropertyValue('--word-progress')) - 50) < 1 && parseFloat(words[1].style.getPropertyValue('--word-progress')) === 0;
  });
  await overlay.waitForFunction(() => {
    const words = document.querySelectorAll('#current-line .lyric-word');
    return words.length === 7 && Math.abs(parseFloat(words[0].style.getPropertyValue('--word-progress')) - 50) < 1 && parseFloat(words[1].style.getPropertyValue('--word-progress')) === 0;
  });
  await page.getByRole('button', {name: '逐字渲染中', exact: true}).click();
  await page.waitForFunction(() => Math.abs(window.__smokeAudio.currentTime - 6) < 0.08 && window.__smokeAudio.paused);
  await overlay.locator('#current-line').filter({hasText: '逐字渲染中'}).waitFor();
  assert.equal(await page.locator('.detail-lyric-line.active').innerText(), '逐字渲染中');
  await page.locator('.player-bar').getByRole('button', {name: '关闭桌面歌词', exact: true}).click();
  await capture(page, "03-online.png");
  await page.getByRole('tab', {name: '歌曲详情', exact: true}).click();
  const songInfo = page.getByRole('tabpanel', {name: '歌曲详情', exact: true});
  await songInfo.getByRole('region', {name: '基础信息', exact: true}).getByText('国语', {exact: true}).waitFor();
  await songInfo.getByText('流行', {exact: true}).waitFor();
  await songInfo.getByText('2026-10-02', {exact: true}).waitFor();
  await songInfo.getByRole('region', {name: '更多信息', exact: true}).getByText('Xmusic 测试唱片', {exact: true}).waitFor();
  await songInfo.getByRole('region', {name: '简介', exact: true}).getByText('用于验证与移动端一致的歌曲信息。', {exact: true}).waitFor();
  assert.ok(requestDetails.some(request => request.path === '/api/song/detail' && request.params.mid === 'smoke001'));
  await capture(page, '21-mobile-style-song-information.png');
  await page.getByRole('tab', {name: '歌词', exact: true}).click();
  await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().find(window => window.getTitle() !== 'Xmusic 桌面歌词').setSize(1000, 680));
  await capture(page, '06-expanded-small-window.png');
  await page.getByRole('button', {name: '收起歌曲详情', exact: true}).click();
  const settingsBounds = await page.locator('.sidebar .nav-item').filter({hasText: '设置'}).boundingBox();
  const playerBounds = await page.locator('.player-bar').boundingBox();
  assert.ok(settingsBounds && playerBounds && settingsBounds.y + settingsBounds.height <= playerBounds.y, 'Settings must remain accessible at the minimum window height');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  // Changing preferred quality reloads the stream without losing the paused position.
  const positionBeforeQuality = await page.evaluate(() => window.__smokeAudio.currentTime);
  await page.getByRole('button', {name: '选择音质', exact: true}).click();
  await page.getByRole('button', {name: /^标准音质/}).click();
  await page.waitForFunction(() => window.__smokeAudio.readyState > 0 && !window.__smokeAudio.seeking && JSON.parse(localStorage.getItem('xmusic:quality')) === '128');
  assert.ok(qualityRequests.includes('128'));
  assert.equal(await page.evaluate(() => window.__smokeAudio.paused), true);
  const positionAfterQuality = await page.evaluate(() => window.__smokeAudio.currentTime);
  assert.ok(Math.abs(positionAfterQuality - positionBeforeQuality) < 0.2, `Quality seek changed ${positionBeforeQuality} to ${positionAfterQuality}`);
  await page.getByRole('button', {name: '播放速度，当前 1 倍', exact: true}).click();
  await page.getByRole('button', {name: '1.5×', exact: true}).click();
  assert.equal(await page.evaluate(() => window.__smokeAudio.playbackRate), 1.5);
  assert.equal(await page.evaluate(() => window.__smokeAudio.preservesPitch), true);
  await page.getByRole('button', {name: '播放', exact: true}).click();
  await page.getByRole('button', {name: '暂停', exact: true}).waitFor();
  await page.clock.install();
  await page.getByRole('button', {name: '睡眠定时', exact: true}).click();
  await page.getByLabel('自定义分钟', {exact: true}).fill('1');
  await page.getByRole('button', {name: '开始计时', exact: true}).click();
  await capture(page, '08-sleep-timer-small-window.png');
  await page.clock.fastForward(61000);
  await page.getByText('睡眠定时已结束，播放已暂停。', {exact: true}).waitFor({state: 'attached'});
  assert.equal(await page.evaluate(() => window.__smokeAudio.paused), true);
  await page.getByRole('button', {name: '15 分钟', exact: true}).click();
  await page.getByRole('button', {name: '取消定时', exact: true}).click();
  await page.getByRole('button', {name: '关闭播放设置', exact: true}).click();

  // Downloads use a selected isolated directory and real HTTP audio bytes.
  await page.locator('.sidebar .nav-item').filter({hasText: '下载管理'}).click();
  assert.equal(await page.getByRole('button', {name: '更改文件夹', exact: true}).count(), 0);
  await page.getByRole('button', {name: '清除下载记录', exact: true}).waitFor();
  await page.locator('.sidebar .nav-item').filter({hasText: '设置'}).click();
  await application.evaluate(({dialog}, directory) => {
    dialog.showOpenDialog = async () => ({canceled: false, filePaths: [directory]});
  }, downloadDirectory);
  await page.getByRole('button', {name: '更改文件夹', exact: true}).click();
  await page.waitForFunction(async directory => (await window.desktop.getDownloads()).directory === directory, downloadDirectory);
  await page.getByRole('region', {name: '下载设置', exact: true}).scrollIntoViewIfNeeded();
  await capture(page, '10-download-settings.png');
  await page.getByRole('button', {name: '下载当前歌曲', exact: true}).click();
  await page.getByRole('article', {name: '在线播放测试，已完成', exact: true}).waitFor();
  const completedDownload = await page.evaluate(async () => (await window.desktop.getDownloads()).tasks[0]);
  assert.equal(completedDownload.quality, '128');
  assert.equal(completedDownload.receivedBytes, wav.length);
  assert.deepEqual(await readFile(path.join(downloadDirectory, completedDownload.fileName)), wav);
  await page.getByRole('button', {name: '导入本地音乐', exact: true}).filter({hasText: '导入本地音乐'}).click();
  await page.getByRole('button', {name: '重新导入', exact: true}).waitFor();
  await capture(page, '09-download-complete.png');
  for (const endpoint of [
    "/api/search",
    "/api/song/url",
    "/api/lyric",
    "/audio.wav",
  ])
    assert.ok(requests.includes(endpoint), endpoint);
  assert.deepEqual(errors, []);

  const savedBounds = await application.evaluate(({BrowserWindow, screen}) => {
    const window = BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Xmusic 桌面歌词');
    const area = screen.getPrimaryDisplay().workArea;
    window.setBounds({x: area.x + 20, y: area.y + 30, width: 720, height: 180});
    return window.getBounds();
  });
  await page.evaluate(() => window.desktop.setDesktopLyricsLocked(true));

  // Restart the same isolated profile: queue/favorites/local library persist, but audio stays paused.
  await application.close();
  application = undefined;
  page = await launch();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('xmusic:theme')).accent), '#ff8800');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('xmusic:theme')).backgroundImages.light), customBackground);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('xmusic:theme')).backgroundImages.dark), null);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('xmusic:theme')).floatingBackgroundImage), floatingBackground);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('xmusic:floatingLyricsRadius'))), 28);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('xmusic:lyricFontFamily'))), 'SimSun');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.backgroundImage), 'true');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('xmusic:playbackRate'))), 1.5);
  assert.equal(await page.evaluate(async () => (await window.desktop.getDownloads()).tasks[0].status), 'completed');
  assert.equal(await page.evaluate(async () => (await window.desktop.getDownloads()).directory), downloadDirectory);
  await page.getByRole('button', {name: '睡眠定时', exact: true}).waitFor();
  assert.deepEqual(await page.evaluate(() => window.desktop.getDesktopLyricsState()), {visible: false, locked: true});
  const restoredOverlayCreated = application.waitForEvent('window');
  await page.locator('.player-bar').getByRole('button', {name: '开启桌面歌词', exact: true}).click();
  const restoredOverlay = await restoredOverlayCreated;
  await restoredOverlay.locator('#current-line').waitFor();
  await restoredOverlay.waitForFunction(expected => getComputedStyle(document.documentElement).getPropertyValue('--background-image').includes(expected), floatingBackground);
  assert.equal(await restoredOverlay.locator('.lyrics-background').evaluate(element => getComputedStyle(element).opacity), '0.35');
  await assertFloatingTaskbarStyle('reopened after restart');
  const restoredBounds = await fittedFloatingBounds(restoredOverlay);
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(restoredBounds[key] - savedBounds[key]) <= 1, `Saved ${key} may differ only by native pixel rounding after restart`);
  await page.locator('.player-bar').getByRole('button', {name: '关闭桌面歌词', exact: true}).click();
  await page
    .getByRole("button", { name: "Windows 播放测试", exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "暂停", exact: true }).count(),
    0
  );
  const restoredPlaylists = await page.evaluate(() => JSON.parse(localStorage.getItem('xmusic:playlistLibrary')));
  const restoredCustomPlaylist = restoredPlaylists.playlists.find(playlist => playlist.name === CUSTOM_PLAYLIST_NAME);
  assert.ok(restoredCustomPlaylist, 'Created playlist persists after restart');
  assert.deepEqual(restoredCustomPlaylist.tracks.map(track => track.mid), ['playlist001'], 'Batch removal persists without losing unselected songs');
  assert.ok(restoredPlaylists.favoritePlaylists.some(playlist => playlist.id === '1002' && playlist.title === '华语精选'));
  await page.locator('.sidebar .nav-item').filter({hasText: '我的歌单'}).click();
  await page.locator('.playlist-card-open').filter({hasText: CUSTOM_PLAYLIST_NAME}).click();
  await page.locator('.playlist-library').getByRole('button', {name: '歌单测试歌曲', exact: true}).waitFor();
  assert.equal(await page.locator('.playlist-library .discovery-track-row:not(.discovery-track-head)').count(), 1);
  await capture(page, '18-restored-custom-playlist.png');
  await page.getByRole('button', {name: '返回我的歌单', exact: true}).click();
  await page.locator('.playlist-library .discovery-tabs').getByRole('button', {name: '收藏歌单', exact: true}).click();
  await page.locator('.playlist-card-open').filter({hasText: '华语精选'}).click();
  await page.locator('.discovery-playlist-detail').getByRole('heading', {name: '华语精选', exact: true}).waitFor();
  await page.locator('.discovery-playlist-detail').getByRole('button', {name: '取消收藏歌单', exact: true}).waitFor();
  await page.locator('.discovery-playlist-detail').getByRole('button', {name: '歌单第三首', exact: true}).waitFor();
  await page
    .locator(".sidebar .nav-item")
    .filter({ hasText: "我喜欢的音乐" })
    .click();
  await page
    .getByRole("button", { name: "Windows 播放测试", exact: true })
    .waitFor();
  await page
    .locator(".sidebar .nav-item")
    .filter({ hasText: "本地音乐" })
    .click();
  await page
    .getByRole("button", { name: "从音乐库移除 Windows 播放测试", exact: true })
    .click();
  await page.waitForFunction(async () => (await window.desktop.getLocalTracks()).length === 1);
  await access(audioPath);
  await page.locator('.sidebar .nav-item').filter({hasText: '下载管理'}).click();
  await page.getByRole('button', {name: '清除下载记录', exact: true}).click();
  await page.waitForFunction(async () => (await window.desktop.getDownloads()).tasks.length === 0);
  await access(path.join(downloadDirectory, completedDownload.fileName));
  const audioRequestsBeforeOffline = requests.filter(value => value === '/api/song/url' || value === '/audio.wav').length;
  const offlineUrl = await page.evaluate(() => window.desktop.resolveDownloadedAudio({mid: 'smoke001', quality: '128'}));
  assert.ok(offlineUrl, 'Downloaded song must remain available after history cleanup');
  const offlineRange = await application.evaluate(async ({net}, url) => {
    // The renderer permits this scheme for media, while its connect-src stays
    // restricted. Verify bytes through the same registered Electron session.
    const response = await net.fetch(url, {headers: {Range: 'bytes=12-63'}});
    return {url, status: response.status, bytes: [...new Uint8Array(await response.arrayBuffer())]};
  }, offlineUrl);
  assert.match(offlineRange.url, /^xmusic-audio:\/\/track\//);
  assert.equal(offlineRange.status, 206);
  assert.deepEqual(Buffer.from(offlineRange.bytes), wav.subarray(12, 64));
  assert.equal(requests.filter(value => value === '/api/song/url' || value === '/audio.wav').length, audioRequestsBeforeOffline);
  await page.locator('.sidebar .nav-item').filter({hasText: '我的歌单'}).click();
  await page.getByRole('button', {name: '导入 QQ 歌单', exact: true}).click();
  const importDialog = page.getByRole('dialog', {name: '导入 QQ 音乐歌单', exact: true});
  await importDialog.getByLabel('分享链接或歌单 ID', {exact: true}).fill('https://y.qq.com/n/ryqq/playlist/1002');
  await importDialog.getByRole('button', {name: '解析歌单', exact: true}).click();
  await importDialog.getByLabel('歌单名称', {exact: true}).fill('QQ 导入测试');
  await capture(page, '22-qq-playlist-import-preview.png');
  await importDialog.getByRole('button', {name: '创建并添加', exact: true}).click();
  await importDialog.getByRole('button', {name: '完成', exact: true}).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('xmusic:playlistLibrary')).playlists.some(item => item.name === 'QQ 导入测试' && item.tracks.length === 3));
  const queueBeforeClear = await page.evaluate(() => localStorage.getItem('xmusic:queue'));
  const favoritesBeforeClear = await page.evaluate(() => localStorage.getItem('xmusic:favorites'));
  await page.locator('.sidebar .nav-item').filter({hasText: '最近播放'}).click();
  await page.getByRole('button', {name: '清空最近播放', exact: true}).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('xmusic:recent')).length === 0);
  assert.equal(await page.evaluate(() => localStorage.getItem('xmusic:queue')), queueBeforeClear);
  assert.equal(await page.evaluate(() => localStorage.getItem('xmusic:favorites')), favoritesBeforeClear);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        checks: [
          "isolated bridge",
          "native import and cancel",
          "real WAV playback",
          "seek via lyrics",
          "pause",
          "favorites",
          "queue",
          "HTTP search/playback/lyrics",
          "restart persistence without autoplay",
          "remove without deleting audio",
          "custom light theme persists",
          "titlebar theme toggle and accessible mobile-style setting switches",
          "shortcut enable preference and close-choice checkbox cancel semantics",
          "local image import validation, separate dark/light images and readable mask",
          "independent floating background import, removal, theme switching and restart persistence",
          "SVG floating controls and themed close prompt with repeated close, cancel and Escape",
          "full expanded lyrics and song details",
          "mobile song information fields and introduction loaded through the validated detail bridge",
          "desktop lyrics isolated window, sync, lock/unlock and controls",
          "desktop lyrics position, manual size and lock persist without auto-show",
          "toolbar above background, complete current/next sentences, font selection and custom corner radius",
          "developer access gate, author link and independent download preferences",
          "large desktop lyrics resize to fit",
          "desktop lyrics keep the configured font size and restore the manual background after expansion",
          "QRC word fill advances, freezes on pause and rewinds after seek in both lyric views",
          "mobile charts, playlist capsules, category pagination and playlist details via real IPC",
          "ID-only chart songs resolve and play without external discovery network",
          "custom playlist creation, online playlist favorites and reopening from My Playlists",
          "batch add three songs, remove selected songs and restore remaining tracks after restart",
          "search shortcut exits expanded player and restores focus",
          "compact lists without hero banner",
          "quality reload preserves paused position",
          "real playback speed and pitch preservation",
          "sleep countdown expires and cancels",
          "HTTP download, byte verification, local import and restart history",
          "recursive folder reimport refreshes sidecar covers immediately without duplicate tracks",
          "QQ playlist preview and import through the validated service bridge",
          "downloaded online song resolves locally and serves correct Range bytes after download history cleanup",
          "recent history clears independently of favorites and queue; normal UI text is not selectable",
        ],
        artifacts: testRoot,
      },
      null,
      2
    )
  );
} catch (error) {
  for (const [index, window] of (application?.windows() ?? []).entries()) {
    await capture(window, `failure-window-${index}.png`).catch(() => {});
  }
  console.error(`Smoke artifacts: ${testRoot}`);
  throw error;
} finally {
  if (application) await application.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
