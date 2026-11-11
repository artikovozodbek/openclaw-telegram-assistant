/**
 * Transcribe an audio file via Google Gemini API.
 *
 * Used by tg-watcher to turn Telegram voice notes into text before
 * appending them to the conversation. Returns "" on failure (caller
 * decides whether that's acceptable).
 *
 * Usage:
 *   const { transcribe } = require('./transcribe');
 *   const text = await transcribe('/tmp/voice.ogg', 'audio/ogg');
 */

const fs = require('fs');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_AUDIO_MODEL || 'gemini-2.5-flash';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const PROMPT = [
  'Transcribe this audio recording.',
  'The speaker may use Russian, Uzbek, or English (sometimes mixed in one sentence).',
  'Output ONLY the transcript text. No commentary, no language labels, no quotes, no markdown.',
  'Preserve numbers, dates, times, and proper names verbatim.',
].join(' ');

async function transcribe(filePath, mimeType = 'audio/ogg') {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set');
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`Audio file not found: ${filePath}`);
  }

  const audioBytes = fs.readFileSync(filePath);
  const audioBase64 = audioBytes.toString('base64');

  const body = {
    contents: [
      {
        parts: [
          { inlineData: { mimeType, data: audioBase64 } },
          { text: PROMPT },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 4096,
    },
  };

  const url = `${GEMINI_ENDPOINT}?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`Gemini HTTP ${resp.status}: ${detail.slice(0, 300)}`);
    }
    const json = await resp.json();
    const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join(' ').trim();
    return text || '';
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { transcribe };
