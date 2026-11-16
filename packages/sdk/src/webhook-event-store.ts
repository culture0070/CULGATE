import type { WebhookEventKey, WebhookEventStore } from '@culgate/core';

export interface InMemoryWebhookEventStoreOptions {
  /**
   * How long a claim may be held before another worker may retake it, in
   * case the first worker died mid-processing. Default 5 minutes.
   */
  claimTtlMs?: number;
  /** Test seam. */
  now?: () => number;
}

type Entry =
  { state: 'processing'; claimedAt: number } | { state: 'completed' } | { state: 'failed' };

/**
 * Process-local event store for tests and local development.
 *
 * Do NOT use in production: it forgets everything on restart, grows without
 * bound, and is not shared between processes, so two instances of your
 * application would both process the same event. Implement
 * `WebhookEventStore` on your database instead (for example with a unique
 * key on account, provider, and event ID).
 */
export class InMemoryWebhookEventStore implements WebhookEventStore {
  readonly #entries = new Map<string, Entry>();
  readonly #claimTtlMs: number;
  readonly #now: () => number;

  constructor(options: InMemoryWebhookEventStoreOptions = {}) {
    this.#claimTtlMs = options.claimTtlMs ?? 5 * 60_000;
    this.#now = options.now ?? Date.now;
  }

  async claim(input: WebhookEventKey): Promise<boolean> {
    // Check-and-set happens synchronously, so it is atomic within a process.
    const key = toKey(input);
    const entry = this.#entries.get(key);
    const now = this.#now();
    const available =
      entry === undefined ||
      entry.state === 'failed' ||
      (entry.state === 'processing' && now - entry.claimedAt >= this.#claimTtlMs);
    if (available) this.#entries.set(key, { state: 'processing', claimedAt: now });
    return available;
  }

  async markCompleted(input: WebhookEventKey): Promise<void> {
    this.#entries.set(toKey(input), { state: 'completed' });
  }

  async markFailed(input: WebhookEventKey): Promise<void> {
    this.#entries.set(toKey(input), { state: 'failed' });
  }
}

function toKey({ accountId, provider, eventId }: WebhookEventKey): string {
  return JSON.stringify([accountId, provider, eventId]);
}
