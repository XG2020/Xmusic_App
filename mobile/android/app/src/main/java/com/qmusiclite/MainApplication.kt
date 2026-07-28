package com.qmusiclite

import android.app.Application
import android.content.Context
import androidx.appcompat.app.AppCompatDelegate
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.load
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.react.soloader.OpenSourceMergedSoMapping
import com.facebook.soloader.SoLoader
import com.qmusiclite.localmusic.LocalMusicPackage

class MainApplication : Application(), ReactApplication {

  companion object {
    /** 应用内主题模式 -> AppCompat DayNight 模式 */
    fun nightModeOf(mode: String?): Int = when (mode) {
      "dark" -> AppCompatDelegate.MODE_NIGHT_YES
      "light" -> AppCompatDelegate.MODE_NIGHT_NO
      else -> AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
    }

    /**
     * 按 JS 侧保存的应用内主题模式强制 DayNight：
     * 启动窗口/values-night 资源跟随应用内主题解析，
     * 而不是只认系统深浅色（应用设浅色+系统深色时启动图不再是深色）
     */
    fun applySavedThemeMode(context: Context) {
      val mode = context
        .getSharedPreferences("splash_prefs", Context.MODE_PRIVATE)
        .getString("theme_mode", "system")
      AppCompatDelegate.setDefaultNightMode(nightModeOf(mode))
    }
  }

  override val reactNativeHost: ReactNativeHost =
      object : DefaultReactNativeHost(this) {
        override fun getPackages(): List<ReactPackage> =
            PackageList(this).packages.apply {
              add(LocalMusicPackage())
            }

        override fun getJSMainModuleName(): String = "index"

        override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

        override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
        override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED
      }

  override val reactHost: ReactHost
    get() = getDefaultReactHost(applicationContext, reactNativeHost)

  override fun onCreate() {
    super.onCreate()
    // 必须在任何 Activity 创建前应用，冷启动窗口才能拿到正确的明暗资源
    applySavedThemeMode(this)
    SoLoader.init(this, OpenSourceMergedSoMapping)
    if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
      // If you opted-in for the New Architecture, we load the native entry point for this app.
      load()
    }
  }
}
