// Privatus Analytics — Logpush HTTP destination endpoint.
// Receives Cloudflare Logpush batches of the http_requests dataset (ndjson, gzip), keeps only
// { ts, path, status, user_agent } (ClientIP and everything else is dropped) and forwards to {UPSTREAM}/api/logs.
// Authenticated with a shared secret sent by Logpush as a custom header (see README).
// MIT License — Copyright (c) 2026 Privatus Analytics
import { botRegex, onlyBots, parseLogpush, shipLines } from './lib.js'

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export function authorised(request, env) {
  if (!env.LOGPUSH_SECRET) return false
  const header = request.headers.get('Authorization') || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : request.headers.get('X-Logpush-Secret') || ''
  return timingSafeEqual(token, env.LOGPUSH_SECRET)
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
    if (!authorised(request, env)) return new Response('Unauthorized', { status: 401 })

    const body = new Uint8Array(await request.arrayBuffer())
    const lines = await parseLogpush(body, { onlyBots: onlyBots(env), regex: botRegex(env.EXTRA_BOTS) })
    // Logpush's destination validation sends a small test payload with no log fields: accept it.
    if (!lines.length) return new Response('ok', { status: 200 })

    let ok = false
    try {
      ok = await shipLines(lines, env)
    } catch {
      ok = false
    }
    // A non-2xx makes Logpush retry the batch.
    return ok ? new Response('ok', { status: 200 }) : new Response('upstream error', { status: 502 })
  }
}
