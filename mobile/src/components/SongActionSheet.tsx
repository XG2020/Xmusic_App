import React, {useEffect, useMemo, useState} from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Modal,
  Clipboard,
  ToastAndroid,
  Platform,
} from 'react-native';
import {AppAlert} from './AppDialog';
import {playNext} from '../services/player';
import {startDownload} from '../services/downloadManager';
import {
  isFav,
  toggleFav,
  getLocalPlaylists,
  createLocalPlaylist,
  addSongsToPlaylist,
  LocalPlaylist,
} from '../services/store';
import {useTheme, Theme} from '../theme';
import Icon from './Icon';
import type {Song} from '../types/music';

export type SongAction = {
  label: string;
  destructive?: boolean;
  onPress: () => void;
};

type Props = {
  /** 为 null 时隐藏弹层 */
  song: Song | null;
  onClose: () => void;
  /** 场景专属操作（如删除本地文件、从歌单移除），显示在通用操作之后 */
  extraActions?: SongAction[];
};

/**
 * 歌曲长按操作弹层：下一曲播放 / 收藏 / 添加到歌单（可新建）
 */
export default function SongActionSheet({song, onClose, extraActions}: Props) {
  const {t} = useTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const [panel, setPanel] = useState<'main' | 'pls'>('main');
  const [fav, setFav] = useState(false);
  const [playlists, setPlaylists] = useState<LocalPlaylist[]>([]);
  const [newName, setNewName] = useState('');

  useEffect(() => {
    if (song) {
      setPanel('main');
      setNewName('');
      isFav(song).then(setFav);
    }
  }, [song]);

  const onPlayNext = async () => {
    if (!song) {
      return;
    }
    onClose();
    const ok = await playNext(song);
    // 自动消失的轻提示，不打断操作
    if (ok) {
      ToastAndroid.show(`已添加为下一曲播放：${song.title}`, ToastAndroid.SHORT);
    } else {
      ToastAndroid.show('操作失败：未获取到歌曲播放地址', ToastAndroid.SHORT);
    }
  };

  const onToggleFav = async () => {
    if (!song) {
      return;
    }
    const now = await toggleFav(song);
    onClose();
    AppAlert.alert(now ? '已添加到"我喜欢"' : '已取消收藏', song.title);
  };

  const openPlaylists = async () => {
    setPlaylists(await getLocalPlaylists());
    setPanel('pls');
  };

  const onAddTo = async (pl: LocalPlaylist) => {
    if (!song) {
      return;
    }
    const added = await addSongsToPlaylist(pl.id, [song]);
    onClose();
    AppAlert.alert(
      added ? `已添加到《${pl.name}》` : '歌曲已在该歌单中',
      song.title,
    );
  };

  const onCreateAndAdd = async () => {
    if (!song) {
      return;
    }
    const name = newName.trim();
    if (!name) {
      AppAlert.alert('请输入歌单名称');
      return;
    }
    await createLocalPlaylist(name, [song], song.coverUrl);
    onClose();
    AppAlert.alert('已创建歌单', `《${name}》已收录「${song.title}」`);
  };

  /** 按默认下载音质后台下载 */
  const onDownloadSong = async () => {
    if (!song) {
      return;
    }
    onClose();
    const ok = await startDownload(song);
    if (ok) {
      AppAlert.alert('已开始下载', '进度可在「下载管理」中查看');
    } else {
      AppAlert.alert('无法下载', '该歌曲正在下载中或没有可用地址');
    }
  };

  /** 复制「歌名 - 歌手」到剪贴板 */
  const onCopyName = () => {
    if (!song) {
      return;
    }
    const singers = song.singer?.map(s => s.name).join(' / ');
    const text = singers ? `${song.title} - ${singers}` : song.title;
    Clipboard.setString(text);
    onClose();
    if (Platform.OS === 'android') {
      ToastAndroid.show('已复制歌名', ToastAndroid.SHORT);
    } else {
      AppAlert.alert('已复制歌名', text);
    }
  };

  return (
    <Modal
      visible={!!song}
      transparent
      animationType="slide"
      onRequestClose={onClose}>
      <TouchableOpacity
        style={styles.mask}
        activeOpacity={1}
        onPress={onClose}>
        <View style={styles.sheet} onStartShouldSetResponder={() => true}>
          <Text style={styles.songTitle} numberOfLines={1}>
            {song?.title}
            {song?.singer?.length ? (
              <Text style={styles.songArtist}>
                {'  '}
                {song.singer.map(s => s.name).join(' / ')}
              </Text>
            ) : null}
          </Text>

          {panel === 'main' ? (
            <>
              <TouchableOpacity style={styles.item} onPress={onPlayNext}>
                <Text style={styles.itemIcon}>▶</Text>
                <Text style={styles.itemLabel}>下一曲播放</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.item} onPress={onToggleFav}>
                <Text style={[styles.itemIcon, fav && styles.favActive]}>
                  {fav ? '♥' : '♡'}
                </Text>
                <Text style={styles.itemLabel}>
                  {fav ? '取消收藏' : '收藏到"我喜欢"'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.item} onPress={openPlaylists}>
                <Text style={styles.itemIcon}>＋</Text>
                <Text style={styles.itemLabel}>添加到歌单…</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.item} onPress={onDownloadSong}>
                <View style={styles.itemIconWrap}>
                  <Icon name="downloadFilled" size={22} color={t.primary} />
                </View>
                <Text style={styles.itemLabel}>下载</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.item} onPress={onCopyName}>
                <Text style={styles.itemIcon}>⧉</Text>
                <Text style={styles.itemLabel}>复制歌名</Text>
              </TouchableOpacity>
              {extraActions?.map(a => (
                <TouchableOpacity
                  key={a.label}
                  style={styles.item}
                  onPress={() => {
                    onClose();
                    a.onPress();
                  }}>
                  {a.destructive ? (
                    // 垃圾桶用单色素材红色着色，与菜单内其他单色图标风格统一
                    <View style={styles.itemIconWrap}>
                      <Icon name="garbage" size={32} color="#E5484D" />
                    </View>
                  ) : (
                    <Text style={styles.itemIcon}>·</Text>
                  )}
                  <Text
                    style={[
                      styles.itemLabel,
                      a.destructive && styles.destructive,
                    ]}>
                    {a.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </>
          ) : (
            <>
              <FlatList
                data={playlists}
                keyExtractor={p => p.id}
                style={styles.plList}
                ListEmptyComponent={
                  <Text style={styles.plEmpty}>暂无歌单，可在下方新建</Text>
                }
                renderItem={({item}) => (
                  <TouchableOpacity
                    style={styles.item}
                    onPress={() => onAddTo(item)}>
                    <Text style={styles.itemIcon}>📃</Text>
                    <Text style={styles.itemLabel} numberOfLines={1}>
                      {item.name}
                    </Text>
                    <Text style={styles.plCount}>{item.songs.length} 首</Text>
                  </TouchableOpacity>
                )}
              />
              <View style={styles.createRow}>
                <TextInput
                  style={styles.createInput}
                  placeholder="新建歌单名称"
                  placeholderTextColor={t.sub}
                  value={newName}
                  onChangeText={setNewName}
                  onSubmitEditing={onCreateAndAdd}
                />
                <TouchableOpacity
                  style={styles.createBtn}
                  onPress={onCreateAndAdd}>
                  <Text style={styles.createBtnText}>新建</Text>
                </TouchableOpacity>
              </View>
              <TouchableOpacity
                style={styles.backBtn}
                onPress={() => setPanel('main')}>
                <Text style={styles.backBtnText}>‹ 返回</Text>
              </TouchableOpacity>
            </>
          )}

          <TouchableOpacity style={styles.cancel} onPress={onClose}>
            <Text style={styles.cancelText}>取消</Text>
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

const createStyles = (t: Theme) =>
  StyleSheet.create({
    mask: {
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
      maxHeight: '70%',
    },
    songTitle: {
      color: t.text,
      fontSize: 15,
      fontWeight: '700',
      textAlign: 'center',
      marginBottom: 8,
    },
    songArtist: {color: t.sub, fontSize: 12, fontWeight: '400'},
    item: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 13,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
    },
    itemIcon: {fontSize: 20, color: t.primary, width: 32, textAlign: 'center'},
    itemIconWrap: {width: 32, alignItems: 'center'},
    favActive: {color: '#FF5A79'},
    itemLabel: {flex: 1, color: t.text, fontSize: 15},
    destructive: {color: '#E5484D'},
    plList: {flexGrow: 0},
    plEmpty: {
      textAlign: 'center',
      color: t.sub,
      fontSize: 12,
      paddingVertical: 20,
    },
    plCount: {color: t.sub, fontSize: 12},
    createRow: {flexDirection: 'row', gap: 10, marginTop: 12},
    createInput: {
      flex: 1,
      backgroundColor: t.cardLight,
      borderRadius: 18,
      paddingHorizontal: 14,
      height: 40,
      fontSize: 13,
      color: t.text,
    },
    createBtn: {
      backgroundColor: t.primary,
      borderRadius: 18,
      paddingHorizontal: 20,
      justifyContent: 'center',
    },
    createBtnText: {color: '#fff', fontSize: 14, fontWeight: '700'},
    backBtn: {marginTop: 10, alignItems: 'center', paddingVertical: 6},
    backBtnText: {color: t.primary, fontSize: 14, fontWeight: '600'},
    cancel: {
      marginTop: 12,
      backgroundColor: t.sheetBtn,
      borderRadius: 22,
      paddingVertical: 11,
      alignItems: 'center',
    },
    cancelText: {color: t.text, fontSize: 15},
  });
