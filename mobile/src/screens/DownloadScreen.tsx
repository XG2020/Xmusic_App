import React, {useMemo} from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  SectionList,
  StyleSheet,
  Platform,
} from 'react-native';
import {AppAlert} from '../components/AppDialog';
import {SafeAreaView} from 'react-native-safe-area-context';
import {
  useDownloads,
  clearDownloadHistory,
  removeDownloadRecord,
  DownloadTask,
} from '../services/downloadManager';
import {openLocalFolder} from '../services/local';
import {qualityOption} from '../services/settings';
import {useTheme, Theme} from '../theme';

function fmtTime(ts: number) {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}`;
}

/**
 * 下载管理：进行中任务（实时进度）+ 下载历史
 */
export default function DownloadScreen({navigation}: any) {
  const {t} = useTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const {active, history} = useDownloads();

  const sections = [
    ...(active.length ? [{title: `下载中 (${active.length})`, data: active}] : []),
    ...(history.length ? [{title: '下载历史', data: history}] : []),
  ];

  const onClear = () => {
    if (!history.length) {
      return;
    }
    AppAlert.alert('清空下载历史', '仅清除记录，不会删除已下载的文件', [
      {text: '取消', style: 'cancel'},
      {text: '清空', style: 'destructive', onPress: () => clearDownloadHistory()},
    ]);
  };

  /** 打开文件所在文件夹（调用系统文件管理器，原生多级兜底） */
  const openFolder = async (path: string) => {
    const dir = path.slice(0, path.lastIndexOf('/'));
    if (Platform.OS !== 'android') {
      AppAlert.alert('文件位置', dir);
      return;
    }
    const ok = await openLocalFolder(path);
    if (!ok) {
      AppAlert.alert('无法打开文件管理器', `文件位于：\n${dir}`);
    }
  };

  /** 长按下载记录：打开所在文件夹 / 删除记录（可连文件一起删） */
  const onLongPressItem = (item: DownloadTask) => {
    if (item.status === 'downloading') {
      return;
    }
    const buttons: any[] = [];
    if (item.status === 'done' && item.path) {
      buttons.push({
        text: '打开所在文件夹',
        onPress: () => openFolder(item.path!),
      });
      buttons.push({
        text: '删除记录和文件',
        style: 'destructive',
        onPress: () => {
          AppAlert.alert('删除文件', '将同时删除已下载的音乐文件，确定？', [
            {text: '取消', style: 'cancel'},
            {
              text: '删除',
              style: 'destructive',
              onPress: () => removeDownloadRecord(item, true),
            },
          ]);
        },
      });
    }
    buttons.push({
      text: '删除记录',
      onPress: () => removeDownloadRecord(item, false),
    });
    buttons.push({text: '取消', style: 'cancel'});
    AppAlert.alert(item.title, undefined, buttons);
  };

  const renderItem = ({item}: {item: DownloadTask}) => {
    const pct = Math.round(item.progress * 100);
    return (
      <TouchableOpacity
        style={styles.item}
        activeOpacity={0.7}
        onLongPress={() => onLongPressItem(item)}
        delayLongPress={400}>
        <View style={styles.itemInfo}>
          <Text style={styles.title} numberOfLines={1}>
            {item.title}
          </Text>
          <Text style={styles.sub} numberOfLines={1}>
            {item.artist ? `${item.artist} · ` : ''}
            {qualityOption(item.quality).label} · {fmtTime(item.createdAt)}
          </Text>
          {item.status === 'downloading' && (
            <View style={styles.barWrap}>
              <View style={styles.bar}>
                <View style={[styles.barFill, {width: `${pct}%`}]} />
              </View>
              <Text style={styles.pct}>{pct}%</Text>
            </View>
          )}
          {item.status === 'error' && (
            <Text style={styles.error} numberOfLines={1}>
              失败：{item.error ?? '未知错误'}
            </Text>
          )}
          {item.status === 'done' && !!item.path && (
            <Text style={styles.path} numberOfLines={1}>
              {item.path}
            </Text>
          )}
        </View>
        <Text
          style={[
            styles.status,
            item.status === 'done' && styles.statusDone,
            item.status === 'error' && styles.statusError,
          ]}>
          {item.status === 'downloading'
            ? '⬇'
            : item.status === 'done'
            ? '✓'
            : '✕'}
        </Text>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.pageTitle}>下载管理</Text>
        <TouchableOpacity onPress={onClear}>
          <Text style={styles.clearText}>清空历史</Text>
        </TouchableOpacity>
      </View>

      <SectionList
        sections={sections}
        keyExtractor={(item, i) => `${item.id}-${item.createdAt}-${i}`}
        renderItem={renderItem}
        renderSectionHeader={({section}) => (
          <Text style={styles.sectionTitle}>{section.title}</Text>
        )}
        ListEmptyComponent={
          <Text style={styles.empty}>
            暂无下载记录{'\n'}长按歌曲选择「下载」，或在播放页点击 ⬇
          </Text>
        }
        stickySectionHeadersEnabled={false}
      />
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
    backText: {
      fontSize: 30,
      color: t.text,
      lineHeight: 32,
      paddingHorizontal: 4,
    },
    pageTitle: {flex: 1, fontSize: 18, fontWeight: '700', color: t.text},
    clearText: {color: t.sub, fontSize: 13, padding: 6},
    sectionTitle: {
      fontSize: 13,
      fontWeight: '700',
      color: t.sub,
      paddingHorizontal: 16,
      paddingTop: 14,
      paddingBottom: 6,
    },
    empty: {
      textAlign: 'center',
      color: t.sub,
      marginTop: 60,
      fontSize: 13,
      lineHeight: 22,
    },
    item: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      paddingHorizontal: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
    },
    itemInfo: {flex: 1},
    title: {fontSize: 15, fontWeight: '600', color: t.text},
    sub: {fontSize: 11, color: t.sub, marginTop: 3},
    barWrap: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginTop: 8,
    },
    bar: {
      flex: 1,
      height: 3,
      borderRadius: 2,
      backgroundColor: t.cardLight,
      overflow: 'hidden',
    },
    barFill: {height: 3, backgroundColor: t.primary, borderRadius: 2},
    pct: {fontSize: 11, color: t.primary, width: 36, textAlign: 'right'},
    error: {fontSize: 11, color: '#E5484D', marginTop: 4},
    path: {fontSize: 10, color: t.sub, marginTop: 4, opacity: 0.7},
    status: {fontSize: 16, color: t.primary, paddingLeft: 12},
    statusDone: {color: t.primary},
    statusError: {color: '#E5484D'},
  });
