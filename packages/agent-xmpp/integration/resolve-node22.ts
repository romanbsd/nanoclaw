/**
 * Resolve a Node.js 22 binary for integration/E2E subprocesses.
 * better-sqlite3 in the host tree is compiled for Node 22 (ABI 127).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function nodeMajor(bin: string): number | null {
  try {
    const out = execFileSync(bin, ['-p', 'process.versions.node.split(".")[0]'], {
      encoding: 'utf8',
    }).trim();
    const major = Number(out);
    return Number.isFinite(major) ? major : null;
    // eslint-disable-next-line no-catch-all/no-catch-all -- node binary probe; try next candidate
  } catch {
    return null;
  }
}

function pushUnique(list: string[], bin: string | undefined): void {
  if (!bin || list.includes(bin)) return;
  list.push(bin);
}

function node22Candidates(): string[] {
  const list: string[] = [];
  pushUnique(list, process.env.NANOCLAW_NODE);
  pushUnique(list, process.env.NODE_BIN);

  for (const brewNode of ['/opt/homebrew/opt/node@22/bin/node', '/usr/local/opt/node@22/bin/node']) {
    pushUnique(list, brewNode);
  }

  const nvmDir = process.env.NVM_DIR || path.join(os.homedir(), '.nvm');
  try {
    const versionsDir = path.join(nvmDir, 'versions/node');
    if (fs.existsSync(versionsDir)) {
      const v22 = fs
        .readdirSync(versionsDir)
        .filter((v) => v.startsWith('v22.'))
        .sort()
        .reverse();
      for (const v of v22) {
        pushUnique(list, path.join(versionsDir, v, 'bin/node'));
      }
    }
    // eslint-disable-next-line no-catch-all/no-catch-all -- unreadable nvm dir; try other candidates
  } catch {
    // ignore unreadable nvm dir
  }

  try {
    const fnmMultis = path.join(os.homedir(), '.local/share/fnm/node-versions');
    if (fs.existsSync(fnmMultis)) {
      const v22 = fs
        .readdirSync(fnmMultis)
        .filter((v) => v.startsWith('v22.'))
        .sort()
        .reverse();
      for (const v of v22) {
        pushUnique(list, path.join(fnmMultis, v, 'installation/bin/node'));
      }
    }
    // eslint-disable-next-line no-catch-all/no-catch-all -- unreadable fnm dir; try other candidates
  } catch {
    // ignore unreadable fnm dir
  }

  try {
    const onPath = execFileSync('sh', ['-lc', 'command -v node'], { encoding: 'utf8' }).trim();
    pushUnique(list, onPath);
    // eslint-disable-next-line no-catch-all/no-catch-all -- node not on PATH; try other candidates
  } catch {
    // ignore
  }

  return list;
}

let cached: string | undefined;

/** Absolute path to a Node 22 `node` binary. Throws if none found. */
export function resolveNode22Bin(): string {
  if (cached) return cached;

  for (const bin of node22Candidates()) {
    if (!fs.existsSync(bin)) continue;
    if (nodeMajor(bin) === 22) {
      cached = bin;
      return bin;
    }
  }

  throw new Error(
    'Node.js 22 required (better-sqlite3 native module). Install node@22, or set NANOCLAW_NODE=/path/to/node22',
  );
}

/** Log-friendly version string for the resolved Node 22 binary. */
export function resolveNode22Version(): string {
  const bin = resolveNode22Bin();
  try {
    return execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim();
    // eslint-disable-next-line no-catch-all/no-catch-all -- version probe fallback for logging only
  } catch {
    return 'v22.x';
  }
}
