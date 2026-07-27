import React, {useEffect, useMemo, useState} from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Switch,
} from 'react-native';
import {AppAlert} from '../components/AppDialog';
import {SafeAreaView} from 'react-native-safe-area-context';
import {
  setSleepTimer,
  cancelSleepTimer,
  getSleepMinutes,
  getSleepRemaining,
  getSleepFinishTrack,
  setSleepFinishTrack,
} from '../services/sleepTimer';
import {useTheme, Theme} from '../theme';

const PRESETS = [15, 30, 45, 60];

/** 剩余秒数格式化为 mm:ss */
function fmtCountdown(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * 定时关闭页面（参考 QQ 音乐样式）：
 * 不开启 / 15 / 30 / 45 / 60 分钟后 / 自定义，选中项显示倒计时与 ✓
 */
export default function SleepTimerScreen({navigation}: any) {
  const {t} = useTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const [minutes, setMinutes] = useState(getSleepMinutes());
  const [remain, setRemain] = useState(getSleepRemaining());
  const [customOpen, setCustomOpen] = useState(false);
  const [customMin, setCustomMin] = useState('');
  const [finishTrack, setFinishTrack] = useState(getSleepFinishTrack());

  // 每秒刷新倒计时
  useEffect(() => {
    const iv = setInterval(() => {
      setRemain(getSleepRemaining());
      setMinutes(getSleepMinutes());
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  const pick = (min: number) => {
    setCustomOpen(false);
    if (min <= 0) {
      cancelSleepTimer();
    } else {
      setSleepTimer(min);
    }
    setMinutes(getSleepMinutes());
    setRemain(getSleepRemaining());
  };

  const onCustom = () => {
    const min = Math.floor(Number(customMin));
    if (!min || min <= 0 || min > 24 * 60) {
      AppAlert.alert('请输入有效的分钟数（1-1440）');
      return;
    }
    setCustomMin('');
    pick(min);
  };

  const isCustomActive = minutes > 0 && !PRESETS.includes(minutes);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.pageTitle}>定时关闭</Text>
        <View style={styles.backText} />
      </View>

      {/* 不开启 */}
      <TouchableOpacity style={styles.row} onPress={() => pick(0)}>
        <Text style={styles.rowLabel}>不开启</Text>
        {minutes === 0 && <Text style={styles.check}>✓</Text>}
      </TouchableOpacity>

      {/* 预设档位 */}
      {PRESETS.map(min => {
        const active = minutes === min;
        return (
          <TouchableOpacity
            key={min}
            style={styles.row}
            onPress={() => pick(min)}>
            <Text style={[styles.rowLabel, active && styles.rowActive]}>
              {min}分钟后
            </Text>
            {active && remain > 0 && (
              <Text style={styles.countdown}>{fmtCountdown(remain)}</Text>
            )}
            {active && <Text style={styles.check}>✓</Text>}
          </TouchableOpacity>
        );
      })}

      {/* 自定义 */}
      <TouchableOpacity
        style={styles.row}
        onPress={() => setCustomOpen(v => !v)}>
        <Text style={[styles.rowLabel, isCustomActive && styles.rowActive]}>
          自定义
          {isCustomActive ? `（${minutes}分钟）` : ''}
        </Text>
        {isCustomActive && remain > 0 && (
          <Text style={styles.countdown}>{fmtCountdown(remain)}</Text>
        )}
        {isCustomActive && <Text style={styles.check}>✓</Text>}
      </TouchableOpacity>
      {customOpen && (
        <View style={styles.customRow}>
          <TextInput
            style={styles.customInput}
            placeholder="输入分钟数（1-1440）"
            placeholderTextColor={t.sub}
            keyboardType="number-pad"
            value={customMin}
            onChangeText={setCustomMin}
            onSubmitEditing={onCustom}
            autoFocus
          />
          <TouchableOpacity style={styles.customBtn} onPress={onCustom}>
            <Text style={styles.customBtnText}>确定</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* 到时行为：立即暂停 / 播完当前歌曲再暂停 */}
      <View style={[styles.row, styles.finishRow]}>
        <View style={styles.finishLabelWrap}>
          <Text style={styles.finishLabel}>播完整首歌再关闭</Text>
          <Text style={styles.finishSub}>
            {finishTrack ? '到时后播完当前歌曲再暂停' : '到时后立即暂停'}
          </Text>
        </View>
        <Switch
          value={finishTrack}
          onValueChange={v => {
            setFinishTrack(v);
            setSleepFinishTrack(v);
          }}
          trackColor={{
            false: t.isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)',
            true: t.primary,
          }}
          thumbColor="#fff"
        />
      </View>

      <Text style={styles.hint}>
        {finishTrack
          ? '计时结束后，播完当前歌曲停止播放'
          : '计时结束后，停止播放'}
      </Text>
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
      width: 36,
    },
    pageTitle: {
      flex: 1,
      fontSize: 18,
      fontWeight: '700',
      color: t.text,
      textAlign: 'center',
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingVertical: 17,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
    },
    rowLabel: {flex: 1, fontSize: 16, color: t.text},
    rowActive: {color: t.primary, fontWeight: '600'},
    finishRow: {marginTop: 8},
    finishLabelWrap: {flex: 1},
    finishLabel: {fontSize: 16, color: t.text},
    finishSub: {fontSize: 12, color: t.sub, marginTop: 3},
    countdown: {color: t.sub, fontSize: 14, marginRight: 12},
    check: {
      color: t.primary,
      fontSize: 18,
      fontWeight: '700',
    },
    customRow: {
      flexDirection: 'row',
      gap: 10,
      paddingHorizontal: 20,
      paddingVertical: 12,
    },
    customInput: {
      flex: 1,
      backgroundColor: t.card,
      borderRadius: 18,
      paddingHorizontal: 14,
      height: 40,
      fontSize: 13,
      color: t.text,
    },
    customBtn: {
      backgroundColor: t.primary,
      borderRadius: 18,
      paddingHorizontal: 20,
      justifyContent: 'center',
    },
    customBtnText: {color: '#fff', fontSize: 14, fontWeight: '700'},
    hint: {
      color: t.sub,
      fontSize: 12,
      paddingHorizontal: 20,
      marginTop: 16,
    },
  });
