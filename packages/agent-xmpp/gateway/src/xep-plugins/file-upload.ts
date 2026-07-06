/** XEP-0363 HTTP File Upload, XEP-0446/0447, XEP-0300, XEP-0066 fallback */

import crypto from 'crypto';

import { xml, type Element } from '@xmpp/xml';
import { ulid } from 'ulid';

import type { FileRef, XmppUploadFileInput } from '@agent-xmpp/protocol';

const HTTP_UPLOAD_NS = 'urn:xmpp:http:upload:0';
const OOB_NS = 'jabber:x:oob';

export interface UploadSlot {
  putUrl: string;
  getUrl: string;
  file: FileRef;
}

export function buildSlotRequest(from: string, to: string, size: number, mediaType: string, filename: string): Element {
  return xml(
    'iq',
    { type: 'get', from, to, id: `upload-${ulid()}` },
    xml('request', {
      xmlns: HTTP_UPLOAD_NS,
      filename,
      'content-type': mediaType,
      size: String(size),
    }),
  );
}

export function parseSlotResponse(stanza: Element): { putUrl: string; getUrl: string } | null {
  const slot = stanza.getChild('slot', HTTP_UPLOAD_NS);
  if (!slot) return null;
  const put = slot.getChild('put')?.attrs.url as string | undefined;
  const get = slot.getChild('get')?.attrs.url as string | undefined;
  if (!put || !get) return null;
  return { putUrl: put, getUrl: get };
}

export async function uploadBytes(putUrl: string, bytes: Buffer, mediaType: string): Promise<void> {
  const res = await fetch(putUrl, {
    method: 'PUT',
    headers: { 'Content-Type': mediaType },
    body: bytes,
  });
  if (!res.ok) {
    throw new Error(`HTTP upload failed: ${res.status} ${res.statusText}`);
  }
}

export function sha256Hex(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function decodeUploadInput(input: XmppUploadFileInput): { bytes: Buffer; name: string; mediaType: string } {
  if (input.bytesBase64) {
    return {
      bytes: Buffer.from(input.bytesBase64, 'base64'),
      name: input.name,
      mediaType: input.mediaType,
    };
  }
  throw new Error('bytesBase64 is required in gateway upload (path upload is MCP-local only)');
}

export function buildFileShareStanza(
  to: string,
  from: string,
  file: FileRef,
  note?: string,
  threadId?: string,
): Element {
  const body = note || file.description || `Shared file: ${file.name || file.url}`;
  const children = [
    xml('body', {}, body),
    xml('x', { xmlns: OOB_NS }, xml('url', {}, file.url)),
  ];
  if (threadId) children.push(xml('thread', {}, threadId));
  if (file.mediaType) {
    children.push(
      xml('file', {
        xmlns: 'urn:xmpp:file:metadata:0',
        name: file.name || 'file',
        mediaType: file.mediaType,
        size: file.sizeBytes ? String(file.sizeBytes) : undefined,
      }),
    );
  }
  return xml('message', { type: 'chat', to, from, id: ulid() }, ...children);
}
