# Jev demos: project memory

Notes for future sessions: decisions, measurements and gotchas that the code alone doesn't tell you. Setup and file layout are in `README.md`.

## What this is

A small Express app (`server.js`) with demo pages in `public/` showing TypeSafe's **Jev** ("System One" model: typed choice / noul / score answers with probabilities, billed per input token only, $0.042 per Mtok). Every page shows the raw request and response.

| Page | What Jev decides |
|---|---|
| `/tools` | Which tool an agent should call (user-editable tool list) → call / confirm / ask / answer / refuse |
| `/guard` | Whether a proposed tool call runs → allow / ask / block |
| `/agent` | Next step of a support-agent loop (7 mock tools), up to 6 steps |
| `/send` | Help-desk complaint triage: 8 questions → routing lane |
| `/paste` | Which copied résumé snippet fits a form field |
| `/flappy` | Flap or wait, every ~0.14 s |
| `/dino` | Jump, duck or run, every 0.1 s (Chrome T-Rex game) |
| `/mail` | Sort 1,000 Enron emails (or your Gmail, subject lines only) |

Run: `npm start`, then open http://localhost:3000. Keys live in `.env` (gitignored): `TYPESAFE_API_KEY`, `ANTHROPIC_API_KEY`, optional `GEMINI_API_KEY`. Never commit or print them.

Since 2026-09-29 the rival is **Claude Haiku 4.5**: `GEMINI_API_KEY` is commented out in `.env`. Uncomment it to switch back to Gemini.

## Comparison lane (Jev vs another model)

- `/send`, `/paste`, `/mail`, `/tools`, `/guard` and `/agent` can race Jev against a rival model on the same questions. The rival is **Gemini 3.5 Flash-Lite** (`lib/gemini.js`) when `GEMINI_API_KEY` is set, otherwise **Claude Haiku 4.5** (`lib/claude.js`). The choice is made by `RIVAL` in `server.js`.
- Pages read the rival's name, model, endpoint and key variable from `/api/health` (`h.rival`, `h.rivalConfigured`) and fill labels via `data-rv` / `data-rv-t` attributes. Don't hardcode a model name in the pages.
- The wire flag is still `engine: 'claude'` and the page variables are still `res.claude`, `claudeReady` and so on. Here "claude" just means "the rival lane"; it was kept for backwards compatibility.
- The rival answers with hard values only (no probabilities). Its answers are mapped into Jev's `{choice | noul | score}` shape so the routes stay unchanged.
- `/flappy` and `/dino` stay Jev-only (they need a decision every 0.1–0.14 s).

### Measured results (2026-09-27, Jev `jev-1.13.0` vs `gemini-3.5-flash-lite`)

| Workload | Jev s/call | Gemini s/call | Jev cost | Gemini cost | Agreement |
|---|---|---|---|---|---|
| `/mail`, 100 emails | 0.67 | 1.28 | $0.0032 | $0.0224 (7×) | 97/99 category/spam; priority 83, reply 80 |
| `/send`, 8 sample complaints | 0.46 | 1.29 | $0.00026 | $0.0024 (9×) | 53/64 answers match; same lane 6/8 |

- The `/mail` summary reports **time to finish** (the lane clocks, which include rate-limit waits) separately from **response time per call** (successful attempts only). Keep both, or the summary contradicts the lane cards: on the free Gemini key a 25-email race is Jev 8 s vs Gemini about 1 min 10 s, yet per-call time is only about 1.1× apart.
- Jev is 7–9× cheaper everywhere and 2–3× faster on short inputs, but was **slower than Gemini on long inputs** (the since-removed `/coach` write-ups). Summary text must handle both directions ("faster" or "slower", "cheaper" or "pricier"); don't assume Jev wins.
- Earlier baseline: Claude Haiku 4.5 was about 25–30× Jev's cost per email.

### Gemini key limits

- The current key is on the **free tier**: no charges, but **15 requests per minute per model** (quota `GenerateRequestsPerMinutePerProjectPerModel-FreeTier`), plus a daily cap. The daily cap resets at midnight Pacific time; check it at https://aistudio.google.com/rate-limit.
- At 15 RPM a 100-email `/mail` race takes about 6–7 minutes for Gemini (about 14 s for Jev). `lib/gemini.js` retries 429s using Google's `retryDelay` (capped at 20 s, up to 4 retries).
- Enabling billing costs about $0.0002 per email ($0.30 in / $2.50 out per Mtok; no thinking tokens observed).
- The key was pasted into a chat once. Swap in a fresh key from AI Studio.

## Agent demos (`/tools`, `/guard`, `/agent`), added 2026-10-06

- Jev only picks; it never writes text. Tool arguments are not generated: `/tools` shows the tool name only, `/agent` parses the order ID from the message with a regex, and its final reply is a template filled from what the mock tools returned (`agentReply` in `server.js`).
- `/agent` mock data is `AGENT_ORDERS` in `server.js`. A1077's rider note is a planted prompt injection; the `suspicious` question blocks `issue_refund` when it fires. `issue_refund` itself also rejects calls made before `lookup_order` and `check_refund_policy`, or outside the policy.
- `/tools` drops to "ask" when Jev's top tool is under 50% likely; the rival has no probabilities, so it never triggers that rule.
- Built and checked against a stubbed Jev endpoint only (`.env` had no keys on 2026-10-06). The prompt wording has not been tuned against the real model yet, unlike `/dino`.

## `/dino` design notes

- A Jev round trip takes about 0.5–0.7 s, so each question describes where things will be **when the answer lands** (projected with the measured latency), and up to 10 questions are in flight at once, asked every 100 ms. Same approach as `/flappy`.
- The physics were tuned by simulation: gravity 0.38, jump 10, speed 3.5 → 5.5 px/frame. Obstacle spacing is `300 + speed*40 + rand*300` px, so the dino has landed before the next jump window. Birds appear after 8 obstacles (low = jump, head height = duck, high = ignore).
- The distance bins use projected time to contact in frames: over 60 is "far ahead", 20–60 is "coming up, still some way off", 1–20 is "about to reach the dino", and anything closer is "right at the dino".
- The wording matters. With plain "coming up", Jev jumped too early. The "still some way off" wording, plus a jump criterion saying that jumping while the obstacle is still coming up lands too early, fixed it. Wrong answers while the dino is airborne are ignored by the game.
- Verified: in a headless browser run, Jev played 60 s without crashing (21 obstacles, birds included).

## Testing tips

- Headless checks: `puppeteer-core` with the local Chrome (`C:/Program Files/Google/Chrome/Application/chrome.exe`). Install it in a scratch folder, not in this repo.
- On Windows, stop a stray server with PowerShell (`pkill` doesn't exist in Git Bash): `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? { $_.CommandLine -like '*server.js*' } | % { Stop-Process -Id $_.ProcessId -Force }`.
- When bulk-testing the Jev API, keep concurrency at about 4. Firing 72 calls at once got rate-limited.

## Workflow

- Repo: https://github.com/Ranjith1717-CPU/Jev (`origin`). Work is committed straight to `main`.
