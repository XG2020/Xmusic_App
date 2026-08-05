package com.qmusiclite

import android.content.pm.PackageManager
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.qmusiclite.localmusic.LocalMusicModule

class MainActivity : ReactActivity() {

  override fun onCreate(savedInstanceState: Bundle?) {
    // 设置过自定义启动图时换成纯色启动窗口，避免先闪一下默认 logo 启动图
    val hasCustomSplash = getSharedPreferences("splash_prefs", MODE_PRIVATE)
      .getBoolean("custom_splash", false)
    if (hasCustomSplash) {
      setTheme(R.style.AppTheme_CustomSplash)
    }
    super.onCreate(savedInstanceState)
  }

  /**
   * 运行时权限结果转发给 LocalMusicModule（RN 0.76 的 ActivityEventListener
   * 无权限回调）：音频/存储读取授权后模块继续「所有文件访问」环节
   */
  override fun onRequestPermissionsResult(
    requestCode: Int,
    permissions: Array<out String>,
    grantResults: IntArray
  ) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode == LocalMusicModule.MEDIA_PERMISSION_REQUEST) {
      val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
      LocalMusicModule.notifyMediaPermissionResult(granted)
    }
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "QMusicLite"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
