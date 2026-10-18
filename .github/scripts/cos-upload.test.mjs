import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { uploadOnce } from './cos-upload.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const parameters = (body = Buffer.alloc(196_731, 37)) => ({
  Bucket: 'fixture-1234567890', Region: 'ap-guangzhou', Key: 'computer-use/verification/fixture.zip',
  Body: body, ContentLength: body.length, CacheControl: 'public, max-age=31536000, immutable',
  ServerSideEncryption: 'AES256', ContentType: 'application/octet-stream',
});

function fakeClient(perform) {
  const calls = [];
  const canceled = [];
  return {
    calls, canceled,
    putObject(params, callback) {
      const call = { params, callback, id: `task-${calls.length + 1}` };
      calls.push(call);
      params.onTaskReady(call.id);
      perform?.(call);
    },
    cancelTask(id) { canceled.push(id); },
  };
}

async function readBody(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function settleWithin(promise, ms = 2_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Upload did not settle within test deadline')), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

test('uploadOnce sends bounded byte chunks and preserves object metadata and content', async () => {
  const params = parameters();
  let received;
  const chunks = [];
  const client = fakeClient(({ params: request, callback }) => {
    assert.equal(request.Body.readableObjectMode, false);
    assert.notEqual(request.Body, params.Body);
    for (const key of Object.keys(params).filter(key => key !== 'Body')) assert.equal(request[key], params[key]);
    request.Body.on('data', chunk => { assert.ok(Buffer.isBuffer(chunk)); chunks.push(chunk); });
    request.Body.on('end', () => { received = Buffer.concat(chunks); callback(null, { ETag: 'fixture-etag' }); });
  });
  await settleWithin(uploadOnce(client, params));
  assert.equal(digest(received), digest(params.Body));
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.length > 0 && chunk.length <= 64 * 1024));
  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.canceled, []);
  assert.equal(client.calls[0].params.Body.destroyed, true);
  assert.ok(Buffer.isBuffer(params.Body), 'caller-owned parameters must not be replaced by a consumed stream');
});

test('repeated progress cannot settle the upload or retain heartbeat work after success', async () => {
  const messages = [];
  let completed = false;
  const client = fakeClient(({ params, callback }) => {
    params.Body.resume();
    params.onProgress({ loaded: 65_536, total: params.ContentLength });
    params.onProgress({ loaded: 65_536, total: params.ContentLength });
    setTimeout(() => callback(null, {}), 40);
  });
  const pending = uploadOnce(client, parameters(), { heartbeatMs: 5, report: message => messages.push(message) })
    .then(() => { completed = true; });
  await delay(10);
  assert.equal(completed, false);
  await settleWithin(pending);
  assert.ok(messages.length > 0);
  const count = messages.length;
  await delay(20);
  assert.equal(messages.length, count);
  assert.deepEqual(client.canceled, []);
});

test('deadline cancels the task, destroys its stream and ignores late callbacks and progress', async () => {
  const messages = [];
  const client = fakeClient();
  await assert.rejects(settleWithin(uploadOnce(client, parameters(), {
    timeoutMs: 25, heartbeatMs: 5, report: message => messages.push(message),
  })), { code: 'UPLOAD_DEADLINE' });
  const call = client.calls[0];
  assert.deepEqual(client.canceled, [call.id]);
  assert.equal(call.params.Body.destroyed, true);
  const count = messages.length;
  call.callback(null, {});
  call.callback(Object.assign(new Error('late failure'), { code: 'ECONNRESET' }));
  call.params.onProgress({ loaded: call.params.ContentLength, total: call.params.ContentLength });
  await delay(20);
  assert.equal(messages.length, count);
  assert.deepEqual(client.canceled, [call.id]);
});

test('deadline cancels a request whose source already ended while the response is missing', async () => {
  let received;
  const client = fakeClient(({ params }) => { readBody(params.Body).then(bytes => { received = bytes; }); });
  const params = parameters();
  await assert.rejects(settleWithin(uploadOnce(client, params, { timeoutMs: 50, heartbeatMs: 5 })), { code: 'UPLOAD_DEADLINE' });
  assert.deepEqual(received, params.Body);
  assert.equal(client.calls[0].params.Body.destroyed, true);
  assert.deepEqual(client.canceled, ['task-1']);
});

test('an already aborted signal never starts an upload or logs progress', async () => {
  const controller = new AbortController();
  controller.abort();
  const messages = [];
  const client = fakeClient();
  await assert.rejects(uploadOnce(client, parameters(), { signal: controller.signal, report: message => messages.push(message) }), { code: 'UPLOAD_ABORTED' });
  assert.equal(client.calls.length, 0);
  assert.deepEqual(client.canceled, []);
  assert.deepEqual(messages, []);
});

test('abort closes an active upload and a later deadline cannot cancel it again', async () => {
  const controller = new AbortController();
  const client = fakeClient();
  const pending = uploadOnce(client, parameters(), { signal: controller.signal, timeoutMs: 30, heartbeatMs: 5 });
  controller.abort();
  await assert.rejects(settleWithin(pending), { code: 'UPLOAD_ABORTED' });
  assert.equal(client.calls[0].params.Body.destroyed, true);
  assert.deepEqual(client.canceled, ['task-1']);
  await delay(45);
  assert.deepEqual(client.canceled, ['task-1']);
});

test('a second attempt creates a fresh stream and starts again at byte zero', async () => {
  const params = parameters();
  const received = [];
  const failure = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
  const client = fakeClient(({ params: request, callback, id }) => {
    readBody(request.Body).then(bytes => {
      received.push(bytes);
      callback(id === 'task-1' ? failure : null, {});
    });
  });
  await assert.rejects(uploadOnce(client, params), error => error === failure);
  await settleWithin(uploadOnce(client, params));
  assert.equal(received.length, 2);
  for (const bytes of received) assert.deepEqual(bytes, params.Body);
  assert.notEqual(client.calls[0].params.Body, client.calls[1].params.Body);
  assert.ok(client.calls.every(call => call.params.Body.destroyed));
});

test('ordinary and synchronous SDK failures settle and clean up without logging signed error details', async () => {
  for (const synchronous of [false, true]) {
    const failure = Object.assign(new Error('private-test-secret signed request'), {
      code: 'ECONNRESET', headers: { Authorization: 'private-test-secret' },
    });
    const messages = [];
    const client = fakeClient(({ callback }) => {
      if (synchronous) throw failure;
      setImmediate(() => callback(failure));
    });
    await assert.rejects(settleWithin(uploadOnce(client, parameters(), {
      timeoutMs: 30, heartbeatMs: 5, report: message => messages.push(message),
    })), error => error === failure);
    assert.equal(client.calls[0].params.Body.destroyed, true);
    const count = messages.length;
    await delay(45);
    assert.equal(messages.length, count);
    assert.doesNotMatch(JSON.stringify(messages), /private-test-secret|signed request|Authorization/);
  }
});

let COS;
try {
  COS = createRequire(new URL('../cos/package.json', import.meta.url))('cos-nodejs-sdk-v5');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

test('real pinned SDK releases the socket after the complete body receives no response', { skip: !COS }, async t => {
  const sockets = new Set();
  let received = 0;
  let ended = false;
  const server = createServer(request => {
    request.on('data', chunk => { received += chunk.length; });
    request.on('end', () => { ended = true; });
    // Deliberately leave the response pending after consuming the whole body.
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new COS({
    SecretId: 'fixture-id', SecretKey: 'fixture-secret', Protocol: 'http:',
    Domain: `127.0.0.1:${server.address().port}`, Timeout: 5_000, KeepAlive: false,
  });
  const params = parameters(Buffer.alloc(1024 * 1024, 97));
  await assert.rejects(settleWithin(uploadOnce(client, params, { timeoutMs: 300, heartbeatMs: 20 })), { code: 'UPLOAD_DEADLINE' });
  assert.equal(ended, true);
  assert.equal(received, params.Body.length);
  for (let i = 0; i < 30 && sockets.size; i++) await delay(10);
  assert.equal(sockets.size, 0, 'total deadline must close the HTTP socket, not merely reject a wrapper promise');
  assert.equal(client.getTaskList()[0].state, 'canceled');
});
