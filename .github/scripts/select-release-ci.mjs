import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { repository as officialRepository } from './release-manifest.mjs';

export function matchesReleaseCI(run, sha, repository) {
  return run?.name === 'CI' && run.event === 'push' && run.head_branch === 'main' &&
    run.head_repository?.full_name === repository && run.head_sha === sha && Number.isSafeInteger(run.id) && run.id > 0;
}

export async function selectReleaseCI({ sha, repository, runId = '', listRuns, getRun,
  now = Date.now, sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  onWait = () => {} }) {
  if (!/^[a-f0-9]{40}$/.test(sha) || repository !== officialRepository || (runId && !/^[1-9][0-9]*$/.test(runId)))
    throw new Error('Invalid release commit, repository or CI run ID.');
  if (runId) {
    const run = await getRun(runId);
    if (!matchesReleaseCI(run, sha, repository) || run.status !== 'completed' || run.conclusion !== 'success')
      throw new Error('CI run does not match the successful main push for the release commit.');
    return String(run.id);
  }
  const started = now();
  let selected;
  while (true) {
    if (now() - started >= 45 * 60_000) throw new Error('Release CI did not finish successfully within 45 minutes. Retry after CI completes.');
    if (!selected && now() - started >= 180_000)
      throw new Error('No matching CI main-push run appeared within three minutes. Push this commit to main and let CI build its packages before retrying the release.');
    if (!selected) {
      const candidates = (await listRuns()).filter(run => matchesReleaseCI(run, sha, repository));
      selected = candidates.sort((left, right) => right.id - left.id)[0];
      if (!selected && now() - started >= 180_000)
        throw new Error('No matching CI main-push run appeared within three minutes. Push this commit to main and let CI build its packages before retrying the release.');
    } else selected = await getRun(String(selected.id));
    if (selected) {
      if (!matchesReleaseCI(selected, sha, repository)) throw new Error('Selected CI run no longer matches the release commit.');
      if (selected.status === 'completed') {
        if (selected.conclusion !== 'success') throw new Error(`Release CI ${selected.id} finished with ${selected.conclusion ?? 'no successful conclusion'}.`);
        return String(selected.id);
      }
      if (!['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(selected.status))
        throw new Error(`Unexpected CI run status: ${selected.status}.`);
    }
    if (now() - started >= 45 * 60_000) throw new Error('Release CI did not finish successfully within 45 minutes. Retry after CI completes.');
    onWait(selected ? `Waiting for CI run ${selected.id} (${selected.status}).` : 'Waiting for the matching CI main-push run to appear.');
    const deadline = started + (selected ? 45 * 60_000 : 180_000);
    await sleep(Math.min(30_000, Math.max(0, deadline - now())));
  }
}

function api(path) {
  return JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [sha, runId = ''] = process.argv.slice(2);
  if (!sha || process.argv.length > 4) throw new Error('Usage: select-release-ci.mjs COMMIT [SUCCESSFUL_RUN_ID]');
  const repository = process.env.GITHUB_REPOSITORY;
  selectReleaseCI({ sha, repository, runId,
    listRuns: () => api(`repos/${repository}/actions/workflows/ci.yml/runs?event=push&head_sha=${sha}&per_page=100`).workflow_runs,
    getRun: id => api(`repos/${repository}/actions/runs/${id}`),
    onWait: message => console.error(message),
  }).then(id => console.log(id)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
