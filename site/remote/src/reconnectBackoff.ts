export const RECONNECT_BASE_DELAY_MS = 1_000;
export const RECONNECT_MAX_DELAY_MS = 30_000;
/**
 * Two phones waking from the same push, or one phone whose OS delivers a burst
 * of focus/visibility events, must not renegotiate in lockstep.
 */
export const RECONNECT_JITTER_RATIO = 0.25;
const MAX_BACKOFF_EXPONENT = 20;

export interface ReconnectBackoffOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  /** Injectable for deterministic tests; must return a value in [0, 1). */
  random?: () => number;
}

/**
 * Paces repeated transport rebuilds.
 *
 * A mobile page receives focus and visibility events far more often than a
 * user actually switches apps, and `ForegroundResumeCoordinator` keeps asking
 * for a resume until one succeeds. Without pacing, an unreachable desktop turns
 * that into a renegotiation storm: every event pays a full WebRTC offer, ICE
 * gathering, and relay fallback. Delay only *repeat* failures — the first
 * attempt after a healthy connection is always immediate, so the common case
 * (a brief app switch) stays instant.
 */
export class ReconnectBackoff {
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly jitterRatio: number;
  private readonly random: () => number;
  private failures = 0;

  constructor(options: ReconnectBackoffOptions = {}) {
    this.baseDelayMs = options.baseDelayMs ?? RECONNECT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? RECONNECT_MAX_DELAY_MS;
    this.jitterRatio = options.jitterRatio ?? RECONNECT_JITTER_RATIO;
    this.random = options.random ?? Math.random;
  }

  /** How long to wait before the next attempt. Zero while no attempt failed. */
  delayMs(): number {
    if (this.failures === 0) {
      return 0;
    }
    const exponential = Math.min(
      this.maxDelayMs,
      this.baseDelayMs * 2 ** (this.failures - 1),
    );
    const jitter = exponential * this.jitterRatio * this.random();
    return Math.round(Math.min(this.maxDelayMs, exponential + jitter));
  }

  recordFailure(): void {
    // The delay is clamped by `maxDelayMs` anyway; cap the counter so a long
    // outage cannot grow the exponent until `2 ** n` stops being finite.
    if (this.failures < MAX_BACKOFF_EXPONENT) {
      this.failures += 1;
    }
  }

  recordSuccess(): void {
    this.failures = 0;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }
}
