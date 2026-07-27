import React, {useEffect, useMemo, useState} from 'react';
import {View, Text, StyleSheet, Image, ScrollView} from 'react-native';
import {useActiveTrack, useProgress} from 'react-native-track-player';
import {getSongDetail, normalizeSong} from '../services/api';
import {formatDuration} from '../utils/format';
import {useTheme, Theme} from '../theme';
import type {Song} from '../types/music';

/** 歌曲百科扩展信息（语种/流派/发行时间等） */
type WikiInfo = {
  lan?: string;
  genre?: string;
  pub?: string;
  company?: string;
  intro?: string;
};

/**
 * 歌曲详情视图（歌曲百科样式，参考 QQ 音乐）：
 * 作为播放页左右滑动的同级页面嵌入；
 * 封面（右侧露黑胶碟边）+ 歌名歌手横排，下方分组卡片、值右对齐
 */
export default function SongDetailView() {
  const {t} = useTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const track = useActiveTrack();
  const progress = useProgress(1000);
  const [detail, setDetail] = useState<Song | null>(null);
  const [wiki, setWiki] = useState<WikiInfo>({});

  const mid = (track as any)?.mid as string | undefined;

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setWiki({});
    if (!mid) {
      return;
    }
    getSongDetail({mid})
      .then(d => {
        if (cancelled) {
          return;
        }
        const info = d?.track_info ?? d;
        if (info) {
          setDetail(normalizeSong(info));
        }
        // info 区块：lan/genre/pub_time/company/intro，取 content[0].value
        const w = d?.info;
        const pick = (k: string): string | undefined =>
          w?.[k]?.content?.[0]?.value || undefined;
        if (w) {
          setWiki({
            lan: pick('lan'),
            genre: pick('genre'),
            pub: pick('pub_time'),
            company: pick('company'),
            intro: pick('intro'),
          });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [mid]);

  const title = detail?.title ?? (track?.title ? String(track.title) : '—');
  const singer =
    detail?.singer?.map(s => s.name).join(' / ') ??
    (track?.artist ? String(track.artist) : '—');

  const basicRows: {label: string; value: string}[] = [
    {label: '歌曲名', value: title},
    {label: '歌手', value: singer},
    {label: '语种', value: wiki.lan ?? '—'},
    {label: '流派', value: wiki.genre ?? '—'},
    {label: '专辑', value: detail?.album?.name || '—'},
    {label: '专辑发行时间', value: wiki.pub ?? '—'},
  ];

  const moreRows: {label: string; value: string}[] = [
    {label: '时长', value: formatDuration(detail?.interval ?? progress.duration)},
    {label: '唱片公司', value: wiki.company ?? '—'},
    {
      label: '来源',
      value:
        track?.url && !String(track.url).startsWith('http')
          ? '本地文件'
          : '在线播放',
    },
  ];

  const renderCard = (
    cardTitle: string,
    rows: {label: string; value: string}[],
  ) => (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{cardTitle}</Text>
      {rows.map((r, i) => (
        <View
          key={r.label}
          style={[styles.row, i === rows.length - 1 && styles.rowLast]}>
          <Text style={styles.label}>{r.label}</Text>
          <Text style={styles.value} numberOfLines={2}>
            {r.value}
          </Text>
        </View>
      ))}
    </View>
  );

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.body}>
        {/* 封面（右侧露黑胶碟边）+ 歌名歌手横排 */}
        <View style={styles.hero}>
          <View style={styles.coverWrap}>
            {track?.artwork ? (
              <Image
                source={{uri: String(track.artwork)}}
                style={styles.cover}
              />
            ) : (
              <Image
                source={require('../assets/player_cover.png')}
                style={styles.cover}
              />
            )}
            <Image
              source={require('../assets/album_cover_player.png')}
              style={styles.coverDisc}
              resizeMode="stretch"
            />
          </View>
          <View style={styles.heroText}>
            <Text style={styles.heroTitle} numberOfLines={2}>
              {title}
            </Text>
            <Text style={styles.heroSinger} numberOfLines={1}>
              {singer}
            </Text>
          </View>
        </View>

        {renderCard('基础信息', basicRows)}
        {renderCard('更多信息', moreRows)}

        {wiki.intro ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>简介</Text>
            <Text style={styles.introText}>{wiki.intro}</Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const createStyles = (t: Theme) =>
  StyleSheet.create({
    container: {flex: 1},
    body: {padding: 16, paddingBottom: 40},
    hero: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 14,
      paddingHorizontal: 4,
    },
    /* 黑胶碟效果：网页版比例 封面186×180 + 叠层201×180(left:9)，按高100等比换算 */
    coverWrap: {
      width: 117,
      height: 100,
    },
    cover: {width: 103, height: 100, borderRadius: 4},
    coverDisc: {
      position: 'absolute',
      left: 5,
      top: 0,
      width: 112,
      height: 100,
    },
    heroText: {flex: 1, marginLeft: 16},
    heroTitle: {fontSize: 20, fontWeight: '700', color: t.playerText},
    heroSinger: {fontSize: 13, color: t.playerSub, marginTop: 6},
    card: {
      backgroundColor: t.isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
      borderRadius: 14,
      paddingHorizontal: 16,
      paddingBottom: 4,
      marginTop: 16,
    },
    cardTitle: {
      fontSize: 16,
      fontWeight: '700',
      color: t.playerText,
      paddingTop: 16,
      paddingBottom: 4,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 14,
      gap: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.isDark
        ? 'rgba(255,255,255,0.1)'
        : 'rgba(0,0,0,0.08)',
    },
    rowLast: {borderBottomWidth: 0},
    label: {color: t.playerSub, fontSize: 14},
    value: {
      flex: 1,
      color: t.playerText,
      fontSize: 14,
      textAlign: 'right',
    },
    introText: {
      color: t.playerText,
      fontSize: 13,
      lineHeight: 21,
      paddingVertical: 10,
    },
  });
