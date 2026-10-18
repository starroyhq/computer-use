import { createHash } from 'node:crypto';
import { Agent, request as httpsRequest } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';

const MiB = 1024 * 1024;
const retryable = error => [408, 429, 500, 502, 503, 504].includes(error.statusCode) ||
  ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'ETIMEDOUT', 'UPLOAD_DEADLINE'].includes(error.code);
const failure = (code, statusCode) => Object.assign(new Error(code), { code, ...(statusCode ? { statusCode } : {}) });
const safeCode = code => typeof code === 'string' && /^[A-Za-z0-9_]{1,48}$/.test(code) ? code : 'MULTIPART_REQUEST_FAILED';
const md5 = bytes => createHash('md5').update(bytes).digest('base64');
const escapeXml = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
function xmlText(xml, tag) {
  // COS returns a small, fixed XML response. Reject DTDs, nested content and
  // unknown entities rather than resolving anything outside that response.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw failure('INVALID_MULTIPART_RESPONSE');
  const matches = [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))];
  if (matches.length !== 1 || /&(?!amp;|lt;|gt;|quot;|apos;)/.test(matches[0][1]))
    throw failure('INVALID_MULTIPART_RESPONSE');
  return matches[0][1].replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity]);
}

// Only public REST APIs and the official SDK's public signature generator are
// used. The SDK's multipart init/complete calls do not expose cancellable tasks.
export async function multipartUpload(params, {
  authorize, securityToken, signal, timeoutMs = 20 * 60_000, requestTimeoutMs = 2 * 60_000,
  heartbeatMs = 15_000, partSize = MiB, concurrency = 16, report = () => {},
  request = httpsRequest, wait = delay,
} = {}) {
  if (typeof authorize !== 'function' || !Buffer.isBuffer(params.Body) || params.Body.length === 0 ||
      params.ContentLength !== params.Body.length || !/^[a-z0-9-]+-\d+$/.test(params.Bucket) ||
      !/^[a-z]+-[a-z0-9-]+$/.test(params.Region) || typeof params.Key !== 'string' ||
      !params.Key.startsWith('computer-use/') || /[\r\n\0]/.test(params.Key))
    throw failure('INVALID_MULTIPART_PARAMETERS');
  if (![timeoutMs, requestTimeoutMs, heartbeatMs].every(n => Number.isFinite(n) && n > 0) ||
      !Number.isInteger(partSize) || partSize < MiB || partSize > 5 * 1024 * MiB ||
      !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32 ||
      Math.ceil(params.Body.length / partSize) > 10_000)
    throw failure('INVALID_MULTIPART_PARAMETERS');
  if (signal?.aborted) throw failure('UPLOAD_ABORTED');
  const host = `${params.Bucket}.cos.${params.Region}.myqcloud.com`;
  const pathname = `/${params.Key}`;
  const encodedPath = pathname.split('/').map(encodeURIComponent).join('/');
  const controller = new AbortController();
  const agent = new Agent({ keepAlive: true, maxSockets: concurrency });
  const abort = () => controller.abort(failure('UPLOAD_ABORTED'));
  signal?.addEventListener('abort', abort, { once: true });
  const totalDeadline = setTimeout(() => controller.abort(failure('UPLOAD_DEADLINE')), timeoutMs);
  const started = Date.now();
  let completedBytes = 0;
  let uploadId;
  let completed = false;
  let completionAttempted = false;
  const heartbeat = setInterval(() => report(`multipart confirmed ${completedBytes}/${params.Body.length} bytes; elapsed ${((Date.now() - started) / 1000).toFixed(1)}s`), heartbeatMs);

  async function send(method, query, body = Buffer.alloc(0), extraHeaders = {}, requestSignal = controller.signal, deadlineMs = requestTimeoutMs) {
    if (requestSignal?.aborted) throw requestSignal.reason || failure('UPLOAD_ABORTED');
    const headers = { host, 'content-length': String(body.length), ...extraHeaders,
      ...(securityToken ? { 'x-cos-security-token': securityToken } : {}) };
    try {
      headers.authorization = authorize({ Method: method, Pathname: pathname, Query: query, Headers: { ...headers } });
      if (typeof headers.authorization !== 'string' || !headers.authorization) throw failure('INVALID_COS_AUTHORIZATION');
    } catch {
      throw failure('INVALID_COS_AUTHORIZATION');
    }
    const suffix = Object.entries(query).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
    return new Promise((resolve, reject) => {
      let req;
      let response;
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        requestSignal?.removeEventListener('abort', cancel);
        if (error) {
          response?.destroy();
          req?.destroy();
          reject(error);
        } else resolve(result);
      };
      const cancel = () => finish(requestSignal.reason || failure('UPLOAD_ABORTED'));
      const deadline = setTimeout(() => finish(failure('UPLOAD_DEADLINE')), deadlineMs);
      requestSignal?.addEventListener('abort', cancel, { once: true });
      try {
        req = request({ protocol: 'https:', hostname: host, method, path: `${encodedPath}?${suffix}`, headers, agent }, res => {
          if (settled) { res.destroy(); return; }
          response = res;
          const chunks = [];
          let size = 0;
          res.on('data', chunk => {
            size += chunk.length;
            if (size > MiB) { finish(failure('INVALID_MULTIPART_RESPONSE')); return; }
            chunks.push(chunk);
          });
          res.once('aborted', () => finish(failure('ECONNRESET')));
          res.once('error', error => finish(failure(safeCode(error.code))));
          res.once('end', () => {
            if (settled) return;
            const text = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode < 200 || res.statusCode >= 300 || /<Error[>\s]/.test(text)) {
              let code = 'MULTIPART_REQUEST_FAILED';
              try { code = safeCode(xmlText(text, 'Code')); } catch { /* No raw response in diagnostics. */ }
              finish(failure(code, res.statusCode));
            } else finish(undefined, { text, headers: res.headers });
          });
        });
        req.once('error', error => finish(failure(safeCode(error.code))));
        req.end(body);
      } catch (error) {
        finish(failure(safeCode(error.code)));
      }
    });
  }

  try {
    const initHeaders = {
      'content-type': params.ContentType || 'application/octet-stream',
      'cache-control': params.CacheControl || '',
      'x-cos-server-side-encryption': params.ServerSideEncryption || 'AES256',
    };
    const init = await send('POST', { uploads: '' }, undefined, initHeaders);
    const initializedId = xmlText(init.text, 'UploadId');
    if (!/<InitiateMultipartUploadResult(?:\s[^>]*)?>[\s\S]*<\/InitiateMultipartUploadResult>/.test(init.text) || !initializedId || initializedId.length > 2048 || /[\r\n\0]/.test(initializedId))
      throw failure('INVALID_MULTIPART_RESPONSE');
    uploadId = initializedId;
    const count = Math.ceil(params.Body.length / partSize);
    const parts = new Array(count);
    let nextPart = 0;
    let firstError;
    const worker = async () => {
      while (nextPart < count && !controller.signal.aborted) {
        const index = nextPart++;
        const bytes = params.Body.subarray(index * partSize, Math.min((index + 1) * partSize, params.Body.length));
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const result = await send('PUT', { partNumber: String(index + 1), uploadId }, bytes, { 'content-md5': md5(bytes) });
            const etag = result.headers.etag;
            if (typeof etag !== 'string' || !/^(?:"[a-fA-F0-9]{32}"|[a-fA-F0-9]{32})$/.test(etag)) throw failure('INVALID_PART_ETAG');
            // The server validates Content-MD5; retain its ETag for completion.
            parts[index] = { PartNumber: index + 1, ETag: etag.replaceAll('"', '') };
            completedBytes += bytes.length;
            break;
          } catch (error) {
            if (controller.signal.aborted || attempt === 3 || !retryable(error)) throw error;
            report(`multipart part ${index + 1}/${count}: retry ${attempt + 1}/3`);
            await wait(250 * 2 ** (attempt - 1), undefined, { signal: controller.signal });
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, count) }, async () => {
      try { await worker(); } catch (error) {
        if (!firstError) firstError = error;
        controller.abort(error);
      }
    }));
    if (firstError) throw firstError;
    if (controller.signal.aborted) throw controller.signal.reason;
    const body = Buffer.from(`<CompleteMultipartUpload>${parts.map(part => `<Part><PartNumber>${part.PartNumber}</PartNumber><ETag>${escapeXml(`"${part.ETag}"`)}</ETag></Part>`).join('')}</CompleteMultipartUpload>`);
    // Completion is intentionally sent once. A lost response is resolved by the
    // caller's authenticated full-object readback before any new upload begins.
    completionAttempted = true;
    const result = await send('POST', { uploadId }, body, { 'content-type': 'application/xml', 'content-md5': md5(body) });
    if (/<!DOCTYPE|<!ENTITY/i.test(result.text) || !/<CompleteMultipartUploadResult(?:\s[^>]*)?>[\s\S]*<\/CompleteMultipartUploadResult>/.test(result.text)) throw failure('INVALID_MULTIPART_RESPONSE');
    completed = true;
    report(`multipart confirmed ${completedBytes}/${params.Body.length} bytes in ${count} parts`);
    return { parts: count };
  } catch (error) {
    if (completionAttempted) error.completionAttempted = true;
    throw error;
  } finally {
    clearInterval(heartbeat);
    clearTimeout(totalDeadline);
    signal?.removeEventListener('abort', abort);
    // Abort addresses only this UploadId, never a completed object. Use an
    // independent bounded request even after cancellation, to clean orphan parts.
    if (uploadId && !completed) {
      try { await send('DELETE', { uploadId }, undefined, {}, null, Math.min(requestTimeoutMs, 30_000)); }
      catch { report('multipart cleanup not confirmed; bucket lifecycle will expire remaining parts'); }
    }
    agent.destroy();
  }
}
