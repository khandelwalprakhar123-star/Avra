# wcgen / WhatsApp Card Bot — Full Technical Report

**Report date:** 2026-07-15
**This folder:** `wcardv1/` — the code for the **v1.1 release** (image generation + reply-to-edit loop)
**Parent project:** `/Users/humptydumpty/whatsapp-card-bot` — the full product (Tool A + Tool B + art direction)

---

## 1. What the product is

A WhatsApp bot ("wcgen") that generates Indian festive invitation/greeting cards. A user messages
a WhatsApp number, describes the card they want (optionally attaching reference photos), and gets
back an AI-generated card image. Under the hood every card is drawn by **Google Gemini's image
model** (`gemini-3.1-flash-lite-image`, nicknamed **"Nano Banana Lite"**).

The full product is sophisticated: it understands the request, searches a curated library of 390
real cards, art-directs the generation with a bespoke style guide, and supports multi-turn editing.
**v1.1 (this folder) strips all of that down to the essential spine** so it can ship immediately.

---

## 2. The two things in this repo

| | **Full product** (repo root) | **v1.1** (`wcardv1/`, this folder) |
|---|---|---|
| Intake | WhatsApp via Twilio | WhatsApp via Twilio (identical) |
| Understanding | Tool A (conversation) + Tool B (extract → slots) | none — raw text passed through |
| Retrieval | Tool B: embedding search over 390 cards | none |
| Art direction | `lib/artdirect.js` writes a style guide | none |
| Image model | Gemini Nano Banana Lite | Gemini Nano Banana Lite (identical) |
| Reference images | catalogue cards chosen by search | **user's own attached photos** |
| Editing | reply-to-edit loop | **reply-to-edit loop** (ported from the full product) |
| State/DB | Supabase Postgres (3 tables) | **none** (Supabase used for image hosting only) |
| Image hosting | local disk + ngrok | **Supabase Storage bucket** |
| Spend caps | Postgres ledger (durable) | in-memory counters |

---

## 3. v1.1 pipeline (what this folder does)

```
 WhatsApp user
      │  text + optional reference photos
      ▼
 Twilio ──POST /whatsapp──►  server.js
                              │  1. validate Twilio signature
                              │  2. rate-limit (50/sender/hr · ₹200/day global)
                              │  3. what is this pointing at? (lib/session.js)
                              │       ├─ a reply / warm session ──► EDIT that image
                              │       └─ neither ────────────────► fresh generation
                              │  4. ack immediately ("working on it…")
                              │  5. download reference images from Twilio (lib/media.js)
                              │  6. editing? fetch the base back (lib/storage.js)
                              │  7. base + refs + text ──► Gemini Nano Banana (lib/generate.js)
                              │  8. upload result ──► Supabase Storage (lib/storage.js)
                              │  9. send public image URL back ──► Twilio ──► user
                              ▼
```

A first message is a **fresh generation**. Replying to an image the bot sent — or sending a bare
message while the session is still warm (30 min) — **edits** it instead: the previous image is
fetched back from Supabase and handed to Gemini as the base. Reply `finalize` (or `done`) to close
it and start fresh. Session state is in memory, so a restart forgets every open image.

### Files in `wcardv1/`

| File | Responsibility |
|---|---|
| `server.js` | The Twilio webhook + orchestration. ~130 lines. |
| `lib/generate.js` | The Gemini image call. Retry on transient 5xx; reject degenerate <10KB blanks. |
| `lib/media.js` | **New for v1.1.** Downloads the user's attached images from Twilio's authenticated media URLs. |
| `lib/storage.js` | Uploads each generated image to a public Supabase Storage bucket, returns the URL Twilio fetches. |
| `lib/ratelimit.js` | In-memory per-sender + global-daily spend caps. |
| `lib/session.js` | **New for v1.1.** The edit loop's memory: which image a reply points at, session warmth, branching, finality. Pure logic — driveable without a phone. |
| `.env` | All secrets (pasted below in §8). |
| `.env.example` | Template with every variable documented. |
| `package.json` | 4 runtime deps: `@google/genai`, `@supabase/supabase-js`, `express`, `twilio` (+ `dotenv`). |

### What was copied vs. written fresh
- **Copied & trimmed from the full product:** the Gemini call, retry logic, and the degenerate-image
  guard (from `lib/generate.js`); the Twilio webhook, signature validation, immediate-ack pattern,
  and spend caps (from `server.js`).
- **Written new for v1.1:** `lib/media.js` (the full product *discarded* attached images —
  `ARCHITECTURE.md §7`: "Reference images: MediaUrl0…N discarded") and `lib/storage.js` (the full
  product served images off local disk behind ngrok; v1.1 hosts them on Supabase Storage instead).
- **Deliberately NOT copied:** Tool A (`lib/conversation.js`), Tool B (`lib/extract.js`,
  `lib/query.js`, `lib/retrieve.js`, `lib/canonical.js`, `lib/derive.js`), art direction
  (`lib/artdirect.js`), the Supabase database layer (`lib/store.js`), the catalogue/embeddings data,
  the lab (`lab-server.js`), and all the `scripts/`.

### Verified working (2026-07-15)
- `npm install` — clean, 0 vulnerabilities.
- Supabase Storage — bucket `cards` auto-created public; upload + unauthenticated public fetch both
  return 200 with correct `content-type`. (This is the critical dependency: Twilio fetches the image
  URL with no credentials.)
- `node server.js` — boots and listens; env validation fires on any missing secret.

---

## 4. The tools & services (the full stack, explained)

### Tool A — the conversation *(full product only; not in v1.1)*
`lib/conversation.js`. A **hand-written state machine**, deliberately *not* an LLM agent. It decides
what to say back to the user and nothing else. States: `collecting → choosing → generating`. Its one
job in the understanding phase is to ask **at most one** clarifying question (only for things that get
*printed* — host name, date, venue), then get out of the way. No LLM ever chooses the bot's words —
that's the anti-nagging guarantee. It calls Tool B to turn text into structured slots.

### Tool B — the retrieval engine *(full product only; not in v1.1)*
The part that **finds pictures**. Message in, pictures out — it doesn't draw, talk, or remember. Its
pieces:
- `lib/extract.js` — one Gemini call that reads the user's messy text and splits it into two piles:
  the **look** (colour, style, motifs) and the **print copy** (names, dates, phone). These never mix —
  a phone number must go *on* the card, not *into* the search.
- `lib/canonical.js` / `lib/derive.js` — turn slots into a canonical "index card" sentence in the exact
  vocabulary the 390 real cards were catalogued with (e.g. "burgundy" → "deep maroon"), fill in implied
  motifs ("rajasthani" → arches, paisley, diyas), and detect when a conversation has stopped converging.
- `lib/query.js` / `lib/retrieve.js` — embed that canonical sentence and rank the 390 catalogue cards
  by cosine similarity, filter out wrong occasions and cards with no space to print on (only 94 of 390
  have room), then nudge for colour. Returns the top 30 plus a supporting **motif** and **photograph**.
- The trick: it searches with a *written description of the ideal card as if it already existed*, then
  asks "which of our 390 real cards is this closest to?" — comparing like with like, not a WhatsApp
  message against a catalogue entry.
- On pick, it hands the image model **5 references** (the chosen card first + 2 near-misses + 1 motif +
  1 photo) so the model builds something new instead of photocopying one card.
- Cost: ~3 seconds, well under ₹1 per search. Full detail in `../HOW-TOOL-B-WORKS.md`.

### Art direction *(full product only; not in v1.1)*
`lib/artdirect.js`. A billable Gemini call that writes a **bespoke style guide** (colour roles with
hex, stroke weights, prohibited lists) for each card, from the references Tool B returned. Without it,
the model fell back to its own prior (generic stock Indian festive cards). The guide is *binding* and
overrides the references where they disagree.

### Twilio — the WhatsApp transport *(used by both)*
The messaging provider. It receives inbound WhatsApp messages as signed webhooks to `POST /whatsapp`,
and sends outbound text + images back via its REST API. Key facts the code is built around:
- **Signature validation** — every webhook is HMAC-signed with the auth token over the exact called
  URL. This is the only thing stopping an anonymous internet user from spending your Gemini credits.
- **15-second read timeout** — the webhook must ack fast; the actual image goes back via a later REST
  call, never in the webhook response.
- **It fetches media by URL** — Twilio never takes image bytes; it takes a public HTTPS URL and pulls
  the file itself (why v1.1 needs Supabase Storage). It also rejects media whose bytes disagree with
  the declared type (error 63019).
- **Sandbox number** — `whatsapp:+14155238886` is Twilio's *shared* sandbox. Anyone who joins with the
  sandbox code can message the bot, which is exactly why the spend caps exist.
- Reference-image intake (v1.1) uses `MediaUrl0…N` behind Twilio HTTP Basic auth (Account SID : Auth
  Token).

### ngrok — the public tunnel *(used by both, for the webhook)*
Exposes the local Express server to the internet over a stable HTTPS URL
(`https://<your-subdomain>.ngrok-free.dev`) so Twilio can reach the webhook. `PUBLIC_BASE_URL`
must be this exact URL because Twilio's signature is computed over it. In the full product ngrok *also*
served the generated images; in v1.1 it only carries the webhook (images live on Supabase).

### Supabase — Postgres + Storage *(both use it, differently)*
- **Full product** uses Supabase **Postgres** for durable conversation state and a spend ledger
  (see §5), plus (in the target architecture) Storage for images.
- **v1.1** uses Supabase **Storage only** — a public bucket named `cards`. No tables, no rows, no RLS.
  Generated images are uploaded and served from `…/storage/v1/object/public/cards/<uuid>.png`.
- Access uses the **service role key** (full-database bypass, server-side only, never shipped to a
  browser). Project: ``.

### Gemini (Google) — the models *(both)*
One API key, three uses across the product:
- **`gemini-3.1-flash-lite-image` ("Nano Banana Lite")** — the image generator. ~₹3/image. Used by
  both the full product and v1.1. This is the *only* Gemini use in v1.1.
- **`gemini-3.1-flash-lite`** — the text extractor in Tool B (~2.3s). *Full product only.*
- **`gemini-embedding-001`** — embeds the canonical sentence for catalogue search. *Full product only.*

### OpenAI — the lab & the swappable backend *(full product only; NOT used in v1.1)*
`OPENAI_API_KEY` exists in `.env` for two reasons in the full product: (1) **the lab**
(`lab-server.js`, `npm run lab`) fans one brief out to five image models side-by-side to compare them,
some of which are OpenAI's; (2) the target architecture has a config-driven `ImageBackend` interface
with an OpenAI adapter to prove the seam is model-agnostic (`ARCHITECTURE.md §6`). **v1.1 calls only
Gemini** — the OpenAI key is carried in `.env` for parity but is unused by this folder's code.

---

## 5. The database (full product) — not used by v1.1

The full product's Supabase Postgres schema lives in `../supabase/migrations/0001_conversations.sql`.
Three tables, all written by the server with the service-role key; RLS enabled with **zero policies**
so only the service role can read/write. **v1.1 touches none of this.**

| Table | Purpose |
|---|---|
| `conversations` | One row per phone. The slot-filling state machine: `status`, retrieval `slots` (the look), `payload` (the print copy), the persisted `candidates` ranking + cursor, and loop guards. A partial unique index enforces one live conversation per phone. |
| `inbound_messages` | Twilio redelivery guard. `message_sid` is the primary key; a redelivered webhook must not re-extract or re-generate (silent double-spend). |
| `llm_calls` | The token/spend ledger. Every billable call (extract / embed / generate / art_direct) is logged so a runaway loop is visible before it's expensive. This is what makes the daily budget cap *durable* across restarts — the thing v1.1's in-memory caps can't do. |

### The data assets (full product)
- `catalog.json` (~554 KB) — the 390 curated cards with their annotations ("index cards").
- `embeddings.json` (~6.4 MB) — precomputed embedding vectors for catalogue search.
- `motifs-catalog.json`, `fonts-catalog.json`, plus the `Diwali Cards/`, `Diwali Database/`,
  `Fonts Database/`, and `motifs/` folders — the raw asset libraries.
- `billing-report.html`, `TRACKER.md`, `PRD.md`, `ARCHITECTURE.md`, `HOW-TOOL-B-WORKS.md` — ops &
  design docs.

---

## 6. How to run v1.1

```bash
cd wcardv1
npm install                      # already done
# .env is populated (see §8). Make sure PUBLIC_BASE_URL matches your live ngrok URL.
ngrok http 3000                  # in another terminal — copy the https URL into PUBLIC_BASE_URL
npm start                        # boots on PORT (default 3000)
```
Then point the Twilio WhatsApp sandbox's "when a message comes in" webhook at
`https://<your-ngrok>/whatsapp` and message the sandbox number. Send text, or text + photos.

**Roadmap (next release):** a durable spend ledger + session store (Postgres), replacing the
in-memory maps that a restart wipes.

---

## 7. Known limitations of v1.1 (by design)
- **Editing is in-memory only.** A restart (or `node --watch` on file save) forgets every open
  image, so a reply after one lands as a brand-new generation instead of an edit.
- **In-memory spend caps.** Restarting the server (or `node --watch` on file save) resets the day's
  count, and a second process keeps its own tally. The ₹/day cap also multiplies a *fixed* ₹/gen
  estimate (`COST_PER_GEN_INR`) rather than observing the real Gemini bill.
- **No eviction.** `sessions` / `sidToCard` / `closedCards` grow for the life of the process. They
  hold URLs and ids, not image bytes, so this is slow — but it is unbounded.
- **No webhook dedup.** Without the Postgres `inbound_messages` guard, a Twilio redelivery *could*
  double-generate. Mitigated by the immediate 200 ack (redelivery is rare), not eliminated.
- **Image type support** is whatever Gemini accepts (PNG/JPEG/WebP). Exotic uploads (HEIC) may fail.

---

## 8. `.env` (pasted, as requested)

> ⚠️ **Secrets redacted.** This report is committed to a shared Git repository, so the live values
> are NOT reproduced here. The real, complete values live only in `wcardv1/.env` on disk, which is
> git-ignored and never pushed. Structure below; fill from `.env.example`.

```dotenv
TWILIO_ACCOUNT_SID=<in wcardv1/.env>
TWILIO_AUTH_TOKEN=<in wcardv1/.env>
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
GEMINI_API_KEY=<in wcardv1/.env>
PUBLIC_BASE_URL=<your ngrok https URL, in wcardv1/.env>
PORT=3000
SUPABASE_URL=<in wcardv1/.env>
SUPABASE_SERVICE_ROLE_KEY=<in wcardv1/.env — service-role JWT, server-side only>
SUPABASE_BUCKET=cards
# OPENAI_API_KEY — removed; v1.1 does not use OpenAI. Add back only if you wire up the full product.

# Spend caps (in-memory; see lib/ratelimit.js)
MAX_PER_SENDER_PER_HOUR=50
MAX_GLOBAL_INR_PER_DAY=200
COST_PER_GEN_INR=3.2
MAX_REFERENCES=6
```

The complete, unredacted values live only in `wcardv1/.env` on disk. If any secret has already been
committed or shared elsewhere, rotate it (Twilio auth token, Gemini key, Supabase service-role key,
OpenAI key).
