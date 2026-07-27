import React, {useEffect, useRef, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  useWindowDimensions,
} from 'react-native';
import {
  NavigationContainer,
  useNavigationContainerRef,
} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import HomeScreen from './screens/HomeScreen';
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
import MiniPlayer from './components/MiniPlayer';
import Icon, {IconName} from './components/Icon';
import {showRankTabEnabled, subscribeShowRankTab} from './services/settings';
import {useTheme} from './theme';

const Stack = createNativeStackNavigator();

// 底栏三个主页面（logo 素材图标，选中/未选中两套造型）
const TABS: {label: string; icon: IconName; iconSel: IconName}[] = [
  {label: '首页', icon: 'tabHome', iconSel: 'tabHomeSel'},
  {label: '排行', icon: 'tabRank', iconSel: 'tabRank'},
  {label: '我的', icon: 'tabMine', iconSel: 'tabMineSel'},
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
]);

/**
 * 主页容器：首页/排行/我的 横向 pager，可左右滑动切换 + 自绘底栏
 * 外部跳转指定页：navigation.navigate('Main', {tab: 'rank'|'mine', ...})
 */
function MainTabs({navigation, route}: any) {
  const {t} = useTheme();
  const insets = useSafeAreaInsets();
  const {width} = useWindowDimensions();
  const pagerRef = useRef<ScrollView>(null);
  const [page, setPage] = useState(0);
  // 底栏排行榜入口开关（设置页切换后实时生效）
  const [showRank, setShowRank] = useState(showRankTabEnabled());
  useEffect(() => subscribeShowRankTab(setShowRank), []);
  // 开关切换后页数/下标变化，回到首页避免错位
  useEffect(() => {
    pagerRef.current?.scrollTo({x: 0, animated: false});
    setPage(0);
  }, [showRank]);

  const tabs = showRank ? TABS : [TABS[0], TABS[2]];
  const mineIndex = showRank ? 2 : 1;

  const go = (i: number) => {
    pagerRef.current?.scrollTo({x: i * width, animated: true});
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
      go(1);
    } else if (params.tab === 'mine') {
      go(mineIndex);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.tab, params.ts]);

  return (
    <View style={[styles.mainWrap, {backgroundColor: t.bg}]}>
      <ScrollView
        ref={pagerRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        onMomentumScrollEnd={e =>
          setPage(Math.round(e.nativeEvent.contentOffset.x / width))
        }>
        <View style={{width}}>
          <HomeScreen navigation={navigation} />
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
      </ScrollView>
      <MiniPlayer />
      <View
        style={[
          styles.tabBar,
          {backgroundColor: t.card, paddingBottom: Math.max(insets.bottom, 6)},
        ]}>
        {tabs.map(tab => {
          const i = tabs.indexOf(tab);
          const active = page === i;
          const color = active ? t.primary : t.sub;
          return (
            <TouchableOpacity
              key={tab.label}
              style={styles.tabItem}
              activeOpacity={0.8}
              onPress={() => go(i)}>
              <Icon
                name={active ? tab.iconSel : tab.icon}
                size={23}
                color={color}
              />
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
  const navRef = useNavigationContainerRef();
  const [routeName, setRouteName] = useState('');
  return (
    <NavigationContainer
      ref={navRef}
      onReady={() => setRouteName(navRef.getCurrentRoute()?.name ?? '')}
      onStateChange={() =>
        setRouteName(navRef.getCurrentRoute()?.name ?? '')
      }>
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
          options={{animation: 'fade_from_bottom', animationDuration: 220}}
        />
        <Stack.Screen name="Playlist" component={PlaylistScreen} />
        <Stack.Screen name="Rank" component={RankScreen} />
        <Stack.Screen name="PlaylistDetail" component={PlaylistDetailScreen} />
        <Stack.Screen name="Local" component={LocalScreen} />
        <Stack.Screen name="Settings" component={SettingsScreen} />
        <Stack.Screen name="SleepTimer" component={SleepTimerScreen} />
        <Stack.Screen name="Download" component={DownloadScreen} />
        <Stack.Screen
          name="NowPlaying"
          component={NowPlayingScreen}
          options={{animation: 'slide_from_bottom', animationDuration: 260}}
        />
        <Stack.Screen
          name="Player"
          component={PlayerScreen}
          options={{animation: 'slide_from_bottom', animationDuration: 300}}
        />
      </Stack.Navigator>
      {/* Stack 子页面底部全局迷你播放条（Tab 页由 tabBar 内的那份负责） */}
      {MINI_BAR_ROUTES.has(routeName) && <MiniPlayer />}
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  mainWrap: {flex: 1},
  tabBar: {
    flexDirection: 'row',
    paddingTop: 7,
    elevation: 8,
  },
  tabItem: {flex: 1, alignItems: 'center', gap: 2},
  tabLabel: {fontSize: 11, fontWeight: '600'},
});
