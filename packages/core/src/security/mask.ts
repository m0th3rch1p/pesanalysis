/** Mask phone numbers except the last three digits before showing or exporting message text. */
export function maskPhones(text: string): string {
  return String(text ?? "").replace(/(?:\+?254|0)?([17]\d{8})\b/g, (_m, digits: string) => `•••${digits.slice(-3)}`);
}

export function last3(sender: string): string {
  const digits = sender.replace(/\D/g, "");
  return digits.length >= 3 ? digits.slice(-3) : sender;
}
