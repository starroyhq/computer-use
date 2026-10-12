import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const skillDirectory = join(root, 'skills', 'computer-use');

/** The copied SKILL.md is deliberately standalone; these source files are build inputs only. */
export async function renderSkill(directory = skillDirectory) {
  const [template, instructions, macos, windows] = await Promise.all(
    ['template.md', 'instructions.md', 'bootstrap-macos.sh', 'bootstrap-windows.ps1'].map(name => readFile(join(directory, name), 'utf8')),
  );
  const replacements = { INSTRUCTIONS: instructions, MACOS_BOOTSTRAP: macos, WINDOWS_BOOTSTRAP: windows };
  let output = template;
  for (const [key, value] of Object.entries(replacements)) {
    const placeholder = `{{${key}}}`;
    if (output.split(placeholder).length !== 2) throw new Error(`Expected exactly one ${placeholder} in the Skill template.`);
    output = output.replace(placeholder, () => value.trimEnd());
  }
  return `${output.trimEnd()}\n`;
}

export async function checkSkill(directory = skillDirectory) {
  const expected = await renderSkill(directory);
  if ((await readFile(join(directory, 'SKILL.md'), 'utf8')) !== expected)
    throw new Error('SKILL.md is out of date. Run node scripts/build-skill.mjs.');
  return expected;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) throw new Error('Usage: build-skill.mjs [--check]');
  if (args[0] === '--check') await checkSkill();
  else await writeFile(join(skillDirectory, 'SKILL.md'), await renderSkill());
}
