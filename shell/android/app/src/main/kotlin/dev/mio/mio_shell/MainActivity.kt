package dev.mio.mio_shell

import android.util.Base64
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

class MainActivity : FlutterActivity() {
    private val executor = Executors.newSingleThreadExecutor()

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

                else -> result.notImplemented()
            }
        }
    }

    override fun onDestroy() {
        executor.shutdown()
        super.onDestroy()
    }
}
