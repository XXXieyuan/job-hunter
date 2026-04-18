const {
  OPENAI_API_KEY,
  OPENAI_BASE_URL,
  OPENAI_EMBEDDING_MODEL,
  OPENAI_CHAT_MODEL,
} = require('../config');
const { getLogger } = require('../logger');

const logger = getLogger('openAIClient');

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;

function hasOpenAIKey() {
  return !!OPENAI_API_KEY;
}

function stripThinkTags(content) {
  if (typeof content !== 'string') {
    return content;
  }
  const stripped = content.replace(/<think>[\s\S]*?<\/think>/g, '');
  return stripped.trim();
}

/**
 * Sleep helper for retry backoff.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Core HTTP call to OpenAI-compatible API with 429 retry + exponential backoff.
 * Retries up to MAX_RETRIES times on 429 status with delays of 2s, 4s, 8s.
 */
async function callOpenAI(path, body) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set');
  }

  const url = `${OPENAI_BASE_URL.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    // Retry on transient errors: 429 (rate limited) and 5xx (upstream /
    // Cloudflare issues — seen frequently on n1n.ai with reasoning=xhigh
    // under load). Non-retriable 4xx (400, 401, 403) fall through to throw.
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      const delayMs = BASE_DELAY_MS * Math.pow(2, attempt); // 2s, 4s, 8s
      const reason = res.status === 429 ? 'rate limited' : `upstream ${res.status}`;
      logger.warn(`${reason}. Retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(delayMs);
      continue;
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI error ${res.status}: ${text.slice(0, 500)}`);
    }

    return res.json();
  }
}

/**
 * Generate an embedding vector for the given text.
 * Returns a raw float array suitable for storage in DB as BLOB.
 * Uses the configured embedding model (default: text-embedding-3-small).
 *
 * @param {string} text - Input text to embed
 * @returns {number[]|null} - Float array of embedding values, or null if no API key
 */
async function generateEmbedding(text) {
  if (!OPENAI_API_KEY) {
    return null;
  }
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return null;
  }

  // Truncate to ~8000 tokens (~32000 chars as rough estimate)
  const truncated = text.length > 32000 ? text.slice(0, 32000) : text;

  const json = await callOpenAI('embeddings', {
    model: OPENAI_EMBEDDING_MODEL,
    input: truncated,
  });
  const [item] = json.data || [];
  return item ? item.embedding : null;
}

/**
 * Legacy alias for generateEmbedding (backward compatibility).
 */
async function getEmbedding(text) {
  return generateEmbedding(text);
}

async function chatCompletion(messages, opts = {}) {
  if (!OPENAI_API_KEY) {
    return null;
  }

  // Reasoning control — routes to /v1/responses (the only endpoint on the
  // n1n.ai gateway that accepts a reasoning parameter). Default to xhigh
  // for every caller unless they explicitly pass a different effort; we'll
  // tune individual callers down after observing token usage in practice.
  // Values: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'. Pass
  // `reasoning_effort: null` to force the legacy /chat/completions path.
  const effort = opts.reasoning_effort === null
    ? null
    : (opts.reasoning_effort || 'xhigh');

  if (effort) {
    const payload = {
      model: opts.model || OPENAI_CHAT_MODEL,
      input: messages,
      reasoning: { effort },
    };
    if (opts.max_tokens) payload.max_output_tokens = opts.max_tokens;
    if (opts.temperature !== undefined) payload.temperature = opts.temperature;
    const json = await callOpenAI('responses', payload);
    // /responses shape:
    //   output: [{type: 'reasoning', ...}, {type: 'message', content: [{type: 'output_text', text}]}]
    const out = Array.isArray(json.output) ? json.output : [];
    const msg = out.find((x) => x && x.type === 'message');
    if (!msg || !Array.isArray(msg.content)) return null;
    const textPart = msg.content.find((c) => c && (c.type === 'output_text' || c.type === 'text'));
    if (!textPart || typeof textPart.text !== 'string') return null;
    // Log reasoning_tokens so the user can tune effort per-caller.
    try {
      const u = json.usage || {};
      const rt = (u.output_tokens_details || {}).reasoning_tokens;
      logger.info('chatCompletion /responses', {
        effort,
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        reasoning_tokens: rt,
        total_tokens: u.total_tokens,
      });
    } catch { /* best-effort logging */ }
    return stripThinkTags(textPart.text.trim());
  }

  const payload = {
    model: opts.model || OPENAI_CHAT_MODEL,
    messages,
    temperature: opts.temperature ?? 0.6,
    max_tokens: opts.max_tokens ?? 4096,
  };
  const json = await callOpenAI('chat/completions', payload);
  const choice = json.choices && json.choices[0];
  if (!choice || !choice.message || !choice.message.content) {
    return null;
  }
  const content = choice.message.content.trim();
  return stripThinkTags(content);
}

module.exports = {
  hasOpenAIKey,
  generateEmbedding,
  getEmbedding,
  chatCompletion,
};
