import React, {useEffect, useMemo, useState} from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Modal,
  FlatList,
  ActivityIndicator,
  Linking,
  Switch,
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
  getDownloadDir,
  setDownloadDir,
  FONT_SIZE_OPTIONS,
  fontSizeLabel,
  getAutoOpenPlayer,
  setAutoOpenPlayer,
  getShowRankTab,
  setShowRankTab,
} from '../services/settings';
import {applyQualityToCurrent} from '../services/player';
import {useSleepTimer, formatSleepRemaining} from '../services/sleepTimer';
import {listSubDirs, STORAGE_ROOT, DirEntry} from '../services/local';
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
  // 下载目录
  const [downloadDir, setDownloadDirState] = useState('');
  const [dirModal, setDirModal] = useState(false);
  const [browsePath, setBrowsePath] = useState(STORAGE_ROOT);
  const [browseDirs, setBrowseDirs] = useState<DirEntry[]>([]);
  const [browsing, setBrowsing] = useState(false);
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

  const refreshCacheSize = () => {
    getCacheBytes().then(setCacheBytes).catch(() => {});
  };

  useEffect(() => {
    getDownloadDir().then(setDownloadDirState);
    getPlayQuality().then(setPlayQ);
    getDownloadQuality().then(setDlQ);
    getMaxCacheMb().then(setMaxCacheMbState);
    getAutoOpenPlayer().then(setAutoOpen);
    getShowRankTab().then(setShowRank);
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

  const openDirBrowser = async (path: string) => {
    setBrowsing(true);
    setBrowsePath(path);
    try {
      setBrowseDirs(await listSubDirs(path));
    } catch (e) {
      setBrowseDirs([]);
    } finally {
      setBrowsing(false);
    }
  };

  const browseUp = () => {
    if (browsePath === STORAGE_ROOT) {
      return;
    }
    const parent = browsePath.slice(0, browsePath.lastIndexOf('/'));
    openDirBrowser(parent.length < STORAGE_ROOT.length ? STORAGE_ROOT : parent);
  };

  const pickDownloadDir = async () => {
    await setDownloadDir(browsePath);
    setDownloadDirState(browsePath);
    setDirModal(false);
    AppAlert.alert('已设置下载目录', browsePath);
  };

  const resetDownloadDir = async () => {
    await setDownloadDir('');
    setDownloadDirState('');
    setDirModal(false);
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
                  latest.url || 'https://github.com/XG2020/xmusic/releases',
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

  const dirShort = downloadDir
    ? downloadDir.replace(`${STORAGE_ROOT}/`, '')
    : '默认';

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.pageTitle}>设置</Text>
        <View style={styles.backSpace} />
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {/* 播放与下载 */}
        <Text style={styles.groupTitle}>播放与下载</Text>
        <View style={styles.group}>
          {renderRow('在线听歌品质', qualityOption(playQ).label, () =>
            setSheet('play'),
          )}
          {renderRow('歌曲下载品质', qualityOption(dlQ).label, () =>
            setSheet('download'),
          )}
          {renderRow('歌曲存储位置设置', dirShort, () => {
            setDirModal(true);
            openDirBrowser(downloadDir || STORAGE_ROOT);
          })}
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
          {renderRow('当前版本', `v${APP_VERSION}`, undefined, false)}
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

      {/* 下载目录浏览器 */}
      <Modal
        visible={dirModal}
        transparent
        animationType="slide"
        onRequestClose={() => setDirModal(false)}>
        <View style={styles.sheetMask}>
          <View style={styles.sheet}>
            <View style={styles.browseHeader}>
              <TouchableOpacity onPress={browseUp}>
                <Text style={styles.browseUp}>‹ 上级</Text>
              </TouchableOpacity>
              <Text style={styles.browsePath} numberOfLines={1}>
                {browsePath === STORAGE_ROOT
                  ? '内部存储'
                  : browsePath.replace(`${STORAGE_ROOT}/`, '')}
              </Text>
            </View>
            {browsing ? (
              <View style={styles.browseLoading}>
                <ActivityIndicator color={t.primary} />
              </View>
            ) : (
              <FlatList
                data={browseDirs}
                keyExtractor={d => d.path}
                style={styles.sheetList}
                ListEmptyComponent={
                  <Text style={styles.sheetEmpty}>没有子文件夹</Text>
                }
                renderItem={({item}) => (
                  <TouchableOpacity
                    style={styles.dirItem}
                    onPress={() => openDirBrowser(item.path)}>
                    <Text style={styles.dirIcon}>📁</Text>
                    <Text style={styles.dirName} numberOfLines={1}>
                      {item.name}
                    </Text>
                    <Text style={styles.dirArrow}>›</Text>
                  </TouchableOpacity>
                )}
              />
            )}
            <TouchableOpacity
              style={styles.sheetPrimaryBtn}
              onPress={pickDownloadDir}>
              <Text style={styles.sheetPrimaryText}>✓ 下载到此文件夹</Text>
            </TouchableOpacity>
            {!!downloadDir && (
              <TouchableOpacity
                style={styles.sheetOutlineBtn}
                onPress={resetDownloadDir}>
                <Text style={styles.sheetOutlineText}>恢复默认目录</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={styles.sheetCancel}
              onPress={() => setDirModal(false)}>
              <Text style={styles.sheetCancelText}>取消</Text>
            </TouchableOpacity>
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
    rowValue: {color: t.sub, fontSize: 13, maxWidth: 160, marginRight: 4},
    rowArrow: {color: t.sub, fontSize: 18, lineHeight: 20},
    // 弹层
    sheetMask: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.55)',
      justifyContent: 'flex-end',
    },
    sheet: {
      backgroundColor: t.card,
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
    // 目录浏览器
    browseHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      marginBottom: 8,
    },
    browseUp: {color: t.primary, fontSize: 14, fontWeight: '700'},
    browsePath: {flex: 1, color: t.sub, fontSize: 12},
    browseLoading: {paddingVertical: 30, alignItems: 'center'},
    sheetList: {flexGrow: 0, marginBottom: 4},
    sheetEmpty: {
      textAlign: 'center',
      color: t.sub,
      fontSize: 12,
      paddingVertical: 24,
    },
    dirItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 11,
      gap: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
    },
    dirIcon: {fontSize: 16},
    dirName: {flex: 1, color: t.text, fontSize: 14},
    dirArrow: {color: t.sub, fontSize: 18},
    sheetPrimaryBtn: {
      backgroundColor: t.primary,
      borderRadius: 22,
      paddingVertical: 11,
      alignItems: 'center',
      marginTop: 8,
    },
    sheetPrimaryText: {color: '#fff', fontSize: 15, fontWeight: '700'},
    sheetOutlineBtn: {
      marginTop: 10,
      borderRadius: 22,
      paddingVertical: 11,
      alignItems: 'center',
      borderWidth: 1,
      borderColor: t.primary,
    },
    sheetOutlineText: {color: t.primary, fontSize: 15, fontWeight: '600'},
  });
