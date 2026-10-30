package expo.modules.yakosms

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * One location fix per money SMS (D107). This is a separate foreground service with
 * type=location, because a shortService cannot legally read location in the background.
 * The SMS is already persisted before this service starts; if anything fails we start the
 * headless ingest immediately and the transaction keeps the last-known (or no) place.
 *
 * Coalescing: Fuliza often sends a draw notice and the payment seconds apart. At most one
 * fix per 60 s; later SMS reuse the cached fix, so the battery cost is one fix per purchase.
 */
class LocationFixService : Service() {
  private val executor = Executors.newSingleThreadExecutor()
  private var started = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val seq = intent?.getLongExtra(EXTRA_SEQ, -1L) ?: -1L
    if (started) {
      // A Fuliza notice and the actual payment often arrive seconds apart. The first call owns
      // the fix; later messages still need their headless ingest, and inherit the passive snapshot.
      startIngest(this)
      return START_NOT_STICKY
    }
    started = true
    if (!canRunInBackground(this)) {
      startIngest(this)
      stopSelf()
      return START_NOT_STICKY
    }
    try {
      startForegroundCompat()
    } catch (_: Exception) {
      // OEM/Android 15 refusal: never crash the SMS process for an optional location.
      startIngest(this)
      stopSelf()
      return START_NOT_STICKY
    }
    executor.execute {
      try {
        if (seq > 0) {
          val fix = obtainFix(this)
          if (fix != null) QueueStore.updateContext(this, seq, fix)
        }
      } catch (_: Exception) {
        // Never block ingest on a location failure.
      } finally {
        startIngest(this)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
      }
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    executor.shutdownNow()
    super.onDestroy()
  }

  private fun startForegroundCompat() {
    ensureChannel(this)
    val n = buildNotification(this)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
    } else {
      startForeground(NOTIF_ID, n)
    }
  }

  companion object {
    private const val CHANNEL = "yako-location"
    private const val NOTIF_ID = 0x5943
    private const val EXTRA_SEQ = "seq"
    private const val PREFS = "yako_location"
    private const val KEY_LAST = "last_fix"
    private const val KEY_AT = "last_fix_at"
    private const val COALESCE_MS = 60_000L
    private const val FRESH_TIMEOUT_MS = 20_000L
    private const val LAST_KNOWN_MAX_AGE_MS = 30 * 60_000L

    fun intent(ctx: Context, seq: Long): Intent = Intent(ctx, LocationFixService::class.java).putExtra(EXTRA_SEQ, seq)

    /** True only when the OS will allow a background-started location FGS. */
    fun canRunInBackground(ctx: Context): Boolean {
      val fine = ctx.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
      val coarse = ctx.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
      val background = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
        ctx.checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED
      return (fine || coarse) && background
    }

    private fun ensureChannel(ctx: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val nm = ctx.getSystemService(NotificationManager::class.java)
      if (nm.getNotificationChannel(CHANNEL) != null) return
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL, "Payment place", NotificationManager.IMPORTANCE_LOW).apply {
          description = "Briefly finds the place of a new payment SMS"
          setShowBadge(false)
        }
      )
    }

    private fun buildNotification(ctx: Context): Notification {
      val open = android.app.PendingIntent.getActivity(
        ctx, 0,
        Intent(ctx, Class.forName("dev.yako.app.MainActivity")).apply {
          flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        },
        android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT,
      )
      val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
        Notification.Builder(ctx, CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(ctx)
      return b.setContentTitle("Finding this payment's place")
        .setContentText("One reading, on this phone. No tracking.")
        .setSmallIcon(android.R.drawable.ic_menu_mylocation)
        .setOngoing(true)
        .setContentIntent(open)
        .build()
    }

    private fun hasLocation(ctx: Context): Boolean =
      ctx.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
        ctx.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    /** Exposed for the Diagnostics spike: returns the same JSON the SMS path would store. */
    fun freshFixJson(ctx: Context): JSONObject? = obtainFix(ctx)

    private fun obtainFix(ctx: Context): JSONObject? {
      if (!hasLocation(ctx)) return null
      val now = System.currentTimeMillis()
      val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val lastAt = sp.getLong(KEY_AT, 0L)
      if (now - lastAt in 0 until COALESCE_MS) {
        val cached = sp.getString(KEY_LAST, null)
        if (cached != null) return runCatching { JSONObject(cached) }.getOrNull()
      }
      val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return null
      val t0 = SystemClock.elapsedRealtime()
      val fresh = currentFix(ctx, lm)
      if (fresh != null) {
        android.util.Log.i("YakoLocation", "fresh provider=${providerName(lm, fresh)} latencyMs=${SystemClock.elapsedRealtime() - t0} accuracy=${fresh.accuracy}")
        val out = JSONObject()
          .put("lat", fresh.latitude).put("lng", fresh.longitude)
          .put("accuracy", fresh.accuracy.toDouble())
          .put("locationAt", fresh.time)
          .put("fixKind", "current")
          .put("provider", providerName(lm, fresh))
          .put("fixLatencyMs", SystemClock.elapsedRealtime() - t0)
        sp.edit().putString(KEY_LAST, out.toString()).putLong(KEY_AT, now).commit()
        return out
      }
      // Last-known is explicitly labelled, so the UI never pretends it is a fresh fix.
      val known = lastKnown(lm)
      if (known != null && now - known.time <= LAST_KNOWN_MAX_AGE_MS) {
        return JSONObject()
          .put("lat", known.latitude).put("lng", known.longitude)
          .put("accuracy", known.accuracy.toDouble())
          .put("locationAt", known.time)
          .put("fixKind", "last_known")
          .put("provider", providerName(lm, known))
          .put("fixLatencyMs", SystemClock.elapsedRealtime() - t0)
          .put("ageMs", now - known.time)
      }
      android.util.Log.i("YakoLocation", "no fix latencyMs=${SystemClock.elapsedRealtime() - t0}")
      return JSONObject().put("fixKind", "none").put("fixLatencyMs", SystemClock.elapsedRealtime() - t0)
    }

    @Suppress("MissingPermission")
    private fun currentFix(ctx: Context, lm: LocationManager): Location? {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
      val providers = buildList {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && lm.isProviderEnabled(LocationManager.FUSED_PROVIDER)) add(LocationManager.FUSED_PROVIDER)
        if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) add(LocationManager.NETWORK_PROVIDER)
        if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) add(LocationManager.GPS_PROVIDER)
      }
      val deadline = SystemClock.elapsedRealtime() + FRESH_TIMEOUT_MS
      for (provider in providers) {
        val remaining = deadline - SystemClock.elapsedRealtime()
        if (remaining <= 0) break
        val signal = android.os.CancellationSignal()
        val latch = java.util.concurrent.CountDownLatch(1)
        var result: Location? = null
        try {
          lm.getCurrentLocation(provider, signal, ctx.mainExecutor) { loc ->
            result = loc
            latch.countDown()
          }
          latch.await(remaining, java.util.concurrent.TimeUnit.MILLISECONDS)
        } catch (_: Exception) {
          // Try the next provider.
        } finally {
          signal.cancel()
        }
        if (result != null) return result
      }
      return null
    }

    @Suppress("MissingPermission")
    private fun lastKnown(lm: LocationManager): Location? = sequenceOf(
      LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER, LocationManager.PASSIVE_PROVIDER,
    ).mapNotNull { provider ->
      try { if (lm.isProviderEnabled(provider)) lm.getLastKnownLocation(provider) else null } catch (_: Exception) { null }
    }.maxByOrNull { it.time }

    private fun providerName(lm: LocationManager, loc: Location): String = try {
      val fused = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && loc.provider == LocationManager.FUSED_PROVIDER
      when {
        fused -> "fused"
        loc.provider == LocationManager.GPS_PROVIDER -> "gps"
        loc.provider == LocationManager.NETWORK_PROVIDER -> "network"
        loc.provider == LocationManager.PASSIVE_PROVIDER -> "passive"
        else -> loc.provider?.ifBlank { "unknown" } ?: "unknown"
      }
    } catch (_: Exception) { "unknown" }

    private fun startIngest(ctx: Context) {
      try {
        ctx.startForegroundService(Intent(ctx, YakoSmsTaskService::class.java))
      } catch (_: Exception) {
        // The SMS is already in the durable queue; the next app open drains it.
      }
    }
  }
}
