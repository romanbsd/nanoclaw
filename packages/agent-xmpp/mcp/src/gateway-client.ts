const base = process.env.XMPP_GATEWAY_URL || 'http://127.0.0.1:9220';

export async function gatewayPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gateway ${path} failed: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}
