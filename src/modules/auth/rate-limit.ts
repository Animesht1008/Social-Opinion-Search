/**
 * Fixed-window in-memory rate limiter. Deliberately simple and dependency-free.
 * NOTE: state is per process. Behind several instances use a shared store (Redis) or the platform's edge limiter.
 */
export interface LimitResult { allowed: boolean; remaining: number; retryAfterSeconds: number }

export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private max: number, private windowMs: number, private now: () => number = Date.now) {}

  /** Records one hit for `key` and says whether it is within the limit. */
  hit(key: string): LimitResult {
    const t = this.now();
    this.sweep(t);
    let e = this.hits.get(key);
    if (!e || e.resetAt <= t) { e = { count: 0, resetAt: t + this.windowMs }; this.hits.set(key, e); }
    e.count++;
    return { allowed: e.count <= this.max, remaining: Math.max(0, this.max - e.count), retryAfterSeconds: Math.ceil((e.resetAt - t) / 1000) };
  }
  /** Check without recording (used to block a key that already failed too often). */
  peek(key: string): LimitResult {
    const t = this.now();
    const e = this.hits.get(key);
    if (!e || e.resetAt <= t) return { allowed: true, remaining: this.max, retryAfterSeconds: 0 };
    return { allowed: e.count < this.max, remaining: Math.max(0, this.max - e.count), retryAfterSeconds: Math.ceil((e.resetAt - t) / 1000) };
  }
  reset(key: string) { this.hits.delete(key); }
  private sweep(t: number) {
    if (this.hits.size < 5000) return;
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}

/** A limiter that always allows (used when RATE_LIMIT_ENABLED=false, e.g. in tests). */
export class NoLimiter extends RateLimiter {
  constructor() { super(Number.MAX_SAFE_INTEGER, 1); }
  override hit(_key?: string): LimitResult { return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, retryAfterSeconds: 0 }; }
  override peek(_key?: string): LimitResult { return this.hit(); }
}
