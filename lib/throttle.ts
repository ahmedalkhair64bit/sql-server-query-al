// Failed sign-ins per email and per client address, kept in memory: one container, and a restart only
// forgets recent failures. Per email is the real protection; the address can be forged when the server is
// reached without a proxy, but it still slows one client spraying many emails.
const WINDOW_MS = 15 * 60_000;
const LIMITS = { email: 5, ip: 30 } as const;
const failures = new Map<string, number[]>();

const recent = (key: string, now: number) =>
  (failures.get(key) ?? []).filter((t) => now - t < WINDOW_MS);

/** Seconds until the next attempt is allowed, or 0 when it is allowed now. */
export function retryAfter(
  email: string,
  ip: string,
  now = Date.now(),
): number {
  let wait = 0;
  for (const [kind, key] of [
    ["email", `e:${email}`],
    ["ip", `i:${ip}`],
  ] as const) {
    const list = recent(key, now);
    if (list.length >= LIMITS[kind])
      wait = Math.max(wait, Math.ceil((list[0] + WINDOW_MS - now) / 1000));
  }
  return wait;
}
export function recordFailure(email: string, ip: string, now = Date.now()) {
  for (const key of [`e:${email}`, `i:${ip}`])
    failures.set(key, [...recent(key, now), now]);
  if (failures.size > 50_000) failures.clear(); // bound memory under a spray of random emails
}
export function clearFailures(email: string) {
  failures.delete(`e:${email}`);
}
