import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const modulePath = process.env.SOCIAL_SOURCE_MODULE ?? '../supabase/functions/_shared/social-source.js'
const {
  FEED_HEADERS,
  extractYouTubeChannelId,
  normalizeSocialSourceUrl,
  redditFeedUrlCandidates,
  youtubeSourceAliases,
} = await import(modulePath)

describe('social source helpers', () => {
  it('sends a descriptive user agent for Reddit and bridge feeds', () => {
    assert.match(FEED_HEADERS['User-Agent'], /^web:LinkXCapitalNews:v1\.0/)
    assert.match(FEED_HEADERS.Accept, /application\/atom\+xml/)
  })

  it('normalizes equivalent YouTube source URLs', () => {
    assert.equal(
      normalizeSocialSourceUrl('https://www.youtube.com/@DwarkeshPatel/'),
      'youtube:@dwarkeshpatel',
    )
    assert.equal(
      normalizeSocialSourceUrl('https://youtube.com/channel/UCXl4i9dYBrFOabk0xGmbkRA/'),
      'youtube:channel:UCXl4i9dYBrFOabk0xGmbkRA',
    )
    assert.equal(
      normalizeSocialSourceUrl('https://www.youtube.com/feeds/videos.xml?channel_id=UCcefcZRL2oaA_uBNeo5UOWg'),
      'youtube:channel:UCcefcZRL2oaA_uBNeo5UOWg',
    )
  })

  it('builds source aliases from current metadata', () => {
    const aliases = youtubeSourceAliases({
      rss_url: 'https://www.youtube.com/@DwarkeshPatel',
      metadata: {
        youtube_handle: '@DwarkeshPatel',
        channel_id: 'UCXl4i9dYBrFOabk0xGmbkRA',
      },
    })

    assert.ok(aliases.has('youtube:@dwarkeshpatel'))
    assert.ok(aliases.has('youtube:channel:UCXl4i9dYBrFOabk0xGmbkRA'))
  })

  it('extracts channel IDs from page payloads and feed URLs', () => {
    assert.equal(
      extractYouTubeChannelId('window["ytCommand"]={"browseEndpoint":{"browseId":"UCcefcZRL2oaA_uBNeo5UOWg"}}'),
      'UCcefcZRL2oaA_uBNeo5UOWg',
    )
    assert.equal(
      extractYouTubeChannelId('https://www.youtube.com/feeds/videos.xml?channel_id=UChpleBmo18P08aKCIgti38g'),
      'UChpleBmo18P08aKCIgti38g',
    )
  })

  it('builds Reddit fallback feed URLs', () => {
    assert.deepEqual(
      redditFeedUrlCandidates('https://www.reddit.com/r/MachineLearning.rss'),
      [
        'https://www.reddit.com/r/MachineLearning.rss',
        'https://old.reddit.com/r/MachineLearning.rss',
        'https://www.reddit.com/r/MachineLearning/new/.rss',
      ],
    )
  })

  it('caps XML parsing before expensive batch dedupe', () => {
    const source = readText('workers/ingest-rss/src/index.ts')
    assert.match(source, /MAX_FEED_ITEMS_PER_SOURCE/)
    assert.match(source, /MAX_OFFICIAL_FEED_ITEMS_PER_SOURCE/)
    assert.match(source, /parseRSS\(xml, maxItems\)/)
    assert.match(source, /items\.length >= maxItems/)
    assert.match(source, /const scopedItems = await limitOfficialItemsToWheel\(env, allItems\)/)
    assert.match(source, /const dedupedItems = await suppressBatchDuplicates\(scopedItems\)/)
    assert.match(source, /if \(item\.source_type !== 'official_rss'\)/)
  })
})

function readText(path) {
  return readFileSync(path, 'utf8')
}
