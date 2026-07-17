import { describe, expect, it } from 'vitest';

import { combineContainerContributions } from './container-contribution.js';

describe('combineContainerContributions', () => {
  it('preserves provider mount precedence and lets extensions overlay env', () => {
    const combined = combineContainerContributions(
      {
        mounts: [{ hostPath: '/provider', containerPath: '/state', readonly: false }],
        env: { SHARED: 'provider', PROVIDER_ONLY: 'yes' },
        blockedHosts: ['provider.invalid'],
        promptAddendum: 'Provider guidance',
      },
      [
        {
          mounts: [{ hostPath: '/channel', containerPath: '/state', readonly: true }],
          env: { SHARED: 'channel', CHANNEL_ONLY: 'yes' },
          blockedHosts: ['provider.invalid', 'channel.invalid'],
          promptAddendum: 'Channel guidance',
        },
      ],
    );

    expect(combined.mounts?.map((mount) => mount.hostPath)).toEqual(['/channel', '/provider']);
    expect(combined.env).toEqual({ SHARED: 'channel', PROVIDER_ONLY: 'yes', CHANNEL_ONLY: 'yes' });
    expect(combined.blockedHosts).toEqual(['provider.invalid', 'channel.invalid']);
    expect(combined.promptAddendum).toBe('Provider guidance\n\nChannel guidance');
  });
});
