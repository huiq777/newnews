# API Keys & Environment Variables

This document is the authoritative reference for every secret in the system. Before deploying anything, verify each key is in exactly the right location — not missing, not duplicated into an insecure location.

---

## Security Rules

1. **The Supabase service role key bypasses all RLS policies.** Any system that holds this key has full read/write access to the entire database. It must only ever exist in Cloudflare Workers secrets.
2. **The Supabase anon key is safe for the frontend.** It respects RLS policies — users can only read/write what the policies allow.
3. **No AI provider keys (Groq, Cohere) should ever reach the client.** They live in Cloudflare Workers secrets or Supabase Edge Function secrets only.

---

## Full Secrets Reference

| Variable | Where to Get It | Cloudflare Workers secrets | Supabase Edge Function Secrets | Expo Frontend Env |
|---|---|---|---|---|
| `SUPABASE_URL` | Supabase → Settings → API | Yes (all 3 workers) | No (use built-in Supabase client) | Yes (`EXPO_PUBLIC_SUPABASE_URL`) |
| `SUPABASE_ANON_KEY` | Supabase → Settings → API | No | No | Yes (`EXPO_PUBLIC_SUPABASE_ANON_KEY`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API | **Yes — all 3 workers. ONLY HERE.** | No | **Never** |
| `GROQ_API_KEY` | console.groq.com | Yes (`process-queue` worker) | Yes (`chat-live` + `chat-rag` functions) | **Never** |
| `COHERE_API_KEY` | dashboard.cohere.com | Yes (`embed-batch` worker) | Yes (`chat-rag` function) | **Never** |
| `X_BEARER_TOKEN` | developer.twitter.com → Your App → Keys and Tokens | Yes (`ingest-x` worker) | No | **Never** |

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

# From workers/embed-batch/:
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put COHERE_API_KEY

# From workers/ingest-x/:
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put X_BEARER_TOKEN
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
- `GROQ_API_KEY` (used by `chat-live` and `chat-rag`)
- `COHERE_API_KEY` (used by `chat-rag`)

These are accessible inside Edge Functions via `Deno.env.get('COHERE_API_KEY')`.

---

## Expo Frontend Environment Variables

Create a `.env.local` file at the root of the Expo project:

```
EXPO_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOi...
```

The `EXPO_PUBLIC_` prefix is required by Expo to make variables available in client-side code. Variables without this prefix are not accessible in the browser bundle.

For Vercel deployment, add these same two variables in: Vercel → Project → Settings → Environment Variables.

---

## What Happens If a Key Is in the Wrong Place

| Mistake | Consequence |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` in Expo env | Any user who opens DevTools can read all data in your database, bypassing RLS |
| `GROQ_API_KEY` in Expo env | Your Groq API quota is exposed to anyone who views your frontend bundle |
| `SUPABASE_ANON_KEY` missing from Expo env | Frontend cannot connect to Supabase — auth and data fetching both fail |
| `COHERE_API_KEY` missing from Worker secrets | `embed-batch` Worker fails silently — articles never get embeddings |
| `GROQ_API_KEY` missing from Edge Function secrets | `chat-live` and `chat-rag` cannot call Groq — both chatbots return 500 |
| `COHERE_API_KEY` missing from Edge Function secrets | `chat-rag` cannot generate query embeddings — chatbot returns 500 |

---

## Cost Reference

| Service | Free Tier | v1 Usage |
|---|---|---|
| Supabase | 500MB DB, 2M Edge Function calls/mo | <50MB, <10K calls |
| Cloudflare Workers | 100,000 requests/day | ~300/day |
| Groq | Free (rate-limited) | ~50–100 API calls/day |
| Cohere | 1,000 API calls/month | ~30 batch calls/month |
| Vercel | 100GB bandwidth | Minimal |

**Cohere free trial note:** The trial API key expires after 90 days. After expiry it becomes pay-as-you-go (~$0.0001/1K tokens — negligible at v1 scale, but no longer free). Set a calendar reminder.
