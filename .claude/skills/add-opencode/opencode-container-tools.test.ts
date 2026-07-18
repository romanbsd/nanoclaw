import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('OpenCode container tools', () => {
  it('pins the OpenCode CLI to the same version as its SDK', () => {
    const root = process.cwd();
    const tools = JSON.parse(fs.readFileSync(path.join(root, 'container/cli-tools.json'), 'utf8')) as Array<{
      name: string;
      version: string;
    }>;
    const runner = JSON.parse(
      fs.readFileSync(path.join(root, 'container/agent-runner/package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    const cli = tools.find((tool) => tool.name === 'opencode-ai');

    expect(cli?.version).toBe('1.4.17');
    expect(runner.dependencies['@opencode-ai/sdk']).toBe(cli?.version);
  });
});
