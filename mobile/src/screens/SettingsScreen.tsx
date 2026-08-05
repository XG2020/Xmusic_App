import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Modal,
  ActivityIndicator,
  Linking,
  Switch,
  TextInput,
  ToastAndroid,
  Platform,
} from 'react-native';
import {AppAlert} from '../components/AppDialog';
import {SafeAreaView} from 'react-native-safe-area-context';
import {useTheme, Theme} from '../theme';
import {
  ThemeMode,
  Quality,
  QUALITY_OPTIONS,
  qualityOption,
  getPlayQuality,
  setPlayQuality,
  getDownloadQuality,
  setDownloadQuality,
  getDefaultDownloadDir,
  getDefaultDownloadDirName,
  getDownloadDir,
  setDownloadDir,
  getDownloadDirName,
  setDownloadDirName,
  FONT_SIZE_OPTIONS,
  fontSizeLabel,
  getAutoOpenPlayer,
  setAutoOpenPlayer,
  getShowRankTab,
  setShowRankTab,
  getCoverSpin,
  setCoverSpin,
  getDataReminder,
  setDataReminder,
  getCacheWhilePlay,
  setCacheWhilePlay,
  getWifiOnly,
  setWifiOnly,
  getAllowMix,
  setAllowMix,
  getDownloadLyric,
  setDownloadLyric,
  getDownloadCover,
  setDownloadCover,
  getDevUnlocked,
  setDevUnlocked,
} from '../services/settings';
import {getCustomApiUrl, setCustomApiUrl} from '../services/api';
import {applyQualityToCurrent} from '../services/player';
import {useSleepTimer, formatSleepRemaining} from '../services/sleepTimer';
import {pickDownloadDir} from '../services/local';
import {checkMediaPermissions, requestMediaPermissions} from '../services/permissions';
import {checkUpdate} from '../services/update';
import {
  CACHE_LIMIT_OPTIONS,
  DEFAULT_CACHE_MB,
  cacheLimitLabel,
  getCacheBytes,
  getMaxCacheMb,
  setMaxCacheMb,
  clearAllCache,
  enforceCacheLimit,
  formatBytes,
} from '../services/cacheManager';
import {APP_VERSION} from '../constants/config';
import {md5} from '../utils/md5';

const MODE_OPTIONS: {value: ThemeMode; label: string}[] = [
  {value: 'system', label: '跟随系统'},
  {value: 'light', label: '浅色'},
  {value: 'dark', label: '深色'},
];

/** 底部弹层类型：在线音质 / 下载音质 / 深色模式 / 最大缓存 / 字号 */
type SheetKind = 'play' | 'download' | 'theme' | 'cache' | 'font' | null;

/**
 * 设置页（参考 QQ 音乐样式）：分组行式布局
 * 播放与下载 / 功能与服务 / 关于
 */
export default function SettingsScreen({navigation}: any) {
  const {t, mode, setMode, fontSize, setFontSize} = useTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  // 音质
  const [playQ, setPlayQ] = useState<Quality>('320');
  const [dlQ, setDlQ] = useState<Quality>('flac');
  const [sheet, setSheet] = useState<SheetKind>(null);
  // 定时关闭
  const sleepRemain = useSleepTimer();
  // 下载目录（空值 = 默认 Download/Xmusic；SAF 授权时为 content:// uri + 目录显示名）
  const [downloadDir, setDownloadDirState] = useState('');
  const [downloadDirName, setDownloadDirNameState] = useState('');
  // 检查更新
  const [checking, setChecking] = useState(false);
  // 缓存
  const [cacheBytes, setCacheBytes] = useState(0);
  const [maxCacheMb, setMaxCacheMbState] = useState(DEFAULT_CACHE_MB);
  const [clearingCache, setClearingCache] = useState(false);
  // 播放歌曲自动进入播放页
  const [autoOpen, setAutoOpen] = useState(true);
  // 底栏排行榜入口
  const [showRank, setShowRank] = useState(true);
  // 播放页封面旋转
  const [spinOn, setSpinOn] = useState(true);
  // 使用流量提醒
  const [dataReminder, setDataReminderState] = useState(true);
  // 边播边存
  const [cacheWhilePlay, setCacheWhilePlayState] = useState(true);
  // 仅 Wi-Fi 联网（默认关）
  const [wifiOnly, setWifiOnlyState] = useState(false);
  // 允许与其他应用同时播放（默认开）
  const [allowMix, setAllowMixState] = useState(true);
  // 下载附件：同时下载歌词/封面
  const [dlLyric, setDlLyric] = useState(true);
  const [dlCover, setDlCover] = useState(true);
  // 存储与媒体权限（音频和歌曲 / 文档和文件）
  const [permGranted, setPermGranted] = useState(true);
  // 开发者模式：连点版本号 5 次 -> 密钥校验 -> 自定义 API 接口
  const verTapCount = useRef(0);
  const verTapLast = useRef(0);
  const devUnlocked = useRef(false);
  const [keyModal, setKeyModal] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [apiModal, setApiModal] = useState(false);
  const [apiInput, setApiInput] = useState('');
  const [apiSaving, setApiSaving] = useState(false);

  const refreshCacheSize = () => {
    getCacheBytes().then(setCacheBytes).catch(() => {});
  };

  useEffect(() => {
    getDownloadDir().then(setDownloadDirState);
    getDownloadDirName().then(setDownloadDirNameState);
    getPlayQuality().then(setPlayQ);
    getDownloadQuality().then(setDlQ);
    getMaxCacheMb().then(setMaxCacheMbState);
    getAutoOpenPlayer().then(setAutoOpen);
    getShowRankTab().then(setShowRank);
    getCoverSpin().then(setSpinOn);
    getDataReminder().then(setDataReminderState);
    getCacheWhilePlay().then(setCacheWhilePlayState);
    getWifiOnly().then(setWifiOnlyState);
    getAllowMix().then(setAllowMixState);
    getDownloadLyric().then(setDlLyric);
    getDownloadCover().then(setDlCover);
    checkMediaPermissions()
      .then(s => setPermGranted(s.audio && s.allFiles))
      .catch(() => {});
    getDevUnlocked().then(on => {
      devUnlocked.current = on;
    });
    refreshCacheSize();
  }, []);

  const onToggleAutoOpen = (on: boolean) => {
    setAutoOpen(on);
    setAutoOpenPlayer(on).catch(() => {});
  };

  const onToggleShowRank = (on: boolean) => {
    setShowRank(on);
    setShowRankTab(on).catch(() => {});
  };

  const onToggleSpin = (on: boolean) => {
    setSpinOn(on);
    setCoverSpin(on).catch(() => {});
  };

  const onToggleDataReminder = (on: boolean) => {
    setDataReminderState(on);
    setDataReminder(on).catch(() => {});
  };

  const onToggleCacheWhilePlay = (on: boolean) => {
    setCacheWhilePlayState(on);
    setCacheWhilePlay(on).catch(() => {});
  };

  const onToggleWifiOnly = (on: boolean) => {
    setWifiOnlyState(on);
    setWifiOnly(on).catch(() => {});
  };

  const onToggleAllowMix = (on: boolean) => {
    setAllowMixState(on);
    setAllowMix(on).catch(() => {});
    // 音频焦点模式在播放器创建时定死，切换后需重启应用才生效
    ToastAndroid.show('重启应用后生效', ToastAndroid.SHORT);
  };

  const onToggleDlLyric = (on: boolean) => {
    setDlLyric(on);
    setDownloadLyric(on).catch(() => {});
  };

  const onToggleDlCover = (on: boolean) => {
    setDlCover(on);
    setDownloadCover(on).catch(() => {});
  };

  // ===== 音质 =====

  const onPickQuality = async (q: Quality) => {
    if (sheet === 'play') {
      setPlayQ(q);
      await setPlayQuality(q);
      // 正在播放在线歌曲时无缝切换（保持进度），否则对后续播放生效
      await applyQualityToCurrent(q);
    } else if (sheet === 'download') {
      setDlQ(q);
      await setDownloadQuality(q);
    }
    setSheet(null);
  };

  // ===== 缓存 =====

  const onClearCache = () => {
    if (clearingCache) {
      return;
    }
    AppAlert.alert(
      '清除缓存',
      `当前缓存 ${formatBytes(cacheBytes)}，清除不影响已下载的歌曲`,
      [
        {text: '取消', style: 'cancel'},
        {
          text: '清除',
          style: 'destructive',
          onPress: async () => {
            setClearingCache(true);
            try {
              await clearAllCache();
            } finally {
              setClearingCache(false);
              refreshCacheSize();
            }
          },
        },
      ],
    );
  };

  const onPickCacheLimit = async (mb: number) => {
    setMaxCacheMbState(mb);
    setSheet(null);
    await setMaxCacheMb(mb);
    // 调小上限后立即检查是否需要清理
    const cleaned = await enforceCacheLimit().catch(() => false);
    if (cleaned) {
      refreshCacheSize();
    }
  };

  // ===== 下载目录 =====

  const onPickDownloadDir = async () => {
    // SAF 系统目录选择器：选择即持久化授权，下载可直接写入所选目录（含公共目录）
    const picked = await pickDownloadDir();
    if (!picked) {
      // 用户取消不打扰；非 Android 平台无 SAF，提示不支持
      if (Platform.OS !== 'android') {
        AppAlert.alert('暂不支持', '当前平台仅支持应用默认下载目录。');
      }
      return;
    }
    await setDownloadDir(picked.uri);
    await setDownloadDirName(picked.name);
    setDownloadDirState(picked.uri);
    setDownloadDirNameState(picked.name);
    AppAlert.alert('已设置下载目录', picked.name);
  };

  const resetDownloadDir = async () => {
    await setDownloadDir('');
    await setDownloadDirName('');
    setDownloadDirState('');
    setDownloadDirNameState('');
  };

  // ===== 检查更新 =====

  const onCheckUpdate = async () => {
    if (checking) {
      return;
    }
    setChecking(true);
    try {
      const {hasUpdate, latest} = await checkUpdate();
      if (hasUpdate) {
        AppAlert.alert(
          `发现新版本 v${latest.v}`,
          latest.note || '有新版本可用，是否前往下载？',
          [
            {text: '取消', style: 'cancel'},
            {
              text: '去下载',
              onPress: () =>
                Linking.openURL(
                  latest.url || 'https://github.com/XG2020/Xmusic_App/releases',
                ).catch(() => {}),
            },
          ],
        );
      } else {
        AppAlert.alert('已是最新版本', `当前版本 v${APP_VERSION}`);
      }
    } catch (e) {
      AppAlert.alert('检查更新失败', '请检查网络后重试');
    } finally {
      setChecking(false);
    }
  };

  // ===== 开发者模式 =====

  // 开发者密钥不以明文出现：只保留密钥的 MD5，输入后哈希比对
  const DEV_SECRET_MD5 = 'b769e214d2bedba287b3a898786c0c22';

  /** 连点版本号：1.5 秒内累计 5 次触发；已解锁直接进接口设置，否则先验密钥 */
  const onVersionTap = () => {
    const now = Date.now();
    if (now - verTapLast.current > 1500) {
      verTapCount.current = 0;
    }
    verTapLast.current = now;
    verTapCount.current += 1;
    if (verTapCount.current < 5) {
      return;
    }
    verTapCount.current = 0;
    if (devUnlocked.current) {
      openApiModal();
    } else {
      setKeyInput('');
      setKeyModal(true);
    }
  };

  /** 打开接口设置：仅回显自定义地址，内置接口地址不展示 */
  const openApiModal = async () => {
    setApiInput(await getCustomApiUrl());
    setApiModal(true);
  };

  const onSubmitKey = () => {
    if (md5(keyInput.trim()) !== DEV_SECRET_MD5) {
      AppAlert.alert('密钥错误', '请输入正确的开发者密钥');
      return;
    }
    devUnlocked.current = true;
    setDevUnlocked(true).catch(() => {});
    setKeyModal(false);
    openApiModal();
  };

  /** 保存自定义接口；输入为空时恢复内置接口 */
  const onSaveApi = async () => {
    const url = apiInput.trim();
    if (url && !/^https?:\/\/.+/i.test(url)) {
      AppAlert.alert('地址无效', '请输入 http:// 或 https:// 开头的完整接口地址');
      return;
    }
    setApiSaving(true);
    try {
      await setCustomApiUrl(url);
      setApiModal(false);
      AppAlert.alert(
        url ? '已启用自定义接口' : '已恢复内置接口',
        '后续所有请求将使用该接口',
      );
    } finally {
      setApiSaving(false);
    }
  };

  /** 通用设置行：左标签 + 右值 + › */
  const renderRow = (
    label: string,
    value: string,
    onPress?: () => void,
    showArrow = true,
  ) => (
    <TouchableOpacity
      key={label}
      style={styles.row}
      activeOpacity={onPress ? 0.6 : 1}
      onPress={onPress}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={1}>
        {value}
      </Text>
      {showArrow && <Text style={styles.rowArrow}>›</Text>}
    </TouchableOpacity>
  );

  const defaultDirShort = getDefaultDownloadDirName();
  const dirShort = downloadDirName || downloadDir || defaultDirShort;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.pageTitle}>设置</Text>
        <View style={styles.backSpace} />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.body}>
        {/* 网络 */}
        <Text style={styles.groupTitle}>网络</Text>
        <View style={styles.group}>
          {/* 开关行：仅 Wi-Fi 联网（开启后移动网络下不播放在线歌曲，且仅 Wi-Fi 下边播边存缓存） */}
          <View style={styles.row}>
            <View style={styles.rowTextWrap}>
              <Text style={styles.rowLabel}>仅Wi-Fi联网</Text>
              <Text style={styles.rowSub}>
                开启后移动网络下不播放在线歌曲，本地与已缓存歌曲不受限
              </Text>
            </View>
            <Switch
              value={wifiOnly}
              onValueChange={onToggleWifiOnly}
              trackColor={{false: t.cardLight, true: t.primary}}
              thumbColor="#fff"
            />
          </View>
          {/* 开关行：使用流量时弹窗提醒（关闭后蜂窝网络直接播放不提醒） */}
          <View style={styles.row}>
            <Text style={styles.rowLabel}>使用流量提醒</Text>
            <Switch
              value={dataReminder}
              onValueChange={onToggleDataReminder}
              trackColor={{false: t.cardLight, true: t.primary}}
              thumbColor="#fff"
            />
          </View>
        </View>

        {/* 播放与下载 */}
        <Text style={styles.groupTitle}>播放与下载</Text>
        <View style={styles.group}>
          {renderRow('在线听歌品质', qualityOption(playQ).label, () =>
            setSheet('play'),
          )}
          {renderRow('歌曲下载品质', qualityOption(dlQ).label, () =>
            setSheet('download'),
          )}
          {renderRow(
            '存储与媒体权限',
            permGranted ? '已授权' : '未完全授权，点击重新申请',
            async () => {
              // 未授权时重新发起申请（所有文件访问会跳系统设置页，返回后结算状态）
              const s = await requestMediaPermissions().catch(() => null);
              if (s) {
                setPermGranted(s.audio && s.allFiles);
              }
            },
          )}
          {renderRow('歌曲存储位置设置', dirShort, () => {
            if (!downloadDir) {
              onPickDownloadDir();
              return;
            }
            AppAlert.alert(
              '下载目录',
              `默认位置：${getDefaultDownloadDir()}\n\n重新选择目录或恢复默认？`,
              [
              {text: '取消', style: 'cancel'},
              {text: '恢复默认', onPress: resetDownloadDir},
              {text: '重新选择', onPress: onPickDownloadDir},
              ],
            );
          })}
          {/* 开关行：下载时同时下载歌词/封面 */}
          <View style={styles.row}>
            <Text style={styles.rowLabel}>下载时同时下载歌词</Text>
            <Switch
              value={dlLyric}
              onValueChange={onToggleDlLyric}
              trackColor={{false: t.cardLight, true: t.primary}}
              thumbColor="#fff"
            />
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>下载时同时下载封面</Text>
            <Switch
              value={dlCover}
              onValueChange={onToggleDlCover}
              trackColor={{false: t.cardLight, true: t.primary}}
              thumbColor="#fff"
            />
          </View>
        </View>

        {/* 功能与服务 */}
        <Text style={styles.groupTitle}>功能与服务</Text>
        <View style={styles.group}>
          {renderRow(
            '定时关闭',
            sleepRemain > 0
              ? `${formatSleepRemaining(sleepRemain)}后`
              : '未开启',
            () => navigation.navigate('SleepTimer'),
          )}
          {renderRow(
            '深色模式',
            MODE_OPTIONS.find(o => o.value === mode)?.label ?? '跟随系统',
            () => setSheet('theme'),
          )}
          {renderRow('个性化装扮', '', () =>
            navigation.navigate('Personalize'),
          )}
          {renderRow('字号大小', fontSizeLabel(fontSize), () =>
            setSheet('font'),
          )}
          {/* 开关行：播放歌曲后自动进入播放页 */}
          <View style={styles.row}>
            <Text style={styles.rowLabel}>播放歌曲自动进入播放页</Text>
            <Switch
              value={autoOpen}
              onValueChange={onToggleAutoOpen}
              trackColor={{false: t.cardLight, true: t.primary}}
              thumbColor="#fff"
            />
          </View>
          {/* 开关行：允许与其他应用同时播放（开：混音；关：其他应用出声则暂停，对方结束时恢复） */}
          <View style={styles.row}>
            <Text style={styles.rowLabel}>允许与其他应用同时播放</Text>
            <Switch
              value={allowMix}
              onValueChange={onToggleAllowMix}
              trackColor={{false: t.cardLight, true: t.primary}}
              thumbColor="#fff"
            />
          </View>
          {/* 开关行：播放页封面旋转（关闭后唱片静止，减少动画开销） */}
          <View style={styles.row}>
            <Text style={styles.rowLabel}>播放页封面旋转</Text>
            <Switch
              value={spinOn}
              onValueChange={onToggleSpin}
              trackColor={{false: t.cardLight, true: t.primary}}
              thumbColor="#fff"
            />
          </View>
          {/* 开关行：底栏显示排行榜入口（关闭后首页榜单卡改为打开独立排行页） */}
          <View style={styles.row}>
            <Text style={styles.rowLabel}>底栏显示排行榜入口</Text>
            <Switch
              value={showRank}
              onValueChange={onToggleShowRank}
              trackColor={{false: t.cardLight, true: t.primary}}
              thumbColor="#fff"
            />
          </View>
        </View>

        {/* 存储与缓存 */}
        <Text style={styles.groupTitle}>存储与缓存</Text>
        <View style={styles.group}>
          {/* 开关行：边播边存（在线播放时非蜂窝网络下后台缓存整曲，断网可回听/下次离线可播） */}
          <View style={styles.row}>
            <Text style={styles.rowLabel}>边播边存</Text>
            <Switch
              value={cacheWhilePlay}
              onValueChange={onToggleCacheWhilePlay}
              trackColor={{false: t.cardLight, true: t.primary}}
              thumbColor="#fff"
            />
          </View>
          {renderRow(
            '清除缓存',
            clearingCache ? '清理中…' : formatBytes(cacheBytes),
            onClearCache,
          )}
          {renderRow('最大缓存大小', cacheLimitLabel(maxCacheMb), () =>
            setSheet('cache'),
          )}
        </View>

        {/* 关于 */}
        <Text style={styles.groupTitle}>关于</Text>
        <View style={styles.group}>
          {renderRow('当前版本', `v${APP_VERSION}`, onVersionTap, false)}
          {renderRow('检查更新', checking ? '检查中…' : '', onCheckUpdate)}
          {renderRow('作者', 'XG.GM', () =>
            Linking.openURL('https://github.com/XG2020').catch(() => {}),
          )}
        </View>
      </ScrollView>

      {/* 音质 / 深色模式选择弹层 */}
      <Modal
        visible={sheet !== null}
        transparent
        statusBarTranslucent
        animationType="slide"
        onRequestClose={() => setSheet(null)}>
        <TouchableOpacity
          style={styles.sheetMask}
          activeOpacity={1}
          onPress={() => setSheet(null)}>
          <View style={styles.sheet} onStartShouldSetResponder={() => true}>
            <Text style={styles.sheetTitle}>
              {sheet === 'play'
                ? '在线听歌品质'
                : sheet === 'download'
                ? '歌曲下载品质'
                : sheet === 'cache'
                ? '最大缓存大小'
                : sheet === 'font'
                ? '字号大小'
                : '深色模式'}
            </Text>
            {sheet === 'theme'
              ? MODE_OPTIONS.map(opt => {
                  const active = mode === opt.value;
                  return (
                    <TouchableOpacity
                      key={opt.value}
                      style={styles.sheetItem}
                      onPress={() => {
                        setMode(opt.value);
                        setSheet(null);
                      }}>
                      <Text
                        style={[
                          styles.sheetItemLabel,
                          active && styles.sheetItemActive,
                        ]}>
                        {opt.label}
                      </Text>
                      {active && <Text style={styles.sheetCheck}>✓</Text>}
                    </TouchableOpacity>
                  );
                })
              : sheet === 'font'
              ? FONT_SIZE_OPTIONS.map(opt => {
                  const active = fontSize === opt.value;
                  return (
                    <TouchableOpacity
                      key={opt.value}
                      style={styles.sheetItem}
                      onPress={() => {
                        setFontSize(opt.value);
                        setSheet(null);
                      }}>
                      <Text
                        style={[
                          styles.sheetItemLabel,
                          active && styles.sheetItemActive,
                        ]}>
                        {opt.label}
                      </Text>
                      {active && <Text style={styles.sheetCheck}>✓</Text>}
                    </TouchableOpacity>
                  );
                })
              : sheet === 'cache'
              ? CACHE_LIMIT_OPTIONS.map(mb => {
                  const active = maxCacheMb === mb;
                  return (
                    <TouchableOpacity
                      key={mb}
                      style={styles.sheetItem}
                      onPress={() => onPickCacheLimit(mb)}>
                      <Text
                        style={[
                          styles.sheetItemLabel,
                          active && styles.sheetItemActive,
                        ]}>
                        {cacheLimitLabel(mb)}
                      </Text>
                      {active && <Text style={styles.sheetCheck}>✓</Text>}
                    </TouchableOpacity>
                  );
                })
              : QUALITY_OPTIONS.map(opt => {
                  const active =
                    (sheet === 'play' ? playQ : dlQ) === opt.value;
                  return (
                    <TouchableOpacity
                      key={opt.value}
                      style={styles.sheetItem}
                      onPress={() => onPickQuality(opt.value)}>
                      <View style={styles.sheetItemLeft}>
                        <Text
                          style={[
                            styles.sheetItemLabel,
                            active && styles.sheetItemActive,
                          ]}>
                          {opt.label}
                        </Text>
                        <Text style={styles.sheetItemDesc}>{opt.desc}</Text>
                      </View>
                      {active && <Text style={styles.sheetCheck}>✓</Text>}
                    </TouchableOpacity>
                  );
                })}
            {(sheet === 'play' || sheet === 'download') && (
              <Text style={styles.sheetHint}>高音质不可用时自动降级</Text>
            )}
            {sheet === 'cache' && (
              <Text style={styles.sheetHint}>
                缓存超过上限后启动时自动清理，最小 100 MB
              </Text>
            )}
            <TouchableOpacity
              style={styles.sheetCancel}
              onPress={() => setSheet(null)}>
              <Text style={styles.sheetCancelText}>取消</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* 开发者密钥验证（连点版本号 5 次触发） */}
      <Modal
        visible={keyModal}
        transparent
        statusBarTranslucent
        animationType="fade"
        onRequestClose={() => setKeyModal(false)}>
        <View style={styles.devMask}>
          <View style={styles.devCard}>
            <Text style={styles.devTitle}>开发者验证</Text>
            <TextInput
              style={styles.devInput}
              value={keyInput}
              onChangeText={setKeyInput}
              placeholder="请输入开发者密钥"
              placeholderTextColor={t.sub}
              autoCapitalize="characters"
              autoCorrect={false}
              autoFocus
              onSubmitEditing={onSubmitKey}
            />
            <View style={styles.devBtnRow}>
              <TouchableOpacity
                style={styles.devBtn}
                onPress={() => setKeyModal(false)}>
                <Text style={styles.devBtnText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.devBtn, styles.devBtnPrimary]}
                onPress={onSubmitKey}>
                <Text style={[styles.devBtnText, styles.devBtnTextPrimary]}>
                  确定
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 开发者模式：自定义 API 接口（内置接口地址不展示） */}
      <Modal
        visible={apiModal}
        transparent
        statusBarTranslucent
        animationType="fade"
        onRequestClose={() => setApiModal(false)}>
        <View style={styles.devMask}>
          <View style={styles.devCard}>
            <Text style={styles.devTitle}>开发者模式 · API 接口</Text>
            <Text style={styles.devHint}>留空并保存则恢复使用内置接口</Text>
            <TextInput
              style={styles.devInput}
              value={apiInput}
              onChangeText={setApiInput}
              placeholder="https://your-api.example.com"
              placeholderTextColor={t.sub}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            <View style={styles.devBtnRow}>
              <TouchableOpacity
                style={styles.devBtn}
                onPress={() => setApiModal(false)}>
                <Text style={styles.devBtnText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.devBtn, styles.devBtnPrimary]}
                onPress={onSaveApi}
                disabled={apiSaving}>
                {apiSaving ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={[styles.devBtnText, styles.devBtnTextPrimary]}>
                    保存
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const createStyles = (t: Theme) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: t.bg},
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    backText: {fontSize: 30, color: t.text, lineHeight: 32, paddingHorizontal: 4},
    backSpace: {width: 38},
    pageTitle: {
      flex: 1,
      fontSize: 18,
      fontWeight: '700',
      color: t.text,
      textAlign: 'center',
    },
    body: {paddingBottom: 32},
    groupTitle: {
      fontSize: 13,
      color: t.sub,
      marginTop: 18,
      marginBottom: 4,
      paddingHorizontal: 20,
    },
    group: {
      backgroundColor: t.card,
      marginHorizontal: 12,
      borderRadius: 14,
      paddingHorizontal: 16,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
    },
    rowLabel: {flex: 1, fontSize: 15, color: t.text},
    rowTextWrap: {flex: 1, marginRight: 8},
    rowSub: {color: t.sub, fontSize: 12, marginTop: 2, lineHeight: 16},
    rowValue: {color: t.sub, fontSize: 13, maxWidth: 160, marginRight: 4},
    rowArrow: {color: t.sub, fontSize: 18, lineHeight: 20},
    // 弹层
    sheetMask: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.55)',
      justifyContent: 'flex-end',
    },
    // 开发者模式弹窗（居中卡片）
    devMask: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.55)',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 32,
    },
    devCard: {
      alignSelf: 'stretch',
      // 弹窗背景：开启面板色时随板块色，否则保持卡片色
      backgroundColor: t.panel ?? t.card,
      borderRadius: 16,
      padding: 20,
    },
    devTitle: {
      color: t.text,
      fontSize: 16,
      fontWeight: '700',
      textAlign: 'center',
    },
    devHint: {color: t.sub, fontSize: 12, marginTop: 8, textAlign: 'center'},
    devInput: {
      marginTop: 14,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 9,
      color: t.text,
      fontSize: 14,
    },
    devBtnRow: {flexDirection: 'row', gap: 12, marginTop: 16},
    devBtn: {
      flex: 1,
      backgroundColor: t.sheetBtn,
      borderRadius: 20,
      paddingVertical: 10,
      alignItems: 'center',
      justifyContent: 'center',
    },
    devBtnPrimary: {backgroundColor: t.primary},
    devBtnText: {color: t.text, fontSize: 14},
    devBtnTextPrimary: {color: '#fff', fontWeight: '700'},
    sheet: {
      // 弹层背景：开启面板色时随板块色，否则保持卡片色
      backgroundColor: t.panel ?? t.card,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      paddingTop: 16,
      paddingBottom: 24,
      paddingHorizontal: 20,
      maxHeight: '75%',
    },
    sheetTitle: {
      color: t.text,
      fontSize: 16,
      fontWeight: '700',
      textAlign: 'center',
      marginBottom: 8,
    },
    sheetItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
    },
    sheetItemLeft: {flex: 1},
    sheetItemLabel: {flex: 1, color: t.text, fontSize: 15},
    sheetItemActive: {color: t.primary, fontWeight: '700'},
    sheetItemDesc: {color: t.sub, fontSize: 11, marginTop: 2},
    sheetCheck: {color: t.primary, fontSize: 18, fontWeight: '700'},
    sheetHint: {
      color: t.sub,
      fontSize: 11,
      textAlign: 'center',
      marginTop: 10,
    },
    sheetCancel: {
      marginTop: 12,
      backgroundColor: t.sheetBtn,
      borderRadius: 22,
      paddingVertical: 11,
      alignItems: 'center',
    },
    sheetCancelText: {color: t.text, fontSize: 15},
  });
