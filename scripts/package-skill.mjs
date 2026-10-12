import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkSkill, skillDirectory } from './build-skill.mjs';

/** A signed package must contain the same standalone Skill and instructions checked at build time. */
export async function verifySkillResources(directory) {
  const expected = await checkSkill();
  if ((await readFile(join(directory, 'SKILL.md'), 'utf8')) !== expected)
    throw new Error('The packaged Skill does not match the generated Skill.');
  if ((await readFile(join(directory, 'instructions.md'), 'utf8')) !== (await readFile(join(skillDirectory, 'instructions.md'), 'utf8')))
    throw new Error('The packaged instructions do not match this build.');
}
