import {useEffect, useState} from 'react';
import {Image, NativeModules} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import RNFS from 'react-native-fs';
import {IMAGE_HEADERS} from './download';

/**
 * 皮肤（个性化装扮）服务：
 * 每个槽位可自定义一张图片（本地图片复制 / 在线 URL 下载），
 * 图片统一落盘到应用私有 skins 目录，配置持久化到 AsyncStorage，
 * 内存缓存 + 订阅让底栏/背景等处切换后立即生效。
 */

/** 皮肤槽位：启动图 / 全局背景 / 播放页背景 / 底栏三图标 / 我的页三卡片图标 */
export type SkinSlot =
  | 'splash'
  | 'bg'
  | 'playerBg'
  | 'tabHome'
  | 'tabRank'
  | 'tabMine'
  | 'mineLocal'
  | 'mineDownload'
  | 'mineNowPlaying';

/** 槽位 -> file:// 图片地址（未设置的槽位缺省用内置素材） */
export type SkinConfig = Partial<Record<SkinSlot, string>>;

const SKIN_KEY = 'skin_config';
const SKIN_DIR = `${RNFS.DocumentDirectoryPath}/skins`;

let config: SkinConfig = {};
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach(l => l());
}

let ready = false;

/** 皮肤配置预热是否已完成（供 Splash 首帧同步判断能否直接读配置） */
export function isSkinReady(): boolean {
  return ready;
}

// 把"是否设置了自定义启动图"标志同步给原生：MainActivity 冷启动时
// 据此把启动窗口换成纯色底，不再显示默认 logo 启动图
function syncNativeSplashFlag() {
  NativeModules.LocalMusic?.setCustomSplashFlag?.(!!config.splash);
}

// 模块加载时预热：底栏首帧渲染即可拿到自定义图标；
// skinReady 供启动图等首帧就要读配置的场景等待预热完成
export const skinReady: Promise<void> = AsyncStorage.getItem(SKIN_KEY)
  .then(raw => {
    if (raw) {
      config = JSON.parse(raw) as SkinConfig;
      notify();
    }
  })
  .catch(() => {})
  .then(() => {
    ready = true;
    // 预热后校准原生标志，修复清数据/异常导致的 JS 配置与原生标志不一致
    syncNativeSplashFlag();
  });

async function save() {
  await AsyncStorage.setItem(SKIN_KEY, JSON.stringify(config)).catch(() => {});
}

/** 同步读取当前皮肤配置 */
export function getSkin(): SkinConfig {
  return config;
}

/** Hook：订阅皮肤配置，任意槽位变更后实时刷新 */
export function useSkin(): SkinConfig {
  const [, force] = useState(0);
  useEffect(() => {
    const update = () => force(v => v + 1);
    listeners.add(update);
    return () => {
      listeners.delete(update);
    };
  }, []);
  return config;
}

async function ensureSkinDir() {
  try {
    if (!(await RNFS.exists(SKIN_DIR))) {
      await RNFS.mkdir(SKIN_DIR);
    }
  } catch (e) {
    // 创建失败由后续写入报错兜底
  }
}

/** 删除槽位旧图片（仅清理 skins 目录内的文件，不碰用户原图） */
async function removeSlotFile(slot: SkinSlot) {
  const old = config[slot];
  if (old && old.startsWith('file://')) {
    const path = decodeURI(old.replace(/^file:\/\//, ''));
    if (path.startsWith(SKIN_DIR)) {
      await RNFS.unlink(path).catch(() => {});
    }
  }
}

/** 带时间戳的落盘路径：同槽位换图后 URI 变化，避开 RN Image 的 URI 级缓存 */
function slotFilePath(slot: SkinSlot): string {
  return `${SKIN_DIR}/${slot}_${Date.now()}.jpg`;
}

/** 文件路径转 RN 可用的 file:// URI（中文/空格需百分号编码） */
function toFileUri(path: string): string {
  return `file://${encodeURI(path).replace(/#/g, '%23')}`;
}

// 自定义图片上限：超过 GPU 纹理/内存安全线的图设置后可能渲染空白甚至 OOM，
// 在设置时直接拒绝并提示，避免用户拿到一个“加载不出来”的皮肤
const MAX_SIDE = 8192;
const MAX_PIXELS = 48000000; // 约 8000x6000
const MAX_BYTES = 5 * 1024 * 1024; // 文件体积上限 5MB

/** 校验文件体积不超 5MB（超大文件解码慢、占存储） */
async function assertFileSizeOk(path: string) {
  const stat = await RNFS.stat(path).catch(() => null);
  if (stat && Number(stat.size) > MAX_BYTES) {
    const mb = (Number(stat.size) / 1024 / 1024).toFixed(1);
    throw new Error(`图片文件过大（${mb}MB），请选择 5MB 以内的图片`);
  }
}

/** 校验图片可用：能被解码（不是坏文件/非图片）且分辨率在安全范围内 */
async function assertImageUsable(uri: string) {
  const {width, height} = await new Promise<{width: number; height: number}>(
    (resolve, reject) =>
      Image.getSize(uri, (w, h) => resolve({width: w, height: h}), reject),
  ).catch(() => {
    throw new Error('无法识别的图片文件，请换一张试试');
  });
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    throw new Error(
      `图片分辨率过大（${width}×${height}），请选择更小的图片`,
    );
  }
}

/**
 * 用本地图片设置槽位皮肤：复制到 skins 目录（原图移动/删除后皮肤不受影响）。
 * 失败时抛错由调用方提示。
 */
export async function setSkinFromLocal(slot: SkinSlot, srcPath: string) {
  // 先校验再落盘，坏图/超大图直接拒绝
  await assertFileSizeOk(srcPath);
  await assertImageUsable(toFileUri(srcPath));
  await ensureSkinDir();
  const dest = slotFilePath(slot);
  await RNFS.copyFile(srcPath, dest);
  await removeSlotFile(slot);
  config = {...config, [slot]: toFileUri(dest)};
  await save();
  if (slot === 'splash') {
    syncNativeSplashFlag();
  }
  notify();
}

/**
 * 用在线图片 URL 设置槽位皮肤：下载到 skins 目录（离线也能显示）。
 * 非 2xx / 空文件视为失败并抛错。
 */
export async function setSkinFromUrl(slot: SkinSlot, url: string) {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('请输入 http(s) 开头的图片地址');
  }
  await ensureSkinDir();
  const dest = slotFilePath(slot);
  try {
    const ret = await RNFS.downloadFile({
      fromUrl: url,
      toFile: dest,
      headers: IMAGE_HEADERS,
    }).promise;
    const stat = await RNFS.stat(dest).catch(() => null);
    if (
      ret.statusCode < 200 ||
      ret.statusCode >= 300 ||
      !stat ||
      Number(stat.size) <= 0
    ) {
      throw new Error(`图片下载失败 (${ret.statusCode})`);
    }
    // 校验下载内容确实是可用图片（防 URL 返回 HTML/超大图/超 5MB）
    await assertFileSizeOk(dest);
    await assertImageUsable(toFileUri(dest));
  } catch (e) {
    // 失败不留半截文件
    await RNFS.unlink(dest).catch(() => {});
    throw e;
  }
  await removeSlotFile(slot);
  config = {...config, [slot]: toFileUri(dest)};
  await save();
  if (slot === 'splash') {
    syncNativeSplashFlag();
  }
  notify();
}

/** 恢复槽位默认（删除自定义图片） */
export async function clearSkin(slot: SkinSlot) {
  await removeSlotFile(slot);
  const next = {...config};
  delete next[slot];
  config = next;
  await save();
  if (slot === 'splash') {
    syncNativeSplashFlag();
  }
  notify();
}
