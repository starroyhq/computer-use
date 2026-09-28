#!/bin/bash
# Repeatable Safari acceptance for the packaged Computer Use CLI.
# Requires the menu-bar app to be running, Safari open on a scrollable page,
# and Accessibility / Screen Recording already granted. If the profile is
# missing, pairing waits for approval in the local app.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export CU_ROOT="$ROOT"
export CU_CLI="${CU_CLI:-$ROOT/artifacts/Computer Use.app/Contents/Resources/bin/computer-use}"
export CU_PROFILE="${CU_PROFILE:-macos-accept}"
exec node --input-type=module - <<'EOF'
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const cli = process.env.CU_CLI;
const profile = process.env.CU_PROFILE;
const failures = [];
const summary = {};
let openedWindowId = 0;
let sessionId;

function fail(message) {
  failures.push(message);
  process.stderr.write(`FAIL ${message}\n`);
}

function run(args, timeout = 90_000) {
  const started = performance.now();
  const result = spawnSync(cli, args, { encoding: 'utf8', timeout });
  return {
    ms: Math.round(performance.now() - started),
    status: result.status,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    error: result.error,
  };
}

function parse(result, label) {
  const raw = result.stdout || result.stderr;
  let body;
  try {
    body = raw ? JSON.parse(raw) : undefined;
  } catch {
    fail(`${label}: response is not JSON (${result.status}): ${raw.slice(0, 300)}`);
    return undefined;
  }
  if (result.error) {
    fail(`${label}: ${result.error.message}`);
    return body;
  }
  if (body?.error && body.state === undefined) {
    fail(`${label}: ${body.error.code ?? 'error'} ${body.error.message ?? ''}`.trim());
    return undefined;
  }
  if (result.status !== 0) {
    fail(`${label}: exit ${result.status}: ${raw.slice(0, 300)}`);
    return undefined;
  }
  return body;
}

function call(method, params) {
  const result = run([method, '--profile', profile, '--json', JSON.stringify(params ?? {})]);
  return { ms: result.ms, body: parse(result, method) };
}

function safariWindows(targets) {
  return (Array.isArray(targets) ? targets : []).filter(
    target =>
      target.kind === 'desktop' &&
      /safari/i.test(String(target.appId ?? '')) &&
      String(target.title ?? '').trim().length > 0,
  );
}

function marker(observation) {
  const height = observation.imageHeight ?? 0;
  const elements = (observation.elements ?? []).filter(element => {
    const bounds = element.bounds;
    return (
      element.label &&
      bounds &&
      bounds.width > 24 &&
      bounds.height >= 8 &&
      bounds.height < 80 &&
      bounds.y > height * 0.2 &&
      bounds.y < height * 0.75
    );
  });
  elements.sort((a, b) => b.label.length - a.label.length);
  return elements[0];
}

function locate(observation, label, x) {
  const matches = (observation.elements ?? []).filter(element => element.label === label && element.bounds);
  matches.sort((a, b) => Math.abs(a.bounds.x - x) - Math.abs(b.bounds.x - x));
  return matches[0];
}

function scroll(session, snapshotId, direction, point) {
  return call('act', {
    sessionId: session,
    snapshotId,
    requestId: randomUUID(),
    action: { type: 'scroll', direction, amount: 5, unit: 'line', point },
    timeoutMs: 30_000,
  });
}

function openExampleWindow() {
  const script = `
tell application "Safari"
  set oldIds to {}
  repeat with existing in windows
    set end of oldIds to id of existing
  end repeat
  make new document with properties {URL:"https://example.com"}
  delay 1
  set newId to 0
  repeat with existing in windows
    set candidate to id of existing
    if oldIds does not contain candidate then set newId to candidate
  end repeat
  return newId as text
end tell`;
  const result = spawnSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 20_000 });
  if (result.status !== 0) {
    fail(`could not open a second Safari window: ${(result.stderr || result.stdout || '').trim()}`);
    return;
  }
  openedWindowId = Number((result.stdout || '').trim());
  if (!openedWindowId) fail('Safari did not report the new window id');
}

function closeExampleWindow() {
  if (!openedWindowId) return;
  const result = spawnSync(
    'osascript',
    ['-e', `tell application "Safari" to close (window id ${openedWindowId})`],
    { encoding: 'utf8', timeout: 15_000 },
  );
  if (result.status !== 0) fail(`could not close Safari window ${openedWindowId}: ${(result.stderr || '').trim()}`);
  else summary.closedExtraWindow = openedWindowId;
}

if (!existsSync(cli)) {
  process.stderr.write(`CLI not found: ${cli}\n`);
  process.exit(1);
}

const credential = join(homedir(), '.config', 'computer-use', `${profile}.json`);
if (!existsSync(credential)) {
  process.stderr.write(`Pairing profile ${profile} for Safari. Approve it in Computer Use.\n`);
  const paired = run(['pair', '--name', 'macOS acceptance', '--app', 'com.apple.Safari', '--profile', profile], 180_000);
  const body = parse(paired, 'pair');
  if (!body?.paired) {
    process.stderr.write(failures.map(item => `- ${item}`).join('\n') + '\n');
    process.exit(1);
  }
  summary.paired = true;
}

function desktopReady(body) {
  const desktop = body?.backends?.find(backend => backend.kind === 'desktop');
  return body?.stopped !== true && body?.paused !== true && desktop?.available === true;
}

const doctor = call('doctor', {});
summary.doctorMs = doctor.ms;
if (!desktopReady(doctor.body)) fail('doctor reports the desktop runtime is unavailable');

let targets = call('targets', {}).body;
let windows = safariWindows(targets);
if (windows.length < 1) fail('no titled Safari window is authorized for this profile');

const primary = windows.find(target => !/example domain/i.test(target.title)) ?? windows[0];
summary.targetTitle = primary.title;
const opened = call('session_open', { targetId: primary.id, mode: 'background' });
sessionId = opened.body?.sessionId;
if (!sessionId) fail('session_open did not return a session');

try {
  if (!sessionId) throw new Error('no session');
  const first = call('observe', { sessionId });
  summary.observeMs = first.ms;
  const observation = first.body?.observation ?? first.body;
  const snapshotId = first.body?.snapshotId;
  const chosen = observation ? marker(observation) : undefined;
  if (!snapshotId || !chosen) {
    fail('observe did not yield a snapshot and a mid-page element');
  } else {
    const point = {
      x: Math.round(chosen.bounds.x + chosen.bounds.width / 2),
      y: Math.round(chosen.bounds.y + chosen.bounds.height / 2),
    };
    const down = scroll(sessionId, snapshotId, 'down', point);
    summary.scrollActMs = down.ms;
    summary.scrollState = down.body?.state;
    summary.scrollEffect = down.body?.effect;
    if (down.body?.state !== 'executed' || !['confirmed', 'unconfirmed'].includes(down.body?.effect)) {
      fail(`scroll state/effect: ${down.body?.state ?? 'missing'} / ${down.body?.effect ?? 'missing'}`);
    }
    const afterDown = call('observe', { sessionId });
    const moved = afterDown.body ? locate(afterDown.body.observation ?? afterDown.body, chosen.label, chosen.bounds.x) : undefined;
    const dy = moved ? Math.round(moved.bounds.y - chosen.bounds.y) : null;
    summary.scrollDy = dy;
    let directionOk = dy !== null && dy <= -20;
    if (!directionOk && afterDown.body?.snapshotId) {
      const up = scroll(sessionId, afterDown.body.snapshotId, 'up', point);
      if (up.body?.state !== 'executed' || !['confirmed', 'unconfirmed'].includes(up.body?.effect)) {
        fail(`boundary scroll state/effect: ${up.body?.state ?? 'missing'} / ${up.body?.effect ?? 'missing'}`);
      }
      const afterUp = call('observe', { sessionId });
      const lifted = afterUp.body ? locate(afterUp.body.observation ?? afterUp.body, chosen.label, chosen.bounds.x) : undefined;
      const upDy = lifted && moved ? Math.round(lifted.bounds.y - moved.bounds.y) : null;
      summary.scrollUpDy = upDy;
      directionOk = upDy !== null && upDy >= 20;
      if (directionOk && afterUp.body?.snapshotId) scroll(sessionId, afterUp.body.snapshotId, 'down', point);
    } else if (directionOk && afterDown.body?.snapshotId) {
      scroll(sessionId, afterDown.body.snapshotId, 'up', point);
    }
    if (!directionOk) fail(`scroll direction not confirmed (down dy=${dy})`);
  }

  targets = call('targets', {}).body;
  windows = safariWindows(targets);
  if (windows.length < 2) openExampleWindow();
  const deadline = Date.now() + 20_000;
  while (safariWindows(call('targets', {}).body).length < 2 && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  windows = safariWindows(call('targets', {}).body);
  summary.safariWindows = windows.length;
  if (windows.length < 2) fail('need two titled Safari windows for the key refusal');
  else {
    const fresh = call('observe', { sessionId });
    const key = call('act', {
      sessionId,
      snapshotId: fresh.body?.snapshotId,
      requestId: randomUUID(),
      action: { type: 'key', keys: ['pagedown'] },
      timeoutMs: 30_000,
    });
    summary.keyState = key.body?.state;
    summary.keyCode = key.body?.error?.code;
    if (key.body?.state !== 'failed' || key.body?.error?.code !== 'background_unavailable') {
      fail(`key refusal: ${key.body?.state ?? 'missing'} / ${key.body?.error?.code ?? 'missing'}`);
    }
    const still = call('observe', { sessionId });
    summary.observeAfterRefusalMs = still.ms;
    if (!still.body?.snapshotId) fail('observe after key refusal did not return a snapshot');
    const runtime = call('doctor', {});
    if (!desktopReady(runtime.body)) fail('runtime stopped after the refused key');
  }
} finally {
  if (sessionId) call('session_close', { sessionId });
  closeExampleWindow();
}

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (failures.length) {
  process.stderr.write(`${failures.length} check(s) failed\n`);
  process.exit(1);
}
process.stderr.write('macOS Safari acceptance passed\n');
EOF
