#!/usr/bin/env node
/**
 * TTS Send — Generate ElevenLabs audio and save to file
 * Usage: node tts-send.js "text to speak" /path/to/output.mp3
 */
const https = require('https');
const fs = require('fs');

const text = process.argv[2];
const outPath = process.argv[3] || '/tmp/openclaw/uploads/tts_output.mp3';
const apiKey = process.env.ELEVENLABS_API_KEY;
const voiceId = process.env.ELEVENLABS_VOICE_ID || '6r3jSnrDWN6mYQeBHOOU';
const modelId = process.env.ELEVENLABS_MODEL_ID || 'eleven_v3';

if (!text) { console.error('Usage: node tts-send.js "text" [output.mp3]'); process.exit(1); }
if (!apiKey) { console.error('ELEVENLABS_API_KEY not set'); process.exit(1); }

const body = JSON.stringify({
  text,
  model_id: modelId,
  voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.0 }
});

const dir = require('path').dirname(outPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const req = https.request({
  hostname: 'api.elevenlabs.io',
  path: `/v1/text-to-speech/${voiceId}`,
  method: 'POST',
  headers: {
    'xi-api-key': apiKey,
    'Content-Type': 'application/json',
    'Accept': 'audio/mpeg'
  }
}, (res) => {
  if (res.statusCode !== 200) {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => { console.error(`ElevenLabs error ${res.statusCode}: ${data}`); process.exit(1); });
    return;
  }
  const file = fs.createWriteStream(outPath);
  res.pipe(file);
  file.on('finish', () => {
    file.close();
    console.log(JSON.stringify({ ok: true, path: outPath, size: fs.statSync(outPath).size }));
  });
});

req.on('error', (e) => { console.error(`Request error: ${e.message}`); process.exit(1); });
req.write(body);
req.end();
