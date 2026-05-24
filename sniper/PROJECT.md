# sniper — production handles

Source-of-truth for every external resource the Resy sniper depends on. Keep updated.

**Transport pivot (2026-05-24):** Linq Blue is waitlist-only. Swapped to **Twilio SMS** — $2/mo extra, no waitlist, same UX (text a number from your iPhone). Code updated, both functions redeployed.

## Supabase

| | |
|---|---|
| **Project name** | `resy-sniper` |
| **Project ref / ID** | `eskqbzoisyrvybxyjmln` |
| **Organization** | `fapyiiqfzljtvygqfpxe` (same org as `curaite`) |
| **Region** | `us-east-1` |
| **Plan** | Pro ($10/mo) |
| **Created** | 2026-05-24 |
| **Dashboard** | https://supabase.com/dashboard/project/eskqbzoisyrvybxyjmln |
| **API URL** | https://eskqbzoisyrvybxyjmln.supabase.co |

### Edge Functions (deployed)

| Name | Version | URL | Auth | Status |
|---|---|---|---|---|
| **`sniper-app`** ★ | v1 | `https://eskqbzoisyrvybxyjmln.supabase.co/functions/v1/sniper-app?key=<SNIPER_WEBHOOK_SECRET>` | `?key=` query param | **THIS is the user-facing web app. Bookmark on iPhone home screen.** |
| `sniper-poll` | v4 | `https://eskqbzoisyrvybxyjmln.supabase.co/functions/v1/sniper-poll` | `x-sniper-secret` header (from pg_cron) | Notifications best-effort; web watches skip SMS |
| `sniper-health` | v1 | `https://eskqbzoisyrvybxyjmln.supabase.co/functions/v1/sniper-health` | none | Env-var verifier |
| `sniper-inbound` | v3 | `https://eskqbzoisyrvybxyjmln.supabase.co/functions/v1/sniper-inbound?secret=<SNIPER_WEBHOOK_SECRET>` | `?secret=` | Twilio webhook receiver — unused unless Twilio set up later |

**Verification:** Once secrets are pasted, `curl` the health URL. If it returns `"ok": true`, you're good to text the bot. If anything's missing or malformed, it tells you exactly which var.

### Schema (applied)

Tables: `sniper_chats`, `sniper_credentials`, `sniper_pending_otp`, `sniper_watches`, `sniper_alerts`, `sniper_meta`. Extensions: `pg_cron`, `pg_net`. Cron `sniper-poll-tick` runs every 1 min.

## Secrets — paste into Supabase Edge Function env vars

Dashboard → https://supabase.com/dashboard/project/eskqbzoisyrvybxyjmln/settings/functions

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | reuse your curaite Anthropic key |
| `SNIPER_ENCRYPTION_KEY` | `28f32f62cbeaffe183021f9d11f4611423bd7a29b339b7ca190826c0aad0990e` |
| `SNIPER_WEBHOOK_SECRET` | `5e5a01f9dc59e641642bf9cf0e45f459ab0436f78e3adda60aa3b2bd3299dc04` |
| `TWILIO_ACCOUNT_SID` | from Twilio Console (starts with `AC...`) |
| `TWILIO_AUTH_TOKEN` | from Twilio Console |
| `TWILIO_FROM_NUMBER` | your purchased Twilio number, e.g. `+15551234567` |
| `SNIPER_OWNER_HANDLES` | YOUR iPhone number in E.164, e.g. `+15551234567` — bot REFUSES anyone else |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-injected — don't set them.

## Twilio (replaces Linq Blue — no waitlist)

1. Sign up at https://twilio.com — free $15 trial credit ($1.15/mo for a US local number, ~$0.0079/msg)
2. Console → Phone Numbers → Buy a number → pick any US local number → checkout (uses trial credit at first)
3. Console → grab `Account SID` + `Auth Token` from the dashboard → paste as secrets above
4. Phone Numbers → Manage → Active Numbers → click your number → Messaging configuration:
   - "A message comes in" → Webhook → POST →
     `https://eskqbzoisyrvybxyjmln.supabase.co/functions/v1/sniper-inbound?secret=5e5a01f9dc59e641642bf9cf0e45f459ab0436f78e3adda60aa3b2bd3299dc04`
   - Save

## Resy

- Public web frontend API key — embedded as default (`VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5`). No action.
- Your auth token — obtained per-account via SMS OTP after you text `/connect +phone` to the bot. Stored encrypted (AES-256-GCM). Tokens rotate every few weeks; run `/connect` again to refresh.
- Primary Resy account: phone TBD
- Backup Resy account: phone TBD (connect this one first to validate end-to-end)

## Costs

| Item | Monthly |
|---|---|
| Supabase Pro (sniper project) | $10 |
| Twilio number + ~50 msgs | ~$2 |
| Anthropic API (Haiku parses) | <$0.10 |
| **Total** | **~$12** |

## v1 (live now): auto-book by default

Every watch auto-books on match. Bot uses your default Resy payment method, sends SMS confirmation with venue + time + Resy URL.

**Opt out per watch:** include "no book" / "just ping" / "link only" in the request. Bot will SMS the Resy link instead of booking.

## Operating commands (text the bot's Twilio number)

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
        ├── _shared/          ← env, db, encryption, resy, resy-auth, twilio, parse, match
        ├── sniper-inbound/   ← Twilio webhook receiver
        └── sniper-poll/      ← cron-driven watcher + auto-book
```

## Done

- [x] Created Supabase project (`eskqbzoisyrvybxyjmln`, us-east-1, Pro plan)
- [x] Applied schema migration (6 sniper_* tables + pg_cron + pg_net)
- [x] Deployed `sniper-inbound` Edge Function — v3 (Twilio + bulk-watch parser)
- [x] Deployed `sniper-poll` Edge Function — v3 (Twilio + shared-secret auth)
- [x] Deployed `sniper-health` Edge Function — v1 (env var verifier, public)
- [x] Scheduled pg_cron `sniper-poll-tick` — active, firing every minute
- [x] Verified cron fires (currently 500s on poll because env vars not set yet — clears the moment you paste them)

## What you still do — web app path, no Twilio needed

**Total: ~3 min. Phone OR laptop. No new accounts.**

1. **Set 3 secrets in Supabase** → https://supabase.com/dashboard/project/eskqbzoisyrvybxyjmln/settings/functions
   - `ANTHROPIC_API_KEY` = reuse your curaite key
   - `SNIPER_ENCRYPTION_KEY` = `28f32f62cbeaffe183021f9d11f4611423bd7a29b339b7ca190826c0aad0990e`
   - `SNIPER_WEBHOOK_SECRET` = `5e5a01f9dc59e641642bf9cf0e45f459ab0436f78e3adda60aa3b2bd3299dc04`

2. **Verify** — visit https://eskqbzoisyrvybxyjmln.supabase.co/functions/v1/sniper-health → should return `"ok": true`

3. **Bookmark the app URL on your home screen:**
   ```
   https://eskqbzoisyrvybxyjmln.supabase.co/functions/v1/sniper-app?key=5e5a01f9dc59e641642bf9cf0e45f459ab0436f78e3adda60aa3b2bd3299dc04
   ```
   Safari → Share → "Add to Home Screen" → icon appears like a native app.

4. **Use it.** Tap the icon → tap "send code" with your Resy phone → Resy texts YOU → type the code in → connected. Then type your watches into the text box. Bot does the rest.

Auto-book is on by default. The page polls every 30 sec and shows everything in the activity feed. Same URL works on laptop Safari, phone Safari, anywhere.
