import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = () => readFileSync('news-app/App.tsx', 'utf8')

test('new article monitoring does not use Supabase Realtime channels', () => {
  const app = source()

  assert.doesNotMatch(app, /\.channel\(['"]public:daily_news['"]\)/)
  assert.doesNotMatch(app, /postgres_changes/)
  assert.doesNotMatch(app, /removeChannel/)
})

test('new article monitoring keeps lightweight polling and focus checks', () => {
  const app = source()

  assert.match(app, /NEW_ARTICLES_POLL_INTERVAL_MS/)
  assert.match(app, /setInterval\(\(\) => \{\s*checkMissedArticles\(\{ force: true \}\)\s*\}/s)
  assert.match(app, /AppState\.addEventListener\('change'/)
  assert.match(app, /visibilitychange/)
  assert.match(app, /\.select\('id', \{ count: 'exact', head: true \}\)/)
})

test('ingest-rss owns RSS-like feeds including YouTube fallback and Reddit RSS', () => {
  const rssWorker = readFileSync('workers/ingest-rss/src/index.ts', 'utf8')
  const buildersWorker = readFileSync('workers/ingest-builders/src/index.ts', 'utf8')

  assert.match(rssWorker, /source_type=in\.\(rss,wechat,official_rss,reddit,youtube\)/)
  assert.match(rssWorker, /fetchYouTubeFeed/)
  assert.match(rssWorker, /extractYouTubeChannelId/)
  assert.match(rssWorker, /www\.youtube\.com\/feeds\/videos\.xml\?channel_id=/)

  assert.doesNotMatch(buildersWorker, /source_type=in\.\([^)]*reddit/)
  assert.doesNotMatch(buildersWorker, /redditSources/)
  assert.doesNotMatch(buildersWorker, /top\.json\?t=day/)
})
