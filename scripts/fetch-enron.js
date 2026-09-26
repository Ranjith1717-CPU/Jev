'use strict';

// Builds data/enron-inbox.json: a random, cleaned sample of real Enron emails
// from the LLM-PBE/enron-email dataset on Hugging Face (~490k rows, one `text`
// column). Uses the public datasets-server rows API, so there is no need to
// install Python `datasets` or download the full ~490 MB parquet.
//
//   node scripts/fetch-enron.js [count=1000] [seed=42]

const fs = require('fs');
const path = require('path');

const DATASET = 'LLM-PBE/enron-email';
const API = 'https://datasets-server.huggingface.co';
const COUNT = Number(process.argv[2]) || 1000;
const SEED = Number(process.argv[3]) || 42;
const CHUNK = 20; // rows per request; small chunks spread picks across mailboxes
const MAX_BODY = 1500; // chars sent to Jev per email
const OUT = path.join(__dirname, '..', 'data', 'enron-inbox.json');

// Deterministic PRNG (mulberry32) so the same seed rebuilds the same inbox.
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Retries with exponential backoff; the public API rate-limits (HTTP 429).
async function getJson(url, tries = 8) {
  for (let i = 1; ; i++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (i >= tries) throw new Error(`HTTP ${res.status} for ${url}`);
    await new Promise((r) => setTimeout(r, Math.min(30000, 2000 * 2 ** (i - 1))));
  }
}

function clean(text) {
  return text
    .replace(/\r/g, '')
    .replace(/\?(?=\s|$)/gm, ' ') // stray '?' the corpus uses for non-breaking spaces
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function toEmail(text) {
  const body = clean(text);
  if (body.length < 120 || body.length > 6000 || !/[a-z]{3}/i.test(body)) return null;

  const subj = body.match(/^\s*Subject:[ \t]*(.+)$/im);
  const firstLine = body.split('\n').map((l) => l.trim()).find((l) => l && !/^-{3,}|^Forwarded by/i.test(l));
  const subject = (subj ? subj[1] : firstLine || '(no subject)').trim().slice(0, 120);
  const from = (body.match(/^\s*From:[ \t]*(.+)$/im) || [])[1];

  return {
    subject,
    // Lotus Notes headers look like "Kevin M Presto @ ECT      09/06/2000 07:28 AM"
    ...(from ? { from: from.split(/\s{2,}|\s+\d{1,2}\/\d{1,2}\/\d{2,4}|\s+on\s*$/)[0].trim().slice(0, 80) } : {}),
    body: body.length > MAX_BODY ? body.slice(0, MAX_BODY) + '…' : body,
  };
}

async function main() {
  const { size } = await getJson(`${API}/size?dataset=${encodeURIComponent(DATASET)}`);
  const total = size.dataset.num_rows;
  const rand = rng(SEED);
  const seen = new Set();
  const out = [];

  console.log(`${DATASET}: ${total.toLocaleString()} rows; sampling ${COUNT}…`);
  while (out.length < COUNT) {
    const offsets = Array.from({ length: 4 }, () => Math.floor(rand() * (total - CHUNK)));
    const pages = await Promise.all(offsets.map((o) =>
      getJson(`${API}/rows?dataset=${encodeURIComponent(DATASET)}&config=default&split=train&offset=${o}&length=${CHUNK}`)));
    for (const page of pages) {
      for (const { row } of page.rows) {
        const email = toEmail(row.text || '');
        const key = email && email.body.slice(0, 300);
        if (!email || seen.has(key)) continue;
        seen.add(key);
        out.push(email);
        if (out.length >= COUNT) break;
      }
      if (out.length >= COUNT) break;
    }
    process.stdout.write(`\r  ${out.length} / ${COUNT}`);
  }

  const inbox = out.map((e, i) => ({ id: i + 1, ...e }));
  fs.writeFileSync(OUT, JSON.stringify(inbox, null, 2) + '\n');
  console.log(`\nWrote ${inbox.length} emails to ${path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
