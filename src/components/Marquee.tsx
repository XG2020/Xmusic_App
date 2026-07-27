import React, {useEffect, useRef, useState} from 'react';
import {View, Animated, Easing, StyleSheet} from 'react-native';

const GAP = 48; // 首尾副本间距
const SPEED = 35; // 像素/秒
const PAUSE = 1500; // 每轮滚动前停留时间

type Props = {
  children: React.ReactNode;
  style?: any;
};

/**
 * 跑马灯：内容宽度超过容器时自动循环滚动，否则静态显示
 * 用法：<Marquee key={文本变化时重置}><Text numberOfLines={1}>...</Text></Marquee>
 */
export default function Marquee({children, style}: Props) {
  const [containerW, setContainerW] = useState(0);
  const [textW, setTextW] = useState(0);
  const offset = useRef(new Animated.Value(0)).current;
  const shouldScroll = containerW > 0 && textW > containerW + 1;

  useEffect(() => {
    if (!shouldScroll) {
      offset.setValue(0);
      return;
    }
    const distance = textW + GAP;
    const anim = Animated.loop(
      Animated.sequence([
        Animated.delay(PAUSE),
        Animated.timing(offset, {
          toValue: -distance,
          duration: (distance / SPEED) * 1000,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
        // 第二份副本滚到原位后瞬间归零，实现无缝循环
        Animated.timing(offset, {toValue: 0, duration: 0, useNativeDriver: true}),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [shouldScroll, textW, offset]);

  return (
    <View
      style={[styles.clip, style]}
      onLayout={e => setContainerW(e.nativeEvent.layout.width)}>
      <Animated.View style={[styles.row, {transform: [{translateX: offset}]}]}>
        <View
          style={styles.item}
          onLayout={e => setTextW(e.nativeEvent.layout.width)}>
          {children}
        </View>
        {shouldScroll && (
          <View style={[styles.item, {marginLeft: GAP}]}>{children}</View>
        )}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  clip: {overflow: 'hidden'},
  row: {flexDirection: 'row', alignItems: 'center'},
  // flexShrink:0 保持内容自然宽度以便测量
  item: {flexShrink: 0},
});
