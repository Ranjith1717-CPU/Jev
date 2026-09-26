'use strict';

const Anthropic = require('@anthropic-ai/sdk').default;
const { JevError } = require('./jev');

// Comparison baseline: Claude Haiku 4.5, Anthropic's cheapest current model.
// $1 per Mtok input, $5 per Mtok output.
const MODEL = 'claude-haiku-4-5';
const PRICE_IN = 1 / 1_000_000;
const PRICE_OUT = 5 / 1_000_000;

let client;

/**
 * Ask Claude the same typed questions Jev gets ({ choice | noul | score }) and
 * return the same shape as askJev, with answers mapped into Jev's format so
 * every route can use either engine unchanged:
 *   choice -> { choice }, noul -> { noul: 0 | 1 }, score -> { score: index }
 * Claude gives one hard answer per question, so there are no probabilities.
 */
async function askClaude({ state, questions }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new JevError('ANTHROPIC_API_KEY is not set on the server. Add it to .env to compare against Claude.', {
      code: 'NO_KEY',
    });
  }
  client ||= new Anthropic({ maxRetries: 4 });

  const properties = {};
  const lines = [];
  for (const [key, q] of Object.entries(questions)) {
    if (q.type === 'choice') {
      properties[key] = { type: 'string', enum: Object.keys(q.criteria) };
      lines.push(`- ${key}: ${q.instructions}\n  Options:\n` +
        Object.entries(q.criteria).map(([k, v]) => `    ${k}: ${v}`).join('\n'));
    } else if (q.type === 'score') {
      properties[key] = { type: 'integer', enum: q.criteria.map((_, i) => i) };
      lines.push(`- ${key}: ${q.instructions}\n  Scale:\n` +
        q.criteria.map((v, i) => `    ${i}: ${v}`).join('\n'));
    } else {
      properties[key] = { type: 'boolean' };
      lines.push(`- ${key}: ${q.instructions} (true = yes, false = no)`);
    }
  }
  const schema = { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };

  const request = {
    model: MODEL,
    max_tokens: 512,
    system: 'You classify the input below by answering every question. Answer each one using only the allowed values.',
    messages: [{ role: 'user', content: `Input:\n${state}\n\nQuestions:\n${lines.join('\n')}` }],
    output_config: { format: { type: 'json_schema', schema } },
  };

  const t0 = Date.now();
  let msg;
  try {
    msg = await client.messages.create(request);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new JevError('Claude rejected ANTHROPIC_API_KEY (HTTP 401).', { status: 401 });
    } else if (err instanceof Anthropic.RateLimitError) {
      throw new JevError('Claude rate limit hit (HTTP 429). Try a smaller run.', { status: 429 });
    } else if (err instanceof Anthropic.APIError) {
      throw new JevError(`Claude API error${err.status ? ` (HTTP ${err.status})` : ''}: ${err.message}`, { status: err.status });
    }
    throw new JevError(`Could not reach the Claude API: ${err.message}`, { code: 'NETWORK' });
  }
  const ms = Date.now() - t0;

  if (msg.stop_reason === 'refusal') throw new JevError('Claude declined to answer this one.', { status: 422 });
  const text = msg.content.find((b) => b.type === 'text')?.text || '';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new JevError('Claude returned an unreadable answer.', { status: 502 });
  }

  const answers = {};
  for (const [key, q] of Object.entries(questions)) {
    const v = parsed[key];
    if (q.type === 'choice') answers[key] = { type: 'choice', choice: v };
    else if (q.type === 'score') answers[key] = { type: 'score', score: Number(v) || 0 };
    else answers[key] = { type: 'noul', noul: v ? 1 : 0 };
  }

  const { input_tokens: inTok = 0, output_tokens: outTok = 0 } = msg.usage || {};
  return {
    request,
    raw: { model: msg.model, answers, usage: msg.usage, output: parsed },
    model: msg.model,
    tokens: inTok + outTok,
    cost: inTok * PRICE_IN + outTok * PRICE_OUT,
    ms,
  };
}

module.exports = { askClaude, CLAUDE_MODEL: MODEL };
