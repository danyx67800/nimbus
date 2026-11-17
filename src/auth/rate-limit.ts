interface WindowEntry {
  timestamps: number[];
}

export class RateLimiter {
  private readonly windows = new Map<string, WindowEntry>();
  private lastCleanup = Date.now();

  hit(key: string, limit: number, windowMs: number): { allowed: boolean; retryAfter: number; remaining: number } {
    const now = Date.now();
    this.maybeCleanup(now);
    let entry = this.windows.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      this.windows.set(key, entry);
    }
    const cutoff = now - windowMs;
    entry.timestamps = entry.timestamps.filter((timestamp) => timestamp > cutoff);
    if (entry.timestamps.length >= limit) {
      const oldest = entry.timestamps[0] ?? now;
      return {
        allowed: false,
        retryAfter: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
        remaining: 0,
      };
    }
    entry.timestamps.push(now);
    return { allowed: true, retryAfter: 0, remaining: limit - entry.timestamps.length };
  }

  reset(key: string): void {
    this.windows.delete(key);
  }

  private maybeCleanup(now: number): void {
    if (now - this.lastCleanup < 60_000) return;
    this.lastCleanup = now;
    for (const [key, entry] of this.windows) {
      if (entry.timestamps.every((timestamp) => now - timestamp > 60 * 60 * 1000)) this.windows.delete(key);
    }
  }
}

interface LockoutState {
  failures: number;
  lockedUntil: number;
  lastFailure: number;
}

/**
 * Progressive lockout per (IP, username). Delays are intentionally not
 * exposed to the client: every failed login gets the same generic answer.
 */
export class LoginLockout {
  private readonly states = new Map<string, LockoutState>();

  constructor(
    private readonly maxFailures = 5,
    private readonly baseDelayMs = 30_000,
  ) {}

  check(key: string): { locked: boolean; retryAfter: number } {
    const state = this.states.get(key);
    if (!state) return { locked: false, retryAfter: 0 };
    if (state.lockedUntil > Date.now()) {
      return { locked: true, retryAfter: Math.ceil((state.lockedUntil - Date.now()) / 1000) };
    }
    return { locked: false, retryAfter: 0 };
  }

  fail(key: string): void {
    const now = Date.now();
    const state = this.states.get(key) ?? { failures: 0, lockedUntil: 0, lastFailure: now };
    state.failures += 1;
    state.lastFailure = now;
    if (state.failures >= this.maxFailures) {
      const exponent = Math.min(state.failures - this.maxFailures, 5);
      state.lockedUntil = now + Math.min(this.baseDelayMs * 2 ** exponent, 15 * 60_000);
    }
    this.states.set(key, state);
  }

  succeed(key: string): void {
    this.states.delete(key);
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, state] of this.states) {
      if (state.lockedUntil < now && now - state.lastFailure > 24 * 60 * 60 * 1000) this.states.delete(key);
    }
  }
}
