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
    // (the user may still pick one by hand).
    function barSources(sources, currentId) {
        const all = sources || [];
        // Only the current one (or nothing) left visible: that is "every
        // source hidden" from the user's point of view, so offer them all.
        if (!all.some((source) => !source.hidden)) return all.slice();
        return all.filter((source) => !source.hidden || source.id === currentId);
    }

    // The source a page opens on. The one this browser saved, if it is still
    // offered; otherwise TwiKeep; otherwise the first offered one. A saved id
    // the server no longer has (a removed source) or a hidden one falls
    // through to the default instead of failing.
    const DEFAULT_SOURCE_ID = 'twikeep';

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
            return { ...source, hidden: Boolean(update.hidden), retryLater: Boolean(update.retryLater) };
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
            source.id !== currentId && !source.hidden && !failed.has(source.id)
        )) || null;
    }

    const REASONS = {
        blocked: 'このネットワークから開けません',
        timeout: '応答がありません',
        empty: 'ランキングが空でした',
        http: 'サイトがエラーを返しました',
        error: '読み込みに失敗しました',
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

    function mediaStalled({ readyState, networkState, elapsedMs }) {
        if (readyState >= 1) return false;
        if (networkState === 3) return true;
        return elapsedMs >= STALL_MS;
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
    // bottom of a board still turns up now and then.
    const MIN_WEIGHT = 0.2;

    function rankOf(video, index) {
        const rank = video && Number(video.rank);
        return Number.isFinite(rank) && rank >= 1 ? rank : index + 1;
    }

    // One weight per video, in (MIN_WEIGHT, 1]. The list uses the best
    // signal any of its videos has (saves > likes > views); a video without
    // that number gets the floor. Counts are log-compressed so a 100x lead
    // does not mean "always first". With no numbers at all the board rank
    // is used (No.1 heaviest).
    function feedWeights(list) {
        const items = Array.isArray(list) ? list : [];
        if (items.length === 0) return [];
        const stats = items.map(popularityOf);
        const key = POPULARITY_KEYS.find((name) => stats.some((entry) => entry[name] != null));
        if (key) {
            const counts = stats.map((entry) => entry[key] || 0);
            const top = Math.log1p(Math.max(...counts));
            if (top > 0) {
                return counts.map((count) => MIN_WEIGHT + (1 - MIN_WEIGHT) * (Math.log1p(count) / top));
            }
        }
        const ranks = items.map(rankOf);
        const size = Math.max(items.length, ...ranks);
        const span = Math.log(size + 1);
        return ranks.map((rank) => {
            const clamped = Math.min(Math.max(rank, 1), size);
            return MIN_WEIGHT + (1 - MIN_WEIGHT) * (Math.log((size + 1) / clamped) / span);
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

    return {
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
        nextMetric,
        pickMetric,
    };
}));
