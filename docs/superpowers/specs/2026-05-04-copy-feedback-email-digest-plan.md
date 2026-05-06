# Copy Icons + Trend Brief Feedback + Email Subscriber Digest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add copy buttons to trend brief and QA answers, add thumbs feedback to trend briefs, and enable email subscription for the digest.

**Architecture:** Three independent but related additions: (1) copy/feedback UI components wired to Supabase; (2) email subscriber table + unsubscribe edge function; (3) per-subscriber email delivery in send-digest worker. All UI follows existing `AnswerFeedback.tsx` style exactly.

**Tech Stack:** React Native (web-first), Supabase PostgREST, Deno edge functions, Cloudflare Workers, Resend API.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `supabase/sql/20260504_trend_brief_feedback.sql` | Create | Add `feedback`/`feedback_at` to `trend_briefs`; column-level GRANT |
| `supabase/sql/20260504_email_subscribers.sql` | Create | `email_subscribers` + `email_digest_sent` tables, RLS |
| `news-app/components/AnswerFeedback.tsx` | Modify | Add `copyText?` prop + copy button |
| `news-app/components/TrendBriefFeedback.tsx` | Create | `[👍][👎][copy]` row for trend briefs |
| `news-app/components/TrendBriefCard.tsx` | Modify | Store `briefId`+`initialFeedback`; render `TrendBriefFeedback` |
| `news-app/components/ArticleCard.tsx` | Modify | Pass `copyText={ans.content}` to `<AnswerFeedback />` |
| `news-app/components/XThreadCard.tsx` | Modify | Pass `copyText={ans.content}` to `<AnswerFeedback />` |
| `news-app/components/SubscriptionManualModal.tsx` | Modify | Add Email tab with lang toggle + subscribe flow |
| `supabase/functions/unsubscribe-email/index.ts` | Create | Sets `unsubscribed_at`; returns HTML confirmation |
| `workers/send-digest/src/index.ts` | Modify | Add `sendEmailDigests`, `buildEmailHtml`, `buildEmailSubject` |
| `workers/send-digest/wrangler.toml` | Modify | Declare `RESEND_API_KEY`, `RESEND_FROM`, `APP_URL` secrets |

---

## Task 1: SQL — feedback columns on trend_briefs

**Files:**
- Create: `supabase/sql/20260504_trend_brief_feedback.sql`

- [ ] **Step 1: Create migration file**

```sql
-- supabase/sql/20260504_trend_brief_feedback.sql
alter table trend_briefs
  add column if not exists feedback    smallint check (feedback in (-1, 1)),
  add column if not exists feedback_at timestamptz;

-- Column-level grant mirrors qa_logs pattern — prevents clients overwriting other columns.
grant update (feedback, feedback_at) on trend_briefs to anon, authenticated;
```

- [ ] **Step 2: Apply to Supabase**

Run in Supabase SQL editor or via CLI:
```bash
supabase db push  # or paste SQL directly in the Supabase dashboard SQL editor
```

Expected: no error. Verify with:
```sql
select column_name, data_type from information_schema.columns
where table_name = 'trend_briefs' and column_name in ('feedback', 'feedback_at');
```
Expected: 2 rows returned.

- [ ] **Step 3: Commit**

```bash
git add supabase/sql/20260504_trend_brief_feedback.sql
git commit -m "feat: add feedback/feedback_at columns to trend_briefs"
```

---

## Task 2: SQL — email_subscribers + email_digest_sent tables

**Files:**
- Create: `supabase/sql/20260504_email_subscribers.sql`

- [ ] **Step 1: Create migration file**

```sql
-- supabase/sql/20260504_email_subscribers.sql
create table email_subscribers (
  id              uuid        primary key default gen_random_uuid(),
  email           text        not null unique,
  lang            text        not null default 'en' check (lang in ('en', 'zh')),
  created_at      timestamptz not null default now(),
  unsubscribed_at timestamptz
);

alter table email_subscribers enable row level security;
create policy "anon can subscribe"
  on email_subscribers for insert to anon, authenticated
  with check (true);

create table email_digest_sent (
  id            uuid        primary key default gen_random_uuid(),
  subscriber_id uuid        not null references email_subscribers(id) on delete cascade,
  anchor_date   date        not null,
  step_days     integer     not null default 1,
  status        text        not null check (status in ('pending','sent','failed','skipped_empty_brief')),
  last_error    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (subscriber_id, anchor_date, step_days)
);

create index email_digest_sent_anchor_idx on email_digest_sent (anchor_date desc, subscriber_id);
```

- [ ] **Step 2: Apply to Supabase**

Run in Supabase SQL editor. Verify:
```sql
select table_name from information_schema.tables
where table_name in ('email_subscribers', 'email_digest_sent');
```
Expected: 2 rows.

- [ ] **Step 3: Commit**

```bash
git add supabase/sql/20260504_email_subscribers.sql
git commit -m "feat: add email_subscribers and email_digest_sent tables"
```

---

## Task 3: AnswerFeedback.tsx — add copy button

**Files:**
- Modify: `news-app/components/AnswerFeedback.tsx`

- [ ] **Step 1: Add SVG constants and update imports**

After the existing `DOWNVOTE_SVG` constant (line 21), add:

```typescript
const COPY_SVG = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
  <rect x="9" y="9" width="11" height="11" rx="2" stroke="#3D3D63" stroke-width="1.5"/>
  <path d="M5 15H4C2.89543 15 2 14.1046 2 13V4C2 2.89543 2.89543 2 4 2H13C14.1046 2 15 2.89543 15 4V5" stroke="#3D3D63" stroke-width="1.5" stroke-linecap="round"/>
</svg>`

const COPY_DONE_SVG = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
  <path d="M5 12l5 5L20 7" stroke="#16a34a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`
```

- [ ] **Step 2: Update prop type and add state**

Replace the props block:
```typescript
export default function AnswerFeedback({
  qaLogId,
  lang,
  onRefresh,
  initialFeedback = null,
}: {
  qaLogId: string
  lang: 'en' | 'zh'
  onRefresh?: () => void
  initialFeedback?: Feedback
  copyText?: string
}) {
```

Add new state after `hoverRefresh`:
```typescript
  const [copied, setCopied] = useState(false)
  const [hoverCopy, setHoverCopy] = useState(false)
```

- [ ] **Step 3: Add copy handler and button**

Add handler before `return`:
```typescript
  async function handleCopy() {
    if (!copyText) return
    await navigator.clipboard?.writeText(copyText)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
```

After the `{onRefresh && ...}` block (after line 120), before `{error && ...}`, add:
```typescript
      {copyText !== undefined && (
        <Pressable
          onPress={(e) => { e.stopPropagation?.(); void handleCopy() }}
          onHoverIn={() => setHoverCopy(true)}
          onHoverOut={() => setHoverCopy(false)}
          accessibilityLabel="Copy"
          style={[styles.btn, copied ? styles.btnCopied : (hoverCopy && styles.btnHovered)]}
        >
          <WebHTML
            html={copied ? COPY_DONE_SVG : `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><rect x="9" y="9" width="11" height="11" rx="2" stroke="#3D3D63" stroke-width="1.5"/><path d="M5 15H4C2.89543 15 2 14.1046 2 13V4C2 2.89543 2.89543 2 4 2H13C14.1046 2 15 2.89543 15 4V5" stroke="#3D3D63" stroke-width="1.5" stroke-linecap="round"/></svg>`}
            style={styles.svgWrapper}
          />
        </Pressable>
      )}
```

- [ ] **Step 4: Add btnCopied style**

In the `StyleSheet.create({...})` block, after `btnActive`:
```typescript
  btnCopied: {
    backgroundColor: '#F0FDF4',
    borderColor: '#16a34a',
  },
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd "news-app" && npx tsc --noEmit 2>&1 | grep -i "AnswerFeedback\|error" | head -20
```
Expected: no errors on AnswerFeedback.tsx.

- [ ] **Step 6: Commit**

```bash
git add news-app/components/AnswerFeedback.tsx
git commit -m "feat: add copy button to AnswerFeedback"
```

---

## Task 4: ArticleCard + XThreadCard — pass copyText

**Files:**
- Modify: `news-app/components/ArticleCard.tsx` (line ~317)
- Modify: `news-app/components/XThreadCard.tsx` (line ~293)

- [ ] **Step 1: Update ArticleCard.tsx**

Find the line (around line 317):
```typescript
<AnswerFeedback qaLogId={ans.qaLogId} initialFeedback={ans.feedback} lang={lang} onRefresh={() => { innerPressed.current = true; handleAsk(i, q, true) }} />
```

Replace with:
```typescript
<AnswerFeedback qaLogId={ans.qaLogId} initialFeedback={ans.feedback} lang={lang} onRefresh={() => { innerPressed.current = true; handleAsk(i, q, true) }} copyText={ans.content} />
```

- [ ] **Step 2: Update XThreadCard.tsx**

Find the line (around line 293):
```typescript
<AnswerFeedback qaLogId={ans.qaLogId} lang={lang} onRefresh={() => { innerPressed.current = true; handleAsk(i, q, true) }} />
```

Replace with:
```typescript
<AnswerFeedback qaLogId={ans.qaLogId} lang={lang} onRefresh={() => { innerPressed.current = true; handleAsk(i, q, true) }} copyText={ans.content} />
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd "news-app" && npx tsc --noEmit 2>&1 | grep -i "error" | head -10
```
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add news-app/components/ArticleCard.tsx news-app/components/XThreadCard.tsx
git commit -m "feat: pass copyText to AnswerFeedback in article and thread cards"
```

---

## Task 5: TrendBriefFeedback.tsx — new component

**Files:**
- Create: `news-app/components/TrendBriefFeedback.tsx`

- [ ] **Step 1: Create the file**

```typescript
// news-app/components/TrendBriefFeedback.tsx
// [👍][👎][copy] feedback row for trend briefs. Mirrors AnswerFeedback pattern.
// Writes to trend_briefs.feedback via column-level GRANT (20260504 migration).

import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { supabase } from '../lib/config'
import WebHTML from './WebHTML'

// Copied from AnswerFeedback.tsx — no import coupling, keep self-contained.
const UPVOTE_SVG = `<svg class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><path d="M192.170667 600.746667l126.805333 0 0 302.08-126.805333 0 0-302.08Z" fill="#F6716F"></path><path d="M192.170667 842.752v29.525333a30.549333 30.549333 0 0 0 30.549333 30.549334h65.877333a30.549333 30.549333 0 0 0 30.549334-30.549334v-29.525333z" fill="#F0504D"></path><path d="M130.730667 652.629333h61.610666v198.485334H130.730667zM727.722667 721.408h11.434666a45.397333 45.397333 0 0 0 0-90.624h-11.605333a45.568 45.568 0 0 0 45.568-45.226667 45.568 45.568 0 0 0-45.568-45.397333h-120.490667a44.885333 44.885333 0 0 0-32.768 14.165333 48.298667 48.298667 0 0 1-16.213333-46.250666 277.674667 277.674667 0 0 0 4.096-76.970667 86.528 86.528 0 0 0-93.696-78.677333 18.773333 18.773333 0 0 0-17.066667 20.309333l1.024 11.434667a245.077333 245.077333 0 0 1-36.352 151.04l-85.333333 112.298666a37.546667 37.546667 0 0 0-10.922667 26.453334V836.266667a37.205333 37.205333 0 0 0 18.602667 32.426666 245.418667 245.418667 0 0 0 124.416 34.133334h249.856a45.397333 45.397333 0 0 0 45.397333-45.397334 45.568 45.568 0 0 0-45.397333-45.397333h15.018667a45.397333 45.397333 0 0 0 0-90.624z" fill="#FFE3BA"></path><path d="M802.133333 212.48l17.066667 58.709333a13.141333 13.141333 0 0 0 8.192 8.533334l57.685333 19.456a12.8 12.8 0 0 1 2.389334 22.698666l-51.2 34.133334a12.970667 12.970667 0 0 0-5.632 10.581333v60.928a12.8 12.8 0 0 1-20.650667 9.898667l-47.957333-37.546667a12.458667 12.458667 0 0 0-11.605334-2.218667l-58.197333 18.261334a12.8 12.8 0 0 1-15.872-17.066667L697.514667 341.333333a12.629333 12.629333 0 0 0-1.706667-11.776l-35.328-49.152a12.8 12.8 0 0 1 10.922667-20.138666l60.928 2.218666a12.629333 12.629333 0 0 0 10.752-5.12l36.352-48.981333a12.8 12.8 0 0 1 22.698666 4.096z" fill="#FFB038"></path><path d="M890.026667 282.965333l-55.637334-18.773333-15.189333-56.32a29.866667 29.866667 0 0 0-52.736-9.557333l-34.133333 47.104-58.538667-2.218667A29.866667 29.866667 0 0 0 646.656 290.133333l34.133333 47.957334-20.309333 55.296a29.525333 29.525333 0 0 0 6.485333 30.72 29.184 29.184 0 0 0 30.549334 7.850666l55.978666-17.066666 46.250667 36.010666a30.037333 30.037333 0 0 0 12.970667 5.973334 28.330667 28.330667 0 0 0 18.261333-2.56 29.013333 29.013333 0 0 0 17.066667-26.453334v-58.709333l48.64-32.768a29.866667 29.866667 0 0 0-7.168-53.077333zM827.562667 341.333333a30.378667 30.378667 0 0 0-13.141334 24.405334v52.394666l-41.130666-32.256a29.354667 29.354667 0 0 0-13.141334-5.802666 28.672 28.672 0 0 0-14.165333 0.853333l-49.834667 15.530667 17.92-48.981334a30.549333 30.549333 0 0 0-3.754666-27.648l-30.378667-42.496 52.224 1.877334a29.525333 29.525333 0 0 0 25.088-12.117334l31.232-41.813333 13.653333 50.517333a30.378667 30.378667 0 0 0 19.114667 20.138667l49.493333 17.066667zM655.018667 168.277333a17.066667 17.066667 0 0 0 15.018666 8.704 17.066667 17.066667 0 0 0 8.192-2.048 17.066667 17.066667 0 0 0 6.656-23.210666L667.136 119.466667a17.066667 17.066667 0 0 0-29.866667 17.066666zM725.333333 153.6h1.024a17.066667 17.066667 0 0 0 17.066667-16.213333v-17.066667a17.066667 17.066667 0 0 0-34.133333-1.706667v17.066667A17.066667 17.066667 0 0 0 725.333333 153.6zM597.333333 202.410667l14.848 8.192a17.066667 17.066667 0 0 0 8.192 2.048 17.066667 17.066667 0 0 0 8.192-31.914667l-14.165333-8.192a17.066667 17.066667 0 1 0-17.066667 29.866667zM256 820.736a20.309333 20.309333 0 1 0 20.309333 20.309333A20.309333 20.309333 0 0 0 256 820.736z" fill="#3D3D63"></path><path d="M802.133333 676.693333a62.293333 62.293333 0 0 0-26.112-51.2 61.952 61.952 0 0 0-47.445333-102.4h-121.685333a60.416 60.416 0 0 0-29.184 7.68 32.085333 32.085333 0 0 1-2.901334-18.773333 291.669333 291.669333 0 0 0 4.266667-81.749333 103.594667 103.594667 0 0 0-112.128-94.208 35.84 35.84 0 0 0-32.597333 38.912l1.024 11.434666a227.498667 227.498667 0 0 1-33.109334 139.093334l-69.12 90.453333a47.445333 47.445333 0 0 0-44.544-31.573333h-65.877333A47.616 47.616 0 0 0 175.104 631.466667v4.266666h-44.373333a17.066667 17.066667 0 0 0 0 34.133334h44.373333v164.181333h-44.373333a17.066667 17.066667 0 1 0 0 34.133333h44.373333v4.266667a47.616 47.616 0 0 0 47.616 47.616h65.877333a47.786667 47.786667 0 0 0 45.226667-34.133333 263.68 263.68 0 0 0 128.341333 34.133333h250.709334a62.293333 62.293333 0 0 0 62.293333-62.293333 61.269333 61.269333 0 0 0-13.482667-38.570667 62.464 62.464 0 0 0 28.330667-51.2 61.610667 61.610667 0 0 0-14.677333-39.765333A62.805333 62.805333 0 0 0 802.133333 676.693333z m-499.370666 85.333334v109.738666a13.653333 13.653333 0 0 1-13.482667 13.482667h-66.56a13.482667 13.482667 0 0 1-13.482667-13.482667V631.466667a13.482667 13.482667 0 0 1 13.482667-13.482667h65.877333a13.653333 13.653333 0 0 1 13.482667 13.482667z m304.810666-204.8h121.002667a28.16 28.16 0 0 1 0 56.32h-121.685333a28.16 28.16 0 0 1 0-56.32zM566.442667 885.76h-104.277334a230.741333 230.741333 0 0 1-115.882666-31.402667 20.309333 20.309333 0 0 1-10.069334-17.066666v-163.328a20.309333 20.309333 0 0 1 5.973334-14.506667l1.536-1.706667 86.528-113.493333a261.632 261.632 0 0 0 39.082666-161.450667l-1.024-11.605333c0-0.853333 0-1.706667 1.536-1.877333a68.266667 68.266667 0 0 1 51.2 16.042666 68.266667 68.266667 0 0 1 24.576 47.104 257.365333 257.365333 0 0 1-3.754666 72.362667 64.341333 64.341333 0 0 0 11.605333 51.2 59.904 59.904 0 0 0-1.536 58.368 62.122667 62.122667 0 0 0-7.68 122.88 60.586667 60.586667 0 0 0-7.68 30.72 62.122667 62.122667 0 0 0 34.133333 55.125333 62.805333 62.805333 0 0 0-11.093333 35.328 60.416 60.416 0 0 0 6.826667 27.306667z m146.432 0h-91.306667a28.16 28.16 0 0 1 0-56.32h91.306667a28.16 28.16 0 0 1 0 56.32z m14.848-90.453333h-128.853334a28.16 28.16 0 0 1 0-56.32h128.853334a28.16 28.16 0 0 1 0 56.32z m11.434666-90.453334H556.885333a28.16 28.16 0 0 1 0-56.32h182.272a28.16 28.16 0 1 1 0 56.32z" fill="#3D3D63"></path></svg>`

const DOWNVOTE_SVG = `<svg class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><path d="M221.866667 695.296m-115.029334 0a115.029333 115.029333 0 1 0 230.058667 0 115.029333 115.029333 0 1 0-230.058667 0Z" fill="#D8E3F0"></path><path d="M756.224 770.048m-160.938667 0a160.938667 160.938667 0 1 0 321.877334 0 160.938667 160.938667 0 1 0-321.877334 0Z" fill="#EDF4FF"></path><path d="M178.858667 161.28l126.805333 0 0 302.08-126.805333 0 0-302.08Z" fill="#69BAF9"></path><path d="M178.858667 403.285333v29.525334a30.549333 30.549333 0 0 0 30.549333 30.378666h65.706667a30.549333 30.549333 0 0 0 30.549333-30.549333v-29.525333z" fill="#599ED4"></path><path d="M117.248 212.992h61.610667v198.485333H117.248zM737.621333 343.210667H715.093333a45.568 45.568 0 0 0 0-90.965334H699.733333a45.568 45.568 0 0 0 0-91.136H448.853333a247.637333 247.637333 0 0 0-124.586666 34.133334 37.546667 37.546667 0 0 0-18.602667 32.426666v162.645334a37.034667 37.034667 0 0 0 11.093333 26.624l85.333334 112.298666a243.541333 243.541333 0 0 1 36.522666 150.869334l-1.024 11.605333a18.602667 18.602667 0 0 0 17.066667 20.309333 86.528 86.528 0 0 0 93.696-78.677333l2.56-28.330667a113.834667 113.834667 0 0 0-4.778667-43.861333 26.794667 26.794667 0 0 1 25.088-35.84h143.872a45.568 45.568 0 0 0 0-91.136h22.528a45.056 45.056 0 0 0 44.544-45.397333 45.056 45.056 0 0 0-44.544-45.568z" fill="#FFE3BA"></path><path d="M845.141333 615.936a178.005333 178.005333 0 1 0 65.194667 243.2 178.005333 178.005333 0 0 0-65.194667-243.2z m35.669334 226.133333a143.872 143.872 0 1 1-52.736-196.608 144.042667 144.042667 0 0 1 52.736 196.608z" fill="#3D3D63"></path><path d="M686.762667 806.4a17.066667 17.066667 0 0 0-0.853334 34.133333 53.418667 53.418667 0 0 1 44.373334 25.770667 18.090667 18.090667 0 0 0 6.144 5.802667 17.066667 17.066667 0 0 0 23.04-23.722667 88.064 88.064 0 0 0-72.704-41.984zM749.056 686.08l-17.066667 4.437333-4.437333-17.066666a17.066667 17.066667 0 0 0-33.109333 8.874666L699.733333 699.733333l-17.066666 4.437334a17.066667 17.066667 0 1 0 8.874666 32.938666l17.066667-4.437333 4.437333 17.066667a17.066667 17.066667 0 0 0 33.109334-8.874667l-4.608-17.066667 17.066666-4.608a17.066667 17.066667 0 0 0 11.946667-20.821333 17.066667 17.066667 0 0 0-21.504-12.288zM853.333333 746.496L836.266667 750.933333l-4.437334-17.066666a17.066667 17.066667 0 1 0-32.938666 8.704l4.437333 17.066666-17.066667 4.437334a17.066667 17.066667 0 1 0 8.704 32.938666l17.066667-4.437333 4.437333 17.066667a17.066667 17.066667 0 1 0 32.938667-8.874667l-4.437333-17.066667 17.066666-4.437333a17.066667 17.066667 0 1 0-8.704-32.768zM242.176 202.752a20.309333 20.309333 0 1 0 20.309333 20.309333 20.309333 20.309333 0 0 0-20.309333-20.309333zM221.866667 563.2a132.096 132.096 0 1 0 132.266666 132.096A132.266667 132.266667 0 0 0 221.866667 563.2z m0 230.058667a97.962667 97.962667 0 1 1 98.133333-97.962667A98.133333 98.133333 0 0 1 221.866667 793.258667z" fill="#3D3D63"></path><path d="M269.482667 704l-24.064-14.506667 14.506666-23.893333a17.066667 17.066667 0 0 0-5.973333-23.381333 17.066667 17.066667 0 0 0-23.381333 5.802666l-14.506667 24.234667-24.064-14.506667a17.066667 17.066667 0 0 0-23.552 5.802667 17.066667 17.066667 0 0 0 5.973333 23.381333l24.064 14.506667-14.506666 24.234667a17.066667 17.066667 0 0 0 5.802666 23.381333 17.066667 17.066667 0 0 0 23.210667-5.973333l14.506667-24.234667 24.064 14.506667a17.066667 17.066667 0 0 0 17.066666-29.354667zM571.392 542.378667h142.677333a62.634667 62.634667 0 0 0 62.634667-62.634667 61.269333 61.269333 0 0 0-11.434667-36.010667 62.122667 62.122667 0 0 0 0-110.592 62.634667 62.634667 0 0 0-17.066666-88.234666A62.464 62.464 0 0 0 699.733333 144.042667H448.853333a264.362667 264.362667 0 0 0-128.512 34.133333 47.616 47.616 0 0 0-45.226666-34.133333h-65.877334a47.786667 47.786667 0 0 0-47.616 47.616v4.096h-44.373333a17.066667 17.066667 0 0 0 0 34.133333h44.373333v164.352h-44.373333a17.066667 17.066667 0 0 0 0 34.133333h44.544v4.266667a47.616 47.616 0 0 0 47.616 47.445333h65.706667a47.445333 47.445333 0 0 0 44.714666-31.573333l68.266667 89.258667a228.181333 228.181333 0 0 1 34.133333 140.288l-1.024 11.605333a36.010667 36.010667 0 0 0 32.597334 38.912h9.216a103.765333 103.765333 0 0 0 102.4-94.549333l2.389333-28.330667a126.634667 126.634667 0 0 0-5.802667-51.2A9.557333 9.557333 0 0 1 563.2 546.133333a9.386667 9.386667 0 0 1 8.192-3.754666z m-296.277333-96.256h-65.706667a13.312 13.312 0 0 1-13.482667-13.312V191.829333a13.482667 13.482667 0 0 1 13.482667-13.482666h65.877333a13.482667 13.482667 0 0 1 13.482667 13.482666v240.298667a13.482667 13.482667 0 0 1-13.653333 13.994667z m260.437333 80.725333a43.861333 43.861333 0 0 0-5.461333 39.594667 95.402667 95.402667 0 0 1 4.096 36.693333L531.797333 631.466667a69.632 69.632 0 0 1-24.576 47.274666 68.266667 68.266667 0 0 1-51.2 15.872 1.706667 1.706667 0 0 1-1.706666-1.877333l1.024-11.434667a263.168 263.168 0 0 0-39.765334-162.816l-85.333333-112.298666-1.536-1.706667a20.650667 20.650667 0 0 1-5.973333-14.506667v-162.645333a20.992 20.992 0 0 1 10.069333-17.066667 230.741333 230.741333 0 0 1 116.053333-31.232H699.733333a28.501333 28.501333 0 0 1 0 57.002667h-43.349333a17.066667 17.066667 0 0 0-17.066667 17.066667 17.066667 17.066667 0 0 0 17.066667 17.066666h58.709333a28.501333 28.501333 0 0 1 0 56.832h-65.194666a17.066667 17.066667 0 0 0 0 34.133334h86.698666a28.501333 28.501333 0 1 1 0 56.832H658.773333a17.066667 17.066667 0 0 0 0 34.133333h55.296a28.501333 28.501333 0 0 1 0 57.002667h-142.677333a44.032 44.032 0 0 0-35.84 17.749333z" fill="#3D3D63"></path></svg>`

const COPY_SVG = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><rect x="9" y="9" width="11" height="11" rx="2" stroke="#3D3D63" stroke-width="1.5"/><path d="M5 15H4C2.89543 15 2 14.1046 2 13V4C2 2.89543 2.89543 2 4 2H13C14.1046 2 15 2.89543 15 4V5" stroke="#3D3D63" stroke-width="1.5" stroke-linecap="round"/></svg>`

const COPY_DONE_SVG = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><path d="M5 12l5 5L20 7" stroke="#16a34a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`

const getIconHtml = (svg: string, active: boolean, hovered: boolean) =>
  svg.replace('<svg ', `<svg style="transition: all 0.2s ease; ${(active || hovered) ? '' : 'filter: grayscale(100%) opacity(60%);'}" `)

type Feedback = -1 | 0 | 1 | null

const STRINGS = {
  en: { helpful: 'Good brief', notHelpful: 'Poor brief', error: 'Could not save — try again' },
  zh: { helpful: '摘要不错', notHelpful: '摘要较差', error: '保存失败，请重试' },
}

export default function TrendBriefFeedback({
  briefId,
  synthesis,
  lang,
  initialFeedback = null,
}: {
  briefId: string
  synthesis: string
  lang: 'en' | 'zh'
  initialFeedback?: -1 | 0 | 1 | null
}) {
  const [feedback, setFeedback] = useState<Feedback>(initialFeedback)
  const [error, setError] = useState(false)
  const [hoverUp, setHoverUp] = useState(false)
  const [hoverDown, setHoverDown] = useState(false)
  const [copied, setCopied] = useState(false)
  const [hoverCopy, setHoverCopy] = useState(false)
  const t = STRINGS[lang]

  async function vote(next: Feedback) {
    const target: Feedback = feedback === next ? null : next
    const previous = feedback
    setFeedback(target)
    setError(false)

    const { data, error: err } = await supabase
      .from('trend_briefs')
      .update({
        feedback: target,
        feedback_at: target === null ? null : new Date().toISOString(),
      })
      .eq('id', briefId)
      .select('id')

    if (err || !data || data.length === 0) {
      console.error('[TrendBriefFeedback] PATCH failed:', err?.message ?? 'no rows updated (RLS row-scope or stale briefId)')
      setFeedback(previous)
      setError(true)
    }
  }

  async function handleCopy() {
    await navigator.clipboard?.writeText(synthesis)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const upActive = feedback === 1
  const downActive = feedback === -1

  return (
    <View style={styles.row}>
      <Pressable
        onPress={(e) => { e.stopPropagation?.(); void vote(1) }}
        onHoverIn={() => setHoverUp(true)}
        onHoverOut={() => setHoverUp(false)}
        accessibilityLabel={t.helpful}
        style={[styles.btn, upActive ? styles.btnActive : (hoverUp && styles.btnHovered)]}
      >
        <WebHTML html={getIconHtml(UPVOTE_SVG, upActive, hoverUp)} style={styles.svgWrapper} />
      </Pressable>
      <Pressable
        onPress={(e) => { e.stopPropagation?.(); void vote(-1) }}
        onHoverIn={() => setHoverDown(true)}
        onHoverOut={() => setHoverDown(false)}
        accessibilityLabel={t.notHelpful}
        style={[styles.btn, downActive ? styles.btnActive : (hoverDown && styles.btnHovered)]}
      >
        <WebHTML html={getIconHtml(DOWNVOTE_SVG, downActive, hoverDown)} style={styles.svgWrapper} />
      </Pressable>
      <Pressable
        onPress={(e) => { e.stopPropagation?.(); void handleCopy() }}
        onHoverIn={() => setHoverCopy(true)}
        onHoverOut={() => setHoverCopy(false)}
        accessibilityLabel="Copy"
        style={[styles.btn, copied ? styles.btnCopied : (hoverCopy && styles.btnHovered)]}
      >
        <WebHTML html={copied ? COPY_DONE_SVG : COPY_SVG} style={styles.svgWrapper} />
      </Pressable>
      {error && <Text style={styles.errorText}>{t.error}</Text>}
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
    marginBottom: 4,
  },
  btn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#E0DDD6',
  },
  btnHovered: {
    backgroundColor: '#FAF9F7',
    borderColor: '#C8C4BE',
  },
  btnActive: {
    backgroundColor: '#FAF9F7',
    borderColor: '#1A1A1A',
  },
  btnCopied: {
    backgroundColor: '#F0FDF4',
    borderColor: '#16a34a',
  },
  svgWrapper: {
    width: 20,
    height: 20,
  },
  errorText: {
    fontSize: 11,
    color: '#b91c1c',
    fontFamily: 'Manrope, sans-serif',
    marginLeft: 4,
  },
})
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd "news-app" && npx tsc --noEmit 2>&1 | grep -i "TrendBriefFeedback\|error" | head -20
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add news-app/components/TrendBriefFeedback.tsx
git commit -m "feat: create TrendBriefFeedback component with thumbs and copy"
```

---

## Task 6: TrendBriefCard.tsx — wire briefId and render feedback row

**Files:**
- Modify: `news-app/components/TrendBriefCard.tsx`

- [ ] **Step 1: Add TrendBriefFeedback import**

At the top of the file, after the existing imports, add:
```typescript
import TrendBriefFeedback from './TrendBriefFeedback'
```

- [ ] **Step 2: Extend CachedBriefRow type and state**

Find `CachedBriefRow` type (line ~41):
```typescript
type CachedBriefRow = {
  synthesis_en: string | null
  synthesis_zh: string | null
  sources_json: BriefSource[]
  generated_at: string
}
```

Replace with:
```typescript
type CachedBriefRow = {
  id: string
  synthesis_en: string | null
  synthesis_zh: string | null
  sources_json: BriefSource[]
  generated_at: string
  feedback: -1 | 1 | null
}
```

- [ ] **Step 3: Add briefId and initialFeedback state**

After `const [cachedRow, setCachedRow] = useState<CachedBriefRow | null>(null)` (line ~69), add:
```typescript
  const [briefId, setBriefId] = useState<string | null>(null)
  const [initialFeedback, setInitialFeedback] = useState<-1 | 1 | null>(null)
```

- [ ] **Step 4: Update fetchFullBriefRow select**

Find the `fetchFullBriefRow` function (line ~240). Update the select param:

Change:
```typescript
        `&select=synthesis_en,synthesis_zh,sources_json,generated_at` +
```
To:
```typescript
        `&select=id,synthesis_en,synthesis_zh,sources_json,generated_at,feedback` +
```

- [ ] **Step 5: Populate briefId/initialFeedback when cachedRow loads**

There are two places where `setCachedRow(row)` is called after a `fetchFullBriefRow` result. Update both.

**In `generate()` function** (around line 181):
```typescript
void fetchFullBriefRow(anchorDate, ctrl.signal).then(row => {
  if (row) {
    setCachedRow(row)
    setBriefId(row.id)
    setInitialFeedback(row.feedback ?? null)
  }
})
```
(There are two such calls in `generate()` — both inside the `[DONE]` handler at lines ~180 and ~191. Update both.)

**In `showCached()` function** (around line 228):
```typescript
    setCachedRow(row)
    setSynthesis(text)
    setSourcesJson(row.sources_json ?? [])
    setGeneratedAt(row.generated_at)
    setBriefId(row.id)
    setInitialFeedback(row.feedback ?? null)
    setBriefState('loaded')
```

- [ ] **Step 6: Clear briefId/initialFeedback on window change**

In the useEffect that clears state on window/articles change (around line 262, where `setCachedRow(null)` is called), also add:
```typescript
    setBriefId(null)
    setInitialFeedback(null)
```

- [ ] **Step 7: Render TrendBriefFeedback after sources**

Find the sources section (around line 582):
```tsx
        </View>
      )}
    </View>
  )}
</View>
```

The structure is roughly:
```tsx
          {/* Sources */}
          {sourcesJson.length > 0 && (...)}
        </View>   {/* closes cardExpanded View */}
      )}
    </View>  {/* closes briefCard */}
```

After the closing `</View>` of the sources block and before the closing `</View>` of the cardExpanded block, add:

```tsx
          {synthesis.length > 0 && briefState === 'loaded' && briefId && (
            <TrendBriefFeedback
              briefId={briefId}
              synthesis={synthesis}
              lang={lang}
              initialFeedback={initialFeedback}
            />
          )}
```

- [ ] **Step 8: Verify TypeScript compiles**

```bash
cd "news-app" && npx tsc --noEmit 2>&1 | grep -i "TrendBriefCard\|error" | head -20
```
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add news-app/components/TrendBriefCard.tsx
git commit -m "feat: wire briefId and render TrendBriefFeedback in TrendBriefCard"
```

---

## Task 7: SubscriptionManualModal.tsx — add Email tab

**Files:**
- Modify: `news-app/components/SubscriptionManualModal.tsx`

- [ ] **Step 1: Add email to active state type**

The component uses `active: Channel | null` state. Change it to accommodate `'email'` as a special non-DB channel:

Find:
```typescript
type Channel = 'feishu' | 'slack' | 'discord' | 'telegram' | 'notion'
```
Replace with:
```typescript
type Channel = 'feishu' | 'slack' | 'discord' | 'telegram' | 'notion'
type ActivePane = Channel | 'email'
```

Find:
```typescript
  const [active, setActive] = useState<Channel | null>(null)
```
Replace with:
```typescript
  const [active, setActive] = useState<ActivePane | null>(null)
```

- [ ] **Step 2: Add email icon to CHANNEL_ICONS**

After the `notion` entry in `CHANNEL_ICONS`, add (as a separate constant since email is not a `Channel`):

At the top of the component after `CHANNEL_ICONS`, add:
```typescript
const EMAIL_ICON = (color: string) =>
  `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="14" height="14" style="display:block"><rect x="2" y="4" width="20" height="16" rx="2" stroke="${color}" stroke-width="1.5"/><path d="M2 7l10 7 10-7" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/></svg>`
```

- [ ] **Step 3: No STRINGS changes needed**

Email uses a standalone `EmailPane` component (not the `steps`/`cta` pattern). "Email" is hardcoded in the rail — no string lookup needed.

- [ ] **Step 4: Add `TextInput` to the react-native import and add EmailPane component**

First, find:
```typescript
import { Image, Linking, Pressable, StyleSheet, Text, View } from 'react-native'
```
Replace with:
```typescript
import { Image, Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
```

Then, before the `ChannelSteps` function, add the `EmailPane` component and its styles:

```typescript
function EmailPane({
  lang,
  hovered,
  setHovered,
}: {
  lang: 'en' | 'zh'
  hovered: string | null
  setHovered: (h: string | null) => void
}) {
  // supabase is already imported at the top of this file
  const [emailLang, setEmailLang] = useState<'en' | 'zh'>(lang)
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'duplicate' | 'error'>('idle')
  const ctaKey = 'email-cta'
  const ctaHovered = hovered === ctaKey

  const S = {
    en: {
      heading: 'Get the trend brief in your inbox',
      placeholder: 'your@email.com',
      cta: 'Subscribe →',
      success: (e: string) => `Subscribed! Next brief goes to ${e}`,
      duplicate: 'Already subscribed.',
      error: 'Something went wrong — try again.',
      fine: 'Unsubscribe any time.',
    },
    zh: {
      heading: '将趋势摘要发送到你的邮箱',
      placeholder: '你的邮箱地址',
      cta: '订阅 →',
      success: (e: string) => `订阅成功！下一封摘要将发送至 ${e}`,
      duplicate: '该邮箱已订阅。',
      error: '出错了，请重试。',
      fine: '随时可退订。',
    },
  }
  const t = S[lang]

  async function handleSubscribe() {
    const trimmed = email.trim().toLowerCase()
    if (!trimmed || !trimmed.includes('@')) return
    setStatus('loading')
    const { error } = await supabase
      .from('email_subscribers')
      .insert({ email: trimmed, lang: emailLang })
    if (!error) {
      setStatus('success')
    } else if (error.code === '23505') {
      setStatus('duplicate')
    } else {
      setStatus('error')
    }
  }

  return (
    <View style={{ gap: 14 }}>
      <Text style={emailStyles.heading}>{t.heading}</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {(['en', 'zh'] as const).map(l => (
          <Pressable
            key={l}
            onPress={() => setEmailLang(l)}
            style={[emailStyles.langBtn, emailLang === l && emailStyles.langBtnActive]}
          >
            <Text style={[emailStyles.langBtnText, emailLang === l && emailStyles.langBtnTextActive]}>
              {l === 'en' ? 'English' : '中文'}
            </Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        value={email}
        onChangeText={setEmail}
        placeholder={t.placeholder}
        keyboardType="email-address"
        autoCapitalize="none"
        style={emailStyles.input}
        editable={status !== 'loading' && status !== 'success'}
      />
      {status === 'success' ? (
        <Text style={emailStyles.successText}>{t.success(email.trim().toLowerCase())}</Text>
      ) : (
        <Pressable
          onPress={() => { void handleSubscribe() }}
          onHoverIn={() => setHovered(ctaKey)}
          onHoverOut={() => setHovered(null)}
          style={[emailStyles.cta, ctaHovered && emailStyles.ctaHovered, status === 'loading' && emailStyles.ctaDisabled]}
          disabled={status === 'loading'}
        >
          <Text style={emailStyles.ctaText}>{status === 'loading' ? '…' : t.cta}</Text>
        </Pressable>
      )}
      {status === 'duplicate' && <Text style={emailStyles.mutedText}>{t.duplicate}</Text>}
      {status === 'error' && <Text style={emailStyles.errorText}>{t.error}</Text>}
      <Text style={emailStyles.fineText}>{t.fine}</Text>
    </View>
  )
}

const emailStyles = StyleSheet.create({
  heading: { fontSize: 13, fontWeight: '600', color: '#27272a', fontFamily: 'Space Grotesk, sans-serif' },
  langBtn: {
    paddingHorizontal: 12, paddingVertical: 5,
    borderRadius: 16, borderWidth: 1, borderColor: '#d4d4d8',
    backgroundColor: '#fff',
  },
  langBtnActive: { borderColor: '#18181b', backgroundColor: '#18181b' },
  langBtnText: { fontSize: 12, color: '#71717a', fontFamily: 'Space Grotesk, sans-serif' },
  langBtnTextActive: { color: '#fff' },
  input: {
    borderWidth: 1, borderColor: '#d4d4d8', borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 8,
    fontSize: 13, color: '#27272a', fontFamily: 'Space Grotesk, sans-serif',
    backgroundColor: '#fff',
  },
  cta: {
    borderWidth: 1, borderColor: '#d4d4d8', borderRadius: 8,
    paddingVertical: 7, paddingHorizontal: 14,
    backgroundColor: '#18181b', alignSelf: 'flex-start',
  },
  ctaHovered: { backgroundColor: '#27272a' },
  ctaDisabled: { opacity: 0.5 },
  ctaText: { fontSize: 12, fontWeight: '700', color: '#fff', fontFamily: 'Space Grotesk, sans-serif' },
  successText: { fontSize: 12, color: '#16a34a', fontFamily: 'Space Grotesk, sans-serif' },
  mutedText: { fontSize: 12, color: '#71717a', fontFamily: 'Space Grotesk, sans-serif' },
  errorText: { fontSize: 11, color: '#b91c1c', fontFamily: 'Space Grotesk, sans-serif' },
  fineText: { fontSize: 11, color: '#a1a1aa', fontFamily: 'Space Grotesk, sans-serif' },
})
```

- [ ] **Step 5: Add email rail row in the left rail**

In the modal's left rail JSX, after the `{visibleInvites.map(...)}` block and before the closing `</View>` of the rail, add:

```tsx
            {/* Email — hardcoded, not from DB */}
            {(() => {
              const isActive = active === 'email'
              const rowKey = 'rail-email'
              const isHovered = hovered === rowKey
              return (
                <Pressable
                  onPress={() => setActive('email')}
                  onHoverIn={() => setHovered(rowKey)}
                  onHoverOut={() => setHovered(null)}
                  style={[
                    styles.railRow,
                    isHovered && !isActive && styles.railRowHovered,
                    isActive && styles.railRowActive,
                  ]}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <WebHTML html={EMAIL_ICON(isActive ? '#18181b' : '#3f3f46')} />
                    <Text style={[styles.railLabel, isActive && styles.railLabelActive]}>Email</Text>
                  </View>
                </Pressable>
              )
            })()}
```

- [ ] **Step 6: Render EmailPane in the right pane**

Find the right pane JSX (around line 231):
```tsx
          {/* Right pane */}
          <View style={styles.pane}>
            {activeInvite ? (
              <ChannelSteps
                key={activeInvite.channel}
                invite={activeInvite}
                lang={lang}
                hovered={hovered}
                setHovered={setHovered}
              />
            ) : (
              <Text style={styles.muted}>—</Text>
            )}
          </View>
```

Replace with:
```tsx
          {/* Right pane */}
          <View style={styles.pane}>
            {active === 'email' ? (
              <EmailPane lang={lang} hovered={hovered} setHovered={setHovered} />
            ) : activeInvite ? (
              <ChannelSteps
                key={activeInvite.channel}
                invite={activeInvite}
                lang={lang}
                hovered={hovered}
                setHovered={setHovered}
              />
            ) : (
              <Text style={styles.muted}>—</Text>
            )}
          </View>
```

- [ ] **Step 7: Verify TypeScript compiles**

```bash
cd "news-app" && npx tsc --noEmit 2>&1 | grep -i "SubscriptionManual\|error" | head -20
```
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add news-app/components/SubscriptionManualModal.tsx
git commit -m "feat: add email subscription tab to SubscriptionManualModal"
```

---

## Task 8: unsubscribe-email Edge Function

**Files:**
- Create: `supabase/functions/unsubscribe-email/index.ts`

- [ ] **Step 1: Create the function**

```typescript
// supabase/functions/unsubscribe-email/index.ts
// Deploy with --no-verify-jwt (unsubscribe link is clicked unauthenticated).
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

serve(async (req) => {
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  const id = new URL(req.url).searchParams.get('id')
  if (!id) return new Response('Missing id', { status: 400 })

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/email_subscribers?id=eq.${id}&unsubscribed_at=is.null`,
    {
      method: 'PATCH',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ unsubscribed_at: new Date().toISOString() }),
    },
  )

  if (!res.ok) {
    console.error(`unsubscribe PATCH failed: ${res.status}`)
    return new Response('Error', { status: 500 })
  }

  return new Response(
    `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:480px;margin:60px auto;text-align:center">
      <h2>You've been unsubscribed</h2>
      <p style="color:#71717a">You won't receive any more trend briefs at this address.</p>
    </body></html>`,
    { headers: { 'Content-Type': 'text/html' } },
  )
})
```

- [ ] **Step 2: Deploy the function**

```bash
supabase functions deploy unsubscribe-email --no-verify-jwt
```
Expected: `Deployed Function unsubscribe-email` (or similar success message).

- [ ] **Step 3: Smoke-test**

Insert a test subscriber in Supabase:
```sql
insert into email_subscribers (email) values ('test@example.com') returning id;
```
Copy the UUID. Visit: `https://<your-project>.supabase.co/functions/v1/unsubscribe-email?id=<uuid>`

Expected: HTML confirmation page. Verify:
```sql
select unsubscribed_at from email_subscribers where email = 'test@example.com';
```
Should not be null.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/unsubscribe-email/index.ts
git commit -m "feat: add unsubscribe-email edge function"
```

---

## Task 9: send-digest worker — email delivery

**Files:**
- Modify: `workers/send-digest/src/index.ts`
- Modify: `workers/send-digest/wrangler.toml`

- [ ] **Step 1: Update Env interface**

In `src/index.ts`, find:
```typescript
export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  FEISHU_WEBHOOK_URL?: string
  ...
}
```

Add to the end of the interface:
```typescript
  RESEND_API_KEY?: string
  RESEND_FROM?: string
  APP_URL?: string
```

- [ ] **Step 2: Add email helper functions**

After the `bulkMarkSent` function (around line 206), add:

```typescript
function buildEmailHtml(synthesis: string, briefLabel: string, subscriberId: string, appUrl: string): string {
  const body = synthesis
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/\n\n+/g, '</p><p>')
    .replace(/\n/g, '<br/>')
  const unsubUrl = `${appUrl}/unsubscribe-email?id=${subscriberId}`
  return `<!DOCTYPE html><html><body style="font-family:Georgia,serif;max-width:640px;margin:0 auto;padding:24px;color:#1a1a1a;line-height:1.7">
    <p style="font-size:11px;color:#71717a;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:24px">${briefLabel}</p>
    <p>${body}</p>
    <hr style="border:none;border-top:1px solid #e4e4e7;margin:32px 0"/>
    <p style="font-size:11px;color:#a1a1aa">You subscribed to trend briefs. <a href="${unsubUrl}" style="color:#71717a">Unsubscribe</a>.</p>
  </body></html>`
}

function buildEmailSubject(briefLabel: string): string {
  return briefLabel
}

async function sendEmailDigests(
  stepDays: number,
  anchorDate: string,
  brief: TrendBriefRow,
  briefLabel: string,
  env: Env,
): Promise<void> {
  if (!env.RESEND_API_KEY || (!brief.synthesis_en && !brief.synthesis_zh)) return

  const subRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/email_subscribers?unsubscribed_at=is.null&select=id,email,lang`,
    { headers: SB(env) },
  )
  if (!subRes.ok) { console.error('email_subscribers fetch failed'); return }
  const subscribers: { id: string; email: string; lang: 'en' | 'zh' }[] = await subRes.json()
  if (subscribers.length === 0) return

  const claims = subscribers.map(s => ({
    subscriber_id: s.id, anchor_date: anchorDate, step_days: stepDays, status: 'pending',
  }))
  const claimRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/email_digest_sent?on_conflict=subscriber_id,anchor_date,step_days`,
    {
      method: 'POST',
      headers: { ...SB(env), 'Prefer': 'return=representation,resolution=ignore-duplicates' },
      body: JSON.stringify(claims),
    },
  )
  if (!claimRes.ok) { console.error('email claim failed'); return }
  const claimed: { id: string; subscriber_id: string }[] = await claimRes.json()
  if (claimed.length === 0) { console.log('All email subscribers already claimed'); return }

  const claimedBySubscriber = new Map(claimed.map(r => [r.subscriber_id, r.id]))
  const appUrl = env.APP_URL ?? ''
  const toSend = subscribers.filter(s => claimedBySubscriber.has(s.id))

  const results = await Promise.allSettled(
    toSend.map(async s => {
      const synthesis = s.lang === 'zh'
        ? (brief.synthesis_zh ?? brief.synthesis_en ?? '')
        : (brief.synthesis_en ?? brief.synthesis_zh ?? '')
      if (!synthesis) throw new Error('no synthesis for lang ' + s.lang)
      const html = buildEmailHtml(synthesis, briefLabel, s.id, appUrl)
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.RESEND_FROM ?? 'Trend Brief <brief@resend.dev>',
          to: [s.email],
          subject: buildEmailSubject(briefLabel),
          html,
        }),
      })
      if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`)
      return s
    }),
  )

  const sentIds: string[] = []
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    const sub = toSend[i]
    const rowId = claimedBySubscriber.get(sub.id)!
    if (r.status === 'fulfilled') {
      sentIds.push(rowId)
      console.log(`✓ email → ${sub.email}`)
    } else {
      const msg = String((r as PromiseRejectedResult).reason?.message ?? (r as PromiseRejectedResult).reason ?? '').slice(0, 500)
      console.error(`✗ email → ${sub.email}: ${msg}`)
      await fetch(`${env.SUPABASE_URL}/rest/v1/email_digest_sent?id=eq.${rowId}`, {
        method: 'PATCH', headers: SB(env),
        body: JSON.stringify({ status: 'failed', last_error: msg, updated_at: new Date().toISOString() }),
      })
    }
  }
  if (sentIds.length > 0) {
    await fetch(`${env.SUPABASE_URL}/rest/v1/email_digest_sent?id=in.(${sentIds.join(',')})`, {
      method: 'PATCH', headers: SB(env),
      body: JSON.stringify({ status: 'sent', updated_at: new Date().toISOString() }),
    })
  }
  console.log(`Email digest ${anchorDate} step_days=${stepDays}: ${sentIds.length}/${claimed.length} sent`)
}
```

- [ ] **Step 3: Call sendEmailDigests from sendBriefForStepDays**

In `sendBriefForStepDays`, compute `briefLabel` (currently only in `sendNotion`). Add it to `sendBriefForStepDays` after the `brief` is fetched, and call `sendEmailDigests` at the end.

Find (around line 254):
```typescript
  const sourcesCount = Array.isArray(brief.sources_json) ? brief.sources_json.length : null
```

Before that line, add:
```typescript
  const briefLabel = stepDays >= 30
    ? `MONTHLY BRIEF · ${anchorDate.slice(0, 7)}`
    : stepDays >= 7
      ? `WEEKLY BRIEF · ${anchorDate}`
      : `TREND BRIEF · ${anchorDate}`
```

After `await bulkMarkSent(sentIds, env)` (line ~274), add:
```typescript
  await sendEmailDigests(stepDays, anchorDate, brief, briefLabel, env)
```

- [ ] **Step 4: Update wrangler.toml**

Open `workers/send-digest/wrangler.toml`. Replace the current contents with:

```toml
name = "send-digest"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[triggers]
crons = ["30 0 * * *"]

# Secrets — set via: wrangler secret put <KEY>
# SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FEISHU_WEBHOOK_URL,
# SLACK_WEBHOOK_URL, DISCORD_WEBHOOK_URL, TELEGRAM_BOT_TOKEN,
# TELEGRAM_CHAT_ID, NOTION_TOKEN, NOTION_DATABASE_ID,
# RESEND_API_KEY, RESEND_FROM, APP_URL
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd "workers/send-digest" && npx tsc --noEmit 2>&1 | grep -i "error" | head -10
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add workers/send-digest/src/index.ts workers/send-digest/wrangler.toml
git commit -m "feat: add email digest delivery to send-digest worker"
```

---

## Verification Checklist

1. **Copy — brief:** Expand a loaded trend brief → tap copy button → paste → raw markdown pasted. Button turns green for 1.5s.
2. **Copy — QA:** Get a QA answer → tap copy → paste → answer text copied.
3. **Thumbs — brief:** Tap 👍 on an expanded brief → run `SELECT feedback FROM trend_briefs WHERE id='...'` → value is `1`. Tap again → value is null.
4. **Thumbs persistence:** Reload app → expand same brief → 👍 pre-highlighted (requires `initialFeedback` to be populated from the DB row).
5. **Email subscribe:** Open SubscriptionManualModal → Email tab → select language → enter email → Subscribe → check `SELECT * FROM email_subscribers WHERE email='...'` for `lang` and no `unsubscribed_at`.
6. **Email duplicate:** Subscribe same email twice → "Already subscribed." message shown.
7. **Unsubscribe link:** Visit `https://<project>.supabase.co/functions/v1/unsubscribe-email?id=<uuid>` → HTML confirmation page → `unsubscribed_at` is set in DB.
8. **Email digest send:** Set `RESEND_API_KEY`, `RESEND_FROM`, `APP_URL` secrets on the worker → trigger `send-digest` via a test cron or manual fetch → verify email received → `email_digest_sent` row has `status='sent'`.
9. **Idempotency:** Re-trigger `send-digest` for the same date → `email_digest_sent` claim returns 0 rows → no duplicate send.
