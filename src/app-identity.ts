import { win32 } from 'node:path';
import { CuError } from './contracts.js';

const bundleId = /^[A-Za-z0-9][A-Za-z0-9.-]{1,199}$/;
const localExecutable = /^[A-Za-z]:\\[^\r\n\0]+\.exe$/i;

export function canonicalAppId(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') {
    if (!bundleId.test(value)) throw new CuError('invalid_request', 'Use an application bundle identifier.');
    return value;
  }
  if (!localExecutable.test(value) || value.includes('..')) {
    throw new CuError('invalid_request', 'Use an absolute local Windows .exe path for application authorization.');
  }
  const normalized = win32.normalize(value);
  if (!localExecutable.test(normalized)) throw new CuError('invalid_request', 'Invalid Windows executable path.');
  return `win32:${normalized.toLowerCase()}`;
}

export function windowsAppId(launchPath: string | undefined): string | undefined {
  if (!launchPath) return undefined;
  try { return canonicalAppId(launchPath, 'win32'); }
  catch { return undefined; }
}
