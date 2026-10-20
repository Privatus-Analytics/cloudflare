import { describe, it, expect, vi } from 'vitest'
import {
  BOT_TOKENS, botRegex, isBot, onlyBots, cleanPath, requestToLine, normaliseTimestamp,
  logpushRecordToLine, parseLogpush, chunk, shipLines
} from '../src/lib.js'
import worker from '../src/index.js'
import logpush, { authorised } from '../src/logpush.js'

const now = new Date('2026-09-29T10:00:00.123Z')

async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

describe('bot detection', () => {
  const uas = {
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)': true,
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ChatGPT-User/1.0; +https://openai.com/bot)': true,
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)': true,
    'Claude-User/1.0': true,
    'Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)': true,
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)': true,
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)': true,
    'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 (Applebot/0.1)': true,
    'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)': true,
    'CCBot/2.0 (https://commoncrawl.org/faq/)': true,
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36': false,
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148': false,
    '': false
  }
  for (const [ua, expected] of Object.entries(uas)) {
    it(`${expected ? 'matches' : 'ignores'} ${ua.slice(0, 60) || '(empty)'}`, () => expect(isBot(ua)).toBe(expected))
  }

  it('covers every required crawler token', () => {
    for (const token of ['GPTBot', 'ChatGPT-User', 'OAI-SearchBot', 'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'anthropic-ai',
      'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Googlebot', 'Bingbot', 'Applebot', 'Applebot-Extended', 'Bytespider',
      'CCBot', 'Amazonbot', 'Meta-ExternalAgent', 'FacebookBot', 'DuckAssistBot', 'cohere-ai', 'YouBot', 'Diffbot']) {
      expect(BOT_TOKENS).toContain(token)
      expect(isBot(`Mozilla/5.0 (compatible; ${token.toLowerCase()}/1.0)`)).toBe(true)
    }
  })

  it('accepts extra tokens', () => {
    expect(isBot('MyCrawler/1.0', botRegex('MyCrawler, Other'))).toBe(true)
    expect(isBot('MyCrawler/1.0')).toBe(false)
  })

  it('ONLY_BOTS defaults to true', () => {
    expect(onlyBots({})).toBe(true)
    expect(onlyBots({ ONLY_BOTS: 'false' })).toBe(false)
    expect(onlyBots({ ONLY_BOTS: 'true' })).toBe(true)
  })
})

describe('requestToLine', () => {
  const request = (ua, url = 'https://site.com/blog/post?utm_source=x&token=secret#frag') => new Request(url, {
    headers: { 'User-Agent': ua, 'CF-Connecting-IP': '203.0.113.7', 'X-Forwarded-For': '203.0.113.7', Cookie: 'a=b' }
  })

  it('maps to exactly ts/path/status/user_agent without query string or IP', () => {
    const line = requestToLine(request('GPTBot/1.2'), 200, { now })
    expect(line).toEqual({ ts: '2026-09-29T10:00:00Z', path: '/blog/post', status: 200, user_agent: 'GPTBot/1.2' })
    expect(JSON.stringify(line)).not.toContain('203.0.113.7')
  })

  it('filters humans when onlyBots, keeps them otherwise', () => {
    expect(requestToLine(request('Mozilla/5.0 Chrome/129'), 200, { now })).toBeNull()
    expect(requestToLine(request('Mozilla/5.0 Chrome/129'), 404, { now, onlyBots: false }).status).toBe(404)
  })

  it('cleans paths', () => {
    expect(cleanPath('/a/b?x=1#y')).toBe('/a/b')
    expect(cleanPath('a')).toBe('/a')
  })
})

describe('Logpush parsing', () => {
  it('normalises timestamp formats', () => {
    expect(normaliseTimestamp('2026-09-29T10:00:00Z')).toBe('2026-09-29T10:00:00Z')
    expect(normaliseTimestamp(1790676000)).toBe('2026-09-29T10:00:00Z')
    expect(normaliseTimestamp(1790676000000)).toBe('2026-09-29T10:00:00Z')
    expect(normaliseTimestamp('1790676000000000000')).toBe('2026-09-29T10:00:00Z')
    expect(normaliseTimestamp('nope')).toBeNull()
  })

  it('drops ClientIP and other fields', () => {
    const line = logpushRecordToLine({
      ClientIP: '198.51.100.4', ClientRequestHost: 'site.com', ClientRequestPath: '/docs', ClientRequestURI: '/docs?q=1',
      ClientRequestUserAgent: 'ClaudeBot/1.0', EdgeResponseStatus: 200, EdgeStartTimestamp: '2026-09-29T10:00:00Z', RayID: 'abc'
    })
    expect(line).toEqual({ ts: '2026-09-29T10:00:00Z', path: '/docs', status: 200, user_agent: 'ClaudeBot/1.0' })
  })

  it('falls back to ClientRequestURI without its query string', () => {
    const line = logpushRecordToLine({ ClientRequestURI: '/x?y=1', ClientRequestUserAgent: 'GPTBot', EdgeResponseStatus: 301, EdgeStartTimestamp: 1790676000 })
    expect(line.path).toBe('/x')
  })

  it('parses gzip ndjson and skips junk, humans and test payloads', async () => {
    const ndjson = [
      JSON.stringify({ ClientIP: '1.2.3.4', ClientRequestPath: '/a', ClientRequestUserAgent: 'GPTBot/1.2', EdgeResponseStatus: 200, EdgeStartTimestamp: '2026-09-29T10:00:00Z' }),
      JSON.stringify({ ClientIP: '1.2.3.5', ClientRequestPath: '/b', ClientRequestUserAgent: 'Mozilla/5.0 Chrome/129', EdgeResponseStatus: 200, EdgeStartTimestamp: '2026-09-29T10:00:01Z' }),
      'not json',
      JSON.stringify({ content: 'test' }),
      ''
    ].join('\n')
    const lines = await parseLogpush(await gzip(ndjson))
    expect(lines).toEqual([{ ts: '2026-09-29T10:00:00Z', path: '/a', status: 200, user_agent: 'GPTBot/1.2' }])
    expect(JSON.stringify(lines)).not.toContain('1.2.3.4')
    expect(await parseLogpush(new TextEncoder().encode(ndjson), { onlyBots: false })).toHaveLength(2)
  })
})

describe('shipping', () => {
  it('chunks', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  it('POSTs {lines} with the bearer key, ≤1000 per request', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }))
    const lines = Array.from({ length: 1500 }, (_, i) => ({ ts: '2026-09-29T10:00:00Z', path: `/${i}`, status: 200, user_agent: 'GPTBot' }))
    expect(await shipLines(lines, { INGEST_KEY: 'pik_test', UPSTREAM: 'https://privatusanalytics.com/' }, fetchMock)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://privatusanalytics.com/api/logs')
    expect(init.headers.Authorization).toBe('Bearer pik_test')
    expect(JSON.parse(init.body).lines).toHaveLength(1000)
  })

  it('reports failure on non-2xx', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 500 }))
    expect(await shipLines([{}], { INGEST_KEY: 'pik_test' }, fetchMock)).toBe(false)
  })
})

describe('route worker', () => {
  it('passes the response through and enqueues only crawler lines', async () => {
    const origin = new Response('page', { status: 200 })
    vi.stubGlobal('fetch', vi.fn(async () => origin))
    const sent = []
    const pending = []
    const env = { LOG_QUEUE: { send: async (m) => { sent.push(m) } } }
    const ctx = { waitUntil: (p) => pending.push(p) }
    const res = await worker.fetch(new Request('https://site.com/p?secret=1', { headers: { 'User-Agent': 'OAI-SearchBot/1.0', 'CF-Connecting-IP': '9.9.9.9' } }), env, ctx)
    await worker.fetch(new Request('https://site.com/p', { headers: { 'User-Agent': 'Mozilla/5.0 Firefox/130' } }), env, ctx)
    await Promise.all(pending)
    expect(res).toBe(origin)
    expect(sent).toHaveLength(1)
    expect(sent[0].path).toBe('/p')
    expect(Object.keys(sent[0]).sort()).toEqual(['path', 'status', 'ts', 'user_agent'])
    vi.unstubAllGlobals()
  })

  it('queue consumer acks on success and retries on failure', async () => {
    const batch = (ok) => ({ messages: [{ body: { ts: 't', path: '/', status: 200, user_agent: 'GPTBot' } }], ackAll: vi.fn(), retryAll: vi.fn(), ok })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 202 })))
    const good = batch()
    await worker.queue(good, { INGEST_KEY: 'pik_test' })
    expect(good.ackAll).toHaveBeenCalled()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
    const bad = batch()
    await worker.queue(bad, { INGEST_KEY: 'pik_test' })
    expect(bad.retryAll).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('logpush worker', () => {
  const env = { LOGPUSH_SECRET: 's3cret', INGEST_KEY: 'pik_test' }

  it('requires the shared secret', async () => {
    expect(authorised(new Request('https://x', { headers: { Authorization: 'Bearer s3cret' } }), env)).toBe(true)
    expect(authorised(new Request('https://x', { headers: { 'X-Logpush-Secret': 's3cret' } }), env)).toBe(true)
    expect(authorised(new Request('https://x', { headers: { Authorization: 'Bearer nope' } }), env)).toBe(false)
    expect(authorised(new Request('https://x'), {})).toBe(false)
    const res = await logpush.fetch(new Request('https://x', { method: 'POST', body: '' }), env)
    expect(res.status).toBe(401)
  })

  it('forwards parsed lines and accepts the validation payload', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    const headers = { Authorization: 'Bearer s3cret', 'Content-Encoding': 'gzip' }
    const test = await logpush.fetch(new Request('https://x', { method: 'POST', headers, body: await gzip('{"content":"test"}') }), env)
    expect(test.status).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()
    const body = await gzip(JSON.stringify({ ClientIP: '1.1.1.1', ClientRequestPath: '/z', ClientRequestUserAgent: 'Amazonbot/0.1', EdgeResponseStatus: 404, EdgeStartTimestamp: 1790676000 }))
    const res = await logpush.fetch(new Request('https://x', { method: 'POST', headers, body }), env)
    expect(res.status).toBe(200)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ lines: [{ ts: '2026-09-29T10:00:00Z', path: '/z', status: 404, user_agent: 'Amazonbot/0.1' }] })
    vi.unstubAllGlobals()
  })
})
