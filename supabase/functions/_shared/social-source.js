export const FEED_HEADERS = {
  'User-Agent': 'web:LinkXCapitalNews:v1.0 (source coverage recovery; contact: ops@linkx.capital)',
  'Accept': 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
  'Accept-Language': 'en-US,en;q=0.9',
}

export function extractYouTubeChannelId(value) {
  if (!value) return null
  const text = String(value).replace(/\\u0026/g, '&').replace(/\\"/g, '"')
  return text.match(/[?&]channel_id=(UC[a-zA-Z0-9_-]{20,})/)?.[1] ??
    text.match(/youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{20,})/)?.[1] ??
    text.match(/"browseEndpoint":\{"browseId":"(UC[a-zA-Z0-9_-]{20,})"/)?.[1] ??
    text.match(/"channelId":"(UC[a-zA-Z0-9_-]{20,})"/)?.[1] ??
    text.match(/"externalId":"(UC[a-zA-Z0-9_-]{20,})"/)?.[1] ??
    text.match(/itemprop=["']channelId["'][^>]+content=["'](UC[a-zA-Z0-9_-]{20,})["']/i)?.[1] ??
    null
}

export function normalizeSocialSourceUrl(value) {
  if (!value) return ''
  const raw = String(value).trim()
  const channelId = extractYouTubeChannelId(raw)
  if (channelId) return `youtube:channel:${channelId}`

  try {
    const url = new URL(raw)
    const host = url.hostname.replace(/^www\./, '').toLowerCase()
    const pathname = url.pathname.replace(/\/+$/, '')

    if (host === 'youtube.com' || host === 'youtu.be') {
      const handle = pathname.match(/^\/@([^/]+)$/)?.[1]
      if (handle) return `youtube:@${handle.toLowerCase()}`
    }

    url.hash = ''
    url.search = ''
    url.hostname = host
    url.pathname = pathname || '/'
    return url.toString().replace(/\/$/, '')
  } catch {
    const handle = raw.match(/^@?([A-Za-z0-9._-]+)$/)?.[1]
    return handle ? `youtube:@${handle.toLowerCase()}` : raw.toLowerCase()
  }
}

export function getYouTubeChannelId(source) {
  return source?.metadata?.channel_id ??
    source?.metadata?.youtube_channel_id ??
    extractYouTubeChannelId(source?.rss_url ?? '')
}

export function redditFeedUrlCandidates(value) {
  if (!value) return []
  const raw = String(value).trim()
  const subreddit = raw.match(/reddit\.com\/r\/([^/.?#]+)/i)?.[1]
  if (!subreddit) return [raw]
  return [
    raw,
    `https://old.reddit.com/r/${subreddit}.rss`,
    `https://www.reddit.com/r/${subreddit}/new/.rss`,
  ]
}

export function youtubeSourceAliases(source) {
  const aliases = new Set()
  const rssUrl = source?.rss_url ?? ''
  const metadata = source?.metadata ?? {}

  for (const value of [
    rssUrl,
    metadata.youtube_handle,
    metadata.handle,
    metadata.channel_url,
    metadata.apify_start_url,
    metadata.source_page,
  ]) {
    const normalized = normalizeSocialSourceUrl(value)
    if (normalized) aliases.add(normalized)
  }

  const channelId = getYouTubeChannelId(source)
  if (channelId) {
    aliases.add(`youtube:channel:${channelId}`)
    aliases.add(normalizeSocialSourceUrl(`https://www.youtube.com/channel/${channelId}`))
    aliases.add(normalizeSocialSourceUrl(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`))
  }

  return aliases
}
