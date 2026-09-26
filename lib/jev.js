'use strict';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

// $42 per billion input tokens ($0.042 per Mtok). Output tokens are free.
// Source: https://docs.typesafe.ai/models
const PRICE_PER_INPUT_TOKEN = 42 / 1_000_000_000;

class JevError extends Error {
  constructor(message, { status, raw, code } = {}) {
    super(message);
    this.name = 'JevError';
    this.status = status;
    this.raw = raw;
    this.code = code;
  }
}

/**
 * Call Jev's System One endpoint with a state and a map of typed questions.
 * Returns { request, raw, model, tokens, cost, ms } — everything the demo
 * pages show in their "request sent / response received" panels.
 */
async function askJev({ state, questions, model = 'jev-latest' }) {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    throw new JevError(
      'TYPESAFE_API_KEY is not set on the server. Copy .env.example to .env and add your key.',
      { code: 'NO_KEY' }
    );
  }

  const body = { state, model, questions };
  const t0 = Date.now();

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (networkErr) {
    throw new JevError(`Could not reach the Jev API: ${networkErr.message}`, { code: 'NETWORK' });
  }

  const ms = Date.now() - t0;
  let raw;
  try {
    raw = await res.json();
  } catch {
    raw = null;
  }

  if (!res.ok) {
    const msg =
      (raw && (raw.error?.message || raw.message)) || `Jev API error (HTTP ${res.status})`;
    throw new JevError(msg, { status: res.status, raw });
  }

  const inputTokens = raw?.usage?.input_tokens || 0;
  const outputTokens = raw?.usage?.output_tokens || 0;
  const tokens = inputTokens + outputTokens;
  const cost = inputTokens * PRICE_PER_INPUT_TOKEN;

  return { request: body, raw, model: raw.model, tokens, cost, ms };
}

module.exports = { askJev, JevError, PRICE_PER_INPUT_TOKEN };
