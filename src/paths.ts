import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { CuError } from './contracts.js';

export const dataDir = process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Computer Use')
  : join(homedir(), 'Library', 'Application Support', 'Computer Use');
export const socketPath = join(dataDir, 'runtime.sock');
export const credentialDir = process.platform === 'win32' ? join(dataDir, 'credentials') : join(homedir(), '.config', 'computer-use');
export const windowsPipeInfoPath = join(dataDir, 'runtime-pipe.json');

export async function defaultIpcPath(): Promise<string> {
  if (process.platform !== 'win32') return socketPath;
  try {
    const parsed = z.object({ pipeName: z.string().regex(/^\\\\\.\\pipe\\computer-use-[A-Za-z0-9-]+$/) }).parse(JSON.parse(await readFile(windowsPipeInfoPath, 'utf8')));
    return parsed.pipeName;
  } catch {
    throw new CuError('unavailable', 'Windows host is not running or its private pipe information is unavailable.');
  }
}
