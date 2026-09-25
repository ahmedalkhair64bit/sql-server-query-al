import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// The analyst base URL is typed by a user and the server fetches it. Loopback and private networks stay
// allowed (Ollama and vLLM live there); what no model server ever lives on is the link-local range, where
// cloud metadata services hand out instance credentials (169.254.169.254 on GCP, AWS and Azure).
const METADATA_HOSTS = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
]);

/** True for addresses no model server uses: link-local (v4 and v6), unspecified, and known metadata IPs. */
export function isBlockedAddress(ip: string): boolean {
  const a = ip.toLowerCase().replace(/^::ffff:/, "");
  if (isIP(a) === 4) {
    const [p, q] = a.split(".").map(Number);
    return (
      (p === 169 && q === 254) || p === 0 || a === "100.100.100.200" // Alibaba metadata
    );
  }
  if (isIP(a) === 6)
    return /^fe[89ab]/.test(a) || a === "::" || a.startsWith("fd00:ec2:");
  return false;
}

/** The checks that need no DNS: for immediate feedback when the URL is saved. */
export function staticUrlProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "The base URL is not a valid URL.";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    return "The base URL must start with http:// or https://.";
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (METADATA_HOSTS.has(host) || isBlockedAddress(host))
    return `${u.host} is a link-local or cloud metadata address; model servers never run there.`;
  return null;
}

/** Why the server refuses to call this URL, or null when it may. Also resolves the host name. */
export async function modelUrlProblem(url: string): Promise<string | null> {
  const problem = staticUrlProblem(url);
  if (problem) return problem;
  const u = new URL(url);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return null;
  try {
    const addrs = await lookup(host, { all: true });
    if (addrs.some((a) => isBlockedAddress(a.address)))
      return `${u.host} resolves to a link-local or cloud metadata address; model servers never run there.`;
  } catch {
    // Unresolvable hosts fail in fetch with their own clear error.
  }
  return null;
}

/** fetch for user-configured model URLs: refuses metadata targets and never follows a redirect there. */
export const guardedFetch: typeof fetch = async (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const problem = await modelUrlProblem(url);
  if (problem) throw new Error(problem);
  return fetch(input, { ...init, redirect: "error" });
};
