/**
 * LLM helper — calls GPT-5.4 via the OpenAI-compatible proxy.
 *
 * Reads CELION_API_KEY from env.
 *
 * IMPORTANT: GPT-5.4 on the non-streaming /chat/completions endpoint has
 * a known proxy bug where `content: null` is returned despite tokens being
 * billed. Using `stream: true` bypasses this — the SSE chunks contain the
 * actual generated text. The /responses endpoint exhibits the same bug.
 */

const DEFAULT_BASE_URL = process.env.CELION_BASE_URL || 'http://168.119.103.207:8317/v1';
const DEFAULT_MODEL = process.env.CELION_MODEL || 'gpt-5.4';
const DEFAULT_TIMEOUT_MS = Number(process.env.CELION_TIMEOUT_MS || 180000);
const VALID_REASONING = new Set(['low', 'medium', 'high', 'xhigh']);

async function callLLM({
  system,
  user,
  model = DEFAULT_MODEL,
  maxTokens = 4000,
  reasoningEffort = 'low',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  jsonOutput = true
}) {
  const apiKey = process.env.CELION_API_KEY;
  if (!apiKey) throw new Error('CELION_API_KEY not set in environment');
  if (!VALID_REASONING.has(reasoningEffort)) {
    throw new Error(`Invalid reasoning effort "${reasoningEffort}". Use one of: low, medium, high, xhigh`);
  }

  const finalSystem = jsonOutput
    ? `${system}\n\nВАЖНО: возвращай ТОЛЬКО валидный JSON без префиксов, комментариев или кодовых блоков.`
    : system;

  const body = {
    model,
    messages: [
      { role: 'system', content: finalSystem },
      { role: 'user', content: user }
    ],
    max_completion_tokens: maxTokens,
    reasoning_effort: reasoningEffort,
    stream: true
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(`${DEFAULT_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`LLM request timed out after ${timeoutMs}ms`);
    }
    throw new Error(`LLM request failed: ${err.message}`);
  }

  if (!response.ok) {
    clearTimeout(timer);
    const errText = await response.text().catch(() => '');
    throw new Error(`LLM API ${response.status}: ${errText.slice(0, 600)}`);
  }

  // Stream the SSE body, accumulate `delta.content`
  let accumulated = '';
  let finishReason = null;
  let buffer = '';

  try {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const rawLine = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (!rawLine || !rawLine.startsWith('data:')) continue;

        const payload = rawLine.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') break;

        let chunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }

        const choice = chunk?.choices?.[0];
        const deltaContent = choice?.delta?.content;
        if (typeof deltaContent === 'string') accumulated += deltaContent;
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      }
    }
  } finally {
    clearTimeout(timer);
  }

  if (!accumulated) {
    throw new Error(`LLM returned empty content (finish_reason: ${finishReason || 'unknown'})`);
  }
  return accumulated.trim();
}

async function analyzeWithGPT(opts) {
  const text = await callLLM({ ...opts, jsonOutput: true });
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
      try { return JSON.parse(fenced[1]); } catch { /* fall through */ }
    }
    const obj = text.match(/\{[\s\S]*\}/);
    if (obj) {
      try { return JSON.parse(obj[0]); } catch { /* fall through */ }
    }
    throw new Error(`LLM returned non-JSON output: ${text.slice(0, 500)}`);
  }
}

module.exports = { analyzeWithGPT, callLLM };
