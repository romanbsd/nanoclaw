import { describe, expect, it } from 'vitest';
import { xml } from '@xmpp/xml';

import { buildJoinPresence, buildRoomMessage, isMucJid } from './muc.js';
import { buildSlotRequest, sha256Hex } from './file-upload.js';
import { buildReceivedReceipt } from './receipts.js';

describe('muc plugin', () => {
  it('builds join presence', () => {
    const p = buildJoinPresence({ roomJid: 'room@conference.test' }, 'bot@agents.test');
    expect(p.name).toBe('presence');
    expect(p.attrs.to).toBe('room@conference.test/bot');
  });

  it('identifies conference JIDs', () => {
    expect(isMucJid('x@conference.example')).toBe(true);
  });

  it('builds groupchat message', () => {
    const m = buildRoomMessage({ roomJid: 'room@conference.test', body: 'hi' }, 'bot@agents.test');
    expect(m.attrs.type).toBe('groupchat');
  });
});

describe('file-upload plugin', () => {
  it('builds slot request IQ', () => {
    const iq = buildSlotRequest('bot@test', 'upload.test', 100, 'text/plain', 'a.txt');
    expect(iq.name).toBe('iq');
    expect(iq.getChild('request', 'urn:xmpp:http:upload:0')).toBeDefined();
  });

  it('computes sha256', () => {
    expect(sha256Hex(Buffer.from('hello'))).toHaveLength(64);
  });
});

describe('receipts plugin', () => {
  it('builds delivery receipt', () => {
    const r = buildReceivedReceipt('user@test', 'bot@agents.test', 'msg-1');
    expect(r.getChild('received', 'urn:xmpp:receipts')).toBeDefined();
  });
});
