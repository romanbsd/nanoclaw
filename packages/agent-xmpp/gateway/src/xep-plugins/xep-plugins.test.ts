import { describe, expect, it } from 'vitest';
import { xml } from '@xmpp/xml';

import { buildJoinPresence, buildRoomMessage, isMucJid } from './muc.js';
import { buildReceivedReceipt, isAckOrReceiptStanza, requestsReceipt } from './receipts.js';
import { stanzaToAgentMessage } from './message.js';

const RECEIPTS_NS = 'urn:xmpp:receipts';
const MENTIONS_NS = 'urn:xmpp:mentions:0';

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

describe('receipts plugin', () => {
  it('builds delivery receipt', () => {
    const r = buildReceivedReceipt('user@test', 'bot@agents.test', 'msg-1');
    expect(r.getChild('received', 'urn:xmpp:receipts')).toBeDefined();
  });

  it('detects receipt stanzas without body', () => {
    const r = buildReceivedReceipt('user@test', 'bot@agents.test', 'msg-1');
    expect(isAckOrReceiptStanza(r)).toBe(true);
    const chat = xml('message', { type: 'chat', from: 'a@b', to: 'c@d' }, xml('body', {}, 'hi'));
    expect(isAckOrReceiptStanza(chat)).toBe(false);
  });

  it('acks only when a receipt was requested (XEP-0184)', () => {
    const plain = xml('message', { type: 'chat', from: 'a@b', to: 'c@d' }, xml('body', {}, 'hi'));
    expect(requestsReceipt(plain)).toBe(false);
    const asked = xml(
      'message',
      { type: 'chat', from: 'a@b', to: 'c@d' },
      xml('body', {}, 'hi'),
      xml('request', { xmlns: RECEIPTS_NS }),
    );
    expect(requestsReceipt(asked)).toBe(true);
  });
});

describe('XEP-0513 mentions', () => {
  it('captures occupant-id-addressed mentions in MUC (not just jid)', () => {
    const stanza = xml(
      'message',
      { type: 'groupchat', from: 'room@conference.test/nick', to: 'bot@agents.test' },
      xml('body', {}, 'Hello, bot!'),
      xml('mention', { xmlns: MENTIONS_NS, begin: '7', end: '10', occupantid: 'occ-42' }),
    );
    const msg = stanzaToAgentMessage(stanza, 'agents.test');
    expect(msg?.extensions?.mentions).toEqual(['occ-42']);
  });
});
