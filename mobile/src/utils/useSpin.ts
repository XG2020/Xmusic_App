import {useEffect, useRef} from 'react';
import {Animated, Easing} from 'react-native';

/**
 * 连续旋转动画 hook：
 * 暂停时停在当前角度，恢复播放时从当前角度继续转（不回跳），动画更顺滑。
 * 不用 addListener 常驻监听（native driver 下会每帧发事件回 JS 线程），
 * 改在暂停时通过 stopAnimation 回调一次性拿到当前角度。
 */
export function useSpin(playing: boolean, duration = 20000) {
  const spin = useRef(new Animated.Value(0)).current;
  const current = useRef(0);
  const running = useRef(false);

  useEffect(() => {
    running.current = playing;
    if (!playing) {
      // 停止并记录当前角度，下次从这里继续转
      spin.stopAnimation(value => {
        current.current = value;
      });
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
      spin.stopAnimation(value => {
        current.current = value;
      });
    };
  }, [playing, duration, spin]);

  return spin.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });
}
