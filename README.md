# XMusic(QmusicLite)

一个以安卓为主、可继续扩展到多平台的音乐播放器项目，参考 MusicFree 的技术路线，界面方向偏QQ音乐风格。

## 已接入能力

- 在线搜索歌曲
- 获取歌曲播放链接
- 获取歌单并导入 QQ 音乐歌单 ID
- 安卓本地音乐扫描
- 当前播放页
- 在线下载到应用目录
- 15 分钟定时停止

## 接口配置

- 默认接口地址在 `src/constants/config.ts`
- export const BASE_URL = 'api地址';
- 生产环境请替换为你自己的部署地址

## 本地运行

```bash
cd mobile
npm install
npm start
```

另开终端：

```bash
cd mobile
npm run android
```

## 构建 APK

本地构建：

```bash
cd mobile
npm install
npm run build-android
```

GitHub Actions：

- 已提供 `.github/workflows/android.yml`
- 推送到 `main` 或 `master` 后会自动构建
- 构建产物在 Actions 的 Artifacts 中下载

## 低内存与流畅性策略

- 启用 Hermes
- 使用原生 TrackPlayer 负责播放
- 使用 FlatList 渲染长列表
- 播放器保持单例初始化，避免重复创建
- 本地音乐扫描走 Android MediaStore，避免 JS 大量文件遍历
