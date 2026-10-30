package expo.modules.yakosms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Debug builds only (declared in src/debug manifest): lets adb inject a message through the real code path. */
class DebugSmsReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    SmsReceiver().onReceive(context, intent.setAction(SmsReceiver.DEBUG_SMS_ACTION))
  }
}
