#!/usr/bin/env node
/**
 * Direct Gemini video analysis for competitor reels/videos.
 *
 * Usage:
 *   node skills/competitor-analyzer/scripts/gemini-video-analyze.js \
 *     --file /tmp/openclaw/uploads/competitor_video_123.mp4 \
 *     --source instagram \
 *     --date 2026-03-31T10:00:00Z \
 *     --caption "..." \
 *     --likes 8 \
 *     --comments 3 \
 *     --url https://www.instagram.com/reel/.../ \
 *     --model gemini-3.1-pro-preview \
 *     --output-file /tmp/openclaw/uploads/competitor_video_analysis_123.json
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_MODEL = 'gemini-3.1-pro-preview';
const API_BASE = 'https://generativelanguage.googleapis.com';
const MAX_DEFAULT_MB = 100;

function parseArgs(argv) {
  const result = { _: [] };
  let i = 0;
  while (i < argv.length) {
    const current = argv[i];
    if (current.startsWith('--')) {
      const key = current.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        result[key] = argv[i + 1];
        i += 2;
      } else {
        result[key] = true;
        i += 1;
      }
    } else {
      result._.push(current);
      i += 1;
    }
  }
  return result;
}

function requireArg(args, key, label = key) {
  if (!args[key]) {
    throw new Error(`Missing required --${label}`);
  }
  return args[key];
}

function inferMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.mp4':
      return 'video/mp4';
    case '.mov':
      return 'video/mov';
    case '.webm':
      return 'video/webm';
    case '.avi':
      return 'video/avi';
    case '.mpeg':
    case '.mpg':
      return 'video/mpeg';
    case '.wmv':
      return 'video/wmv';
    case '.flv':
      return 'video/x-flv';
    case '.3gp':
      return 'video/3gpp';
    default:
      throw new Error(`Unsupported video extension: ${ext || '(none)'}`);
  }
}

function buildPrompt(args) {
  const metadataLines = [
    `Source: ${args.source || 'instagram'}`,
    args.date ? `Post date: ${args.date}` : null,
    args.url ? `Post URL: ${args.url}` : null,
    args.caption ? `Caption: ${args.caption}` : null,
    args.likes ? `Likes: ${args.likes}` : null,
    args.comments ? `Comments: ${args.comments}` : null
  ].filter(Boolean);

  return [
    'Analyze this competitor social video directly from the uploaded video file.',
    'Return plain text in English with these sections:',
    '1. Speech transcription or spoken message',
    '2. Visual description',
    '3. Business intelligence',
    '4. Marketing angle and CTA',
    '5. Target audience',
    '6. Strengths and weaknesses',
    '7. Key intel bullets',
    '',
    'Use the video itself as the primary source. Use metadata only as supporting context.',
    '',
    'Metadata:',
    ...metadataLines
  ].join('\n');
}

async function expectJson(response, context) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${context} failed with ${response.status}: ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${context} returned non-JSON response: ${text.slice(0, 500)}`);
  }
}

async function startUpload({ apiKey, filePath, mimeType, displayName, fileSize }) {
  const response = await fetch(`${API_BASE}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(fileSize),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      file: {
        display_name: displayName || path.basename(filePath)
      }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Upload start failed with ${response.status}: ${text.slice(0, 500)}`);
  }

  const uploadUrl = response.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    throw new Error('Upload start succeeded but no x-goog-upload-url header was returned');
  }
  return uploadUrl;
}

async function finalizeUpload({ uploadUrl, fileBuffer, fileSize }) {
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(fileSize),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize'
    },
    body: fileBuffer
  });

  return expectJson(response, 'Upload finalize');
}

async function getFile({ apiKey, fileName }) {
  const response = await fetch(`${API_BASE}/v1beta/${fileName}`, {
    method: 'GET',
    headers: {
      'x-goog-api-key': apiKey
    }
  });
  return expectJson(response, 'File status');
}

async function deleteFile({ apiKey, fileName }) {
  const response = await fetch(`${API_BASE}/v1beta/${fileName}`, {
    method: 'DELETE',
    headers: {
      'x-goog-api-key': apiKey
    }
  });
  if (!response.ok && response.status !== 404) {
    const text = await response.text();
    throw new Error(`File delete failed with ${response.status}: ${text.slice(0, 500)}`);
  }
}

async function waitForActive({ apiKey, file, timeoutMs, pollIntervalMs }) {
  const deadline = Date.now() + timeoutMs;
  let current = file;

  while (true) {
    const state = current?.state;
    if (state === 'ACTIVE' || state === 'SUCCEEDED' || state === 'READY') {
      return current;
    }
    if (state === 'FAILED') {
      throw new Error(`Gemini file processing failed for ${current.name}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for Gemini to activate file ${current.name}`);
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    current = await getFile({ apiKey, fileName: current.name });
  }
}

function extractResponseText(payload) {
  const parts = payload?.candidates?.flatMap(candidate => candidate?.content?.parts || []) || [];
  return parts
    .map(part => part?.text)
    .filter(Boolean)
    .join('\n')
    .trim();
}

async function generateContent({ apiKey, model, fileUri, mimeType, prompt }) {
  const response = await fetch(`${API_BASE}/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              file_data: {
                file_uri: fileUri,
                mime_type: mimeType
              }
            },
            {
              text: prompt
            }
          ]
        }
      ]
    })
  });

  return expectJson(response, 'Generate content');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const filePath = requireArg(args, 'file');
  const model = args.model || DEFAULT_MODEL;
  const apiKey = process.env.GEMINI_API_KEY;
  const maxBytes = Number(args['max-mb'] || MAX_DEFAULT_MB) * 1024 * 1024;
  const pollIntervalMs = Number(args['poll-interval-ms'] || 3000);
  const timeoutMs = Number(args['timeout-ms'] || 180000);
  const deleteLocal = Boolean(args['delete-local']);
  const deleteRemote = args['delete-remote'] !== 'false';

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in the runtime environment');
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`Video file not found: ${filePath}`);
  }

  const stat = fs.statSync(filePath);
  if (stat.size > maxBytes) {
    throw new Error(`Video file exceeds ${args['max-mb'] || MAX_DEFAULT_MB} MB: ${filePath}`);
  }

  const mimeType = inferMimeType(filePath);
  const fileBuffer = fs.readFileSync(filePath);
  const prompt = args.prompt || buildPrompt(args);
  const displayName = args['display-name'] || path.basename(filePath);
  let uploadedFile = null;

  try {
    const uploadUrl = await startUpload({
      apiKey,
      filePath,
      mimeType,
      displayName,
      fileSize: stat.size
    });

    const uploadResult = await finalizeUpload({
      uploadUrl,
      fileBuffer,
      fileSize: stat.size
    });

    uploadedFile = uploadResult.file;
    if (!uploadedFile?.name || !uploadedFile?.uri) {
      throw new Error('Gemini upload response did not include file name and uri');
    }

    uploadedFile = await waitForActive({
      apiKey,
      file: uploadedFile,
      timeoutMs,
      pollIntervalMs
    });

    const analysisResponse = await generateContent({
      apiKey,
      model,
      fileUri: uploadedFile.uri,
      mimeType,
      prompt
    });

    const analysisText = extractResponseText(analysisResponse);
    if (!analysisText) {
      throw new Error('Gemini response did not contain text output');
    }

    const output = {
      status: 'ok',
      model,
      prompt,
      file: {
        path: filePath,
        mimeType,
        sizeBytes: stat.size
      },
      uploadedFile: {
        name: uploadedFile.name,
        uri: uploadedFile.uri,
        mimeType: uploadedFile.mimeType || mimeType,
        state: uploadedFile.state || null
      },
      analysis: {
        text: analysisText
      },
      videoAnalysisEntry: {
        source: args.source || 'instagram',
        date: args.date || null,
        summary: analysisText,
        model,
        caption: args.caption || null,
        likes: args.likes != null ? Number(args.likes) : null,
        comments: args.comments != null ? Number(args.comments) : null,
        url: args.url || null,
        analyzedAt: new Date().toISOString(),
        analysisMode: 'direct_gemini_video_upload'
      }
    };

    if (args['output-file']) {
      fs.writeFileSync(args['output-file'], JSON.stringify(output, null, 2));
    }

    console.log(JSON.stringify(output, null, 2));
  } finally {
    if (deleteRemote && uploadedFile?.name) {
      try {
        await deleteFile({ apiKey, fileName: uploadedFile.name });
      } catch (error) {
        console.error(JSON.stringify({ warning: error.message }, null, 2));
      }
    }
    if (deleteLocal && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'error', error: error.message }, null, 2));
  process.exit(1);
});
