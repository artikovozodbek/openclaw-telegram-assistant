#!/usr/bin/env node
/**
 * Export an Instagram reel/video file from the logged-in browser via CDP.
 *
 * Usage:
 *   node export-instagram-video.js \
 *     --reel-url "https://www.instagram.com/example_handle/reel/ABC123/" \
 *     --output-file /tmp/openclaw/uploads/latest.mp4
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function parseArgs(argv) {
  const result = { _: [] };
  let i = 0;
  while (i < argv.length) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        result[key] = argv[i + 1];
        i += 2;
      } else {
        result[key] = true;
        i += 1;
      }
    } else {
      result._.push(argv[i]);
      i += 1;
    }
  }
  return result;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function uploadsDir() {
  const dirPath = path.join(os.tmpdir(), 'openclaw', 'uploads');
  ensureDir(dirPath);
  return dirPath;
}

function loadConfigCdpUrl() {
  const candidatePaths = [
    path.join(__dirname, '../../../../openclaw.json'),
    path.join(__dirname, '../../../../config/openclaw.json'),
    path.join(process.cwd(), 'openclaw.json'),
    path.join(process.cwd(), 'config/openclaw.json')
  ];

  for (const configPath of candidatePaths) {
    if (!fs.existsSync(configPath)) continue;
    const raw = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw);
    const cdpUrl =
      config?.browser?.profiles?.user?.cdpUrl ||
      config?.browser?.profiles?.openclaw?.cdpUrl ||
      config?.browser?.profiles?.['chrome-cdp']?.cdpUrl ||
      null;
    if (cdpUrl) return cdpUrl;
  }

  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.eventWaiters = [];
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;

      ws.onopen = () => resolve();
      ws.onerror = event => {
        const message = event?.message || 'CDP websocket connection failed';
        reject(new Error(message));
      };
      ws.onmessage = event => this.handleMessage(String(event.data));
      ws.onclose = () => {
        for (const [, pending] of this.pending) {
          pending.reject(new Error('CDP websocket closed'));
        }
        this.pending.clear();
      };
    });
  }

  handleMessage(payload) {
    let message;
    try {
      message = JSON.parse(payload);
    } catch {
      return;
    }

    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result || {});
      }
      return;
    }

    for (const waiter of [...this.eventWaiters]) {
      if (waiter.matches(message)) {
        clearTimeout(waiter.timeoutId);
        this.eventWaiters = this.eventWaiters.filter(item => item !== waiter);
        waiter.resolve(message);
      }
    }
  }

  send(method, params = {}, sessionId = null) {
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) {
      message.sessionId = sessionId;
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(message));
    });
  }

  waitForEvent(matches, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.eventWaiters = this.eventWaiters.filter(item => item !== waiter);
        reject(new Error(`Timed out waiting for CDP event after ${timeoutMs} ms`));
      }, timeoutMs);

      const waiter = { matches, resolve, reject, timeoutId };
      this.eventWaiters.push(waiter);
    });
  }

  async close() {
    if (!this.ws) return;
    try {
      this.ws.close();
    } catch {}
    this.ws = null;
  }
}

function escapeForSingleQuotedJs(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

async function evaluateJson(client, sessionId, expression) {
  const result = await client.send(
    'Runtime.evaluate',
    {
      expression,
      awaitPromise: true,
      returnByValue: true
    },
    sessionId
  );

  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed');
  }

  return result.result?.value;
}

async function waitForVideoReady(client, sessionId, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = await evaluateJson(
      client,
      sessionId,
      `(() => {
        const video = document.querySelector('video');
        if (!video) {
          return { ok: false, reason: 'NO_VIDEO' };
        }
        return {
          ok: Boolean(video.currentSrc || video.src),
          reason: video.currentSrc || video.src ? null : 'NO_SOURCE',
          src: video.currentSrc || video.src || null,
          readyState: video.readyState,
          paused: video.paused,
          title: document.title,
          bodyText: document.body && document.body.innerText ? document.body.innerText.slice(0, 500) : ''
        };
      })()`
    );

    if (state?.ok) {
      return state;
    }

    if (state?.bodyText && state.bodyText.includes("Sorry, this page isn't available")) {
      throw new Error('Instagram reel page is unavailable when reopened by URL. Use the already-open reel page with --target-id / --browser-target-id.');
    }

    await evaluateJson(
      client,
      sessionId,
      `(() => {
        const video = document.querySelector('video');
        if (!video) return null;
        video.muted = true;
        video.playsInline = true;
        const playResult = video.play();
        if (playResult && typeof playResult.catch === 'function') {
          playResult.catch(() => {});
        }
        return true;
      })()`
    );

    await sleep(750);
  }

  throw new Error(`Timed out waiting for reel video to become ready after ${timeoutMs} ms`);
}

async function exportVideoIntoPageMemory(client, sessionId, key) {
  const jsKey = escapeForSingleQuotedJs(key);
  const expression = `(async () => {
    const storeKey = '${jsKey}';
    const rawChunkSize = 96 * 1024;
    const stringStep = 0x8000;

    function chunkBlobIntoBase64(blob) {
      return blob.arrayBuffer().then(buffer => {
        const bytes = new Uint8Array(buffer);
        const chunks = [];

        for (let offset = 0; offset < bytes.length; offset += rawChunkSize) {
          const part = bytes.subarray(offset, Math.min(offset + rawChunkSize, bytes.length));
          let binary = '';
          for (let i = 0; i < part.length; i += stringStep) {
            binary += String.fromCharCode.apply(null, part.subarray(i, Math.min(i + stringStep, part.length)));
          }
          chunks.push(btoa(binary));
        }

        return {
          chunks,
          chunkCount: chunks.length,
          size: blob.size,
          mimeType: blob.type || 'video/mp4'
        };
      });
    }

    async function storeBlob(blob, src, sourceType) {
      const prepared = await chunkBlobIntoBase64(blob);
      window[storeKey] = {
        chunks: prepared.chunks,
        chunkCount: prepared.chunkCount,
        size: prepared.size,
        mimeType: prepared.mimeType,
        src,
        createdAt: Date.now()
      };

      return {
        ok: true,
        storeKey,
        chunkCount: prepared.chunkCount,
        size: prepared.size,
        mimeType: prepared.mimeType,
        src,
        sourceType
      };
    }

    async function recordViaCaptureStream(video, src) {
      const captureStream = video.captureStream || video.mozCaptureStream;
      if (!captureStream) {
        throw new Error('captureStream is not supported on this browser video element');
      }

      const stream = captureStream.call(video);
      const mimeCandidates = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm'
      ];
      const mimeType = mimeCandidates.find(value => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(value)) || 'video/webm';
      const recorder = new MediaRecorder(stream, { mimeType });
      const recordedChunks = [];

      recorder.addEventListener('dataavailable', event => {
        if (event.data && event.data.size > 0) {
          recordedChunks.push(event.data);
        }
      });

      const finished = new Promise((resolve, reject) => {
        recorder.addEventListener('stop', () => resolve(), { once: true });
        recorder.addEventListener('error', event => reject(new Error(event.error?.message || 'MediaRecorder failed')), { once: true });
      });

      const durationMs = Number.isFinite(video.duration) && video.duration > 0
        ? Math.ceil(video.duration * 1000) + 1200
        : 45000;
      const maxDurationMs = Math.min(Math.max(durationMs, 5000), 90000);

      try {
        video.currentTime = 0;
      } catch {}

      recorder.start(1000);
      const playResult = video.play();
      if (playResult && typeof playResult.catch === 'function') {
        playResult.catch(() => {});
      }

      await Promise.race([
        new Promise(resolve => video.addEventListener('ended', resolve, { once: true })),
        new Promise(resolve => setTimeout(resolve, maxDurationMs))
      ]);

      if (recorder.state !== 'inactive') {
        recorder.stop();
      }
      await finished;

      if (recordedChunks.length === 0) {
        throw new Error('captureStream recording returned no data');
      }

      const recordedBlob = new Blob(recordedChunks, { type: recorder.mimeType || mimeType || 'video/webm' });
      return storeBlob(recordedBlob, src, 'capture_stream_recording');
    }

    const video = document.querySelector('video');
    if (!video) {
      return { ok: false, error: 'NO_VIDEO_ELEMENT' };
    }

    video.muted = true;
    video.playsInline = true;
    const playResult = video.play();
    if (playResult && typeof playResult.catch === 'function') {
      playResult.catch(() => {});
    }

    const src = video.currentSrc || video.src || null;
    if (!src) {
      return { ok: false, error: 'NO_VIDEO_SOURCE' };
    }

    try {
      const response = await fetch(src);
      const blob = await response.blob();
      return storeBlob(blob, src, src.startsWith('blob:') ? 'blob_fetch' : 'direct_fetch');
    } catch (error) {
      if (src.startsWith('blob:')) {
        try {
          return await recordViaCaptureStream(video, src);
        } catch (recordingError) {
          return {
            ok: false,
            error: recordingError && recordingError.message ? recordingError.message : String(recordingError),
            src,
            exportFallback: 'capture_stream_recording'
          };
        }
      }

      return {
        ok: false,
        error: error && error.message ? error.message : String(error),
        src
      };
    }
  })()`;

  return evaluateJson(client, sessionId, expression);
}

async function readChunk(client, sessionId, key, index) {
  const jsKey = escapeForSingleQuotedJs(key);
  const expression = `(() => {
    const store = window['${jsKey}'];
    if (!store) {
      return { ok: false, error: 'STORE_NOT_FOUND' };
    }
    const chunk = store.chunks[${index}] || null;
    store.chunks[${index}] = null;
    return { ok: true, chunk };
  })()`;

  return evaluateJson(client, sessionId, expression);
}

async function clearStore(client, sessionId, key) {
  const jsKey = escapeForSingleQuotedJs(key);
  await evaluateJson(
    client,
    sessionId,
    `(() => {
      delete window['${jsKey}'];
      return true;
    })()`
  );
}

async function writeChunksToFile(client, sessionId, key, chunkCount, outputFile) {
  ensureDir(path.dirname(outputFile));
  const stream = fs.createWriteStream(outputFile);

  try {
    for (let index = 0; index < chunkCount; index += 1) {
      const result = await readChunk(client, sessionId, key, index);
      if (!result?.ok || !result.chunk) {
        throw new Error(`Missing exported chunk ${index + 1}/${chunkCount}`);
      }
      stream.write(Buffer.from(result.chunk, 'base64'));
    }
  } finally {
    await new Promise((resolve, reject) => {
      stream.end(error => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const reelUrl = args['reel-url'] || args.url;
  const targetIdArg = args['target-id'];
  if (!reelUrl && !targetIdArg) {
    throw new Error('Missing required --reel-url or --target-id');
  }

  const timeoutMs = Number(args['timeout-ms'] || 45000);
  const cdpUrl = args['cdp-url'] || process.env.OPENCLAW_CDP_URL || loadConfigCdpUrl();
  if (!cdpUrl) {
    throw new Error('Could not determine CDP URL');
  }

  const defaultOutput = path.join(uploadsDir(), `instagram_reel_${Date.now()}.mp4`);
  const requestedOutputFile = args['output-file'] || defaultOutput;
  const client = new CdpClient(cdpUrl);
  let sessionId = null;
  let targetId = null;
  let shouldCloseTarget = false;

  await client.connect();
  try {
    if (targetIdArg) {
      targetId = targetIdArg;
    } else {
      const created = await client.send('Target.createTarget', { url: 'about:blank' });
      targetId = created.targetId;
      shouldCloseTarget = true;
    }

    const attached = await client.send('Target.attachToTarget', {
      targetId,
      flatten: true
    });
    sessionId = attached.sessionId;

    await client.send('Page.enable', {}, sessionId);
    await client.send('Runtime.enable', {}, sessionId);
    await client.send('Network.enable', {}, sessionId);

    if (reelUrl && !targetIdArg) {
      const loadEvent = client.waitForEvent(
        message => message.sessionId === sessionId && message.method === 'Page.loadEventFired',
        timeoutMs
      ).catch(() => null);

      await client.send('Page.navigate', { url: reelUrl }, sessionId);
      await loadEvent;
      await sleep(1500);
    }

    const readyState = await waitForVideoReady(client, sessionId, timeoutMs);
    const exportKey = `__openclawVideoExport_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const exportResult = await exportVideoIntoPageMemory(client, sessionId, exportKey);
    if (!exportResult?.ok) {
      throw new Error(exportResult?.error || 'Failed to export video from browser page');
    }

    let outputFile = requestedOutputFile;
    if (
      String(exportResult.mimeType || '').startsWith('video/webm') &&
      path.extname(outputFile).toLowerCase() !== '.webm'
    ) {
      outputFile = outputFile.replace(/\.[^.]+$/, '') || outputFile;
      if (!outputFile.endsWith('.webm')) {
        outputFile = `${outputFile}.webm`;
      }
    }

    await writeChunksToFile(client, sessionId, exportKey, exportResult.chunkCount, outputFile);
    await clearStore(client, sessionId, exportKey);

    const stat = fs.statSync(outputFile);
    const result = {
      status: 'ok',
      reelUrl: reelUrl || null,
      targetId,
      outputFile,
      sizeBytes: stat.size,
      mimeType: exportResult.mimeType,
      sourceType: exportResult.sourceType,
      browserSrc: exportResult.src,
      browserVideoState: readyState
    };

    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (sessionId) {
      try {
        await client.send('Runtime.disable', {}, sessionId);
      } catch {}
      try {
        await client.send('Page.disable', {}, sessionId);
      } catch {}
      try {
        await client.send('Target.detachFromTarget', { sessionId });
      } catch {}
    }
    if (targetId && shouldCloseTarget && !args['keep-page']) {
      try {
        await client.send('Target.closeTarget', { targetId });
      } catch {}
    }
    await client.close();
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'error', error: error.message }, null, 2));
  process.exit(1);
});
