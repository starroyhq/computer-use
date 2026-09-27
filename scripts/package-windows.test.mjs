import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertPeMachine, parseArguments, targetForArch } from './package-windows.mjs';

test('Windows package targets have separate binaries, receipts and destinations', () => {
  const arm64 = targetForArch('arm64');
  const x64 = targetForArch('x64');
  assert.equal(arm64.rid, 'win-arm64');
  assert.equal(x64.rid, 'win-x64');
  assert.notEqual(arm64.output, x64.output);
  assert.notEqual(arm64.marker, x64.marker);
  assert.match(arm64.node.filename, /win-arm64/);
  assert.match(x64.node.filename, /win-x64/);
  assert.match(arm64.cua.filename, /windows-arm64/);
  assert.match(x64.cua.filename, /windows-x86_64/);
  assert.throws(() => targetForArch('ia32'), /Unsupported Windows architecture/);
});

test('Windows package CLI defaults to host architecture and selects an explicit target', () => {
  assert.equal(parseArguments([], 'arm64').target.rid, 'win-arm64');
  assert.equal(parseArguments([], 'x64').target.rid, 'win-x64');
  assert.equal(parseArguments(['--arch', 'x64', '--verify-only'], 'arm64').target.rid, 'win-x64');
  assert.equal(parseArguments(['--verify-only', '--arch', 'arm64'], 'x64').verifyOnly, true);
  assert.throws(() => parseArguments(['--arch'], 'arm64'), /Usage/);
  assert.throws(() => parseArguments(['--arch', '--verify-only'], 'arm64'), /Usage/);
  assert.throws(() => parseArguments(['--arch', 'x64', '--arch', 'arm64'], 'arm64'), /Usage/);
});

test('Windows PE verification rejects the other architecture', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'computer-use-windows-pe-'));
  try {
    const path = join(directory, 'component.exe');
    const pe = Buffer.alloc(0x86);
    pe.write('MZ');
    pe.writeUInt32LE(0x80, 0x3c);
    pe.write('PE\0\0', 0x80);
    pe.writeUInt16LE(0x8664, 0x84);
    await writeFile(path, pe);
    await assertPeMachine(path, targetForArch('x64'));
    await assert.rejects(assertPeMachine(path, targetForArch('arm64')), /not Windows ARM64/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
