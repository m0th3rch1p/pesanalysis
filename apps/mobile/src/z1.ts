import * as SecureStore from "expo-secure-store";
import type { SQLiteDatabase } from "expo-sqlite";
import {
  buildZ1Snapshot, pairHost, z1Call, z1PushSnapshot, z1Test,
  type Z1Endpoint,
} from "@yako/core";
import { asDbAdapter } from "./db/open";

const URL_KEY = "z1.host.url";
const TOKEN_KEY = "z1.host.token";

export async function getZ1Config(): Promise<{ url: string; token: string }> {
  return {
    url: (await SecureStore.getItemAsync(URL_KEY)) ?? "",
    token: (await SecureStore.getItemAsync(TOKEN_KEY)) ?? "",
  };
}

export async function saveZ1Config(url: string, token: string): Promise<void> {
  await SecureStore.setItemAsync(URL_KEY, url.trim());
  if (token.trim()) await SecureStore.setItemAsync(TOKEN_KEY, token.trim());
}

function endpoint(url: string, token: string): Z1Endpoint {
  if (!/^https?:\/\//i.test(url.trim())) throw new Error("Host address must start with http:// or https://");
  if (!token.trim()) throw new Error("Host token is empty");
  return { baseUrl: url.trim(), token: token.trim(), timeoutMs: 20_000 };
}

export async function testZ1(url: string, token: string): Promise<{ server: string; tools: string[] }> {
  return z1Test(endpoint(url, token));
}

export async function pushZ1(db: SQLiteDatabase, url: string, token: string): Promise<{ rows: number; snapshotRows: number }> {
  const a = asDbAdapter(db);
  const snap = buildZ1Snapshot(a, "z1-live");
  const r = await z1PushSnapshot(endpoint(url, token), snap);
  pairHost(a, { id: "z1-live", name: "Live personal host", keyFingerprint: "bearer" });
  const rows = snap.tables.transactions.length + snap.tables.labels.length + snap.tables.counterparties.length + snap.tables.accounts.length + snap.tables.tags.length;
  return { rows: r.rows, snapshotRows: rows };
}

export async function callZ1(url: string, token: string, tool: string, args: Record<string, unknown> = {}): Promise<string> {
  return z1Call(endpoint(url, token), tool, args);
}

