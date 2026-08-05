import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  Animated,
  Easing,
  Modal,
  StyleProp,
  StyleSheet,
  TouchableOpacity,
  ViewStyle,
} from 'react-native';

type Props = {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  slideDistance?: number;
  maskColor?: string;
  sheetStyle?: StyleProp<ViewStyle>;
};

/**
 * 复用迷你播放条播放列表的底部弹层动效：
 * 遮罩单独淡入淡出，面板单独上滑/下滑，避免系统 slide 把整层一起推上来。
 */
export default function AnimatedBottomSheetModal({
  visible,
  onClose,
  children,
  slideDistance = 420,
  maskColor = 'rgba(0,0,0,0.55)',
  sheetStyle,
}: Props) {
  const [mounted, setMounted] = useState(visible);
  const anim = useRef(new Animated.Value(visible ? 1 : 0)).current;
  const ticketRef = useRef(0);
  const openSheet = (ticket: number) => {
    Animated.timing(anim, {
      toValue: 1,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start(({finished}) => {
      if (!finished || ticketRef.current !== ticket) {
        return;
      }
    });
  };

  useEffect(() => {
    if (visible) {
      const ticket = ++ticketRef.current;
      anim.setValue(0);
      if (!mounted) {
        setMounted(true);
      } else {
        openSheet(ticket);
      }
      return;
    }
    if (!mounted) {
      return;
    }
    const ticket = ++ticketRef.current;
    Animated.timing(anim, {
      toValue: 0,
      duration: 160,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(({finished}) => {
      if (finished && ticketRef.current === ticket) {
        setMounted(false);
      }
    });
  }, [anim, mounted, visible]);

  const handleShow = () => {
    if (!visible) {
      return;
    }
    const ticket = ticketRef.current;
    openSheet(ticket);
  };

  const sheetAnimatedStyle = useMemo(
    () => ({
      transform: [
        {
          translateY: anim.interpolate({
            inputRange: [0, 1],
            outputRange: [slideDistance, 0],
          }),
        },
      ],
    }),
    [anim, slideDistance],
  );

  if (!mounted) {
    return null;
  }

  return (
    <Modal
      visible
      transparent
      statusBarTranslucent
      animationType="none"
      onShow={handleShow}
      onRequestClose={onClose}>
      <Animated.View
        style={[styles.mask, {opacity: anim, backgroundColor: maskColor}]}>
        <TouchableOpacity
          style={styles.maskTouch}
          activeOpacity={1}
          onPress={onClose}>
          <Animated.View
            style={[styles.sheet, sheetAnimatedStyle, sheetStyle]}
            onStartShouldSetResponder={() => true}>
            {children}
          </Animated.View>
        </TouchableOpacity>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  mask: {
    flex: 1,
  },
  maskTouch: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    overflow: 'hidden',
  },
});
