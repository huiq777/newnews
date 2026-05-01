# Trend Brief "How to Subscribe?" Manual — Design Plan

## Context
The trend brief is generated daily by the operator's `generate-trend-brief` Edge Function and pushed by the `send-digest` Cloudflare Worker at `30 0 * * *` to four globally-configured channel destinations: a Feishu group, a Slack workspace channel, a Discord server channel, and a Telegram chat. The webhook secrets live as Cloudflare Worker secrets — they are operator-side config, not per-user.

The user originally asked the manual to support two paths: **Path A** — the reader joins the operator's existing channel destination — and **Path B** — the reader adds the bot to a group they own. The Architectural Reality Check below shows that the current `send-digest` webhook architecture cannot support Path B for any channel today. **This spec scopes Path A only.** Path B is deferred to a separate, future spec.

The manual lives inside the trend brief area as a hovering modal: left rail = channel list, right pane = steps. Trigger: a "How to Subscribe?" text button placed next to the trend brief title (`趋势简报 · 4月26日` / `TREND BRIEF · Apr 26`).

## Architectural reality check
Path B is not free. The current `send-digest` worker uses incoming webhooks, which are bound at creation time to one specific channel/group. Adding the bot to a different user's group requires a different mechanism per provider:

| Channel | Path A (join existing) | Path B (add bot to own group) |
|---|---|---|
| Feishu | Operator shares group invite (no universal link in Feishu free tier — typically a QR or email-add) | Not possible. A "Custom Bot" webhook is group-bound; it cannot be added to other groups. Would require a real Feishu app with `im:message:send_as_bot` scope + per-user OAuth + per-group `chat_id` table. |
| Slack | Operator shares workspace invite link | Not possible with the current incoming webhook. Would require a real Slack App distributed via OAuth, multi-workspace install, and per-install token storage. |
| Discord | Server invite link (`discord.gg/xxx`) | Not possible with the current webhook. Would require a real Discord Bot (not a webhook), with `applications.commands` + bot scopes, OAuth invite URL, and per-guild send logic. |
| Telegram | If chat is a public channel/supergroup: `t.me/<username>`. Otherwise: invite link. | Possible with the existing bot token — the same `TELEGRAM_BOT_TOKEN` can be added to multiple chats. But `send-digest` today reads a single `TELEGRAM_CHAT_ID` secret. Supporting per-user chats requires (1) a `telegram_subscribers` table populated when users `/start` the bot, (2) a webhook endpoint that captures chat IDs, (3) fan-out in `send-digest` from one `chat_id` to N. Multi-week scope. |

**Honest framing for the manual:** Path A (join) works for all four channels today and is the entire scope of this spec. Path B (add bot) is not feasible with the current webhook architecture for any channel — it is deferred entirely and will require a separate spec when prioritized. No teaser, no placeholder UI.

Re-enabling Path B for Slack / Discord / Feishu specifically would be a multi-month re-architecture (real apps, OAuth, per-install tokens, RLS-protected subscriber tables, `send-digest` fan-out). Telegram is closer (the same bot token can join multiple chats), but still needs a `telegram_subscribers` table, a `/start` webhook handler, and fan-out logic. All deferred.

## Recommended approach

### 1. Frontend modal: `SubscriptionManualModal`
**File:** `news-app/components/SubscriptionManualModal.tsx` (new, ~280 lines)
**Trigger:** A persistent "How to Subscribe?" / "如何订阅?" `Pressable` that sits immediately to the right of the `趋势简报 · 4月26日` / `TREND BRIEF · Apr 26` title in `news-app/components/TrendBriefCard.tsx`. The title row renders in every card state (idle, loading, streaming, loaded, error), so anchoring the help button to the title — not to the primary CTA — guarantees it is always visible and discoverable.

**Style:** secondary button — same `Pressable` + hover treatment as `generateBtn` (`#d4d4d8` border, Space Grotesk 12px, 700 weight, letter-spacing 0.5), but compact (smaller padding to fit the title row) and `#71717a` text to read as secondary and not compete with the title.

```
[ TREND BRIEF · 4月26日 ]   [ How to Subscribe? ]   …   ↻   ▲

(below, regardless of state:)
[ ✦ Generate Trend Brief ]    or    [ ↻ View Trend Brief ]    or    streaming/loaded body
```

The title row is the persistent anchor; the body below transitions through states. The "How to Subscribe?" button lives in the title row alongside the age badge and right-side header controls — it does not move when the body changes.

**State:** `showSubscriptionManual` boolean lifted to `App.tsx`, mirroring how `lang` is plumbed today. Modal renders at the `App` root so it overlays the `FlatList` header card cleanly.

**Layout** (matches existing design language — Space Grotesk body, Manrope titles, off-white `#fafafa` rail, accent `#6e77e3`, no dark mode):

```
┌─ How to Subscribe ────────────────────────── ✕ ─┐
│ Feishu     ●  │  Step 1. Join the News Project   │
│ Slack         │  Slack workspace.                 │
│ Discord       │  [ Join Slack workspace → ]      │
│ Telegram      │                                   │
│               │  Step 2. Open the                 │
│               │  #ai-trend-brief channel.         │
│               │                                   │
│               │  Step 3. The brief arrives        │
│               │  automatically each morning.      │
└──────────────────────────────────────────────────┘
```

- **Left rail:** 4 channels stacked vertically, active row gets `borderLeftColor: #6e77e3` + tinted background, mirroring the `generateBtnHovered` aesthetic.
- **Right pane:** numbered steps only — no meta line, no language/time header. The primary CTA `Pressable` (`Linking.openURL(inviteUrl)`) is embedded inside whichever step it belongs to (typically Step 1).
- **Overlay:** absolutely-positioned `View` with `rgba(0,0,0,0.3)` backdrop, no `react-native` Modal (the codebase doesn't use it; staying inline matches house style and avoids native/web divergence).
- Backdrop / ✕ / Esc → close. Esc handler is web-only via `useEffect` + `typeof document !== 'undefined'` branch, matching the existing pattern in `App.tsx:47`.
- Bilingual via the existing inline-ternary i18n. Strings live in a `STRINGS` constant at the top of the component.

### 2. Invite URL config surface — DB-backed, redeploy-free
The risk being designed around: Feishu group invites typically expire (~7 days on free tier) or hit user-count caps. Slack workspace invites can also be revoked. If invite URLs were hardcoded in `news-app/lib/config.ts` or an `EXPO_PUBLIC_*` env var, every rotation would require a frontend rebuild and (for native) a store-review cycle. That is a hard no.

**Approach:** invite URLs live in a tiny new Supabase table, read anonymously at modal open. Operator updates rows in the Supabase dashboard; the change is live for every user instantly, no redeploy.

**Schema** (add to `supabase/sql/`):

```sql
create table public.channel_invites (
  channel       text primary key,                       -- 'feishu' | 'slack' | 'discord' | 'telegram'
  invite_url    text not null default '',               -- empty = channel hidden in UI
  language      text not null check (language in ('en','zh')),
  display_label text,                                   -- e.g. '#ai-trend-brief in News Project Slack'
  updated_at    timestamptz not null default now()
);

alter table public.channel_invites enable row level security;
create policy "anon_read_invites" on public.channel_invites
  for select to anon, authenticated using (true);
-- writes only via service role / dashboard; no anon write policy
```

Seed rows for the four channels with empty URLs so the operator just fills them in. Seed `language` per channel: `'zh'` for Feishu (matches `synthesis_zh` routing in send-digest), `'en'` for Slack / Discord / Telegram. Seed `display_label` only for Slack and Discord (e.g., `'#ai-trend-brief in News Project Slack'`); leave null for Feishu and Telegram.

**Both non-key columns are read by the modal:**

- `display_label` is interpolated into Step 2's step copy. The Step 2 string template becomes `Open the {display_label}.` When `display_label` is null, fall back to the generic `Open the trend-brief channel.` so the UI never crashes on a missing label.
- `language` (`'en' | 'zh'`) drives a small subdued badge in the **left rail** next to the channel name (e.g., `Feishu  ZH`, `Slack  EN`). It does **not** filter or hide channels — a Chinese reader may still want Slack, an English reader may still want Feishu — and it does **not** add a meta header to the right pane. The badge prevents the UX surprise of joining Slack expecting Chinese content or Feishu expecting English.

**Left-rail badge style:** small `LANG` pill at the right edge of each rail row (8px font, `#a1a1aa` text on transparent bg, no border, 4px horizontal padding). Mirrors the secondary-text feel of `briefAge` in `TrendBriefCard.tsx`.

**Frontend:**
- The modal calls `supabase.from('channel_invites').select('*')` lazily on first open, caches in state, hides any row whose `invite_url` is empty.
- No invite URL ships in the JS bundle. No rebuild required when invites rotate.

*Why a table, not a Cloudflare Workers redirect?* The project doesn't currently have its own apex domain configured for redirects, but it already has Supabase running, anon RLS already proven on other tables, and the frontend already imports the Supabase client. This piggybacks on infra that exists rather than introducing a new layer.

**Architectural review (this table):**
- **Goes through raw_ingestion?** No — config, not ingested content. Same exception class as sources.
- **RLS:** anon SELECT only, no anon INSERT/UPDATE/DELETE. Operator writes via Supabase dashboard or a one-off SQL migration.
- **Failure mode:** if the fetch fails (network, 429), the modal renders "Channel destinations unavailable — try again later." No silent data loss — purely UX.
- **Token cost:** zero LLM tokens. One small SELECT per modal open. Cache in component state for the session.

### 3. Per-channel right-pane content (concrete copy)
Drawn from the live state in `workers/send-digest/src/index.ts:43-96`. Steps only — no meta header.

| Channel | Steps |
|---|---|
| Feishu | 1. Open the Feishu group invite. 2. Accept the invite. 3. The brief arrives automatically each morning. |
| Slack | 1. Join the News Project Slack workspace. 2. Open the **{display_label}**. 3. The brief arrives automatically each morning. |
| Discord | 1. Join the News Project Discord server. 2. Find the **{display_label}**. 3. The brief arrives automatically each morning. |
| Telegram | 1. Open the Telegram channel. 2. Tap Join. 3. The brief arrives automatically each morning. |

`{display_label}` is interpolated from `channel_invites.display_label` for the active channel. When the column is null, Step 2 falls back to the generic `Open the trend-brief channel.` Feishu and Telegram do not have a "channel within workspace/server" concept, so their Step 2 already reads naturally without `display_label` and the fallback is never visible to users.

The CTA button (e.g. "Join Slack workspace →") is rendered inside Step 1, with its `href` resolved at fetch time from `channel_invites.invite_url`, not as a separate header element. Bilingual step copy lives in `STRINGS` at the top of the component; the destination URL never lives in the bundle.

### 4. What this design deliberately does NOT include
- No webhook input UI. Webhooks are operator-only secrets.
- No "test send" button. Out of scope for a help modal.
- No per-user channel preferences. Requires auth + a `user_channels` table + `send-digest` refactor — a separate, much larger spec.
- No Path B for any channel. Per-user fan-out is architecturally unsupported by the current webhook-based `send-digest`, and a "coming soon" teaser would commit us to multi-week backend work without a finalized spec. Ship only what works today.
- No invite URLs in the JS bundle. Volatile by nature (Feishu invites expire); read from the `channel_invites` table at modal open instead.
- No live "is this channel configured?" probe of webhook secrets. Frontend doesn't introspect worker secrets — secrets stay server-side. The presence of a non-empty `invite_url` in the table is the manual's only signal.

## Critical files

| File | Change |
|---|---|
| `news-app/components/SubscriptionManualModal.tsx` | NEW — modal component, fetches `channel_invites` lazily on first open, caches in state |
| `news-app/components/TrendBriefCard.tsx` | Add "How to Subscribe?" Pressable in the title row of all three state branches that render the card: `idle_cached` (line 367), `idle_ready` (line 394), and active/loaded/error (~line 421). Extract a small `HeaderRow` sub-component to avoid triplicating the JSX. New `onOpenManual` prop plumbed in from `App.tsx`. (Note: [line 345](../../news-app/components/TrendBriefCard.tsx#L345) returns null when `!hasArticles || briefState === 'idle'` — *either* condition. The transient `idle` state typically resolves to `idle_cached` or `idle_ready` within one tick, so the help button is briefly invisible at first mount, which is acceptable. The button cannot appear before articles load — also acceptable, since there is nothing to subscribe to yet.) |
| `news-app/App.tsx` | Add `showManual` state, render `<SubscriptionManualModal>` at root, wire prop into `TrendBriefCard` |
| `supabase/sql/<dated>_channel_invites.sql` | NEW — `channel_invites` table + anon-read RLS policy + four seed rows with empty `invite_url` |

No worker changes. No new secrets. No new cron triggers. No LLM tokens. One new tiny config table; one new public-read RLS policy on it.

## Reuse map
- **Modal overlay:** absolute View at App root with `rgba(0,0,0,0.3)` backdrop. Mirrors `App.tsx:47` web/native branching pattern.
- **Pressable + hover state:** copy `generateBtn` / `generateBtnHovered` from `TrendBriefCard.tsx`.
- **Color tokens:** `#fafafa`, `#e4e4e7`, `#18181b`, `#71717a`, `#6e77e3` — already used in `TrendBriefCard`.
- **External link launching:** `Linking.openURL()` from `react-native`, pattern from `ArticleCard.tsx:197` and `XThreadCard.tsx:171`.
- **i18n:** inline `lang === 'en' ? … : …`, no new library.
- **Inline icons:** `WebHTML.tsx` for any per-channel SVG glyphs.

## Architect Decision Framework review
- **New cron trigger?** No.
- **Daily Groq token cost?** Zero. Frontend only.
- **Subrequest budget?** N/A — frontend only.
- **New data through `raw_ingestion`?** N/A.
- **Failure mode of external dep?** Only external call is `Linking.openURL`. Cannot affect pipeline.
- **Token economy:** zero impact. **Pipeline integrity:** zero impact. **Seam quality:** clean — frontend stays read-only relative to worker secrets.

## Decisions log

- **2026-04-26** — Removed earlier-draft "Coming soon — add this bot to your own Telegram group" muted-text teaser from the Telegram pane. Architect rule: do not ship UI for features without a finalized backend spec and a committed implementation date. Per-user Telegram fan-out (subscriber table, `/start` webhook, fan-out loop) requires its own spec; deferred.
- **2026-04-26** — Rejected `news-app/lib/config.ts`-hardcoded invite URLs in favor of the `channel_invites` Supabase table. Reason: Feishu invites expire (~7 days, free tier) and Slack invites can be revoked; redeploy-per-rotation is unacceptable, especially for native bundles awaiting store review.
- **2026-04-26** — Anchored the "How to Subscribe?" trigger to the title row in all three render branches of `TrendBriefCard.tsx` (`idle_cached`, `idle_ready`, active/loaded/error) rather than to the primary CTA. Reason: the title row is the persistent header in every state; anchoring there makes the help button always discoverable in the same place.
- **2026-04-26** — Kept both `display_label` and `language` columns in `channel_invites` and wired both into the UI (Step 2 copy interpolation; left-rail `LANG` badge respectively). Earlier draft considered dropping one or both; the operator value of redeploy-free channel-name updates and the UX value of language disclosure both justified keeping them.

## Verification

1. `cd news-app && npx expo start --web` and wait for articles to load.
2. Idle state: confirm the title row reads `TREND BRIEF · 4月26日 [ How to Subscribe? ] … ↻ ▲`, with the "How to Subscribe?" button immediately right of the date title. Click it.
3. Modal opens with 4 channels in the left rail. Each row shows the channel name and a small `LANG` badge: `ZH` next to Feishu, `EN` next to Slack / Discord / Telegram. Feishu is preselected.
4. Close modal. Click "Generate Trend Brief". Once the brief loads, confirm the title row is unchanged — "How to Subscribe?" is still in the same position immediately right of the date title.
5. Click each channel in the rail → right pane updates with numbered steps only (no meta header).
6. For the Slack pane, Step 2 reads `Open the #ai-trend-brief in News Project Slack.` (interpolated from `display_label`). For Discord, Step 2 reads `Find the {display_label}.` similarly interpolated.
7. Click "Join Slack workspace →" embedded in Step 1 → external URL opens in new tab on web, system browser on iOS/Android.
8. Toggle EN/中 in NavBar → modal copy updates in place without re-opening. The `LANG` badges do **not** change (they reflect the channel's brief language, not the user's UI language).
9. Press Esc / click backdrop / click ✕ → modal closes.
10. In the Supabase dashboard, set `channel_invites.invite_url = ''` for the Discord row. Reopen the modal and confirm Discord is hidden from the rail (graceful degradation).
11. Update the same row's `invite_url` to a new value in the dashboard. Reopen the modal and confirm the new URL is used by the Step 1 CTA — **without** a frontend rebuild. This validates the redeploy-free promise.
12. Set `display_label = NULL` for the Slack row. Reopen → Step 2 falls back to `Open the trend-brief channel.` instead of erroring or showing literal `{display_label}`.
13. iOS simulator (`npx expo start --ios`) → modal renders; backdrop tap closes; deep links launch in browser/app.
14. End-to-end: with operator's real invite URLs in the table, click each channel's CTA from a fresh device, complete the join flow, and wait for tomorrow's `30 0 * * *` UTC delivery to confirm the brief lands.

---

## SWE implementation notes (architect addendum)

Two UX guards added after spec approval — no architectural change, but the SWE must implement them:

1. **Empty-state fallback when no channels are configured.** The current design hides any row with `invite_url = ''`. If the operator accidentally clears all four URLs, `filtered.length === 0` and the modal renders an empty left rail. Render a fallback inside the right pane (left rail empty) with bilingual copy:
   - EN: *"No channels are currently accepting invites. Check back soon, or message Hui."*
   - 中: *"目前没有可加入的频道。请稍后再试，或联系 Hui。"*
   Place this string in the same `STRINGS` constant as the rest of the modal copy.

2. **URL validation before `Linking.openURL()`.** `Linking.openURL()` rejects (web) or crashes (some native targets) when the URL lacks a scheme. Operators editing rows in the Supabase dashboard may paste a bare `news.project.feishu.cn/q/abc` without `https://`. Wrap the call:

   ```ts
   async function openInvite(url: string) {
     if (!url) return
     const safe = /^https?:\/\//i.test(url) ? url : `https://${url}`
     try {
       await Linking.openURL(safe)
     } catch {
       // Optional: surface a non-blocking toast / inline error in the step.
       // At minimum, swallow so the modal does not crash.
     }
   }
   ```

   Both behaviors are defensive — they exist because the operator-configured table is the single source of truth and a malformed row should degrade UX, not break the modal.

---

**Deliverable:** SWE implements per the above (including the addendum) in a separate session. Architect handoff complete on 2026-04-26; addendum 2026-04-26.
