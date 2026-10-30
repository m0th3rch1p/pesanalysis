import type { SQLiteDatabase } from "expo-sqlite";
import { applyLabelPack, decodeLabelPack, decryptBackup, SCHEMA_VERSION, type LabelPack, type LabelPackPreview, type LabelPackResult } from "@yako/core";
import { asDbAdapter } from "./db/open";

export interface OpenedLabelPack { pack: LabelPack; preview: LabelPackPreview }

export async function openLabelPack(db: SQLiteDatabase, bytes: Uint8Array, passphrase: string): Promise<OpenedLabelPack> {
  const plain = await decryptBackup(bytes, { passphrase });
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(plain)); } catch { throw new Error("label pack is not valid JSON"); }
  const pack = decodeLabelPack(parsed, SCHEMA_VERSION);
  const preview = applyLabelPack(asDbAdapter(db), pack, { dryRun: true });
  return { pack, preview };
}

export function applyOpenedLabelPack(db: SQLiteDatabase, pack: LabelPack): LabelPackResult {
  return applyLabelPack(asDbAdapter(db), pack);
}
