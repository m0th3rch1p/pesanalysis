import type { SmsMessage } from "@yako/core";

/**
 * Synthetic demo feed. Every message below is invented; names and numbers are
 * fake. It exists because a release build cannot accept adb-injected SMS and
 * the offline demo must not depend on a carrier. It goes through the SAME
 * ingestSms() path as a real SMS (WORKSTREAMS "Must-build early").
 *
 * Balances are internally consistent so the chain audit shows "ok", including
 * a Fuliza draw with no balance line followed by a repay that re-anchors.
 * Formats follow the templates verified against the real inbox (see SPIKES.md).
 */

const pad = (n: number) => String(n).padStart(2, "0");

function eat(offsetMin: number): { d: string; t12: string; t24: string; at: number } {
  const at = Date.now() - offsetMin * 60_000;
  const e = new Date(at + 3 * 3600_000); // Africa/Nairobi, no DST
  const d = `${pad(e.getUTCDate())}/${pad(e.getUTCMonth() + 1)}/${String(e.getUTCFullYear()).slice(2)}`;
  const h24 = e.getUTCHours();
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 || 12;
  return {
    d,
    t12: `${h12}:${pad(e.getUTCMinutes())} ${ampm}`,
    t24: `${pad(h24)}:${pad(e.getUTCMinutes())}`,
    at,
  };
}

export function demoFeed(): SmsMessage[] {
  const m = (offset: number, body: string): SmsMessage => {
    const x = eat(offset);
    return { sender: "MPESA", body: body.replace("{D}", x.d).replace("{T}", x.t12), receivedAt: x.at };
  };
  const a = (offset: number, body: string): SmsMessage => {
    const x = eat(offset);
    return { sender: "Airtel", body: body.replace("{D}", x.d).replace("{T}", x.t24), receivedAt: x.at };
  };
  return [
    m(240, "QGH7X8Y2Z1 Confirmed. You have received Ksh2,000.00 from JOHN OTIENO 254711000111 on {D} at {T}. New M-PESA balance is Ksh2,000.00. Transaction cost, Ksh0.00."),
    m(210, "QGH7X8Y2Z2 Confirmed. Ksh500.00 sent to MAMA NJERI 254722000222 on {D} at {T}. New M-PESA balance is Ksh1,487.00. Transaction cost, Ksh13.00."),
    m(180, "QGH7X8Y2Z3 Confirmed. Ksh200.00 paid to KPLC PREPAID. Account 12345678 on {D} at {T}. New M-PESA balance is Ksh1,287.00. Transaction cost, Ksh0.00."),
    m(150, "QGH7X8Y2Z4 Confirmed. Ksh350.00 paid to NAIVAS SUPERMARKET. on {D} at {T}. New M-PESA balance is Ksh937.00. Transaction cost, Ksh0.00."),
    m(120, "QGH7X8Y2Z5 Confirmed. You have withdrawn Ksh500.00 from Agent 001234 on {D} at {T}. New M-PESA balance is Ksh408.00. Transaction cost, Ksh29.00."),
    m(90, "QGH7X8Y2Z6 Confirmed. You have received Ksh1,200.00 from GRACE WANJIKU 254733000333 on {D} at {T}. New M-PESA balance is Ksh1,608.00. Transaction cost, Ksh0.00."),
    m(60, "QGH7X8Y2Z7 Confirmed. You bought Ksh100.00 of airtime on {D} at {T}. New M-PESA balance is Ksh1,508.00. Transaction cost, Ksh0.00."),
    m(30, "QGH7X8Y2Z8 Confirmed. Fuliza M-PESA amount is Ksh500.00. Access fee charged Ksh0.00. Outstanding Fuliza M-PESA amount is Ksh500.00. Repay to unlock more."),
    m(20, "QGH7X8Y2Z9 Confirmed. Ksh520.00 from your M-PESA has been used to fully pay your outstanding Fuliza M-PESA. Your M-PESA balance is Ksh1,488.00. Transaction cost, Ksh0.00."),
    m(10, "QGH7X8Y2ZA Confirmed. Ksh1,000.00 sent to PETER KAMAU 254744000444 on {D} at {T}. New M-PESA balance is Ksh475.00. Transaction cost, Ksh13.00."),
    m(5, "QGH7X8Y2ZB Confirmed. You have received Ksh2,500.00 from FAITH ACHIENG 254755000555 on {D} at {T}. New M-PESA balance is Ksh2,975.00. Transaction cost, Ksh0.00."),
    a(45, "TID: AIR7X8Y2Z1. You have received Ksh150.00 from BRIAN OCHIENG 254766000666 on {D} at {T}. Fee Ksh0.00. Bal Ksh150.00."),
  ];
}
