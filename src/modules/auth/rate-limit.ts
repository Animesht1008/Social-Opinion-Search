export interface LimitResult { allowed: boolean; remaining: number; retryAfterSeconds: number }

export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private max: number, private windowMs: number, private now: () => number = Date.now) {}

  hit(key: string): LimitResult {
    const t = this.now();
    this.sweep(t);
    let e = this.hits.get(key);
    if (!e || e.resetAt <= t) { e = { count: 0, resetAt: t + this.windowMs }; this.hits.set(key, e); }
    e.count++;
    return { allowed: e.count <= this.max, remaining: Math.max(0, this.max - e.count), retryAfterSeconds: Math.ceil((e.resetAt - t) / 1000) };
  }
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

export class NoLimiter extends RateLimiter {
  constructor() { super(Number.MAX_SAFE_INTEGER, 1); }
  override hit(_key?: string): LimitResult { return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, retryAfterSeconds: 0 }; }
  override peek(_key?: string): LimitResult { return this.hit(); }
}
