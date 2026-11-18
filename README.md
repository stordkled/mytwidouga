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

The image is `ghcr.io/puppeteer/puppeteer` and must set `PUPPETEER_EXECUTABLE_PATH` (the base image does). Chrome is launched on demand, only for sources that need JavaScript or a Cloudflare challenge.

## Sources

| id | Site | Periods | How it is fetched |
| --- | --- | --- | --- |
| `twivideo` | twivideo.net | 24時間 / 1週間 / 1ヶ月 | Headless Chrome. Direct MP4 on twimg. |
| `pornhub` | pornhub.com | 24時間 / 1週間 / 1ヶ月 (`/video?o=mv&t=t\|w\|m`) | HTTP, then Chrome if the safe-for-work redirect gets in the way. Playback is resolved from `mediaDefinitions` (HLS) with an embed iframe fallback. |
| `85po` | 85po.com, falling back to 85po.net | 24時間 / 1週間 / 1ヶ月 | HTTP. KVS async block `sort_by=video_viewed_today\|week\|month`. MP4 via `get_file`. |
| `tokyomotion` | tokyomotion.net | 今日 / 今週 / 今月 | HTTP. Most viewed among videos added in that window (`/videos?o=mv&t=t\|w\|m`). MP4 via `/vsrc/`. |
| `missav` | missav.ws (then missav.ai, missav.live, missav123.com) | 今日 / 週間 / 月間 | Headless Chrome. `/ja/today-hot`, `/ja/weekly-hot`, `/ja/monthly-hot`. HLS on surrit.com. |

None of these sites publish a 3-day board. The old 3-day tab did not map to a twivideo ranking either. Asking for `period=3d` (or the legacy `sort=3days`) returns the nearest real board and sets `fallback` so the UI can say so. The period tabs themselves are the periods that source exports, so a month board shows up as 1ヶ月 / 月間 instead of a mislabeled week.

The last site and its period are stored in `localStorage`.

## API

- `GET /api/sources` — id, name, color, periods.
- `GET /api/videos?source=85po&period=24h` — normalized videos. A source failure is `{ ok: false, error }` and does not affect the others.
- `GET /api/resolve?source=pornhub&id=...` — turn a `playback.kind: "resolve"` item into `file`, `hls`, or `embed`.
- `GET /api/external?source=twivideo&id=...` — original-post URL for sources that need a lookup.
- `GET /proxy/media?source=missav&url=...` — streams a URL whose host is on that source's allowlist, with that source's Referer. m3u8 responses are rewritten so segments and keys also go through the proxy. Private hosts and unknown hosts are rejected.

Rankings are cached per source and period (10 minutes). Resolved media URLs are cached for 90 seconds because many of them are signed. Each fetch has its own timeout.

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
  mediaHosts: ['example.com', 'cdn.example.net'],
  mediaReferer: 'https://example.com/',
  cacheTtlMs: 10 * 60 * 1000,   // optional
  timeoutMs: 25000,             // optional

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

Use `lib/http.js` `getText` for ordinary pages. Use `lib/browser.js` `gotoHtml` when the page is a Cloudflare challenge or the markup is rendered by JavaScript. `gotoHtml` waits out a "Just a moment" / 「しばらくお待ちください」 interstitial and throws if Cloudflare hard-blocks the network, so one blocked site does not take the process down.

If the site has no period for a tab the user might still request (`3d` is the usual one), do not invent a URL. Omit that period. The registry answers with the nearest period and a `fallbackReason`.

## Tests

```bash
npm test
```

Parser tests use small HTML fixtures so a selector change is visible without the network. Live fetches depend on the sites and on Cloudflare.
