import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

// Regenerate the checked-in platform containers without adding a build dependency.
// Artwork edits belong in the SVG source; this script only renders and packages it.
if (process.platform !== 'darwin') throw new Error('Icon conversion requires macOS sips and iconutil.');
const assets = fileURLToPath(new URL('../assets/', import.meta.url));
const source = join(assets, 'app-icon.png');
const stage = await mkdtemp(join(tmpdir(), 'computer-use-icons-'));
try {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(join(assets, 'app-icon.svg')).href);
    await page.screenshot({ path: source, omitBackground: true });
    // The menu-bar glyph shares the app's exact contour, with no tile and a white fill.
    const cursorPath = await page.locator('svg > path').getAttribute('d');
    if (!cursorPath) throw new Error('The app SVG must contain a cursor path.');
    const menuSvg = join(assets, 'menu-bar-icon.svg');
    await writeFile(
      menuSvg,
      `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="256 256 512 512">\n  <title>Computer Use menu bar</title>\n  <path d="${cursorPath}" fill="#FFF"/>\n</svg>\n`,
    );
    const menuPage = await browser.newPage({ viewport: { width: 18, height: 18 }, deviceScaleFactor: 2 });
    await menuPage.goto(pathToFileURL(menuSvg).href);
    await menuPage.screenshot({ path: join(assets, 'menu-bar-icon.png'), omitBackground: true });
  } finally {
    await browser.close();
  }
  const iconset = join(stage, 'app-icon.iconset');
  await mkdir(iconset);
  const resize = (size, output) =>
    execFileSync('/usr/bin/sips', ['-z', String(size), String(size), source, '--out', output], { stdio: 'ignore' });
  for (const size of [16, 32, 128, 256, 512]) {
    resize(size, join(iconset, `icon_${size}x${size}.png`));
    resize(size * 2, join(iconset, `icon_${size}x${size}@2x.png`));
  }
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', join(assets, 'app-icon.icns')]);

  // PNG-backed ICO entries retain alpha and are supported on the Windows 10 baseline.
  const sizes = [16, 20, 24, 32, 48, 64, 128, 256];
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  const frames = [];
  let offset = header.length;
  for (const [index, size] of sizes.entries()) {
    const output = join(stage, `${size}.png`);
    resize(size, output);
    const frame = await readFile(output);
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(frame.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    frames.push(frame);
    offset += frame.length;
  }
  await writeFile(join(assets, 'app-icon.ico'), Buffer.concat([header, ...frames]));
  console.log('Generated app PNG/ICNS/ICO and white menu-bar SVG/PNG from assets/app-icon.svg.');
} finally {
  await rm(stage, { recursive: true, force: true });
}
