package expo.modules.yakosms

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * SMS bridge: inbox backfill, capture-queue drain, and secure key material.
 * JS requests READ_SMS/RECEIVE_SMS via react-native PermissionsAndroid before calling readInbox.
 */
class YakoSmsModule : Module() {
  private val ctx: Context get() = appContext.reactContext ?: throw IllegalStateException("no react context")

  override fun definition() = ModuleDefinition {
    Name("YakoSms")
    Events("onSms")

    // DB key material: Android SecureRandom, never Math.random. Sync so openLedger() can stay sync.
    Function("randomHex") { n: Int ->
      val b = ByteArray(n)
      java.security.SecureRandom().nextBytes(b)
      b.joinToString("") { "%02x".format(it) }
    }

    // Backfill: rows newer than sinceMs, oldest first. Only address/date/body; caller filters senders.
    AsyncFunction("readInbox") { sinceMs: Long, limit: Int ->
      val out = mutableListOf<Map<String, Any>>()
      ctx.contentResolver.query(
        Uri.parse("content://sms/inbox"), arrayOf("address", "date", "body"),
        "date > ?", arrayOf(sinceMs.toString()), "date ASC LIMIT $limit"
      )?.use { c ->
        while (c.moveToNext()) out.add(mapOf("sender" to (c.getString(0) ?: ""), "receivedAt" to c.getLong(1), "body" to (c.getString(2) ?: "")))
      }
      out
    }

    // Onboarding backfill: one page of rows in (sinceMs, beforeMs), NEWEST first, so the most recent
    // messages are imported before older history and the loop can page with the oldest date seen.
    AsyncFunction("readInboxPage") { sinceMs: Long, beforeMs: Long, limit: Int ->
      val out = mutableListOf<Map<String, Any>>()
      ctx.contentResolver.query(
        Uri.parse("content://sms/inbox"), arrayOf("address", "date", "body"),
        "date > ? AND date < ?", arrayOf(sinceMs.toString(), beforeMs.toString()), "date DESC LIMIT $limit"
      )?.use { c ->
        while (c.moveToNext()) out.add(mapOf("sender" to (c.getString(0) ?: ""), "receivedAt" to c.getLong(1), "body" to (c.getString(2) ?: "")))
      }
      out
    }

    // Local perceptual hash (dHash 64-bit) for product/warranty matching. No network.
    AsyncFunction("imageHash") { rawUri: String ->
      val uri = if (rawUri.startsWith("file://") || rawUri.startsWith("content://")) Uri.parse(rawUri) else Uri.fromFile(java.io.File(rawUri))
      val bmp = ctx.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it) }
        ?: throw IllegalStateException("could not read image")
      val small = Bitmap.createScaledBitmap(bmp, 9, 8, true)
      if (small !== bmp) bmp.recycle()
      var hash = 0L
      for (y in 0 until 8) {
        for (x in 0 until 8) {
          val l = small.getPixel(x, y)
          val r = small.getPixel(x + 1, y)
          val ll = (Color.red(l) * 299 + Color.green(l) * 587 + Color.blue(l) * 114) / 1000
          val rr = (Color.red(r) * 299 + Color.green(r) * 587 + Color.blue(r) * 114) / 1000
          if (ll > rr) hash = hash or (1L shl (y * 8 + x))
        }
      }
      small.recycle()
      "%016x".format(hash)
    }

    // Diagnostic: exercise the exact passive snapshot used by SmsReceiver.
    AsyncFunction("captureContextJson") {
      ContextCapture.capture(ctx).toString()
    }

    // Diagnostic/spike: run the same fresh-fix path as LocationFixService without waiting for an SMS.
    AsyncFunction("captureFreshContextJson") {
      LocationFixService.freshFixJson(ctx)?.toString() ?: "{}"
    }

    // At-least-once queue: peek, ingest, commit to the ledger, THEN ack (D88).
    AsyncFunction("peekQueue") { limit: Int ->
      val arr = QueueStore.peek(ctx, limit)
      (0 until arr.length()).map { i ->
        val o = arr.getJSONObject(i)
        val m = mutableMapOf<String, Any>(
          "seq" to o.getLong("seq"),
          "sender" to o.getString("sender"),
          "receivedAt" to o.getLong("receivedAt"),
          "body" to o.getString("body"),
        )
        for (k in listOf("lat", "lng", "accuracy", "batteryPct", "isCharging", "capturedAt", "calendarEventId", "calendarTitle", "locationAt", "fixKind", "provider", "fixLatencyMs", "ageMs")) {
          if (o.has(k) && !o.isNull(k)) m[k] = o.get(k)
        }
        m
      }
    }
    // Privacy mode (FLAG_SECURE). Default ON; turning it off is for screen recording the demo only.
    Function("isSecureScreen") { ctx.getSharedPreferences("yako_ui", Context.MODE_PRIVATE).getBoolean("secure", true) }
    Function("setSecureScreen") { on: Boolean ->
      ctx.getSharedPreferences("yako_ui", Context.MODE_PRIVATE).edit().putBoolean("secure", on).commit()
      appContext.currentActivity?.runOnUiThread {
        val w = appContext.currentActivity?.window
        if (on) w?.addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)
        else w?.clearFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)
      }
    }
    AsyncFunction("ackQueue") { upToSeq: Long -> QueueStore.ack(ctx, upToSeq) }
    AsyncFunction("queueSize") { QueueStore.size(ctx) }
    // Reset support: wipe the queue and refuse anything received before `ms`.
    AsyncFunction("resetCapture") { ms: Long -> QueueStore.clear(ctx); QueueStore.setIngestFloor(ctx, ms) }
    Function("ingestFloor") { QueueStore.ingestFloor(ctx) }
  }
}
