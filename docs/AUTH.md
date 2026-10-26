# Authentication, sessions and account security

Real accounts replaced the earlier demo header (`x-user-id`). This document explains the design, the threat model it
answers, every endpoint, and what is **not** covered. Everything described here is implemented in `src/modules/auth/`,
`src/routes/auth.ts`, `src/routes/account.ts` and `src/routes/security.ts` and is covered by
`tests/unit/auth.test.ts` and `tests/integration/auth.test.ts`.

## 1. Design in one paragraph
A user registers with an email, a password and a display name. The password is hashed with **scrypt** (memory-hard KDF
built into Node). Signing in creates a **server-side session**: a 256-bit random opaque token; only its **SHA-256** is stored.
Browsers receive the token in an **HttpOnly, SameSite=Lax** cookie (`__Host-` prefix and `Secure` in production); API/CLI
clients can ask for the token in the response body (`"mode": "token"`) and send `Authorization: Bearer …`.
Authorization (who may see which opinion) is unchanged and still enforced in SQL — authentication now simply supplies a
*verified* user id to it.

## 2. Why these choices

| decision | alternative | reason |
|---|---|---|
| scrypt via `node:crypto` | bcrypt / argon2 packages | No native build step (important for Docker/PaaS), memory-hard, parameters stored in the hash so cost can be raised later and old hashes upgraded transparently on next login. Argon2id is the current first choice in OWASP guidance; scrypt is an accepted alternative. Cost N=2^15, r=8, p=1 (~32 MiB, ~70 ms here). |
| Opaque server-side sessions | JWT | Instant revocation (logout, password change, disable account, "sign out everywhere"), nothing to leak by decoding the token, no signing-key management. Cost: one DB lookup per request (indexed primary key). |
| Store SHA-256(token) | store token | A read-only database leak does not yield usable sessions. SHA-256 (not a slow hash) is appropriate because the token has 256 bits of entropy. |
| HttpOnly cookie for the browser | token in `localStorage` | JavaScript (including injected script) cannot read the cookie, so an XSS bug cannot steal the session. |
| `SameSite=Lax` + Origin check + JSON-only bodies | CSRF tokens | Cross-site form posts are not sent the cookie; every unsafe cookie-authenticated request with a foreign `Origin` (or `Sec-Fetch-Site: cross-site`) is rejected with 403; bearer-token requests are exempt because the credential is not ambient. |
| Strict CSP, no inline script/style | — | Limits the damage of any injection bug; the UI is written to comply (styles set through CSSOM, handlers via `addEventListener`). |
| In-memory rate limiter | Redis / edge limiter | Zero dependencies. **Per process**; see limitations. |

## 3. Flows

### Registration (`POST /api/v1/auth/register`)
1. Zod validates `{ email, password, displayName, mode? }` (strict: unknown fields rejected). Email is trimmed/lower-cased.
2. Registration can be closed with `AUTH_ALLOW_REGISTRATION=false` (403 `REGISTRATION_CLOSED`).
3. Password policy: 10–128 chars, not in a small common-password list, ≥5 distinct characters, must not contain the email name or display name.
4. Duplicate email → 409 `EMAIL_TAKEN` (including a race between two registrations — the DB unique index is the arbiter).
5. Hash, insert, create session, set cookie (or return token). IP-based limit: 10 registrations/hour.

### Sign-in (`POST /api/v1/auth/login`)
1. IP limit: 30 attempts / 15 min. Per-(email, IP) **failure** limit: 5 / 15 min → `429` + `Retry-After`; while locked out even the right password is refused.
2. Credentials are checked in constant time. For an unknown/disabled account a throw-away hash is verified, so response *time* does not reveal whether an email exists. The error is identical (`401 INVALID_CREDENTIALS`, "Invalid email or password.") for unknown email, wrong password and disabled account.
3. On success: `lastLoginAt` updated; hashes created with weaker parameters are re-hashed with the current cost; a session is created; the failure counter resets.

### Requests
`getSession()` reads `Authorization: Bearer …` or the session cookie, hashes the token, loads the session + user, checks `expiresAt > now` and `isActive`, and (at most every 5 minutes) bumps `lastUsedAt`. There is no other way to authenticate — the old `x-user-id` header is ignored (tested).

### Other endpoints
| endpoint | behaviour |
|---|---|
| `GET /api/v1/auth/config` | public: registration open?, password minimum, session lifetime, demo accounts (non-production only) |
| `GET /api/v1/auth/me` | current user + session expiry |
| `POST /api/v1/auth/logout` | revokes this session, clears the cookie; idempotent (204) |
| `POST /api/v1/auth/logout-all` | revokes every session of the user |
| `POST /api/v1/auth/password` | needs the current password; applies the policy; **revokes all other sessions** |
| `DELETE /api/v1/auth/account` | needs the password; deletes the account and (by `ON DELETE CASCADE`) sessions, relationships, opinions with their aspects and embeddings, and search runs |

## 4. HTTP hardening (`src/routes/security.ts`)
* `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`
* `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, a restrictive `Permissions-Policy`.
* `Strict-Transport-Security` when cookies are `Secure`.
* `Cache-Control: no-store` for `/api/*` and `/health`.
* Request body limit 16 KB; malformed JSON → 400; an *empty* JSON body is treated as `{}`.
* Errors never leak internals (generic 500); unknown-user and not-yours cases return 404 so ids cannot be probed.

## 5. Social graph management (what makes identity matter)
Authenticated users manage their own graph (`src/routes/social.ts`): search people by name (accounts only, ≥3 letters), send/accept/decline/cancel/remove requests, edit type and closeness, block/unblock. **The inner circle is therefore produced by users' own accepted requests and closeness settings**, then evaluated by the same rule as before (ACCEPTED + type ∈ `INNER_CIRCLE_TYPES` + closeness ≥ `INNER_CIRCLE_MIN_CLOSENESS`).
* Blocking deletes any existing relationship, hides the blocked user's content (even PUBLIC) from the blocker, and makes the blocker indistinguishable from "no such user" to the blocked user.
* Closeness is a single shared number per relationship (either party may edit it).
* Users can post opinions with a visibility level; they can delete only their own, only user-generated ones.

## 6. Operations
* Demo accounts: `npm run db:seed` creates `riya|aman|zoya@demo.example` (synthetic users) when `SEED_DEMO_LOGINS=true`, with `DEMO_PASSWORD` or a random password printed once. **Set `SEED_DEMO_LOGINS=false` for public deployments.**
* No email is sent by this system, so **there is no self-service password reset**. Recovery path: `USER_PASSWORD='new-long-passphrase' npm run user:admin -- set-password someone@example.com` (revokes all their sessions). Other commands: `create`, `disable`, `enable`, `list`.
* Behind a proxy/PaaS set `TRUST_PROXY=true` (correct client IPs for rate limits; honours `X-Forwarded-Host` in the CSRF check). Optionally set `PUBLIC_ORIGIN`.
* Sessions: 7 days by default (`AUTH_SESSION_TTL_HOURS`), fixed lifetime (no sliding extension), expired rows purged opportunistically.

## 7. Verified vs not verified
Verified by automated tests (against a real PostgreSQL): hashing/verification, policy, token hashing in the DB, cookie attributes, bearer mode, enumeration-resistant login, lockout + `Retry-After`, logout/logout-all/password-change revocation, expiry, disabled accounts, cascade delete, CSRF origin checks (including the default-port case), security headers, closed registration, secure-cookie mode, per-user search/write rate limits, and the legacy header no longer working. A headless-Chromium run confirmed the cookie is HttpOnly/SameSite=Lax/unreadable by script and that the UI triggers **no CSP violations**.

**Not verified / not provided:** behaviour behind a real HTTPS proxy; email verification; password reset by email; multi-factor authentication; breached-password lookup (only a tiny built-in common-password list); account lockout shared across instances; audit logging; a penetration test.

## 8. Known limitations (be honest about these)
1. **Per-process rate limiting.** With N instances an attacker gets N× the budget. Use a shared store or an edge limiter for production scale.
2. **No email verification** — anyone can register any email address (including someone else's); nothing proves ownership. Friend requests by email therefore only prove the address exists as a registered string.
3. **Registration reveals whether an email is registered** (409). This trade-off was chosen over a silent success because there is no email channel to deliver "check your inbox".
4. **No MFA, no device management UI** (only "sign out everywhere").
5. Password policy is intentionally light (NIST-style: length + denylist, no composition rules).
6. Sessions have a fixed lifetime; there is no "remember me"/sliding option.
7. The CSRF defence relies on `Origin`/`Sec-Fetch-Site` being sent by modern browsers plus `SameSite=Lax`; very old browsers are not a target.
8. Display names are unique-less and user-chosen: impersonation by name is possible.
