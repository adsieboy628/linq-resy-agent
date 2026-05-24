# resy-sniper

Personal Resy reservation sniper. Text a number in natural language ("I Sodi Saturday June 14 6-9:30 for 3"), bot watches for matching slots, **auto-books on your Resy account when found** and texts you the confirmation.

Lives as a subfolder inside `linq-resy-agent` because it reuses the Resy API surface from `../src/bookings/client.ts` (MIT). Runs entirely on **Supabase Edge Functions + pg_cron** — no Railway, no Fly, no Docker, no laptop. **Single user only.**

See `PROJECT.md` for live production handles (Supabase project ID, dashboard URL, env var names).

---

## What I (Claude) already did

- Created Supabase project `resy-sniper` (id: `eskqbzoisyrvybxyjmln`, us-east-1, $10/mo Pro).
- Wrote two Edge Functions (`sniper-inbound`, `sniper-poll`) + shared lib.
- Wrote the schema migration + pg_cron schedule.

## What's left for you (Adam) — ~15 min on iPhone

### 1. Linq Blue free sandbox (5 min)
Sign up at https://linqapp.com → create a partner account → generate an API token → note your assigned bot phone number(s). This is the iMessage bridge.

### 2. Set the 5 env vars in Supabase (5 min)
Dashboard: https://supabase.com/dashboard/project/eskqbzoisyrvybxyjmln/settings/functions

Add these secrets (Edge Functions → Secrets):

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | reuse your curaite key |
| `SNIPER_ENCRYPTION_KEY` | run on any computer: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` → paste output |
| `LINQ_API_TOKEN` | from Linq dashboard |
| `LINQ_BOT_NUMBERS` | comma-separated, e.g. `+12025550101` |
| `SNIPER_OWNER_HANDLES` | your iMessage phone, e.g. `+15551234567` — bot will refuse anyone else |
| `SNIPER_WEBHOOK_SECRET` | any random 32+ char string — Linq will need this too |

### 3. Tell Linq Blue where to send messages (2 min)
Linq dashboard → Webhooks → add:
- URL: `https://eskqbzoisyrvybxyjmln.supabase.co/functions/v1/sniper-inbound`
- Custom header: `x-sniper-secret` = (the secret from step 2)

### 4. Tell me when those four steps are done.
I apply the migration, deploy the functions, kick off cron. Then you text the bot.

---

## How you use it

Text the bot's Linq number from your iPhone:

```
/connect +15551234567
```
Bot sends Resy an SMS code. You reply:
```
/code 123456
```
(If Resy asks for email after the code, bot will prompt: `/email you@x.com`.)

Then just text what you want:

```
watch I Sodi Saturday June 14 6-9:30 for 3
```

Bot replies:
> watching I Sodi — 2026-06-14, 18:00-21:30, party 3. will auto-book when found.

When it lands the slot:
> BOOKED I Sodi — 2026-06-14 19:15, party 3
> https://resy.com/cities/ny/i-sodi

### Other commands
```
/list — show active watches
/cancel 2 — cancel watch #2 from /list
/signout — disconnect Resy
/help
```

### Opt out of auto-book per request
Include "no book" or "just ping" in your request:
```
watch I Sodi Sat June 14 6-9:30 for 3 just ping me
```
Bot will send the Resy link instead of booking.

---

## Architecture

```
iPhone ──iMessage──▶ Linq Blue ──webhook──▶ sniper-inbound (Edge Fn)
                                                │
                                                ▼
                                       sniper_watches (Supabase)
                                                │
                                       ┌────────┴────────┐
                                       ▼                 ▼
                              every 60s pg_cron     stored auth token
                                       │            (AES-256-GCM)
                                       ▼
                              sniper-poll (Edge Fn)
                                       │
                                       ▼
                              Resy /4/find for each watch
                                       │
                                  matches? ──▶ Resy /3/details → /2/user → /3/book
                                       │                          │
                                       ▼                          ▼
                              record in sniper_alerts    iMessage confirmation
                                                         via Linq Blue
```

## Files

```
sniper/
├── README.md (this)
├── PROJECT.md                 ← LIVE PRODUCTION HANDLES — always keep current
└── supabase/
    ├── migrations/
    │   └── 20260522000000_sniper_init.sql
    └── functions/
        ├── _shared/
        │   ├── env.ts
        │   ├── encryption.ts  ← AES-256-GCM (Web Crypto / Deno)
        │   ├── db.ts          ← Supabase client + Watch CRUD + alert dedupe
        │   ├── resy.ts        ← search, find slots, book
        │   ├── resy-auth.ts   ← SMS OTP / challenge flow
        │   ├── linq.ts        ← send iMessage via Linq Blue
        │   ├── parse.ts       ← Claude Haiku turns text into a Watch
        │   └── match.ts       ← slot vs prefs filter
        ├── sniper-inbound/index.ts  ← webhook receiver; auth-gated to SNIPER_OWNER_HANDLES
        └── sniper-poll/index.ts     ← cron tick; polls + books + notifies
```

## Risks (read before launch)

- **Resy ToS:** unofficial API. Personal-volume, single-account = below historical enforcement threshold (they enforce against scalper bots like Appointment Trader). Don't share. Don't resell. Backup Resy account on standby per Adam.
- **Auto-book charges credit card.** Default payment method on Resy must be valid. Bot will throw "No payment method on file" if not.
- **Token expiry:** rotates every few weeks. `/connect` re-runs OTP — 30 sec recovery.
- **Owner gate is the only auth:** if `SNIPER_OWNER_HANDLES` is misconfigured (e.g. wrong format), bot might refuse you or accept strangers. Verify after deploy.
- **Cron is 1-min granular** (Supabase pg_cron minimum). Fine for cancellation watches; for hot drops you may miss the first wave. Acceptable for an NYC trip-planning use case where most matches will be cancellations + slow-drop venues.
- **Edge Function timeout** is 150s. Far more than we need; ~50 watches × ~1s each per tick is the practical ceiling.

## Cost: ~$10/mo

(Supabase Pro for the project, everything else free.)
