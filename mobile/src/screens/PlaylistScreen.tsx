import React, {useEffect, useMemo, useState} from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import {AppAlert} from '../components/AppDialog';
import {SafeAreaView} from 'react-native-safe-area-context';
import {getPlaylist, getPreferredSongUrls, pinPlaylistCache, resolvePlaylistId} from '../services/api';
import type {Song} from '../types/music';
import {playSongs} from '../services/player';
import {autoOpenPlayerEnabled} from '../services/settings';
import {addRecentSongs, isFavPlaylist, toggleFavPlaylist} from '../services/store';
import SongActionSheet from '../components/SongActionSheet';
import Icon from '../components/Icon';
import {useSkin} from '../services/skin';
import {useTheme, Theme} from '../theme';

export default function PlaylistScreen({navigation, route}: any) {
  const {t} = useTheme();
  const skin = useSkin();
  const styles = useMemo(() => createStyles(t), [t]);
  // 从歌单搜索结果进入时带 id/name 参数，自动加载并隐藏手动输入行
  const routeId = route?.params?.id;
  const routeName: string = route?.params?.name ?? '';
  const [playlistId, setPlaylistId] = useState(routeId ? String(routeId) : '');
  const [name, setName] = useState(routeName);
  const [songs, setSongs] = useState<Song[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionSong, setActionSong] = useState<Song | null>(null);
  // 收藏在线歌单：记录成功加载的 dissid/封面用作收藏摘要
  const [resolvedId, setResolvedId] = useState<string | number | null>(null);
  const [coverUrl, setCoverUrl] = useState<string | undefined>(undefined);
  const [faved, setFaved] = useState(false);

  const load = async (input?: string) => {
    const text = (input ?? playlistId).trim();
    if (!text) {
      return;
    }
    // 分享短链需请求跟随重定向才能拿到歌单 ID，解析期间也显示加载态
    setLoading(true);
    try {
      const id = await resolvePlaylistId(text);
      if (!id) {
        AppAlert.alert('无法识别', '请输入歌单 ID 或粘贴 QQ 音乐分享链接');
        return;
      }
      const data = await getPlaylist(id);
      const list = data?.songs ?? [];
      const mids = list.map(s => s.mid!).filter(Boolean);
      const urls = mids.length ? await getPreferredSongUrls(mids) : {};
      setName(data?.name ?? '');
      setResolvedId(id);
      setCoverUrl(data?.coverUrl);
      isFavPlaylist(id).then(setFaved);
      setSongs(
        list.map(s => ({
          ...s,
          url: s.mid ? urls?.[s.mid] : undefined,
        })),
      );
    } catch (e) {
      AppAlert.alert('加载失败', '请确认歌单 ID 是否正确');
    } finally {
      setLoading(false);
    }
  };

  // 带 id 参数进入（歌单搜索结果点击）时自动加载
  useEffect(() => {
    if (routeId) {
      setPlaylistId(String(routeId));
      load(String(routeId));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId, route?.params?.ts]);

  const playAt = (index: number) => {
    addRecentSongs([songs[index]]);
    playSongs(songs, index);
    if (autoOpenPlayerEnabled()) {
      navigation.navigate('Player');
    }
  };

  /** 收藏/取消收藏当前歌单（成功加载后才可用） */
  const onToggleFav = async () => {
    if (!resolvedId) {
      return;
    }
    const next = await toggleFavPlaylist({
      id: resolvedId,
      name: name || `歌单 ${resolvedId}`,
      coverUrl: coverUrl ?? songs[0]?.coverUrl,
      songCount: songs.length,
    });
    if (next) {
      // 收藏即把当前歌单内容缓存续期为长缓存，下次进入秒开
      pinPlaylistCache(resolvedId);
    }
    setFaved(next);
  };

  return (
    <SafeAreaView style={[styles.container, !!skin.bg && styles.transparentBg]} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.pageTitle} numberOfLines={1}>
          {name || '歌单'}
        </Text>
      </View>

      {/* 搜索结果进入时隐藏手动输入行（id 已确定） */}
      {!routeId && (
        <View style={styles.row}>
          <TextInput
            style={styles.input}
            placeholder="输入歌单 ID 或粘贴分享链接"
            placeholderTextColor={t.sub}
            value={playlistId}
            onChangeText={setPlaylistId}
            onSubmitEditing={() => load()}
          />
          <TouchableOpacity style={styles.btn} onPress={() => load()}>
            <Text style={styles.btnText}>{loading ? '...' : '加载'}</Text>
          </TouchableOpacity>
        </View>
      )}

      {!!name && !routeId && <Text style={styles.playlistName}>{name}</Text>}
      {songs.length > 0 && (
        <View style={styles.playAllRow}>
          <TouchableOpacity style={styles.playAll} onPress={() => playAt(0)}>
            <Text style={styles.playAllIcon}>▶</Text>
            <Text style={styles.playAllText}>播放全部 ({songs.length})</Text>
          </TouchableOpacity>
          {/* 在线歌单（有 dissid）才可收藏 */}
          {!!resolvedId && (
            <TouchableOpacity
              style={styles.favBtn}
              onPress={onToggleFav}
              hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
              <Icon
                name={faved ? 'favOn' : 'favOff'}
                size={22}
                color={faved ? undefined : t.sub}
              />
            </TouchableOpacity>
          )}
        </View>
      )}

      {loading ? (
        <ActivityIndicator style={styles.loading} color={t.primary} size="large" />
      ) : (
        <FlatList
          showsVerticalScrollIndicator={false}
          data={songs}
          keyExtractor={(item, i) => item.mid ?? `${item.title}-${i}`}
          renderItem={({item, index}) => (
            <View style={styles.item}>
              {/* 主点击区与右侧「⋮」拆成兄弟节点，避免点按钮时误触发行点击 */}
              <TouchableOpacity
                style={styles.itemMain}
                activeOpacity={0.7}
                onPress={() => playAt(index)}>
                <Text style={styles.index}>{index + 1}</Text>
                <View style={styles.itemInfo}>
                  <Text style={styles.title} numberOfLines={1}>
                    {item.title}
                  </Text>
                  <Text style={styles.sub} numberOfLines={1}>
                    {item.singer?.map(s => s.name).join(' / ')}
                  </Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.moreBtn}
                onPress={() => setActionSong(item)}
                hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                <Icon name="more" size={16} style={styles.moreIcon} />
              </TouchableOpacity>
            </View>
          )}
        />
      )}

      <SongActionSheet song={actionSong} onClose={() => setActionSong(null)} />
    </SafeAreaView>
  );
}

const createStyles = (t: Theme) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: t.bg},
    transparentBg: {backgroundColor: 'transparent'},
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    backText: {fontSize: 30, color: t.text, lineHeight: 32, paddingHorizontal: 4},
    pageTitle: {fontSize: 18, fontWeight: '700', color: t.text, flex: 1},
    row: {flexDirection: 'row', gap: 8, paddingHorizontal: 12},
    input: {
      flex: 1,
      // 搜索框胶囊：开启面板色时随板块色，否则保持卡片色
      backgroundColor: t.panel ?? t.card,
      borderRadius: 18,
      paddingHorizontal: 14,
      height: 38,
      fontSize: 14,
      color: t.text,
    },
    btn: {
      backgroundColor: t.primary,
      paddingHorizontal: 18,
      justifyContent: 'center',
      borderRadius: 18,
    },
    btnText: {color: '#fff', fontWeight: '700'},
    playlistName: {
      fontSize: 16,
      fontWeight: '700',
      color: t.text,
      marginHorizontal: 16,
      marginTop: 12,
    },
    playAllRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
    },
    playAll: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 10,
    },
    playAllIcon: {color: t.primary, fontSize: 14},
    playAllText: {fontSize: 14, fontWeight: '700', color: t.text},
    favBtn: {paddingHorizontal: 4, paddingVertical: 6},
    loading: {marginTop: 40},
    item: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      paddingLeft: 16,
      paddingRight: 4,
    },
    // 行主点击区（占满左侧空间，与右侧按钮兄弟布局）
    itemMain: {flex: 1, flexDirection: 'row', alignItems: 'center'},
    index: {width: 30, fontSize: 14, color: t.sub},
    itemInfo: {flex: 1},
    title: {fontSize: 15, fontWeight: '600', color: t.text},
    sub: {fontSize: 12, color: t.sub, marginTop: 3},
    moreBtn: {paddingHorizontal: 12, paddingVertical: 6},
    moreIcon: {tintColor: t.sub},
  });
