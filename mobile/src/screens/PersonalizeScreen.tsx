import React, {useEffect, useMemo, useState} from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Modal,
  Image,
  Platform,
  ActivityIndicator,
  ToastAndroid,
  Switch,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {AppAlert} from '../components/AppDialog';
import {pickImage} from '../services/local';
import {
  SkinSlot,
  useSkin,
  setSkinFromLocal,
  setSkinFromUrl,
  clearSkin,
} from '../services/skin';
import {useTheme, Theme, PRESET_THEME_COLORS} from '../theme';
import {
  getThemeColor,
  setThemeColor,
  subscribeThemeColor,
  isValidThemeColor,
  panelEnabled,
  panelColor,
  panelAlpha,
  subscribePanel,
  setPanelEnabled,
  setPanelColor,
  setPanelAlpha,
} from '../services/settings';

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

/**
 * 个性化装扮（设置-二级页）：
 * 自定义应用背景图、底栏按钮图标、「我的」页三个板块图标，
 * 每项支持本地图片或在线图片 URL，显示时自动缩放到目标尺寸。
 */
export default function PersonalizeScreen({navigation}: any) {
  const {t} = useTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const skin = useSkin();
  // 自定义主题色（null = 默认色，实时订阅）
  const [customColor, setCustomColor] = useState<string | null>(getThemeColor());
  useEffect(() => subscribeThemeColor(setCustomColor), []);
  // 自定义主题色输入弹层
  const [colorModal, setColorModal] = useState(false);
  const [colorText, setColorText] = useState('');
  // 板块背景：开关 + 自定义颜色 + 透明度（实时订阅，变化时主题重建并立即生效）
  const [panelOn, setPanelOn] = useState(panelEnabled());
  const [panelColorV, setPanelColorV] = useState<string | null>(panelColor());
  const [panelAlphaV, setPanelAlphaV] = useState(panelAlpha());
  useEffect(
    () =>
      subscribePanel(() => {
        setPanelOn(panelEnabled());
        setPanelColorV(panelColor());
        setPanelAlphaV(panelAlpha());
      }),
    [],
  );
  // 自定义板块颜色输入弹层
  const [panelColorModal, setPanelColorModal] = useState(false);
  const [panelColorText, setPanelColorText] = useState('');
  // 背景浓度输入弹层（点击确认后才应用）
  const [alphaModal, setAlphaModal] = useState(false);
  const [alphaText, setAlphaText] = useState('');
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
  // 在线图片地址输入
  const [urlSlot, setUrlSlot] = useState<SkinSlot | null>(null);
  const [urlText, setUrlText] = useState('');
  const [urlLoading, setUrlLoading] = useState(false);

  const toast = (msg: string) => {
    if (Platform.OS === 'android') {
      ToastAndroid.show(msg, ToastAndroid.SHORT);
    }
  };

  // ===== 本地图片选择（SAF 系统选择器，无需存储权限） =====

  const onPickLocal = async (slot: SkinSlot) => {
    setActionSlot(null);
    const picked = await pickImage();
    if (!picked) {
      // 用户取消不打扰；非 Android 平台无 SAF，提示改用在线地址
      if (Platform.OS !== 'android') {
        AppAlert.alert('暂不支持', '当前平台请使用在线图片地址。');
      }
      return;
    }
    try {
      await setSkinFromLocal(slot, picked.uri);
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

  // ===== 自定义主题色 =====

  // 当前生效主题色（null = 默认色板首项）
  const currentColor = customColor ?? PRESET_THEME_COLORS[0];
  const isPresetSelected = (c: string) => currentColor === c;
  // 已设置且不在预置色板内 = 自定义色生效
  const isCustomActive =
    !!customColor && !PRESET_THEME_COLORS.includes(customColor);

  const openColorModal = () => {
    setColorText(customColor ?? '');
    setColorModal(true);
  };
  // 输入规范化：容忍无 # 前缀/小写，#RRGGBB
  const parsedColor = (() => {
    const raw = colorText.trim().replace(/^#/, '');
    return raw ? `#${raw.toUpperCase()}` : '';
  })();
  const colorValid = isValidThemeColor(parsedColor);
  const applyCustomColor = () => {
    if (!colorValid) {
      return;
    }
    setColorModal(false);
    setThemeColor(parsedColor).catch(() => {});
  };
  const resetThemeColor = () => {
    setColorModal(false);
    setThemeColor(null).catch(() => {});
  };

  // ===== 自定义板块颜色（独立于主题色） =====

  // 当前板块色（null = 跟随深浅模式默认色）
  const isPanelPresetSelected = (c: string) => panelColorV === c;
  // 已设置且不在预置色板内 = 自定义板块色生效
  const isPanelCustomActive =
    !!panelColorV && !PRESET_THEME_COLORS.includes(panelColorV);

  const openPanelColorModal = () => {
    setPanelColorText(panelColorV ?? '');
    setPanelColorModal(true);
  };
  // 输入规范化：容忍无 # 前缀/小写，#RRGGBB
  const parsedPanelColor = (() => {
    const raw = panelColorText.trim().replace(/^#/, '');
    return raw ? `#${raw.toUpperCase()}` : '';
  })();
  const panelColorValid = isValidThemeColor(parsedPanelColor);
  const applyPanelColor = () => {
    if (!panelColorValid) {
      return;
    }
    setPanelColorModal(false);
    setPanelColor(parsedPanelColor).catch(() => {});
  };
  const resetPanelColor = () => {
    setPanelColorModal(false);
    setPanelColor(null).catch(() => {});
  };

  const openAlphaModal = () => {
    setAlphaText(String(Math.round(panelAlphaV * 100)));
    setAlphaModal(true);
  };
  const applyAlpha = () => {
    const v = Math.floor(Number(alphaText));
    if (isNaN(v) || v < 0 || v > 100) {
      AppAlert.alert('请输入 0-100 的整数');
      return;
    }
    setPanelAlphaV(v / 100);
    setPanelAlpha(v / 100).catch(() => {});
    setAlphaModal(false);
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
        <View>
          <Text style={styles.groupTitle}>主题色</Text>
          <View style={styles.group}>
            <View style={styles.paletteRow}>
              <Text style={styles.rowLabel}>选择主题色</Text>
              <Text style={styles.rowValue}>
                {customColor ? customColor : '默认'}
              </Text>
            </View>
            <View style={styles.palette}>
              {PRESET_THEME_COLORS.map((c, i) => (
                <TouchableOpacity
                  key={c}
                  style={[
                    styles.swatch,
                    {backgroundColor: c},
                    isPresetSelected(c) && styles.swatchOn,
                  ]}
                  activeOpacity={0.7}
                  onPress={() =>
                    // 首项为默认色：点选即恢复默认（保持默认色原样，不做明暗收敛）
                    i === 0
                      ? setThemeColor(null).catch(() => {})
                      : setThemeColor(c).catch(() => {})
                  }>
                  {isPresetSelected(c) && (
                    <Text style={styles.swatchCheck}>✓</Text>
                  )}
                </TouchableOpacity>
              ))}
              {/* 自定义色块：未设置时显示 +，已设置时显示当前自定义色 */}
              <TouchableOpacity
                style={[
                  styles.swatch,
                  styles.swatchCustom,
                  isCustomActive && styles.swatchOn,
                ]}
                activeOpacity={0.7}
                onPress={openColorModal}>
                {isCustomActive ? (
                  <View
                    style={[styles.customDot, {backgroundColor: customColor!}]}
                  />
                ) : (
                  <Text style={styles.swatchCustomText}>+</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>

        {/* 板块背景：搜索栏/底栏/迷你条/歌单分类栏支持独立自定义颜色，浓度可调 */}
        <View>
          <Text style={styles.groupTitle}>板块背景</Text>
          <View style={styles.group}>
            <View style={styles.paletteRow}>
              <View style={styles.rowTextWrap}>
                <Text style={styles.rowLabel}>板块使用自定义颜色</Text>
                <Text style={styles.rowSub}>
                  应用于搜索栏、底栏、迷你播放器（含播放按钮内圆）及胶囊/卡片底色
                </Text>
              </View>
              <Switch
                value={panelOn}
                onValueChange={on => setPanelEnabled(on).catch(() => {})}
                trackColor={{false: t.cardLight, true: t.primary}}
                thumbColor="#fff"
              />
            </View>
            {panelOn && (
              <>
                <View style={styles.paletteRow}>
                  <Text style={styles.rowLabel}>板块颜色</Text>
                  <Text style={styles.rowValue}>
                    {panelColorV ? panelColorV : '深浅模式默认'}
                  </Text>
                </View>
                <View style={styles.palette}>
                  {/* 首项：深浅模式默认（未自定义时） */}
                  <TouchableOpacity
                    style={[
                      styles.swatch,
                      styles.swatchCustom,
                      !panelColorV && styles.swatchOn,
                    ]}
                    activeOpacity={0.7}
                    onPress={() => setPanelColor(null).catch(() => {})}>
                    <Text style={styles.panelFollowText}>默认</Text>
                  </TouchableOpacity>
                  {PRESET_THEME_COLORS.map(c => (
                    <TouchableOpacity
                      key={c}
                      style={[
                        styles.swatch,
                        {backgroundColor: c},
                        isPanelPresetSelected(c) && styles.swatchOn,
                      ]}
                      activeOpacity={0.7}
                      onPress={() => setPanelColor(c).catch(() => {})}>
                      {isPanelPresetSelected(c) && (
                        <Text style={styles.swatchCheck}>✓</Text>
                      )}
                    </TouchableOpacity>
                  ))}
                  {/* 自定义色块：未设置时显示 +，已设置时显示当前自定义色 */}
                  <TouchableOpacity
                    style={[
                      styles.swatch,
                      styles.swatchCustom,
                      isPanelCustomActive && styles.swatchOn,
                    ]}
                    activeOpacity={0.7}
                    onPress={openPanelColorModal}>
                    {isPanelCustomActive ? (
                      <View
                        style={[
                          styles.customDot,
                          {backgroundColor: panelColorV!},
                        ]}
                      />
                    ) : (
                      <Text style={styles.swatchCustomText}>+</Text>
                    )}
                  </TouchableOpacity>
                </View>
                <View style={styles.alphaRow}>
                  <Text style={styles.rowLabel}>背景浓度</Text>
                  <TouchableOpacity
                    style={styles.alphaValueBtn}
                    activeOpacity={0.7}
                    onPress={openAlphaModal}>
                    <Text style={styles.alphaValueText}>
                      {Math.round(panelAlphaV * 100)}%
                    </Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        </View>
        <Text style={styles.hint}>
          图片需小于 5MB，会自动缩放到合适大小：启动图/背景建议使用竖版图片，图标建议使用正方形图片；
          启动图未自定义时跟随深色模式使用内置明暗两套；
          主题色可点选色板快速切换，或点「+」输入任意 #RRGGBB 颜色，明暗模式下会自动调节对比度保证可读；
          板块背景开启后可选独立颜色（默认跟随深浅模式）并调节浓度（0% 完全透明），搜索栏/底栏/迷你播放器（含播放按钮内圆）及榜单/歌单等卡片、分类胶囊会应用该颜色
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
              onPress={() => actionSlot && onPickLocal(actionSlot)}>
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

      {/* 自定义主题色输入 */}
      <Modal
        visible={colorModal}
        transparent
        statusBarTranslucent
        animationType="slide"
        onRequestClose={() => setColorModal(false)}>
        <TouchableOpacity
          style={styles.sheetMask}
          activeOpacity={1}
          onPress={() => setColorModal(false)}>
          <View style={styles.sheet} onStartShouldSetResponder={() => true}>
            <Text style={styles.sheetTitle}>自定义主题色</Text>
            <TextInput
              style={styles.urlInput}
              placeholder="#31C27C"
              placeholderTextColor={t.sub}
              value={colorText}
              onChangeText={setColorText}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={7}
              onSubmitEditing={applyCustomColor}
            />
            <View style={styles.colorPreviewRow}>
              <Text style={styles.colorPreviewLabel}>预览</Text>
              <View
                style={[
                  styles.colorPreview,
                  {backgroundColor: colorValid ? parsedColor : t.border},
                ]}
              />
              <Text style={styles.colorPreviewHex}>
                {colorValid ? parsedColor : '输入 #RRGGBB'}
              </Text>
            </View>
            <TouchableOpacity
              style={[styles.sheetPrimaryBtn, !colorValid && styles.btnDisabled]}
              onPress={applyCustomColor}>
              <Text style={styles.sheetPrimaryText}>应用</Text>
            </TouchableOpacity>
            {customColor != null && (
              <TouchableOpacity
                style={styles.sheetItem}
                onPress={resetThemeColor}>
                <Text style={[styles.sheetItemLabel, styles.destructive]}>
                  恢复默认主题色
                </Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={styles.sheetCancel}
              onPress={() => setColorModal(false)}>
              <Text style={styles.sheetCancelText}>取消</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* 自定义板块颜色输入（独立于主题色） */}
      <Modal
        visible={panelColorModal}
        transparent
        statusBarTranslucent
        animationType="slide"
        onRequestClose={() => setPanelColorModal(false)}>
        <TouchableOpacity
          style={styles.sheetMask}
          activeOpacity={1}
          onPress={() => setPanelColorModal(false)}>
          <View style={styles.sheet} onStartShouldSetResponder={() => true}>
            <Text style={styles.sheetTitle}>自定义板块颜色</Text>
            <TextInput
              style={styles.urlInput}
              placeholder="#31C27C"
              placeholderTextColor={t.sub}
              value={panelColorText}
              onChangeText={setPanelColorText}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={7}
              onSubmitEditing={applyPanelColor}
            />
            <View style={styles.colorPreviewRow}>
              <Text style={styles.colorPreviewLabel}>预览</Text>
              <View
                style={[
                  styles.colorPreview,
                  {backgroundColor: panelColorValid ? parsedPanelColor : t.border},
                ]}
              />
              <Text style={styles.colorPreviewHex}>
                {panelColorValid ? parsedPanelColor : '输入 #RRGGBB'}
              </Text>
            </View>
            <TouchableOpacity
              style={[
                styles.sheetPrimaryBtn,
                !panelColorValid && styles.btnDisabled,
              ]}
              onPress={applyPanelColor}>
              <Text style={styles.sheetPrimaryText}>应用</Text>
            </TouchableOpacity>
            {panelColorV != null && (
              <TouchableOpacity
                style={styles.sheetItem}
                onPress={resetPanelColor}>
                <Text style={[styles.sheetItemLabel, styles.destructive]}>
                  恢复深浅模式默认
                </Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={styles.sheetCancel}
              onPress={() => setPanelColorModal(false)}>
              <Text style={styles.sheetCancelText}>取消</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* 背景浓度输入（弹窗内确认后才应用，避免输入过程实时落盘导致回跳） */}
      <Modal
        visible={alphaModal}
        transparent
        statusBarTranslucent
        animationType="slide"
        onRequestClose={() => setAlphaModal(false)}>
        <TouchableOpacity
          style={styles.sheetMask}
          activeOpacity={1}
          onPress={() => setAlphaModal(false)}>
          <View style={styles.sheet} onStartShouldSetResponder={() => true}>
            <Text style={styles.sheetTitle}>背景浓度</Text>
            <TextInput
              style={styles.urlInput}
              placeholder="0-100（0 完全透明，100 纯色）"
              placeholderTextColor={t.sub}
              keyboardType="number-pad"
              maxLength={3}
              value={alphaText}
              onChangeText={setAlphaText}
              autoFocus
              onSubmitEditing={applyAlpha}
            />
            <TouchableOpacity style={styles.sheetPrimaryBtn} onPress={applyAlpha}>
              <Text style={styles.sheetPrimaryText}>应用</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.sheetCancel}
              onPress={() => setAlphaModal(false)}>
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
    // 背景浓度值按钮（点击弹出输入弹窗）
    alphaValueBtn: {
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 6,
      paddingHorizontal: 10,
      paddingVertical: 4,
      marginLeft: 8,
    },
    alphaValueText: {
      fontSize: 13,
      color: t.primary,
      fontWeight: '600',
    },
    rowThumb: {
      width: 36,
      height: 36,
      borderRadius: 8,
      marginRight: 4,
      backgroundColor: t.cardLight,
    },
    rowArrow: {color: t.sub, fontSize: 18, lineHeight: 20},
    // 主题色色板
    paletteRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
    },
    // 板块背景开关行
    rowTextWrap: {flex: 1, paddingRight: 12},
    rowSub: {color: t.sub, fontSize: 12, marginTop: 3, lineHeight: 16},
    alphaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingTop: 2,
      paddingBottom: 2,
    },
    palette: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 12,
      paddingVertical: 4,
      paddingBottom: 18,
    },
    swatch: {
      width: 36,
      height: 36,
      borderRadius: 18,
      borderWidth: 2,
      borderColor: 'transparent',
      alignItems: 'center',
      justifyContent: 'center',
    },
    swatchOn: {borderColor: t.primary},
    swatchCheck: {color: '#fff', fontSize: 15, fontWeight: '800'},
    swatchCustom: {backgroundColor: t.cardLight},
    swatchCustomText: {color: t.sub, fontSize: 20, lineHeight: 22},
    // 板块色板首项「默认（深浅模式）」文字标记
    panelFollowText: {color: t.sub, fontSize: 11, fontWeight: '600'},
    customDot: {width: 20, height: 20, borderRadius: 10},
    // 自定义色输入预览
    colorPreviewRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      marginTop: 12,
      paddingHorizontal: 4,
    },
    colorPreviewLabel: {color: t.sub, fontSize: 13},
    colorPreview: {width: 30, height: 30, borderRadius: 15},
    colorPreviewHex: {color: t.text, fontSize: 13},
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
