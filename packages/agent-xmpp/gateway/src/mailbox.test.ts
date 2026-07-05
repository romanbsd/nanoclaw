import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { Mailbox } from './mailbox.js';

function canOpenMailbox(): boolean {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xmpp-mailbox-probe-'));
    const m = new Mailbox(dir);
    m.close();
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
    // eslint-disable-next-line no-catch-all/no-catch-all -- mailbox probe; absence means skip tests
  } catch {
    return false;
  }
}

const sqliteOk = canOpenMailbox();

describe.skipIf(!sqliteOk)('Mailbox idempotency', () => {
  let tmpDir: string;
  let mailbox: Mailbox;

  afterEach(() => {
    mailbox?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('deduplicates by stanza_id', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xmpp-mailbox-'));
    mailbox = new Mailbox(tmpDir);
    const first = mailbox.enqueue('stanza-1', 'a@agents.test', '{"id":"stanza-1"}');
    const second = mailbox.enqueue('stanza-1', 'a@agents.test', '{"id":"stanza-1"}');
    expect(first.isDuplicate).toBe(false);
    expect(second.isDuplicate).toBe(true);
  });

  it('resolves stored agent message for reply routing', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xmpp-mailbox-'));
    mailbox = new Mailbox(tmpDir);
    const payload = JSON.stringify({
      id: 'stanza-1',
      from: 'human@example.com',
      to: 'a@agents.test',
      kind: 'text',
      contentType: 'text/plain',
      body: 'hi',
    });
    mailbox.enqueue('stanza-1', 'a@agents.test', payload);
    const msg = mailbox.resolveMessage('stanza-1');
    expect(msg?.from).toBe('human@example.com');
  });

  it('lists pending and delivered rows for redelivery sweep', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xmpp-mailbox-'));
    mailbox = new Mailbox(tmpDir);
    mailbox.enqueue('s-pending', 'a@agents.test', '{"id":"s-pending"}');
    mailbox.enqueue('s-delivered', 'a@agents.test', '{"id":"s-delivered"}');
    mailbox.markDelivered('s-delivered');
    mailbox.markAcked('s-other', 'acked');

    const rows = mailbox.listForRedelivery();
    const ids = rows.map((r) => r.stanzaId).sort();
    expect(ids).toEqual(['s-delivered', 's-pending']);
  });
});
