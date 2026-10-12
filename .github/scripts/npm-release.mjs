import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPackageArchive, verifyNpmArchive } from '../../scripts/package-npm.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REGISTRY = 'https://registry.npmjs.org';
const REPOSITORY = 'starroyhq/computer-use';
const PROVENANCE = 'https://slsa.dev/provenance/v1';
class PendingPublication extends Error {}

export function validateReleaseRef({ repository, event, ref, publish, version }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('npm publishing requires a stable release version.');
  if (repository !== REPOSITORY) throw new Error('npm publishing is restricted to the official repository.');
  if (event === 'push' && ref === `refs/tags/npm-v${version}`) return;
  if (event === 'workflow_dispatch' && ref === 'refs/heads/main' && publish === 'true') return;
  throw new Error('Publish requires an exact npm-vVERSION tag or an explicit manual publish from main.');
}

export async function verifyReleaseSource({ root = ROOT, env = process.env, runGit } = {}) {
  const manifest = JSON.parse(await readFile(join(root, 'packages/npm/package.json'), 'utf8'));
  validateReleaseRef({
    repository: env.GITHUB_REPOSITORY,
    event: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF,
    publish: env.NPM_PUBLISH,
    version: manifest.version,
  });
  const git = runGit ?? (args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim());
  const sha = git(['rev-parse', 'HEAD']);
  if (sha !== env.GITHUB_SHA) throw new Error('The checked-out source differs from the workflow commit.');
  // Full-history checkout fetches origin/main even for a tag run. Never publish
  // a tag from a side branch that has not been included in main.
  git(['merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main']);
  return { version: manifest.version, sha };
}

function registryUrl(value) {
  const url = new URL(value);
  if (url.origin !== REGISTRY || url.username || url.password || url.hash) throw new Error('Unexpected npm registry URL.');
  return url.href;
}

async function responseBytes(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) throw new Error('npm registry response is too large.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('npm registry response is too large.');
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel();
  }
}

async function request(url, fetchImpl) {
  return fetchImpl(registryUrl(url), { redirect: 'error', signal: AbortSignal.timeout(15_000) });
}

async function requiredBytes(url, fetchImpl, limit, pending) {
  const response = await request(url, fetchImpl);
  if (response.status === 404 && pending) throw new PendingPublication('Published npm data is not visible yet.');
  if (!response.ok) throw new Error(`npm registry request failed: HTTP ${response.status}.`);
  return responseBytes(response, limit);
}

export function compareArchives(localBytes, remoteBytes, integrity) {
  const actual = `sha512-${createHash('sha512').update(remoteBytes).digest('base64')}`;
  if (typeof integrity !== 'string' || !integrity.split(/\s+/).includes(actual))
    throw new Error('Published npm archive integrity does not match registry metadata.');
  const local = readPackageArchive(localBytes);
  const remote = readPackageArchive(remoteBytes);
  for (const [path, { content }] of local) {
    const same =
      path === 'package.json'
        ? JSON.stringify(JSON.parse(content)) === JSON.stringify(JSON.parse(remote.get(path).content))
        : content.equals(remote.get(path).content);
    if (!same) throw new Error(`npm version already exists with different content: ${path}. Bump the launcher version.`);
  }
}

export function verifyProvenance(document, { bytes, name, version, sha, ref }) {
  const attestation = document.attestations?.find(item => item.predicateType === PROVENANCE);
  if (!attestation?.bundle?.dsseEnvelope?.payload) throw new PendingPublication('npm provenance is not visible yet.');
  const statement = JSON.parse(Buffer.from(attestation.bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
  const definition = statement.predicate?.buildDefinition;
  const workflow = definition?.externalParameters?.workflow;
  const digest = createHash('sha512').update(bytes).digest('hex');
  const subject = `pkg:npm/${name.replace('@', '%40')}@${version}`;
  if (
    statement.predicateType !== PROVENANCE ||
    !statement.subject?.some(item => item.name === subject && item.digest?.sha512 === digest) ||
    workflow?.repository !== `https://github.com/${REPOSITORY}` ||
    workflow?.path !== '.github/workflows/npm.yml' ||
    workflow?.ref !== ref ||
    !definition.resolvedDependencies?.some(item => item.digest?.gitCommit === sha)
  )
    throw new Error('npm provenance does not identify this archive, workflow and source commit.');
  // Registry HTTPS and archive SRI are checked here. This validates the published
  // statement contents; it is not an independent Sigstore signature verifier.
}

export async function checkRegistry(archive, { root = ROOT, fetchImpl = fetch, provenance = false, sha, ref } = {}) {
  const local = await verifyNpmArchive(archive, { root });
  const response = await request(`${REGISTRY}/${encodeURIComponent(local.name)}/${local.version}`, fetchImpl);
  if (response.status === 404) return { exists: false, name: local.name, version: local.version };
  if (!response.ok) throw new Error(`npm version lookup failed: HTTP ${response.status}.`);
  const metadata = JSON.parse((await responseBytes(response, 1024 * 1024)).toString('utf8'));
  if (metadata.name !== local.name || metadata.version !== local.version)
    throw new Error('npm registry returned the wrong package version.');
  const expectedTarball = `${REGISTRY}/${local.name}/-/${local.name.split('/').at(-1)}-${local.version}.tgz`;
  if (registryUrl(metadata.dist?.tarball) !== expectedTarball) throw new Error('npm registry returned an unexpected tarball path.');
  const bytes = await requiredBytes(expectedTarball, fetchImpl, 8 * 1024 * 1024, provenance);
  compareArchives(await readFile(archive), bytes, metadata.dist?.integrity);
  let provenanceUrl;
  if (provenance) {
    if (metadata.dist?.attestations?.provenance?.predicateType !== PROVENANCE)
      throw new PendingPublication('npm provenance metadata is not visible yet.');
    provenanceUrl = registryUrl(metadata.dist.attestations.url);
    const document = JSON.parse((await requiredBytes(provenanceUrl, fetchImpl, 2 * 1024 * 1024, true)).toString('utf8'));
    verifyProvenance(document, { bytes, name: local.name, version: local.version, sha, ref });
  }
  return {
    exists: true,
    name: local.name,
    version: local.version,
    integrity: metadata.dist.integrity,
    ...(provenanceUrl && { provenanceUrl }),
  };
}

export async function verifyPublished(archive, options = {}) {
  const {
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    onPending = message => console.error(message),
    attempts = 16,
    ...checkOptions
  } = options;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const result = await checkRegistry(archive, { ...checkOptions, provenance: true });
      if (result.exists) return result;
      throw new PendingPublication('Published npm version is not visible yet.');
    } catch (error) {
      if (!(error instanceof PendingPublication) || attempt === attempts - 1) throw error;
      onPending(`Waiting for npm registry propagation (${attempt + 1}/${attempts}): ${error.message}`);
      await sleep(20_000);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, archive, ...extra] = process.argv.slice(2);
    if (extra.length || !['source', 'check', 'verify'].includes(command) || (command === 'source' ? archive : !archive))
      throw new Error('Usage: npm-release.mjs source | check ARCHIVE | verify ARCHIVE');
    const result =
      command === 'source'
        ? await verifyReleaseSource()
        : command === 'check'
          ? await checkRegistry(archive)
          : await verifyPublished(archive, { sha: process.env.GITHUB_SHA, ref: process.env.GITHUB_REF });
    console.log(JSON.stringify(result));
    if (command === 'check' && process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `exists=${result.exists}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `npm ${command}: ${JSON.stringify(result)}\n\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
