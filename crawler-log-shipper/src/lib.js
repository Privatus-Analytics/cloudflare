// Pure helpers shared by the route Worker, the queue consumer and the Logpush endpoint.
// Log lines are exactly { ts, path, status, user_agent } — never IP addresses, never query strings.
// MIT License — Copyright (c) 2026 Privatus Analytics

// AI assistants, AI training crawlers and major search crawlers (matched case-insensitively as substrings).
export const BOT_TOKENS = [
  // OpenAI
  'GPTBot', 'ChatGPT-User', 'OAI-SearchBot',
  // Anthropic
  'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'Claude-Web', 'anthropic-ai',
  // Perplexity
  'PerplexityBot', 'Perplexity-User',
  // Google (Google-Extended is a robots.txt token; kept in case it appears in a UA)
  'Google-Extended', 'Googlebot', 'Google-InspectionTool', 'GoogleOther', 'Google-CloudVertexBot',
  // Microsoft
  'Bingbot', 'BingPreview',
  // Apple
  'Applebot', 'Applebot-Extended',
  // Others
  'Bytespider', 'CCBot', 'Amazonbot', 'Meta-ExternalAgent', 'Meta-ExternalFetcher', 'FacebookBot',
  'facebookexternalhit', 'DuckAssistBot', 'DuckDuckBot', 'cohere-ai', 'cohere-training-data-crawler',
  'YouBot', 'Diffbot', 'MistralAI-User', 'AI2Bot', 'Timpibot', 'ImagesiftBot', 'PetalBot', 'YandexBot',
  'Baiduspider', 'Kangaroo Bot', 'PanguBot', 'Webzio-Extended', 'omgili', 'iaskspider', 'Brightbot'
]

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function botRegex(extra = '') {
  const tokens = BOT_TOKENS.concat(String(extra || '').split(',').map((t) => t.trim()).filter(Boolean))
  return new RegExp(tokens.map(escape).join('|'), 'i')
}

const DEFAULT_BOTS = botRegex()

export function isBot(userAgent, regex = DEFAULT_BOTS) {
  return !!userAgent && regex.test(userAgent)
}

export function onlyBots(env = {}) {
  return String(env.ONLY_BOTS === undefined ? 'true' : env.ONLY_BOTS).toLowerCase() !== 'false'
}

// Strip "?query" and "#fragment" from a path or URL path.
export function cleanPath(path) {
  const p = String(path || '/').split('#')[0].split('?')[0]
  return p.startsWith('/') ? p.slice(0, 2048) : '/' + p.slice(0, 2047)
}

function isoSeconds(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

// Request + response status → log line (or null when filtered out).
export function requestToLine(request, status, { now = new Date(), onlyBots: bots = true, regex = DEFAULT_BOTS } = {}) {
  const userAgent = request.headers.get('User-Agent') || ''
  if (bots && !isBot(userAgent, regex)) return null
  return {
    ts: isoSeconds(now),
    path: cleanPath(new URL(request.url).pathname),
    status: Number(status) || 0,
    user_agent: userAgent.slice(0, 512)
  }
}

// EdgeStartTimestamp may be RFC 3339, unix seconds, unix millis or unix nanos depending on the job's timestamp_format.
export function normaliseTimestamp(value) {
  if (value === undefined || value === null || value === '') return null
  let date
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const n = Number(value)
    const ms = n > 1e17 ? n / 1e6 : n > 1e14 ? n / 1e3 : n > 1e11 ? n : n * 1000
    date = new Date(ms)
  } else {
    date = new Date(String(value))
  }
  return Number.isNaN(date.getTime()) ? null : isoSeconds(date)
}

// One Logpush http_requests record → log line (ClientIP and every other field are dropped).
export function logpushRecordToLine(record, { onlyBots: bots = true, regex = DEFAULT_BOTS } = {}) {
  if (!record || typeof record !== 'object') return null
  const userAgent = String(record.ClientRequestUserAgent || '')
  const path = record.ClientRequestPath || record.ClientRequestURI
  const ts = normaliseTimestamp(record.EdgeStartTimestamp)
  if (!path || !ts) return null
  if (bots && !isBot(userAgent, regex)) return null
  return { ts, path: cleanPath(path), status: Number(record.EdgeResponseStatus) || 0, user_agent: userAgent.slice(0, 512) }
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).text()
}

// Logpush HTTP destination body (ndjson, usually gzip) → log lines.
export async function parseLogpush(body, options = {}) {
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body)
  const text = bytes.length > 1 && bytes[0] === 0x1f && bytes[1] === 0x8b ? await gunzip(bytes) : new TextDecoder().decode(bytes)
  const lines = []
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    let record
    try { record = JSON.parse(raw) } catch { continue }
    const line = logpushRecordToLine(record, options)
    if (line) lines.push(line)
  }
  return lines
}

export function chunk(items, size) {
  const out = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

// POST lines to {UPSTREAM}/api/logs in chunks of ≤1000. Returns true when every chunk was accepted.
export async function shipLines(lines, env, fetchImpl = fetch) {
  if (!lines.length) return true
  if (!env.INGEST_KEY) throw new Error('INGEST_KEY secret is not set')
  const endpoint = (env.UPSTREAM || 'https://privatusanalytics.com').replace(/\/+$/, '') + '/api/logs'
  for (const part of chunk(lines, 1000)) {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.INGEST_KEY}` },
      body: JSON.stringify({ lines: part })
    })
    if (!res.ok) return false
  }
  return true
}
