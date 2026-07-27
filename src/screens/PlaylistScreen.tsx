import React, {useMemo, useState} from 'react';
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
import {getPlaylist, getPreferredSongUrls, parsePlaylistId} from '../services/api';
import type {Song} from '../types/music';
import {playSongs} from '../services/player';
import {autoOpenPlayerEnabled} from '../services/settings';
import {addRecentSongs} from '../services/store';
import SongActionSheet from '../components/SongActionSheet';
import Icon from '../components/Icon';
import {useTheme, Theme} from '../theme';

export default function PlaylistScreen({navigation}: any) {
  const {t} = useTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const [playlistId, setPlaylistId] = useState('');
  const [name, setName] = useState('');
  const [songs, setSongs] = useState<Song[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionSong, setActionSong] = useState<Song | null>(null);

  const load = async () => {
    const id = parsePlaylistId(playlistId);
    if (!id) {
      if (playlistId.trim()) {
        AppAlert.alert('无法识别', '请输入歌单 ID 或粘贴 QQ 音乐分享链接');
      }
      return;
    }
    setLoading(true);
    try {
      const data = await getPlaylist(id);
      const list = data?.songs ?? [];
      const mids = list.map(s => s.mid!).filter(Boolean);
      const urls = mids.length ? await getPreferredSongUrls(mids) : {};
      setName(data?.name ?? '');
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

  const playAt = (index: number) => {
    addRecentSongs([songs[index]]);
    playSongs(songs, index);
    if (autoOpenPlayerEnabled()) {
      navigation.navigate('Player');
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.pageTitle}>歌单</Text>
      </View>

      <View style={styles.row}>
        <TextInput
          style={styles.input}
          placeholder="输入歌单 ID 或粘贴分享链接"
          placeholderTextColor={t.sub}
          value={playlistId}
          onChangeText={setPlaylistId}
          onSubmitEditing={load}
        />
        <TouchableOpacity style={styles.btn} onPress={load}>
          <Text style={styles.btnText}>{loading ? '...' : '加载'}</Text>
        </TouchableOpacity>
      </View>

      {!!name && <Text style={styles.playlistName}>{name}</Text>}
      {songs.length > 0 && (
        <TouchableOpacity style={styles.playAll} onPress={() => playAt(0)}>
          <Text style={styles.playAllIcon}>▶</Text>
          <Text style={styles.playAllText}>播放全部 ({songs.length})</Text>
        </TouchableOpacity>
      )}

      {loading ? (
        <ActivityIndicator style={styles.loading} color={t.primary} size="large" />
      ) : (
        <FlatList
          data={songs}
          keyExtractor={(item, i) => item.mid ?? `${item.title}-${i}`}
          renderItem={({item, index}) => (
            <TouchableOpacity style={styles.item} onPress={() => playAt(index)}>
              <Text style={styles.index}>{index + 1}</Text>
              <View style={styles.itemInfo}>
                <Text style={styles.title} numberOfLines={1}>
                  {item.title}
                </Text>
                <Text style={styles.sub} numberOfLines={1}>
                  {item.singer?.map(s => s.name).join(' / ')}
                </Text>
              </View>
              <TouchableOpacity
                style={styles.moreBtn}
                onPress={() => setActionSong(item)}
                hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                <Icon name="more" size={16} style={styles.moreIcon} />
              </TouchableOpacity>
            </TouchableOpacity>
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
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    backText: {fontSize: 30, color: t.text, lineHeight: 32, paddingHorizontal: 4},
    pageTitle: {fontSize: 18, fontWeight: '700', color: t.text},
    row: {flexDirection: 'row', gap: 8, paddingHorizontal: 12},
    input: {
      flex: 1,
      backgroundColor: t.card,
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
    playAll: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    playAllIcon: {color: t.primary, fontSize: 14},
    playAllText: {fontSize: 14, fontWeight: '700', color: t.text},
    loading: {marginTop: 40},
    item: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      paddingLeft: 16,
      paddingRight: 4,
    },
    index: {width: 30, fontSize: 14, color: t.sub},
    itemInfo: {flex: 1},
    title: {fontSize: 15, fontWeight: '600', color: t.text},
    sub: {fontSize: 12, color: t.sub, marginTop: 3},
    moreBtn: {paddingHorizontal: 12, paddingVertical: 6},
    moreIcon: {tintColor: t.sub},
  });
