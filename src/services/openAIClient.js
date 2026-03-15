const {
  OPENAI_API_KEY,
  OPENAI_BASE_URL,
  OPENAI_EMBEDDING_MODEL,
  OPENAI_CHAT_MODEL,
} = require('../config');

function hasOpenAIKey() {
  return !!OPENAI_API_KEY;
}

async function callOpenAI(path, body) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set');
  }

  const url = `${OPENAI_BASE_URL.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${text}`);
  }

  return res.json();
}

async function getEmbedding(text) {
  if (!OPENAI_API_KEY) {
    return null;
  }
  const json = await callOpenAI('embeddings', {
    model: OPENAI_EMBEDDING_MODEL,
    input: text,
  });
  const [item] = json.data || [];
  return item ? item.embedding : null;
}

async function chatCompletion(messages, opts = {}) {
  if (!OPENAI_API_KEY) {
    return null;
  }
  const json = await callOpenAI('chat/completions', {
    model: opts.model || OPENAI_CHAT_MODEL,
    messages,
    temperature: opts.temperature ?? 0.6,
    max_tokens: opts.max_tokens ?? 800,
  });
  const choice = json.choices && json.choices[0];
  return choice && choice.message && choice.message.content
    ? choice.message.content.trim()
    : null;
}

module.exports = {
  hasOpenAIKey,
  getEmbedding,
  chatCompletion,
};

