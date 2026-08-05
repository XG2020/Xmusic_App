import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  FlatList,
} from 'react-native';
import {AppAlert} from '../components/AppDialog';
import {SafeAreaView} from 'react-native-safe-area-context';
import TrackPlayer, {Track, useActiveTrack} from 'react-native-track-player';
import {cancelProgressiveEnqueue, saveQueueSnapshot} from '../services/player';
import Icon from '../components/Icon';
import {useTheme, Theme} from '../theme';
import {useSkin} from '../services/skin';

/**
 * 全屏「正在播放」队列页：展示当前播放队列，
 * 点击切歌、右侧 ✕ 移出队列，当前曲目高亮
 */
export default function NowPlayingScreen({navigation}: any) {
  const {t} = useTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const skin = useSkin();
  const pageBackground = skin.bg;
  const track = useActiveTrack();
  const [queue, setQueue] = useState<Track[]>([]);
  const [activeIdx, setActiveIdx] = useState(-1);

  const refresh = useCallback(async () => {
    try {
      setQueue(await TrackPlayer.getQueue());
      setActiveIdx((await TrackPlayer.getActiveTrackIndex()) ?? -1);
    } catch (e) {
      setQueue([]);
    }
  }, []);

  // 切歌时同步高亮
  useEffect(() => {
    refresh();
  }, [refresh, track]);

  const playAt = async (index: number) => {
    try {
      await TrackPlayer.skip(index);
      await TrackPlayer.play();
      setActiveIdx(index);
    } catch (e) {
      // 队列越界忽略
    }
  };

  const removeAt = async (index: number) => {
    try {
      await TrackPlayer.remove(index);
      await saveQueueSnapshot();
      await refresh();
    } catch (e) {
      // 移除失败忽略
    }
  };

  const clearAll = () => {
    if (!queue.length) {
      return;
    }
    AppAlert.alert('清空播放列表', '确定清空当前播放队列吗？', [
      {text: '取消', style: 'cancel'},
      {
        text: '清空',
        style: 'destructive',
        onPress: async () => {
          try {
            // 停止渐进式后台追加，避免清空后又被补回
            cancelProgressiveEnqueue();
            await TrackPlayer.reset();
            await saveQueueSnapshot();
            await refresh();
          } catch (e) {}
        },
      },
    ]);
  };

  return (
    <View style={styles.root}>
      {!!pageBackground && (
        <>
          <Image
            source={{uri: pageBackground}}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
            resizeMethod="resize"
          />
          {/* 让进入动画期间始终由当前页自己的背景托底，避免透出下层 Mine 页 */}
          <View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              {backgroundColor: t.bg + 'A6'},
            ]}
          />
        </>
      )}
      <SafeAreaView
        style={[styles.container, !!pageBackground && styles.transparentBg]}
        edges={['top']}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()}>
            <Text style={styles.headerBtn}>←</Text>
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <Text style={styles.title}>当前播放 ({queue.length})</Text>
          </View>
          <TouchableOpacity
            onPress={clearAll}
            hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
            <Icon name="garbage" size={40} color={t.text} />
          </TouchableOpacity>
        </View>

        <FlatList
          showsVerticalScrollIndicator={false}
          data={queue}
          keyExtractor={(item, i) => `${item.id ?? item.title}-${i}`}
          initialScrollIndex={
            activeIdx > 6 && queue.length > 10 ? activeIdx - 3 : 0
          }
          getItemLayout={(_, index) => ({
            length: 60,
            offset: 60 * index,
            index,
          })}
          ListEmptyComponent={
            <Text style={styles.empty}>播放队列为空</Text>
          }
          renderItem={({item, index}) => {
            const active = index === activeIdx;
            return (
              <TouchableOpacity
                style={styles.item}
                activeOpacity={0.7}
                onPress={() => playAt(index)}>
                {item.artwork ? (
                  <Image
                    source={{uri: String(item.artwork)}}
                    style={styles.cover}
                  />
                ) : (
                  <View style={[styles.cover, styles.coverFallback]}>
                    <Text style={styles.coverNote}>♪</Text>
                  </View>
                )}
                <View style={styles.info}>
                  <Text
                    style={[styles.itemTitle, active && styles.active]}
                    numberOfLines={1}>
                    {active ? '♪ ' : ''}
                    {item.title}
                  </Text>
                  {item.artist ? (
                    <Text
                      style={[styles.itemArtist, active && styles.activeSub]}
                      numberOfLines={1}>
                      {item.artist}
                    </Text>
                  ) : null}
                </View>
                <TouchableOpacity
                  style={styles.removeBtn}
                  hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
                  onPress={() => removeAt(index)}>
                  <Text style={styles.removeText}>✕</Text>
                </TouchableOpacity>
              </TouchableOpacity>
            );
          }}
        />
      </SafeAreaView>
    </View>
  );
}

const createStyles = (t: Theme) =>
  StyleSheet.create({
    root: {flex: 1, backgroundColor: t.bg},
    container: {flex: 1, backgroundColor: t.bg},
    transparentBg: {backgroundColor: 'transparent'},
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    headerBtn: {
      color: t.text,
      fontSize: 24,
      width: 36,
      textAlign: 'center',
    },
    headerCenter: {flex: 1, alignItems: 'center'},
    title: {fontSize: 17, fontWeight: '700', color: t.text},
    clearBtn: {fontSize: 18, width: 36, textAlign: 'center', color: t.sub},
    empty: {
      textAlign: 'center',
      color: t.sub,
      fontSize: 13,
      paddingVertical: 60,
    },
    item: {
      flexDirection: 'row',
      alignItems: 'center',
      height: 60,
      paddingHorizontal: 16,
      gap: 12,
    },
    cover: {width: 44, height: 44, borderRadius: 8},
    coverFallback: {
      backgroundColor: t.cardLight,
      alignItems: 'center',
      justifyContent: 'center',
    },
    coverNote: {color: t.sub, fontSize: 16},
    info: {flex: 1},
    itemTitle: {color: t.text, fontSize: 15},
    itemArtist: {color: t.sub, fontSize: 12, marginTop: 3},
    active: {color: t.primary, fontWeight: '700'},
    activeSub: {color: t.primary},
    removeBtn: {
      width: 40,
      height: 40,
      alignItems: 'center',
      justifyContent: 'center',
    },
    removeText: {color: t.sub, fontSize: 22},
  });
