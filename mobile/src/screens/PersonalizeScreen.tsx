import React, {useMemo, useState} from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  FlatList,
  Modal,
  Image,
  Platform,
  ActivityIndicator,
  ToastAndroid,
} from 'react-native';
import RNFS from 'react-native-fs';
import {SafeAreaView} from 'react-native-safe-area-context';
import {check, request, PERMISSIONS, RESULTS} from 'react-native-permissions';
import {AppAlert} from '../components/AppDialog';
import {STORAGE_ROOT} from '../services/local';
import {
  SkinSlot,
  useSkin,
  setSkinFromLocal,
  setSkinFromUrl,
  clearSkin,
} from '../services/skin';
import {useTheme, Theme} from '../theme';

/** 皮肤槽位分组（与设置页分组行式布局一致） */
const SLOT_GROUPS: {
  title: string;
  items: {slot: SkinSlot; label: string}[];
}[] = [
  {
    title: '全局',
    items: [
      {slot: 'splash', label: '启动图'},
      {slot: 'bg', label: '应用背景图'},
      {slot: 'playerBg', label: '播放页背景图'},
    ],
  },
  {
    title: '底栏按钮图标',
    items: [
      {slot: 'tabHome', label: '首页'},
      {slot: 'tabRank', label: '排行'},
      {slot: 'tabMine', label: '我的'},
    ],
  },
  {
    title: '「我的」页面板块图标',
    items: [
      {slot: 'mineLocal', label: '本地音乐'},
      {slot: 'mineDownload', label: '下载管理'},
      {slot: 'mineNowPlaying', label: '正在播放'},
    ],
  },
];

const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|bmp)$/i;

type BrowseEntry = {name: string; path: string; isDir: boolean};

/** 读取图片需要媒体图片权限（Android 13+ 为 READ_MEDIA_IMAGES） */
async function ensureImagePermission() {
  const perm =
    Number(Platform.Version) >= 33
      ? PERMISSIONS.ANDROID.READ_MEDIA_IMAGES
      : PERMISSIONS.ANDROID.READ_EXTERNAL_STORAGE;
  const status = await check(perm);
  if (status !== RESULTS.GRANTED) {
    const requested = await request(perm);
    if (requested !== RESULTS.GRANTED) {
      throw new Error('读取本地图片权限被拒绝');
    }
  }
}

/** 列出目录下的子文件夹与图片文件（文件夹在前） */
async function listDirImages(dir: string): Promise<BrowseEntry[]> {
  try {
    const items = await RNFS.readDir(dir);
    const dirs = items
      .filter(i => i.isDirectory() && !i.name.startsWith('.'))
      .map(i => ({name: i.name, path: i.path, isDir: true}));
    const images = items
      .filter(i => i.isFile() && IMAGE_EXT_RE.test(i.name))
      .map(i => ({name: i.name, path: i.path, isDir: false}));
    const byName = (a: BrowseEntry, b: BrowseEntry) =>
      a.name.localeCompare(b.name, 'zh-Hans-CN');
    return [...dirs.sort(byName), ...images.sort(byName)];
  } catch (e) {
    return [];
  }
}

/** 本地图片缩略图 URI（路径含中文/空格需编码） */
function fileUri(path: string) {
  return `file://${encodeURI(path).replace(/#/g, '%23')}`;
}

/**
 * 个性化装扮（设置-二级页）：
 * 自定义应用背景图、底栏按钮图标、「我的」页三个板块图标，
 * 每项支持本地图片或在线图片 URL，显示时自动缩放到目标尺寸。
 */
export default function PersonalizeScreen({navigation}: any) {
  const {t} = useTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const skin = useSkin();
  // 当前操作的槽位（选择方式弹层）
  const [actionSlot, setActionSlot] = useState<SkinSlot | null>(null);
  const actionLabel = useMemo(() => {
    for (const g of SLOT_GROUPS) {
      const hit = g.items.find(i => i.slot === actionSlot);
      if (hit) {
        return hit.label;
      }
    }
    return '';
  }, [actionSlot]);
  // 本地图片浏览器
  const [pickerSlot, setPickerSlot] = useState<SkinSlot | null>(null);
  const [browsePath, setBrowsePath] = useState(STORAGE_ROOT);
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [browsing, setBrowsing] = useState(false);
  // 在线图片地址输入
  const [urlSlot, setUrlSlot] = useState<SkinSlot | null>(null);
  const [urlText, setUrlText] = useState('');
  const [urlLoading, setUrlLoading] = useState(false);

  const toast = (msg: string) => {
    if (Platform.OS === 'android') {
      ToastAndroid.show(msg, ToastAndroid.SHORT);
    }
  };

  // ===== 本地图片浏览 =====

  const openBrowser = async (slot: SkinSlot) => {
    setActionSlot(null);
    try {
      await ensureImagePermission();
    } catch (e) {
      AppAlert.alert('无法读取本地图片', '请授予图片读取权限后重试');
      return;
    }
    setPickerSlot(slot);
    await browseTo(STORAGE_ROOT);
  };

  const browseTo = async (path: string) => {
    setBrowsing(true);
    setBrowsePath(path);
    setEntries(await listDirImages(path));
    setBrowsing(false);
  };

  const browseUp = () => {
    if (browsePath === STORAGE_ROOT) {
      return;
    }
    const parent = browsePath.slice(0, browsePath.lastIndexOf('/'));
    browseTo(parent.length < STORAGE_ROOT.length ? STORAGE_ROOT : parent);
  };

  const onPickLocal = async (entry: BrowseEntry) => {
    if (entry.isDir) {
      browseTo(entry.path);
      return;
    }
    const slot = pickerSlot;
    setPickerSlot(null);
    if (!slot) {
      return;
    }
    try {
      await setSkinFromLocal(slot, entry.path);
      toast('已应用自定义图片');
    } catch (e: any) {
      AppAlert.alert('设置失败', e?.message ?? '无法读取所选图片，请换一张试试');
    }
  };

  // ===== 在线图片 =====

  const openUrlInput = (slot: SkinSlot) => {
    setActionSlot(null);
    setUrlText('');
    setUrlSlot(slot);
  };

  const onSubmitUrl = async () => {
    const slot = urlSlot;
    const url = urlText.trim();
    if (!slot || !url || urlLoading) {
      return;
    }
    setUrlLoading(true);
    try {
      await setSkinFromUrl(slot, url);
      setUrlSlot(null);
      toast('已应用在线图片');
    } catch (e: any) {
      AppAlert.alert('设置失败', e?.message ?? '图片下载失败，请检查地址');
    } finally {
      setUrlLoading(false);
    }
  };

  // ===== 恢复默认 =====

  const onReset = async (slot: SkinSlot) => {
    setActionSlot(null);
    await clearSkin(slot);
    toast('已恢复默认');
  };

  /** 设置行：左标签 + 当前图片缩略预览 + › */
  const renderRow = (slot: SkinSlot, label: string) => {
    const uri = skin[slot];
    return (
      <TouchableOpacity
        key={slot}
        style={styles.row}
        activeOpacity={0.6}
        onPress={() => setActionSlot(slot)}>
        <Text style={styles.rowLabel}>{label}</Text>
        {uri ? (
          <Image
            source={{uri}}
            style={styles.rowThumb}
            resizeMode="cover"
            resizeMethod="resize"
          />
        ) : (
          <Text style={styles.rowValue}>默认</Text>
        )}
        <Text style={styles.rowArrow}>›</Text>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.pageTitle}>个性化装扮</Text>
        <View style={styles.backSpace} />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.body}>
        {SLOT_GROUPS.map(group => (
          <View key={group.title}>
            <Text style={styles.groupTitle}>{group.title}</Text>
            <View style={styles.group}>
              {group.items.map(item => renderRow(item.slot, item.label))}
            </View>
          </View>
        ))}
        <Text style={styles.hint}>
          图片需小于 5MB，会自动缩放到合适大小：启动图/背景建议使用竖版图片，图标建议使用正方形图片；
          启动图未自定义时跟随深色模式使用内置明暗两套
        </Text>
      </ScrollView>

      {/* 选择方式弹层：本地图片 / 在线地址 / 恢复默认 */}
      <Modal
        visible={actionSlot !== null}
        transparent
        statusBarTranslucent
        animationType="slide"
        onRequestClose={() => setActionSlot(null)}>
        <TouchableOpacity
          style={styles.sheetMask}
          activeOpacity={1}
          onPress={() => setActionSlot(null)}>
          <View style={styles.sheet} onStartShouldSetResponder={() => true}>
            <Text style={styles.sheetTitle}>自定义「{actionLabel}」</Text>
            <TouchableOpacity
              style={styles.sheetItem}
              onPress={() => actionSlot && openBrowser(actionSlot)}>
              <Text style={styles.sheetItemLabel}>从本地图片选择</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.sheetItem}
              onPress={() => actionSlot && openUrlInput(actionSlot)}>
              <Text style={styles.sheetItemLabel}>使用在线图片地址</Text>
            </TouchableOpacity>
            {!!(actionSlot && skin[actionSlot]) && (
              <TouchableOpacity
                style={styles.sheetItem}
                onPress={() => actionSlot && onReset(actionSlot)}>
                <Text style={[styles.sheetItemLabel, styles.destructive]}>
                  恢复默认
                </Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={styles.sheetCancel}
              onPress={() => setActionSlot(null)}>
              <Text style={styles.sheetCancelText}>取消</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* 本地图片浏览器 */}
      <Modal
        visible={pickerSlot !== null}
        transparent
        statusBarTranslucent
        animationType="slide"
        onRequestClose={() => setPickerSlot(null)}>
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
                showsVerticalScrollIndicator={false}
                data={entries}
                keyExtractor={e => e.path}
                style={styles.sheetList}
                ListEmptyComponent={
                  <Text style={styles.sheetEmpty}>该文件夹内没有图片</Text>
                }
                renderItem={({item}) => (
                  <TouchableOpacity
                    style={styles.dirItem}
                    onPress={() => onPickLocal(item)}>
                    {item.isDir ? (
                      <Text style={styles.dirIcon}>📁</Text>
                    ) : (
                      <Image
                        source={{uri: fileUri(item.path)}}
                        style={styles.imgThumb}
                        resizeMode="cover"
                        // 按缩略图尺寸降采样解码，浏览相册大图目录不卡不爆内存
                        resizeMethod="resize"
                      />
                    )}
                    <Text style={styles.dirName} numberOfLines={1}>
                      {item.name}
                    </Text>
                    <Text style={styles.dirArrow}>
                      {item.isDir ? '›' : ''}
                    </Text>
                  </TouchableOpacity>
                )}
              />
            )}
            <TouchableOpacity
              style={styles.sheetCancel}
              onPress={() => setPickerSlot(null)}>
              <Text style={styles.sheetCancelText}>取消</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* 在线图片地址输入 */}
      <Modal
        visible={urlSlot !== null}
        transparent
        statusBarTranslucent
        animationType="slide"
        onRequestClose={() => setUrlSlot(null)}>
        <TouchableOpacity
          style={styles.sheetMask}
          activeOpacity={1}
          onPress={() => !urlLoading && setUrlSlot(null)}>
          <View style={styles.sheet} onStartShouldSetResponder={() => true}>
            <Text style={styles.sheetTitle}>在线图片地址</Text>
            <TextInput
              style={styles.urlInput}
              placeholder="https://example.com/image.jpg"
              placeholderTextColor={t.sub}
              value={urlText}
              onChangeText={setUrlText}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              onSubmitEditing={onSubmitUrl}
            />
            <TouchableOpacity
              style={[styles.sheetPrimaryBtn, urlLoading && styles.btnDisabled]}
              onPress={onSubmitUrl}>
              {urlLoading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.sheetPrimaryText}>下载并应用</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.sheetCancel}
              onPress={() => !urlLoading && setUrlSlot(null)}>
              <Text style={styles.sheetCancelText}>取消</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
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
      paddingVertical: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
    },
    rowLabel: {flex: 1, fontSize: 15, color: t.text},
    rowValue: {color: t.sub, fontSize: 13, marginRight: 4},
    rowThumb: {
      width: 36,
      height: 36,
      borderRadius: 8,
      marginRight: 4,
      backgroundColor: t.cardLight,
    },
    rowArrow: {color: t.sub, fontSize: 18, lineHeight: 20},
    hint: {
      color: t.sub,
      fontSize: 12,
      marginTop: 16,
      paddingHorizontal: 20,
      lineHeight: 18,
    },
    // 弹层（与设置页样式一致）
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
      paddingVertical: 13,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
    },
    sheetItemLabel: {flex: 1, color: t.text, fontSize: 15},
    destructive: {color: '#E5484D'},
    sheetCancel: {
      marginTop: 12,
      backgroundColor: t.sheetBtn,
      borderRadius: 22,
      paddingVertical: 11,
      alignItems: 'center',
    },
    sheetCancelText: {color: t.text, fontSize: 15},
    // 图片浏览器
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
      paddingVertical: 9,
      gap: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
    },
    dirIcon: {fontSize: 16, width: 34, textAlign: 'center'},
    imgThumb: {
      width: 34,
      height: 34,
      borderRadius: 6,
      backgroundColor: t.cardLight,
    },
    dirName: {flex: 1, color: t.text, fontSize: 14},
    dirArrow: {color: t.sub, fontSize: 18, width: 12},
    urlInput: {
      backgroundColor: t.cardLight,
      borderRadius: 12,
      paddingHorizontal: 14,
      height: 44,
      fontSize: 14,
      color: t.text,
      marginTop: 6,
    },
    sheetPrimaryBtn: {
      backgroundColor: t.primary,
      borderRadius: 22,
      paddingVertical: 11,
      alignItems: 'center',
      marginTop: 14,
    },
    btnDisabled: {opacity: 0.6},
    sheetPrimaryText: {color: '#fff', fontSize: 15, fontWeight: '700'},
  });
