import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareVersions, digestFile, releaseNames, repository } from './release-manifest.mjs';

const tagPattern = /^v((0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8}))$/;
export function inspectRelease(tag, releases) {
  const match = tagPattern.exec(tag);
  if (!match) throw new Error('Invalid release tag.');
  const matches = releases.filter(release => release.tag_name === tag);
  if (matches.length > 1) throw new Error(`Multiple releases found for ${tag}.`);
  for (const release of releases) {
    const other = tagPattern.exec(release.tag_name);
    if (!release.draft && !release.prerelease && other && compareVersions(other[1], match[1]) > 0)
      throw new Error(`Refusing to publish or promote ${tag}: newer stable ${release.tag_name} already exists.`);
  }
  const release = matches[0] ?? null;
  if (release?.prerelease) throw new Error('Expected a full release, not a prerelease.');
  return release;
}

export async function verifyReleaseAssets(directory, tag, release, { allowPartial = false } = {}) {
  if (!tagPattern.test(tag) || !release || release.tag_name !== tag || release.prerelease ||
      (!release.draft && !release.published_at)) throw new Error('Expected a full release for the tag.');
  if (allowPartial && !release.draft) throw new Error('Partial asset recovery is only allowed for a draft release.');
  const files = (await readdir(directory)).sort();
  const expected = releaseNames(tag.slice(1)).sort();
  if (JSON.stringify(files) !== JSON.stringify(expected)) throw new Error('Expected exactly the 15 verified release files.');
  const assets = new Map(release.assets.map(asset => [asset.name, asset]));
  if (assets.size !== release.assets.length || [...assets.keys()].some(name => !expected.includes(name)))
    throw new Error('Release asset list differs from verified files.');
  const missing = [];
  for (const file of files) {
    const asset = assets.get(file);
    if (!asset) { missing.push(file); continue; }
    if (asset.state === 'starter')
      throw new Error(`Incomplete GitHub upload placeholder: ${file}. Review and remove only this unfinished starter asset in GitHub, then retry recovery_run_id; never replace an uploaded asset.`);
    const digest = await digestFile(join(directory, file));
    if ((asset.state && asset.state !== 'uploaded') || asset.size !== digest.bytes || asset.digest !== `sha256:${digest.sha256}`)
      throw new Error(`Release asset differs from local file: ${file}. Preserve the original verified bytes; never overwrite existing assets.`);
  }
  if (missing.length && !allowPartial)
    throw new Error('Incomplete release assets. Recover a partial draft with recovery_run_id from its original publishing run; do not rebuild or overwrite.');
  return missing;
}

export function githubReleases() {
  if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY !== repository) throw new Error('Unexpected publishing repository.');
  // Paginate because retry/backfill tags can be older than the first page. Authenticated listing includes drafts.
  return JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${repository}/releases?per_page=100`], { encoding: 'utf8' })).flat();
}

export async function runReleaseCommand(args, { list = githubReleases, execute = execFileSync } = {}) {
  if (args.length === 2 && ['preflight', 'publish'].includes(args[0])) {
    const [command, tag] = args;
    const release = inspectRelease(tag, await list());
    if (command === 'preflight') {
      console.log(JSON.stringify({ reuse: !!release, draft: release?.draft ?? null, createdAt: release?.created_at ?? null }));
      return;
    }
    if (!release) throw new Error('Create and verify the draft before publishing.');
    if (!release.draft) { console.log(`Already published ${tag}; retaining the existing GitHub latest selection.`); return; }
    execute('gh', ['release', 'edit', tag, '--repo', repository, '--draft=false', '--prerelease=false', '--latest'], { stdio: 'inherit' });
    return;
  }
  const [directory, tag, mode] = args;
  if (!directory || !tag || args.length > 3 || (mode !== undefined && mode !== '--allow-partial'))
    throw new Error('Usage: verify-release.mjs DIRECTORY TAG [--allow-partial] | preflight TAG | publish TAG');
  const release = inspectRelease(tag, await list());
  const missing = await verifyReleaseAssets(directory, tag, release, { allowPartial: mode === '--allow-partial' });
  if (mode) console.log(JSON.stringify(missing));
  else console.log(`Verified 15 uploaded assets for ${tag}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runReleaseCommand(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
