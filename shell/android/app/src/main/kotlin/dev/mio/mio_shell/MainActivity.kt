package dev.mio.mio_shell

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.ContentValues
import android.content.Intent
import android.graphics.Color
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Environment
import android.os.Build
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Base64
import android.window.OnBackInvokedDispatcher
import android.view.View
import android.view.WindowManager
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

class MainActivity : FlutterActivity() {
    private val executor = Executors.newSingleThreadExecutor()
    private lateinit var channel: MethodChannel

    private var pendingPick: MethodChannel.Result? = null
    private var pendingPickDestination: String? = null
    private var pendingPickMultiple: Boolean = false

    private var pendingNotification: Triple<String, String, Int>? = null
    private var pendingStorage: MethodChannel.Result? = null
    private var pendingStorageType: String = "images"

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        channel = MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            "mio/runtime",
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(
                OnBackInvokedDispatcher.PRIORITY_DEFAULT,
            ) { handleBack() }
        }

        channel.setMethodCallHandler { call, result ->
            when (call.method) {
                "getLaunchConfig" -> {
                    val config = mutableMapOf<String, Any?>(
                        "devUrl" to intent?.getStringExtra("mio.devUrl"),
                        "appId" to intent?.getStringExtra("mio.appId"),
                        "appName" to intent?.getStringExtra("mio.appName"),
                        "appVersion" to intent?.getStringExtra("mio.appVersion"),
                        "windowWidth" to intent?.getIntExtra("mio.windowWidth", 0),
                        "windowHeight" to intent?.getIntExtra("mio.windowHeight", 0),
                    )
                    intent?.getStringExtra("mio.appConfig")?.let { encoded ->
                        try {
                            val json = JSONObject(
                                String(Base64.decode(encoded, Base64.NO_WRAP), Charsets.UTF_8),
                            )
                            config["appId"] = json.optString("id", null)
                            config["appName"] = json.optString("name", null)
                            config["appVersion"] = json.optString("version", null)
                            config["windowWidth"] = json.optInt("width", 0)
                            config["windowHeight"] = json.optInt("height", 0)
                        } catch (_: Exception) {
                            // Keep the individual extras as a fallback.
                        }
                    }
                    result.success(config)
                }

                "copyAsset" -> {
                    val asset = call.argument<String>("asset")
                    val dest = call.argument<String>("dest")
                    if (asset == null || dest == null) {
                        result.error("bad_args", "asset and dest are required", null)
                        return@setMethodCallHandler
                    }
                    executor.execute {
                        try {
                            val output = File(dest)
                            output.parentFile?.mkdirs()
                            assets.open(asset).use { input ->
                                output.outputStream().use { stream ->
                                    input.copyTo(stream, 64 * 1024)
                                }
                            }
                            runOnUiThread { result.success(dest) }
                        } catch (error: Exception) {
                            runOnUiThread {
                                result.error("asset_copy_failed", error.message, null)
                            }
                        }
                    }
                }

                "setKeepScreenOn" -> {
                    val enabled = call.argument<Boolean>("enabled") ?: false
                    runOnUiThread {
                        if (enabled) {
                            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                        } else {
                            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                        }
                    }
                    result.success(null)
                }

                "setOrientation" -> {
                    val value = when (call.argument<String>("mode")) {
                        "portrait" -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                        "landscape" -> ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
                        else -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                    }
                    runOnUiThread { requestedOrientation = value }
                    result.success(null)
                }

                "notify.send" -> {
                    val title = call.argument<String>("title") ?: "Mio"
                    val body = call.argument<String>("body") ?: ""
                    val id = call.argument<Int>("id") ?: 4001
                    val needsPermission = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                        checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
                        PackageManager.PERMISSION_GRANTED
                    if (needsPermission) {
                        // Ask, then post from the permission callback. Returning
                        // immediately keeps the bridge call from waiting on a
                        // system dialog the user may ignore.
                        pendingNotification = Triple(title, body, id)
                        requestPermissions(
                            arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                            REQUEST_NOTIFY,
                        )
                        result.success(mapOf("id" to id, "requested" to true))
                    } else {
                        postNotification(title, body, id)
                        result.success(mapOf("id" to id))
                    }
                }

                "media.pickImage" -> {
                    startImagePicker(call, result, max = 1)
                }

                "media.pickImages" -> {
                    startImagePicker(call, result, max = call.argument<Int>("max") ?: 0)
                }

                "notify.progress" -> {
                    val id = call.argument<Int>("id") ?: 4002
                    val title = call.argument<String>("title") ?: "Mio"
                    val text = call.argument<String>("text") ?: ""
                    val progress = call.argument<Int>("progress") ?: 0
                    val max = call.argument<Int>("max") ?: 100
                    postProgress(id, title, text, progress, max)
                    result.success(mapOf("id" to id, "progress" to progress))
                }

                "notify.cancel" -> {
                    val id = call.argument<Int>("id") ?: 4001
                    (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).cancel(id)
                    result.success(null)
                }

                "setSystemBars" -> {
                    val statusColor = call.argument<String>("statusBarColor")
                    val navColor = call.argument<String>("navigationBarColor")
                    val statusIcons = call.argument<String>("statusBarIcons")
                    val navIcons = call.argument<String>("navigationBarIcons")
                    runOnUiThread {
                        try {
                            // Android 15+ enforces edge-to-edge and ignores the
                            // bar colors; go edge-to-edge and let Flutter paint
                            // the area behind the status bar.
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                                window.setDecorFitsSystemWindows(false)
                            }
                            @Suppress("DEPRECATION")
                            window.statusBarColor = Color.TRANSPARENT
                            @Suppress("DEPRECATION")
                            window.navigationBarColor = navColor?.let { Color.parseColor(it) } ?: Color.TRANSPARENT
                            @Suppress("DEPRECATION")
                            var flags = window.decorView.systemUiVisibility
                            if (statusIcons != null) {
                                flags = if (statusIcons == "light") {
                                    flags or View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                                } else {
                                    flags and View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR.inv()
                                }
                            }
                            if (navIcons != null) {
                                flags = if (navIcons == "light") {
                                    flags or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
                                } else {
                                    flags and View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR.inv()
                                }
                            }
                            window.decorView.systemUiVisibility = flags
                            result.success(null)
                        } catch (error: Exception) {
                            result.error("system_bars_failed", error.message, null)
                        }
                    }
                }

                "foreground.start" -> {
                    val title = call.argument<String>("title") ?: "Mio"
                    val text = call.argument<String>("text") ?: "Running"
                    try {
                        MioForegroundService.running = true
                        MioForegroundService.start(this, title, text)
                        result.success(mapOf("running" to true))
                    } catch (error: Exception) {
                        MioForegroundService.running = false
                        result.error("foreground_failed", error.message, null)
                    }
                }

                "foreground.stop" -> {
                    MioForegroundService.stop(this)
                    MioForegroundService.running = false
                    result.success(mapOf("running" to false))
                }

                "foreground.isRunning" -> {
                    result.success(mapOf("running" to MioForegroundService.isRunning(this)))
                }

                "storage.status" -> result.success(storageStatus())

                "storage.request" -> requestStorage(call, result)

                "media.saveImage" -> saveImageToGallery(call, result)

                else -> result.notImplemented()
            }
        }

    }

    /// Back is decided in Dart (page handler, history, double-press exit);
    /// native only finishes the activity when Dart reports it is not handled.
    private fun handleBack() {
        channel.invokeMethod("backPressed", null, object : MethodChannel.Result {
            override fun success(result: Any?) {
                if (result != true) finish()
            }

            override fun error(code: String, message: String?, details: Any?) {
                finish()
            }

            override fun notImplemented() {
                finish()
            }
        })
    }

    // Android 15+ uses predictive back and never calls onBackPressed().
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        handleBack()
    }


    private fun storagePermissions(type: String): Array<String> {
        return when {
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU ->
                if (type == "video") arrayOf(Manifest.permission.READ_MEDIA_VIDEO)
                else arrayOf(Manifest.permission.READ_MEDIA_IMAGES)
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ->
                arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
            else -> arrayOf(
                Manifest.permission.READ_EXTERNAL_STORAGE,
                Manifest.permission.WRITE_EXTERNAL_STORAGE,
            )
        }
    }

    private fun storageStatus(): Map<String, Any?> {
        val permissions = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            arrayOf(Manifest.permission.READ_MEDIA_IMAGES)
        } else {
            arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
        val granted = permissions.all {
            checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED
        }
        return mapOf(
            "granted" to granted,
            "scoped" to (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q),
        )
    }

    private fun requestStorage(call: MethodCall, result: MethodChannel.Result) {
        val type = call.argument<String>("type") ?: "images"
        val missing = storagePermissions(type).filter {
            checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) {
            result.success(storageStatus())
            return
        }
        pendingStorage = result
        pendingStorageType = type
        requestPermissions(missing.toTypedArray(), REQUEST_STORAGE)
    }

    private fun saveImageToGallery(call: MethodCall, result: MethodChannel.Result) {
        val source = call.argument<String>("path")
        if (source == null) {
            result.error("bad_args", "path is required", null)
            return
        }
        val album = (call.argument<String>("album") ?: "Mio")
            .replace(Regex("[^A-Za-z0-9._ -]"), "_")
        executor.execute {
            try {
                val file = File(source)
                if (!file.exists()) throw IllegalArgumentException("file not found: $source")
                val name = "${System.currentTimeMillis()}-" +
                    file.name.replace(Regex("[^A-Za-z0-9._-]"), "_")

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val values = ContentValues().apply {
                        put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                        put(MediaStore.MediaColumns.MIME_TYPE, "image/png")
                        put(MediaStore.MediaColumns.RELATIVE_PATH, "Pictures/$album")
                        put(MediaStore.MediaColumns.IS_PENDING, 1)
                    }
                    val uri = contentResolver.insert(
                        MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                        values,
                    ) ?: throw IllegalStateException("MediaStore refused the insert")
                    contentResolver.openOutputStream(uri)?.use { output ->
                        file.inputStream().use { input -> input.copyTo(output) }
                    } ?: throw IllegalStateException("cannot open $uri")
                    values.clear()
                    values.put(MediaStore.MediaColumns.IS_PENDING, 0)
                    contentResolver.update(uri, values, null, null)
                    runOnUiThread {
                        result.success(
                            mapOf("uri" to uri.toString(), "name" to name, "album" to album),
                        )
                    }
                } else {
                    if (checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) !=
                        PackageManager.PERMISSION_GRANTED
                    ) {
                        runOnUiThread {
                            result.error(
                                "storage_denied",
                                "WRITE_EXTERNAL_STORAGE is not granted",
                                null,
                            )
                        }
                        return@execute
                    }
                    val directory = File(
                        Environment.getExternalStoragePublicDirectory(
                            Environment.DIRECTORY_PICTURES,
                        ),
                        album,
                    )
                    directory.mkdirs()
                    val target = File(directory, name)
                    file.inputStream().use { input ->
                        target.outputStream().use { output -> input.copyTo(output) }
                    }
                    MediaScannerConnection.scanFile(this, arrayOf(target.absolutePath), null, null)
                    runOnUiThread {
                        result.success(
                            mapOf(
                                "uri" to target.toURI().toString(),
                                "name" to name,
                                "album" to album,
                                "path" to target.absolutePath,
                            ),
                        )
                    }
                }
            } catch (error: Exception) {
                runOnUiThread { result.error("save_failed", error.message, null) }
            }
        }
    }

    private fun postNotification(title: String, body: String, id: Int) {
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel("mio", "Mio", NotificationManager.IMPORTANCE_DEFAULT),
            )
        }
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, "mio")
        } else {
            Notification.Builder(this)
        }
        val notification = builder
            .setContentTitle(title)
            .setContentText(body)
            .setSmallIcon(applicationInfo.icon)
            .setAutoCancel(true)
            .build()
        manager.notify(id, notification)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_STORAGE) {
            val pending = pendingStorage
            pendingStorage = null
            pendingStorageType = "images"
            pending?.success(storageStatus())
            return
        }
        if (requestCode != REQUEST_NOTIFY) return
        val pending = pendingNotification ?: return
        pendingNotification = null
        val granted = grantResults.isNotEmpty() &&
            grantResults[0] == PackageManager.PERMISSION_GRANTED
        if (granted) {
            postNotification(pending.first, pending.second, pending.third)
        }
    }

    private fun startImagePicker(call: MethodCall, result: MethodChannel.Result, max: Int) {
        val destination = (call.arguments as? Map<*, *>)?.get("destination") as? String
        if (destination == null) {
            result.error("bad_args", "destination is required", null)
            return
        }
        if (pendingPick != null) {
            result.error("pick_busy", "A picker is already open", null)
            return
        }
        pendingPick = result
        pendingPickDestination = destination
        pendingPickMultiple = max > 1
        try {
            val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                // The system photo picker: no storage permission, multi-select.
                Intent(MediaStore.ACTION_PICK_IMAGES).apply {
                    type = "image/*"
                    if (max > 1) {
                        putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, max)
                        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                    }
                }
            } else {
                Intent(Intent.ACTION_PICK).apply {
                    type = "image/*"
                    data = MediaStore.Images.Media.EXTERNAL_CONTENT_URI
                }
            }
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            startActivityForResult(intent, REQUEST_PICK_IMAGE)
        } catch (error: Exception) {
            pendingPick = null
            pendingPickDestination = null
            result.error("pick_failed", error.message, null)
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_PICK_IMAGE) return
        val pending = pendingPick
        val destination = pendingPickDestination
        val multiple = pendingPickMultiple
        pendingPick = null
        pendingPickDestination = null
        pendingPickMultiple = false
        if (pending == null || destination == null) return
        if (resultCode != RESULT_OK || data == null) {
            pending.success(if (multiple) emptyList<Any>() else null)
            return
        }

        val uris = mutableListOf<Uri>()
        data.clipData?.let { clip ->
            for (index in 0 until clip.itemCount) {
                clip.getItemAt(index)?.uri?.let { uris.add(it) }
            }
        }
        data.data?.let { uris.add(it) }

        executor.execute {
            try {
                val picked = uris.map { copyPickedImage(it, destination) }
                runOnUiThread {
                    pending.success(if (multiple) picked else picked.firstOrNull())
                }
            } catch (error: Exception) {
                runOnUiThread { pending.error("pick_failed", error.message, null) }
            }
        }
    }

    private fun postProgress(id: Int, title: String, text: String, progress: Int, max: Int) {
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(
                    "mio.progress",
                    "Background progress",
                    NotificationManager.IMPORTANCE_LOW,
                ),
            )
        }
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, "mio.progress")
        } else {
            Notification.Builder(this)
        }
        manager.notify(
            id,
            builder
                .setContentTitle(title)
                .setContentText(text)
                .setSmallIcon(applicationInfo.icon)
                .setOngoing(true)
                .setProgress(max, progress, false)
                .build(),
        )
    }

    private fun copyPickedImage(uri: Uri, destination: String): Map<String, Any?> {
        val directory = File(destination)
        directory.mkdirs()

        var displayName = "image"
        var size = 0L
        contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (nameIndex >= 0) displayName = cursor.getString(nameIndex) ?: displayName
                val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (sizeIndex >= 0) size = cursor.getLong(sizeIndex)
            }
        }

        val safeName = displayName.replace(Regex("[^A-Za-z0-9._-]"), "_")
        val target = File(directory, System.currentTimeMillis().toString() + "-" + safeName)
        contentResolver.openInputStream(uri)?.use { input ->
            target.outputStream().use { output -> input.copyTo(output, 64 * 1024) }
        } ?: throw IllegalStateException("Cannot read the selected image")

        return mapOf(
            "path" to target.absolutePath,
            "name" to safeName,
            "mime" to (contentResolver.getType(uri) ?: "image/*"),
            "size" to target.length(),
        )
    }

    override fun onDestroy() {
        executor.shutdown()
        super.onDestroy()
    }

    companion object {
        private const val REQUEST_PICK_IMAGE = 7001
        private const val REQUEST_NOTIFY = 7002
        private const val REQUEST_STORAGE = 7003
    }
}
