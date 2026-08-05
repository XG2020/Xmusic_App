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
# RN/Hermes 依赖自带 consumer rules，这里只保留桥反射所需的最小规则，
# 不再整包 keep，避免削弱 R8 裁剪与混淆效果
-keepclassmembers,includedescriptorclasses class * { native <methods>; }
-keepclassmembers class * { @com.facebook.react.bridge.ReactMethod <methods>; }
-keepclassmembers class * { @com.facebook.proguard.annotations.DoNotStrip *; }
-keep,allowobfuscation @interface com.facebook.proguard.annotations.DoNotStrip
-keep @com.facebook.proguard.annotations.DoNotStrip class *
-dontwarn com.facebook.react.**
-dontwarn com.facebook.hermes.**
-dontwarn com.facebook.jni.**
-dontwarn com.facebook.soloader.**

# ---- 本项目自定义原生模块（LocalMusicModule 经反射注册，保留类名与方法） ----
-keep,allowobfuscation class com.qmusiclite.localmusic.LocalMusicModule
-keep,allowobfuscation class com.qmusiclite.localmusic.LocalMusicPackage
-keepclassmembers,allowobfuscation class com.qmusiclite.localmusic.LocalMusicModule {
    @com.facebook.react.bridge.ReactMethod <methods>;
    public <init>(...);
}

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
