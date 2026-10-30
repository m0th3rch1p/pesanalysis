import { requireNativeModule } from "expo-modules-core";

export interface RawSms {
  seq?: number; sender: string; body: string; receivedAt: number;
  lat?: number; lng?: number; accuracy?: number; locationAt?: number;
  fixKind?: "current" | "last_known" | "none"; provider?: string; fixLatencyMs?: number; ageMs?: number;
  batteryPct?: number; isCharging?: boolean; capturedAt?: number; calendarEventId?: string; calendarTitle?: string;
}
interface YakoSmsNative {
  readInbox(sinceMs: number, limit: number): Promise<RawSms[]>;
  readInboxPage(sinceMs: number, beforeMs: number, limit: number): Promise<RawSms[]>;
  peekQueue(limit: number): Promise<RawSms[]>;
  ackQueue(upToSeq: number): Promise<number>;
  queueSize(): Promise<number>;
  resetCapture(ms: number): Promise<void>;
  ingestFloor(): number;
  isSecureScreen(): boolean;
  setSecureScreen(on: boolean): void;
  randomHex(n: number): string;
  imageHash(uri: string): Promise<string>;
  captureContextJson(): Promise<string>;
  captureFreshContextJson(): Promise<string>;
}
const Native = requireNativeModule<YakoSmsNative>("YakoSms");
export const readInbox = (sinceMs = 0, limit = 5000) => Native.readInbox(sinceMs, limit);
export const readInboxPage = (sinceMs: number, beforeMs: number, limit = 400) => Native.readInboxPage(sinceMs, beforeMs, limit);
export const peekQueue = (limit = 500) => Native.peekQueue(limit);
export const ackQueue = (upToSeq: number) => Native.ackQueue(upToSeq);
export const queueSize = () => Native.queueSize();
export const resetCapture = (ms = Date.now()) => Native.resetCapture(ms);
export const randomHex = (n = 32) => Native.randomHex(n);
export const imageHash = (uri: string) => Native.imageHash(uri);
export const captureContextJson = () => Native.captureContextJson();
export const captureFreshContextJson = () => Native.captureFreshContextJson();
export const ingestFloor = () => Native.ingestFloor();
export const isSecureScreen = () => Native.isSecureScreen();
export const setSecureScreen = (on: boolean) => Native.setSecureScreen(on);
