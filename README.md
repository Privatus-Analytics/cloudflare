# Privatus Analytics on Cloudflare

| Package | Purpose |
| --- | --- |
| [`crawler-log-shipper/`](crawler-log-shipper/) | See which AI assistants and search crawlers fetch your pages (they don't run JavaScript), by shipping request logs **without IPs** to Privatus Analytics. Route Worker + Queue, or a Logpush HTTP endpoint. |

It is an ES-module Worker with no runtime dependencies. The package pins Wrangler in its lockfile. Run `npm ci`
in the package folder first. The commands below use `npx --no-install wrangler …`, which runs only that locally
installed, pinned version and fails instead of downloading the newest Wrangler release from npm (Wrangler handles
your Cloudflare login and Worker secrets).

---

## Crawler log shipper

AI crawlers (GPTBot, ClaudeBot, PerplexityBot, …) don't execute JavaScript, so the tracker never sees them.
This Worker sits in front of your site as a pure passthrough (`fetch(request)`) and, *after* the response is
returned (`ctx.waitUntil`), records:

```json
{ "ts": "2026-09-29T10:00:00Z", "path": "/blog/post", "status": 200, "user_agent": "GPTBot/1.2" }
```

— no IP, no query string, no headers or cookies. With `ONLY_BOTS=true` (default) only requests whose UA matches
the crawler list are recorded: GPTBot, ChatGPT-User, OAI-SearchBot, ClaudeBot, Claude-User, Claude-SearchBot,
Claude-Web, anthropic-ai, PerplexityBot, Perplexity-User, Google-Extended, Googlebot, Google-InspectionTool,
GoogleOther, Google-CloudVertexBot, Bingbot, BingPreview, Applebot, Applebot-Extended, Bytespider, CCBot,
Amazonbot, Meta-ExternalAgent, Meta-ExternalFetcher, FacebookBot, facebookexternalhit, DuckAssistBot, DuckDuckBot,
cohere-ai, cohere-training-data-crawler, YouBot, Diffbot, MistralAI-User, AI2Bot, Timpibot, ImagesiftBot, PetalBot,
YandexBot, Baiduspider, Kangaroo Bot, PanguBot, Webzio-Extended, omgili, iaskspider, Brightbot (case-insensitive
substring match; add more with `EXTRA_BOTS="Foo,Bar"`). Note: `Google-Extended` and `Applebot-Extended` are
robots.txt control tokens rather than crawler UAs; they're matched in case they appear, but Google/Apple fetches
show up as Googlebot/Applebot.

Lines go to a Cloudflare Queue (only the four fields above ever enter the queue). The consumer receives batches of up
to 100 (`max_batch_size = 100`, `max_batch_timeout = 30`) and POSTs `{"lines":[…]}` to `{UPSTREAM}/api/logs` with
`Authorization: Bearer ${INGEST_KEY}`; non-2xx → `retryAll()` (up to `max_retries`).

### Setup

1. Queues must be enabled on your account (Workers Paid plan).
2. `cd crawler-log-shipper && npm ci`
3. `npx --no-install wrangler queues create privatus-crawler-logs`
4. Edit `wrangler.toml`: replace `example.com` in `routes` (e.g. `example.com/*`; exclude static paths with more
   specific routes pointing to no Worker if you like).
5. `npx --no-install wrangler secret put INGEST_KEY` → your site's crawler log key (`pik_…`).
6. `npx --no-install wrangler deploy`.

The Worker never alters the response; if logging fails the request still succeeds. Each request through the Worker counts
as a Worker invocation — use `ONLY_BOTS=true` and narrower routes to keep queue volume down.

### Logpush alternative (Enterprise)

If you already use Cloudflare Logpush (http_requests dataset), skip the route Worker and deploy the receiver in
`src/logpush.js`, which accepts Logpush HTTP-destination batches (ndjson, gzip-compressed; detected by magic bytes,
so it works whether or not the body is transparently decompressed), maps
`EdgeStartTimestamp → ts` (RFC 3339 or unix s/ms/ns), `ClientRequestPath` (or `ClientRequestURI` without query) `→ path`,
`EdgeResponseStatus → status`, `ClientRequestUserAgent → user_agent`, **drops `ClientIP` and every other field**,
applies the same `ONLY_BOTS` filter, and forwards `{lines}` to `{UPSTREAM}/api/logs` in chunks of ≤ 1000.
Returns 502 on upstream failure so Logpush retries; returns 200 for the destination-validation test payload.

1. `npx --no-install wrangler secret put INGEST_KEY -c wrangler.logpush.toml` and
   `npx --no-install wrangler secret put LOGPUSH_SECRET -c wrangler.logpush.toml` (long random string).
2. `npx --no-install wrangler deploy -c wrangler.logpush.toml` → note the URL, e.g. `https://privatus-logpush-receiver.<acct>.workers.dev`.
3. Create the Logpush job (dashboard → Analytics & Logs → Logpush → HTTP destination, or API) with:
   * destination: `https://privatus-logpush-receiver.<acct>.workers.dev/?header_Authorization=Bearer%20<LOGPUSH_SECRET>`
   * dataset: `http_requests`
   * fields: `ClientRequestPath,ClientRequestUserAgent,EdgeResponseStatus,EdgeStartTimestamp`
     (do **not** select `ClientIP`; it would be dropped anyway)
   * timestamp format: `rfc3339`
   * optional filter to pre-select crawlers, e.g. `{"where":{"key":"ClientRequestUserAgent","operator":"contains","value":"bot"}}`

---

## Tests

Pure functions (request→line mapping, bot regex, Logpush parsing incl. gzip, shipping/chunking) and
the handlers with mocked `fetch`/`caches`/Queue are covered with Vitest:

```sh
docker run --rm -v "$PWD":/w -w /w node:22 sh -c 'cd crawler-log-shipper && npm install && npx vitest run'
rm -rf crawler-log-shipper/node_modules
```

Not covered: running under `workerd`/Miniflare, real Queue delivery and real Logpush jobs.

## License

MIT — see `LICENSE`.
