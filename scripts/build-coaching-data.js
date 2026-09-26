'use strict';

// Builds data/private/coaching-sessions.json from a BIG Intelligence export
// (the zip of engagement zips, or a folder already extracted from it).
// The output is anonymised and git-ignored: it never leaves this machine.
//
//   node scripts/build-coaching-data.js <export.zip | extracted-folder>
//
// Each session becomes a plain-text write-up (what a coach would read) plus
// the "truth" computed from BIG Intelligence's own per-person scorecards, so
// the /coach page can check Jev's calls against it. Scores and health bands
// are never put into the text Jev sees.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const input = process.argv[2];
if (!input) {
  console.error('Usage: node scripts/build-coaching-data.js <export.zip | extracted-folder>');
  process.exit(1);
}
const OUT = path.join(__dirname, '..', 'data', 'private', 'coaching-sessions.json');

function unzip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  // Windows ships bsdtar, which reads zip files; elsewhere use unzip.
  if (process.platform === 'win32') execFileSync('C:\\Windows\\System32\\tar.exe', ['-xf', zip, '-C', dest]);
  else execFileSync('unzip', ['-q', '-o', zip, '-d', dest]);
}

function findCoreFiles(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) findCoreFiles(full, out);
    else if (name.endsWith('.zip')) {
      const dest = full.slice(0, -4) + '__x';
      if (!fs.existsSync(dest)) unzip(full, dest);
      findCoreFiles(dest, out);
    } else if (name.endsWith('coach-dump.core.json')) out.push(full);
  }
  return out;
}

let root = path.resolve(input);
if (root.endsWith('.zip')) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coaching-'));
  unzip(root, tmp);
  root = tmp;
}
const files = [...new Set(findCoreFiles(root))];
if (!files.length) {
  console.error('No *coach-dump.core.json files found under', root);
  process.exit(1);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const clip = (s, n) => (s && s.length > n ? s.slice(0, n).trimEnd() + '…' : s || '');

// Folder names read "BIG Intelligence - <Coach Full Name> - <Company>", which
// is the only place the coach's surname lives.
const coachNames = files.map((f) => (f.match(/BIG Intelligence - ([^-\\/]+?) - /) || [])[1]).filter(Boolean);

// People from every engagement, so a name from one account mentioned in
// another's notes is still caught.
const allPeople = files.flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8')).people.map((p) => p.name || ''));

// Common first names, matched case-sensitively (so "mark" the verb survives),
// to catch outside contacts who are not on any people list.
const FIRST_NAMES = 'Aaron Adam Alan Alex Alice Amanda Amy Andrew Angela Anna Anthony Ashley Barbara Ben Benjamin Beth Bill Bob Brad Brandon Brian Bruce Carl Carol Chad Charles Chris Christine Christopher Craig Dan Daniel Dave David Dennis Derek Diana Donna Doug Ed Edward Emily Eric Erin Frank Gary Grace Greg Gregory Heather Jack Jacob James Jamie Jane Jason Jeff Jen Jennifer Jeremy Jessica Jim Joe John Jon Jordan Joseph Josh Julie Justin Karen Kate Kathy Keith Kelly Ken Kevin Kim Kyle Laura Lisa Mark Mary Matt Matthew Megan Melissa Michael Michelle Mike Nancy Nick Nicole Pam Patrick Paul Peter Rachel Rebecca Richard Rick Rob Robert Ron Ryan Sam Sandra Sara Sarah Scott Sean Sharon Stephanie Stephen Steve Steven Susan Tim Timothy Todd Tom Tony Tracy Travis Tyler Victoria Will William'.split(' ');
const FIRST_RE = new RegExp(`\\b(${FIRST_NAMES.join('|')})(\\s+[A-Z][a-zA-Z'-]+)?\\b`, 'g');

const engagements = files
  .map((f) => JSON.parse(fs.readFileSync(f, 'utf8')))
  // Only engagements with per-person scorecards can be checked against truth.
  .filter((j) => j.sessions.some((s) => (s.people_read || []).some((p) => p.reads)))
  .sort((a, b) => a.sessions.length - b.sessions.length);

const sessions = [];
engagements.forEach((j, ei) => {
  const client = 'Client ' + String.fromCharCode(65 + ei);

  // Role labels for people ("VP", "VP 2"), then a replacer for every name form.
  const count = {}, label = {};
  for (const p of j.people) {
    const role = p.client_title || p.role_bucket || 'Team member';
    count[role] = (count[role] || 0) + 1;
    label[p.id] = count[role] > 1 ? `${role} ${count[role]}` : role;
  }
  const swaps = [];
  for (const p of j.people) {
    const parts = (p.name || '').split(/\s+/).filter((w) => w.length > 2);
    if (p.name) swaps.push([p.name, `the ${label[p.id]}`]);
    for (const w of parts) swaps.push([w, `the ${label[p.id]}`]);
  }
  swaps.push([j.account.name, 'the company']);
  for (const w of j.account.name.split(/\s+/).filter((w) => w.length > 3 && !/^(group|investment|the|and)$/i.test(w))) swaps.push([w, 'the company']);
  if (j.meta.coach) swaps.push([j.meta.coach, 'the coach']);
  for (const c of coachNames) for (const w of [c, ...c.split(/\s+/)].filter((w) => w.length > 2)) swaps.push([w, 'the coach']);
  const own = new Set(swaps.map(([from]) => from.toLowerCase()));
  for (const n of allPeople) {
    for (const w of [n.replace(/\s*-.*$/, ''), ...n.split(/[\s,]+/)].filter((w) => w.length > 2 && !/^(jr|sr|the)\.?$/i.test(w))) {
      if (!own.has(w.toLowerCase())) swaps.push([w, 'a contact']);
    }
  }
  swaps.sort((a, b) => b[0].length - a[0].length); // full names before first names
  const anon = (s) => swaps
    .reduce((t, [from, to]) => t.replace(new RegExp(`\\b${esc(from)}('s)?\\b`, 'gi'), (m, poss) => to + (poss || '')), String(s || ''))
    .replace(FIRST_RE, 'a contact')
    .replace(/\b(Coach )?the coach( the coach)*\b/gi, 'the coach')
    .replace(/\bthe the\b/gi, 'the');

  const lastRead = {}; // person id -> previous reads, for the erosion truth
  for (const s of j.sessions) {
    const asks = [...(s.critical_path_actions || []), ...(s.next_steps || [])].map((a) => (typeof a === 'string' ? a : a.action || a.title || a.text || ''));
    const people = s.people_read || [];

    const lines = [];
    lines.push(`Session ${s.n} (${s.date}). Mood as logged: ${s.mood || 'not logged'}.`);
    if (s.executive_summary) lines.push(`Summary: ${clip(anon(s.executive_summary), 900)}`);
    if (s.key_issue) lines.push(`Key issue: ${clip(anon(s.key_issue), 250)}`);
    const risks = (s.risks || []).map((r) => r.title).filter(Boolean);
    if (risks.length) lines.push(`Risks raised: ${anon(risks.join('; '))}`);
    if (asks.length) lines.push(`Commitments set this session (${asks.length}):\n${asks.map((a) => '- ' + clip(anon(a), 110)).join('\n')}`);
    const notes = [];
    for (const p of people) {
      const who = `${label[p.person_id] || 'Team member'}${p.decision_maker ? ' (decision-maker)' : ''}`;
      const moved = (p.what_moved || []).map((m) => `${m.read} ${m.direction}: ${clip(anon(m.summary), 200)}`);
      if (moved.length) notes.push(`${who}: ${moved.join(' ')}`);
    }
    if (notes.length) lines.push(`Coach's notes on people:\n${notes.map((n) => '- ' + n).join('\n')}`);

    // Truth from the scorecards (null when the session can't answer it).
    const withReads = people.filter((p) => p.reads);
    const dm = withReads.filter((p) => p.decision_maker);
    let erosion = null;
    for (const p of withReads) {
      const prev = lastRead[p.person_id];
      if (!prev) continue;
      const drop = ['ROI perception', 'chemistry'].some((k) => typeof prev[k] === 'number' && typeof p.reads[k] === 'number' && prev[k] - p.reads[k] >= 1);
      erosion = erosion || drop;
    }
    for (const p of withReads) lastRead[p.person_id] = p.reads;

    if (!withReads.length) continue;
    sessions.push({
      id: `${client}-${s.n}`,
      client,
      n: s.n,
      date: s.date,
      title: clip(anon(s.key_issue || s.title || `Session ${s.n}`), 110),
      mood: s.mood || null,
      text: lines.join('\n\n').slice(0, 3200),
      truth: {
        erosion: erosion === null ? null : !!erosion,
        capacity: dm.length ? dm.some((p) => typeof p.reads['implementation capacity'] === 'number' && p.reads['implementation capacity'] < 6) : null,
        overload: asks.length ? asks.length > 3 : null,
        drift: withReads.some((p) => p.band && p.band !== 'healthy'),
      },
    });
  }
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(sessions, null, 1) + '\n');
const rate = (k) => {
  const v = sessions.map((s) => s.truth[k]).filter((x) => x !== null);
  return `${k} ${v.filter(Boolean).length}/${v.length}`;
};
console.log(`Wrote ${sessions.length} sessions from ${engagements.length} engagements to ${path.relative(process.cwd(), OUT)}`);
console.log('Truth base rates:', ['erosion', 'capacity', 'overload', 'drift'].map(rate).join(' · '));
