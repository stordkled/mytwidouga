/* Pure feed decisions shared by src/main.js (window.FeedLogic) and the
   Node tests (require). No DOM access here. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.FeedLogic = api;
}(typeof self !== 'undefined' ? self : this, () => {
    // `page` (2, 3, ...) asks for the next page of the same board.
    function videosUrl(sourceId, period, metric, page) {
        let url = `/api/videos?source=${encodeURIComponent(sourceId)}&period=${encodeURIComponent(period || '')}`;
        if (metric) url += `&metric=${encodeURIComponent(metric)}`;
        if (Number.isInteger(page) && page > 1) url += `&page=${page}`;
        return url;
    }

    // Infinite scroll: fetch the next page once the viewer is this close to
    // the end of the feed, unless one is already on its way.
    const LOAD_MORE_AHEAD = 3;

    function shouldLoadMore({ index, total, hasMore, loading }) {
        if (!hasMore || loading) return false;
        return index >= total - LOAD_MORE_AHEAD;
    }

    // The source id is the video's own, never "whatever is selected now":
    // a late re-resolve after a source switch must not ask the new source
    // for the old source's video id.
    function resolveUrl(sourceId, videoId, fresh) {
        return `/api/resolve?source=${encodeURIComponent(sourceId)}&id=${encodeURIComponent(videoId)}${fresh ? '&fresh=1' : ''}`;
    }

    // Sources for the switcher: the non-hidden ones, plus the current one so
    // the user can see where they are. If every source is hidden, show all
    // (the user may still pick one by hand). A source disabled in config is
    // never offered, not even as the current one.
    function barSources(sources, currentId) {
        const all = (sources || []).filter((source) => source.enabled !== false);
        // Only the current one (or nothing) left visible: that is "every
        // source hidden" from the user's point of view, so offer them all.
        if (!all.some((source) => !source.hidden)) return all.slice();
        return all.filter((source) => !source.hidden || source.id === currentId);
    }

    // The source a page opens on. The one this browser saved, if it is still
    // offered; otherwise Pornhub; otherwise the first offered one (85po in
    // the registry order). A saved id the server no longer has (a removed
    // source) or a hidden one falls through to the default instead of failing.
    const DEFAULT_SOURCE_ID = 'pornhub';

    function initialSource(offered, savedId) {
        const list = offered || [];
        return list.find((source) => source.id === savedId)
            || list.find((source) => source.id === DEFAULT_SOURCE_ID)
            || list[0]
            || null;
    }

    // Merge a fresh /api/sources answer into the client list: the server's
    // hidden flag (which clears after hiddenRetryMs) wins, so a hidden
    // source comes back on an open page without a reload.
    function mergeSourceStatus(sources, fresh) {
        const byId = new Map((fresh || []).map((source) => [source.id, source]));
        return (sources || []).map((source) => {
            const update = byId.get(source.id);
            if (!update) return source;
            return {
                ...source,
                enabled: update.enabled !== false,
                hidden: Boolean(update.hidden),
                retryLater: Boolean(update.retryLater),
            };
        });
    }

    // How often an open page re-asks /api/sources while a source is hidden
    // only for a while (config-hidden ones never come back, so no polling).
    const SOURCES_REFRESH_MS = 60000;

    function needsSourceRefresh(sources, lastRefreshAt, now) {
        if (!(sources || []).some((source) => source.hidden && source.retryLater)) return false;
        return !lastRefreshAt || now - lastRefreshAt >= SOURCES_REFRESH_MS;
    }

    // Where to go automatically after `currentId` failed. Never a hidden
    // source and never one that already failed in this chain, so when every
    // source fails the feed stops instead of cycling through them.
    function fallbackSource(sources, currentId, failedIds) {
        const failed = failedIds instanceof Set ? failedIds : new Set(failedIds || []);
        return (sources || []).find((source) => (
            source.id !== currentId && source.enabled !== false && !source.hidden && !failed.has(source.id)
        )) || null;
    }

    const REASONS = {
        blocked: 'このネットワークから開けません',
        timeout: '応答がありません',
        empty: 'ランキングが空でした',
        http: 'サイトがエラーを返しました',
        error: '読み込みに失敗しました',
        disabled: '設定で無効になっています',
    };

    function reasonText(reason) {
        return REASONS[reason] || REASONS.error;
    }

    // Shown in the note bar when the feed moves to another source by itself.
    function switchNote(fromName, toName, reason, hidden) {
        const tail = hidden ? '（しばらく非表示）' : '';
        return `${fromName}: ${reasonText(reason)}${tail} → ${toName} に切り替えました`;
    }

    function joinNotes(...notes) {
        return notes.filter(Boolean).join(' / ');
    }

    // Is a playback attempt still the one on screen?
    function playbackCurrent(attempt, now) {
        return Boolean(attempt && now
            && attempt.token === now.token
            && attempt.index === now.index
            && attempt.sourceId === now.sourceId);
    }

    // After a failed ladder step: fetch a fresh URL once, but only for
    // "resolve" videos and only while this attempt is still on screen.
    function shouldReResolve({ ok, mode, alreadyResolved, kind, current }) {
        return !ok && mode !== 'embed' && !alreadyResolved && kind === 'resolve' && Boolean(current);
    }

    // A <video> that has no data after this long, or that the browser has
    // already given up on (NETWORK_NO_SOURCE), is a failed step. Longer than
    // the relay queue wait (proxyQueueMs, 8 s) so a queued proxy still counts.
    const STALL_MS = 12000;

    function mediaStalled({ readyState, networkState, elapsedMs, stallMs }) {
        if (readyState >= 1) return false;
        if (networkState === 3) return true;
        return elapsedMs >= (stallMs > 0 ? stallMs : STALL_MS);
    }

    // ---- Faster start ------------------------------------------------------
    // How long one ladder step may sit without data. Only the full relay can
    // wait in the server's queue (proxyQueueMs, 8 s), so only it keeps STALL_MS.
    const STEP_TIMEOUT_MS = { direct: 6000, 'playlist-proxy': 7000, proxy: STALL_MS };

    function stepTimeoutMs(mode) {
        return STEP_TIMEOUT_MS[mode] || STALL_MS;
    }

    // Try the step that worked last time first, then the rest in ladder
    // order, so a wrong memory still reaches every step.
    function orderModes(modes, learned) {
        const list = Array.isArray(modes) ? modes.slice() : [];
        if (!learned || !list.includes(learned)) return list;
        return [learned, ...list.filter((mode) => mode !== learned)];
    }

    const LADDER_MEMORY_TTL_MS = 30 * 60 * 1000;
    // An embed always "succeeds" (nothing can observe the iframe), so it is
    // never remembered: it would hide the working <video> steps.
    const LEARNABLE_MODES = ['direct', 'playlist-proxy', 'proxy'];

    // Last working step per source and media kind (file / hls), in memory and
    // mirrored to storage. Broken or unavailable storage only loses the memory.
    function createLadderMemory(storage, key, options = {}) {
        const ttlMs = options.ttlMs > 0 ? options.ttlMs : LADDER_MEMORY_TTL_MS;
        const clock = typeof options.now === 'function' ? options.now : Date.now;
        const entries = new Map();
        try {
            const raw = storage ? storage.getItem(key) : null;
            const parsed = raw ? JSON.parse(raw) : null;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                Object.entries(parsed).forEach(([name, entry]) => {
                    if (entry && LEARNABLE_MODES.includes(entry.mode) && Number.isFinite(entry.expires)) {
                        entries.set(name, { mode: entry.mode, expires: entry.expires });
                    }
                });
            }
        } catch { /* start empty */ }

        const nameOf = (sourceId, kind) => `${sourceId}:${kind}`;
        const persist = () => {
            try {
                if (storage) storage.setItem(key, JSON.stringify(Object.fromEntries(entries)));
            } catch { /* kept for this page */ }
        };

        return {
            get(sourceId, kind) {
                const name = nameOf(sourceId, kind);
                const hit = entries.get(name);
                if (!hit) return null;
                if (hit.expires <= clock()) {
                    entries.delete(name);
                    persist();
                    return null;
                }
                return hit.mode;
            },
            set(sourceId, kind, mode) {
                if (!LEARNABLE_MODES.includes(mode)) return;
                entries.set(nameOf(sourceId, kind), { mode, expires: clock() + ttlMs });
                persist();
            },
            forget(sourceId, kind) {
                if (entries.delete(nameOf(sourceId, kind))) persist();
            },
        };
    }

    // Signed CDN URLs name their own end time. Seconds or milliseconds; a
    // small number under one of these names is not a timestamp.
    const EXPIRY_PARAMS = ['validto', 'expires', 'expire', 'exp', 'e'];
    const SIGNED_URL_MARGIN_MS = 20000;
    const EMBED_RESOLVE_TTL_MS = 30000;
    const CLIENT_RESOLVE_TTL_MS = 60000;

    function signedUrlExpiry(url) {
        let params;
        try {
            params = new URL(url).searchParams;
        } catch {
            return null;
        }
        for (const name of EXPIRY_PARAMS) {
            const raw = params.get(name);
            if (raw == null || !/^\d+$/.test(raw)) continue;
            const value = Number(raw);
            if (value >= 1e12) return value;
            if (value >= 1e9) return value * 1000;
        }
        return null;
    }

    function playbackFresh(playback, now) {
        if (!playback || !playback.url) return true;
        const expiry = signedUrlExpiry(playback.url);
        return expiry == null || expiry - SIGNED_URL_MARGIN_MS > now;
    }

    // How long the server may keep one resolve result. 0 means "do not
    // store". An embed is usually the fallback after a transient failure, so
    // it is kept only briefly and the real media gets another chance.
    function resolveCacheTtl(playback, baseTtlMs, now) {
        let ttl = baseTtlMs;
        if (playback && playback.kind === 'embed') ttl = Math.min(ttl, EMBED_RESOLVE_TTL_MS);
        const expiry = playback && playback.url ? signedUrlExpiry(playback.url) : null;
        if (expiry != null) ttl = Math.min(ttl, expiry - SIGNED_URL_MARGIN_MS - now);
        return Math.max(0, ttl);
    }

    // Cards around the one on screen: the next gets buffered, the one after
    // gets metadata, anything further is released.
    const PRELOAD_AHEAD = 2;

    function keepWarm(cardIndex, currentIndex) {
        const distance = cardIndex - currentIndex;
        return distance >= 1 && distance <= PRELOAD_AHEAD;
    }

    function preloadLevel(offset) {
        if (offset === 1) return 'auto';
        return offset === 2 ? 'metadata' : 'none';
    }

    // Cards built at once; the rest follow after the first video starts, so
    // 24 posters do not compete with it for connections.
    const INITIAL_CARDS = 4;

    // The first page of the board this browser opened last, fetched alongside
    // /api/sources at startup. Only a plain first-page videos URL qualifies.
    function isBootUrl(url) {
        return typeof url === 'string'
            && /^\/api\/videos\?source=[^&]+&period=[^&]*(?:&metric=[^&]+)?$/.test(url);
    }

    // The startup request for a board; the server declines it for a source
    // that is hidden now, without contacting that source.
    function bootRequestUrl(url) {
        return `${url}&boot=1`;
    }

    // An HLS step has worked once the element holds a decoded video frame.
    // Loaded fragments alone do not show that: they may be audio only.
    const HLS_FIRST_FRAME_GRACE_MS = 3000;

    function hlsFrameReady({ readyState, videoWidth, hasError }) {
        return !hasError && readyState >= 2 && videoWidth !== 0;
    }

    // Small rolling timing log: per label, the last `limit` samples.
    function createTimingLog(limit = 200, maxLabels = 128) {
        const samples = new Map();
        const percentile = (sorted, share) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
        return {
            add(label, ms) {
                if (!Number.isFinite(ms) || ms < 0) return;
                let list = samples.get(label);
                if (!list) {
                    if (samples.size >= maxLabels) return;
                    list = [];
                    samples.set(label, list);
                }
                list.push(Math.round(ms));
                if (list.length > limit) list.shift();
            },
            summary() {
                const out = {};
                [...samples.keys()].sort().forEach((label) => {
                    const sorted = samples.get(label).slice().sort((a, b) => a - b);
                    out[label] = {
                        count: sorted.length,
                        p50: percentile(sorted, 0.5),
                        p95: percentile(sorted, 0.95),
                        max: sorted[sorted.length - 1],
                    };
                });
                return out;
            },
        };
    }

    function nextMetric(metrics, current) {
        const list = (metrics || []).map((metric) => metric.id);
        if (list.length === 0) return '';
        const at = list.indexOf(current);
        return list[(at + 1) % list.length];
    }

    function pickMetric(source, saved) {
        if (!source || !Array.isArray(source.metrics) || source.metrics.length === 0) return '';
        if (source.metrics.some((metric) => metric.id === saved)) return saved;
        return source.defaultMetric || source.metrics[0].id;
    }

    // ---- Bookmarks (いいね一覧) ---------------------------------------------
    // Stored newest first as JSON under one localStorage key. Each entry has
    // just enough to list it and to hand it back to the playback ladder:
    // the original `playback` object (file / hls / embed / resolve) is kept
    // as the ranking delivered it, and a "resolve" one is re-resolved by
    // source + id when it plays.
    const BOOKMARK_LIMIT = 500;
    const PLAYBACK_KINDS = ['file', 'hls', 'embed', 'resolve'];

    function str(value, max) {
        if (value == null) return '';
        return String(value).slice(0, max || 2000);
    }

    function bookmarkKey(sourceId, videoId) {
        return `${sourceId}\u0000${videoId}`;
    }

    function cleanPlayback(playback) {
        if (!playback || typeof playback !== 'object' || !PLAYBACK_KINDS.includes(playback.kind)) return null;
        const out = {
            kind: playback.kind,
            url: playback.url ? str(playback.url) : null,
            embedUrl: playback.embedUrl ? str(playback.embedUrl) : null,
        };
        if (playback.referer) out.referer = str(playback.referer);
        if (playback.needsReferer) out.needsReferer = true;
        return out;
    }

    // A feed video (as /api/videos returned it) -> a stored entry, or null
    // when it lacks what playback needs.
    function bookmarkFromVideo(video, sourceId, now) {
        if (!video || video.id == null || video.id === '' || !sourceId) return null;
        const playback = cleanPlayback(video.playback);
        if (!playback) return null;
        const likedAt = Number.isFinite(now) ? now : Date.now();
        return {
            sourceId: str(sourceId, 64),
            id: str(video.id, 80),
            pageUrl: str(video.pageUrl),
            externalUrl: str(video.externalUrl || video.pageUrl),
            title: str(video.title, 300),
            thumbUrl: str(video.thumbUrl),
            duration: str(video.duration, 32),
            lookup: Boolean(video.lookup),
            likedAt,
            playback,
        };
    }

    // Validate one stored entry (anything from localStorage may be garbage).
    function cleanBookmark(entry) {
        if (!entry || typeof entry !== 'object') return null;
        if (typeof entry.sourceId !== 'string' || !entry.sourceId) return null;
        if (entry.id == null || entry.id === '') return null;
        const playback = cleanPlayback(entry.playback);
        if (!playback) return null;
        return {
            sourceId: str(entry.sourceId, 64),
            id: str(entry.id, 80),
            pageUrl: str(entry.pageUrl),
            externalUrl: str(entry.externalUrl || entry.pageUrl),
            title: str(entry.title, 300),
            thumbUrl: str(entry.thumbUrl),
            duration: str(entry.duration, 32),
            lookup: Boolean(entry.lookup),
            likedAt: Number.isFinite(entry.likedAt) ? entry.likedAt : 0,
            playback,
        };
    }

    function limitOf(limit) {
        return typeof limit === 'number' && limit >= 0 ? limit : BOOKMARK_LIMIT;
    }

    // Newest first, one entry per source+id, at most `limit` (oldest dropped).
    function normalizeBookmarks(list, limit) {
        const max = limitOf(limit);
        const seen = new Set();
        const out = [];
        (Array.isArray(list) ? list : []).forEach((entry, order) => {
            const clean = cleanBookmark(entry);
            if (!clean) return;
            const key = bookmarkKey(clean.sourceId, clean.id);
            if (seen.has(key)) return;
            seen.add(key);
            out.push({ clean, order });
        });
        out.sort((a, b) => (b.clean.likedAt - a.clean.likedAt) || (a.order - b.order));
        return out.slice(0, max).map((item) => item.clean);
    }

    // Read the list. A missing, unreadable or corrupt value is an empty list,
    // never an exception.
    function loadBookmarks(storage, key, limit) {
        let raw = null;
        try {
            raw = storage ? storage.getItem(key) : null;
        } catch {
            return [];
        }
        if (!raw) return [];
        try {
            return normalizeBookmarks(JSON.parse(raw), limit);
        } catch {
            return [];
        }
    }

    // Write the list. On a quota error the oldest half is dropped and it
    // tries again, so the newest likes survive. Returns what was stored.
    function saveBookmarks(storage, key, list) {
        let items = Array.isArray(list) ? list.slice() : [];
        if (!storage) return { ok: false, saved: items, trimmed: 0 };
        const total = items.length;
        for (;;) {
            try {
                storage.setItem(key, JSON.stringify(items));
                return { ok: true, saved: items, trimmed: total - items.length };
            } catch {
                if (items.length === 0) return { ok: false, saved: Array.isArray(list) ? list.slice() : [], trimmed: 0 };
                items = items.slice(0, Math.floor(items.length / 2));
            }
        }
    }

    function isBookmarked(list, sourceId, videoId) {
        if (videoId == null) return false;
        const key = bookmarkKey(sourceId, String(videoId));
        return (list || []).some((entry) => bookmarkKey(entry.sourceId, entry.id) === key);
    }

    function addBookmark(list, video, sourceId, now, limit) {
        const current = list || [];
        if (isBookmarked(current, sourceId, video && video.id)) return current.slice();
        const entry = bookmarkFromVideo(video, sourceId, now);
        if (!entry) return current.slice();
        return [entry, ...current].slice(0, limitOf(limit));
    }

    function removeBookmark(list, sourceId, videoId) {
        const key = bookmarkKey(sourceId, String(videoId));
        return (list || []).filter((entry) => bookmarkKey(entry.sourceId, entry.id) !== key);
    }

    // Like / unlike. `liked` is the state after the toggle.
    function toggleBookmark(list, video, sourceId, now, limit) {
        if (!video || video.id == null) return { list: (list || []).slice(), liked: false };
        if (isBookmarked(list, sourceId, video.id)) {
            return { list: removeBookmark(list, sourceId, video.id), liked: false };
        }
        const next = addBookmark(list, video, sourceId, now, limit);
        return { list: next, liked: isBookmarked(next, sourceId, video.id) };
    }

    // Stored entries -> feed videos (newest first) for the same card UI.
    function bookmarkVideos(list) {
        const entries = normalizeBookmarks(list, Infinity);
        return entries.map((entry, index) => ({
            id: entry.id,
            title: entry.title,
            rank: 0,
            rankLabel: `${index + 1}/${entries.length}`,
            pageUrl: entry.pageUrl,
            thumbUrl: entry.thumbUrl,
            duration: entry.duration,
            views: '',
            externalUrl: entry.externalUrl,
            lookup: entry.lookup,
            playback: { ...entry.playback },
            likedAt: entry.likedAt,
            _sourceId: entry.sourceId,
            _bookmark: true,
        }));
    }

    // ---- いいね一覧: 一覧 / ランダム再生 -------------------------------------
    // "list" plays the likes newest first (as before); "random" plays every
    // like, from any source, in a plain uniform shuffle (not the weighted
    // ranking order). Anything else stored is "list".
    const BOOKMARK_ORDERS = ['list', 'random'];
    const DEFAULT_BOOKMARK_ORDER = 'list';

    function pickBookmarkOrder(saved) {
        return BOOKMARK_ORDERS.includes(saved) ? saved : DEFAULT_BOOKMARK_ORDER;
    }

    // Can the playback ladder try this video at all? A "resolve" one asks the
    // server by source + id (that works for disabled sources too); the others
    // need a media URL or an embed URL. Whether it really plays is found out
    // when it plays (a failure skips to the next card).
    function bookmarkPlayable(video) {
        const playback = video && video.playback;
        if (!playback || video.id == null || video.id === '') return false;
        if (playback.kind === 'resolve') return true;
        return Boolean(playback.url || playback.embedUrl);
    }

    // Fisher–Yates: every order equally likely. `rng` returns [0, 1).
    function shuffleList(items, rng) {
        const random = typeof rng === 'function' ? rng : Math.random;
        const list = Array.isArray(items) ? items.slice() : [];
        for (let i = list.length - 1; i > 0; i -= 1) {
            let u = Number(random());
            if (!(u >= 0)) u = 0;
            if (u >= 1) u = 1 - Number.EPSILON;
            const j = Math.floor(u * (i + 1));
            [list[i], list[j]] = [list[j], list[i]];
        }
        return list;
    }

    // Feed videos from bookmarkVideos() in the chosen order. "random" leaves
    // out entries that have nothing to play (they stay stored and are still
    // in the 一覧, where they can be unliked) and renumbers the badges.
    function orderBookmarkVideos(list, order, rng) {
        const items = Array.isArray(list) ? list : [];
        if (pickBookmarkOrder(order) !== 'random') return items.slice();
        const shuffled = shuffleList(items.filter(bookmarkPlayable), rng);
        return shuffled.map((video, index) => ({ ...video, rankLabel: `${index + 1}/${shuffled.length}` }));
    }

    // ---- Source switching by swipe / Shift+←→ ------------------------------
    // The neighbour of `currentId` among `list` (the sources the bar offers),
    // looping at both ends. `step` > 0 is the next one, < 0 the previous one.
    // A current id not in the list starts from the first (next) or the last
    // (previous). Null when there is nothing else to go to.
    function stepSource(list, currentId, step) {
        const items = Array.isArray(list) ? list.filter(Boolean) : [];
        if (items.length === 0 || !step) return null;
        const at = items.findIndex((source) => source.id === currentId);
        if (at < 0) return step > 0 ? items[0] : items[items.length - 1];
        if (items.length < 2) return null;
        const move = step > 0 ? 1 : -1;
        return items[(at + move + items.length) % items.length];
    }

    // A horizontal swipe is at least this long and clearly more sideways
    // than up/down, so a vertical swipe (next video) or a tap never counts.
    const SWIPE_MIN_PX = 60;
    const SWIPE_RATIO = 1.8;

    // Finger moved left (dx < 0) -> 'next', right -> 'prev', else null.
    function swipeSourceDirection(dx, dy, options = {}) {
        const minPx = options.minPx > 0 ? options.minPx : SWIPE_MIN_PX;
        const ratio = options.ratio > 0 ? options.ratio : SWIPE_RATIO;
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
        const ax = Math.abs(dx);
        if (ax < minPx || ax < Math.abs(dy) * ratio) return null;
        return dx < 0 ? 'next' : 'prev';
    }

    // ---- Feed order (ランダム / ランキング順) ----------------------------------
    // "random" (default) plays each ranking in a weighted random order, so a
    // popular video tends to come early but a low one still shows up now and
    // then. "ranking" keeps the board's own order. The いいね一覧 never goes
    // through here; it stays newest first.
    const FEED_ORDERS = ['random', 'ranking'];
    const DEFAULT_FEED_ORDER = 'random';

    function pickFeedOrder(saved) {
        return FEED_ORDERS.includes(saved) ? saved : DEFAULT_FEED_ORDER;
    }

    function nextFeedOrder(current) {
        return pickFeedOrder(current) === 'random' ? 'ranking' : 'random';
    }

    const UNITS = {
        k: 1e3, m: 1e6, b: 1e9, '千': 1e3, '万': 1e4, '萬': 1e4, '億': 1e8,
    };

    // "1.2K" "12,345" "1万" "1.5万回" "3.4M views" -> a number, else null.
    function parseCount(value) {
        if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
        if (value == null) return null;
        let text = String(value);
        if (typeof text.normalize === 'function') text = text.normalize('NFKC');
        const match = text.match(/(\d[\d,]*(?:\.\d+)?)\s*(?:([千万萬億])|([kmb])(?![a-z]))?/i);
        if (!match) return null;
        const number = Number(match[1].replace(/,/g, ''));
        if (!Number.isFinite(number)) return null;
        const unit = (match[2] || match[3] || '').toLowerCase();
        return Math.round(number * (UNITS[unit] || 1));
    }

    const POPULARITY_KEYS = ['saves', 'likes', 'views'];

    // What a label counts: お気に入り/保存 > いいね > 表示/再生.
    function countKind(label) {
        if (/保存|お気に入り|ダウンロード|fav|save|download|bookmark/i.test(label)) return 'saves';
        if (/いいね|like|♥|❤/i.test(label)) return 'likes';
        return 'views';
    }

    // { saves, likes, views } (each a number or null) from the structured
    // `stats` the server sends, else from the display text in `views`
    // (e.g. "1,234 保存", "123 回表示 · 45 保存", "1.2K views").
    function popularityOf(video) {
        const out = { saves: null, likes: null, views: null };
        if (!video || typeof video !== 'object') return out;
        const stats = video.stats && typeof video.stats === 'object' ? video.stats : {};
        POPULARITY_KEYS.forEach((key) => {
            const count = parseCount(stats[key]);
            if (count != null) out[key] = count;
        });
        if (typeof video.views === 'string' && video.views) {
            video.views.split(/[·・|/]/).forEach((part) => {
                const count = parseCount(part);
                if (count == null) return;
                const kind = countKind(part);
                if (out[kind] == null) out[kind] = count;
            });
        } else if (typeof video.views === 'number' && out.views == null) {
            out.views = parseCount(video.views);
        }
        return out;
    }

    // Every video keeps at least this share of the top weight, so the
    // bottom of a board still turns up now and then (about 1 in 20 against
    // the top video).
    const MIN_WEIGHT = 0.05;
    // The log-compressed score (0..1) is raised to this power before the
    // floor is added. 1 would be a gentle tilt close to a plain shuffle; 2
    // makes the popular end of a board clearly front-loaded ("ある程度
    // ランダム") while the middle and bottom still get picked.
    const WEIGHT_CURVE = 2;

    function curveWeight(share) {
        const s = Number.isFinite(share) ? Math.min(Math.max(share, 0), 1) : 0;
        if (s >= 1) return 1;
        return MIN_WEIGHT + (1 - MIN_WEIGHT) * Math.pow(s, WEIGHT_CURVE);
    }

    function rankOf(video, index) {
        const rank = video && Number(video.rank);
        return Number.isFinite(rank) && rank >= 1 ? rank : index + 1;
    }

    // One weight per video, in [MIN_WEIGHT, 1]. The list uses the best
    // signal any of its videos has (saves > likes > views); a video without
    // that number gets the floor. Counts are log-compressed so a 100x lead
    // does not mean "always first", then curved (WEIGHT_CURVE) so the top
    // of the board leads clearly. With no numbers at all the board rank is
    // used (No.1 heaviest).
    function feedWeights(list) {
        const items = Array.isArray(list) ? list : [];
        if (items.length === 0) return [];
        const stats = items.map(popularityOf);
        const key = POPULARITY_KEYS.find((name) => stats.some((entry) => entry[name] != null));
        if (key) {
            const counts = stats.map((entry) => entry[key] || 0);
            const top = Math.log1p(Math.max(...counts));
            if (top > 0) {
                return counts.map((count) => curveWeight(Math.log1p(count) / top));
            }
        }
        const ranks = items.map(rankOf);
        const size = Math.max(items.length, ...ranks);
        const span = Math.log(size + 1);
        return ranks.map((rank) => {
            const clamped = Math.min(Math.max(rank, 1), size);
            return curveWeight(Math.log((size + 1) / clamped) / span);
        });
    }

    // Efraimidis–Spirakis: key = u^(1/w), largest first. Compared as
    // ln(u)/w (same order, no underflow). `rng` returns [0, 1).
    function weightedShuffle(items, weights, rng) {
        const random = typeof rng === 'function' ? rng : Math.random;
        const list = Array.isArray(items) ? items : [];
        const keyed = list.map((item, index) => {
            const raw = weights && Number(weights[index]);
            const weight = Number.isFinite(raw) && raw > 0 ? raw : MIN_WEIGHT;
            let u = Number(random());
            if (!(u > 0)) u = Number.MIN_VALUE;
            if (u >= 1) u = 1 - Number.EPSILON;
            return { item, index, key: Math.log(u) / weight };
        });
        keyed.sort((a, b) => (b.key - a.key) || (a.index - b.index));
        return keyed.map((entry) => entry.item);
    }

    function feedKey(video) {
        return bookmarkKey((video && video._sourceId) || '', String(video && video.id));
    }

    // Drop malformed rows, repeats, and anything in `exclude` (keys from
    // feedKey). Keeps the board order.
    function uniqueVideos(list, exclude) {
        const seen = new Set(exclude || []);
        const out = [];
        (Array.isArray(list) ? list : []).forEach((video) => {
            if (!video || video.id == null || video.id === '') return;
            const key = feedKey(video);
            if (seen.has(key)) return;
            seen.add(key);
            out.push(video);
        });
        return out;
    }

    // A ranking list as the feed plays it: no repeats, then either the board
    // order or a fresh weighted shuffle.
    function orderFeed(list, order, options = {}) {
        const unique = uniqueVideos(list, options.exclude);
        if (pickFeedOrder(order) === 'ranking') return unique;
        return weightedShuffle(unique, feedWeights(unique), options.rng);
    }

    // Infinite scroll: the next page is ordered the same way and appended;
    // a video already in the feed is not added again.
    function appendFeed(existing, page, order, options = {}) {
        const current = Array.isArray(existing) ? existing : [];
        const exclude = new Set(current.map(feedKey));
        return current.concat(orderFeed(page, order, { ...options, exclude }));
    }

    // ---- Seek bar (シークバー) ----------------------------------------------
    // The card's <video> is the same element for direct, playlist-proxy (HLS)
    // and full proxy playback, so one set of numbers covers all three. An
    // embed (iframe) cannot be seeked from here and hides the bar.

    const UNKNOWN_TIME = '--:--';
    // A stream with no finite duration counts as seekable only when the
    // browser reports a window at least this long (a live HLS window).
    const MIN_SEEK_WINDOW = 1;
    // Never seek onto the very last frame: that fires "ended" (the card
    // would loop back to 0) instead of showing the chosen spot.
    const SEEK_END_GUARD = 0.25;
    const SEEK_STEP = 5;

    // 0 -> "0:00", 65 -> "1:05", 3661 -> "1:01:01"; unknown -> "--:--".
    function formatTime(seconds) {
        if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return UNKNOWN_TIME;
        const total = Math.floor(seconds);
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        const secs = String(total % 60).padStart(2, '0');
        return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`;
    }

    function clamp01(value) {
        if (!Number.isFinite(value)) return 0;
        return Math.min(Math.max(value, 0), 1);
    }

    function finiteOr(value, fallback) {
        return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    }

    // What the bar shows for a media element's numbers. `duration` NaN
    // (nothing loaded) or Infinity (live) never throws: a live stream with
    // a seekable window seeks inside that window, anything else is shown as
    // "--:--" and cannot be dragged.
    function seekInfo(timing) {
        const t = timing || {};
        const now = Math.max(0, finiteOr(t.currentTime, 0));
        const duration = t.duration;
        if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) {
            return {
                canSeek: true,
                live: false,
                start: 0,
                end: duration,
                position: clamp01(now / duration),
                currentText: formatTime(Math.min(now, duration)),
                totalText: formatTime(duration),
            };
        }
        const start = Math.max(0, finiteOr(t.seekableStart, 0));
        const end = finiteOr(t.seekableEnd, NaN);
        if (Number.isFinite(end) && end - start >= MIN_SEEK_WINDOW) {
            return {
                canSeek: true,
                live: true,
                start,
                end,
                position: clamp01((now - start) / (end - start)),
                currentText: formatTime(now),
                totalText: 'LIVE',
            };
        }
        return {
            canSeek: false,
            live: duration === Infinity,
            start: 0,
            end: 0,
            position: 0,
            currentText: formatTime(now),
            totalText: duration === Infinity ? 'LIVE' : UNKNOWN_TIME,
        };
    }

    // Pointer x on the track -> 0..1 (outside the track clamps to an end).
    function seekRatio(clientX, left, width) {
        if (!Number.isFinite(clientX) || !Number.isFinite(left) || !(width > 0)) return 0;
        return clamp01((clientX - left) / width);
    }

    // Keep a time inside what `info` can seek to (null when it cannot seek).
    function clampSeekTime(time, info) {
        if (!info || !info.canSeek || !Number.isFinite(time)) return null;
        const span = info.end - info.start;
        const last = span > SEEK_END_GUARD * 4 ? info.end - SEEK_END_GUARD : info.end;
        return Math.min(Math.max(time, info.start), last);
    }

    // 0..1 along the bar -> seconds to set as currentTime.
    function seekTarget(ratio, info) {
        if (!info || !info.canSeek) return null;
        return clampSeekTime(info.start + clamp01(ratio) * (info.end - info.start), info);
    }

    // Keyboard: ±seconds from the current time.
    function seekBy(info, currentTime, delta) {
        if (!info || !info.canSeek || !Number.isFinite(delta)) return null;
        return clampSeekTime(finiteOr(currentTime, info.start) + delta, info);
    }

    // Where a time sits on the bar (0..1).
    function seekPosition(time, info) {
        if (!info || !info.canSeek || !Number.isFinite(time)) return 0;
        return clamp01((time - info.start) / (info.end - info.start));
    }

    // 'hidden' for an embed (the iframe player has its own controls),
    // 'disabled' while nothing seekable is loaded, else 'active'.
    function seekbarState(info, embedded) {
        if (embedded) return 'hidden';
        return info && info.canSeek ? 'active' : 'disabled';
    }

    // ---- Start offset (開始位置) ---------------------------------------------
    // The per-source offset from /api/sources; anything unusable is 0.
    function startOffsetFor(config, sourceId) {
        const value = config && config.startOffsets ? config.startOffsets[sourceId] : 0;
        return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
    }

    // Where a video starts and loops back to. A clip no longer than the offset
    // starts at 0; any longer clip starts at the offset. Unknown or live
    // durations also start at 0.
    function startPosition(offset, duration) {
        if (!(offset > 0) || !Number.isFinite(offset)) return 0;
        if (typeof duration !== 'number' || !Number.isFinite(duration)) return 0;
        return duration > offset ? offset : 0;
    }

    return {
        startOffsetFor,
        startPosition,
        formatTime,
        seekInfo,
        seekRatio,
        seekTarget,
        clampSeekTime,
        seekBy,
        seekPosition,
        seekbarState,
        SEEK_STEP,
        SEEK_END_GUARD,
        UNKNOWN_TIME,
        WEIGHT_CURVE,
        FEED_ORDERS,
        DEFAULT_FEED_ORDER,
        pickFeedOrder,
        nextFeedOrder,
        parseCount,
        popularityOf,
        MIN_WEIGHT,
        feedWeights,
        weightedShuffle,
        uniqueVideos,
        orderFeed,
        appendFeed,
        LOAD_MORE_AHEAD,
        shouldLoadMore,
        BOOKMARK_LIMIT,
        bookmarkFromVideo,
        normalizeBookmarks,
        loadBookmarks,
        saveBookmarks,
        isBookmarked,
        addBookmark,
        removeBookmark,
        toggleBookmark,
        bookmarkVideos,
        BOOKMARK_ORDERS,
        DEFAULT_BOOKMARK_ORDER,
        pickBookmarkOrder,
        bookmarkPlayable,
        shuffleList,
        orderBookmarkVideos,
        stepSource,
        SWIPE_MIN_PX,
        SWIPE_RATIO,
        swipeSourceDirection,
        videosUrl,
        resolveUrl,
        barSources,
        DEFAULT_SOURCE_ID,
        initialSource,
        mergeSourceStatus,
        needsSourceRefresh,
        SOURCES_REFRESH_MS,
        fallbackSource,
        reasonText,
        switchNote,
        joinNotes,
        playbackCurrent,
        shouldReResolve,
        mediaStalled,
        STALL_MS,
        stepTimeoutMs,
        orderModes,
        createLadderMemory,
        LADDER_MEMORY_TTL_MS,
        signedUrlExpiry,
        playbackFresh,
        resolveCacheTtl,
        SIGNED_URL_MARGIN_MS,
        EMBED_RESOLVE_TTL_MS,
        CLIENT_RESOLVE_TTL_MS,
        PRELOAD_AHEAD,
        keepWarm,
        preloadLevel,
        INITIAL_CARDS,
        isBootUrl,
        bootRequestUrl,
        hlsFrameReady,
        HLS_FIRST_FRAME_GRACE_MS,
        createTimingLog,
        nextMetric,
        pickMetric,
    };
}));
