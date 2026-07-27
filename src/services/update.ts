import axios from 'axios';
import {APP_VERSION, UPDATE_CHECK_URL} from '../constants/config';

/**
 * 检查更新：拉取 GitHub 仓库根目录 relseas.json，比较其中 v 字段与当前版本
 */

export type ReleaseInfo = {
  v: string;
  url?: string;
  note?: string;
};

/** 语义化版本比较：a>b 返回 1，a<b 返回 -1，相等返回 0 */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

/** 拉取远端版本信息（加时间戳绕过 raw CDN 缓存） */
export async function checkUpdate(): Promise<{
  hasUpdate: boolean;
  current: string;
  latest: ReleaseInfo;
}> {
  const {data} = await axios.get(`${UPDATE_CHECK_URL}?t=${Date.now()}`, {
    timeout: 10000,
  });
  const latest: ReleaseInfo =
    typeof data === 'string' ? JSON.parse(data) : data;
  if (!latest?.v) {
    throw new Error('远端版本信息格式不正确');
  }
  return {
    hasUpdate: compareVersions(latest.v, APP_VERSION) > 0,
    current: APP_VERSION,
    latest,
  };
}
