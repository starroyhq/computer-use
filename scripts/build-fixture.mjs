import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';

// 两个一次性验证用 App：原生输入控件，以及仿浏览器终端（xterm.js）的 WebKit 页面。
const fixtures = [
  {
    source: 'validation/DesktopFixture.swift',
    name: 'Computer Use Fixture',
    executable: 'ComputerUseFixture',
    id: 'fixture',
    frameworks: ['AppKit'],
  },
  {
    source: 'validation/WebKitFixture.swift',
    name: 'Computer Use WebKit Fixture',
    executable: 'ComputerUseWebKitFixture',
    id: 'webkit-fixture',
    frameworks: ['AppKit', 'WebKit'],
  },
];
for (const fixture of fixtures) {
  const app = resolve(`artifacts/${fixture.name}.app`);
  await mkdir(join(app, 'Contents/MacOS'), { recursive: true });
  execFileSync(
    'swiftc',
    [fixture.source, '-o', join(app, 'Contents/MacOS', fixture.executable), ...fixture.frameworks.flatMap(name => ['-framework', name])],
    { stdio: 'inherit' },
  );
  await writeFile(
    join(app, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.starroy.computeruse.${fixture.id}</string>
<key>CFBundleName</key><string>${fixture.name}</string>
<key>CFBundleExecutable</key><string>${fixture.executable}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
</dict></plist>
`,
  );
  execFileSync('codesign', ['--force', '--sign', '-', app], { stdio: 'inherit' });
  process.stdout.write(app + '\n');
}
