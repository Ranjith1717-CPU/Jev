# Jev demos

Four small apps showing what [TypeSafe's Jev](https://docs.typesafe.ai) (a "System One" decision model) is for — fast, typed, structured decisions, not generated text. Every page shows the exact request sent and the raw response received.

- **`/send`** — help-desk complaint triage. One call, eight parallel questions (team, action, refund, urgency, mood, churn risk, prompt-injection check, language) → a routing lane.
- **`/paste`** — smart paste. Copy a whole résumé once, paste into any form field, Jev picks the exact snippet.
- **`/flappy`** — Jev plays Flappy Bird. Every flap/wait is a live decision; the game describes itself as text.
- **`/mail`** — Jev sorts an inbox live: 1,000 real emails randomly sampled from the [Enron email corpus](https://huggingface.co/datasets/LLM-PBE/enron-email) (category, priority, spam, reply-needed) — or your own Gmail (read-only, subject-lines-only).

No page compares Jev against another model — this is purely a Jev showcase.

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` and add your key:

```
TYPESAFE_API_KEY=sk-...
```

Get a key from [console.typesafe.ai/keys](https://console.typesafe.ai/keys) (early access is currently waitlisted).

```bash
npm start
```

Open http://localhost:3000.

> **Never commit `.env`.** It's already in `.gitignore`. Don't paste your key into chat, issues, or commit messages either.

## Cost

Jev is priced per input token only (output is free): **$0.042 per 1,000 input tokens** (per the [pricing page](https://docs.typesafe.ai/models)). Everything here is cheap to run:

- `/send` and `/paste`: a few hundred tokens per click, a fraction of a cent.
- `/flappy`: makes a call roughly every 0.14s while the bird is alive (several in flight at once) — a few minutes of play is still well under a cent, but stopping the game (the **Stop** button) ends the calls immediately.
- `/mail`: the Enron inbox runs up to all 1,000 emails (≈ 1,000 Jev calls — use 10/25/100 for a quick demo); Gmail mode caps at 50 per run. Both run 8 requests concurrently.

## Connecting Gmail (optional)

The Gmail toggle on `/mail` uses OAuth with Google's `gmail.metadata` scope — a scope Google restricts to headers and labels. It **cannot** return a message body, even if the code asked for one, which is what makes "subject lines only" a real guarantee rather than just a promise in the code.

To enable it:

1. In [Google Cloud Console](https://console.cloud.google.com/), create (or pick) a project and enable the **Gmail API** (APIs & Services → Library).
2. Configure the **OAuth consent screen** (External is fine for personal testing; add yourself as a test user if it stays in "Testing" mode).
3. Under **Credentials**, create an **OAuth client ID** of type **Web application**.
   - Authorized redirect URI: `http://localhost:3000/auth/google/callback` (match the port you actually run on).
4. Copy the generated Client ID and Client Secret into `.env`:
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
   ```
5. Restart the server, open `/mail`, switch to **My Gmail**, click **Connect Gmail**.

The OAuth token is stored locally in `.gmail-token.json` (gitignored, single-user, your machine only). Click **Disconnect** on the page (or delete that file) to revoke local access; you can also revoke the app entirely from your [Google Account permissions](https://myaccount.google.com/permissions).

## Project layout

```
server.js          Express app: static pages + /api/* routes
lib/jev.js          Jev API client (fetch wrapper, cost calc)
lib/gmail.js         Gmail OAuth + metadata-only client
data/enron-inbox.json    1,000 real Enron emails for /mail
scripts/fetch-enron.js   Rebuilds data/enron-inbox.json from Hugging Face
public/              The four demo pages + landing page
```

### Dataset credit

`data/enron-inbox.json` is a random, lightly-cleaned sample of 1,000 emails from the public **Enron email corpus**, via the [`LLM-PBE/enron-email`](https://huggingface.co/datasets/LLM-PBE/enron-email) dataset on Hugging Face (~490k emails, raw text). Subjects and senders are parsed from the text where present; bodies are trimmed to 1,500 characters. The emails are unlabeled, so the demo shows what Jev decides rather than an accuracy score.

To rebuild it (a different size or sample), run `node scripts/fetch-enron.js [count] [seed]` (defaults: 1000, 42). It pulls rows through the Hugging Face datasets-server API, so no Python or full download is needed.

## Deploying

This is a single Node/Express process reading `TYPESAFE_API_KEY` (and optionally the `GOOGLE_*` vars) from the environment — it deploys as-is to Fly.io, Render, Railway, or any container host. Set the same env vars there instead of `.env`, and update `GOOGLE_REDIRECT_URI` (and the redirect URI in Google Cloud Console) to your deployed domain if you enable Gmail.
