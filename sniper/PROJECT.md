# sniper — production handles

This is the source-of-truth for every external resource the Resy sniper depends on. Keep updated.

## Supabase

| | |
|---|---|
| **Project name** | `resy-sniper` |
| **Project ref / ID** | `eskqbzoisyrvybxyjmln` |
| **Organization** | `fapyiiqfzljtvygqfpxe` (same org as `curaite`) |
| **Region** | `us-east-1` |
| **Plan** | Pro ($10/mo — required because curaite already occupies the free slot in this org) |
| **Created** | 2026-05-24 |
| **Dashboard** | https://supabase.com/dashboard/project/eskqbzoisyrvybxyjmln |
| **API URL** | https://eskqbzoisyrvybxyjmln.supabase.co |

### Edge Functions (deployed)

| Name | Purpose | URL | verify_jwt |
|---|---|---|---|
| `sniper-inbound` | Linq Blue webhook receiver (iMessage in) | https://eskqbzoisyrvybxyjmln.supabase.co/functions/v1/sniper-inbound | false (auth via `x-sniper-secret` header) |
| `sniper-poll` | Watcher tick — polls Resy, books on match | https://eskqbzoisyrvybxyjmln.supabase.co/functions/v1/sniper-poll | false (auth via `x-sniper-secret` header) |

### Schema (applied)

Tables: `sniper_chats`, `sniper_credentials`, `sniper_pending_otp`, `sniper_watches`, `sniper_alerts`, `sniper_meta`.

Extensions: `pg_cron`, `pg_net`.

Cron job (active, every 1 min): `sniper-poll-tick` — `pg_net.http_post` to `sniper-poll` with the secret read from `sniper_meta.value where key = 'webhook_secret'`.

## Secrets to paste into Supabase Edge Function env vars

Dashboard → https://supabase.com/dashboard/project/eskqbzoisyrvybxyjmln/settings/functions

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | (reuse your curaite Anthropic key) |
| `SNIPER_ENCRYPTION_KEY` | `28f32f62cbeaffe183021f9d11f4611423bd7a29b339b7ca190826c0aad0990e` |
| `SNIPER_WEBHOOK_SECRET` | `5e5a01f9dc59e641642bf9cf0e45f459ab0436f78e3adda60aa3b2bd3299dc04` |
| `LINQ_API_TOKEN` | (from your Linq Blue dashboard once you sign up) |
| `LINQ_BOT_NUMBERS` | (the phone number Linq assigns your bot, with `+`, e.g. `+12025550101`) |
| `SNIPER_OWNER_HANDLES` | (your iMessage phone number, with `+`, e.g. `+15551234567` — bot REFUSES anyone else) |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-injected into Edge Functions — don't set them.

## Linq Blue (you sign up — only new account needed)

1. Sign up at https://linqapp.com (free sandbox tier)
2. Generate a partner API token → paste as `LINQ_API_TOKEN` above
3. Note your bot's assigned phone number(s) → paste as `LINQ_BOT_NUMBERS` above
4. Configure the webhook:
   - URL: `https://eskqbzoisyrvybxyjmln.supabase.co/functions/v1/sniper-inbound`
   - Custom header: `x-sniper-secret: 5e5a01f9dc59e641642bf9cf0e45f459ab0436f78e3adda60aa3b2bd3299dc04`
   - Event: `message.received`

## Resy

- Public web frontend API key — embedded as default (`VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5`). No action.
- Your auth token — obtained per-account via SMS OTP after you text `/connect +phone` to the bot. Stored encrypted (AES-256-GCM) in `sniper_credentials`. Tokens rotate every few weeks; run `/connect` again to refresh.
- Primary Resy account: phone TBD
- Backup Resy account: phone TBD (recommend connecting this one first to validate end-to-end)

## Costs

| Item | Monthly |
|---|---|
| Supabase Pro (resy-sniper project) | $10 |
| Linq Blue sandbox | $0 |
| Anthropic API (Haiku, parses ~10 msgs/day) | <$0.10 |
| **Total** | **~$10** |

## v1 vs v2

**v1 (default for every watch):** auto-book when found. Bot uses your default Resy payment method, sends iMessage confirmation with venue + time + Resy URL.

**Opt out per watch:** include "no book" / "just ping" / "link only" in the request. Bot will text you the Resy link instead of booking.

## Operating commands (text the bot)

```
/connect +15551234567 — connect Resy via SMS OTP
/code 123456 — verify the SMS code Resy sent
/email you@x.com — provide email if Resy challenges after the code
/list — show your active watches
/cancel 2 — cancel watch #2 from /list
/signout — disconnect Resy account
/help — show this
```

Free-form requests (the main use case):
```
watch I Sodi Saturday June 14 6-9:30 for 3
```

## Code layout

```
sniper/
├── README.md                 ← user-facing setup
├── PROJECT.md (this)         ← live production handles
└── supabase/
    ├── migrations/
    │   └── 20260522000000_sniper_init.sql
    └── functions/
        ├── _shared/          ← env, db, encryption, resy, resy-auth, linq, parse, match
        ├── sniper-inbound/   ← Linq webhook receiver
        └── sniper-poll/      ← cron-driven watcher + auto-book
```

## Already-done checklist

- [x] Created Supabase project (`eskqbzoisyrvybxyjmln`, us-east-1, Pro plan)
- [x] Applied schema migration (5 sniper_* tables + pg_cron + pg_net)
- [x] Deployed `sniper-inbound` Edge Function (version 1)
- [x] Deployed `sniper-poll` Edge Function (version 2, with shared-secret auth)
- [x] Scheduled pg_cron `sniper-poll-tick` — confirmed active
- [x] Stored shared secret in `sniper_meta` for cron use

## What you still do (one sitting, ~15 min on iPhone)

- [ ] Sign up at linqapp.com → get API token + bot number
- [ ] Paste the 6 env vars above into the Supabase Edge Functions Secrets dashboard
- [ ] Configure Linq Blue webhook (URL + `x-sniper-secret` header) per the table above
- [ ] Text the bot: `/connect +<your_backup_resy_phone>` → reply with `/code 123456` when SMS arrives
- [ ] Start sniping: `watch I Sodi Sat Jun 14 6-9:30 for 3`
