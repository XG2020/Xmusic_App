package com.qmusiclite.localmusic

import android.content.Intent
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.content.ContentResolver
import android.database.Cursor
import android.net.Uri
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import java.io.File

class LocalMusicModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "LocalMusic"

  @ReactMethod
  fun getAudioFiles(promise: com.facebook.react.bridge.Promise) {
    try {
      val resolver: ContentResolver = reactContext.contentResolver
      val uri: Uri = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
      val projection = arrayOf(
        MediaStore.Audio.Media._ID,
        MediaStore.Audio.Media.TITLE,
        MediaStore.Audio.Media.ARTIST,
        MediaStore.Audio.Media.ALBUM,
        MediaStore.Audio.Media.DURATION,
        MediaStore.Audio.Media.DATA
      )
      val selection = MediaStore.Audio.Media.IS_MUSIC + "!= 0"
      val cursor: Cursor? = resolver.query(uri, projection, selection, null, null)
      val list: WritableArray = Arguments.createArray()
      cursor?.use {
        val idIndex = it.getColumnIndexOrThrow(MediaStore.Audio.Media._ID)
        val titleIndex = it.getColumnIndexOrThrow(MediaStore.Audio.Media.TITLE)
        val artistIndex = it.getColumnIndexOrThrow(MediaStore.Audio.Media.ARTIST)
        val albumIndex = it.getColumnIndexOrThrow(MediaStore.Audio.Media.ALBUM)
        val durationIndex = it.getColumnIndexOrThrow(MediaStore.Audio.Media.DURATION)
        val dataIndex = it.getColumnIndexOrThrow(MediaStore.Audio.Media.DATA)
        while (it.moveToNext()) {
          val map: WritableMap = Arguments.createMap()
          map.putString("id", it.getString(idIndex))
          map.putString("title", it.getString(titleIndex))
          map.putString("artist", it.getString(artistIndex))
          map.putString("album", it.getString(albumIndex))
          map.putInt("duration", it.getInt(durationIndex))
          map.putString("path", it.getString(dataIndex))
          list.pushMap(map)
        }
      }
      promise.resolve(list)
    } catch (e: Exception) {
      promise.reject("E_LOCAL_MUSIC", e)
    }
  }

  /**
   * 用系统文件管理器打开指定文件所在目录（尽力而为，多级兜底适配国产 ROM）。
   * 成功唤起任一文件管理器返回 true，全部失败返回 false（由 JS 端提示路径）。
   */
  @ReactMethod
  fun openFolder(path: String, promise: com.facebook.react.bridge.Promise) {
    try {
      val f = File(path)
      val dir = if (f.isDirectory) f.absolutePath else (f.parent ?: path)
      val rel = dir.removePrefix("/storage/emulated/0").trimStart('/')

      // 1) DocumentsUI（系统文件/各厂商文件管理器均注册）定位到目录
      try {
        val docUri = DocumentsContract.buildDocumentUri(
          "com.android.externalstorage.documents",
          "primary:$rel"
        )
        val intent = Intent(Intent.ACTION_VIEW).apply {
          setDataAndType(docUri, DocumentsContract.Document.MIME_TYPE_DIR)
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        reactContext.startActivity(intent)
        promise.resolve(true)
        return
      } catch (e: Exception) {
        // 继续尝试下一级
      }

      // 2) 部分第三方/国产文件管理器支持 resource/folder 定位
      try {
        val intent = Intent(Intent.ACTION_VIEW).apply {
          setDataAndType(Uri.parse("file://$dir"), "resource/folder")
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        reactContext.startActivity(intent)
        promise.resolve(true)
        return
      } catch (e: Exception) {
        // 继续尝试下一级
      }

      // 3) 目录在 Download 下时，打开系统"下载内容"页兜底
      if (dir.contains("/Download")) {
        try {
          val intent = Intent(android.app.DownloadManager.ACTION_VIEW_DOWNLOADS).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          }
          reactContext.startActivity(intent)
          promise.resolve(true)
          return
        } catch (e: Exception) {
          // 继续兜底
        }
      }

      promise.resolve(false)
    } catch (e: Exception) {
      promise.reject("E_OPEN_FOLDER", e)
    }
  }
}
