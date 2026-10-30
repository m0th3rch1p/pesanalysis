package expo.modules.yakosms

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Durable at-least-once capture queue (D88).
 *  - Items get a monotonically increasing `seq`; the reader acks `seq <= n` only AFTER the ledger commit.
 *  - File lives in noBackupFilesDir, AES-256-GCM with an Android Keystore key (never extractable),
 *    rewritten atomically (tmp + rename) under a process-wide lock. Receiver and module share it.
 *  - If the Keystore is unusable the queue degrades to plaintext rather than dropping a transaction.
 */
object QueueStore {
  private const val FILE = "sms-queue.v2"
  private const val ALIAS = "yako_queue_key"
  private const val PREFS = "yako_sms_q"
  private const val SEQ = "seq"
  private const val FLOOR = "ingest_floor"
  private val lock = Any()

  private fun key(): SecretKey? = try {
    val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (ks.getKey(ALIAS, null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
      init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256).build())
      generateKey()
    }
  } catch (e: Exception) { null }

  private fun seal(plain: String): String {
    val k = key() ?: return "P:" + Base64.encodeToString(plain.toByteArray(), Base64.NO_WRAP)
    val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, k) }
    val ct = c.doFinal(plain.toByteArray())
    return "E:" + Base64.encodeToString(c.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP)
  }

  private fun open(line: String): String? = try {
    if (line.startsWith("P:")) String(Base64.decode(line.substring(2), Base64.NO_WRAP))
    else {
      val (_, iv, ct) = line.split(":")
      val c = Cipher.getInstance("AES/GCM/NoPadding").apply {
        init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
      }
      String(c.doFinal(Base64.decode(ct, Base64.NO_WRAP)))
    }
  } catch (e: Exception) { null }

  private fun file(ctx: Context) = File(ctx.noBackupFilesDir, FILE)

  private fun readAll(ctx: Context): MutableList<JSONObject> {
    val f = file(ctx)
    if (!f.exists()) return mutableListOf()
    val out = mutableListOf<JSONObject>()
    f.readLines().forEach { l -> if (l.isNotBlank()) open(l)?.let { out.add(JSONObject(it)) } }
    return out
  }

  private fun writeAll(ctx: Context, items: List<JSONObject>) {
    val f = file(ctx)
    val tmp = File(f.parentFile, "$FILE.tmp")
    tmp.writeText(items.joinToString("\n") { seal(it.toString()) })
    if (!tmp.renameTo(f)) { f.delete(); if (!tmp.renameTo(f)) throw java.io.IOException("queue rename failed") }
  }

  /** Appends and returns the seq. Throws on I/O failure so callers can fall back to a notification. */
  fun append(ctx: Context, item: JSONObject): Long = synchronized(lock) {
    val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val seq = sp.getLong(SEQ, 0L) + 1
    if (!sp.edit().putLong(SEQ, seq).commit()) throw java.io.IOException("seq commit failed")
    val items = readAll(ctx)
    items.add(item.put("seq", seq))
    writeAll(ctx, items)
    seq
  }

  /** Merge location fields into a queued item before the headless task drains it. */
  fun updateContext(ctx: Context, seq: Long, fields: JSONObject): Boolean = synchronized(lock) {
    val items = readAll(ctx)
    val item = items.firstOrNull { it.optLong("seq") == seq } ?: return false
    val keys = fields.keys()
    while (keys.hasNext()) { val k = keys.next(); item.put(k, fields.get(k)) }
    writeAll(ctx, items)
    true
  }

  fun peek(ctx: Context, limit: Int = 500): JSONArray = synchronized(lock) {
    val arr = JSONArray()
    readAll(ctx).sortedBy { it.optLong("seq") }.take(limit).forEach { arr.put(it) }
    arr
  }

  /** Remove every item with seq <= upTo. Idempotent. */
  fun ack(ctx: Context, upTo: Long): Int = synchronized(lock) {
    val items = readAll(ctx)
    val keep = items.filter { it.optLong("seq") > upTo }
    if (keep.size != items.size) writeAll(ctx, keep)
    items.size - keep.size
  }

  fun clear(ctx: Context) = synchronized(lock) { file(ctx).delete() }

  fun size(ctx: Context): Int = synchronized(lock) { readAll(ctx).size }

  /** A reset records the time before which received SMS must never be re-ingested (D88). */
  fun setIngestFloor(ctx: Context, ms: Long) { ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putLong(FLOOR, ms).commit() }
  fun ingestFloor(ctx: Context): Long = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(FLOOR, 0L)
}
