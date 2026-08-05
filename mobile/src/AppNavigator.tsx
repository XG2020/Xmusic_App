import React, {useEffect, useRef, useState} from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  ScrollView,
  Animated,
  TouchableOpacity,
  useWindowDimensions,
  Dimensions,
} from 'react-native';
import {
  NavigationContainer,
  DefaultTheme,
  DarkTheme,
  useNavigationContainerRef,
} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import HomeScreen, {PlaylistTabPage, HomeTopBar} from './screens/HomeScreen';
import RankScreen from './screens/RankScreen';
import MineScreen from './screens/MineScreen';
import PlayerScreen from './screens/PlayerScreen';
import SearchScreen from './screens/SearchScreen';
import PlaylistScreen from './screens/PlaylistScreen';
import PlaylistDetailScreen from './screens/PlaylistDetailScreen';
import LocalScreen from './screens/LocalScreen';
import SettingsScreen from './screens/SettingsScreen';
import SleepTimerScreen from './screens/SleepTimerScreen';
import DownloadScreen from './screens/DownloadScreen';
import NowPlayingScreen from './screens/NowPlayingScreen';
import PersonalizeScreen from './screens/PersonalizeScreen';
import MiniPlayer from './components/MiniPlayer';
import Icon, {IconName} from './components/Icon';
import {showRankTabEnabled, subscribeShowRankTab} from './services/settings';
import {useSkin, SkinSlot} from './services/skin';
import {useTheme} from './theme';

const Stack = createNativeStackNavigator();

// 底栏三个主页面（logo 素材图标，选中/未选中两套造型；slot 为皮肤自定义槽位）
const TABS: {
  label: string;
  icon: IconName;
  iconSel: IconName;
  slot: SkinSlot;
}[] = [
  {label: '首页', icon: 'tabHome', iconSel: 'tabHomeSel', slot: 'tabHome'},
  {label: '排行', icon: 'tabRank', iconSel: 'tabRank', slot: 'tabRank'},
  {label: '我的', icon: 'tabMine', iconSel: 'tabMineSel', slot: 'tabMine'},
];

// 需要在底部显示全局迷你播放条的 Stack 页面
// （Main 内的三个主页已在底栏上方自带，播放页/歌词页不显示）
const MINI_BAR_ROUTES = new Set([
  'Search',
  'Playlist',
  'PlaylistDetail',
  'Local',
  'Settings',
  'SleepTimer',
  'Download',
  'Rank',
  'Personalize',
]);

// 自绘了铺满屏幕的皮肤背景层的 Stack 页面：全局迷你播放条位于页面容器外，
// 收不到页面自绘背景，需同步自绘同款背景让自定义背景图铺满整屏（含播放条）
/**
 * 主页容器：推荐/歌单/排行/我的 横向 pager，可左右滑动连续切换 + 自绘底栏。
 * 推荐与歌单同属底栏「首页」tab（页0/1），顶部双 tab 与横滑联动。
 * 外部跳转指定页：navigation.navigate('Main', {tab: 'rank'|'mine', ...})
 */
function MainTabs({navigation, route}: any) {
  const {t} = useTheme();
  const insets = useSafeAreaInsets();
  const {width} = useWindowDimensions();
  const pagerRef = useRef<ScrollView>(null);
  const [page, setPage] = useState(0);
  // 横滑进度（原生驱动）：驱动固定顶栏标题/搜索提示交叉渐变
  const scrollX = useRef(new Animated.Value(0)).current;
  // 打开搜索时，搜索框上移；其下方 pager 内容同步向下退出。
  const searchContentTransition = useRef(new Animated.Value(0)).current;
  const searchContentShiftY = searchContentTransition.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 72],
  });
  const searchContentOpacity = searchContentTransition.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 0.35],
  });
  const startSearchContentExit = () =>
    Animated.timing(searchContentTransition, {
      toValue: 1,
      duration: 220,
      useNativeDriver: true,
    });
  const resetSearchContent = () => {
    searchContentTransition.stopAnimation();
    searchContentTransition.setValue(0);
  };
  // 固定顶栏实测高度：作为推荐/歌单两页内容的顶部内边距，避免被 overlay 遮住
  const [headerH, setHeaderH] = useState(0);
  // 皮肤：自定义背景图与底栏图标
  const skin = useSkin();
  // 底栏排行榜入口开关（设置页切换后实时生效）
  const [showRank, setShowRank] = useState(showRankTabEnabled());
  useEffect(() => subscribeShowRankTab(setShowRank), []);
  // 主页容器实测尺寸：顶栏自绘背景层与 mainWrap 背景层必须同尺寸（同 cover 算法）才能像素级对齐
  const [wrapSize, setWrapSize] = useState({w: 0, h: 0});
  // 开关切换后页数/下标变化，回到首页避免错位
  useEffect(() => {
    pagerRef.current?.scrollTo({x: 0, animated: false});
    setPage(0);
  }, [showRank]);

  // 页序：0 推荐、1 歌单、2 排行（可关）、末位 我的
  const rankIndex = 2;
  const mineIndex = showRank ? 3 : 2;

  const go = (i: number) => {
    // 点击切页直接定位不做滚动动画：程序滚动是固定时长补间不跟手，
    // 跨页时拖沓感明显；左右滑动手势仍保留跟手翻页
    pagerRef.current?.scrollTo({x: i * width, animated: false});
    setPage(i);
  };

  /** 排行榜横向榜单列表触摸时锁住 pager，避免被页面切换手势拦截 */
  const lockPager = (locked: boolean) => {
    pagerRef.current?.setNativeProps({scrollEnabled: !locked});
  };

  // 外部 navigate('Main', {tab, ...}) 时滑到对应页
  const params = route?.params ?? {};
  useEffect(() => {
    if (params.tab === 'rank' && showRank) {
      go(rankIndex);
    } else if (params.tab === 'mine') {
      go(mineIndex);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.tab, params.ts]);

  // 底栏 tab -> 目标页与选中判定（首页 tab 覆盖推荐/歌单两页）
  const tabPages = showRank
    ? [
        {tab: TABS[0], target: 0, active: page <= 1},
        {tab: TABS[1], target: rankIndex, active: page === rankIndex},
        {tab: TABS[2], target: mineIndex, active: page === mineIndex},
      ]
    : [
        {tab: TABS[0], target: 0, active: page <= 1},
        {tab: TABS[2], target: mineIndex, active: page === mineIndex},
      ];

  return (
    <View
      style={[styles.mainWrap, {backgroundColor: t.bg}]}
      onLayout={e => {
        const {width: w, height: h} = e.nativeEvent.layout;
        setWrapSize(prev => (prev.w === w && prev.h === h ? prev : {w, h}));
      }}>
      {/* 自定义背景图：铺满主页容器，三个主页容器背景随之透明 */}
      {!!skin.bg && (
        <>
          <Image
            source={{uri: skin.bg}}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
            resizeMethod="resize"
          />
          {/* 主题色半透明遮罩：压暗/压亮背景图，保证文字、列表等内容可读 */}
          <View
            style={[StyleSheet.absoluteFill, {backgroundColor: t.bg + 'A6'}]}
          />
        </>
      )}
      <Animated.ScrollView
        ref={pagerRef}
        style={{
          opacity: searchContentOpacity,
          transform: [{translateY: searchContentShiftY}],
        }}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={16}
        onScroll={Animated.event(
          [{nativeEvent: {contentOffset: {x: scrollX}}}],
          {useNativeDriver: true},
        )}
        onMomentumScrollEnd={e =>
          setPage(Math.round(e.nativeEvent.contentOffset.x / width))
        }>
        <View style={{width}}>
          <HomeScreen navigation={navigation} topPad={headerH} />
        </View>
        <View style={{width}}>
          <PlaylistTabPage navigation={navigation} topPad={headerH} />
        </View>
        {showRank && (
          <View style={{width}}>
            <RankScreen
              navigation={navigation}
              route={{params: {rankId: params.rankId}}}
              lockPager={lockPager}
            />
          </View>
        )}
        <View style={{width}}>
          <MineScreen
            navigation={navigation}
            route={{params: {tab: params.mineTab, ts: params.ts}}}
          />
        </View>
      </Animated.ScrollView>
      {/* 固定顶栏 overlay：推荐/歌单双标题 + 下载入口 + 搜索栏，随横滑交叉渐变 */}
      <HomeTopBar
        navigation={navigation}
        goTab={go}
        page={page}
        scrollX={scrollX}
        width={width}
        insetsTop={insets.top}
        wrapHeight={wrapSize.h}
        onHeight={setHeaderH}
        onSearchContentExit={startSearchContentExit}
        onSearchContentReset={resetSearchContent}
      />
      <MiniPlayer />
      <View
        style={[
          styles.tabBar,
          {
            backgroundColor: t.panel ?? t.card,
            paddingBottom: Math.max(insets.bottom, 6),
          },
        ]}>
        {tabPages.map(({tab, target, active}) => {
          const color = active ? t.primary : t.sub;
          const customIcon = skin[tab.slot];
          return (
            <TouchableOpacity
              key={tab.label}
              style={styles.tabItem}
              activeOpacity={0.8}
              onPress={() => go(target)}>
              {/* 固定高度图标区：自定义图(30)与内置图(23)混搭时文字基线也对齐 */}
              <View style={styles.tabIconBox}>
                {customIcon ? (
                  // 自定义图标保持原色不着色，未选中时降低透明度区分状态
                  <Image
                    source={{uri: customIcon}}
                    style={[styles.tabCustomIcon, !active && styles.tabCustomDim]}
                    resizeMode="cover"
                    resizeMethod="resize"
                  />
                ) : (
                  <Icon
                    name={active ? tab.iconSel : tab.icon}
                    size={23}
                    color={color}
                  />
                )}
              </View>
              <Text style={[styles.tabLabel, {color}]}>{tab.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

export default function AppNavigator() {
  const {t} = useTheme();
  const skin = useSkin();
  const navRef = useNavigationContainerRef();
  // routeName 仅用于 MiniPlayer 显隐判断
  const [routeName, setRouteName] = useState('');

  return (
    <NavigationContainer
      ref={navRef}
      // 保持导航容器透明，由常驻的 NavigationBackground 提供不会随转场卸载的底图。
      theme={{
        ...(t.isDark ? DarkTheme : DefaultTheme),
        colors: {
          ...(t.isDark ? DarkTheme : DefaultTheme).colors,
          background: 'transparent',
        },
      }}
      // onStateChange 仅服务于 MiniPlayer 显隐（底部播放条路由过滤）
      onReady={() => setRouteName(navRef.getCurrentRoute()?.name ?? '')}
      onStateChange={() =>
        setRouteName(navRef.getCurrentRoute()?.name ?? '')
      }>
      <View style={styles.root}>
        {/* 常驻背景：透明歌单页在进、退场动画中都不会露出主题底色。 */}
        <NavigationBackground skinBg={skin.bg} tint={t.bg} />
        <Stack.Navigator
          screenOptions={{
            headerShown: false,
            animation: 'slide_from_right',
            animationDuration: 260,
            contentStyle: {backgroundColor: t.bg},
          }}>
          <Stack.Screen name="Main" component={MainTabs} />
          <Stack.Screen
            name="Search"
            component={SearchScreen}
            options={{
              // 首页搜索框已先在原位置上推到目标位置；此处只做短暂淡入，
              // 不再让整个搜索页从底部滑入。
              animation: 'fade',
              animationDuration: 100,
              contentStyle: {backgroundColor: 'transparent'},
            }}
          />
          <Stack.Screen
            name="Playlist"
            component={PlaylistScreen}
            options={{contentStyle: {backgroundColor: 'transparent'}}}
          />
          <Stack.Screen
            name="Rank"
            component={RankScreen}
            options={{contentStyle: {backgroundColor: 'transparent'}}}
          />
          <Stack.Screen
            name="PlaylistDetail"
            component={PlaylistDetailScreen}
            options={{contentStyle: {backgroundColor: 'transparent'}}}
          />
          <Stack.Screen
            name="Local"
            component={LocalScreen}
            options={{contentStyle: {backgroundColor: 'transparent'}}}
          />
          <Stack.Screen name="Settings" component={SettingsScreen} />
          <Stack.Screen name="Personalize" component={PersonalizeScreen} />
          <Stack.Screen name="SleepTimer" component={SleepTimerScreen} />
          <Stack.Screen
            name="Download"
            component={DownloadScreen}
            options={{contentStyle: {backgroundColor: 'transparent'}}}
          />
          <Stack.Screen
            name="NowPlaying"
            component={NowPlayingScreen}
            options={{
              animation: 'slide_from_bottom',
              animationDuration: 260,
              contentStyle: {backgroundColor: 'transparent'},
            }}
          />
          <Stack.Screen
            name="Player"
            component={PlayerScreen}
            options={{animation: 'slide_from_bottom', animationDuration: 300}}
          />
        </Stack.Navigator>
        {/* Stack 子页面底部全局迷你播放条（Tab 页由 tabBar 内的那份负责） */}
        {MINI_BAR_ROUTES.has(routeName) && <MiniPlayer />}
      </View>
    </NavigationContainer>
  );
}

/**
 * 常驻于 Stack 下方的导航背景。路由状态在 pop 开始时就会切换，
 * 因此不能随路由条件卸载，否则退场中的透明页会闪出主题底色。
 */
function NavigationBackground({
  skinBg,
  tint,
}: {
  skinBg?: string;
  tint: string;
}) {
  // Android adjustResize 会在键盘弹出时缩短 React 根容器；背景必须按物理屏幕
  // 尺寸绘制，不能跟随容器高度重算 cover，否则画面会被上挤。
  const {width, height} = Dimensions.get('screen');
  const fixedScreenFill = {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    width,
    height,
  };
  if (!skinBg) {
    return <View style={[fixedScreenFill, {backgroundColor: tint}]} />;
  }
  return (
    <>
      <Image
        source={{uri: skinBg}}
        style={fixedScreenFill}
        resizeMode="cover"
        resizeMethod="resize"
      />
      <View
        style={[fixedScreenFill, {backgroundColor: tint + 'A6'}]}
      />
    </>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: 'transparent'},
  mainWrap: {flex: 1},
  tabBar: {
    flexDirection: 'row',
    paddingTop: 7,
    elevation: 8,
  },
  tabItem: {flex: 1, alignItems: 'center', gap: 2},
  // 图标区固定高度取自定义图尺寸，内置图居中，三个位混搭不错位
  tabIconBox: {height: 30, justifyContent: 'center', alignItems: 'center'},
  tabLabel: {fontSize: 11, fontWeight: '600'},
  // 自定义底栏图标：比内置 Icon 大一号更醒目（图片图标视觉上比线条图形显小），圆角裁剪自动缩放
  tabCustomIcon: {width: 30, height: 30, borderRadius: 7},
  tabCustomDim: {opacity: 0.55},
});
