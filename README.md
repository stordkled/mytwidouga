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

The image is `node:22-bookworm-slim` and has no Chrome, because no source launches a browser at the moment. Rankings are plain HTTP. A block page, timeout, 403, or 5xx tries the next domain in that source's list. This app does not solve Cloudflare challenges or reuse clearance cookies.

## VPSに置く手順

友だちだけが見られるように、Ubuntu の VPS で動かす手順です。Caddy が HTTPS を担当し、アプリのコンテナはインターネットに直接公開しません。

### 必要なもの

| 項目 | 目安 |
| --- | --- |
| OS | Ubuntu 22.04 / 24.04 |
| CPU / メモリ | 1 vCPU / 1GB で少人数は可能。余裕を見るなら 2 vCPU / 2GB |
| ディスク | 10GB 以上の空き |
| 転送量 | 中継再生は動画の通信がすべて VPS を通ります。1本 2〜5Mbps なら 1 時間で約 1〜2GB。転送量の上限を必ず確認してください |
| ドメイン | A レコードを VPS の IP に向けたもの（HTTPS 証明書の取得に必要） |
| 開放ポート | 22（SSH）、80、443（TCP）、443（UDP、任意） |

これらは設計からの目安で、実際の VPS では計測していません。

### 1. Docker を入れる

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

ファイアウォールは、SSH を先に許可してから有効にします。順番を間違えると接続できなくなります。

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw enable
```

### 2. 取得して `.env` を作る

```bash
git clone <リポジトリのURL> shorts
cd shorts
openssl rand -hex 16   # 出力をパスワードとして使う
touch .env
chmod 600 .env
nano .env              # 下の内容を書く
```

`.env` の内容です。`$` や `#` を含む値は単一引用符で囲みます。

```dotenv
DOMAIN=shorts.example.com
BASIC_AUTH_USER=friend
BASIC_AUTH_PASS=ここに生成したパスワード
PORT=3000
APP_MEMORY_LIMIT=512m
```

### 3. 起動する

```bash
sudo docker compose up -d --build
sudo docker compose ps
```

`https://<DOMAIN>/` を開き、ユーザー名とパスワードを入れて動画が再生できれば完了です。友だちには URL とログイン情報を別々の経路で伝えてください。

### 環境変数

| 変数 | 必須 | 既定値 | 内容 |
| --- | --- | --- | --- |
| `DOMAIN` | Compose では必須 | なし | 公開するドメイン。 |
| `BASIC_AUTH_PASS` | Compose では必須 | なし | 共有パスワード。ローカルで未設定ならログインなしで動きます。 |
| `BASIC_AUTH_USER` | 任意 | `friend` | 共有ユーザー名。`:` は使えません。 |
| `PORT` | 任意 | `3000` | コンテナ内でアプリが待ち受けるポート。外向きは常に 80/443 です。 |
| `APP_MEMORY_LIMIT` | 任意 | `512m` | アプリのメモリ上限。 |
| `TRUST_PROXY` | Compose が設定 | `1` | Caddy からの転送情報を信頼します。アプリを直接公開するときは設定しないでください。 |
| `MAX_PROXY_STREAMS` など | 任意 | 下記参照 | 再生や中継の設定は「Domains, cache, and embeds」の表にあり、`.env` に書けば反映されます。 |

ログインに成功すると 30 日間有効な Cookie が発行されます。同じ接続元から 10 回失敗すると、その接続元は最大 15 分間ログインできません。

### 更新

```bash
cd shorts
git pull
sudo docker compose up -d --build
sudo docker image prune -f
```

パスワードを変えるときは `.env` を編集して `sudo docker compose up -d` を実行します。全員のログインが解除されます。

### ログと状態確認

```bash
sudo docker compose ps                 # 動作状況とヘルスチェック
sudo docker compose logs -f app        # アプリのログ
sudo docker compose logs -f caddy      # HTTPS 証明書や接続のログ
curl -u friend https://<DOMAIN>/api/status   # パスワードを聞かれます
```

### 注意点

- **再生できるサイトは家と変わることがあります。** データセンターの IP は配信元にブロックされやすく、一部のソースが表示されない場合があります。
- **利用規約を確認してください。** アダルトコンテンツの中継を禁止している VPS があります。配信元サイトの規約と、利用者が成人であることも確認してください。
- **`.env` は共有もコミットもしないでください。** `.gitignore` と `.dockerignore` で除外済みです。
- **`docker compose down -v` は使わないでください。** 証明書のボリュームも消えます。停止だけなら `sudo docker compose down` です。
- **Chrome はイメージに入っていません。** 今のソースは使っていません。将来必要になったら、Chrome を含むイメージに変更し `PUPPETEER_EXECUTABLE_PATH` を設定してください。

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
| `SOURCE_ENABLED_TWIKEEP` | `1`/`0` overrides `"enabled"` for one source. Same pattern for `TWIHOZON` and the others. |
| `SOURCE_START_OFFSET_PORNHUB` | Seconds a video starts and loops back to. Overrides `"startOffsetSec"` for that source (Pornhub 5, others 0); `0` turns it off. A video no longer than the offset starts at 0. The seek bar can still go before it. Pornhub's embed fallback also starts at the offset: a local player uses the existing relay when enabled. With `FULL_PROXY=0`, it selects media that can play without a Referer or server IP binding and loads it directly (HLS also needs CDN CORS support). Videos exposing only relay-dependent media cannot play in this mode. |
| `BROWSER_IDLE_MS` | Headless Chrome (if a source uses it) is closed after this long without a page. Default 5 minutes. |

`config/sources.json` is re-read when its modification time changes (checked at most every 2 seconds), so edits apply without a restart. `GET /api/status` includes `domains.<id>.active`, `expiresAt`, `candidates`, the playback settings, and `proxy` (`activeStreams`, `waiting`, `clients`).

`twivideo` is `"hidden": true` in the shipped config: from this network it answers with a Cloudflare page, so it is not offered and the server does not probe it on every start.

**TwiKeep and Twihozon are currently off** (`"enabled": false` in `config/sources.json`). They are not in the switcher or feed, and their rankings are not fetched. Saved bookmarks stay and can still play. `GET /api/status` lists them in `disabledSources`. To bring one back, remove that line or set `SOURCE_ENABLED_TWIKEEP=1` / `SOURCE_ENABLED_TWIHOZON=1`.

The switcher order is the order in `sources/index.js`: Pornhub, 85po, TokyoMotion (hidden `twivideo` and the disabled TwiKeep and Twihozon keep their registry positions in the API but are not shown). Automatic switching after a failure follows the same order.

Thumbnails load straight from the CDN with `referrerpolicy=no-referrer`. If that image fails, that source's posters fall back to `/proxy/media`. Set `SOURCE_THUMBS_85PO=proxy` (or `direct`) to skip the probe. A source whose ranking keeps failing is removed from the switcher (`hideFailedSources`, default on, after `hideAfterFailures` consecutive failures, default 3; a block page counts as one failure like any other). A hidden source comes back after `hiddenRetryMs` (default 10 minutes, `HIDDEN_RETRY_MS`); one success clears its record, one more failure hides it again. `HIDE_FAILED_SOURCES=0` keeps every tab. When a ranking fails the feed moves to the next source that is neither hidden nor already failed, and the note bar says why; when none is left it stops and shows a retry button. TwiKeep takes `/api/videos?metric=downloads|views` (the bottom bar has a 保存数/表示数 toggle), and each metric is cached separately.

## Playback ladder

In `auto`, each source remembers the first step that starts playback:

1. **direct** — the viewer's `<video>` loads the MP4 or HLS URL from the CDN. The page sends no referrer. Safari plays HLS natively; other browsers use hls.js when the CDN allows CORS.
2. **playlist-proxy** — `/proxy/playlist` rewrites only the m3u8. Segment URLs stay on the CDN.
3. **proxy** — the full relay, only while `fullProxyEnabled` is true and fewer than `maxProxyStreams` relays are open.
4. **embed** — `getEmbedUrl`, in a sandboxed iframe (`allow-scripts allow-same-origin allow-presentation`, no popups or top navigation) with `autoplay=1&muted=1` added when the URL accepts a query. A transparent layer keeps vertical swipes on the feed and forwards a tap to the player. The rank and title stay on top of the iframe. The next card is preloaded unless that would open a full relay.

The step that worked is remembered per source and media kind for 30 minutes (memory and `shorts.ladder` in `localStorage`) and tried first next time; the other steps stay behind it, and a remembered step that fails is forgotten. An embed is never remembered. A step without data gives up after 6 s (direct), 7 s (playlist-proxy) or 12 s (full relay, which may wait in the 8 s queue). An HLS step counts as working only once a video frame is decoded; if a segment has arrived by the deadline, it gets 3 s more for that frame.

While a video plays, the next two cards are resolved. The next one buffers (`preload="auto"`) and the one after loads metadata when they can play direct; cards further away are released. Media that needs the full relay is resolved but not buffered ahead, because a viewer has two relay slots and the playing video holds one.

**Timings**: `GET /api/status` has `timings` (per `source:stage`: `ranking`, `resolve`, their `-cached` forms, `proxy-first-byte`; count, p50, p95, max). In the browser console, `shortsTimings()` reports `startup` (from page open), `swipe` (from the moment the card starts playing, so the scroll itself is not counted), their `-resolve` part, `mode-<step>` (the whole wait until that step played) and `step-<step>-ok|fail` (that step alone) in ms.

**Measured before/after** (plan 6b033497, 2026-11-21 15:01–15:37 JST): `bbeb7b9` on :3951 and this change on :3952 ran side by side on the same Windows PC and connection, each starting with an empty memory cache. Headless Chrome (412×860, muted autoplay) opened a new incognito context for every trial, so its cache and `localStorage` were empty (only `shorts.source` was set). The two versions took turns, and the feed used the default weighted random order. *Startup* runs from navigation to the first `<video>` `playing`, 5 trials per source with a 45 s timeout. *Swipe* runs from scrolling to the next card, after 4 s of viewing, until that card or the card skipped to plays, 10 per source with a 30 s timeout. An iframe embed has no `playing` event, so embeds are counted but left out of the medians. Values are median / p95 / failures.

| Source | Startup before | Startup after | Swipe before | Swipe after |
| --- | --- | --- | --- | --- |
| Pornhub | 7.52 s / 9.51 s / 0 | 4.47 s / 5.00 s / 0 (−41%) | 4.77 s / 7.16 s / 0 | 1.77 s / 2.41 s / 0 (−63%) |
| 85po | 3.74 s / 20.86 s / 0 | 3.76 s / 3.96 s / 0 | 2.27 s for the first (direct); the other 9 fell to a preloaded embed | 0.01 s / 0.01 s / 0 (all 10 direct) |
| TwiKeep | 1.45 s / 17.38 s / 0 | 1.35 s / 13.24 s / 0 | 0.05 s / 0.11 s / 0 | 0.01 s / 0.01 s / 0 |
| Twihozon | 5 of 5 failed | 5 of 5 failed | not measured | not measured |
| TokyoMotion | 21.38 s / 26.28 s / 0 (3 valid) | 16.74 s / 25.16 s / 0 | 8 of 8 failed | 9 of 10 failed (the one success: 14.77 s) |

Where the time went, from browser Resource Timing (median before → after):
- **Startup resolve:** Pornhub 4.8 s → 2.5 s.
- **Swipe resolve:** no `/api/resolve` call follows a swipe any more because the next card was resolved ahead. Before, the call took 3.2 s (Pornhub) and 4 ms (85po).
- **Ranking:** 2–4 ms with a warm cache in both versions.
- **Proxy first byte:** Pornhub 144 → 152 ms at startup and 453 → 480 ms on a swipe.

Limits:
- **Upstream sources:** Twihozon's top ~19 videos were deleted upstream (`video.twimg.com` answered 403/404), so both versions kept skipping until the timeout. TokyoMotion detail pages timed out on the server in both versions during the run, and the swipe run was stopped early. Neither result reflects this change.
- **Excluded samples:** one TokyoMotion startup before the change opened Pornhub instead and is excluded, and one played as an embed.
- **Method:** these are headless runs, not a phone. Small samples make p95 close to the maximum, and the two versions did not always play the same videos. Startup ran with empty storage, so it leaves out the `shorts.boot` early board fetch.

Raw data: `mytwidouga-6b033497-perf-20261121-1536.json` (kept outside the repository).

The media URL is resolved when the card is about to play, unless a preload already did. If that attempt fails, the app resolves once more, then steps down for that video. A datacenter and a phone can land on different steps when a CDN binds the URL to the IP that resolved it. `PLAYBACK_MODE=embed` skips straight to the iframe. Headless Chrome, if used, is limited to one page.

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

**ランダム順（デフォルト）**: each ranking plays in a weighted random order (Efraimidis–Spirakis, `key = random^(1/weight)`, no repeats), reshuffled on every load or source/period/metric switch. The weight comes from saves (TwiKeep 保存数, Twihozon 保存) > likes > views > board rank, with "1.2K" / "12,345" / "1万" parsed, log-compressed, curved (squared, `WEIGHT_CURVE = 2`) so the popular end of a board comes up front clearly, and floored (`MIN_WEIGHT = 0.05`, about 1/20 of the top) so lower videos still turn up now and then. On a 24-video board ranked by position only, No.1 opens about 1 time in 5 and one of the top five about 6 times in 10, versus 1 in 24 and 5 in 24 for a plain shuffle; the bottom bar's ランダム/ランキング順 button switches back to the board order (`shorts.order` in `localStorage`). The ブクマ list is not shuffled. The logic lives in `src/feed-logic.js` (`orderFeed`, `appendFeed`, `feedWeights`). `/api/videos` serves a board 24 videos at a time (`&page=2`, `hasMore`); scrolling near the end fetches the next page, orders it the same way, and appends it without repeating a video already in the feed.

The last site and its period are stored in `localStorage`. A browser with nothing saved opens on Pornhub (`DEFAULT_SOURCE_ID` in `src/feed-logic.js`; the first offered source, normally 85po, if Pornhub is hidden). A saved site that is hidden or no longer exists falls back the same way; one the server no longer has (MissAV, for example) is also cleared from `localStorage`.

**シークバー**: each card has a seek bar at the bottom with the current time and the length (`1:05 / 3:20`). Tap or drag it (touch or mouse) to jump; the seek happens on release, so a drag over a relayed video opens one new range request instead of one per move. On a computer ←/→ move 5 seconds. It works the same for direct, playlist-proxy (HLS) and full proxy playback because all three play in the card's own `<video>`. An embed (iframe) hides it. Until something seekable is loaded, or for a stream of unknown length, it shows `--:--` (or `LIVE`) and is not draggable; a live HLS window is seekable inside the window. The strip is its own touch target above the play/pause layer with `touch-action: none` and pointer capture, so a drag on it never swipes to the next video and a tap on it never counts toward a double-tap いいね. Time formatting and the position math are `formatTime`, `seekInfo`, `seekRatio`, `seekTarget`, `seekBy` and `seekbarState` in `src/feed-logic.js`.

**ブクマ（いいね一覧）**: ♥ (or a double tap) saves the video in `localStorage` (`shorts.bookmarks`: source, id, page URL, title, thumbnail, liked time, and the original `playback` object for the usual ladder), newest first, at most 500 (the oldest is dropped; a full or broken storage trims or is ignored instead of crashing). The ブクマ button at the right of the site bar plays them in the same vertical feed; a video that no longer plays is skipped with a note but stays in the list until you tap ♥ again, and the bottom bar returns to the ranking.

## API

- `GET /api/sources` — id, name, color, periods.
- `GET /api/videos?source=85po&period=24h` — normalized videos. A source failure is `{ ok: false, error }` and does not affect the others.
- `GET /api/resolve?source=pornhub&id=...` — turn a `playback.kind: "resolve"` item into `file`, `hls`, or `embed`.
- `GET /api/external?source=twivideo&id=...` — original-post URL for sources that need a lookup.
- `GET /proxy/media?source=pornhub&url=...` — streams a URL whose host is on that source's allowlist, with that source's Referer. m3u8 responses are rewritten so segments and keys also go through the proxy. Private hosts and unknown hosts are rejected.

Rankings are cached per source and period for 30 minutes. Resolved media URLs are cached for 3 minutes because many of them are signed, or until 20 seconds before the expiry the URL itself names if that is sooner; an embed fallback is kept for 30 seconds. A domain that already answered is reused until `DOMAIN_MEMORY_TTL_MS`, so a later period does not probe the failing domains again.

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
