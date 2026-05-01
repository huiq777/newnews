# Multi-Channel Digest Upgrade: Diagnosis & Design (v3)

## 1. Diagnosis: Verification-First Procedure

The user reported that `send-digest` does not seem to work and only the previous `send-feishu-digest` is functioning.

**Verification Steps (Run these first):**
1. Confirm which digest workers are actually deployed on Cloudflare:
   ```bash
   npx wrangler deployments list --name send-digest
   npx wrangler deployments list --name send-feishu-digest
   ```
2. Check secret bindings on `send-digest`:
   ```bash
   npx wrangler secret list --name send-digest
   ```
3. Check Cloudflare dashboard logs for the `send-digest` 00:30 UTC window.

**Expected State & Fix:** 
`send-feishu-digest` and `send-digest` are distinct workers, not a Cloudflare-level rename. If `send-digest` is deployed but failing, the root cause is likely that secrets (e.g., `FEISHU_WEBHOOK_URL`) were never bound via `wrangler secret put` for the new worker.
If `send-digest` is correctly deployed and firing, local `workers/send-feishu-digest/` is dead code and should be deleted via `rm -rf`.

---

## 2. Refactored Scope: Trend-Brief Only Delivery

**The message for each delivery should only contain today's trend brief.**
- **Payload:** A single `trend_briefs` row (today, `step_days=1`). No article list, no per-article bullets.
- **Language Routing:** 
  - Feishu → `synthesis_zh`
  - Slack, Discord, Telegram → `synthesis_en`
  - **Null Target Rule:** If a channel's target language field (e.g., `synthesis_zh`) is `null`, skip delivery for *that channel only*.
- **Empty-Brief Behavior:** If today's `trend_briefs` row is entirely absent, skip delivery completely and log a `skipped_empty_brief` status. Do not send empty shells.
- **Notion Decision:** Dropped entirely. A daily trend-brief-only payload would create an endless stream of low-value, single-paragraph pages, generating massive clutter in the workspace.

---

## 3. Upstream Dependency: Pre-Warming the Brief

The digest now strictly depends on `trend_briefs` being populated.
- **Mechanism:** Add a `pg_cron` schedule in Supabase to trigger the `generate-trend-brief` Edge Function at **00:25 UTC** (5 minutes before `send-digest`).
- **Cron Slots:** `pg_cron` runs on Supabase, bypassing Cloudflare's 5-slot cap.
- **Anchor:** Both the pg_cron trigger and `send-digest` use `anchor_date = today_utc - 1` (the UTC day that just closed). At 00:25 UTC the current UTC date has effectively no content; anchoring on yesterday gives the brief a full 24h window. In US Eastern wall time, this maps to "8:30 PM EDT delivery covering ~last 24h ending at 8 PM EDT" during DST.
- **Staleness Check:** `send-digest` must query `trend_briefs` with `anchor_date = today_utc - 1` AND `generated_at >= today_utc_start`. The freshness gate ensures the row was written by tonight's 00:25 UTC pre-warm, not a day-old cached row from a prior failed run.

**Token Efficiency Budget (NFR §3 Check):**
- Daily automatic `generate-trend-brief` consumes ~15,000 tokens per run (two-pass clustering on ~30-50 articles + fallback chain). 
- Net TPD delta: +15,000 TPD to the automated baseline. This fits safely under the 100K daily cap alongside the `process-queue` self-throttling load.

---

## 4. Delivery Channels Review

### Telegram: APPROVED ✅
- **Why:** 100% free official HTTP Bot API.
- **Format Constraint:** Max 4096 chars per `sendMessage`. Chunk at paragraph boundaries to ≤ 3500 chars per chunk; send sequentially (await each chunk before the next so messages arrive in reading order).
- **Escape Contract (revised 2026-04-24, Phase 8):** Use `parse_mode: "HTML"`. The renderer:
  1. HTML-escapes the synthesis: `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`.
  2. Converts CommonMark `**X**` (the bolded verdict sentence emitted by `generate-trend-brief`) → `<b>X</b>`.
  3. Chunks at `\n\n` paragraph boundaries to ≤ 3500 chars.

  HTML mode replaces the prior MarkdownV2 escape regex contract because MarkdownV2 escapes `*` itself, which would render `**verdict**` as literal text instead of bold. HTML mode also avoids the 18-character escape table — `.`, `-`, `(`, `!`, etc. are passed through unchanged.

### Expo Push Notifications: DEFERRED TO COMPANION SPEC 🔄
- **Why:** Replaces iMessage as the Apple-native delivery path. However, adding token storage, user-identity registration flows (`Notifications.getExpoPushTokenAsync()`), and device unregistration pruning is too large for this single refactor.
- **Action:** Will be designed in a separate `2026-04-24-expo-push-registration-design.md` spec. Excluded from this SWE round.

### WhatsApp (CallMeBot): REJECTED ❌
- **Why:** Fails NFR privacy/TOS checks. CallMeBot is an unidentified third-party gateway handling plaintext payloads with no DPA, no fallback, and severe TOS ban risks for the receiver's phone number. WhatsApp is deferred pending a paid Twilio API upgrade decision.

---

## 5. Architectural Implementation Seams

### A. Idempotency Table (`digest_sent`) & Claim Semantics
To prevent duplicate sends on cron retries, we require strict idempotency.
- **Queue-First Exception:** Add `digest_sent` to the documented exceptions in `architect-role.md` alongside `user_tokens` and `trend_briefs` (reasoning: it handles delivery accounting, not ingested content).
- **Schema:** `digest_sent (channel, anchor_date, status, last_error)`
- **Claim Semantics:** Before sending, execute:
  ```sql
  INSERT INTO digest_sent (channel, anchor_date, status) 
  VALUES ('telegram', '2026-04-24', 'pending') 
  ON CONFLICT DO NOTHING RETURNING id;
  ```
  If no row is returned, abort (already sent/claimed).
- **Observability:** After webhook execution, `UPDATE digest_sent SET status = 'sent' | 'failed' | 'skipped_empty_brief', last_error = '...' WHERE id = returned_id`.

### B. Shared Render Seam (`renderBrief`)
- Create `workers/send-digest/src/render.ts`. 
- Export `renderBrief(channel, synthesis)` which handles per-channel truncation and escaping (e.g., applying the Telegram regex).

**Subrequest Recount (CF Limit: 50):**
1 (brief fetch) + 1 (batched idempotency claim) + 1 Feishu + 1 Slack + 1 Discord + up to 3 Telegram (chunks) + 1 bulk-mark-sent + up to 4 individual-mark-failed = **≤ 13/50 subrequests**. Safe.

---

## 6. Required Implementation (For the SWE)

1. Verify state using Section 1. Delete `send-feishu-digest` locally.
2. Bind `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `FEISHU_WEBHOOK_URL`, `SLACK_WEBHOOK_URL`, `DISCORD_WEBHOOK_URL` explicitly via `wrangler secret put` for the `send-digest` worker.
3. Update `architect-role.md` exceptions list with `digest_sent`.
4. Create the `digest_sent` table in Supabase.
5. Add `pg_cron` schedule for `generate-trend-brief` at `25 0 * * *`.
6. Refactor `send-digest`:
   - Drop `daily_news`, `sources` fetches, and Notion integration.
   - Implement `renderBrief()` seam.
   - Implement `INSERT ... ON CONFLICT DO NOTHING RETURNING` claim semantics.
   - Update `sendFeishu`, `sendSlack`, `sendDiscord` to trend-brief-only payloads.
   - Add `sendTelegram()` with HTML mode (`<b>` for bold), paragraph-aware chunking to ≤ 3500 chars per `sendMessage`, sequential sends to preserve order.
   - Update `digest_sent` status table post-send.

---

## 7. Verification / Test Plan (End-to-End)

Before closing the SWE session, execute:
1. **Pre-warm:** Manually invoke the `pg_cron` job for `generate-trend-brief` and confirm a row lands in `trend_briefs` for today.
2. **Delivery:** Trigger `send-digest` via `wrangler tail` + manual execution. Confirm Feishu receives a ZH brief and Telegram/Slack/Discord receive EN briefs.
3. **Idempotency:** Re-trigger `send-digest` in the same UTC day; confirm **no duplicate messages**.
4. **Empty-Brief Fallback:** Temporarily delete today's `trend_briefs` row; trigger `send-digest`; confirm **no messages sent** and a `skipped_empty_brief` row appears in `digest_sent`.
5. **Observability:** Query `digest_sent WHERE anchor_date > now() - interval '7 days'` and confirm per-channel statuses are logged accurately.
