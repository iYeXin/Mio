package dev.mio.mio_shell

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder

/**
 * Keeps the process alive while a long task runs in the WebView.
 *
 * The notification is required by Android: a foreground service without one is
 * killed. `dataSync` is the right type for downloads and uploads.
 */
class MioForegroundService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val title = intent?.getStringExtra("title") ?: "Mio"
        val text = intent?.getStringExtra("text") ?: "Running in the background"
        running = true
        startForeground(NOTIFICATION_ID, buildNotification(this, title, text))
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    companion object {
        const val NOTIFICATION_ID = 4101
        const val CHANNEL_ID = "mio.foreground"

        fun start(context: Context, title: String, text: String) {
            val intent = Intent(context, MioForegroundService::class.java).apply {
                putExtra("title", title)
                putExtra("text", text)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, MioForegroundService::class.java))
        }

        fun isRunning(context: Context): Boolean {
            return running
        }

        @Volatile
        var running: Boolean = false

        fun buildNotification(context: Context, title: String, text: String): Notification {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val channel = NotificationChannel(
                    CHANNEL_ID,
                    "Background work",
                    NotificationManager.IMPORTANCE_LOW,
                )
                manager.createNotificationChannel(channel)
            }

            val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
            val pending = launch?.let {
                PendingIntent.getActivity(
                    context,
                    0,
                    it,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
            }

            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(context, CHANNEL_ID)
            } else {
                Notification.Builder(context)
            }
            return builder
                .setContentTitle(title)
                .setContentText(text)
                .setSmallIcon(context.applicationInfo.icon)
                .setOngoing(true)
                .apply { if (pending != null) setContentIntent(pending) }
                .build()
        }
    }
}
