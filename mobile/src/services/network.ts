import NetInfo, {NetInfoState} from '@react-native-community/netinfo';
import TrackPlayer, {State} from 'react-native-track-player';
import {AppAlert} from '../components/AppDialog';
import {
  dataReminderEnabled,
  getPlayQuality,
  setDataReminder,
  wifiOnlyEnabled,
} from './settings';
import {anyCachedSongPath, cachedSongPath} from './songCache';

/**
 * 网络状态服务：
 * - 全局订阅网络类型（WiFi / 蜂窝 / 无网络），供播放前门禁与「仅WiFi缓存」判断
 * - 播放在线内容前的网络门禁：无网提示 / 流量三选项弹窗
 * - 断网自动暂停后，网络恢复时自动续播（参考大厂做法）
 */

export type NetType = 'wifi' | 'cellular' | 'none' | 'other';

let currentType: NetType = 'other';
let connected = true;
let networkReady = false;
let resolveNetworkReady: (() => void) | null = null;
const networkReadyPromise = new Promise<void>(resolve => {
  resolveNetworkReady = resolve;
});
// 本次软件启动内是否已允许流量播放（「仅一次」选项，冷启动重置）
let allowCellularThisSession = false;
// 断网时是否处于播放中：用于网络恢复后自动续播
let wasPlayingOnDrop = false;

const listeners = new Set<(type: NetType, connected: boolean) => void>();

function classify(s: NetInfoState): NetType {
  if (!s.isConnected) {
    return 'none';
  }
  if (s.type === 'wifi' || s.type === 'ethernet') {
    return 'wifi';
  }
  if (s.type === 'cellular') {
    return 'cellular';
  }
  return 'other';
}

/**
 * 掉线瞬间：若当前在线曲目已整曲缓存到本地，则切换到本地文件，
 * 使整首歌离线可任意拖动播放。
 * （在线时刻意不切换以避免音源重建卡顿，见 songCache 注释；离线时流已断，
 *  切到本地反而能无缝续播并解锁整曲拖动，故仅在掉线这一刻执行。）
 * shouldResume：掉线前处于播放意图（播放/缓冲/加载中）时，切换后继续播放。
 */
async function swapToCachedIfOffline(shouldResume: boolean) {
  try {
    const active = (await TrackPlayer.getActiveTrack()) as any;
    const url = String(active?.url ?? '');
    if (!active?.mid || !/^https?:/i.test(url)) {
      return; // 非在线流曲目（已是本地/缓存）无需处理
    }
    const q = await getPlayQuality();
    // 优先当前音质缓存，其次任一已缓存音质（离线只要有完整文件就能整曲拖动）
    const path =
      (await cachedSongPath(String(active.mid), q)) ||
      (await anyCachedSongPath(String(active.mid)));
    if (!path) {
      return; // 未整曲缓存：保持流媒体，由播放页限制只能拖到已缓冲区域
    }
    const {position} = await TrackPlayer.getProgress();
    await TrackPlayer.load({...active, url: `file://${path}`});
    await TrackPlayer.seekTo(position);
    if (shouldResume) {
      await TrackPlayer.play();
    }
  } catch (e) {
    // 切换失败：保持原流媒体状态
  }
}

async function onConnectivityChange(prev: boolean, now: boolean) {
  if (prev && !now) {
    // 掉线瞬间记录播放状态：正在播放/缓冲则恢复网络后自动续播。
    // 断网后 ExoPlayer 可能已从 Playing 掉到 Buffering，故三态都视为「播放意图」，
    // 供切本地文件后据此续播，避免切换后停在暂停态。
    let wasPlaying = false;
    try {
      const {state} = await TrackPlayer.getPlaybackState();
      wasPlaying =
        state === State.Playing ||
        state === State.Buffering ||
        state === State.Loading;
    } catch (e) {
      wasPlaying = false;
    }
    wasPlayingOnDrop = wasPlaying;
    // 已整曲缓存的在线曲目：切到本地文件，解锁整首离线拖动播放
    await swapToCachedIfOffline(wasPlaying);
  } else if (!prev && now && wasPlayingOnDrop) {
    // 网络恢复：重试当前曲目并续播（retry 用于从错误/停止态恢复流媒体）
    wasPlayingOnDrop = false;
    // 断网期间用户可能已手动暂停：网络卡顿只会产生 Buffering/Error，绝不会变成
    // Paused，因此当前为暂停/停止态即代表用户主动暂停，此时不自动续播，尊重用户操作
    try {
      const {state} = await TrackPlayer.getPlaybackState();
      if (
        state === State.Paused ||
        state === State.Stopped ||
        state === State.None
      ) {
        return;
      }
    } catch (e) {
      // 查询失败则继续尝试续播
    }
    try {
      await TrackPlayer.retry();
    } catch (e) {
      // 非错误态无需 retry，直接 play
    }
    try {
      await TrackPlayer.play();
    } catch (e) {
      // 忽略
    }
  }
}

function handleChange(s: NetInfoState) {
  const prevConnected = connected;
  connected = !!s.isConnected;
  networkReady = true;
  resolveNetworkReady?.();
  resolveNetworkReady = null;
  currentType = classify(s);
  onConnectivityChange(prevConnected, connected).catch(() => {});
  listeners.forEach(l => l(currentType, connected));
}

// 模块加载即开始监听 + 拉取一次当前状态
NetInfo.addEventListener(handleChange);
NetInfo.fetch()
  .then(handleChange)
  .catch(() => {});

/** 等待一次真实网络状态，避免离线冷启动误把在线曲目当成可联网曲目。 */
export async function waitForNetworkState(timeoutMs = 1500): Promise<void> {
  if (networkReady) return;
  await Promise.race([
    networkReadyPromise,
    new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
  ]);
}

/** 当前是否已联网 */
export function isConnected(): boolean {
  return connected;
}

/** 当前是否为蜂窝移动网络 */
export function isCellular(): boolean {
  return currentType === 'cellular';
}

/** 当前网络类型 */
export function networkType(): NetType {
  return currentType;
}

/**
 * 后台/切歌等无法弹窗的场景下，同步判断在线曲目当前是否应被拦截，
 * 返回用于 Toast 的原因文案；未被拦截返回 null。
 * - 无网络：拦截
 * - 「仅 Wi-Fi 联网」开启且当前为蜂窝网络：硬拦截（不允许流量在线播放）
 * 蜂窝流量提醒（三选项弹窗）只在前台用户操作时由 ensureOnlinePlayback 处理，不在此拦截。
 */
export function onlinePlaybackBlockReason(): string | null {
  if (!connected) {
    return '无网络，已暂停在线播放';
  }
  if (currentType === 'cellular' && wifiOnlyEnabled()) {
    return '仅Wi-Fi联网已开启，移动网络下已暂停在线播放';
  }
  return null;
}

/** 订阅网络变化，返回取消函数 */
export function subscribeNetwork(
  fn: (type: NetType, connected: boolean) => void,
): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * 播放在线内容前的网络门禁：
 * - 无网络：提示「无网络，请恢复网络后重试」，返回 false（不加载播放）
 * - 「仅 Wi-Fi 联网」开启且当前为蜂窝：提示后返回 false（硬拦截流量在线播放）
 * - 蜂窝流量且开启提醒且本次未允许：弹三选项弹窗，按用户选择 resolve
 *   · 仅一次：本次软件启动内不再提醒
 *   · 允许所有：关闭设置里的流量提醒开关
 *   · 关闭：不加载播放歌曲
 * - 其它（WiFi / 已允许 / 关提醒）：直接放行
 */
export function ensureOnlinePlayback(): Promise<boolean> {
  return new Promise(resolve => {
    if (!connected) {
      AppAlert.alert('无网络', '请恢复网络后重试');
      resolve(false);
      return;
    }
    if (currentType === 'cellular' && wifiOnlyEnabled()) {
      AppAlert.alert(
        '仅Wi-Fi联网',
        '已开启「仅Wi-Fi联网」，当前为移动网络，无法播放在线歌曲。如需用流量播放，请在设置中关闭该开关。',
      );
      resolve(false);
      return;
    }
    if (
      currentType === 'cellular' &&
      dataReminderEnabled() &&
      !allowCellularThisSession
    ) {
      AppAlert.alert(
        '正在使用流量播放',
        '当前为移动网络，继续播放将消耗流量',
        [
          {
            text: '仅一次（本次不再提醒）',
            onPress: () => {
              allowCellularThisSession = true;
              resolve(true);
            },
          },
          {
            text: '允许所有（关闭流量提醒）',
            onPress: () => {
              setDataReminder(false).catch(() => {});
              resolve(true);
            },
          },
          {
            text: '关闭',
            style: 'cancel',
            onPress: () => resolve(false),
          },
        ],
        {cancelable: false},
      );
      return;
    }
    resolve(true);
  });
}
