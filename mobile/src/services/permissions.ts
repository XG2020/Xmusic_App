import {NativeModules, Platform} from 'react-native';
import {check, request, PERMISSIONS, RESULTS} from 'react-native-permissions';

const {LocalMusic} = NativeModules;

export type MediaPermissionStatus = {
  /** 是否已获得「音频和歌曲」读取权限（Android 13+ 为 READ_MEDIA_AUDIO） */
  audio: boolean;
  /** 是否已获得「文档和文件」所有文件访问权限（Android 11+，旧系统恒为 true） */
  allFiles: boolean;
  /** 当前 Android API 级别（低于 23 的旧系统恒为已授权） */
  apiLevel: number;
};

function audioPermission() {
  return Number(Platform.Version) >= 33
    ? PERMISSIONS.ANDROID.READ_MEDIA_AUDIO
    : PERMISSIONS.ANDROID.READ_EXTERNAL_STORAGE;
}

/** react-native-permissions 兜底读取（原生 checkPermissions 不可用时） */
async function checkFallback(): Promise<MediaPermissionStatus> {
  const apiLevel = Number(Platform.Version);
  const audio = await check(audioPermission())
    .then(s => s === RESULTS.GRANTED)
    .catch(() => false);
  // react-native-permissions 4.x 未内置 MANAGE_EXTERNAL_STORAGE，原生模块
  // 不可用时保守视为未授权（设置页会引导重新申请；正常打包原生模块必然存在）
  const allFiles = apiLevel < 30;
  return {audio, allFiles, apiLevel};
}

/**
 * 查询「音频和歌曲」「文档和文件」权限状态（不弹窗、不跳转）。
 * 优先走原生统一查询，失败回退 react-native-permissions。
 * 非 Android 平台（iOS 媒体权限由系统按需弹窗）恒视为已授权。
 */
export async function checkMediaPermissions(): Promise<MediaPermissionStatus> {
  if (Platform.OS !== 'android') {
    return {audio: true, allFiles: true, apiLevel: Number(Platform.Version)};
  }
  if (LocalMusic?.checkPermissions) {
    try {
      const s = await LocalMusic.checkPermissions();
      return {
        audio: !!s.audio,
        allFiles: !!s.allFiles,
        apiLevel: Number(s.apiLevel ?? 0),
      };
    } catch (e) {
      // 原生失败回退
    }
  }
  return checkFallback();
}

/**
 * 申请「音频和歌曲」「文档和文件」权限：
 * 原生流程为 运行时权限对话框 ->（Android 11+ 未开启时）系统「所有文件访问」设置页，
 * 全部结束后返回最终状态。启动时调用即可，拒绝不影响在线播放。
 */
export async function requestMediaPermissions(): Promise<MediaPermissionStatus> {
  if (Platform.OS !== 'android') {
    return {audio: true, allFiles: true, apiLevel: Number(Platform.Version)};
  }
  if (LocalMusic?.requestPermissions) {
    try {
      // 超时保护：用户从系统设置页直接退出等极端场景下原生 promise 可能不回调，
      // 30 秒后按当前权限状态返回，避免启动引导流程被卡住
      const s: any = await Promise.race([
        LocalMusic.requestPermissions(),
        new Promise(resolve => setTimeout(() => resolve(null), 30000)),
      ]);
      if (s) {
        return {
          audio: !!s.audio,
          allFiles: !!s.allFiles,
          apiLevel: Number(s.apiLevel ?? 0),
        };
      }
      return checkFallback();
    } catch (e) {
      // 原生失败回退逐个请求
    }
  }
  // 兜底：仅能请求音频权限（react-native-permissions 4.x 不支持 MANAGE_EXTERNAL_STORAGE）
  await request(audioPermission()).catch(() => {});
  return checkFallback();
}
