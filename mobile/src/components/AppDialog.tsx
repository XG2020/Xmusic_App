import React, {useEffect, useMemo, useState} from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Pressable,
  ScrollView,
} from 'react-native';
import {useTheme, Theme} from '../theme';

/**
 * 主题化弹窗：替代系统 Alert.alert，跟随应用深浅主题与绿色主色。
 * AppAlert.alert 签名与 RN Alert.alert 完全兼容，可直接替换调用。
 */

export type DialogButton = {
  text: string;
  style?: 'default' | 'cancel' | 'destructive';
  onPress?: () => void;
};

type DialogRequest = {
  title: string;
  message?: string;
  buttons?: DialogButton[];
  options?: {
    cancelable?: boolean;
    buttonLayout?: 'auto' | 'vertical' | 'horizontal';
  };
};

let pushRequest: ((r: DialogRequest) => void) | null = null;

export const AppAlert = {
  alert(
    title: string,
    message?: string,
    buttons?: DialogButton[],
    options?: {
      cancelable?: boolean;
      buttonLayout?: 'auto' | 'vertical' | 'horizontal';
    },
  ) {
    if (pushRequest) {
      pushRequest({title, message, buttons, options});
    }
  },
};

/** 弹窗宿主：挂载在 App 根部（ThemeProvider 内），全局唯一 */
export function AppDialogHost() {
  const {t} = useTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const [queue, setQueue] = useState<DialogRequest[]>([]);

  useEffect(() => {
    pushRequest = r => setQueue(q => [...q, r]);
    return () => {
      pushRequest = null;
    };
  }, []);

  const current = queue[0];

  const close = (btn?: DialogButton) => {
    setQueue(q => q.slice(1));
    // onPress 延后执行，支持在回调里继续弹下一个弹窗
    if (btn?.onPress) {
      const cb = btn.onPress;
      setTimeout(() => cb(), 0);
    }
  };

  if (!current) {
    return null;
  }

  const buttons: DialogButton[] = current.buttons?.length
    ? current.buttons
    : [{text: '确定'}];
  const vertical =
    current.options?.buttonLayout === 'vertical' ||
    (current.options?.buttonLayout !== 'horizontal' && buttons.length > 2);
  const cancelable = current.options?.cancelable !== false;

  const btnTextStyle = (b: DialogButton) => {
    if (b.style === 'destructive') {
      return styles.btnTextDanger;
    }
    if (b.style === 'cancel') {
      return styles.btnTextCancel;
    }
    return styles.btnTextPrimary;
  };
  const btnBgStyle = (b: DialogButton) =>
    b.style === 'cancel' || b.style === 'destructive'
      ? styles.btnPlain
      : styles.btnPrimary;

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={() => cancelable && close()}>
      <Pressable
        style={styles.mask}
        onPress={() => cancelable && close()}>
        <Pressable style={styles.box} onPress={() => {}}>
          <Text style={styles.title}>{current.title}</Text>
          {!!current.message && (
            <Text style={styles.message}>{current.message}</Text>
          )}
          {vertical ? (
            // 竖排按钮多时（如选择合并歌单）可滚动，避免超出屏幕
            <ScrollView
              showsVerticalScrollIndicator={false}
              style={styles.btnScroll}
              contentContainerStyle={styles.btnCol}>
              {buttons.map((b, i) => (
                <TouchableOpacity
                  key={`${b.text}-${i}`}
                  style={[styles.btn, btnBgStyle(b)]}
                  activeOpacity={0.8}
                  onPress={() => close(b)}>
                  <Text style={btnTextStyle(b)} numberOfLines={1}>
                    {b.text}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          ) : (
            <View style={styles.btnRow}>
              {buttons.map((b, i) => (
                <TouchableOpacity
                  key={`${b.text}-${i}`}
                  style={[styles.btn, btnBgStyle(b), styles.btnFlex]}
                  activeOpacity={0.8}
                  onPress={() => close(b)}>
                  <Text style={btnTextStyle(b)}>{b.text}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const createStyles = (t: Theme) =>
  StyleSheet.create({
    mask: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.45)',
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: 44,
    },
    box: {
      width: '100%',
      maxWidth: 300,
      // 弹窗背景：开启面板色时随板块色，否则保持卡片色
      backgroundColor: t.panel ?? t.card,
      borderRadius: 16,
      paddingHorizontal: 20,
      paddingTop: 22,
      paddingBottom: 16,
    },
    title: {
      fontSize: 16,
      fontWeight: '700',
      color: t.text,
      textAlign: 'center',
    },
    message: {
      fontSize: 13,
      color: t.sub,
      textAlign: 'center',
      marginTop: 10,
      lineHeight: 19,
    },
    btnRow: {flexDirection: 'row', gap: 10, marginTop: 20},
    btnCol: {gap: 8},
    btnScroll: {marginTop: 20, maxHeight: 320},
    btn: {
      borderRadius: 21,
      paddingVertical: 10,
      paddingHorizontal: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    btnFlex: {flex: 1},
    btnPrimary: {backgroundColor: t.primary},
    btnPlain: {backgroundColor: t.cardLight},
    btnTextPrimary: {color: '#fff', fontSize: 14, fontWeight: '700'},
    btnTextCancel: {color: t.sub, fontSize: 14},
    btnTextDanger: {color: '#F5484D', fontSize: 14, fontWeight: '600'},
  });
