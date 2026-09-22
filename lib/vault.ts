import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

function key() {
  const s = process.env.APP_SECRET;
  if (!s || s.length < 16) throw new Error("APP_SECRET is missing or shorter than 16 chars — set it in .env");
  return scryptSync(s, "qai-vault-v1", 32);
}
export function seal(plain: string): string {
  if (!plain) return "";
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `${iv.toString("hex")}.${c.getAuthTag().toString("hex")}.${ct.toString("hex")}`;
}
export function open(sealed: string): string {
  if (!sealed) return "";
  try {
    const [iv, tag, ct] = sealed.split(".");
    const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "hex"), { authTagLength: 16 });
    d.setAuthTag(Buffer.from(tag, "hex"));
    return Buffer.concat([d.update(Buffer.from(ct, "hex")), d.final()]).toString("utf8");
  } catch { return ""; }
}
export const mask = (v: string) => (v ? `••••${v.slice(-4)}` : "");
