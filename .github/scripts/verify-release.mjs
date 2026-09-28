import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function main(directory, tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('Invalid release tag.');
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) throw new Error('Missing GitHub repository.');
  const release = JSON.parse(execFileSync('gh', ['api', `repos/${repository}/releases/tags/${tag}`], { encoding: 'utf8' }));
  if (release.tag_name !== tag || !release.draft || !release.prerelease) throw new Error('Expected a draft prerelease for the tag.');
  const files = (await readdir(directory)).sort();
  const assets = new Map(release.assets.map(asset => [asset.name, asset]));
  if (files.length !== 9 || assets.size !== 9 || files.some(file => !assets.has(file))) throw new Error('Release asset list differs from verified files.');
  for (const file of files) {
    const path = join(directory, file);
    const asset = assets.get(file);
    if (asset.size !== (await stat(path)).size || asset.digest !== `sha256:${await sha256(path)}`) {
      throw new Error(`Release asset differs from local file: ${file}`);
    }
  }
  console.log(`Verified ${files.length} uploaded assets for ${tag}.`);
}

const args = process.argv.slice(2);
if (args.length !== 2) throw new Error('Usage: verify-release.mjs DIRECTORY TAG');
main(...args).catch(error => { console.error(error.message); process.exitCode = 1; });
