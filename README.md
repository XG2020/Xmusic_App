# Xmusic(QMusicLite)

一个以安卓为主、可继续扩展到多平台的音乐播放器项目，参考 MusicFree 的技术路线，界面方向偏 QQ 音乐风格。

## 已接入能力

### 在线音乐
- 在线搜索歌曲、排行榜浏览
- 多音质播放与下载（臻品母带 / 全景声 / 无损 flac / 320 / 128，不可用时自动降级）
- 歌单导入：支持纯数字 ID、歌单链接、QQ 音乐分享短链（自动跟随重定向解析真实 ID）
- 在线下载到本地，可选同时下载歌词（.lrc）与封面（.jpg）

### 播放体验
- 播放页三页横滑（歌曲详情 / 歌曲 / 歌词），带方向哨兵防斜滑误触发翻页
- 歌词页：逐字卡拉OK染色（QRC）、翻译对照、聚焦行放大、拖动定位、长按复制
- 倍速播放、三种播放模式（列表 / 单曲 / 随机）、下滑收起播放页
- 迷你播放条、正在播放列表管理
- 睡眠定时停止播放

### 本地音乐
- Android MediaStore 扫描本地音乐，支持自定义扫描文件夹
- 收藏（我喜欢）、下载管理

### 个性化
- 主题：深色 / 浅色 / 跟随系统（冷启动阶段原生同步，启动图明暗与应用内设置一致）
- 字体大小调节
- 个性化装扮：启动图、全局背景、播放页背景、底栏与「我的」页图标均可自定义
  （本地图片或在线 URL，上限 5MB；自定义背景自动叠加主题色遮罩保证可读性；
  设置自定义启动图后默认 logo 启动图不再显示）
- 应用内检查更新

## 接口配置

- 默认接口地址在 `src/constants/config.ts`
- export const BASE_URL = 'api地址'
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

## 目录结构

```
src/
├── components/   # 通用组件（弹窗、图标、迷你播放条、启动图等）
├── screens/      # 页面（首页、搜索、排行、播放页、歌词、设置、装扮等）
├── services/     # 业务服务（接口、播放器、下载、皮肤、设置、缓存等）
├── theme/        # 主题色板与 ThemeProvider
├── utils/        # 工具（歌词解析、格式化、全局字体等）
└── assets/       # 内置素材（图标、启动图）
scripts/          # 素材生成脚本（gen_splash.ps1 从根目录 logo.jpg 生成启动图等）
```

## 素材说明

- 项目图片素材统一使用 JPG（禁用 PNG）
- 启动图明暗两套由 `scripts/gen_splash.ps1` 从仓库根目录 `logo.jpg` 生成，
  同时输出到 `src/assets` 与 android `drawable-xxhdpi` / `drawable-night-xxhdpi`，
  改样式或改色后重跑脚本即可

## 低内存与流畅性策略

- 启用 Hermes
- 使用原生 TrackPlayer 负责播放
- 使用 FlatList 渲染长列表
- 播放器保持单例初始化，避免重复创建
- 本地音乐扫描走 Android MediaStore，避免 JS 大量文件遍历
- 图片按显示尺寸降采样解码（resizeMethod="resize"），大图不撑爆内存
