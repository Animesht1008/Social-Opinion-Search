/** Minimal cookie helpers (no dependency): enough for one HttpOnly session cookie. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && !(k in out)) {
      try { out[k] = decodeURIComponent(v); } catch { /* ignore malformed */ }
    }
  }
  return out;
}

export interface CookieOptions { maxAgeSeconds?: number; secure: boolean }

/**
 * HttpOnly (JS cannot read it -> XSS cannot steal it), SameSite=Lax (not sent on cross-site POSTs -> CSRF defence),
 * Path=/. When Secure, the "__Host-" prefix additionally forbids a Domain attribute and requires HTTPS + Path=/.
 */
export function cookieName(secure: boolean): string {
  return secure ? "__Host-sos_session" : "sos_session";
}

export function buildSessionCookie(value: string, o: CookieOptions): string {
  const parts = [`${cookieName(o.secure)}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (o.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(o.maxAgeSeconds))}`);
  if (o.secure) parts.push("Secure");
  return parts.join("; ");
}

export const clearSessionCookie = (secure: boolean): string => buildSessionCookie("", { secure, maxAgeSeconds: 0 });
