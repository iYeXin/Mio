package dev.mio.mio_shell

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Base64
import android.view.WindowManager
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

class MainActivity : FlutterActivity() {
    private val executor = Executors.newSingleThreadExecutor()

    private var pendingPick: MethodChannel.Result? = null
    private var pendingPickDestination: String? = null

    private var pendingNotification: Triple<String, String, Int>? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            "mio/runtime",
        ).setMethodCallHandler { call, result ->
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
                    val destination = call.argument<String>("destination")
                    if (destination == null) {
                        result.error("bad_args", "destination is required", null)
                        return@setMethodCallHandler
                    }
                    if (pendingPick != null) {
                        result.error("pick_busy", "A picker is already open", null)
                        return@setMethodCallHandler
                    }
                    pendingPick = result
                    pendingPickDestination = destination
                    try {
                        val intent = Intent(Intent.ACTION_PICK).apply {
                            type = "image/*"
                            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        }
                        startActivityForResult(intent, REQUEST_PICK_IMAGE)
                    } catch (error: Exception) {
                        pendingPick = null
                        result.error("pick_failed", error.message, null)
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

                else -> result.notImplemented()
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
        if (requestCode != REQUEST_NOTIFY) return
        val pending = pendingNotification ?: return
        pendingNotification = null
        val granted = grantResults.isNotEmpty() &&
            grantResults[0] == PackageManager.PERMISSION_GRANTED
        if (granted) {
            postNotification(pending.first, pending.second, pending.third)
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_PICK_IMAGE) return
        val pending = pendingPick
        val destination = pendingPickDestination
        pendingPick = null
        pendingPickDestination = null
        if (pending == null) return
        if (resultCode != RESULT_OK || data?.data == null || destination == null) {
            pending.success(null)
            return
        }
        executor.execute {
            try {
                pending.success(copyPickedImage(data.data!!, destination))
            } catch (error: Exception) {
                runOnUiThread { pending.error("pick_failed", error.message, null) }
            }
        }
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
    }
}
