#!/usr/bin/env node
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';

async function main() {
  if (process.platform !== 'darwin' || process.argv.length !== 3) throw new Error('Expected one macOS credential-file path.');
  const path = resolve(process.argv[2]);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let parsed;
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0) {
      throw new Error('Credential file must be an owner-only regular file (mode 0600).');
    }
    parsed = JSON.parse(await file.readFile('utf8'));
  } finally {
    await file.close();
  }
  const authorization = parsed?.mcpServers?.['computer-use']?.headers?.Authorization;
  if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9._~+/-]{20,}={0,2}$/.test(authorization)) {
    throw new Error('Credential file has no valid Computer Use bearer header.');
  }
  process.stdout.write(JSON.stringify({ Authorization: authorization }) + '\n');
}

main().catch(() => { process.stderr.write('Computer Use MCP credential unavailable.\n'); process.exitCode = 1; });
