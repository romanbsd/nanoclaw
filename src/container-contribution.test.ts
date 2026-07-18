import { describe, expect, it } from 'vitest';

import {
  combineContainerContributions,
  registerContainerContributor,
  resolveContainerContributions,
} from './container-contribution.js';

describe('combineContainerContributions', () => {
  it('merges ordered contributions and lets later env values win', () => {
    const combined = combineContainerContributions([
      {
        mounts: [{ hostPath: '/provider', containerPath: '/provider-state', readonly: false }],
        env: { SHARED: 'provider', PROVIDER_ONLY: 'yes' },
        blockedHosts: ['provider.invalid'],
        promptAddendum: 'Provider guidance',
      },
      {
        mounts: [{ hostPath: '/channel', containerPath: '/channel-state', readonly: true }],
        env: { SHARED: 'channel', CHANNEL_ONLY: 'yes' },
        blockedHosts: ['provider.invalid', 'channel.invalid'],
        promptAddendum: 'Channel guidance',
      },
    ]);

    expect(combined.mounts?.map((mount) => mount.hostPath)).toEqual(['/provider', '/channel']);
    expect(combined.env).toEqual({ SHARED: 'channel', PROVIDER_ONLY: 'yes', CHANNEL_ONLY: 'yes' });
    expect(combined.blockedHosts).toEqual(['provider.invalid', 'channel.invalid']);
    expect(combined.promptAddendum).toBe('Provider guidance\n\nChannel guidance');
  });

  it('rejects ambiguous mount targets', () => {
    expect(() =>
      combineContainerContributions([
        { mounts: [{ hostPath: '/one', containerPath: '/state', readonly: false }] },
        { mounts: [{ hostPath: '/two', containerPath: '/state', readonly: false }] },
      ]),
    ).toThrow('Conflicting container mount contribution: /state');
  });

  it('resolves registered extensions independently of channels', () => {
    registerContainerContributor('container-contribution-test', ({ agentGroupId }) => ({
      env: { TARGET_AGENT: agentGroupId },
    }));
    expect(resolveContainerContributions({ agentGroupId: 'ag-42' })).toContainEqual({
      env: { TARGET_AGENT: 'ag-42' },
    });
  });
});
