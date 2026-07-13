import { describe, expect, it } from 'vitest';
import { xml } from '@xmpp/xml';

import { buildJoinPresence, buildRoomMessage, isMucJid } from './muc.js';
import { buildReceivedReceipt, isAckOrReceiptStanza, receivedReceiptId, RECEIPTS_NS, requestsReceipt } from './receipts.js';
import { buildOutboundStanza, stanzaToAgentMessage } from './message.js';
import { buildGatewayInfo, DISCO_INFO_NS } from '../agent-api-disco.js';
import { buildIqError, dispositionForStanza } from '../xmpp-component.js';

const MENTIONS_NS = 'urn:xmpp:mentions:0';
const MUC_NS = 'http://jabber.org/protocol/muc';
const STANZA_ERROR_NS = 'urn:ietf:params:xml:ns:xmpp-stanzas';

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

  it('requests zero history on join so the agent is not flooded (XEP-0045 §7.2.2)', () => {
    const p = buildJoinPresence({ roomJid: 'room@conference.test' }, 'bot@agents.test');
    const history = p.getChild('x', MUC_NS)?.getChild('history');
    expect(history?.attrs.maxstanzas).toBe('0');
  });
});

describe('disco features (XEP-0030)', () => {
  it('advertises the standard XEPs the gateway implements', () => {
    const req = xml('iq', { type: 'get', from: 'peer@test', to: 'gw.test', id: 'd1' }, xml('query', { xmlns: DISCO_INFO_NS }));
    const info = buildGatewayInfo(req, 'gw.test');
    const advertised = info
      .getChild('query', DISCO_INFO_NS)!
      .getChildren('feature')
      .map((f) => f.attrs.var);
    for (const ns of ['urn:xmpp:ping', 'urn:xmpp:receipts', 'http://jabber.org/protocol/chatstates', 'urn:xmpp:reply:0']) {
      expect(advertised).toContain(ns);
    }
  });
});

describe('IQ error fallback (RFC 6120 §8.2.3)', () => {
  it('returns service-unavailable for an unhandled get', () => {
    const req = xml('iq', { type: 'get', from: 'a@b', to: 'gw.test', id: 'q1' }, xml('unknown', { xmlns: 'urn:example:nope' }));
    const err = buildIqError(req);
    expect(err.attrs.type).toBe('error');
    expect(err.attrs.id).toBe('q1');
    expect(err.attrs.to).toBe('a@b');
    expect(err.getChild('error')?.getChild('service-unavailable', STANZA_ERROR_NS)).toBeDefined();
  });
});

describe('component IQ dispatch (dispositionForStanza)', () => {
  const iq = (type: string) => xml('iq', { type, from: 'a@b', to: 'gw.test', id: 'x' });

  it('errors on an unhandled get/set request', () => {
    expect(dispositionForStanza(iq('get')).kind).toBe('error');
    expect(dispositionForStanza(iq('set')).kind).toBe('error');
  });

  it('responds when a handler produces a reply', () => {
    const d = dispositionForStanza(iq('get'), (s) => xml('iq', { type: 'result', id: s.attrs.id }));
    expect(d.kind).toBe('respond');
  });

  it('dispatches IQ result/error responses to stanza handlers (no regression)', () => {
    // Responses to our own outbound IQs must reach onStanza consumers, not be swallowed.
    expect(dispositionForStanza(iq('result')).kind).toBe('dispatch');
    expect(dispositionForStanza(iq('error')).kind).toBe('dispatch');
  });

  it('dispatches message/presence stanzas', () => {
    expect(dispositionForStanza(xml('message', { from: 'a@b' })).kind).toBe('dispatch');
    expect(dispositionForStanza(xml('presence', { from: 'a@b' })).kind).toBe('dispatch');
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

  it('requests a receipt on 1:1 outbound but not in a MUC (XEP-0184 §5.5)', () => {
    const chat = buildOutboundStanza({ from: 'bot@agents.test', to: 'user@test', content: 'hi' }, 'bot@agents.test');
    expect(chat.getChild('request', RECEIPTS_NS)).toBeDefined();
    const groupchat = buildOutboundStanza({ from: 'bot@agents.test', to: 'room@conference.test', content: 'hi' }, 'bot@agents.test');
    expect(groupchat.getChild('request', RECEIPTS_NS)).toBeUndefined();
  });

  it('extracts the acked id from a <received/> (receivedReceiptId)', () => {
    const receipt = xml('message', { from: 'u@test', to: 'bot@agents.test' }, xml('received', { xmlns: RECEIPTS_NS, id: 'm7' }));
    expect(receivedReceiptId(receipt)).toBe('m7');
    expect(receivedReceiptId(xml('message', {}, xml('body', {}, 'hi')))).toBeNull();
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
