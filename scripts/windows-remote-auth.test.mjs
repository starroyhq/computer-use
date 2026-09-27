import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./windows-remote-auth.mjs', import.meta.url));
const token = 'fixture-private-token-0123456789';
const invoke = path => spawnSync(process.execPath, [helper, path], { encoding: 'utf8' });

test('Mac HTTP helper reads only an owner-only regular credential file', { skip: process.platform !== 'darwin' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cu-http-helper-'));
  try {
    const file = join(dir, 'credential.json');
    await writeFile(file, JSON.stringify({ mcpServers: { 'computer-use': { headers: { Authorization: `Bearer ${token}` } } } }), { mode: 0o600 });
    const valid = invoke(file);
    assert.equal(valid.status, 0);
    assert.deepEqual(JSON.parse(valid.stdout), { Authorization: `Bearer ${token}` });
    await chmod(file, 0o644);
    const publicFile = invoke(file);
    assert.notEqual(publicFile.status, 0);
    assert.equal(publicFile.stdout, '');
    assert.equal(publicFile.stderr.includes(token), false);
    await chmod(file, 0o600);
    await writeFile(file, JSON.stringify({ mcpServers: { 'computer-use': { headers: { Authorization: `Bearer ${token}\r\nX-Leak: yes` } } } }));
    assert.notEqual(invoke(file).status, 0);
    await writeFile(file, JSON.stringify({ mcpServers: { 'computer-use': { headers: { Authorization: `Bearer ${token}` } } } }));
    const link = join(dir, 'credential-link.json');
    await symlink(file, link);
    assert.notEqual(invoke(link).status, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
