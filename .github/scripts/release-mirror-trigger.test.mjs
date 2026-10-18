import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const release = readFileSync(new URL('../workflows/release.yml', import.meta.url), 'utf8');
const mirror = readFileSync(new URL('../workflows/mirror-release.yml', import.meta.url), 'utf8');
const dispatch = release.match(/^  dispatch_mirror:\n(?:.*\n|\n)*?(?=^  [a-z_]+:\n|$(?![\s\S]))/m)?.[0];
assert.ok(dispatch, 'The release workflow must dispatch its mirror separately');
const shell = dispatch.match(/^        run: \|\n((?:          .*\n)+)/m)?.[1].replace(/^          /gm, '');
assert.ok(shell, 'Exercise the actual dispatch shell, not a test copy');

function runDispatch(t, tag, exitCode = 0, verifyUpload = 'false') {
  const dir = mkdtempSync(join(tmpdir(), 'release-mirror-trigger-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = join(dir, 'calls.jsonl');
  const summary = join(dir, 'summary.md');
  writeFileSync(calls, '');
  writeFileSync(summary, '');
  writeFileSync(join(dir, 'gh'), `#!/usr/bin/env node
require('node:fs').appendFileSync(process.env.DISPATCH_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(Number(process.env.DISPATCH_EXIT_CODE));
`, { mode: 0o700 });
  const result = spawnSync('bash', ['-c', shell], {
    encoding: 'utf8', timeout: 5_000,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RELEASE_TAG: tag,
      GITHUB_REPOSITORY: 'starroyhq/computer-use', GITHUB_STEP_SUMMARY: summary,
      GH_TOKEN: 'test-only-token', VERIFY_UPLOAD: verifyUpload, DISPATCH_CALLS: calls, DISPATCH_EXIT_CODE: String(exitCode) },
  });
  return { ...result, calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), summary: readFileSync(summary, 'utf8') };
}

test('successful publication is required and only the dispatch job receives Actions write', () => {
  assert.match(dispatch, /needs: \[source, publish\]/);
  assert.match(dispatch, /if: always\(\) && needs\.source\.result == 'success' && needs\.publish\.result == 'success'/);
  assert.match(dispatch, /permissions:\n      actions: write\n    env:/);
  assert.match(dispatch, /RELEASE_TAG: v\$\{\{ needs\.source\.outputs\.version \}\}/);
  assert.equal(release.match(/actions: write/g)?.length, 1);
  assert.doesNotMatch(dispatch, /COS_SECRET|contents: write/);
  for (const workflow of [release, mirror]) {
    assert.match(workflow, /concurrency:\n  group: official-release-publish\n  cancel-in-progress: false\n  queue: max/);
  }
});

test('dispatch queues the exact stable tag on main and returns without polling the locked mirror', t => {
  const result = runDispatch(t, 'v0.9.0');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [['workflow', 'run', 'mirror-release.yml', '--repo', 'starroyhq/computer-use', '--ref', 'main', '-f', 'tag=v0.9.0', '-f', 'verify_upload=false']]);
  assert.match(result.summary, /Queued Mirror published Release for v0\.9\.0/);
  assert.match(result.summary, /separate Actions run/);
});

test('manual acceptance flag is forwarded while ordinary tag releases default to no probe', t => {
  assert.match(release, /verify_mirror_upload:\n(?:.*\n){2}        default: false\n        type: boolean/);
  assert.match(dispatch, /VERIFY_UPLOAD: \$\{\{ inputs\.verify_mirror_upload && 'true' \|\| 'false' \}\}/);
  assert.match(mirror, /if: inputs\.verify_upload/);
  const result = runDispatch(t, 'v0.9.0', 0, 'true');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls[0].slice(-2), ['-f', 'verify_upload=true']);
  const invalid = runDispatch(t, 'v0.9.0', 0, 'invalid');
  assert.equal(invalid.status, 1);
  assert.deepEqual(invalid.calls, []);
});

test('invalid or prerelease tags never reach the dispatch API', t => {
  for (const tag of ['', 'v01.9.0', 'v0.9.0-beta.1', 'main', 'v0.9.0\n-f tag=v1.0.0', 'v0.9.0; echo injected']) {
    const result = runDispatch(t, tag);
    assert.equal(result.status, 1, tag);
    assert.deepEqual(result.calls, [], tag);
    assert.equal(result.summary, '', tag);
  }
});

test('dispatch API failures fail the job without claiming COS was queued or verified', t => {
  const result = runDispatch(t, 'v0.9.0', 23);
  assert.equal(result.status, 23);
  assert.equal(result.calls.length, 1);
  assert.equal(result.summary, '');
});
