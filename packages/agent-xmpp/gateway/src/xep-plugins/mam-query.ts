/** Async MAM result collector (XEP-0313). */

import type { Element } from '@xmpp/xml';

import type { XmppGetArchiveOutput } from '@agent-xmpp/protocol';

import { parseMamResults, parseRsmPaging, type MamPaging } from './mam.js';

const MAM_NS = 'urn:xmpp:mam:2';

interface PendingMam {
  stanzas: Element[];
  paging?: MamPaging;
}

export class MamQueryAwaiter {
  private pending = new Map<string, PendingMam>();

  begin(queryId: string): void {
    this.pending.set(queryId, { stanzas: [] });
  }

  /** Returns true when the stanza belonged to a tracked MAM query. */
  handleStanza(stanza: Element, agentDomain: string): boolean {
    const result = stanza.getChild('result', MAM_NS);
    const fin = stanza.getChild('fin', MAM_NS);
    const queryId = (result?.attrs.queryid || fin?.attrs.queryid) as string | undefined;
    if (!queryId || !this.pending.has(queryId)) return false;

    const entry = this.pending.get(queryId)!;
    if (result) entry.stanzas.push(stanza);
    if (fin) {
      entry.paging = parseRsmPaging(stanza) ?? { complete: fin.attrs.complete === 'true' };
    }
    return true;
  }

  takeResult(queryId: string, agentDomain: string): XmppGetArchiveOutput | null {
    const entry = this.pending.get(queryId);
    if (!entry?.paging) return null;
    this.pending.delete(queryId);
    return {
      messages: parseMamResults(entry.stanzas, agentDomain),
      paging: entry.paging,
    };
  }

  async waitFor(queryId: string, agentDomain: string, timeoutMs = 15_000): Promise<XmppGetArchiveOutput> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const out = this.takeResult(queryId, agentDomain);
      if (out) return out;
      await new Promise((r) => setTimeout(r, 25));
    }
    const partial = this.pending.get(queryId);
    this.pending.delete(queryId);
    return {
      messages: parseMamResults(partial?.stanzas ?? [], agentDomain),
      paging: { complete: false },
    };
  }
}
