// Privatus Analytics — crawler log shipper (route passthrough + Queue consumer).
// Runs on your site's routes: passes every request through untouched, then (off the response path) enqueues
// { ts, path, status, user_agent } for AI/search crawler requests. The consumer batches them to {UPSTREAM}/api/logs.
// No IPs, no query strings, no cookies are ever recorded.
// MIT License — Copyright (c) 2026 Privatus Analytics
import { botRegex, onlyBots, requestToLine, shipLines } from './lib.js'

let cachedRegex = null
let cachedExtra = null
function regexFor(env) {
  if (cachedRegex === null || cachedExtra !== (env.EXTRA_BOTS || '')) {
    cachedExtra = env.EXTRA_BOTS || ''
    cachedRegex = botRegex(cachedExtra)
  }
  return cachedRegex
}

export default {
  async fetch(request, env, ctx) {
    const response = await fetch(request)
    try {
      const line = requestToLine(request, response.status, { onlyBots: onlyBots(env), regex: regexFor(env) })
      if (line) ctx.waitUntil(env.LOG_QUEUE.send(line).catch(() => {}))
    } catch {
      // never break the site because of logging
    }
    return response
  },

  async queue(batch, env) {
    const lines = batch.messages.map((m) => m.body)
    let ok = false
    try {
      ok = await shipLines(lines, env)
    } catch {
      ok = false
    }
    if (ok) batch.ackAll()
    else batch.retryAll()
  }
}
