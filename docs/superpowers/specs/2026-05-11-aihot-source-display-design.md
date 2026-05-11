# Design Plan: AIHot Original Source Display

## Context
For AIHot articles, the system needs to display the original outlet (e.g., "TechCrunch") instead of the aggregate feed name "AIHot" in the UI. 

**Architecture context:** The `daily_news.metadata` JSONB column (added in the AIHot ingestion spec) already stores this under `metadata.source`. Currently, the frontend feed RPC (`fetch_grouped_feed`) drops this column, so the frontend cannot render it. 

The goal is to bridge `daily_news.metadata` to the frontend `ArticleCard` component.

---

## Proposed Changes

### 1. Update `fetch_grouped_feed` RPC
The `fetch_grouped_feed` RPC must be updated to return the new `metadata` column. This is a non-destructive schema update using `CREATE OR REPLACE FUNCTION`.

**Migration file to create:** `supabase/sql/20260511_fetch_grouped_feed_add_metadata.sql`
- Add `metadata JSONB` to the `RETURNS TABLE` definition.
- Add `dn.metadata` to the `ranked` CTE `SELECT` clause.
- Add `r.metadata` to the final `SELECT` clause.

### 2. Update TypeScript Types
To ensure type safety across the frontend, the `Article` and `FeedRow` types must be updated to expect the new `metadata` property.

- **`news-app/lib/config.ts`**: Add `metadata?: Record<string, unknown> | null` and `source_type?: string` to the `Article` type.
- **`news-app/App.tsx`**: Add `metadata: Record<string, unknown> | null` to the `FeedRow` type.

### 3. Update `ArticleCard` UI Logic
Modify the `ArticleCard` component to extract the original source from the `metadata` object conditionally when the `source_type` is `'aihot'`.

**File:** `news-app/components/ArticleCard.tsx`
- Extract: `const aihotSource = item.source_type === 'aihot' ? (item.metadata?.source as string | undefined) : undefined`
- Update the `sourceLabel` fallback chain: `aihotSource || showName || sourceName`

---

## Verification Plan
- **RPC Migration:** Apply the SQL migration and confirm no errors. 
- **Data Flow:** Run `SELECT id, metadata FROM daily_news LIMIT 1;` via the REST API or PostgREST and confirm the `metadata` field is returned.
- **UI Rendering:** Open the app and locate an AIHot article. Confirm the source pill reads the original outlet (e.g., "TechCrunch") instead of "AIHot".
- **Regression:** Confirm that RSS, Twitter, and YouTube source pills are unaffected.
