# TWIVIDEO Shorts

A personal PWA that plays ranking videos in a vertical, YouTube-Shorts-style feed. Each site is a source adapter. The feed has a site switcher and one tab per period that source actually publishes.

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
| `SOURCE_BASES_85PO` | Comma-separated base URLs, tried in order. Same pattern for `PORNHUB`, `MISSAV`, `TOKYOMOTION`, `TWIVIDEO`. |
| `SOURCE_PLAYLIST_HOSTS_MISSAV` | Playlist/CDN hosts merged into that source's proxy allowlist. |
| `SOURCE_EMBED_MISSAV` | Embed template. `{id}` and `{base}` are replaced. |
| `CACHE_TTL_MS` | Ranking cache. Default 30 minutes. |
| `RESOLVE_TTL_MS` | Signed media URL cache. Default 3 minutes. |
| `DOMAIN_MEMORY_TTL_MS` | How long the last working domain is preferred. Default 30 minutes. |
| `MIRROR_TIMEOUT_MS` | Per-domain timeout. Default 12 seconds. |

`GET /api/status` includes `domains.<id>.active`, `expiresAt`, and `candidates`.

Each adapter exports `getEmbedUrl(video)`. The feed uses that iframe when a direct or proxied file cannot be resolved or fails in the player. A transparent layer stays over the iframe so vertical swipes still move the feed; a tap hands the card to the embed, and "スワイプに戻す" puts the layer back.

## Sources

| id | Site | Periods | Playback |
| --- | --- | --- | --- |
| `twivideo` | twivideo.net | 24時間 / 1週間 / 1ヶ月 | Direct MP4 when the HTML is reachable. No official embed unless `SOURCE_EMBED_TWIVIDEO` is set. |
| `pornhub` | pornhub.com, then jp and rt | 24時間 / 1週間 / 1ヶ月 (`/video?o=mv&t=t\|w\|m`) | HLS from `mediaDefinitions`, then `https://<base>/embed/<viewkey>`. A safe-for-work redirect tries the next domain. |
| `85po` | 85po.com, then 85po.net, then 85ro.com | 24時間 / 1週間 / 1ヶ月 | `get_file` MP4, then `https://<base>/embed/<id>/`. |
| `tokyomotion` | tokyomotion.net | 今日 / 今週 / 今月 | `/vsrc/` MP4. The official embed is `https://<base>/embed/<token>` from the watch page, not the numeric id. |
| `missav` | missav.ws, missav.ai, missav.live, missav123.com | 今日 / 週間 / 月間 | Playlist on `surrit.com` when the watch HTML is readable. No official embed URL was found; set `SOURCE_EMBED_MISSAV` if you have one. |

None of these sites publish a 3-day board. The old 3-day tab did not map to a twivideo ranking either. Asking for `period=3d` (or the legacy `sort=3days`) returns the nearest real board and sets `fallback` so the UI can say so. The period tabs themselves are the periods that source exports, so a month board shows up as 1ヶ月 / 月間 instead of a mislabeled week.

The last site and its period are stored in `localStorage`.

## API

- `GET /api/sources` — id, name, color, periods.
- `GET /api/videos?source=85po&period=24h` — normalized videos. A source failure is `{ ok: false, error }` and does not affect the others.
- `GET /api/resolve?source=pornhub&id=...` — turn a `playback.kind: "resolve"` item into `file`, `hls`, or `embed`.
- `GET /api/external?source=twivideo&id=...` — original-post URL for sources that need a lookup.
- `GET /proxy/media?source=missav&url=...` — streams a URL whose host is on that source's allowlist, with that source's Referer. m3u8 responses are rewritten so segments and keys also go through the proxy. Private hosts and unknown hosts are rejected.

Rankings are cached per source and period for 30 minutes. Resolved media URLs are cached for 3 minutes because many of them are signed. A domain that already answered is reused until `DOMAIN_MEMORY_TTL_MS`, so a later period does not probe the failing domains again.

## Adding a source

1. Add `sources/<id>.js`. `<id>` must match `[a-z0-9_-]+`.
2. Register it with one line in `sources/index.js`.

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

## Tests

```bash
npm test
```

Parser tests use small HTML fixtures so a selector change is visible without the network. Live fetches depend on the sites and on Cloudflare.
