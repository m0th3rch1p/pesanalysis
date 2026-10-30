package expo.modules.yakosms

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * Wakes the JS runtime with no UI. The task reads the persisted queue itself
 * (drainQueue), so the Intent carries no transaction data.
 *
 * Android 15 refuses startService() from a background SMS receiver, so the
 * receiver uses startForegroundService(). This service must post its (silent)
 * notification within 5 s, hence onStartCommand -> startForeground immediately.
 * foregroundServiceType="shortService" (API 34+) is time-boxed by the OS and
 * needs no type-specific permission.
 */
class YakoSmsTaskService : HeadlessJsTaskService() {
  /** Two SMS in quick succession start two tasks; only the last to finish may stop the service (A2). */
  private val active = java.util.concurrent.atomic.AtomicInteger(0)

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    startForeground(NOTIF_ID, buildNotification(this))
    active.incrementAndGet()
    return super.onStartCommand(intent, flags, startId)
  }

  /** shortService is time-boxed by the OS: stop cleanly instead of being killed with an ANR (API 34+). */
  override fun onTimeout(startId: Int) { shutdown() }
  override fun onTimeout(startId: Int, fgsType: Int) { shutdown() }

  private fun shutdown() {
    active.set(0)
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig {
    return HeadlessJsTaskConfig("YakoSmsTask", Arguments.createMap(), 30_000, true)
  }

  override fun onHeadlessJsTaskFinish(taskId: Int) {
    super.onHeadlessJsTaskFinish(taskId)
    if (active.decrementAndGet() <= 0) shutdown()
  }

  companion object {
    private const val NOTIF_ID = 0x5941
    const val CAPTURE_CHANNEL = "yako-capture"

    fun ensureCaptureChannel(ctx: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val nm = ctx.getSystemService(NotificationManager::class.java)
      if (nm.getNotificationChannel(CAPTURE_CHANNEL) != null) return
      nm.createNotificationChannel(
        NotificationChannel(CAPTURE_CHANNEL, "Capture", NotificationManager.IMPORTANCE_LOW).apply {
          description = "Brief on-device processing of a new transaction SMS"
          setShowBadge(false)
        }
      )
    }

    fun buildNotification(ctx: Context): Notification {
      ensureCaptureChannel(ctx)
      val open = PendingIntent.getActivity(
        ctx, 0,
        Intent(ctx, Class.forName("dev.yako.app.MainActivity")).apply {
          flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
          putExtra("yako_open_capture", true)
        },
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
      )
      val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
        Notification.Builder(ctx, CAPTURE_CHANNEL)
      else
        @Suppress("DEPRECATION") Notification.Builder(ctx)
      return builder
        .setContentTitle("Filing transaction")
        .setContentText("Processing your latest M-PESA/Airtel message on this phone")
        .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
        .setOngoing(true)
        .setContentIntent(open)
        .build()
    }
  }
}
