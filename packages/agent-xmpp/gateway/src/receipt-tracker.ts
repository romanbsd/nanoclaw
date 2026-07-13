/**
 * XEP-0184 outbound delivery-receipt tracking.
 *
 * A component send only tells us the server accepted the stanza, not that the peer
 * received it. For 1:1 messages that carry a <request/>, we register the stanza here;
 * when the peer returns <received/> we `ack` it, and messages left un-acked past the
 * timeout are handed back by `due` for a bounded number of resends. Resends reuse the
 * same stanza (same id + origin-id), so conformant peers dedup per XEP-0184 §8.
 *
 * Pure and synchronous — no timers, no IO — so it unit-tests without a live connection.
 *
 * @see https://xmpp.org/extensions/xep-0184.html
 */
import type { Element } from '@xmpp/xml';

interface PendingReceipt {
  stanza: Element;
  sentAt: number;
  attempts: number;
}

export interface ReceiptTrackerOptions {
  timeoutMs: number;
  maxResends: number;
}

/** What a sweep produced: stanzas to resend now, and ids we've given up on. */
export interface ReceiptSweep {
  resend: Element[];
  gaveUp: string[];
}

export class ReceiptTracker {
  private readonly pending = new Map<string, PendingReceipt>();

  constructor(private readonly options: ReceiptTrackerOptions) {}

  /** Record a receipt-requested send keyed by its stanza id. */
  register(id: string, stanza: Element, now: number = Date.now()): void {
    if (!id) return;
    this.pending.set(id, { stanza, sentAt: now, attempts: 0 });
  }

  /** Peer confirmed delivery of `id`; stop tracking it. */
  ack(id: string): void {
    this.pending.delete(id);
  }

  /** Drop all pending state — called on gateway stop so a restart can't resend a prior session's stanzas. */
  clear(): void {
    this.pending.clear();
  }

  /**
   * Entries whose timeout has elapsed: each still under the resend cap is re-armed and
   * returned in `resend`; each at the cap is dropped and returned in `gaveUp`.
   */
  due(now: number = Date.now()): ReceiptSweep {
    const resend: Element[] = [];
    const gaveUp: string[] = [];
    for (const [id, entry] of this.pending) {
      if (now - entry.sentAt < this.options.timeoutMs) continue;
      if (entry.attempts >= this.options.maxResends) {
        this.pending.delete(id);
        gaveUp.push(id);
        continue;
      }
      entry.attempts += 1;
      entry.sentAt = now;
      resend.push(entry.stanza);
    }
    return { resend, gaveUp };
  }

  /** Number of messages still awaiting a receipt (for tests / diagnostics). */
  get size(): number {
    return this.pending.size;
  }
}
