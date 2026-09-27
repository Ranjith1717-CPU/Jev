'use strict';

const { JevError } = require('./jev');

// Comparison baseline: Gemini 3.5 Flash-Lite, Google's cheapest current model.
// $0.30 per Mtok input, $2.50 per Mtok output (thinking tokens bill as output).
// Source: https://ai.google.dev/gemini-api/docs/pricing
const MODEL = 'gemini-3.5-flash-lite';
const PRICE_IN = 0.3 / 1_000_000;
const PRICE_OUT = 2.5 / 1_000_000;
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

/**
 * Ask Gemini the same typed questions Jev gets ({ choice | noul | score }) and
 * return the same shape as askJev, with answers mapped into Jev's format so
 * every route can use either engine unchanged:
 *   choice -> { choice }, noul -> { noul: 0 | 1 }, score -> { score: index }
 * Gemini gives one hard answer per question, so there are no probabilities.
 */
async function askGemini({ state, questions }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new JevError('GEMINI_API_KEY is not set on the server. Add it to .env to compare against Gemini.', {
      code: 'NO_KEY',
    });
  }

  const properties = {};
  const lines = [];
  for (const [key, q] of Object.entries(questions)) {
    if (q.type === 'choice') {
      properties[key] = { type: 'STRING', enum: Object.keys(q.criteria) };
      lines.push(`- ${key}: ${q.instructions}\n  Options:\n` +
        Object.entries(q.criteria).map(([k, v]) => `    ${k}: ${v}`).join('\n'));
    } else if (q.type === 'score') {
      // Gemini's schema enums are string-only, so the scale index goes as "0", "1", ...
      properties[key] = { type: 'STRING', enum: q.criteria.map((_, i) => String(i)) };
      lines.push(`- ${key}: ${q.instructions}\n  Scale:\n` +
        q.criteria.map((v, i) => `    ${i}: ${v}`).join('\n'));
    } else {
      properties[key] = { type: 'BOOLEAN' };
      lines.push(`- ${key}: ${q.instructions} (true = yes, false = no)`);
    }
  }
  const schema = { type: 'OBJECT', properties, required: Object.keys(properties), propertyOrdering: Object.keys(properties) };

  const request = {
    systemInstruction: {
      parts: [{ text: 'You classify the input below by answering every question. Answer each one using only the allowed values.' }],
    },
    contents: [{ role: 'user', parts: [{ text: `Input:\n${state}\n\nQuestions:\n${lines.join('\n')}` }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: schema, maxOutputTokens: 512 },
  };

  // Retry dropped connections, rate limits and 5xx up to four times. On a 429,
  // wait as long as Google's RetryInfo asks (capped at 20 s), otherwise back
  // off exponentially; `ms` times only the attempt that succeeded.
  let res, body, t0;
  for (let attempt = 0; ; attempt++) {
    t0 = Date.now();
    let wait = 500 * 2 ** attempt;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      body = await res.json().catch(() => null);
      if (!(res.status === 429 || res.status >= 500) || attempt >= 4) break;
      const delay = body?.error?.details?.find((d) => d.retryDelay)?.retryDelay; // e.g. "7s"
      if (delay) wait = Math.min(20000, parseFloat(delay) * 1000 + 250);
    } catch (networkErr) {
      if (attempt >= 4) throw new JevError(`Could not reach the Gemini API: ${networkErr.message}`, { code: 'NETWORK' });
    }
    await new Promise((r) => setTimeout(r, wait));
  }
  const ms = Date.now() - t0;

  if (!res.ok) {
    const detail = body?.error?.message || `HTTP ${res.status}`;
    throw new JevError(`Gemini API error (HTTP ${res.status}): ${detail}`, { status: res.status });
  }

  const cand = body?.candidates?.[0];
  if (!cand?.content) {
    const why = body?.promptFeedback?.blockReason || cand?.finishReason || 'no answer';
    throw new JevError(`Gemini declined to answer this one (${why}).`, { status: 422 });
  }
  const text = cand.content.parts.filter((p) => !p.thought).map((p) => p.text || '').join('');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new JevError('Gemini returned an unreadable answer.', { status: 502 });
  }

  const answers = {};
  for (const [key, q] of Object.entries(questions)) {
    const v = parsed[key];
    if (q.type === 'choice') answers[key] = { type: 'choice', choice: v };
    else if (q.type === 'score') answers[key] = { type: 'score', score: Number(v) || 0 };
    else answers[key] = { type: 'noul', noul: v ? 1 : 0 };
  }

  const u = body.usageMetadata || {};
  const inTok = u.promptTokenCount || 0;
  const outTok = (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0);
  const model = body.modelVersion || MODEL;
  return {
    request: { model: MODEL, ...request },
    raw: { model, answers, usage: u, output: parsed },
    model,
    tokens: inTok + outTok,
    cost: inTok * PRICE_IN + outTok * PRICE_OUT,
    ms,
  };
}

module.exports = { askGemini, GEMINI_MODEL: MODEL };
