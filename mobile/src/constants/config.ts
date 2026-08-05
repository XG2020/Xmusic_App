// API 基址不建议以明文出现
export const BASE_URL = '';
export const DEFAULT_QUALITY = '320';
export const APP_NAME = 'QMusicLite';
// 当前应用版本（与 android versionName、仓库 relseas.json 保持一致）
export const APP_VERSION = '1.1.0';
// 检查更新：读取 GitHub 仓库根目录 relseas.json 的 v 字段
export const UPDATE_CHECK_URL =
  'https://raw.githubusercontent.com/XG2020/Xmusic_App/main/relseas.json';
// 主题色板已迁移至 src/theme（支持深/浅色切换）
