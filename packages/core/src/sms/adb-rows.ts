/**
 * Parses `adb shell content query --uri content://sms/inbox --projection address:date:body` output.
 * Rows look like: "Row: 12 address=MPESA, date=1792932621401, body=<text, may contain newlines/commas>"
 */
export interface RawSms { sender: string; body: string; receivedAt: number }

export function parseContentQueryOutput(out: string): RawSms[] {
  const chunks = out.replace(/\r/g, "").split(/^Row: \d+ /m).slice(1);
  const rows: RawSms[] = [];
  for (const c of chunks) {
    const m = /^address=(.*?), date=(\d+), body=([\s\S]*?)\n?$/.exec(c);
    if (!m) continue;
    rows.push({ sender: m[1]!, receivedAt: Number(m[2]), body: m[3]! });
  }
  return rows;
}
