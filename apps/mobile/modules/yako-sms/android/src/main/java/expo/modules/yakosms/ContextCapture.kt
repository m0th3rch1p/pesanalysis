package expo.modules.yakosms

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.BatteryManager
import android.os.Build
import android.provider.CalendarContract
import org.json.JSONObject

/**
 * Zero-battery passive snapshot at SMS arrival: last known coarse location (if permission
 * already granted) plus battery/charging state. No foreground service, no wake lock, no
 * continuous GPS. Step/motion fields stay null until a sensor path is added.
 */
object ContextCapture {
  fun capture(context: Context): JSONObject {
    val out = JSONObject()
    out.put("capturedAt", System.currentTimeMillis())
    try {
      val bm = context.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
      if (bm != null) out.put("batteryPct", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY))
      val sticky = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
      if (sticky != null) {
        val status = sticky.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        out.put("isCharging", status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL)
      }
    } catch (_: Exception) { }
    try {
      val fine = context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
      val coarse = context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
      if (fine || coarse) {
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
        if (lm != null) {
          val loc = sequenceOf(
            LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER, LocationManager.PASSIVE_PROVIDER,
          ).mapNotNull { provider ->
            try { if (lm.isProviderEnabled(provider)) lm.getLastKnownLocation(provider) else null } catch (_: Exception) { null }
          }.maxByOrNull { it.time }
          if (loc != null && System.currentTimeMillis() - loc.time < 30 * 60_000L) {
            out.put("lat", loc.latitude)
            out.put("lng", loc.longitude)
            out.put("accuracy", loc.accuracy.toDouble())
            out.put("locationAt", loc.time)
            out.put("fixKind", "last_known")
            out.put("provider", loc.provider ?: "unknown")
            out.put("ageMs", System.currentTimeMillis() - loc.time)
          }
        }
      }
    } catch (_: Exception) { }
    try {
      if (context.checkSelfPermission(Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED) {
        val now = System.currentTimeMillis()
        val begin = now - 30 * 60_000L
        val end = now + 30 * 60_000L
        val uri = CalendarContract.Instances.CONTENT_URI.buildUpon()
          .appendPath(begin.toString()).appendPath(end.toString()).build()
        val projection = arrayOf(
          CalendarContract.Instances.EVENT_ID,
          CalendarContract.Instances.TITLE,
          CalendarContract.Instances.BEGIN,
          CalendarContract.Instances.END,
        )
        context.contentResolver.query(
          uri, projection, null, null, "${CalendarContract.Instances.BEGIN} ASC",
        )?.use { c ->
          if (c.moveToFirst()) {
            out.put("calendarEventId", c.getLong(0).toString())
            out.put("calendarTitle", c.getString(1) ?: "")
            out.put("calendarBegin", c.getLong(2))
            out.put("calendarEnd", c.getLong(3))
          }
        }
      }
    } catch (_: Exception) { }
    return out
  }
}
