# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

# ---- React Native 核心 ----
-keep class com.facebook.react.** { *; }
-keep class com.facebook.hermes.** { *; }
-keep class com.facebook.jni.** { *; }
-keep class com.facebook.soloader.** { *; }
-dontwarn com.facebook.react.**

# 保留 Native Module / TurboModule 的注解方法，避免 RN 桥反射调用失效
-keepclassmembers class * { @com.facebook.react.bridge.ReactMethod <methods>; }
-keepclassmembers,includedescriptorclasses class * { native <methods>; }
-keep,allowobfuscation @interface com.facebook.proguard.annotations.DoNotStrip
-keep @com.facebook.proguard.annotations.DoNotStrip class *
-keepclassmembers class * {
    @com.facebook.proguard.annotations.DoNotStrip *;
}

# ---- 本项目自定义原生模块（LocalMusicModule 经反射注册） ----
-keep class com.qmusiclite.localmusic.** { *; }

# ---- react-native-track-player（前台服务/媒体会话） ----
-keep class com.doublesymmetry.trackplayer.** { *; }
-dontwarn com.doublesymmetry.trackplayer.**

# ---- react-native-fs ----
-keep class com.rnfs.** { *; }

# ---- OkHttp / Okio（RN 网络层） ----
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn javax.annotation.**

# ---- Kotlin 协程 ----
-dontwarn kotlinx.coroutines.**
