package dev.mio.mio_shell

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.UiModeManager
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
import android.view.WindowInsets
import android.view.WindowInsetsController
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

    private var insetsWatcherInstalled = false
    private var lastReportedBars: Map<String, Any?>? = null
    private var desiredStatusIcons: String? = null
    private var desiredNavigationIcons: String? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        channel = MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            "mio/runtime",
        )
        // The app fills the window; pages decide whether to respect safe areas
        // (the shell exposes insets via `platform.insets` and CSS variables).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility =
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        }
        @Suppress("DEPRECATION")
        window.statusBarColor = Color.TRANSPARENT
        @Suppress("DEPRECATION")
        window.navigationBarColor = Color.TRANSPARENT

        // Toggling decor-fits does not re-dispatch window insets on its own.
        // Without this request Flutter's viewPadding stays zero until some other
        // event (for example the IME) triggers an insets pass, which made
        // `platform.insets()` report zeros during startup.
        window.decorView.post { window.decorView.requestApplyInsets() }
        // Report bar visibility changes (the user can swipe a hidden bar back
        // in) to Dart, which forwards them as `app.systemBars`.
        window.decorView.post { installInsetsWatcher() }

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
                            // The CLI writes the archive hash next to the asset.
                            // Reuse the extracted copy only when it matches that
                            // hash; versionName is not enough because a rebuild
                            // can change the content without changing the version.
                            val expected = try {
                                assets.open("mio/app.asar.sha256").bufferedReader().use {
                                    it.readText().trim()
                                }
                            } catch (_: Exception) {
                                ""
                            }
                            val marker = File("$dest.sha256")
                            val cached = expected.isNotEmpty() &&
                                output.isFile &&
                                output.length() > 0 &&
                                runCatching { marker.readText().trim() }.getOrNull() == expected
                            if (!cached) {
                                output.parentFile?.mkdirs()
                                assets.open(asset).use { input ->
                                    output.outputStream().use { stream ->
                                        input.copyTo(stream, 64 * 1024)
                                    }
                                }
                                if (expected.isNotEmpty()) marker.writeText(expected)
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

                "applyTheme" -> {
                    val theme = call.argument<String>("theme") ?: "system"
                    result.success(mapOf("theme" to theme, "applied" to applyTheme(theme)))
                }

                "systemBars" -> result.success(systemBarsState())

                "setSystemBars" -> {
                    val statusMode = call.argument<String>("statusBar")
                    val navigationMode = call.argument<String>("navigationBar")
                    val statusIcons = call.argument<String>("statusBarIcons")
                    val navIcons = call.argument<String>("navigationBarIcons")
                    val statusColor = call.argument<String>("statusBarColor")
                    val navColor = call.argument<String>("navigationBarColor")
                    runOnUiThread {
                        try {
                            applyBarModes(statusMode, navigationMode)
                            applyIconAppearance(statusIcons, navIcons)
                            applyBarColors(statusColor, navColor)
                            result.success(barsState(statusMode, navigationMode))
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

    /**
     * Forced light/dark through the application night mode (Android 12+).
     *
     * Older versions have no per-app switch outside AppCompat, so the shell
     * only themes its own chrome there; the page keeps the system brightness.
     */
    private fun applyTheme(theme: String): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return false
        val manager = getSystemService(UiModeManager::class.java) ?: return false
        val mode = when (theme) {
            "light" -> UiModeManager.MODE_NIGHT_NO
            "dark" -> UiModeManager.MODE_NIGHT_YES
            else -> UiModeManager.MODE_NIGHT_AUTO
        }
        manager.setApplicationNightMode(mode)
        return true
    }

    private fun applyBarModes(status: String?, navigation: String?) {
        applyBarMode(status, navigationBars = false)
        applyBarMode(navigation, navigationBars = true)
    }

    /**
     * `visible` shows the bar; `hidden` hides it and a swipe brings it back for
     * good; `immersive` hides it and a swipe only peeks.
     */
    private fun applyBarMode(mode: String?, navigationBars: Boolean) {
        if (mode == null) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val controller = window.insetsController ?: return
            val type = if (navigationBars) {
                WindowInsets.Type.navigationBars()
            } else {
                WindowInsets.Type.statusBars()
            }
            when (mode) {
                "visible" -> controller.show(type)
                "immersive" -> {
                    controller.systemBarsBehavior =
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                    controller.hide(type)
                }
                else -> {
                    controller.systemBarsBehavior = WindowInsetsController.BEHAVIOR_DEFAULT
                    controller.hide(type)
                }
            }
            return
        }
        @Suppress("DEPRECATION")
        var flags = window.decorView.systemUiVisibility
        @Suppress("DEPRECATION")
        val hide = if (navigationBars) {
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
        } else {
            View.SYSTEM_UI_FLAG_FULLSCREEN
        }
        @Suppress("DEPRECATION")
        val immersive = View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        flags = when (mode) {
            "visible" -> flags and hide.inv() and immersive.inv()
            "immersive" -> flags or hide or immersive
            else -> (flags or hide) and immersive.inv()
        }
        window.decorView.systemUiVisibility = flags
    }

    /** `light` is light icons for a dark background, `dark` is the inverse. */
    private fun applyIconAppearance(statusIcons: String?, navIcons: String?) {
        if (statusIcons != null) desiredStatusIcons = statusIcons
        if (navIcons != null) desiredNavigationIcons = navIcons
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val controller = window.insetsController ?: return
            val lightStatus = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
            val lightNavigation = WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            var appearance = controller.systemBarsAppearance and (lightStatus or lightNavigation)
            if (statusIcons == "dark") {
                appearance = appearance or lightStatus
            } else if (statusIcons == "light") {
                appearance = appearance and lightStatus.inv()
            }
            if (navIcons == "dark") {
                appearance = appearance or lightNavigation
            } else if (navIcons == "light") {
                appearance = appearance and lightNavigation.inv()
            }
            controller.setSystemBarsAppearance(appearance, lightStatus or lightNavigation)
            return
        }
        @Suppress("DEPRECATION")
        var flags = window.decorView.systemUiVisibility
        if (statusIcons != null) {
            flags = if (statusIcons == "dark") {
                flags or View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
            } else {
                flags and View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR.inv()
            }
        }
        if (navIcons != null) {
            flags = if (navIcons == "dark") {
                flags or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
            } else {
                flags and View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR.inv()
            }
        }
        window.decorView.systemUiVisibility = flags
    }

    /** Android 15+ ignores bar colours; the page paints that area instead. */
    private fun applyBarColors(status: String?, navigation: String?) {
        if (Build.VERSION.SDK_INT >= 35) return
        @Suppress("DEPRECATION")
        if (status != null) window.statusBarColor = Color.parseColor(status)
        @Suppress("DEPRECATION")
        if (navigation != null) window.navigationBarColor = Color.parseColor(navigation)
    }

    private fun systemBarsState(
        insets: WindowInsets? = window.decorView.rootWindowInsets,
    ): Map<String, Any?> {
        val statusVisible = statusBarVisible(insets)
        val navigationVisible = navigationBarVisible(insets)
        return mapOf(
            "statusBar" to mapOf(
                "visible" to statusVisible,
                "mode" to barMode(statusVisible, navigationBars = false),
                "icons" to currentIcons(navigationBars = false),
            ),
            "navigationBar" to mapOf(
                "visible" to navigationVisible,
                "mode" to barMode(navigationVisible, navigationBars = true),
                "icons" to currentIcons(navigationBars = true),
            ),
            "colors" to (Build.VERSION.SDK_INT < 35),
            // Kept from the 0.2.5 result shape: icon contrast is always applied.
            "icons" to (Build.VERSION.SDK_INT < Build.VERSION_CODES.R ||
                window.insetsController != null),
        )
    }

    private fun statusBarVisible(insets: WindowInsets?): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            return insets?.isVisible(WindowInsets.Type.statusBars()) ?: true
        }
        @Suppress("DEPRECATION")
        return (window.decorView.systemUiVisibility and View.SYSTEM_UI_FLAG_FULLSCREEN) == 0
    }

    private fun navigationBarVisible(insets: WindowInsets?): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            return insets?.isVisible(WindowInsets.Type.navigationBars()) ?: true
        }
        @Suppress("DEPRECATION")
        return (window.decorView.systemUiVisibility and View.SYSTEM_UI_FLAG_HIDE_NAVIGATION) == 0
    }

    private fun barMode(visible: Boolean, navigationBars: Boolean): String {
        if (visible) return "visible"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val behavior = window.insetsController?.systemBarsBehavior
            return if (behavior == WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE) {
                "immersive"
            } else {
                "hidden"
            }
        }
        @Suppress("DEPRECATION")
        val flags = window.decorView.systemUiVisibility
        @Suppress("DEPRECATION")
        val immersive = View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        return if (flags and immersive != 0) "immersive" else "hidden"
    }

    private fun currentIcons(navigationBars: Boolean): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val appearance = window.insetsController?.systemBarsAppearance ?: 0
            val bit = if (navigationBars) {
                WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            } else {
                WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
            }
            return if (appearance and bit != 0) "dark" else "light"
        }
        @Suppress("DEPRECATION")
        val flags = window.decorView.systemUiVisibility
        val bit = if (navigationBars) {
            View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        } else {
            View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
        }
        return if (flags and bit != 0) "dark" else "light"
    }

    /**
     * State after a change.
     *
     * Insets only report a freshly hidden bar on the next dispatch, so the bars
     * this call touched are reported from the request itself; everything else
     * comes from the window.
     */
    private fun barsState(statusMode: String?, navigationMode: String?): Map<String, Any?> {
        val state = systemBarsState().toMutableMap()
        if (statusMode != null) {
            state["statusBar"] = mapOf(
                "visible" to (statusMode == "visible"),
                "mode" to statusMode,
                "icons" to currentIcons(navigationBars = false),
            )
        }
        if (navigationMode != null) {
            state["navigationBar"] = mapOf(
                "visible" to (navigationMode == "visible"),
                "mode" to navigationMode,
                "icons" to currentIcons(navigationBars = true),
            )
        }
        return state
    }

    /**
     * Watches the decor view for inset changes, so a bar the user swiped back
     * in is reported to the page.
     *
     * The listener forwards to `onApplyWindowInsets`, which is DecorView's own
     * implementation: it still dispatches the insets to the content, so Flutter
     * keeps its padding.
     */
    private fun installInsetsWatcher() {
        if (insetsWatcherInstalled) return
        insetsWatcherInstalled = true
        val decor = window.decorView
        decor.setOnApplyWindowInsetsListener { view, insets ->
            reportSystemBars(insets)
            view.onApplyWindowInsets(insets)
        }
        // Produce one dispatch even when nothing changes by itself, so the page
        // gets the initial state.
        decor.post { decor.requestApplyInsets() }
    }

    private fun reportSystemBars(insets: WindowInsets) {
        // Some ROMs drop the icon appearance when a bar is hidden; put the
        // page's choice back once the bar is visible again.
        applyIconAppearance(
            desiredStatusIcons.takeIf { statusBarVisible(insets) },
            desiredNavigationIcons.takeIf { navigationBarVisible(insets) },
        )
        val state = systemBarsState(insets)
        if (state == lastReportedBars) return
        lastReportedBars = state
        channel.invokeMethod("systemBarsChanged", state)
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
