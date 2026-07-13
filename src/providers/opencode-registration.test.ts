import { describe, expect, it } from 'vitest';

import './index.js';
import { listProviderContainerConfigNames } from './provider-container-registry.js';

describe('OpenCode provider host registration', () => {
  it('registers through the provider barrel', () => {
    expect(listProviderContainerConfigNames()).toContain('opencode');
  });
});
