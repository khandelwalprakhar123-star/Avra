# wcgen / WhatsApp Card Bot — Full Technical Report

**Report date:** 2026-07-22
**This folder:** `wcardv1/` — the code for the **v1.1 release** (image generation + reply-to-edit loop)
**Parent project:** `/Users/humptydumpty/whatsapp-card-bot` — the full product (Tool A + Tool B + art direction)

---

## 1. What the product is

A WhatsApp bot ("wcgen") that generates Indian festive invitation/greeting cards. A user messages
a WhatsApp number, describes the card they want (optionally attaching reference photos), and gets
back an AI-generated card image. Under the hood every card is drawn by **OpenAI's image model**
(`gpt-image-2`).

The full product is sophisticated: it understands the request, searches a curated library of 390
real cards, art-directs the generation with a bespoke style guide, and supports multi-turn editing.
**v1.1 (this folder) strips all of that down to the essential spine** so it can ship immediately.

> **Image-model history.** v1.1 originally generated on Google Gemini
> (`gemini-3.1-flash-lite-image`, "Nano Banana Lite"). It migrated to OpenAI `gpt-image-2` in commit
> `96e7f3c`; the Gemini path and its `@google/genai` dependency are gone, but the previous
> `lib/generate.js` is recoverable from git history. Nothing else in the harness knew the
> difference — `generate()` still returns `{ bytes, mimeType }`.

---

## 2. The two things in this repo

| | **Full product** (repo root) | **v1.1** (`wcardv1/`, this folder) |
|---|---|---|
| Intake | WhatsApp via Twilio | WhatsApp via Twilio (identical) |
| Understanding | Tool A (conversation) + Tool B (extract → slots) | none — raw text passed through |
| Retrieval | Tool B: embedding search over 390 cards | none |
| Art direction | `lib/artdirect.js` writes a style guide | none |
| Image model | Gemini Nano Banana Lite | **OpenAI `gpt-image-2`** |
| Reference images | catalogue cards chosen by search | **user's own attached photos** |
| Editing | reply-to-edit loop | **reply-to-edit loop** (ported from the full product) |
| State/DB | Supabase Postgres (3 tables: conversations, inbound, spend ledger) | **Supabase Postgres (4 tables: edit-loop state + spend ledger)** — no catalogue, no users |
| Image hosting | local disk + ngrok | **Supabase Storage bucket** |
| Spend caps | Postgres ledger (durable) | **Postgres ledger (durable)**, real token-based cost |

---

## 3. v1.1 pipeline (what this folder does)

```
 WhatsApp user
      │  text + optional reference photos
      ▼
 Twilio ──POST /whatsapp──►  server.js
                              │  1. validate Twilio signature
                              │  2. what is this pointing at? (lib/session.js)
                              │       ├─ a reply / warm session ──► EDIT that image
                              │       └─ neither ────────────────► fresh generation
                              │  3. "finalize"? close the card, reply, stop
                              │  4. spend cap: reserve atomically in Postgres (₹200/day global)
                              │  5. ack immediately ("working on it…")
                              │  6. download reference images from Twilio (lib/media.js)
                              │  7. editing? fetch the base back (lib/storage.js)
                              │  8. base + refs + text ──► gpt-image-2 (lib/generate.js)
                              │  9. settle the spend at REAL token cost (lib/pricing.js)
                              │ 10. upload result ──► Supabase Storage (lib/storage.js)
                              │ 11. record the version + outbound SID (lib/session.js)
                              │ 12. send public image URL back ──► Twilio ──► user
                              ▼
```

A first message is a **fresh generation**. Replying to an image the bot sent — or sending a bare
message while the session is still warm (30 min) — **edits** it instead: the previous image is
fetched back from Supabase and handed to `gpt-image-2` as the base. Reply `finalize` (or `done`) to
close it and start fresh. **Session state is durable in Postgres**, so a reply resolves correctly
across restarts, deploys, and `node --watch` reloads.

### Files in `wcardv1/`

| File | Responsibility |
|---|---|
| `server.js` | The Twilio webhook + orchestration. ~245 lines. Boots only after Twilio credentials and the Supabase schema both verify. |
| `lib/generate.js` | The `gpt-image-2` call (`images.generate` / `images.edit`). Retry on transient 429/5xx; reject degenerate <10KB blanks; sniff the real MIME from magic bytes. |
| `lib/pricing.js` | **New.** Turns the `usage` token meters into a real ₹ cost — three separate meters (text in, image in, image out) at their own rates. |
| `lib/media.js` | **New for v1.1.** Downloads the user's attached images from Twilio's authenticated media URLs. Fails loudly on 401/403 rather than silently degrading to text-only. |
| `lib/storage.js` | Uploads each generated image to a public Supabase Storage bucket, returns the URL Twilio fetches; fetches a base image back for edits. |
| `lib/ratelimit.js` | Global daily spend cap, durable in Postgres. Reserve-then-settle against the real billed cost; fails **closed** if the ledger is unreachable. |
| `lib/session.js` | **New for v1.1.** The edit loop's memory, backed by Postgres: which image a reply points at, session warmth, branching, finality. |
| `db/schema.sql` | **New.** The three edit-loop tables, the `spend_ledger` table, and the `reserve_spend()` function. Run in the Supabase SQL editor; safe to re-run (see §5). |
| `site/index.html` | The standalone "Aangan" marketing page. Not served by `server.js`. |
| `.env` | All secrets. Git-ignored. Structure in §8. |
| `.env.example` | Template with every variable documented, required and optional. |
| `package.json` | 4 runtime deps: `openai`, `@supabase/supabase-js`, `express`, `twilio` (+ `dotenv`). |

### What was copied vs. written fresh
- **Copied & trimmed from the full product:** the retry logic and degenerate-image guard (from
  `lib/generate.js`); the Twilio webhook, signature validation, immediate-ack pattern, and spend caps
  (from `server.js`). The image call itself has since been rewritten for OpenAI.
- **Written new for v1.1:** `lib/media.js` (the full product *discarded* attached images —
  `ARCHITECTURE.md §7`: "Reference images: MediaUrl0…N discarded"), `lib/storage.js` (the full
  product served images off local disk behind ngrok), and `lib/pricing.js`.
- **Deliberately NOT copied:** Tool A (`lib/conversation.js`), Tool B (`lib/extract.js`,
  `lib/query.js`, `lib/retrieve.js`, `lib/canonical.js`, `lib/derive.js`), art direction
  (`lib/artdirect.js`), the full product's database layer (`lib/store.js`), the catalogue/embeddings
  data, the lab (`lab-server.js`), and all the `scripts/`.

### Verified working (2026-07-22)
- `node server.js` — boots and listens. This is a real check, not a smoke test: boot validates all
  seven required env vars, makes an authenticated call to the Twilio API, queries the three
  edit-loop tables, and probes `reserve_spend()` before it will listen.
- Boot correctly **refuses to start** against a project whose `db/schema.sql` predates the spend
  ledger, naming the missing function and telling you to re-run the file. Confirmed against a real
  un-migrated project — this is the failure you will hit if you pull without migrating.
- Dependencies in sync — `openai@6.48.0` installed, `@google/genai` removed.
- Supabase Storage — bucket `cards` auto-created public; upload + unauthenticated public fetch both
  return 200 with correct `content-type`. (This is the critical dependency: Twilio fetches the image
  URL with no credentials.)

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
  URL. This is the only thing stopping an anonymous internet user from spending your OpenAI credits.
- **15-second read timeout** — the webhook must ack fast; the actual image goes back via a later REST
  call, never in the webhook response. A fresh generation is ~20s and an edit is 75–90s, so the two
  acks quote different times on purpose.
- **`OriginalRepliedMessageSid`** — when a user swipes-to-reply, Twilio hands back the SID of the
  message they replied to. That is the same SID returned when we sent the image, and it is the entire
  hinge of the edit loop (`sent_versions`, §5).
- **It fetches media by URL** — Twilio never takes image bytes; it takes a public HTTPS URL and pulls
  the file itself (why v1.1 needs Supabase Storage). It also rejects media whose bytes disagree with
  the declared type (error 63019).
- **Sandbox number** — `whatsapp:+14155238886` is Twilio's *shared* sandbox. Anyone who joins with the
  sandbox code can message the bot, which is exactly why the spend cap exists.
- Reference-image intake (v1.1) uses `MediaUrl0…N` behind Twilio HTTP Basic auth (Account SID : Auth
  Token). Twilio then 307-redirects to a pre-signed CDN URL, and `fetch()` strips the `Authorization`
  header on that cross-origin hop — so the credentials reach Twilio and never leak to the CDN.

### ngrok — the public tunnel *(used by both, for the webhook)*
Exposes the local Express server to the internet over a stable HTTPS URL
(`https://<your-subdomain>.ngrok-free.dev`) so Twilio can reach the webhook. `PUBLIC_BASE_URL`
must be this exact URL because Twilio's signature is computed over it. In the full product ngrok *also*
served the generated images; in v1.1 it only carries the webhook (images live on Supabase).

### Supabase — Postgres + Storage *(both use it, for both purposes)*
- **Full product** uses Supabase **Postgres** for durable conversation state and a spend ledger
  (see §5), plus (in the target architecture) Storage for images.
- **v1.1** uses **both**, in the same project:
  - **Storage** — a public bucket named `cards`, auto-created on boot. Generated images are served
    from `…/storage/v1/object/public/cards/<uuid>.png`.
  - **Postgres** — four tables: the edit-loop state and the spend ledger (`db/schema.sql`, §5). RLS
    is enabled with zero policies, so the anon key can read nothing; these tables hold phone numbers.
- Access uses the **service role key** (full-database bypass, server-side only, never shipped to a
  browser). The project ref is in `SUPABASE_URL` in your local `.env`.

### OpenAI — the image model *(v1.1's only model provider)*
- **`gpt-image-2`** — the image generator, and the single external model call v1.1 makes. Requests go
  to `images.generate` for a fresh card, or `images.edit` whenever there is any input image (a base
  being edited, or attached references). Knobs: `IMAGE_QUALITY` (rendering polish, *not* a reasoning
  level — gpt-image-2 has no thinking pass) and `IMAGE_SIZE` (default `1024x1536`, 2:3 portrait).
- **Billing is metered, not flat.** Three meters at their own USD/1M rates: text in ($5), image in
  ($8, edits only), image out ($30). An edit genuinely costs more than a fresh generation because the
  base image is sent back in as input. `lib/pricing.js` reads all of it off the response's `usage`.
- In the **full product**, `OPENAI_API_KEY` additionally powers the lab (`lab-server.js`, `npm run
  lab`), which fans one brief out to five image models side-by-side to compare them.

### Gemini (Google) — *full product only; no longer used by v1.1*
- **`gemini-3.1-flash-lite`** — the text extractor in Tool B (~2.3s).
- **`gemini-embedding-001`** — embeds the canonical sentence for catalogue search.
- **`gemini-3.1-flash-lite-image` ("Nano Banana Lite")** — the full product's image generator, and
  v1.1's until commit `96e7f3c`. v1.1 no longer makes any Gemini call, and `GEMINI_API_KEY` is not
  read by any code in this folder.

---

## 5. The databases

### v1.1's edit-loop tables — `db/schema.sql`

**Run this once**, in the Supabase SQL editor for the project referenced by `SUPABASE_URL`. Skipping
it does not produce a broken-looking deploy — `server.js` refuses to boot without these tables,
precisely so it can't look healthy while silently dropping every reply back to fresh generation.

| Table | Purpose |
|---|---|
| `sent_versions` | Every outbound image, keyed by its Twilio message SID. A swipe-to-reply hands that SID back, and this is where the base version is looked up. The hinge of the edit loop. |
| `sessions` | One row per phone — the image thread that phone currently has open: its version list, `open`/`closed` status, and `last_activity` (compared against the 30-minute edit window). |
| `closed_cards` | Cards the user has finalized. Finality is tracked **per card, not per session**: a reply still names a version long after its session is gone, and a branched session shares its seed version's lineage. |
| `spend_ledger` | One row per generation, all senders. `inr` is written twice: `EST_PER_GEN_INR` when the work is reserved, then the real token-based cost when it settles (or 0 if the call failed before OpenAI billed). |

Plus one function, **`reserve_spend(phone, reserve, cap)`** — the compare-and-reserve for the daily
budget, which runs in SQL rather than JS. In memory, "sum the day, compare, append" was a single
uninterruptible step; across a network it is three, and two concurrent requests could both read ₹198
and both proceed. A `pg_advisory_xact_lock` serialises reservations, held for the transaction only
(microseconds) and never across the ~40s generation itself. It returns `allowed=false` when the
budget is spent, and the caller turns that into a user-facing refusal.

All of this is written only by the server with the service-role key. RLS is enabled with **zero
policies**, so the anon/publishable key can neither read nor write — these tables hold phone numbers.
`reserve_spend` additionally has its default `public` grant revoked.

These replaced in-memory state. Before that, a restart forgot every open image — so a reply to
yesterday's card (the process had restarted overnight) found nothing and was silently treated as a
brand-new generation — and reset the day's spend to ₹0, which meant any redeploy silently lifted the
only ceiling on the OpenAI bill.

### The full product's schema — *not used by v1.1*

Lives in `../supabase/migrations/0001_conversations.sql`. Three separate tables, same access model.

| Table | Purpose |
|---|---|
| `conversations` | One row per phone. The slot-filling state machine: `status`, retrieval `slots` (the look), `payload` (the print copy), the persisted `candidates` ranking + cursor, and loop guards. A partial unique index enforces one live conversation per phone. |
| `inbound_messages` | Twilio redelivery guard. `message_sid` is the primary key; a redelivered webhook must not re-extract or re-generate (silent double-spend). |
| `llm_calls` | The token/spend ledger. Every billable call (extract / embed / generate / art_direct) is logged so a runaway loop is visible before it's expensive. v1.1's `spend_ledger` is the same idea, narrowed to the one billable call it makes. |

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
npm install
# 1. Fill .env from .env.example (see §8).
# 2. Run db/schema.sql ONCE in the Supabase SQL editor — the server won't boot without it.
ngrok http 3000                  # in another terminal — copy the https URL into PUBLIC_BASE_URL
npm start                        # boots on PORT (default 3000)
```
Then point the Twilio WhatsApp sandbox's "when a message comes in" webhook at
`https://<your-ngrok>/whatsapp` and message the sandbox number. Send text, or text + photos.

`PUBLIC_BASE_URL` must match the live ngrok URL exactly — Twilio's signature is computed over the URL
it called, so a stale value fails every webhook with a signature mismatch.

> **Upgrading an existing project?** Re-run `db/schema.sql`. It now also creates `spend_ledger` and
> `reserve_spend()`, and the server refuses to boot without them — a project set up before the ledger
> landed will fail on startup with a message pointing here. The file is idempotent (`create table if
> not exists`, `create or replace function`), so re-running it is safe.

**Roadmap:** an automated test suite (see §7) is the next item. Both halves of the previous
roadmap — the durable session store and the durable spend ledger — have now shipped.

---

## 7. Known limitations of v1.1
- **No automated tests.** There is no test suite, no `test` script, and no CI. The edit-loop rules in
  `lib/session.js` — reply ownership, finality, branching, version identity — are the subtlest logic
  in the codebase and are currently verified only by reading — as are the reserve/settle paths in
  `lib/ratelimit.js`, which now span a network boundary and are where a silent regression costs real
  money. `lib/session.js`, `lib/storage.js`, and `lib/ratelimit.js` each build their Supabase client
  at module load from `process.env`, so none can be exercised without live credentials; making them
  injectable is the prerequisite for testing any of it.
- **A failed settle over-counts.** `settle()` never throws, by design: it runs mid-`try` on the
  success path, so a rejected ledger write would be caught by the generation's own error handler and
  tell the user their finished image failed. The cheaper wrong answer is a stuck reservation — it
  over-counts the day by a few rupees and expires on its own after 24h.
- **A ledger outage stops the bot.** `check()` fails **closed**: if Supabase is unreachable the
  server cannot know what has been spent, so it refuses to generate rather than run uncapped. That
  is the right trade against an unbounded bill, but it does mean the database is a hard dependency
  for generating at all, not just for remembering.
- **No per-sender cap.** The ₹200/day ceiling is global and deliberately has no per-sender
  counterpart, so a single sender on the shared public sandbox number can spend the entire day's
  budget alone.
- **No eviction.** `sent_versions`, `closed_cards`, and `spend_ledger` grow without bound — nothing
  prunes settled ledger rows once they age past the 24h window. They hold URLs
  and ids rather than image bytes, so growth is slow — but nothing prunes them, and neither does the
  Storage bucket.
- **No webhook dedup.** Without the full product's `inbound_messages` guard, a Twilio redelivery
  *could* double-generate. Mitigated by the immediate 200 ack (redelivery is rare), not eliminated.
- **Concurrency is best-effort.** Two messages from the same phone in flight at once can interleave;
  `appendVersion` is scoped to phone *and* card_id so a stale write touches zero rows rather than
  clobbering a newer session, but there is no locking.
- **Image type support** is whatever `gpt-image-2` accepts (PNG/JPEG/WebP). Exotic uploads (HEIC) may
  fail; non-image attachments are silently skipped.

---

## 8. `.env`

> ⚠️ **Secrets redacted.** This report is committed to a shared Git repository, so the live values
> are NOT reproduced here. The real, complete values live only in `wcardv1/.env` on disk, which is
> git-ignored and never pushed. Structure below; `.env.example` documents every variable in full.

**Required** — `server.js` refuses to boot if any of these is missing:

```dotenv
TWILIO_ACCOUNT_SID=<in wcardv1/.env>
TWILIO_AUTH_TOKEN=<in wcardv1/.env>
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
OPENAI_API_KEY=<in wcardv1/.env>
SUPABASE_URL=<in wcardv1/.env>
SUPABASE_SERVICE_ROLE_KEY=<in wcardv1/.env — service-role JWT, server-side only>
PUBLIC_BASE_URL=<your ngrok https URL, in wcardv1/.env>
```

**Optional**, shown with their defaults — all documented in `.env.example`:

```dotenv
PORT=3000
SUPABASE_BUCKET=cards
IMAGE_MODEL=gpt-image-2
IMAGE_QUALITY=medium            # low | medium | high | auto — rendering polish, not "thinking"
IMAGE_SIZE=1024x1536            # 2:3 portrait
MAX_REFERENCES=6
EDIT_WINDOW_MIN=30              # how long a bare message still counts as an edit
MAX_GLOBAL_INR_PER_DAY=200      # global spend cap; no per-sender cap by design
EST_PER_GEN_INR=4.5             # reserved while in flight, settles to real token cost
PRICE_TEXT_INPUT_USD_PER_1M=5   # gpt-image-2 list price
PRICE_IMAGE_INPUT_USD_PER_1M=8
PRICE_IMAGE_OUTPUT_USD_PER_1M=30
USD_INR=98                      # fixed rate; no live FX feed
# VALIDATE_TWILIO_SIGNATURE=false — local curl testing ONLY. Never with a reachable PUBLIC_BASE_URL.
```

`GEMINI_API_KEY`, `MAX_PER_SENDER_PER_HOUR`, `COST_PER_GEN_INR`, and `THINKING_LEVEL` appear in older
`.env` files and are **no longer read by any code in this folder**. Do not carry `IMAGE_MODEL` over
from a Gemini-era `.env` — a Gemini model name passed to the OpenAI SDK fails every generation.

If any secret has already been committed or shared elsewhere, rotate it (Twilio auth token, OpenAI
key, Supabase service-role key).
