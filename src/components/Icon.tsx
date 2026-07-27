import React from 'react';
import {Image, ImageStyle, StyleProp} from 'react-native';

/** 单色图标素材（渲染时按主题 tintColor 着色） */
const MONO_ICONS = {
  downloadFilled: require('../assets/icons/download_filled.png'),
  // 空心描边下载（脚本生成 240px，播放页使用）
  downloadOutline: require('../assets/icons/download_outline.png'),
  // 排序（脚本生成 160px 实心箭头，替换过细的「⇅」文字符号）
  sort: require('../assets/icons/ctrl_sort.png'),
  // 删除/更多（脚本生成 240px，替换低清垃圾桶与「⋮」文字符号）
  garbage: require('../assets/icons/garbage_hd.png'),
  more: require('../assets/icons/more_dots_hd.png'),
  // 播放模式/收藏/倍速/±15s（脚本生成 240px，替换低分辨率原图避免放大模糊）
  modeList: require('../assets/icons/mode_list_hd.png'),
  modeSingle: require('../assets/icons/mode_single_hd.png'),
  modeShuffle: require('../assets/icons/mode_shuffle_hd.png'),
  // 高清播控图标（脚本生成 160px，替换 32px 通知栏小图避免放大模糊）
  play: require('../assets/icons/ctrl_play.png'),
  pause: require('../assets/icons/ctrl_pause.png'),
  prev: require('../assets/icons/ctrl_prev.png'),
  next: require('../assets/icons/ctrl_next.png'),
  favOff: require('../assets/icons/fav_off_hd.png'),
  timer: require('../assets/icons/player_action_autoclose.png'),
  speedBack15: require('../assets/icons/speed_back15_hd.png'),
  speedForward15: require('../assets/icons/speed_forward15_hd.png'),
  speedNormal: require('../assets/icons/speed_normal_hd.png'),
  speed05: require('../assets/icons/speed_05_hd.png'),
  speed06: require('../assets/icons/speed_06_hd.png'),
  speed07: require('../assets/icons/speed_07_hd.png'),
  speed08: require('../assets/icons/speed_08_hd.png'),
  speed09: require('../assets/icons/speed_09_hd.png'),
  speed11: require('../assets/icons/speed_11_hd.png'),
  speed12: require('../assets/icons/speed_12_hd.png'),
  speed13: require('../assets/icons/speed_13_hd.png'),
  speed14: require('../assets/icons/speed_14_hd.png'),
  speed15: require('../assets/icons/speed_15_hd.png'),
  speed16: require('../assets/icons/speed_16_hd.png'),
  speed17: require('../assets/icons/speed_17_hd.png'),
  speed18: require('../assets/icons/speed_18_hd.png'),
  speed19: require('../assets/icons/speed_19_hd.png'),
  speed20: require('../assets/icons/speed_20_hd.png'),
  tabHome: require('../assets/icons/tab_home.png'),
  tabHomeSel: require('../assets/icons/tab_home_sel.png'),
  tabRank: require('../assets/icons/tab_rank.png'),
  tabMine: require('../assets/icons/tab_mine.png'),
  tabMineSel: require('../assets/icons/tab_mine_sel.png'),
  miniList: require('../assets/icons/minibar_playlist.png'),
  miniListHl: require('../assets/icons/minibar_playlist_hl.png'),
  setting: require('../assets/icons/setting.png'),
  phone: require('../assets/icons/qsmart_phone.png'),
  headset: require('../assets/icons/qsmart_headset.png'),
} as const;

/** 彩色图标素材（保持原色，不做着色） */
const COLOR_ICONS = {
  search: require('../assets/icons/search.png'),
  favOn: require('../assets/icons/fav_on_hd.png'),
  heart: require('../assets/icons/liked_playlist_logo.png'),
} as const;

export type IconName = keyof typeof MONO_ICONS | keyof typeof COLOR_ICONS;

type Props = {
  name: IconName;
  size?: number;
  /** 单色图标着色；彩色图标忽略此项 */
  color?: string;
  style?: StyleProp<ImageStyle>;
};

/** 统一的位图图标：logo 素材 + 主题着色 */
export default function Icon({name, size = 20, color, style}: Props) {
  const colored = name in COLOR_ICONS;
  const source = colored
    ? COLOR_ICONS[name as keyof typeof COLOR_ICONS]
    : MONO_ICONS[name as keyof typeof MONO_ICONS];
  return (
    <Image
      source={source}
      resizeMode="contain"
      style={[
        {width: size, height: size},
        !colored && !!color ? {tintColor: color} : null,
        style,
      ]}
    />
  );
}
