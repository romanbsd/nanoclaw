import net from 'node:net';
import path from 'node:path';

export async function injectViaCliSocket(
  dataDir: string,
  payload: {
    text: string;
    to: { channelType: string; platformId: string; threadId: string | null; instance?: string };
    sender?: string;
    senderId?: string;
  },
): Promise<void> {
  const sockPath = path.join(dataDir, 'cli.sock');

  await new Promise<void>((resolve, reject) => {
    const socket = net.connect(sockPath);
    let settled = false;

    const settle = (err: Error | null) => {
      if (settled) return;
      settled = true;
      try {
        socket.end();
        // eslint-disable-next-line no-catch-all/no-catch-all -- socket.end noop during CLI inject teardown
      } catch {
        /* noop */
      }
      if (err) reject(err);
      else resolve();
    };

    socket.once('error', (err) =>
      settle(new Error(`CLI socket at ${sockPath} not reachable: ${err.message}`)),
    );
    socket.once('connect', () => {
      const line = JSON.stringify(payload) + '\n';
      socket.write(line, (err) => {
        if (err) {
          settle(err);
          return;
        }
        setTimeout(() => settle(null), 100);
      });
    });
  });
}
