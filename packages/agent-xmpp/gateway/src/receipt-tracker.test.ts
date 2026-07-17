import { describe, expect, it } from 'vitest';
import { xml } from '@xmpp/xml';

import { ReceiptTracker } from './receipt-tracker.js';

const msg = (id: string) => xml('message', { id, type: 'chat' });

describe('ReceiptTracker (XEP-0184)', () => {
  it('ack clears a pending message; no resend fires', () => {
    const t = new ReceiptTracker({ timeoutMs: 1000, maxResends: 2 });
    t.register('m1', msg('m1'), 0);
    t.ack('m1');
    expect(t.size).toBe(0);
    expect(t.due(10_000).resend).toEqual([]);
  });

  it('does not resend before the timeout elapses', () => {
    const t = new ReceiptTracker({ timeoutMs: 1000, maxResends: 2 });
    t.register('m1', msg('m1'), 0);
    expect(t.due(500).resend).toEqual([]);
    expect(t.size).toBe(1);
  });

  it('resends after timeout, then gives up at the cap', () => {
    const t = new ReceiptTracker({ timeoutMs: 1000, maxResends: 2 });
    t.register('m1', msg('m1'), 0);

    // 1st timeout -> resend #1, re-armed
    let sweep = t.due(1000);
    expect(sweep.resend).toHaveLength(1);
    expect(sweep.gaveUp).toEqual([]);
    expect(t.size).toBe(1);

    // 2nd timeout -> resend #2
    sweep = t.due(2000);
    expect(sweep.resend).toHaveLength(1);
    expect(t.size).toBe(1);

    // 3rd timeout -> cap reached, give up
    sweep = t.due(3000);
    expect(sweep.resend).toEqual([]);
    expect(sweep.gaveUp).toEqual(['m1']);
    expect(t.size).toBe(0);
  });

  it('maxResends=0 means observe-only: gives up on first timeout, never resends', () => {
    const t = new ReceiptTracker({ timeoutMs: 1000, maxResends: 0 });
    t.register('m1', msg('m1'), 0);
    const sweep = t.due(1000);
    expect(sweep.resend).toEqual([]);
    expect(sweep.gaveUp).toEqual(['m1']);
  });

  it('clear() drops pending state so a restart cannot resend prior-session stanzas', () => {
    const t = new ReceiptTracker({ timeoutMs: 1000, maxResends: 2 });
    t.register('m1', msg('m1'), 0);
    t.register('m2', msg('m2'), 0);
    t.clear();
    expect(t.size).toBe(0);
    expect(t.due(10_000).resend).toEqual([]);
  });

  it('ignores empty ids', () => {
    const t = new ReceiptTracker({ timeoutMs: 1000, maxResends: 2 });
    t.register('', msg('x'), 0);
    expect(t.size).toBe(0);
  });
});
