import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { multipartUpload } from './cos-multipart-upload.mjs';

const MiB = 1024 * 1024;
const bytes = Buffer.alloc(2 * MiB + 17, 97);
const params = body => ({ Bucket: 'computer-use-download-1308799022', Region: 'ap-guangzhou',
  Key: 'computer-use/verification/uploads/1-1/name & 日本語.zip', Body: body, ContentLength: body.length,
  ContentType: 'application/zip', CacheControl: 'public, max-age=31536000, immutable', ServerSideEncryption: 'AES256' });
const hash = body => createHash('md5').update(body).digest('hex');
const xmlId = 'id&amp;&lt;&quot;&apos;+/=';
const rawId = 'id&<\"\'+/=';
async function fixture(t, override = () => false) {
  const calls = [];
  const signatures = [];
  const logs = [];
  const sockets = new Set();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = { method: req.method, url: new URL(req.url, 'https://example.test'), headers: req.headers, body: Buffer.concat(chunks) };
    calls.push(call);
    if (await override(call, req, res)) return;
    if (call.method === 'POST' && call.url.searchParams.has('uploads')) {
      res.end(`<InitiateMultipartUploadResult><UploadId>${xmlId}</UploadId></InitiateMultipartUploadResult>`);
    } else if (call.method === 'PUT') {
      res.setHeader('ETag', `"${hash(call.body)}"`);
      res.end();
    } else if (call.method === 'POST') {
      res.end('<CompleteMultipartUploadResult><ETag>completed</ETag></CompleteMultipartUploadResult>');
    } else { res.statusCode = 204; res.end(); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const options = {
    authorize(value) { signatures.push(value); return 'SECRET_SIGNATURE'; },
    securityToken: 'SECRET_TOKEN',
    request(options, callback) {
      return httpRequest({ ...options, protocol: 'http:', hostname: '127.0.0.1', port: server.address().port, agent: false }, callback);
    },
    timeoutMs: 5000, requestTimeoutMs: 1000, heartbeatMs: 100,
    wait: async () => {}, report: value => logs.push(value),
  };
  return { calls, signatures, logs, sockets, options };
}

// The local HTTP sink exercises the exact native request lifecycle without
// publishing files or supplying credentials. Production remains HTTPS-only.
test('multipart preserves bytes, signed metadata, escaped XML and ordered completion under parallel upload', async t => {
  let active = 0;
  let peak = 0;
  const f = await fixture(t, async (call, req, res) => {
    if (call.method !== 'PUT') return false;
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, call.url.searchParams.get('partNumber') === '1' ? 30 : 5));
    active--;
    res.setHeader('ETag', `"${hash(call.body)}"`);
    res.end();
    return true;
  });
  assert.deepEqual(await multipartUpload(params(bytes), { ...f.options, concurrency: 2 }), { parts: 3 });
  assert.equal(peak, 2);
  const init = f.calls[0];
  assert.equal(init.headers['cache-control'], params(bytes).CacheControl);
  assert.equal(init.headers['content-type'], 'application/zip');
  assert.equal(init.headers['x-cos-server-side-encryption'], 'AES256');
  const parts = f.calls.filter(call => call.method === 'PUT').sort((a, b) => Number(a.url.searchParams.get('partNumber')) - Number(b.url.searchParams.get('partNumber')));
  assert.deepEqual(Buffer.concat(parts.map(call => call.body)), bytes);
  assert.deepEqual(parts.map(call => call.body.length), [MiB, MiB, 17]);
  for (const call of parts) {
    assert.equal(call.url.searchParams.get('uploadId'), rawId);
    assert.equal(call.headers['content-md5'], createHash('md5').update(call.body).digest('base64'));
  }
  const complete = f.calls.at(-1).body.toString();
  assert.match(complete, /<PartNumber>1<\/PartNumber>.*<PartNumber>2<\/PartNumber>.*<PartNumber>3<\/PartNumber>/);
  assert.match(complete, /<ETag>&quot;[a-f0-9]{32}&quot;<\/ETag>/);
  for (const signed of f.signatures) {
    assert.equal(signed.Pathname, `/${params(bytes).Key}`);
    assert.equal(signed.Headers.host, 'computer-use-download-1308799022.cos.ap-guangzhou.myqcloud.com');
    assert.equal(signed.Headers['x-cos-security-token'], 'SECRET_TOKEN');
  }
  assert.ok(f.logs.some(line => line.includes(`${bytes.length}/${bytes.length}`)));
  assert.ok(!f.logs.join('').includes('SECRET'));
  assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 0);
});

test('a dropped part retries only the same upload ID and part number with identical bytes', async t => {
  let dropped = false;
  const f = await fixture(t, (call, req) => {
    if (call.method === 'PUT' && !dropped) { dropped = true; req.socket.destroy(); return true; }
    return false;
  });
  await multipartUpload(params(Buffer.alloc(MiB, 1)), f.options);
  const parts = f.calls.filter(call => call.method === 'PUT');
  assert.equal(parts.length, 2);
  assert.equal(parts[0].url.search, parts[1].url.search);
  assert.deepEqual(parts[0].body, parts[1].body);
  assert.equal(f.calls.filter(call => call.url.searchParams.has('uploads')).length, 1);
});

test('permission failures do not retry parts and abort only the current upload ID', async t => {
  const f = await fixture(t, (call, req, res) => {
    if (call.method !== 'PUT') return false;
    res.statusCode = 403;
    res.end('<Error><Code>AccessDenied</Code><Message>SECRET_RESPONSE</Message></Error>');
    return true;
  });
  await assert.rejects(multipartUpload(params(Buffer.alloc(MiB)), f.options), { code: 'AccessDenied', statusCode: 403 });
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1);
  assert.equal(f.calls.filter(call => call.method === 'POST' && !call.url.searchParams.has('uploads')).length, 0);
  assert.equal(f.calls.at(-1).method, 'DELETE');
  assert.equal(f.calls.at(-1).url.searchParams.get('uploadId'), rawId);
  assert.ok(!f.logs.join('').includes('SECRET'));
});

test('completion with a lost response is never replayed and its socket is truly closed', async t => {
  let completeSocketClosed;
  const closed = new Promise(resolve => { completeSocketClosed = resolve; });
  const f = await fixture(t, (call, req, res) => {
    if (call.method !== 'POST' || call.url.searchParams.has('uploads')) return false;
    res.once('close', completeSocketClosed);
    return true;
  });
  await assert.rejects(multipartUpload(params(Buffer.alloc(MiB)), { ...f.options, requestTimeoutMs: 50 }), { code: 'UPLOAD_DEADLINE', completionAttempted: true });
  await closed;
  assert.equal(f.calls.filter(call => call.method === 'POST' && !call.url.searchParams.has('uploads')).length, 1);
  assert.equal(f.calls.at(-1).method, 'DELETE');
});

test('cancellation closes every active part request and still attempts bounded abort cleanup', async t => {
  const stop = new AbortController();
  let activeParts = 0;
  const closed = [];
  const f = await fixture(t, (call, req, res) => {
    if (call.method !== 'PUT') return false;
    closed.push(new Promise(resolve => res.once('close', resolve)));
    if (++activeParts === 2) stop.abort();
    return true;
  });
  await assert.rejects(multipartUpload(params(bytes), { ...f.options, signal: stop.signal, concurrency: 2 }), { code: 'UPLOAD_ABORTED' });
  await Promise.all(closed);
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 2);
  assert.equal(f.calls.at(-1).method, 'DELETE');
});

test('total deadline closes an initialization request even before an upload ID is known', async t => {
  let close;
  const closed = new Promise(resolve => { close = resolve; });
  const f = await fixture(t, (call, req, res) => { res.once('close', close); return true; });
  await assert.rejects(multipartUpload(params(bytes), { ...f.options, timeoutMs: 50 }), { code: 'UPLOAD_DEADLINE' });
  await closed;
  assert.equal(f.calls.length, 1);
});

test('invalid ETag is rejected before completion; cleanup uses only the known upload ID', async t => {
  const f = await fixture(t, (call, req, res) => {
    if (call.method !== 'PUT') return false;
    res.setHeader('ETag', '<unsafe>'); res.end(); return true;
  });
  await assert.rejects(multipartUpload(params(Buffer.alloc(MiB)), f.options), { code: 'INVALID_PART_ETAG' });
  assert.deepEqual(f.calls.map(call => call.method), ['POST', 'PUT', 'DELETE']);
});

test('200 Error completion and malformed XML are failures without replay or raw response leakage', async t => {
  for (const response of ['<Error><Code>InternalError</Code><Message>SECRET_RESPONSE</Message></Error>', '<Other>SECRET_RESPONSE</Other>']) {
    const f = await fixture(t, (call, req, res) => {
      if (call.method !== 'POST' || call.url.searchParams.has('uploads')) return false;
      res.end(response); return true;
    });
    await assert.rejects(multipartUpload(params(Buffer.alloc(MiB)), f.options), error => {
      assert.equal(error.completionAttempted, true);
      assert.ok(!error.message.includes('SECRET'));
      return true;
    });
    assert.equal(f.calls.filter(call => call.method === 'POST' && !call.url.searchParams.has('uploads')).length, 1);
  }
});

test('DTD, duplicate IDs and unknown XML entities fail closed without any part requests', async t => {
  for (const body of ['<!DOCTYPE x><UploadId>id</UploadId>', '<UploadId>a</UploadId><UploadId>b</UploadId>', '<UploadId>&external;</UploadId>']) {
    const f = await fixture(t, (call, req, res) => { res.end(body); return true; });
    await assert.rejects(multipartUpload(params(bytes), f.options), { code: 'INVALID_MULTIPART_RESPONSE' });
    assert.equal(f.calls.length, 1);
  }
});

test('pre-cancelled calls, invalid parameters and signer failures never send requests', async t => {
  const f = await fixture(t);
  const stop = new AbortController(); stop.abort();
  await assert.rejects(multipartUpload(params(bytes), { ...f.options, signal: stop.signal }), { code: 'UPLOAD_ABORTED' });
  await assert.rejects(multipartUpload({ ...params(bytes), Key: 'other/file' }, f.options), { code: 'INVALID_MULTIPART_PARAMETERS' });
  await assert.rejects(multipartUpload(params(bytes), { ...f.options, authorize() { throw new Error('SECRET_SIGNATURE'); } }), { code: 'INVALID_COS_AUTHORIZATION' });
  assert.equal(f.calls.length, 0);
});
