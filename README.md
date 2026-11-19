# TWIVIDEO Shorts

A personal PWA that plays ranking videos in a vertical, YouTube-Shorts-style feed. Each site is a source adapter. The feed has a site switcher and one tab per period that source actually publishes. The service worker loads the app shell from the network first, so an already-installed copy picks up a new `main.js` instead of replaying the cached one.

```bash
npm install
npm start
```

Then open http://localhost:3000/. Docker uses the same command:

```bash
docker build -t shorts .
docker run --rm -p 3000:3000 shorts
```

The image is `ghcr.io/puppeteer/puppeteer`. Rankings are plain HTTP. A block page, timeout, 403, or 5xx tries the next domain in that source's list. This app does not solve Cloudflare challenges or reuse clearance cookies.

## Domains, cache, and embeds

Edit `config/sources.json`, or override it without a code change:

| Variable | Meaning |
| --- | --- |
| `SOURCES_CONFIG` | Path to the JSON file. |
| `SOURCE_BASES_85PO` | Comma-separated base URLs, tried in order. Same pattern for `PORNHUB`, `TOKYOMOTION`, `TWIVIDEO`, `TWIKEEP`, `TWIHOZON`. |
| `SOURCE_PLAYLIST_HOSTS_PORNHUB` | Playlist/CDN hosts merged into that source's proxy allowlist. |
| `SOURCE_EMBED_TWIVIDEO` | Embed template. `{id}` and `{base}` are replaced. |
| `CACHE_TTL_MS` | Ranking cache. Default 30 minutes. |
| `RESOLVE_TTL_MS` | Signed media URL cache. Default 3 minutes. |
| `DOMAIN_MEMORY_TTL_MS` | How long the last working domain is preferred. Default 30 minutes. |
| `MIRROR_TIMEOUT_MS` | Per-domain timeout. Default 12 seconds. |
| `PLAYBACK_MODE` | `auto` (default), `direct`, `playlist-proxy`, `proxy`, or `embed`. `SOURCE_PLAYBACK_85PO` overrides one source. |
| `FULL_PROXY` | `0` turns off the full video relay. Default on, capped by `MAX_PROXY_STREAMS` (code default 3, `config/sources.json` sets 6). |
| `MAX_PROXY_STREAMS_PER_CLIENT` | Relays one viewer (IP) may hold at once. Default 2, so one phone cannot take every slot. |
| `PROXY_QUEUE_MS` | How long a relay request waits for a free slot before `429`. Default 8 seconds. |
| `TRUST_PROXY` | `1` keys the per-viewer cap on `X-Forwarded-For`. Only set this behind your own reverse proxy. |
| `SOURCE_METRIC_TWIKEEP` | `downloads` (default, saves) or `views`. Same as `"metric"` under `twikeep` in the JSON. |
| `SOURCE_HIDDEN_TWIVIDEO` | `1`/`0` overrides `"hidden"` for one source. Hidden sources stay in the API but not in the switcher. |
| `BROWSER_IDLE_MS` | Headless Chrome (if a source uses it) is closed after this long without a page. Default 5 minutes. |

`config/sources.json` is re-read when its modification time changes (checked at most every 2 seconds), so edits apply without a restart. `GET /api/status` includes `domains.<id>.active`, `expiresAt`, `candidates`, the playback settings, and `proxy` (`activeStreams`, `waiting`, `clients`).

`twivideo` is `"hidden": true` in the shipped config: from this network it answers with a Cloudflare page, so it is not offered and the server does not probe it on every start.

The switcher order is the order in `sources/index.js`: TwiKeep, 85po, Pornhub, TokyoMotion, Twihozon (hidden `twivideo` is listed first in the API but not shown). Automatic switching after a failure follows the same order.

Thumbnails load straight from the CDN with `referrerpolicy=no-referrer`. If that image fails, that source's posters fall back to `/proxy/media`. Set `SOURCE_THUMBS_85PO=proxy` (or `direct`) to skip the probe. A source whose ranking keeps failing is removed from the switcher (`hideFailedSources`, default on, after `hideAfterFailures` consecutive failures, default 3; a block page counts as one failure like any other). A hidden source comes back after `hiddenRetryMs` (default 10 minutes, `HIDDEN_RETRY_MS`); one success clears its record, one more failure hides it again. `HIDE_FAILED_SOURCES=0` keeps every tab. When a ranking fails the feed moves to the next source that is neither hidden nor already failed, and the note bar says why; when none is left it stops and shows a retry button. TwiKeep takes `/api/videos?metric=downloads|views` (the bottom bar has a 保存数/表示数 toggle), and each metric is cached separately.

## Playback ladder

In `auto`, each source remembers the first step that starts playback:

1. **direct** — the viewer's `<video>` loads the MP4 or HLS URL from the CDN. The page sends no referrer. Safari plays HLS natively; other browsers use hls.js when the CDN allows CORS.
2. **playlist-proxy** — `/proxy/playlist` rewrites only the m3u8. Segment URLs stay on the CDN.
3. **proxy** — the full relay, only while `fullProxyEnabled` is true and fewer than `maxProxyStreams` relays are open.
4. **embed** — `getEmbedUrl`, in a sandboxed iframe (`allow-scripts allow-same-origin allow-presentation`, no popups or top navigation) with `autoplay=1&muted=1` added when the URL accepts a query. A transparent layer keeps vertical swipes on the feed and forwards a tap to the player. The rank and title stay on top of the iframe. The next card is preloaded unless that would open a full relay.

The media URL is resolved when the card is about to play. If that attempt fails, the app resolves once more, then steps down for that video. A datacenter and a phone can land on different steps when a CDN binds the URL to the IP that resolved it. `PLAYBACK_MODE=embed` skips straight to the iframe. Headless Chrome, if used, is limited to one page.

## Sources

| id | Site | Periods | Playback |
| --- | --- | --- | --- |
| `twivideo` | twivideo.net | 24時間 / 1週間 / 1ヶ月 | Direct MP4 when the HTML is reachable. No official embed unless `SOURCE_EMBED_TWIVIDEO` is set. |
| `twikeep` | twikeep.com | 24時間 / 1週間 / 1ヶ月 / 1年 (`range=24h\|1w\|1m\|1y`) | The `/ranking` page is client-rendered, so the adapter reads the public JSON it loads, `/api/ranking?metric=downloads&range=…`, over plain HTTP (no browser). Ranked by saves (`downloads`) by default; `"metric": "views"` in config or `SOURCE_METRIC_TWIKEEP=views` switches to views. Direct `video.twimg.com` MP4 and `pbs.twimg.com` thumbnail. |
| `85po` | 85po.com, then 85po.net, then 85ro.com | 24時間 / 1週間 / 1ヶ月 | `get_file` MP4, then `https://<base>/embed/<id>/`. |
| `pornhub` | pornhub.com, then jp and rt | 24時間 / 1週間 / 1ヶ月 (`/video?o=mv&t=t\|w\|m`) | A progressive MP4 when the watch page has one, else HLS. A URL with `ip=` or `ipa=` is bound to the resolver, so the viewer never fetches it directly; the relay answers each Range with at most 8MB. The resolver skips signed URLs whose playlist or segment does not load (the `hv-h` `?h=&e=` form answers 410). A safe-for-work redirect tries the next domain. |
| `tokyomotion` | tokyomotion.net | 今日 / 今週 / 今月 | `/vsrc/` MP4. The official embed is `https://<base>/embed/<token>` from the watch page, not the numeric id. |
| `twihozon` | twihozon.org | 24時間 / 1週間 / 1ヶ月 (`/`, `/week.html`, `/month.html`) | Direct `video.twimg.com` MP4 from the listing HTML. A card without one resolves from `/play-<id>-video.html`. The all-time board (`/all.html`) is not offered. |

Both Twitter sources start on the **direct** step (the Twitter CDN plays without a Referer). If that fails, the usual ladder applies. Neither has an embed. Their proxy allowlist is `twimg.com` only.

None of the sites publish a 3-day board. Only TwiKeep has a 1年 board; asking another source for `period=1y` falls back to its month board. The old 3-day tab did not map to a twivideo ranking either. Asking for `period=3d` (or the legacy `sort=3days`) returns the nearest real board and sets `fallback` so the UI can say so. The period tabs themselves are the periods that source exports, so a month board shows up as 1ヶ月 / 月間 instead of a mislabeled week.

**ランダム順（デフォルト）**: each ranking plays in a weighted random order (Efraimidis–Spirakis, `key = random^(1/weight)`, no repeats), reshuffled on every load or source/period/metric switch. The weight comes from saves (TwiKeep 保存数, Twihozon 保存) > likes > views > board rank, with "1.2K" / "12,345" / "1万" parsed, log-compressed, and floored so lower videos still turn up; the bottom bar's ランダム/ランキング順 button switches back to the board order (`shorts.order` in `localStorage`). The ブクマ list is not shuffled. The logic lives in `src/feed-logic.js` (`orderFeed`, `appendFeed`, `feedWeights`). `/api/videos` serves a board 24 videos at a time (`&page=2`, `hasMore`); scrolling near the end fetches the next page, orders it the same way, and appends it without repeating a video already in the feed.

The last site and its period are stored in `localStorage`. A browser with nothing saved opens on TwiKeep (the first offered source if TwiKeep is hidden). A saved site that is hidden or no longer exists falls back the same way; one the server no longer has is also cleared from `localStorage`.

**ブクマ（いいね一覧）**: ♥ (or a double tap) saves the video in `localStorage` (`shorts.bookmarks`: source, id, page URL, title, thumbnail, liked time, and the original `playback` object for the usual ladder), newest first, at most 500 (the oldest is dropped; a full or broken storage trims or is ignored instead of crashing). The ブクマ button at the right of the site bar plays them in the same vertical feed; a video that no longer plays is skipped with a note but stays in the list until you tap ♥ again, and the bottom bar returns to the ranking.

## API

- `GET /api/sources` — id, name, color, periods.
- `GET /api/videos?source=85po&period=24h` — normalized videos. A source failure is `{ ok: false, error }` and does not affect the others.
- `GET /api/resolve?source=pornhub&id=...` — turn a `playback.kind: "resolve"` item into `file`, `hls`, or `embed`.
- `GET /api/external?source=twivideo&id=...` — original-post URL for sources that need a lookup.
- `GET /proxy/media?source=pornhub&url=...` — streams a URL whose host is on that source's allowlist, with that source's Referer. m3u8 responses are rewritten so segments and keys also go through the proxy. Private hosts and unknown hosts are rejected.

Rankings are cached per source and period for 30 minutes. Resolved media URLs are cached for 3 minutes because many of them are signed. A domain that already answered is reused until `DOMAIN_MEMORY_TTL_MS`, so a later period does not probe the failing domains again.

## Adding a source

1. Copy the closest adapter (`sources/tokyomotion.js` is the smallest plain-HTTP one) to `sources/<id>.js`. `<id>` must match `[a-z0-9_-]+`.
2. Change everything that names the old site: the exported `id`, `name`, and `color`; the source id passed to `withMirror(...)` and any other helper; the constants at the top (`DEFAULT_BASES`, `SELECTORS`, `PERIODS`); `mediaHosts` (every host the video or playlist is served from, including redirect targets) and `mediaReferer`. Then rewrite the ranking URL builder and the HTML parser for the new site's markup. A duplicated `id` stops the server at startup.
3. Register it with one line in `sources/index.js`.
4. Add `"<id>": { "bases": [...] }` to `config/sources.json`. Add `"hidden": true` while it is not ready, or if the site only answers with a Cloudflare page.
5. Add a parser test with a small saved HTML fixture to `test/ranking.test.js`, then `npm test`.

Nothing in `server.js` or the frontend needs to change. Restart `npm start`. The new site appears in the switcher, and its `periods` become the bottom tabs.

```js
module.exports = {
  id: 'example',
  name: 'Example',
  color: '#ff9900',          // optional chip color
  periods: [
    { id: '24h', label: '24時間' },
    { id: '7d', label: '1週間' },
  ],
  // Hosts the media proxy is allowed to contact for this source.
  // Subdomains count (cdn.example.com matches example.com).
  bases: ['https://example.com', 'https://example.net'],
  mediaHosts: ['example.com', 'cdn.example.net'],
  mediaReferer: 'https://example.com/',
  cacheTtlMs: 30 * 60 * 1000,   // optional; otherwise config/sources.json
  timeoutMs: 60000,             // optional

  // Optional. Official iframe used when direct and proxied playback do not start.
  getEmbedUrl(video) {
    return `https://example.com/embed/${video.id}`;
  },

  // periodId is one of the ids above. Return a list; the registry
  // assigns rank numbers and drops malformed rows.
  async fetchRanking(periodId) {
    return [{
      id: '1',
      title: 'Title',
      pageUrl: 'https://example.com/watch/1',
      thumbUrl: 'https://cdn.example.net/1.jpg',
      duration: '1:00',
      views: '10K',
      externalUrl: 'https://example.com/watch/1',
      playback: { kind: 'file', url: 'https://cdn.example.net/1.mp4' },
    }];
  },

  // Optional. Use this when the listing has no stable media URL
  // (signed MP4, HLS playlist built by a script). `kind` is
  // file | hls | embed. Set embedUrl too if an iframe can play it.
  async resolvePlayback(id) {
    return { kind: 'hls', url: 'https://cdn.example.net/1/playlist.m3u8', embedUrl: null };
  },
};
```

`playback.kind`:

- `file` — a progressive URL. The app plays it in `<video>` through the proxy.
- `hls` — an m3u8 URL. The app uses hls.js (or Safari's native HLS). The proxy rewrites the playlist.
- `embed` — an iframe URL. Use this when the site will not hand out a media file.
- `resolve` — the listing does not include media yet. The app calls `resolvePlayback` when the card is on screen, then uses whatever that returns. If it fails and `embedUrl` is set, the iframe is shown instead.

Put the CSS selectors and the ranking URLs in constants at the top of the file (`SELECTORS`, `PERIOD_URLS` / `PERIODS`). That is the part that breaks when a site redesigns, and it should be the only part you have to edit.

Use `lib/http.js` `getText` and `lib/mirrors.js` `withMirror`. A block page, timeout, 403, or 5xx throws so the next base is tried. Do not add a Cloudflare solver or copy clearance cookies; put another domain in `bases` instead.

If the site has no period for a tab the user might still request (`3d` is the usual one), do not invent a URL. Omit that period. The registry answers with the nearest period and a `fallbackReason`.

## Server load (about 10 viewers)

What keeps the server light:

- Rankings are cached per source and period for 30 minutes, and concurrent requests for the same board share one fetch. Resolved media URLs are cached for 3 minutes. Both caches are bounded.
- 85po plays straight from its CDN. Thumbnails load straight from the CDN with no referrer. A proxied thumbnail does not take a relay slot and is sent with `Cache-Control: public, max-age=86400`.
- A full relay is capped globally (`maxProxyStreams`) and per viewer (`maxProxyStreamsPerClient`). A request over the cap waits up to `proxyQueueMs` for a slot. It does not contact the CDN until it has one.
- Each MP4 relay answers at most 8MB per Range request. A relay whose viewer hung up, or stopped reading for 30 seconds, closes its CDN connection and frees its slot. The player calls `load()` after removing a `src`, so scrolling away actually ends the download.
- The service worker never caches Range responses, video, or cross-site thumbnails.

What cannot be reduced, and why:

- **Pornhub video has to be relayed.** HLS segments 404 without the watch-page Referer, which a browser will not send cross-site. Progressive MP4 URLs carry `ip=`/`ipa=` and only play from the IP that resolved them. Every Pornhub viewer therefore uses relay bandwidth. Raise `maxProxyStreams` if the uplink allows it.
- **TokyoMotion's `/vsrc/` MP4 does not play direct in Chrome** (the ladder ends on the relay), so it is relayed as well.
- **No shared segment cache.** Friends watching the same video within 3 minutes get the same signed URL, but caching video segments on the server would need either a lot of RAM or a disk cache with eviction. It is not worth it at this size.
- **The relay limiter is per process.** Running several Node processes multiplies the cap.

## Tests

```bash
npm test
```

Parser tests use small HTML fixtures so a selector change is visible without the network. Live fetches depend on the sites and on Cloudflare.
