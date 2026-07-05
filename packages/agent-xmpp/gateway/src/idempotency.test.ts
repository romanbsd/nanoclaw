import { describe, expect, it } from 'vitest';

import { Mailbox } from './mailbox.js';

function sqliteAvailable(): boolean {
  try {
    const m = new Mailbox(`${process.cwd()}/data/probe-${Date.now()}`);
    m.close();
    return true;
    // eslint-disable-next-line no-catch-all/no-catch-all -- sqlite probe; absence means skip tests
  } catch {
    return false;
  }
}

describe.skipIf(!sqliteAvailable())('gateway idempotency', () => {
  it('marks redelivery for duplicate stanza after ack path', () => {
    const dir = `${process.cwd()}/data/test-mailbox-${Date.now()}`;
    const mailbox = new Mailbox(dir);
    mailbox.enqueue('s1', 'a@test', '{}');
    mailbox.markDelivered('s1');
    mailbox.markRedelivered('s1');
    const second = mailbox.enqueue('s1', 'a@test', '{}');
    expect(second.isDuplicate).toBe(true);
    expect(second.redelivered).toBe(true);
    mailbox.close();
  });
});
