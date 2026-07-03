import { describe, expect, it } from 'vitest';

import { getRegisteredChannelNames } from './channel-registry.js';

// Import real barrel so registration side effects run.
import './index.js';

describe('xmpp bridge registration', () => {
  it('registers xmpp in channel registry', () => {
    expect(getRegisteredChannelNames()).toContain('xmpp');
  });
});
