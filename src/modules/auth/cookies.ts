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
