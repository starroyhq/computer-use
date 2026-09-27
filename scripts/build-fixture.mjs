import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const app = resolve('artifacts/Computer Use Fixture.app');
await mkdir(join(app, 'Contents/MacOS'), { recursive: true });
execFileSync('swiftc', ['validation/DesktopFixture.swift', '-o', join(app, 'Contents/MacOS/ComputerUseFixture'), '-framework', 'AppKit'], { stdio: 'inherit' });
await writeFile(join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.starroy.computeruse.fixture</string>
<key>CFBundleName</key><string>Computer Use Fixture</string>
<key>CFBundleExecutable</key><string>ComputerUseFixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
</dict></plist>
`);
execFileSync('codesign', ['--force', '--sign', '-', app], { stdio: 'inherit' });
process.stdout.write(app + '\n');
