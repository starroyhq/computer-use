import { Readable } from 'node:stream';

// A Buffer is written in one call by cos-request and does not emit useful drain
// progress. A fresh, bounded stream also disables the SDK's hidden PUT retries.
function uploadBody(bytes) {
  return Readable.from((function* () {
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024)
      yield bytes.subarray(offset, offset + 64 * 1024);
  })(), { objectMode: false, highWaterMark: 64 * 1024 });
}

export function uploadOnce(client, params, {
  timeoutMs = 10 * 60_000, heartbeatMs = 15_000, report = () => {}, signal,
} = {}) {
  if (!Buffer.isBuffer(params.Body) || params.ContentLength !== params.Body.length)
    return Promise.reject(new Error('Upload requires verified bytes and an exact ContentLength.'));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(heartbeatMs) || heartbeatMs <= 0)
    return Promise.reject(new Error('Upload deadlines must be positive.'));
  const interrupted = code => Object.assign(new Error(code), { code });
  if (signal?.aborted) return Promise.reject(interrupted('UPLOAD_ABORTED'));
  return new Promise((resolve, reject) => {
    const body = uploadBody(params.Body);
    const started = Date.now();
    let taskId;
    let settled = false;
    let cancelled = false;
    let loaded = 0;
    let lastReport = 0;
    const progress = () => {
      lastReport = Date.now();
      report(`transferred ${loaded}/${params.ContentLength} bytes; elapsed ${((lastReport - started) / 1000).toFixed(1)}s`);
    };
    const finish = (error, result, cancel = false) => {
      if (settled) return;
      settled = true;
      cancelled = cancel;
      clearTimeout(deadline);
      clearInterval(heartbeat);
      signal?.removeEventListener('abort', abort);
      // cancelTask aborts the request even after the input stream has ended.
      // It suppresses the SDK callback, so settle our own promise below.
      if (cancel && taskId) client.cancelTask(taskId);
      body.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => finish(interrupted('UPLOAD_ABORTED'), undefined, true);
    const deadline = setTimeout(() => finish(interrupted('UPLOAD_DEADLINE'), undefined, true), timeoutMs);
    const heartbeat = setInterval(progress, heartbeatMs);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      client.putObject({
        ...params, Body: body,
        onTaskReady(id) {
          taskId = id;
          if (cancelled) client.cancelTask(id);
        },
        onProgress(value) {
          if (settled) return;
          if (Number.isFinite(value.loaded)) loaded = Math.max(loaded, Math.min(params.ContentLength, value.loaded));
          if (Date.now() - lastReport >= heartbeatMs || loaded === params.ContentLength) progress();
        },
      }, (error, result) => finish(error, result));
    } catch (error) {
      finish(error, undefined, true);
    }
  });
}
