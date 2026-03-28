# Phase 1.5 — X/Twitter & WeChat Ingestion

Phase 1 built a fully working news pipeline for English RSS feeds. Phase 1.5 extends it with two new source types that don't have standard RSS feeds:

- **Part A — X/Twitter**: Pull posts from specific accounts using the X API v2 free tier. A new Cloudflare Worker (`ingest-x`) handles this independently of `ingest-rss`.
- **Part B — WeChat 微信公众号**: Pull articles from WeChat Official Accounts via **WeWe RSS** (self-hosted, uses the WeChat Reading API). WeWe RSS generates a standard RSS feed that `ingest-rss` already knows how to consume. RSSHub's WeChat route was removed — WeWe RSS is the current solution.

**The two parts are fully independent.** Do Part A, Part B, or both — in any order. The downstream pipeline (`process-queue`, `embed-batch`, chatbots) works identically regardless of which source type an article came from.

**What's already done from the previous session:**
- `workers/ingest-x/` — full worker code written and ready to deploy
- `workers/ingest-rss/src/index.ts` — updated to filter by `source_type=eq.rss` (needs redeployment)
- `sources` table — needs the `source_type` column added via SQL (Step A1)

---

## Part A — X/Twitter via X API v2

### Step A0 — X Developer Account + Bearer Token

Go to **developer.twitter.com** and sign up for a free account. No credit card required.

Once inside the developer portal:
1. Click **"Create Project"** → give it any name (e.g., "news-ingest")
2. Inside the project, click **"Create App"** → give it any name
3. Go to your app → **"Keys and Tokens"** tab
4. Under **Bearer Token**, click **"Generate"** → copy it immediately (shown once)

> **⚠️ X API free tier is write-only (as of 2025).** Reading other users' timelines returns `402 CreditsDepleted`. Requires Basic plan ($100/mo) for user timeline reads. The `ingest-x` worker is correct and ready — upgrade when needed.
>
> **Disabled for now.** Run this SQL to stop the worker making failed API calls hourly:
> ```sql
> UPDATE sources SET is_active = false WHERE source_type = 'x_api';
> -- Re-enable later: UPDATE sources SET is_active = true WHERE source_type = 'x_api';
> ```

---

### Step A1 — SQL: Add `source_type` column + seed X accounts

Run this in **Supabase Dashboard → SQL Editor**:

```sql
-- Add source_type to distinguish RSS feeds from X API sources.
-- All existing rows default to 'rss' — no backfill needed.
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'rss';

-- Add Hacker News RSS while we're here
INSERT INTO sources (name, rss_url, source_type) VALUES
  ('Hacker News', 'https://news.ycombinator.com/rss', 'rss')
ON CONFLICT (rss_url) DO NOTHING;

-- Add X accounts to track.
-- rss_url stores the numeric X user ID in a private URI scheme.
-- The ingest-x worker reads source_type='x_api' rows and parses this field.
-- Find any user's numeric ID at: https://tweeterid.com/
INSERT INTO sources (name, rss_url, source_type) VALUES
  ('Elon Musk (@elonmusk)',   'x://user/44196397',    'x_api'),
  ('Sam Altman (@sama)',      'x://user/2312333412',   'x_api'),
  ('Paul Graham (@paulg)',    'x://user/209708',       'x_api')
ON CONFLICT (rss_url) DO NOTHING;
```

Replace or add any accounts you want. To find a numeric user ID: open tweeterid.com, paste the username, and copy the number shown.

**Verify in Supabase → Table Editor → sources:**
- You should see existing rows with `source_type = 'rss'` (populated by the DEFAULT)
- New X rows with `source_type = 'x_api'` and `rss_url` starting with `x://user/`

---

### Step A2 — Redeploy `ingest-rss` (source_type filter)

The `ingest-rss` worker was updated in the previous session to filter `source_type=eq.rss`, so it won't try to parse X account entries as RSS. This change needs to be deployed:

```bash
cd workers/ingest-rss
wrangler deploy
```

You should see output ending with `Deployed ingest-rss (triggers: 0 7 * * *)`.

**Why this matters:** Without this filter, `ingest-rss` would try to fetch `x://user/44196397` as an RSS URL and log an error for every X account row on every daily run. The filter ensures each worker only sees the source types it knows how to handle.

---

### Step A3 — Deploy `ingest-x` worker

The worker code is already written at `workers/ingest-x/src/index.ts`. Deploy it:

```bash
cd workers/ingest-x

# Install dependencies (first time only)
npm install

# Add secrets — you'll be prompted to paste each value
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put X_BEARER_TOKEN

# Deploy
wrangler deploy
```

**SUPABASE_URL** and **SUPABASE_SERVICE_ROLE_KEY** are the same values you used for `ingest-rss` and `process-queue` — copy from those workers' secrets if you don't have them handy:
```bash
# From workers/ingest-rss/:
wrangler secret list   # shows key names only (not values)
```
The actual values are in Supabase Dashboard → Settings → API.

**X_BEARER_TOKEN** is the token from Step A0.

After deploy, you should see:
```
Deployed ingest-x (triggers: 0 * * * *)
```
This means the worker runs at the top of every hour.

---

### Full `ingest-x` worker code (for reference)

`workers/ingest-x/src/index.ts`:

```typescript
export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  X_BEARER_TOKEN: string
}

const SB = (env: Env) => ({
  'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
  'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
})

export default {
  async fetch() { return new Response('ingest-x worker is running') },

  async scheduled(_event: ScheduledEvent, env: Env) {
    // 1. Get active X sources (source_type = 'x_api')
    const sourcesRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/sources?is_active=eq.true&source_type=eq.x_api&select=id,name,rss_url`,
      { headers: SB(env) }
    )
    const sources: { id: string; name: string; rss_url: string }[] = await sourcesRes.json()
    if (sources.length === 0) { console.log('No X sources configured.'); return }
    console.log(`Fetching tweets for ${sources.length} X accounts`)

    // 2. Fetch recent tweets for each account in parallel
    await Promise.all(sources.map(source => fetchAndIngest(source, env)))

    console.log('Done.')
  },
}

async function fetchAndIngest(
  source: { id: string; name: string; rss_url: string },
  env: Env
) {
  // rss_url stores the X user ID in format "x://user/<numeric_id>"
  const userIdMatch = source.rss_url.match(/^x:\/\/user\/(\d+)$/)
  if (!userIdMatch) {
    console.error(`Invalid rss_url format for X source "${source.name}": ${source.rss_url}`)
    return
  }
  const userId = userIdMatch[1]

  try {
    // X API v2 free tier: user timeline, last 10 tweets (excludes retweets + replies)
    const res = await fetch(
      `https://api.twitter.com/2/users/${userId}/tweets?max_results=10&tweet.fields=created_at,text&exclude=retweets,replies`,
      { headers: { 'Authorization': `Bearer ${env.X_BEARER_TOKEN}` } }
    )

    if (!res.ok) {
      const errText = await res.text()
      console.error(`X API error for user ${userId} (${source.name}): ${res.status} ${errText.substring(0, 200)}`)
      return
    }

    const data: any = await res.json()
    const tweets: { id: string; text: string }[] = data.data || []
    if (tweets.length === 0) { console.log(`No new tweets for ${source.name}`); return }

    // 3. Insert each tweet — duplicates silently skipped via ON CONFLICT
    await Promise.all(
      tweets.map(tweet => {
        const tweetUrl = `https://x.com/i/web/status/${tweet.id}`
        return fetch(`${env.SUPABASE_URL}/rest/v1/raw_ingestion`, {
          method: 'POST',
          headers: { ...SB(env), 'Prefer': 'resolution=ignore-duplicates' },
          body: JSON.stringify({
            source_id: source.id,
            url: tweetUrl,
            raw_content: tweet.text,
            status: 'pending',
          }),
        })
      })
    )
    console.log(`${source.name}: attempted ${tweets.length} tweet inserts`)
  } catch (e) {
    console.error(`Failed to fetch tweets for ${source.name}:`, e)
  }
}
```

> **How tweets flow through the rest of the pipeline:**
> `process-queue` picks up tweet rows from `raw_ingestion` exactly like article rows. Since `fetchPageTitle` already skips `x.com` domains (returns `null`), the title falls back to the first line of the tweet text. For short tweets (<300 chars), the text is used directly as the summary — no Groq call needed. For longer threads (unlikely but possible), Groq summarizes them normally.

---

### Step A4 — Verify

**Trigger the worker manually** (without waiting for the hourly cron):

```bash
cd workers/ingest-x
wrangler dev --remote --test-scheduled
# In another terminal:
curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"
```

> **`--remote` is required.** Without it, wrangler runs in a local sandbox that doesn't have access to your production secrets. You'll get authentication errors against Supabase and X API.

**Check `raw_ingestion` in Supabase → Table Editor:**
- You should see new rows with `url` like `https://x.com/i/web/status/1234567890`
- `raw_content` = the tweet text
- `status = 'pending'`

**Wait for or manually trigger `process-queue`** (from `workers/process-queue/`):
```bash
wrangler dev --remote --test-scheduled
curl "http://localhost:8788/__scheduled?cron=*/15+*+*+*+*"
```

**Check `daily_news`:** Tweets should appear with:
- `title` = first line of tweet text (stripped of leading bullet/dash)
- `summary` = full tweet text (or Groq summary if > 300 chars)
- `sources.name` = the account name you inserted (e.g., "Elon Musk (@elonmusk)")

**View live logs** for the deployed worker:
```bash
wrangler tail ingest-x
```

---

### Common Issues — Part A

| Problem | Cause | Fix |
|---|---|---|
| `403 Unauthorized` from X API | Bearer token invalid or app missing read permissions | Regenerate token in dev portal; check App Permissions = "Read" |
| `401 Unauthorized` | Wrong token format — must be Bearer, not OAuth | Confirm you're using the Bearer Token, not the API Key |
| `429 Too Many Requests` | Hit rate limit (1 request per 15 min per timeline) | Reduce tracked accounts or spread hourly cron calls |
| Worker logs `No X sources configured` | `source_type` column doesn't exist or rows missing | Run Step A1 SQL; check Table Editor |
| `rss_url` format error in logs | Inserted `rss_url` with wrong format | Must be exactly `x://user/<numeric_id>` — no spaces, no `@` |
| Tweets appear but with wrong titles | Groq summarizing a tweet | Tweets <300 chars bypass Groq — title = first line of tweet. If tweets are >300 chars (rare), Groq handles them normally |

---

## Part B — WeChat 微信公众号 via WeWe RSS

### Why WeWe RSS (not RSSHub)

RSSHub's `/wechat/mp/article/<biz>` route was removed — WeChat blocked direct scraping and RSSHub dropped the route entirely. The current best solution is **[WeWe RSS](https://github.com/cooderl/wewe-rss)** (6.5k+ stars), an open-source tool specifically built for WeChat Official Accounts. It routes through the WeChat Reading (微信读书) web API rather than scraping WeChat directly, which is far more stable.

Your RSSHub instance (`rsshub-xxxx.onrender.com`) is still running and useful for other platforms (Bilibili, Zhihu, etc.) — just not WeChat.

---

### Step B0 — Accounts needed

- **Render.com** (already have from RSSHub deploy) — free, no credit card
- **WeChat account** — you'll log in via QR code scan to authorize WeWe RSS to read your WeChat Reading library

---

### Step B1 — Deploy WeWe RSS to Render.com

1. Go to **Render Dashboard → New → Web Service**
2. Select **"Deploy an existing image from a registry"**
3. Enter image URL: `cooderl/wewe-rss:latest`
4. Name it (e.g., `wewe-rss`)
5. Select **Free** plan
6. Add these environment variables:

   | Key | Value |
   |---|---|
   | `AUTH_CODE` | Any password you choose — gates access to your WeWe RSS instance |
   | `SERVER_ORIGIN_URL` | The Render URL you'll get after deploy (add this after first deploy) |

7. Click **Deploy**

You'll get a URL like `https://wewe-rss-xxxx.onrender.com`. Add this as `SERVER_ORIGIN_URL` in Render environment variables, then redeploy.

---

### Step B2 — Authorize with WeChat

1. Open `https://wewe-rss-xxxx.onrender.com` in a browser
2. Enter your `AUTH_CODE` to log in
3. Go to **Accounts → Add Account**
4. A QR code appears — scan it with your **WeChat mobile app** (same as logging into WeChat Web)
5. After scanning, your WeChat account is linked

> **What this authorization does:** WeWe RSS uses the WeChat Reading (微信读书) API, which shares your WeChat login session. It reads your subscribed Official Accounts' article feeds through this API. WeChat Reading is an official WeChat product, so this is substantially more stable than scraping.

> **Limitation:** You can only get feeds for accounts you follow on WeChat. Follow the accounts you want in WeChat first, then they'll appear in WeWe RSS.

---

### Step B3 — Add WeChat accounts and get feed URLs

1. In WeWe RSS → **Feeds** (or equivalent menu) — you'll see all Official Accounts you follow
2. Click any account → copy its RSS feed URL

The URL format is:
```
https://wewe-rss-xxxx.onrender.com/feeds/<account_id>.xml?token=<AUTH_CODE>
```

**Test it in a browser** — you should see standard RSS XML with `<item>` elements containing article titles and links.

---

### Step B4 — Insert WeChat sources into the database

Run in **Supabase Dashboard → SQL Editor**, replacing the URLs with your actual WeWe RSS feed URLs:

```sql
INSERT INTO sources (name, rss_url, source_type) VALUES
  ('36氪',   'https://wewe-rss-xxxx.onrender.com/feeds/<id_for_36kr>.xml?token=yourcode', 'rss'),
  ('虎嗅',   'https://wewe-rss-xxxx.onrender.com/feeds/<id_for_huxiu>.xml?token=yourcode', 'rss'),
  ('人民日报', 'https://wewe-rss-xxxx.onrender.com/feeds/<id_for_rmrb>.xml?token=yourcode',  'rss')
ON CONFLICT (rss_url) DO NOTHING;
```

`source_type = 'rss'` — WeWe RSS outputs standard RSS, so `ingest-rss` handles these exactly like any other feed. No code changes needed.

> **Token in URL:** The `?token=` parameter is your `AUTH_CODE`. It's in the URL, not a header, which is why it works with `ingest-rss`'s plain `fetch()` call. This is fine for server-to-server calls (the token never reaches the frontend), but keep your `AUTH_CODE` out of version control.

---

### Step B5 — Verify

**Trigger `ingest-rss` manually:**

```bash
cd workers/ingest-rss
wrangler dev --remote --test-scheduled
# In another terminal:
curl "http://localhost:8787/__scheduled?cron=0+7+*+*+*"
```

**Check `raw_ingestion`** in Supabase → Table Editor:
- WeChat article rows have `url` starting with `https://mp.weixin.qq.com/s?...`
- `raw_content` = article content from the feed
- `status = 'pending'`

**After `process-queue` runs:**
- WeChat articles appear in `daily_news` with Groq-generated 3-bullet summaries
- `title` = real page title if `fetchPageTitle` succeeds (WeChat often returns a partial page with `<title>` tag accessible without login), otherwise Groq derives it from the summary

---

### Common Issues — Part B

| Problem | Cause | Fix |
|---|---|---|
| WeWe RSS QR code expired | QR codes expire in ~60 seconds | Refresh the page to get a new QR code |
| Feed URL returns 401 | Wrong or missing `?token=` in URL | Add `?token=yourAuthCode` to the URL |
| Feed is empty after login | You don't follow that account on WeChat | Follow the account in WeChat app first, then refresh WeWe RSS |
| Render cold start causes ingest-rss timeout | First request after 15+ min idle takes ~30s | Set up a free UptimeRobot monitor to ping your WeWe RSS URL every 5 minutes |
| Articles have no content, only titles | WeChat feeds sometimes only expose teasers | Groq will summarize whatever text is available; articles <300 chars are stored as-is |
| WeChat session expired | WeChat Reading tokens expire periodically | Re-scan QR code in WeWe RSS → Accounts to re-authorize |

---

## End-to-End Verification Checklist

### Part A — X/Twitter
- [ ] Bearer Token generated at developer.twitter.com
- [ ] `sources` table has `source_type` column (`ALTER TABLE` ran successfully)
- [ ] X account rows inserted with `source_type = 'x_api'` and `rss_url = 'x://user/<id>'`
- [ ] `ingest-rss` redeployed with `source_type=eq.rss` filter
- [ ] `ingest-x` deployed with all 3 secrets
- [ ] Manual trigger produces tweet rows in `raw_ingestion`
- [ ] `process-queue` processes tweets into `daily_news`
- [ ] `wrangler tail ingest-x` shows clean logs on next hourly run

### Part B — WeChat
- [ ] WeWe RSS deployed to Render.com (`cooderl/wewe-rss:latest`)
- [ ] WeChat account authorized via QR code scan
- [ ] Feed URLs tested in browser (return valid RSS XML)
- [ ] WeChat sources inserted into `sources` table with `source_type = 'rss'`
- [ ] `ingest-rss` manual trigger produces `mp.weixin.qq.com` rows in `raw_ingestion`
- [ ] WeChat articles processed into `daily_news` with valid titles and summaries

---

## What Comes Next

**Phase 2** — the full chatbot experience:
- `embed-batch` Cloudflare Worker: generates Cohere vector embeddings for all `daily_news` articles (including tweets and WeChat articles — they all flow through the same table)
- Two Supabase Edge Functions: `chat-live` (Groq Llama general assistant) and `chat-rag` (Groq DeepSeek reasoning over your news feed)
- Expo Router frontend with login, feed, and chat tabs

See `phase2-chatbots-current-task.md` for the full guide.
