# Fasto Innova

An AI marketplace prototype that helps small farmers around **Cassino** (Lazio, Italy) sell directly to nearby buyers — restaurants, hotels, shops and local channels — without forms or spreadsheets. Built for an R&S Management internship project.

Visual design is a direct implementation of the Figma file *DOLCE MERAVGLIA* (Dashboard / Clients / Fasto-AI frames): dark red glass panels over a full-bleed farm photo, Roboto type.

## The three brains

1. **Brain 1 — Interviewer.** A conversational AI that chats with the farmer in plain language (Italian or English) and gathers what they grow, how much, when, and where.
2. **Brain 2 — Matchmaker.** A deterministic scoring engine that ranks the farmer against a curated database of 36 real Cassino-area buyers + 3 sales channels, then an AI writer drafts the pitch and one outreach message.
3. **Brain 3 — Guardian.** Validates and sanity-checks everything moving between Brain 1 and Brain 2: blocks prompt-injection attempts, flags personal data, rejects buyers the AI didn't actually retrieve, and catches false claims (e.g. "organic" when the farmer isn't certified). It runs on every message — there's no dedicated log screen in this design, but every check is logged to the browser console (`F12` → Console) if you want to see it live.

## Screens

- **Dashboard** — Research Progress table: your last conversations, targeted product, quantity pledged, an assumed price per kg (click it to adjust), and how far each one has progressed.
- **Clients** — every buyer Brain 2 has matched you with, and the real outreach message Brain 2 drafted for them (Italian + English). Nothing here is simulated — a message only appears once a real match has been found. "Mark as sent" and "Copy" are manual, on purpose: this prototype never sends anything on its own.
- **Fasto-AI** — the interview itself, with a history rail on the right so you can start fresh chats or revisit old ones.
- **Admin** (R&S account only) — every farmer, every conversation and every outreach draft across the whole app, for internship reporting.

## Running it

No install, no build step — it's plain HTML/CSS/JS.

1. Download/open this folder.
2. Double-click `index.html` (or host it, see below).
3. **Sign in or sign up** with an email + password — this is what saves your chats, matches and outreach drafts between visits. Accounts are handled by Supabase; farmers each see only their own data.
4. On the next screen, choose:
   - **Offline demo** — works instantly, no key needed. Runs a scripted example conversation (a tomato & zucchine farmer near Sant'Elia Fiumerapido) end-to-end.
   - **Live AI** — paste your own Anthropic API key (get one at [console.anthropic.com](https://console.anthropic.com)). A full run costs a few cents. The key is only ever stored in your own browser (`localStorage`, optional) — it is never written to a file and never leaves your machine except to call Anthropic's API directly.

   Either way, once you're signed in, everything you do is saved to your account automatically — no separate "save" step.

## Your account & data

Farmer accounts, chats, messages, matches and outreach drafts are stored in a Supabase project (Postgres + built-in auth), locked down with Row Level Security so each farmer can only ever see their own rows. Buyers don't get accounts — the buyer database stays a curated, read-only dataset fetched live from the same project. The `SUPABASE_URL`/publishable key visible in `js/supabase-client.js` are meant to be public (that's how Supabase's security model works — the database itself is the lock, not the key), so it's safe that they're committed to this repo, same as the rest of the code.

There's also a private **Admin** view (visible only on the R&S account) showing every farmer's activity across the whole app — it stays hidden for everyone else.

## Hosting it for free (so anyone with the link can open it — e.g. on a phone)

**GitHub Pages, no terminal needed:**

1. Go to [github.com](https://github.com) → sign in (or create a free account) → **New repository**. Name it e.g. `fasto-innova`, keep it **Public**, don't add a README (you already have one).
2. On the new repo's page, click **uploading an existing file**.
3. Drag in every file and folder from this project (`index.html`, `manifest.json`, `css/`, `js/`, `assets/`, this `README.md`) and click **Commit changes**.
4. Go to the repo's **Settings → Pages**. Under "Build and deployment", set **Source: Deploy from a branch**, branch **main**, folder **/ (root)**. Save.
5. Wait ~1 minute, then your app is live at `https://<your-username>.github.io/fasto-innova/` — open that on any phone or laptop.

No terminal, no git commands — everything above is point-and-click on github.com.

**One follow-up once it's live:** Supabase's "confirm your email" link redirects new sign-ups back to a URL set in the Supabase dashboard, which currently isn't your GitHub Pages address. Signup still works either way — the account gets confirmed regardless — but to make that link land back on the app instead of a blank/wrong page, go to your Supabase project → **Authentication → URL Configuration** and set **Site URL** to `https://<your-username>.github.io/fasto-innova/` once you know it (one field, one save — no code involved).

## Project structure

```
index.html          app shell — onboarding + sidebar/header + the 3 screens
css/base.css         design tokens, resets, buttons/pills/inputs/avatars
css/app.css           shell layout, dashboard/clients/chatbot layouts, mobile
js/data.js             the 36-buyer + 3-channel Cassino database, price assumptions
js/core.js              Brain 2 (matching engine) + Brain 3 (Guardian) — pure functions, unit-tested
js/app.js                state, screens, Brain 1 orchestration (Claude API calls)
assets/                   images/icons exported from the Figma file
manifest.json              PWA metadata (name, theme color)
test_engine.js               19 automated tests for core.js/data.js — run with `node test_engine.js`
```

## Data honesty

The buyer database (`js/data.js`) is desk research from public listings (review sites, business directories, official sites) — real business names and locations, but `needs`, `volume` and `quality_focus` are inferred for prototype purposes and would need real outreach to confirm before commercial use. This is documented directly in `data.js`'s `meta.disclaimer` field. Per-kg prices shown on the dashboard are editable assumptions, not live market data — click any price to change it.
