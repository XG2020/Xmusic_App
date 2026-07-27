import {useEffect, useRef} from 'react';
import {Animated, Easing} from 'react-native';

/**
 * 连续旋转动画 hook：
 * 暂停时停在当前角度，恢复播放时从当前角度继续转（不回跳），动画更顺滑。
 */
export function useSpin(playing: boolean, duration = 20000) {
  const spin = useRef(new Animated.Value(0)).current;
  const current = useRef(0);
  const running = useRef(false);

  useEffect(() => {
    const sub = spin.addListener(({value}) => {
      current.current = value;
    });
    return () => spin.removeListener(sub);
  }, [spin]);

  useEffect(() => {
    running.current = playing;
    if (!playing) {
      spin.stopAnimation();
      return;
    }
    const tick = () => {
      if (!running.current) {
        return;
      }
      const remain = 1 - current.current;
      Animated.timing(spin, {
        toValue: 1,
        duration: Math.max(remain * duration, 16),
        easing: Easing.linear,
        useNativeDriver: true,
      }).start(({finished}) => {
        if (finished && running.current) {
          spin.setValue(0);
          current.current = 0;
          tick();
        }
      });
    };
    tick();
    return () => {
      running.current = false;
      spin.stopAnimation();
    };
  }, [playing, duration, spin]);

  return spin.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });
}
