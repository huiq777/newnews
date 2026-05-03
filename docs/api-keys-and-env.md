# API Keys & Environment Variables

This document is the authoritative reference for every secret in the system. Before deploying anything, verify each key is in exactly the right location — not missing, not duplicated into an insecure location.

---

## Security Rules

1. **The Supabase service role key bypasses all RLS policies.** Any system that holds this key has full read/write access to the entire database. It must only ever exist in Cloudflare Workers secrets or Supabase Vault (for use in pg_cron SQL — see `service_role_key` row below).
2. **The Supabase anon key is safe for the frontend.** It respects RLS policies — users can only read/write what the policies allow.
3. **No AI provider keys (Groq, Cohere) should ever reach the client.** They live in Cloudflare Workers secrets or Supabase Edge Function secrets only.

---

## Full Secrets Reference

| Variable | Where to Get It | Cloudflare Workers secrets | Supabase Edge Function Secrets | Expo Frontend Env |
|---|---|---|---|---|
| `SUPABASE_URL` | Supabase → Settings → API | Yes (all workers) | No (use built-in Supabase client) | Yes (`EXPO_PUBLIC_SUPABASE_URL`) |
| `SUPABASE_ANON_KEY` | Supabase → Settings → API | No | No | Yes (`EXPO_PUBLIC_SUPABASE_ANON_KEY`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API | **Yes — all workers. ONLY HERE.** | No | **Never** |
| `GROQ_API_KEY` | console.groq.com | Yes (`process-queue`, `ingest-builders`) | Yes (`answer-question`, `refresh-questions`) | **Never** |
| `OPENROUTER_API_KEY` | openrouter.ai → Keys | Yes (`process-queue`, `ingest-builders`) | No | **Never** |
| `OPENROUTER_MODEL` | n/a — you choose (e.g. `google/gemma-2-9b-it:free`) | Yes (`process-queue`) | No | **Never** |
| `OPENROUTER_BIO_MODEL` | n/a — you choose (e.g. `google/gemma-2-9b-it:free`) | Yes (`ingest-builders`) | No | **Never** |
| `COHERE_API_KEY` | dashboard.cohere.com | Yes (`embed-batch` worker) | Yes (`answer-question` function) | **Never** |
| `FEISHU_WEBHOOK_URL` | Feishu group → Settings → Bots → Add Bot → Custom Bot → copy Webhook URL | Yes (`send-digest` worker) | No | **Never** |
| `SLACK_WEBHOOK_URL` | Slack → app → Incoming Webhooks → New Webhook | Optional (`send-digest`) | No | **Never** |
| `DISCORD_WEBHOOK_URL` | Discord channel → Edit Channel → Integrations → Webhooks | Optional (`send-digest`) | No | **Never** |
| `TELEGRAM_BOT_TOKEN` | @BotFather on Telegram → `/newbot` → copy token | Optional (`send-digest`; paired with chat id) | No | **Never** |
| `TELEGRAM_CHAT_ID` | Send a message to your bot, then `GET https://api.telegram.org/bot<TOKEN>/getUpdates` → `result[].message.chat.id` | Optional (`send-digest`) | No | **Never** |
| `WECOM_WEBHOOK_URL` | WeCom group → 群机器人 → 添加机器人 → copy full webhook URL incl. `?key=` | Optional (`send-digest`) | No | **Never** |
| `NOTION_TOKEN` | notion.so/my-integrations → New integration (Internal) → "Insert content" + "Read content" → copy Internal Integration Secret | Optional (`send-digest`; paired with `NOTION_DATABASE_ID`) | No | **Never** |
| `NOTION_DATABASE_ID` | Open the target Notion database → URL contains `notion.so/<workspace>/<database-id>?v=...` → copy the database-id segment. **Must connect the integration to the database** (top-right `···` → `Connections` → `Add connections` → pick the integration) or POSTs return 404. After connecting, share the database with end users and tell them to **subscribe** (database top-right `···` → `Updates` → `Subscribe`) to get push notifications when each daily row lands. | Optional (`send-digest`) | No | **Never** |
| `CRON_SECRET` | Generate a random string; used to auth pg_cron → `generate-trend-brief` | No | Yes (`generate-trend-brief`) | **Never** |
| `service_role_key` (Vault) | Same value as `SUPABASE_SERVICE_ROLE_KEY`; stored via `select vault.create_secret('<jwt>', 'service_role_key', '...')` | No | No — lives in **Supabase Vault** only | **Never** |

---

## How to Set Cloudflare Workers Secrets

Secrets are set via the Wrangler CLI. You are prompted to paste the value — it is never written to any file.

```bash
# From the worker's directory (e.g., workers/ingest-rss/):
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY

# From workers/process-queue/:
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put GROQ_API_KEY
wrangler secret put OPENROUTER_API_KEY
wrangler secret put OPENROUTER_MODEL        # paste: google/gemma-2-9b-it:free (or any free model)

# From workers/embed-batch/:
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put COHERE_API_KEY

# From workers/ingest-builders/:
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put GROQ_API_KEY
wrangler secret put OPENROUTER_API_KEY
wrangler secret put OPENROUTER_BIO_MODEL    # paste: google/gemma-2-9b-it:free (or smaller)

# From workers/send-digest/:
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put FEISHU_WEBHOOK_URL         # optional
wrangler secret put SLACK_WEBHOOK_URL          # optional
wrangler secret put DISCORD_WEBHOOK_URL        # optional
wrangler secret put TELEGRAM_BOT_TOKEN         # optional (paired with TELEGRAM_CHAT_ID)
wrangler secret put TELEGRAM_CHAT_ID           # optional
wrangler secret put WECOM_WEBHOOK_URL          # optional — full https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...
wrangler secret put NOTION_TOKEN               # optional (paired with NOTION_DATABASE_ID)
wrangler secret put NOTION_DATABASE_ID         # optional
```

To verify secrets are set (values are hidden):
```bash
wrangler secret list
```

To update a secret (run the same command again — it overwrites):
```bash
wrangler secret put GROQ_API_KEY
```

---

## How to Set Supabase Edge Function Secrets

Go to: Supabase Dashboard → Edge Functions → Manage Secrets

Add:
- `GROQ_API_KEY` (used by `answer-question` and `refresh-questions`)
- `COHERE_API_KEY` (used by `answer-question` for query embedding)
- `CRON_SECRET` (used by `generate-trend-brief` to auth pg_cron-triggered runs)

These are accessible inside Edge Functions via `Deno.env.get('COHERE_API_KEY')`.

---

## Expo Frontend Environment Variables

Create a `.env.local` file at the root of the Expo project:

```
EXPO_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOi...
```

The `EXPO_PUBLIC_` prefix is required by Expo to make variables available in client-side code. Variables without this prefix are not accessible in the browser bundle.

For Cloudflare Pages deployment, add these same two variables in: Pages → Settings → Environment variables → Production. They are baked into the static bundle at build time — must be present before `npx expo export --platform web` runs.

---

## What Happens If a Key Is in the Wrong Place

| Mistake | Consequence |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` in Expo env | Any user who opens DevTools can read all data in your database, bypassing RLS |
| `GROQ_API_KEY` in Expo env | Your Groq API quota is exposed to anyone who views your frontend bundle |
| `SUPABASE_ANON_KEY` missing from Expo env | Frontend cannot connect to Supabase — auth and data fetching both fail |
| `COHERE_API_KEY` missing from Worker secrets | `embed-batch` Worker fails silently — articles never get embeddings |
| `GROQ_API_KEY` missing from Edge Function secrets | `answer-question` and `refresh-questions` cannot call Groq — both return 500 |
| `COHERE_API_KEY` missing from Edge Function secrets | `answer-question` cannot generate query embeddings — RAG returns 500 |

---

## Cost Reference

| Service | Free Tier | v1 Usage |
|---|---|---|
| Supabase | 500MB DB, 2M Edge Function calls/mo | <50MB, <10K calls |
| Cloudflare Workers | 100,000 requests/day | ~300/day |
| Groq | Free (rate-limited) | ~50–100 API calls/day (fallback only after OpenRouter migration) |
| OpenRouter | Free (free-tier models only — subject to rate limits) | Primary LLM for process-queue + ingest-builders |
| Cohere | 1,000 API calls/month | ~30 batch calls/month |
| Cloudflare Pages | Unlimited bandwidth | Static site hosting |

**Cohere free trial note:** The trial API key expires after 90 days. After expiry it becomes pay-as-you-go (~$0.0001/1K tokens — negligible at v1 scale, but no longer free). Set a calendar reminder.
