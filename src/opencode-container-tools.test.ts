import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

describe('OpenCode container tools', () => {
  it('pins the OpenCode CLI to the same version as its SDK', () => {
    const runner = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'container', 'agent-runner', 'package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    const tools = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'container', 'cli-tools.json'), 'utf8'),
    ) as Array<{
      name: string;
      version: string;
    }>;
    const cli = tools.find((tool) => tool.name === 'opencode-ai');
    expect(cli?.version).toBe('1.4.17');
    expect(runner.dependencies['@opencode-ai/sdk']).toBe(cli?.version);
  });
});
