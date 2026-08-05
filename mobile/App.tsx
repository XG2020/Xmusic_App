/**
 * QMusicLite - 仿 QQ 音乐播放器
 *
 * @format
 */

import React, {useEffect, useState} from 'react';
import {StatusBar} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import AppNavigator from './src/AppNavigator';
import {AppDialogHost} from './src/components/AppDialog';
import Splash from './src/components/Splash';
import {setupPlayer, restoreLastSession} from './src/services/player';
import {enforceCacheLimit} from './src/services/cacheManager';
import {ThemeProvider, useTheme} from './src/theme';
import {requestMediaPermissions} from './src/services/permissions';

function AppInner(): React.JSX.Element {
  const {t} = useTheme();
  // 启动图：首帧盖在页面上为初始化做缓冲，淡出后卸载
  const [splashDone, setSplashDone] = useState(false);

  useEffect(() => {
    if (!splashDone) {
      return;
    }
    // 启动即申请「音频和歌曲」「文档和文件」权限（原生统一流程：
    // 运行时权限对话框 -> 需要时跳系统设置页开启所有文件访问），
    // 授权后可直接按路径扫描/读写任意目录，无需 SAF 逐个目录授权
    requestMediaPermissions().catch(() => {});
  }, [splashDone]);

  return (
    <SafeAreaProvider>
      {/* 沉浸式状态栏：透明背景让页面（含自定义背景图）延伸到状态栏底下，
          避免自定义背景时顶部出现一条不协调的纯色带；各页 SafeAreaView 负责避让 */}
      <StatusBar
        barStyle={t.isDark ? 'light-content' : 'dark-content'}
        backgroundColor="transparent"
        translucent
      />
      <AppNavigator />
      <AppDialogHost />
      {!splashDone && <Splash onDone={() => setSplashDone(true)} />}
    </SafeAreaProvider>
  );
}

function App(): React.JSX.Element {
  useEffect(() => {
    // 初始化失败不能阻塞 UI 启动；就绪后恢复上次播放会话（保持暂停）
    setupPlayer()
      .then(() => restoreLastSession())
      .catch(() => {});
    // 缓存超过上限时自动清理
    enforceCacheLimit().catch(() => {});
  }, []);
  return (
    <ThemeProvider>
      <AppInner />
    </ThemeProvider>
  );
}

export default App;
