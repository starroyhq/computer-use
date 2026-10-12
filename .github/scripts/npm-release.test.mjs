import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { packageFiles, packageNpm } from '../../scripts/package-npm.mjs';
import {
  checkRegistry,
  compareArchives,
  validateReleaseRef,
  verifyProvenance,
  verifyPublished,
  verifyReleaseSource,
} from './npm-release.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REGISTRY = 'https://registry.npmjs.org';
const PROVENANCE = 'https://slsa.dev/provenance/v1';
const SHA = '1'.repeat(40);
const integrity = bytes => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'npm-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of packageFiles) {
    const relative = file.startsWith('resources/')
      ? join('skills/computer-use', basename(file))
      : ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md'].includes(file)
        ? file
        : join('packages/npm', file);
    await mkdir(dirname(join(root, relative)), { recursive: true });
    await copyFile(join(ROOT, relative), join(root, relative));
  }
  const packed = await packageNpm({ root });
  const bytes = await readFile(packed.path);
  const { name, version } = packed;
  const ref = `refs/tags/npm-v${version}`;
  const tarball = `${REGISTRY}/${name}/-/computer-use-${version}.tgz`;
  const url = `${REGISTRY}/${encodeURIComponent(name)}/${version}`;
  const attestations = `${REGISTRY}/-/npm/v1/attestations/${encodeURIComponent(name)}@${version}`;
  const metadata = {
    name,
    version,
    dist: { tarball, integrity: integrity(bytes), attestations: { url: attestations, provenance: { predicateType: PROVENANCE } } },
  };
  const statement = {
    predicateType: PROVENANCE,
    subject: [
      { name: `pkg:npm/${name.replace('@', '%40')}@${version}`, digest: { sha512: createHash('sha512').update(bytes).digest('hex') } },
    ],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: { repository: 'https://github.com/starroyhq/computer-use', path: '.github/workflows/npm.yml', ref },
        },
        resolvedDependencies: [{ digest: { gitCommit: SHA } }],
      },
    },
  };
  const document = {
    attestations: [
      { predicateType: PROVENANCE, bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString('base64') } } },
    ],
  };
  const fetchImpl = async requested => {
    if (requested === url) return Response.json(metadata);
    if (requested === tarball) return new Response(bytes);
    if (requested === attestations) return Response.json(document);
    throw new Error(`Unexpected request: ${requested}`);
  };
  return { root, archive: packed.path, bytes, name, version, ref, metadata, document, statement, fetchImpl, url, tarball, attestations };
}

test('publishing requires the official repository and an exact version tag or explicit manual main dispatch', () => {
  const source = { repository: 'starroyhq/computer-use', event: 'push', ref: 'refs/tags/npm-v0.7.1', version: '0.7.1' };
  validateReleaseRef(source);
  validateReleaseRef({ ...source, event: 'workflow_dispatch', ref: 'refs/heads/main', publish: 'true' });
  for (const change of [
    { repository: 'fork/computer-use' },
    { ref: 'refs/tags/npm-v0.7.0' },
    { ref: 'refs/tags/v0.7.1' },
    { ref: 'refs/heads/main' },
    { event: 'pull_request' },
    { event: 'workflow_dispatch', ref: 'refs/heads/main', publish: 'false' },
    { event: 'workflow_dispatch', ref: 'refs/heads/other', publish: 'true' },
    { version: '0.7.1-beta.1', ref: 'refs/tags/npm-v0.7.1-beta.1' },
  ])
    assert.throws(() => validateReleaseRef({ ...source, ...change }));
});

test('only a registry 404 authorizes publishing a missing version', async t => {
  const f = await fixture(t);
  assert.deepEqual(await checkRegistry(f.archive, { root: f.root, fetchImpl: async () => new Response('', { status: 404 }) }), {
    exists: false,
    name: f.name,
    version: f.version,
  });
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(
      checkRegistry(f.archive, { root: f.root, fetchImpl: async () => new Response('', { status }) }),
      new RegExp(`HTTP ${status}`),
    );
  }
  await assert.rejects(
    checkRegistry(f.archive, {
      root: f.root,
      fetchImpl: async () => {
        throw new Error('Network unavailable');
      },
    }),
    /Network unavailable/,
  );
});

test('release source rejects the wrong checkout or a commit outside origin/main', async () => {
  const { version } = JSON.parse(await readFile(join(ROOT, 'packages/npm/package.json'), 'utf8'));
  const env = {
    GITHUB_REPOSITORY: 'starroyhq/computer-use',
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: `refs/tags/npm-v${version}`,
    GITHUB_SHA: SHA,
  };
  const calls = [];
  assert.deepEqual(
    await verifyReleaseSource({
      env,
      runGit: args => {
        calls.push(args);
        return args[0] === 'rev-parse' ? SHA : '';
      },
    }),
    { version, sha: SHA },
  );
  assert.deepEqual(calls, [
    ['rev-parse', 'HEAD'],
    ['merge-base', '--is-ancestor', SHA, 'refs/remotes/origin/main'],
  ]);
  await assert.rejects(verifyReleaseSource({ env, runGit: () => '2'.repeat(40) }), /differs from the workflow commit/);
  await assert.rejects(
    verifyReleaseSource({
      env,
      runGit: args => {
        if (args[0] === 'rev-parse') return SHA;
        throw new Error('not an ancestor');
      },
    }),
    /not an ancestor/,
  );
});

test('published retries compare archive contents and verify SRI rather than gzip bytes', async t => {
  const f = await fixture(t);
  const repacked = gzipSync(gunzipSync(f.bytes), { level: 0 });
  assert.notDeepEqual(repacked, f.bytes);
  compareArchives(f.bytes, repacked, integrity(repacked));
  assert.throws(() => compareArchives(f.bytes, repacked, integrity(f.bytes)), /integrity/);
  const tar = gunzipSync(f.bytes);
  const index = tar.indexOf(Buffer.from('# Computer Use'));
  assert.ok(index > 0);
  tar[index] = '!'.charCodeAt(0);
  const altered = gzipSync(tar);
  assert.throws(() => compareArchives(f.bytes, altered, integrity(altered)), /different content: README.md/);
  const result = await checkRegistry(f.archive, { root: f.root, fetchImpl: f.fetchImpl });
  assert.equal(result.exists, true);
});

test('registry identity, download origin and integrity are checked before accepting an existing version', async t => {
  const f = await fixture(t);
  for (const change of [
    { name: '@other/computer-use' },
    { version: '0.0.0' },
    { dist: { ...f.metadata.dist, tarball: 'https://example.com/package.tgz' } },
    { dist: { ...f.metadata.dist, tarball: `${REGISTRY}/different/-/different-0.7.1.tgz` } },
    { dist: { ...f.metadata.dist, integrity: 'sha512-wrong' } },
  ]) {
    await assert.rejects(
      checkRegistry(f.archive, {
        root: f.root,
        fetchImpl: requested => (requested === f.url ? Response.json({ ...f.metadata, ...change }) : f.fetchImpl(requested)),
      }),
    );
  }
});

test('published provenance identifies the archive, repository, workflow, ref and commit', async t => {
  const f = await fixture(t);
  const options = { bytes: f.bytes, name: f.name, version: f.version, sha: SHA, ref: f.ref };
  verifyProvenance(f.document, options);
  for (const change of [{ sha: '2'.repeat(40) }, { ref: 'refs/heads/main' }, { version: '0.0.0' }, { bytes: Buffer.from('different') }]) {
    assert.throws(() => verifyProvenance(f.document, { ...options, ...change }), /does not identify/);
  }
  const result = await verifyPublished(f.archive, { root: f.root, fetchImpl: f.fetchImpl, sha: SHA, ref: f.ref });
  assert.equal(result.provenanceUrl, f.attestations);
});

test('post-publish checks retry propagation delays but never retry mismatched content', async t => {
  const f = await fixture(t);
  let attempts = 0;
  let waits = 0;
  const result = await verifyPublished(f.archive, {
    root: f.root,
    sha: SHA,
    ref: f.ref,
    sleep: async () => {
      waits++;
    },
    fetchImpl: requested => {
      if (requested === f.url && attempts++ === 0) return new Response('', { status: 404 });
      if (requested === f.attestations && waits === 1) return Response.json({ attestations: [] });
      return f.fetchImpl(requested);
    },
  });
  assert.equal(result.exists, true);
  assert.equal(waits, 2);
  await assert.rejects(
    verifyPublished(f.archive, {
      root: f.root,
      fetchImpl: f.fetchImpl,
      sha: '2'.repeat(40),
      ref: f.ref,
      sleep: async () => assert.fail('Mismatched provenance must not be retried'),
    }),
    /does not identify/,
  );
});
