import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Platform,
  ActivityIndicator,
  Modal,
} from 'react-native';
import {AppAlert} from '../components/AppDialog';
import {SafeAreaView} from 'react-native-safe-area-context';
import RNFS from 'react-native-fs';
import {check, request, PERMISSIONS, RESULTS} from 'react-native-permissions';
import {
  scanLocalSongs,
  listSubDirs,
  STORAGE_ROOT,
  DirEntry,
} from '../services/local';
import {
  getScanFolders,
  addScanFolder,
  removeScanFolder,
  autoOpenPlayerEnabled,
} from '../services/settings';
import {playSongs} from '../services/player';
import SongActionSheet from '../components/SongActionSheet';
import Icon from '../components/Icon';
import {formatDuration} from '../utils/format';
import {useTheme, Theme} from '../theme';
import type {Song} from '../types/music';

async function ensurePermission() {
  const perm =
    Number(Platform.Version) >= 33
      ? PERMISSIONS.ANDROID.READ_MEDIA_AUDIO
      : PERMISSIONS.ANDROID.READ_EXTERNAL_STORAGE;
  const status = await check(perm);
  if (status !== RESULTS.GRANTED) {
    const requested = await request(perm);
    if (requested !== RESULTS.GRANTED) {
      throw new Error('读取本地音乐权限被拒绝');
    }
  }
}

/** 本地歌曲行（memo 化：上千首扫描结果滚动时不整列表重渲染） */
type LocalRowProps = {
  item: Song;
  index: number;
  styles: ReturnType<typeof createStyles>;
  onPress: (index: number) => void;
  onMore: (item: Song) => void;
};

const LocalSongRow = React.memo(
  ({item, index, styles, onPress, onMore}: LocalRowProps) => (
    <TouchableOpacity style={styles.item} onPress={() => onPress(index)}>
      <View style={styles.itemInfo}>
        <Text style={styles.title} numberOfLines={1}>
          {item.title}
        </Text>
        <Text style={styles.sub} numberOfLines={1}>
          {item.singer?.map(s => s.name).join(' / ') ?? '未知歌手'}
        </Text>
      </View>
      <Text style={styles.duration}>
        {item.interval ? formatDuration(item.interval) : ''}
      </Text>
      <TouchableOpacity
        style={styles.moreBtn}
        onPress={() => onMore(item)}
        hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
        <Icon name="more" size={16} style={styles.moreIcon} />
      </TouchableOpacity>
    </TouchableOpacity>
  ),
);

export default function LocalScreen({navigation}: any) {
  const {t} = useTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const [songs, setSongs] = useState<Song[]>([]);
  const [scanning, setScanning] = useState(false);
  const [actionSong, setActionSong] = useState<Song | null>(null);
  // 自定义扫描文件夹管理
  const [folderModal, setFolderModal] = useState(false);
  const [folders, setFolders] = useState<string[]>([]);
  // 目录浏览器：null = 显示已添加列表，非 null = 正在浏览该目录
  const [browsePath, setBrowsePath] = useState<string | null>(null);
  const [browseDirs, setBrowseDirs] = useState<DirEntry[]>([]);
  const [browsing, setBrowsing] = useState(false);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      await ensurePermission();
      const list = await scanLocalSongs();
      setSongs(list);
      if (!list.length) {
        AppAlert.alert('扫描完成', '未找到本地音乐文件');
      }
    } catch (e) {
      AppAlert.alert('无法读取本地音乐', '请授予媒体读取权限后重试');
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    scan();
    getScanFolders().then(setFolders);
  }, [scan]);

  const playAt = (index: number) => {
    playSongs(songs, index);
    if (autoOpenPlayerEnabled()) {
      navigation.navigate('Player');
    }
  };

  // 行回调经 ref 中转保持引用稳定，配合 memo 行组件
  const playAtRef = useRef(playAt);
  playAtRef.current = playAt;
  const onRowPress = useCallback((index: number) => playAtRef.current(index), []);
  const onRowMore = useCallback((item: Song) => setActionSong(item), []);

  /** 长按删除本地文件 */
  const onDeleteSong = (song: Song) => {
    if (!song.localPath) {
      return;
    }
    AppAlert.alert('删除歌曲', `将从设备中删除文件：\n${song.localPath}`, [
      {text: '取消', style: 'cancel'},
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          try {
            await RNFS.unlink(song.localPath!);
            setSongs(prev => prev.filter(s => s.localPath !== song.localPath));
          } catch (e) {
            AppAlert.alert('删除失败', '文件可能已被移除或没有删除权限');
          }
        },
      },
    ]);
  };

  // ===== 文件夹管理 =====

  const openBrowser = async (path: string) => {
    setBrowsing(true);
    setBrowsePath(path);
    try {
      await ensurePermission();
      setBrowseDirs(await listSubDirs(path));
    } catch (e) {
      setBrowseDirs([]);
    } finally {
      setBrowsing(false);
    }
  };

  const browseUp = () => {
    if (!browsePath || browsePath === STORAGE_ROOT) {
      setBrowsePath(null);
      return;
    }
    const parent = browsePath.slice(0, browsePath.lastIndexOf('/'));
    openBrowser(parent.length < STORAGE_ROOT.length ? STORAGE_ROOT : parent);
  };

  const onAddFolder = async (path: string) => {
    const list = await addScanFolder(path);
    setFolders([...list]);
    setBrowsePath(null);
    AppAlert.alert('已添加', `${path}\n\n点击"扫描歌曲"生效`);
  };

  const onRemoveFolder = (path: string) => {
    AppAlert.alert('移除文件夹', path, [
      {text: '取消', style: 'cancel'},
      {
        text: '移除',
        style: 'destructive',
        onPress: async () => {
          const list = await removeScanFolder(path);
          setFolders([...list]);
        },
      },
    ]);
  };

  const closeFolderModal = () => {
    setFolderModal(false);
    setBrowsePath(null);
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.pageTitle}>本地音乐</Text>
        <TouchableOpacity
          style={styles.headerBtn}
          onPress={() => setFolderModal(true)}>
          <Text style={styles.headerBtnText}>📁 文件夹</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.scanBtn}
          disabled={scanning}
          onPress={scan}>
          <Text style={styles.scanBtnText}>
            {scanning ? '扫描中…' : '扫描歌曲'}
          </Text>
        </TouchableOpacity>
      </View>

      {songs.length > 0 && (
        <TouchableOpacity style={styles.playAll} onPress={() => playAt(0)}>
          <Text style={styles.playAllIcon}>▶</Text>
          <Text style={styles.playAllText}>播放全部 ({songs.length})</Text>
        </TouchableOpacity>
      )}

      {scanning && songs.length === 0 ? (
        <View style={styles.scanningWrap}>
          <ActivityIndicator color={t.primary} size="large" />
          <Text style={styles.scanningText}>正在扫描本地音乐…</Text>
        </View>
      ) : (
        <FlatList
          data={songs}
          keyExtractor={(item, i) => item.localPath ?? `${item.title}-${i}`}
          // 大列表渲染优化：分批渲染 + 收窄渲染窗口 + 裁剪离屏行
          initialNumToRender={12}
          maxToRenderPerBatch={16}
          windowSize={9}
          updateCellsBatchingPeriod={40}
          removeClippedSubviews
          ListEmptyComponent={
            <Text style={styles.empty}>
              没有找到本地音乐文件{'\n'}支持 mp3 / flac / m4a / wav 等格式
              {'\n'}可点击右上角"文件夹"添加自定义扫描目录
              {'\n'}点击歌曲右侧「⋮」可收藏、加歌单或删除文件
            </Text>
          }
          renderItem={({item, index}) => (
            <LocalSongRow
              item={item}
              index={index}
              styles={styles}
              onPress={onRowPress}
              onMore={onRowMore}
            />
          )}
        />
      )}

      {/* 歌曲操作菜单（行尾 ⋮ 打开） */}
      <SongActionSheet
        song={actionSong}
        onClose={() => setActionSong(null)}
        extraActions={
          actionSong
            ? [
                {
                  label: '删除本地文件',
                  destructive: true,
                  onPress: () => onDeleteSong(actionSong),
                },
              ]
            : undefined
        }
      />

      {/* 自定义扫描文件夹管理弹层 */}
      <Modal
        visible={folderModal}
        transparent
        animationType="slide"
        onRequestClose={closeFolderModal}>
        <View style={styles.sheetMask}>
          <View style={styles.sheet}>
            {browsePath === null ? (
              <>
                {/* 已添加的文件夹列表 */}
                <Text style={styles.sheetTitle}>自定义扫描文件夹</Text>
                <FlatList
                  data={folders}
                  keyExtractor={p => p}
                  style={styles.sheetList}
                  ListEmptyComponent={
                    <Text style={styles.sheetEmpty}>
                      暂无自定义文件夹{'\n'}
                      默认扫描 Music、Download 及系统媒体库
                    </Text>
                  }
                  renderItem={({item}) => (
                    <View style={styles.folderItem}>
                      <Text style={styles.folderPath} numberOfLines={2}>
                        {item.replace(`${STORAGE_ROOT}/`, '')}
                      </Text>
                      <TouchableOpacity onPress={() => onRemoveFolder(item)}>
                        <Text style={styles.folderRemove}>✕</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                />
                <TouchableOpacity
                  style={styles.sheetPrimaryBtn}
                  onPress={() => openBrowser(STORAGE_ROOT)}>
                  <Text style={styles.sheetPrimaryText}>＋ 添加文件夹</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.sheetCancel}
                  onPress={closeFolderModal}>
                  <Text style={styles.sheetCancelText}>关闭</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                {/* 目录浏览器 */}
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
                        onPress={() => openBrowser(item.path)}>
                        <Text style={styles.dirIcon}>📁</Text>
                        <Text style={styles.dirName} numberOfLines={1}>
                          {item.name}
                        </Text>
                        {item.audioCount > 0 && (
                          <Text style={styles.dirCount}>
                            {item.audioCount} 首
                          </Text>
                        )}
                        <Text style={styles.dirArrow}>›</Text>
                      </TouchableOpacity>
                    )}
                  />
                )}
                <TouchableOpacity
                  style={styles.sheetPrimaryBtn}
                  onPress={() => onAddFolder(browsePath)}>
                  <Text style={styles.sheetPrimaryText}>✓ 添加此文件夹</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.sheetCancel}
                  onPress={() => setBrowsePath(null)}>
                  <Text style={styles.sheetCancelText}>返回列表</Text>
                </TouchableOpacity>
              </>
            )}
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
    pageTitle: {flex: 1, fontSize: 18, fontWeight: '700', color: t.text},
    headerBtn: {
      backgroundColor: t.card,
      borderRadius: 15,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    headerBtnText: {color: t.text, fontSize: 12},
    scanBtn: {
      backgroundColor: t.card,
      borderRadius: 15,
      paddingHorizontal: 14,
      paddingVertical: 6,
      borderWidth: 1,
      borderColor: t.primary,
    },
    scanBtnText: {color: t.primary, fontSize: 12, fontWeight: '700'},
    playAll: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    playAllIcon: {color: t.primary, fontSize: 14},
    playAllText: {fontSize: 14, fontWeight: '700', color: t.text},
    scanningWrap: {alignItems: 'center', marginTop: 60, gap: 12},
    scanningText: {color: t.sub, fontSize: 13},
    empty: {
      textAlign: 'center',
      color: t.sub,
      marginTop: 40,
      fontSize: 13,
      lineHeight: 22,
    },
    item: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
      paddingLeft: 16,
      paddingRight: 4,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
    },
    itemInfo: {flex: 1},
    title: {fontSize: 15, fontWeight: '600', color: t.text},
    sub: {fontSize: 12, color: t.sub, marginTop: 3},
    duration: {fontSize: 12, color: t.sub},
    moreBtn: {paddingHorizontal: 12, paddingVertical: 6},
    moreIcon: {tintColor: t.sub},
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
      paddingHorizontal: 16,
      maxHeight: '75%',
      minHeight: 320,
    },
    sheetTitle: {
      color: t.text,
      fontSize: 16,
      fontWeight: '700',
      textAlign: 'center',
      marginBottom: 8,
    },
    sheetList: {flexGrow: 0, marginBottom: 4},
    sheetEmpty: {
      textAlign: 'center',
      color: t.sub,
      fontSize: 12,
      lineHeight: 20,
      paddingVertical: 24,
    },
    folderItem: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: t.cardLight,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      marginBottom: 8,
      gap: 10,
    },
    folderPath: {flex: 1, color: t.text, fontSize: 13},
    folderRemove: {color: t.sub, fontSize: 16, paddingHorizontal: 4},
    sheetPrimaryBtn: {
      backgroundColor: t.primary,
      borderRadius: 22,
      paddingVertical: 11,
      alignItems: 'center',
      marginTop: 8,
    },
    sheetPrimaryText: {color: '#fff', fontSize: 15, fontWeight: '700'},
    sheetCancel: {
      marginTop: 10,
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
    dirCount: {color: t.primary, fontSize: 11},
    dirArrow: {color: t.sub, fontSize: 18},
  });
