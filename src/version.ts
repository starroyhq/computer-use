import { readFileSync } from 'node:fs';

// 版本号只维护在 package.json：开发时 src/、dist/ 与它相邻；安装包把 runtime/ 放在精简 package.json 旁边。
function readVersion(): string {
  try {
    const manifest: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const version = manifest !== null && typeof manifest === 'object' ? (manifest as { version?: unknown }).version : undefined;
    return typeof version === 'string' ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export const VERSION = readVersion();
