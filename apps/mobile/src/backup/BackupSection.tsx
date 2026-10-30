import { useEffect, useState } from "react";
import { Alert, Text, View } from "react-native";
import * as Notifications from "expo-notifications";
import type { SQLiteDatabase } from "expo-sqlite";
import { BackupError, peekHeader, SCHEMA_VERSION } from "@yako/core";
import { Btn, C, text } from "../ui";
import { PassphraseModal, RecoveryCodeModal, TypeToConfirmModal } from "./BackupModals";
import { createBackupBytes, restoreFromBytes, type LedgerStats, type RestoreSecret } from "./ledger";
import { latestSnapshot, listSnapshots, eraseSnapshots } from "./snapshots";
import { deleteLegacyPlaintext, hasLegacyPlaintext, pickBackupBytes, resetEverything, shareBackupBytes } from "./files";
import { getBackupKdf } from "./crypto";
import { syncWeeklyReview } from "../runtime/weekly";
import { syncHabitNudges } from "../runtime/nudges";

type Flow =
  | { k: "none" }
  | { k: "create" }
  | { k: "code"; code: string; bytes: Uint8Array; stats: LedgerStats }
  | { k: "restore"; bytes: Uint8Array }
  | { k: "reset" };

const msg = (e: unknown) => (e instanceof BackupError || e instanceof Error ? e.message : String(e)).slice(0, 220);
const when = (t: number) => new Date(t).toLocaleString();

/** Backup / restore / undo / reset controls for More > DATA. All files are encrypted .pesabak containers. */
export function BackupSection({ db, onChanged }: { db: SQLiteDatabase; onChanged: () => void }) {
  const [flow, setFlow] = useState<Flow>({ k: "none" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snap, setSnap] = useState(() => listSnapshots()[0] ?? null);
  const refresh = () => setSnap(listSnapshots()[0] ?? null);
  const close = () => { setFlow({ k: "none" }); setError(null); setBusy(false); };

  useEffect(() => {
    if (!hasLegacyPlaintext()) return;
    Alert.alert("Old unencrypted backups found", "Earlier versions saved backups as readable files on this phone. Delete them now? Make a new encrypted backup first if you still need them.", [
      { text: "Keep for now", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => { deleteLegacyPlaintext(); } },
    ]);
  }, []);

  const startBackup = () => { void getBackupKdf(); setFlow({ k: "create" }); }; // warm the one-time calibration

  const doCreate = async (s: RestoreSecret) => {
    setBusy(true); setError(null);
    try {
      const r = await createBackupBytes(db, { passphrase: s.passphrase! });
      setBusy(false);
      setFlow({ k: "code", code: r.recoveryCode!, bytes: r.bytes, stats: r.stats });
    } catch (e) { setBusy(false); setError(msg(e)); }
  };

  const afterCode = async (bytes: Uint8Array) => {
    close();
    try { await shareBackupBytes(bytes); } catch (e) { Alert.alert("Could not open share sheet", msg(e)); }
  };

  const pick = async () => {
    try {
      const f = await pickBackupBytes();
      if (!f) return;
      const h = peekHeader(f.bytes);
      if (Number(h.meta?.schema ?? 0) > SCHEMA_VERSION) { Alert.alert("Backup is from a newer app", "Update Pesanalysis, then try again."); return; }
      Alert.alert("Restore this backup?", `${f.name}\nCreated ${when(h.created)}.\n\nThe current ledger is replaced only after the backup is verified. A safety snapshot is taken first so you can undo.`, [
        { text: "Cancel", style: "cancel" },
        { text: "Continue", style: "destructive", onPress: () => setFlow({ k: "restore", bytes: f.bytes }) },
      ]);
    } catch (e) { Alert.alert("Not a usable backup", msg(e)); }
  };

  const doRestore = async (bytes: Uint8Array, s: RestoreSecret) => {
    setBusy(true); setError(null);
    try {
      const r = await restoreFromBytes(db, bytes, s);
      try { await Notifications.dismissAllNotificationsAsync(); } catch { /* OS state is best-effort */ }
      void syncWeeklyReview(db); void syncHabitNudges(db);
      close(); refresh(); onChanged();
      Alert.alert("Restored", `${r.rows} rows in ${r.tables} tables verified (backup schema ${r.schemaVersion}).${r.media ? ` ${r.media} media file${r.media === 1 ? "" : "s"} restored.` : ""}${r.contexts ? `\n${r.contexts} live location snapshots kept.` : ""}\nUndo is available in More.`);
    } catch (e) {
      setBusy(false);
      setError(e instanceof BackupError && e.code === "auth" ? "Wrong passphrase or recovery code, or the file is damaged. Your ledger was not changed." : `${msg(e)} Your ledger was not changed.`);
    }
  };

  const undo = () => {
    if (!snap) return;
    Alert.alert("Undo last reset/restore?", `Returns the ledger to how it was on ${when(snap.createdAt)} (${snap.reason.replace("pre-", "before ")}). Current data is snapshotted first.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Undo", style: "destructive", onPress: () => { void (async () => {
        try {
          const l = await latestSnapshot();
          if (!l) throw new Error("no snapshot available");
          const r = await restoreFromBytes(db, l.bytes, { passphrase: l.secret }, { snapshotReason: "pre-undo" });
          try { await Notifications.dismissAllNotificationsAsync(); } catch { /* OS state is best-effort */ }
          void syncWeeklyReview(db); void syncHabitNudges(db);
          refresh(); onChanged();
          Alert.alert("Undone", `${r.rows} rows restored.`);
        } catch (e) { Alert.alert("Undo failed", `${msg(e)} Your ledger was not changed.`); }
      })(); } },
    ]);
  };

  const doReset = async () => {
    setBusy(true);
    try {
      await resetEverything(db);
      try { await Notifications.dismissAllNotificationsAsync(); } catch { /* OS state is best-effort */ }
      void syncWeeklyReview(db); void syncHabitNudges(db);
      close(); refresh(); onChanged();
      Alert.alert("Reset complete", "Ledger, media, tokens and exports were deleted. An encrypted safety snapshot remains so you can undo; erase it from More if you want nothing left.");
    } catch (e) { close(); Alert.alert("Reset failed", `${msg(e)} Nothing was deleted if the safety snapshot could not be written.`); }
  };

  const erase = () => Alert.alert("Erase undo snapshots?", "Undo will no longer be possible.", [
    { text: "Cancel", style: "cancel" },
    { text: "Erase", style: "destructive", onPress: () => { void eraseSnapshots().then(refresh); } },
  ]);

  return (
    <View>
      <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
        <Btn label="Encrypted backup" kind="soft" onPress={startBackup} style={{ flex: 1, paddingVertical: 9 }} />
        <Btn label="Restore from file" kind="soft" onPress={() => { void pick(); }} style={{ flex: 1, paddingVertical: 9 }} />
      </View>
      {snap ? <Btn label={`Undo ${snap.reason.replace("pre-", "")} (${when(snap.createdAt)})`} kind="ghost" onPress={undo} style={{ marginTop: 4, paddingVertical: 9 }} /> : null}
      {snap ? <Btn label="Erase undo snapshots" kind="ghost" onPress={erase} style={{ paddingVertical: 6 }} /> : null}
      <Text style={[text(10, C.dim), { marginTop: 6, lineHeight: 15 }]}>Backups are .pesabak files, encrypted on this phone. Lose both the passphrase and recovery code and they cannot be opened.</Text>
      <Btn label="Reset everything" kind="ghost" onPress={() => setFlow({ k: "reset" })} style={{ marginTop: 4 }} />

      {flow.k === "create" ? <PassphraseModal mode="create" busy={busy} error={error} onSubmit={(s) => { void doCreate(s); }} onCancel={close} /> : null}
      {flow.k === "code" ? <RecoveryCodeModal code={flow.code} note={flow.stats.mediaSkipped ? `${flow.stats.mediaSkipped} attachment${flow.stats.mediaSkipped === 1 ? "" : "s"} could not be included. ${flow.stats.mediaError ?? ""}` : undefined} onDone={() => { void afterCode(flow.bytes); }} /> : null}
      {flow.k === "restore" ? <PassphraseModal mode="enter" allowRecovery title="Unlock backup to restore" busy={busy} error={error} onSubmit={(s) => { void doRestore(flow.bytes, s); }} onCancel={close} /> : null}
      {flow.k === "reset" ? (
        <TypeToConfirmModal title="Reset everything?" word="RESET" actionLabel="Delete all" busy={busy}
          body="Deletes the ledger, SMS bodies, tags, notes, photos and voice notes, chats, learned words, Z1 pairing and exports, and clears the capture queue. An encrypted safety snapshot is made first so you can undo."
          onConfirm={() => { void doReset(); }} onCancel={close} />
      ) : null}
    </View>
  );
}
