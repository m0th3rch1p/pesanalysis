package expo.modules.yakosms

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.os.Build
import android.provider.Telephony
import org.json.JSONObject

/**
 * Persist-first: the raw SMS is appended to SharedPreferences BEFORE any JS runs,
 * so a dead JS runtime loses only the notification, never the transaction.
 *
 * Wake path: Android 15 forbids startService() from a background receiver, so we
 * use startForegroundService(). If even that is refused (OEM policy), we fall back
 * to a silent native notification; the app drains the queue and ingests on open.
 *
 * DEBUG_SMS_ACTION exists because a physical phone cannot receive adb-injected
 * SMS_RECEIVED broadcasts (sender needs BROADCAST_SMS). Honoured only when the
 * app is debuggable; it takes the exact same code path.
 */
class SmsReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    when (intent.action) {
      Telephony.Sms.Intents.SMS_RECEIVED_ACTION -> {
        val parts = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        val bySender = LinkedHashMap<String, StringBuilder>()
        var ts = System.currentTimeMillis()
        for (p in parts) {
          bySender.getOrPut(p.displayOriginatingAddress ?: "") { StringBuilder() }
            .append(p.displayMessageBody ?: "")
          ts = p.timestampMillis
        }
        for ((sender, body) in bySender) persistAndWake(context, sender, body.toString(), ts)
      }
      DEBUG_SMS_ACTION -> {
        // Only reachable through DebugSmsReceiver (debug source set); belt and braces.
        val debuggable = (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        if (!debuggable) return
        val sender = intent.getStringExtra("sender") ?: return
        val body = intent.getStringExtra("body") ?: return
        persistAndWake(context, sender, body, System.currentTimeMillis())
      }
    }
  }

  private fun persistAndWake(context: Context, sender: String, body: String, ts: Long) {
    // Privacy: personal messages and OTPs never enter our queue (D88).
    if (!isCandidate(sender, body)) return
    if (ts < QueueStore.ingestFloor(context)) return
    val ctx = try { ContextCapture.capture(context) } catch (e: Exception) { JSONObject() }
    val item = JSONObject().put("sender", sender).put("body", body).put("receivedAt", ts)
    for (k in listOf("lat", "lng", "accuracy", "batteryPct", "isCharging", "capturedAt", "locationAt", "calendarEventId", "calendarTitle", "calendarBegin", "calendarEnd", "fixKind", "provider", "fixLatencyMs", "ageMs")) {
      if (ctx.has(k)) item.put(k, ctx.get(k))
    }
    val seq = try {
      QueueStore.append(context, item)
    } catch (e: Exception) {
      // Could not persist: tell the user so the inbox catch-up (which cannot lose it) is prompted.
      postFallbackNotification(context)
      return
    }
    // A fresh fix needs a location-typed foreground service. Android 14+ refuses to start a
    // location FGS from the background without ACCESS_BACKGROUND_LOCATION; starting it anyway
    // throws SecurityException and can kill the process before the headless ingest runs.
    val canFix = LocationFixService.canRunInBackground(context)
    if (canFix) {
      try {
        val loc = LocationFixService.intent(context, seq)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(loc)
        else context.startService(loc)
      } catch (e: Exception) {
        startIngest(context, sender)
      }
    } else {
      // Permission denied or foreground-only: keep the passive last-known snapshot and ingest now.
      startIngest(context, sender)
    }
  }

  private fun startIngest(context: Context, sender: String) {
    try {
      val svc = Intent(context, YakoSmsTaskService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(svc)
      else context.startService(svc)
    } catch (e: Exception) {
      // Background FGS launch refused. The SMS is already persisted; prompt the user instead.
      if (isLikelyFinancialSender(sender)) postFallbackNotification(context)
    }
  }

  /**
   * Candidate = could be a money message. Alphanumeric senders (MPESA, banks, lenders) qualify unless the
   * body is a one-time code. Numeric senders (people, till/paybill shortcodes) need confirmation language,
   * so a friend writing "send me Ksh 500" never enters the queue.
   */
  private fun isCandidate(sender: String, body: String): Boolean {
    if (sender.isBlank()) return false
    if (OTP.containsMatchIn(body)) return false
    return if (sender.any { it.isLetter() }) true
    else MONEY.containsMatchIn(body) && CONFIRMATION.containsMatchIn(body)
  }

  /** Alphanumeric senders are the carriers/banks/lenders; phone-number senders are people. */
  private fun isLikelyFinancialSender(sender: String): Boolean =
    sender.isNotBlank() && sender.none { it.isDigit() }

  private fun postFallbackNotification(context: Context) {
    YakoSmsTaskService.ensureCaptureChannel(context)
    val nm = context.getSystemService(NotificationManager::class.java)
    val open = PendingIntent.getActivity(
      context, 0,
      context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        putExtra("yako_open_capture", true)
      },
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
      Notification.Builder(context, YakoSmsTaskService.CAPTURE_CHANNEL)
    else
      @Suppress("DEPRECATION") Notification.Builder(context)
    val n = builder
      .setContentTitle("New transaction message")
      .setContentText("Tap to file it. Nothing leaves your phone.")
      .setSmallIcon(android.R.drawable.stat_notify_chat)
      .setAutoCancel(true)
      .setContentIntent(open)
      .build()
    nm.notify(FALLBACK_ID, n)
  }

  companion object {
    const val PREFS = "yako_sms"
    const val KEY = "queue"
    const val DEBUG_SMS_ACTION = "dev.yako.app.DEBUG_SMS"
    private const val FALLBACK_ID = 0x5942
    private val MONEY = Regex("(?i)\\b(ksh|kes)\\.?\\s?[0-9]|m-?pesa|airtel money|confirmed\\.")
    private val OTP = Regex("(?i)\\b(otp|one[- ]?time|verification code|your code|passcode|pin is)\\b")
    private val CONFIRMATION = Regex("(?i)confirmed|has been (sent|received|paid|debited|credited)|new .*balance|transaction (cost|id)|m-?pesa balance")
  }
}
