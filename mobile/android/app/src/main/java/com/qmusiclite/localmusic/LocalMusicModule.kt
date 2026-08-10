package com.qmusiclite.localmusic

import android.Manifest
import android.app.Activity
import android.content.ContentResolver
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.provider.Settings
import android.database.Cursor
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import java.io.File
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap

class LocalMusicModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "LocalMusic"

  // JS 首帧可同步读到的常量：是否设置了自定义启动图（决定 Splash 首帧显示纯色还是内置图）
  override fun getConstants(): Map<String, Any> = mapOf(
    "hasCustomSplash" to reactContext
      .getSharedPreferences("splash_prefs", android.content.Context.MODE_PRIVATE)
      .getBoolean("custom_splash", false)
  )

  /**
   * 记录"已设置自定义启动图"标志到 SharedPreferences，
   * MainActivity 冷启动时据此把启动窗口换成纯色底（不显示默认 logo 图）
   */
  @ReactMethod
  fun setCustomSplashFlag(enabled: Boolean) {
    reactContext
      .getSharedPreferences("splash_prefs", android.content.Context.MODE_PRIVATE)
      .edit().putBoolean("custom_splash", enabled).apply()
  }

  /**
   * 同步应用内主题模式（system/dark/light）到 SharedPreferences 并立即应用：
   * 下次冷启动 MainApplication 据此强制 DayNight，启动窗口跟随应用内主题
   * 而不是系统深浅色；运行时立即生效让状态栏等原生资源同步切换
   */
  @ReactMethod
  fun setThemeMode(mode: String) {
    reactContext
      .getSharedPreferences("splash_prefs", android.content.Context.MODE_PRIVATE)
      .edit().putString("theme_mode", mode).apply()
    // setDefaultNightMode 必须在主线程调用
    com.facebook.react.bridge.UiThreadUtil.runOnUiThread {
      androidx.appcompat.app.AppCompatDelegate.setDefaultNightMode(
        com.qmusiclite.MainApplication.nightModeOf(mode)
      )
    }
  }

  /**
   * 全量扫描 MediaStore 音频（在后台线程执行，避免阻塞 NativeModule 线程）。
   * 返回每条含 contentUri（分区存储安全）与 path（兼容展示），以及 DATE_ADDED 供增量使用。
   */
  @ReactMethod
  fun getAudioFiles(promise: com.facebook.react.bridge.Promise) {
    Thread(Runnable {
      try {
        val resolver: ContentResolver = reactContext.contentResolver
        val uri: Uri = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
        val projection = arrayOf(
          MediaStore.Audio.Media._ID,
          MediaStore.Audio.Media.TITLE,
          MediaStore.Audio.Media.ARTIST,
          MediaStore.Audio.Media.ALBUM,
          MediaStore.Audio.Media.DURATION,
          MediaStore.Audio.Media.DATE_ADDED,
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
          val addedIndex = it.getColumnIndexOrThrow(MediaStore.Audio.Media.DATE_ADDED)
          val dataIndex = it.getColumnIndexOrThrow(MediaStore.Audio.Media.DATA)
          while (it.moveToNext()) {
            val id = it.getString(idIndex) ?: continue
            val map: WritableMap = Arguments.createMap()
            map.putString("id", id)
            map.putString("title", it.getString(titleIndex))
            map.putString("artist", it.getString(artistIndex))
            map.putString("album", it.getString(albumIndex))
            map.putInt("duration", it.getInt(durationIndex))
            map.putDouble("dateAdded", it.getLong(addedIndex).toDouble())
            // 分区存储下真实路径不可靠：优先用 content:// URI 播放，path 仅作展示/兼容
            map.putString(
              "uri",
              MediaStore.Audio.Media.EXTERNAL_CONTENT_URI.buildUpon()
                .appendPath(id).build().toString()
            )
            // Android 13+ 的 DATA 列可能为 null（分区存储），putString 不允许 null 值，否则抛异常
            map.putString("path", it.getString(dataIndex) ?: "")
            list.pushMap(map)
          }
        }
        promise.resolve(list)
      } catch (e: Exception) {
        promise.reject("E_LOCAL_MUSIC", e)
      }
    }, "local-music-scan").start()
  }

  /**
   * 用系统文件管理器打开指定文件所在目录（尽力而为，多级兜底适配国产 ROM）。
   * 成功唤起任一文件管理器返回 true，全部失败返回 false（由 JS 端提示路径）。
   */
  @ReactMethod
  fun openFolder(path: String, promise: com.facebook.react.bridge.Promise) {
    try {
      // SAF 授权目录（content:// tree URI）：直接用系统文件管理器打开该目录
      if (path.startsWith("content://")) {
        val parsed = Uri.parse(path)
        // 传入单个文件的 document uri 时，先回退到其父目录；目录 tree uri 直接打开
        val dirUri = if (isTreeOnlyUri(parsed)) {
          DocumentsContract.buildDocumentUriUsingTree(
            parsed,
            DocumentsContract.getTreeDocumentId(parsed)
          )
        } else if (isDocumentUri(parsed)) {
          val docId = DocumentsContract.getDocumentId(parsed)
          val parentId = docId.substringBeforeLast('/', "")
          if (parentId.isNotEmpty()) {
            if (DocumentsContract.isTreeUri(parsed)) {
              DocumentsContract.buildDocumentUriUsingTree(parsed, parentId)
            } else {
              DocumentsContract.buildDocumentUri(parsed.authority, parentId)
            }
          } else {
            parsed
          }
        } else {
          parsed
        }
        try {
          val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(dirUri, DocumentsContract.Document.MIME_TYPE_DIR)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          }
          reactContext.startActivity(intent)
          promise.resolve(true)
          return
        } catch (e: Exception) {
          // 打开失败继续尝试下一级
        }
      }
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

  // ===== SAF 下载目录授权（Android 分区存储下系统级目录授权） =====

  companion object {
    private const val PICK_DIR_REQUEST = 48621
    private const val PICK_IMAGE_REQUEST = 48622
    /** 「所有文件访问」系统设置页返回 */
    private const val REQUEST_ALL_FILES = 48624

    /**
     * 运行时权限（音频/存储读取）请求码：MainActivity.onRequestPermissionsResult
     * 据此转发结果（RN 0.76 的 ActivityEventListener 无权限回调，需 Activity 中转）
     */
    const val MEDIA_PERMISSION_REQUEST = 48623

    /** 当前模块实例（RN 每个模块全局单例），供 MainActivity 权限结果转发 */
    @Volatile
    private var instance: LocalMusicModule? = null

    /** 由 MainActivity.onRequestPermissionsResult 调用（主线程） */
    @JvmStatic
    fun notifyMediaPermissionResult(granted: Boolean) {
      instance?.handleMediaPermissionResult(granted)
    }
  }

  /** 在途的目录选择请求（同时只允许一个） */
  private var pendingPick: Promise? = null

  /** 在途的图片选择请求（同时只允许一个） */
  private var pendingPickImage: Promise? = null

  /** 在途的权限请求（音频运行时权限 -> 所有文件访问设置页，串联返回最终状态） */
  private var pendingPermissionPromise: Promise? = null

  /** 原生下载任务表：token（JS 侧任务 id）-> 取消标志与连接（供暂停/取消） */
  private class DownloadJob {
    @Volatile var cancelled = false
    @Volatile var connection: HttpURLConnection? = null
  }

  private val downloadJobs = ConcurrentHashMap<String, DownloadJob>()

  private class CancelledException : Exception()

  // 必须在 init 块之前声明：Kotlin 按声明顺序初始化属性，
  // 若在 init 中引用尚未初始化的属性会拿到 null，导致回调监听注册失败
  private val activityEventListener = object : BaseActivityEventListener() {
    override fun onActivityResult(
      activity: Activity?,
      requestCode: Int,
      resultCode: Int,
      data: Intent?
    ) {
      if (requestCode == PICK_DIR_REQUEST) {
        val promise = pendingPick
        pendingPick = null
        if (promise == null) return
        if (resultCode == Activity.RESULT_OK && data?.data != null) {
          try {
            val uri = data.data!!
            // 持久化授权：重启后仍可读写该目录，无需再次选择
            reactContext.contentResolver.takePersistableUriPermission(
              uri,
              Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            )
            val map: WritableMap = Arguments.createMap()
            map.putString("uri", uri.toString())
            map.putString("name", docDisplayName(uri) ?: uri.lastPathSegment ?: uri.toString())
            promise.resolve(map)
          } catch (e: Exception) {
            promise.reject("E_PICK_DIR", e)
          }
        } else {
          // 用户取消选择：resolve null，JS 端静默处理
          promise.resolve(null)
        }
        return
      }
      if (requestCode == PICK_IMAGE_REQUEST) {
        val promise = pendingPickImage
        pendingPickImage = null
        if (promise == null) return
        if (resultCode == Activity.RESULT_OK && data?.data != null) {
          try {
            val uri = data.data!!
            val map: WritableMap = Arguments.createMap()
            map.putString("uri", uri.toString())
            map.putString("name", imageDisplayName(uri) ?: "image")
            map.putDouble("size", imageSize(uri).toDouble())
            promise.resolve(map)
          } catch (e: Exception) {
            promise.reject("E_PICK_IMAGE", e)
          }
        } else {
          // 用户取消选择：resolve null，JS 端静默处理
          promise.resolve(null)
        }
        return
      }
      // 「所有文件访问」设置页返回（无论用户是否开启，都按当前状态结算）
      if (requestCode == REQUEST_ALL_FILES) {
        resolvePermissionResult()
        return
      }
    }
  }

  init {
    instance = this
    reactContext.addActivityEventListener(activityEventListener)
  }

  /** 弹出系统目录选择器（SAF），选择即授予该目录的读写权限，返回 {uri, name} */
  @ReactMethod
  fun pickDir(promise: Promise) {
    val activity = reactContext.currentActivity
    if (activity == null) {
      promise.reject("E_PICK_DIR_NO_ACTIVITY", "Activity not available")
      return
    }
    pendingPick = promise
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
      addFlags(
        Intent.FLAG_GRANT_READ_URI_PERMISSION or
          Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
          Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
          Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
      )
    }
    try {
      activity.startActivityForResult(intent, PICK_DIR_REQUEST)
    } catch (e: Exception) {
      pendingPick = null
      promise.reject("E_PICK_DIR", e)
    }
  }

  /** 查询 tree URI 的目录显示名（SAF 授权目录） */
  private fun docDisplayName(uri: Uri): String? {
    return try {
      val docId = DocumentsContract.getTreeDocumentId(uri)
      val docUri = DocumentsContract.buildDocumentUriUsingTree(uri, docId)
      reactContext.contentResolver.query(
        docUri,
        arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME),
        null,
        null,
        null
      )?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
    } catch (e: Exception) {
      null
    }
  }

  /** 查询图片文件显示名 */
  private fun imageDisplayName(uri: Uri): String? {
    return try {
      reactContext.contentResolver.query(
        uri,
        arrayOf(android.provider.OpenableColumns.DISPLAY_NAME),
        null,
        null,
        null
      )?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
    } catch (e: Exception) {
      null
    }
  }

  /** 查询图片文件体积（字节），查询失败返回 -1 */
  private fun imageSize(uri: Uri): Long {
    return try {
      reactContext.contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length } ?: -1L
    } catch (e: Exception) {
      -1L
    }
  }

  /**
   * 弹出系统图片选择器（SAF，无需存储权限），返回 {uri, name, size}；
   * 用户取消时 resolve null（JS 端静默处理）。
   */
  @ReactMethod
  fun pickImage(promise: Promise) {
    val activity = reactContext.currentActivity
    if (activity == null) {
      promise.reject("E_PICK_IMAGE_NO_ACTIVITY", "Activity not available")
      return
    }
    pendingPickImage = promise
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = "image/*"
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    try {
      activity.startActivityForResult(intent, PICK_IMAGE_REQUEST)
    } catch (e: Exception) {
      pendingPickImage = null
      promise.reject("E_PICK_IMAGE", e)
    }
  }

  // ===== 存储/媒体权限（启动时申请，替代 SAF 逐个目录授权） =====

  /** 当前权限状态：audio（音频/媒体库读取）、allFiles（Android 11+ 所有文件访问） */
  private fun permissionStatus(): WritableMap {
    val map: WritableMap = Arguments.createMap()
    map.putInt("apiLevel", Build.VERSION.SDK_INT)
    map.putBoolean("audio", hasAudioPermission())
    map.putBoolean("allFiles", hasAllFilesAccess())
    return map
  }

  private fun hasAudioPermission(): Boolean {
    val perm = when {
      Build.VERSION.SDK_INT >= 33 -> Manifest.permission.READ_MEDIA_AUDIO
      Build.VERSION.SDK_INT >= 23 -> Manifest.permission.READ_EXTERNAL_STORAGE
      else -> return true
    }
    return reactContext.checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED
  }

  private fun hasAllFilesAccess(): Boolean {
    // Android 10 及以下无此概念，直接视为已授权
    return Build.VERSION.SDK_INT < 30 || Environment.isExternalStorageManager()
  }

  /** 查询当前权限状态（不弹窗），返回 {audio, allFiles, apiLevel} */
  @ReactMethod
  fun checkPermissions(promise: Promise) {
    promise.resolve(permissionStatus())
  }

  /**
   * 启动时申请「音频和歌曲」（运行时权限对话框）与「文档和文件」（Android 11+
   * 跳系统设置页开启所有文件访问）：音频已授权则直接进入文件权限环节，
   * 从设置页返回后 resolve 最终状态 {audio, allFiles, apiLevel}。
   */
  @ReactMethod
  fun requestPermissions(promise: Promise) {
    val activity = reactContext.currentActivity
    if (activity == null) {
      promise.reject("E_PERMISSION_NO_ACTIVITY", "Activity not available")
      return
    }
    pendingPermissionPromise = promise
    // 权限对话框与设置页跳转都必须在主线程发起
    com.facebook.react.bridge.UiThreadUtil.runOnUiThread {
      val perm = when {
        Build.VERSION.SDK_INT >= 33 -> Manifest.permission.READ_MEDIA_AUDIO
        Build.VERSION.SDK_INT >= 23 -> Manifest.permission.READ_EXTERNAL_STORAGE
        else -> null
      }
      if (perm == null || hasAudioPermission()) {
        requestAllFilesAccess(activity)
      } else {
        activity.requestPermissions(arrayOf(perm), MEDIA_PERMISSION_REQUEST)
      }
    }
  }

  /** MainActivity 权限结果转发：无论授权与否都继续「所有文件访问」环节（或直接结算） */
  private fun handleMediaPermissionResult(granted: Boolean) {
    val activity = reactContext.currentActivity
    if (activity != null) {
      requestAllFilesAccess(activity)
    } else {
      resolvePermissionResult()
    }
  }

  /** Android 11+ 未开启所有文件访问时跳系统设置页；否则直接结算 */
  private fun requestAllFilesAccess(activity: Activity) {
    if (Build.VERSION.SDK_INT >= 30 && !Environment.isExternalStorageManager()) {
      try {
        activity.startActivityForResult(
          Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION)
            .apply { data = Uri.parse("package:" + reactContext.packageName) },
          REQUEST_ALL_FILES
        )
        return
      } catch (e: Exception) {
        // 部分 ROM 不支持应用级跳转，尝试通用「所有文件访问」列表页
        try {
          activity.startActivityForResult(
            Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION),
            REQUEST_ALL_FILES
          )
          return
        } catch (e2: Exception) {
        }
      }
    }
    resolvePermissionResult()
  }

  private fun resolvePermissionResult() {
    val promise = pendingPermissionPromise
    pendingPermissionPromise = null
    promise?.resolve(permissionStatus())
  }

  /**
   * 把所选图片（content://）流式复制到应用私有目录（RNFS 无法读 content URI），
   * 返回成功为 null；失败 reject 且不留半截文件。
   */
  @ReactMethod
  fun copyImageToApp(srcUri: String, destPath: String, promise: Promise) {
    Thread(Runnable {
      try {
        val input = reactContext.contentResolver.openInputStream(Uri.parse(srcUri))
          ?: throw Exception("无法读取所选图片")
        val dest = File(destPath)
        val out = java.io.FileOutputStream(dest)
        input.use { i -> out.use { o -> i.copyTo(o, 64 * 1024) } }
        promise.resolve(null)
      } catch (e: Exception) {
        // 清理半截文件
        try {
          File(destPath).delete()
        } catch (ignore: Exception) {
        }
        promise.reject("E_COPY_IMAGE", e)
      }
    }, "saf-copy-image").start()
  }

  /**
   * 原生流式下载到 SAF 授权目录：ContentResolver 直写（RNFS 无法写 content:// URI），
   * 进度按百分比经 LocalMusic.DownloadProgress 事件上报（token/bytesWritten/contentLength）。
   * 成功 resolve {fileUri, folderUri}；取消时 reject E_DOWNLOAD_CANCELLED（JS 端按暂停/取消处理）。
   */
  @ReactMethod
  fun startDownload(token: String, url: String, treeUri: String, fileName: String, promise: Promise) {
    Thread(Runnable {
      val job = DownloadJob()
      downloadJobs[token] = job
      var created: Uri? = null
      try {
        val resolver: ContentResolver = reactContext.contentResolver
        val rootTree = Uri.parse(treeUri)
        // createDocument 需要的是"目录 document uri"而不是 tree uri；
        // 部分 ROM/Android 版本传 tree uri 会直接报 Invalid URI / content://... 错误。
        val parentDoc = DocumentsContract.buildDocumentUriUsingTree(
          rootTree,
          DocumentsContract.getTreeDocumentId(rootTree)
        )
        // 同名文件先删（重复下载覆盖旧文件）
        findDoc(resolver, rootTree, fileName)?.let {
          DocumentsContract.deleteDocument(resolver, it)
        }
        created = DocumentsContract.createDocument(resolver, parentDoc, "audio/*", fileName)
          ?: throw Exception("无法在授权目录创建文件")
        val conn = URL(url).openConnection() as HttpURLConnection
        job.connection = conn
        conn.requestMethod = "GET"
        // 腾讯 CDN 部分节点会拒绝无 UA 的请求（403），与 JS 侧 IMAGE_HEADERS 一致
        conn.setRequestProperty(
          "User-Agent",
          "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36"
        )
        conn.setRequestProperty("Referer", "https://y.qq.com/")
        conn.connectTimeout = 15000
        conn.readTimeout = 30000
        conn.instanceFollowRedirects = true
        val code = conn.responseCode
        if (code < 200 || code >= 300) {
          throw Exception("下载失败: $code")
        }
        val total = conn.contentLength.toLong()
        var written = 0L
        var lastPct = -1
        resolver.openOutputStream(created!!, "w")?.use { out ->
          conn.inputStream.use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
              if (job.cancelled) {
                throw CancelledException()
              }
              val n = input.read(buf)
              if (n < 0) break
              out.write(buf, 0, n)
              written += n
              val pct = if (total > 0) (written * 100 / total).toInt() else -1
              if (pct != lastPct) {
                lastPct = pct
                emitProgress(token, written, total)
              }
            }
          }
        }
        downloadJobs.remove(token)
        val ret: WritableMap = Arguments.createMap()
        ret.putString("fileUri", created!!.toString())
        ret.putString("folderUri", rootTree.toString())
        promise.resolve(ret)
      } catch (e: Exception) {
        downloadJobs.remove(token)
        // 清理半成品文件
        try {
          created?.let { DocumentsContract.deleteDocument(reactContext.contentResolver, it) }
        } catch (ignore: Exception) {
        }
        if (job.cancelled) {
          promise.reject("E_DOWNLOAD_CANCELLED", "cancelled")
        } else {
          promise.reject("E_DOWNLOAD", e.message ?: "下载失败")
        }
      }
    }, "saf-download").start()
  }

  /** 取消原生下载任务：断开连接使读取中断，随后清理半成品文件 */
  @ReactMethod
  fun cancelDownload(token: String) {
    val job = downloadJobs[token] ?: return
    job.cancelled = true
    try {
      job.connection?.disconnect()
    } catch (e: Exception) {
    }
  }

  /** 删除 SAF 授权目录中的文件（content:// document uri），失败时 reject */
  /** 校验 SAF content:// 文件是否仍存在，供离线播放自动跳过失效歌曲。 */
  @ReactMethod
  fun fileExists(uri: String, promise: Promise) {
    try {
      val parsed = Uri.parse(uri)
      reactContext.contentResolver.openAssetFileDescriptor(parsed, "r")?.use { }
      promise.resolve(true)
    } catch (e: Exception) {
      promise.resolve(false)
    }
  }
  @ReactMethod
  fun deleteFile(uri: String, promise: Promise) {
    try {
      val parsed = Uri.parse(uri)
      // 防御：只允许删除单个文件（document uri），拒绝 tree uri（防止误删整个授权目录）
      if (!isDocumentUri(parsed) || isTreeOnlyUri(parsed)) {
        promise.reject("E_DELETE_FILE", "仅支持删除单个文件")
        return
      }
      val ok = DocumentsContract.deleteDocument(reactContext.contentResolver, parsed)
      if (ok) {
        promise.resolve(null)
      } else {
        promise.reject("E_DELETE_FILE", "删除失败")
      }
    } catch (e: Exception) {
      promise.reject("E_DELETE_FILE", e)
    }
  }

  /** 在 SAF 授权目录中写入/覆盖文本文件，返回 document uri。 */
  @ReactMethod
  fun writeTextFile(treeUri: String, fileName: String, mimeType: String, content: String, promise: Promise) {
    Thread(Runnable {
      try {
        val resolver = reactContext.contentResolver
        val target = upsertDocument(resolver, Uri.parse(treeUri), fileName, mimeType)
        resolver.openOutputStream(target, "wt")?.use { out ->
          out.write(content.toByteArray(Charsets.UTF_8))
        } ?: throw Exception("无法写入文件")
        promise.resolve(target.toString())
      } catch (e: Exception) {
        promise.reject("E_WRITE_TEXT_FILE", e)
      }
    }, "saf-write-text").start()
  }

  /** 在 SAF 授权目录中下载/覆盖附件文件，返回 document uri。 */
  @ReactMethod
  fun downloadFile(treeUri: String, url: String, fileName: String, mimeType: String, promise: Promise) {
    Thread(Runnable {
      var created: Uri? = null
      try {
        val resolver = reactContext.contentResolver
        val parsedTree = Uri.parse(treeUri)
        created = upsertDocument(resolver, parsedTree, fileName, mimeType)
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.requestMethod = "GET"
        conn.setRequestProperty(
          "User-Agent",
          "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36"
        )
        conn.setRequestProperty("Referer", "https://y.qq.com/")
        conn.connectTimeout = 15000
        conn.readTimeout = 30000
        conn.instanceFollowRedirects = true
        val code = conn.responseCode
        if (code < 200 || code >= 300) {
          throw Exception("下载失败: $code")
        }
        resolver.openOutputStream(created, "w")?.use { out ->
          conn.inputStream.use { input ->
            input.copyTo(out, 64 * 1024)
          }
        } ?: throw Exception("无法写入文件")
        promise.resolve(created.toString())
      } catch (e: Exception) {
        try {
          created?.let { DocumentsContract.deleteDocument(reactContext.contentResolver, it) }
        } catch (ignore: Exception) {
        }
        promise.reject("E_DOWNLOAD_FILE", e)
      }
    }, "saf-download-file").start()
  }

  /** 查找与指定音频同目录、同名的兄弟文件，找到返回 document uri，找不到返回 null。 */
  @ReactMethod
  fun findSiblingFile(fileUri: String, fileName: String, promise: Promise) {
    try {
      promise.resolve(findSiblingDoc(Uri.parse(fileUri), fileName)?.toString())
    } catch (e: Exception) {
      promise.reject("E_FIND_SIBLING_FILE", e)
    }
  }

  /** 读取 SAF document uri 文本文件内容。 */
  @ReactMethod
  fun readTextFile(uri: String, promise: Promise) {
    Thread(Runnable {
      try {
        val parsed = Uri.parse(uri)
        val text = reactContext.contentResolver.openInputStream(parsed)?.use { input ->
          InputStreamReader(input, Charsets.UTF_8).readText()
        } ?: throw Exception("无法读取文件")
        promise.resolve(text)
      } catch (e: Exception) {
        promise.reject("E_READ_TEXT_FILE", e)
      }
    }, "saf-read-text").start()
  }

  /**
   * 检查同目录中是否仍有其他音频文件共享同一附件基础名（忽略音质标签）；
   * 用于删除一首歌时避免误删其他音质共用的歌词/封面/元数据。
   */
  @ReactMethod
  fun hasSiblingAudioWithBase(fileUri: String, baseName: String, promise: Promise) {
    try {
      val parsed = Uri.parse(fileUri)
      val ctx = parentContext(parsed) ?: run {
        promise.resolve(false)
        return
      }
      val currentName = displayName(parsed)
      val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(ctx.treeUri, ctx.parentId)
      var found = false
      reactContext.contentResolver.query(
        childrenUri,
        arrayOf(
          DocumentsContract.Document.COLUMN_DISPLAY_NAME,
          DocumentsContract.Document.COLUMN_MIME_TYPE
        ),
        null,
        null,
        null
      )?.use { c ->
        val nameIdx = c.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
        val mimeIdx = c.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE)
        while (c.moveToNext()) {
          val name = c.getString(nameIdx) ?: continue
          val mime = c.getString(mimeIdx) ?: ""
          if (name == currentName || DocumentsContract.Document.MIME_TYPE_DIR == mime) {
            continue
          }
          if (isAudioName(name) && audioBaseName(name) == baseName) {
            found = true
            break
          }
        }
      }
      promise.resolve(found)
    } catch (e: Exception) {
      promise.reject("E_HAS_SIBLING_AUDIO", e)
    }
  }

  /** 删除与指定音频同目录的某个兄弟文件；文件不存在时返回 false。 */
  @ReactMethod
  fun deleteSiblingFile(fileUri: String, fileName: String, promise: Promise) {
    try {
      val target = findSiblingDoc(Uri.parse(fileUri), fileName)
      if (target == null) {
        promise.resolve(false)
        return
      }
      val ok = DocumentsContract.deleteDocument(reactContext.contentResolver, target)
      promise.resolve(ok)
    } catch (e: Exception) {
      promise.reject("E_DELETE_SIBLING_FILE", e)
    }
  }

  private fun emitProgress(token: String, written: Long, total: Long) {
    val params: WritableMap = Arguments.createMap()
    params.putString("token", token)
    params.putDouble("written", written.toDouble())
    params.putDouble("total", total.toDouble())
    reactContext.emitDeviceEvent("LocalMusic.DownloadProgress", params)
  }

  /** 兼容 raw document uri 与 buildDocumentUriUsingTree 返回的 tree/document uri。 */
  private fun isDocumentUri(uri: Uri): Boolean {
    return try {
      DocumentsContract.isDocumentUri(reactContext, uri) && uri.pathSegments.contains("document")
    } catch (e: Exception) {
      false
    }
  }

  /** 仅目录授权本身（tree uri），不包含具体 document 节点。 */
  private fun isTreeOnlyUri(uri: Uri): Boolean {
    return try {
      DocumentsContract.isTreeUri(uri) && !uri.pathSegments.contains("document")
    } catch (e: Exception) {
      false
    }
  }

  /** 在授权目录中按显示名查找文件（返回 document uri，未找到返回 null） */
  private fun findDoc(resolver: ContentResolver, treeUri: Uri, name: String): Uri? {
    val treeDocId = DocumentsContract.getTreeDocumentId(treeUri)
    val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, treeDocId)
    var found: Uri? = null
    resolver.query(
      childrenUri,
      arrayOf(
        DocumentsContract.Document.COLUMN_DOCUMENT_ID,
        DocumentsContract.Document.COLUMN_DISPLAY_NAME
      ),
      null,
      null,
      null
    )?.use { c ->
      val idIdx = c.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
      val nameIdx = c.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
      while (c.moveToNext()) {
        if (c.getString(nameIdx) == name) {
          val id = c.getString(idIdx) ?: continue
          found = DocumentsContract.buildDocumentUriUsingTree(treeUri, id)
          break
        }
      }
    }
    return found
  }

  private data class ParentContext(
    val treeUri: Uri,
    val parentId: String
  )

  private fun parentContext(fileUri: Uri): ParentContext? {
    if (!isDocumentUri(fileUri)) {
      return null
    }
    return try {
      val docId = DocumentsContract.getDocumentId(fileUri)
      val parentId = docId.substringBeforeLast('/', "")
      if (parentId.isEmpty()) {
        null
      } else {
        val treeDocId = try {
          DocumentsContract.getTreeDocumentId(fileUri)
        } catch (e: Exception) {
          parentId
        }
        val treeUri = DocumentsContract.buildTreeDocumentUri(fileUri.authority, treeDocId)
        ParentContext(treeUri, parentId)
      }
    } catch (e: Exception) {
      null
    }
  }

  private fun findSiblingDoc(fileUri: Uri, fileName: String): Uri? {
    val ctx = parentContext(fileUri) ?: return null
    val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(ctx.treeUri, ctx.parentId)
    var exact: Uri? = null
    var prefix: Uri? = null
    reactContext.contentResolver.query(
      childrenUri,
      arrayOf(
        DocumentsContract.Document.COLUMN_DOCUMENT_ID,
        DocumentsContract.Document.COLUMN_DISPLAY_NAME
      ),
      null,
      null,
      null
    )?.use { c ->
      val idIdx = c.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
      val nameIdx = c.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
      while (c.moveToNext()) {
        val name = c.getString(nameIdx) ?: continue
        if (name == fileName) {
          val id = c.getString(idIdx) ?: continue
          exact = DocumentsContract.buildDocumentUriUsingTree(ctx.treeUri, id)
          break // 精确匹配最优，立即返回
        }
        // 模糊回退：部分 OEM 的 SAF Provider 会对 text/plain 等 MIME 自动追加
        // 扩展名（如 song.lrc → song.lrc.txt），此处按 "fileName." 前缀兜底匹配
        if (prefix == null && name.startsWith("$fileName.")) {
          val id = c.getString(idIdx) ?: continue
          prefix = DocumentsContract.buildDocumentUriUsingTree(ctx.treeUri, id)
        }
      }
    }
    return exact ?: prefix
  }

  private fun upsertDocument(
    resolver: ContentResolver,
    treeUri: Uri,
    fileName: String,
    mimeType: String
  ): Uri {
    val parentDoc = DocumentsContract.buildDocumentUriUsingTree(
      treeUri,
      DocumentsContract.getTreeDocumentId(treeUri)
    )
    findDoc(resolver, treeUri, fileName)?.let {
      DocumentsContract.deleteDocument(resolver, it)
    }
    return DocumentsContract.createDocument(resolver, parentDoc, mimeType, fileName)
      ?: throw Exception("无法在授权目录创建文件")
  }

  private fun displayName(uri: Uri): String? {
    return try {
      reactContext.contentResolver.query(
        uri,
        arrayOf(OpenableColumns.DISPLAY_NAME),
        null,
        null,
        null
      )?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
    } catch (e: Exception) {
      null
    }
  }

  /**
   * 递归列出授权目录下的音频文件，返回 [{uri, name, path}]；
   * path 为主存储上的真实路径（用于与 MediaStore 结果去重），无法解析时为空串
   */
  @ReactMethod
  fun listDirAudio(treeUri: String, depth: Int, promise: Promise) {
    Thread(Runnable {
      try {
        val uri = Uri.parse(treeUri)
        val list: WritableArray = Arguments.createArray()
        collectAudio(
          reactContext.contentResolver,
          uri,
          DocumentsContract.getTreeDocumentId(uri),
          depth,
          list
        )
        promise.resolve(list)
      } catch (e: Exception) {
        promise.reject("E_LIST_DIR", e)
      }
    }, "saf-list-audio").start()
  }

  private fun collectAudio(
    resolver: ContentResolver,
    treeUri: Uri,
    docId: String,
    depth: Int,
    out: WritableArray
  ) {
    val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, docId)
    val projection = arrayOf(
      DocumentsContract.Document.COLUMN_DOCUMENT_ID,
      DocumentsContract.Document.COLUMN_DISPLAY_NAME,
      DocumentsContract.Document.COLUMN_MIME_TYPE
    )
    resolver.query(childrenUri, projection, null, null, null)?.use { c ->
      val idIdx = c.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
      val nameIdx = c.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
      val mimeIdx = c.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE)
      while (c.moveToNext()) {
        val id = c.getString(idIdx) ?: continue
        val name = c.getString(nameIdx) ?: continue
        val mime = c.getString(mimeIdx) ?: ""
        if (DocumentsContract.Document.MIME_TYPE_DIR == mime) {
          if (depth > 0) {
            collectAudio(resolver, treeUri, id, depth - 1, out)
          }
        } else if (isAudioName(name)) {
          val docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, id)
          val map: WritableMap = Arguments.createMap()
          map.putString("uri", docUri.toString())
          map.putString("name", name)
          map.putString("path", docToPath(docUri) ?: "")
          out.pushMap(map)
        }
      }
    }
  }

  /** 解析主存储 document uri 的真实路径（primary:Music/a.mp3 -> /storage/emulated/0/Music/a.mp3） */
  private fun docToPath(docUri: Uri): String? {
    return try {
      val docId = DocumentsContract.getDocumentId(docUri)
      if (docId.startsWith("primary:")) {
        "/storage/emulated/0/" + docId.removePrefix("primary:")
      } else {
        null
      }
    } catch (e: Exception) {
      null
    }
  }

  private val AUDIO_EXT = setOf("mp3", "flac", "m4a", "wav", "aac", "ogg", "wma")
  private val QUALITY_TAG_RE =
    Regex("\\s*\\[(标准|HQ 高品质|SQ 无损|臻品音质|臻品全景声|臻品母带)\\]$")

  private fun isAudioName(name: String): Boolean {
    val ext = name.substringAfterLast('.', "").lowercase()
    return ext in AUDIO_EXT
  }

  private fun audioBaseName(name: String): String {
    val noExt = name.substringBeforeLast('.', name)
    return QUALITY_TAG_RE.replace(noExt, "")
  }
}
