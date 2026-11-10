export interface AdmissionRetryPolicyOptions {
  /** Total join attempts, including the first. 1 disables retries. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Exponential backoff for re-dispatching a bot after a retryable join
 * failure — most commonly the host not admitting it from the waiting room in
 * time, or the meeting not having started yet. Non-retryable failures (bad
 * link, meeting locked, provider rejected the request) never consult this.
 */
export class AdmissionRetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;

  constructor(options: AdmissionRetryPolicyOptions = {}) {
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.baseDelayMs = options.baseDelayMs ?? 30_000;
    this.maxDelayMs = options.maxDelayMs ?? 5 * 60_000;
  }

  /** `attemptsMade` = join attempts already dispatched (>= 1 after the first). */
  shouldRetry(attemptsMade: number): boolean {
    return attemptsMade < this.maxAttempts;
  }

  /** Delay before attempt number `attemptsMade + 1`. */
  delayBeforeNextAttemptMs(attemptsMade: number): number {
    const exponent = Math.max(0, attemptsMade - 1);
    return Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** exponent);
  }
}
