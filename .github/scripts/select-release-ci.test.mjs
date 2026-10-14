import assert from 'node:assert/strict';
import test from 'node:test';
import { selectReleaseCI } from './select-release-ci.mjs';

const sha = 'a'.repeat(40);
const repository = 'starroyhq/computer-use';
const completed = { id: 123, name: 'CI', event: 'push', head_branch: 'main', head_repository: { full_name: repository }, head_sha: sha, status: 'completed', conclusion: 'success' };
function harness(overrides = {}) {
  let time = 0;
  const sleeps = [];
  return { sha, repository, listRuns: async () => [completed], getRun: async () => completed,
    now: () => time, sleep: async ms => { sleeps.push(ms); time += ms; }, sleeps, ...overrides };
}

test('tag automation selects only the successful CI push for the exact main commit and repository', async () => {
  const options = harness({ listRuns: async () => [
    { ...completed, id: 500, event: 'pull_request' }, { ...completed, id: 501, event: 'workflow_dispatch' },
    { ...completed, id: 502, head_branch: 'feature' }, { ...completed, id: 503, head_sha: 'b'.repeat(40) },
    { ...completed, id: 504, head_repository: { full_name: 'someone/fork' } }, { ...completed, id: 505, name: 'Another workflow' }, completed,
  ] });
  assert.equal(await selectReleaseCI(options), '123');
  assert.deepEqual(options.sleeps, []);
});

test('manual run IDs preserve the exact-success requirement', async () => {
  assert.equal(await selectReleaseCI(harness({ runId: '123' })), '123');
  for (const run of [{ ...completed, conclusion: 'failure' }, { ...completed, status: 'in_progress' }, { ...completed, head_sha: 'b'.repeat(40) }])
    await assert.rejects(selectReleaseCI(harness({ runId: '123', getRun: async () => run })), /does not match/);
});

test('automation waits for discovery and pins the chosen run while it completes', async () => {
  let lists = 0;
  const ids = [];
  const options = harness({
    listRuns: async () => ++lists < 3 ? [] : [{ ...completed, status: 'queued' }],
    getRun: async id => { ids.push(id); return ids.length === 1 ? { ...completed, status: 'in_progress' } : completed; },
  });
  assert.equal(await selectReleaseCI(options), '123');
  assert.equal(lists, 3);
  assert.deepEqual(ids, ['123', '123']);
  assert.ok(options.sleeps.every(ms => ms === 30_000));
});

test('the newest matching run wins and its failure is never hidden by an older success', async () => {
  const options = harness({ listRuns: async () => [completed, { ...completed, id: 124, conclusion: 'failure' }] });
  await assert.rejects(selectReleaseCI(options), /124 finished with failure/);
  assert.deepEqual(options.sleeps, []);
});

test('missing runs stop after three minutes, and running CI stops after 45 minutes', async () => {
  const absent = harness({ listRuns: async () => [] });
  await assert.rejects(selectReleaseCI(absent), /within three minutes/);
  assert.equal(absent.sleeps.length, 6);
  const running = harness({ listRuns: async () => [{ ...completed, status: 'in_progress' }], getRun: async () => ({ ...completed, status: 'in_progress' }) });
  await assert.rejects(selectReleaseCI(running), /within 45 minutes/);
  assert.equal(running.sleeps.length, 90);
});

test('cancelled CI and a changed selected commit stop immediately', async () => {
  const cancelled = harness({ listRuns: async () => [{ ...completed, conclusion: 'cancelled' }] });
  await assert.rejects(selectReleaseCI(cancelled), /cancelled/);
  const changed = harness({ listRuns: async () => [{ ...completed, status: 'queued' }], getRun: async () => ({ ...completed, head_sha: 'b'.repeat(40) }) });
  await assert.rejects(selectReleaseCI(changed), /no longer matches/);
  assert.equal(changed.sleeps.length, 1);
});
