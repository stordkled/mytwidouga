const { TtlCache, withTimeout } = require('../lib/cache');
const { resolvePeriod } = require('../lib/periods');
const {
    finalizeVideos, pageRanking, PAGE_SIZE, RANKING_MAX,
} = require('../lib/video');
const mirrors = require('../lib/mirrors');
const { withAutoplay } = require('../lib/playback');
const { resolveCacheTtl } = require('../src/feed-logic');

// Register a source by adding its module here. The file must export the
// fields documented in the README section "Adding a source".
// The order is the switcher order and the automatic fallback order; the
// first visible one is what a browser with no saved source opens
// (Pornhub, then 85po; the client's DEFAULT_SOURCE_ID is Pornhub too).
const adapters = [
    require('./pornhub'),
    require('./85po'),
    require('./twivideo'),
    require('./twikeep'),
    require('./tokyomotion'),
    require('./twihozon'),
];

const REQUIRED = ['id', 'name', 'periods', 'mediaHosts', 'mediaReferer', 'fetchRanking'];

function assertAdapter(adapter) {
    for (const key of REQUIRED) {
        if (adapter[key] == null) throw new Error(`Source adapter is missing "${key}"`);
    }
    if (!/^[a-z0-9_-]+$/.test(adapter.id)) {
        throw new Error(`Source id "${adapter.id}" must match [a-z0-9_-]+`);
    }
    if (!Array.isArray(adapter.periods) || adapter.periods.length === 0) {
        throw new Error(`Source "${adapter.id}" has no periods`);
    }
    if (!Array.isArray(adapter.mediaHosts) || adapter.mediaHosts.length === 0) {
        throw new Error(`Source "${adapter.id}" has no mediaHosts`);
    }
}

const byId = new Map();
for (const adapter of adapters) {
    assertAdapter(adapter);
    if (byId.has(adapter.id)) throw new Error(`Duplicate source id "${adapter.id}"`);
    byId.set(adapter.id, adapter);
}

// Bounded: resolve keys are per video id and would otherwise grow forever.
const rankingCache = new TtlCache({ maxEntries: 100 });
const resolveCache = new TtlCache({ maxEntries: 500 });
// Consecutive ranking failures per source. Every failure counts once, a
// block page included: one Cloudflare page (or one timeout) is often
// transient and must not hide a source. After hideAfterFailures failures in
// a row the source is hidden for hiddenRetryMs, then offered again; one
// success clears the record, and one more failure hides it again.
const sourceFailures = new Map();

function noteSourceResult(sourceId, ok, message, now = Date.now()) {
    if (ok) {
        sourceFailures.delete(sourceId);
        return;
    }
    const settings = mirrors.settings();
    const blocked = /block page|cloudflare|attention required|just a moment|しばらくお待ち/i.test(message || '');
    let previous = sourceFailures.get(sourceId) || { count: 0, blocked: false, lastFailureAt: 0, hiddenUntil: 0 };
    // Failures far apart are not a streak.
    if (previous.count > 0 && !previous.hiddenUntil && now - previous.lastFailureAt > settings.hiddenRetryMs) {
        previous = { count: 0, blocked: false, lastFailureAt: 0, hiddenUntil: 0 };
    }
    const count = previous.count + 1;
    sourceFailures.set(sourceId, {
        count,
        blocked: blocked || previous.blocked,
        lastFailureAt: now,
        hiddenUntil: count >= settings.hideAfterFailures ? now + settings.hiddenRetryMs : 0,
    });
}

function sourceHidden(sourceId, now = Date.now()) {
    if (!mirrors.enabledFor(sourceId) || mirrors.hiddenFor(sourceId)) return true;
    if (!mirrors.settings().hideFailedSources) return false;
    const record = sourceFailures.get(sourceId);
    if (!record || !record.hiddenUntil) return false;
    return record.hiddenUntil > now;
}

function failureState(sourceId) {
    const record = sourceFailures.get(sourceId);
    return record ? { ...record } : null;
}

function resetFailures() {
    sourceFailures.clear();
}

function friendlyFailure(name, raw) {
    const text = String(raw || '');
    if (/block page|cloudflare|attention required|just a moment|しばらくお待ち/i.test(text)) {
        return `${name} はこのネットワークから開けません`;
    }
    if (/redirected away/i.test(text)) {
        return `${name} のランキングを取得できませんでした`;
    }
    if (text.length > 180) return `${name} の読み込みに失敗しました`;
    return text;
}

function mergedHosts(adapter) {
    const fromBases = mirrors.basesFor(adapter.id, adapter.bases || []).map(mirrors.hostOf).filter(Boolean);
    const playlists = mirrors.playlistHostsFor(adapter.id, adapter.playlistHosts || []);
    return [...new Set([...(adapter.mediaHosts || []), ...fromBases, ...playlists])];
}

function withEmbeds(adapter, videos) {
    if (typeof adapter.getEmbedUrl !== 'function') return videos;
    return videos.map((video) => {
        let embedUrl = video.playback && video.playback.embedUrl;
        if (!embedUrl) {
            try {
                embedUrl = adapter.getEmbedUrl(video);
            } catch {
                embedUrl = null;
            }
        }
        if (!embedUrl) return video;
        return {
            ...video,
            playback: decoratePlayback({ ...video.playback, embedUrl }),
        };
    });
}

function embedFor(adapter, video) {
    if (!adapter || typeof adapter.getEmbedUrl !== 'function') return null;
    try {
        return adapter.getEmbedUrl(video) || null;
    } catch {
        return null;
    }
}

function metricFor(adapter, requested) {
    if (typeof adapter.resolveMetric !== 'function') return null;
    return adapter.resolveMetric(requested);
}

function publicSource(adapter) {
    const out = {
        id: adapter.id,
        name: adapter.name,
        color: adapter.color || '#ffffff',
        enabled: mirrors.enabledFor(adapter.id),
        hidden: sourceHidden(adapter.id),
        periods: adapter.periods.map((period) => ({ id: period.id, label: period.label })),
    };
    // Hidden only for a while (failure streak, not config): tell the client
    // so an open page re-checks /api/sources and shows it again later.
    if (out.enabled && out.hidden && !mirrors.hiddenFor(adapter.id)) out.retryLater = true;
    if (Array.isArray(adapter.metrics) && adapter.metrics.length > 1) {
        out.metrics = adapter.metrics.map((metric) => ({ id: metric.id, label: metric.label }));
        out.defaultMetric = metricFor(adapter, '');
    }
    return out;
}

function playbackConfig() {
    const global = mirrors.settings();
    return {
        mode: global.playbackMode,
        fullProxyEnabled: global.fullProxyEnabled,
        maxProxyStreams: global.maxProxyStreams,
        sources: Object.fromEntries(adapters.map((adapter) => [adapter.id, mirrors.playbackModeFor(adapter.id)])),
        thumbs: Object.fromEntries(adapters.map((adapter) => {
            const fromEnv = process.env[`SOURCE_THUMBS_${mirrors.envId(adapter.id)}`];
            const fromFile = (mirrors.sourceConfig(adapter.id).thumbs) || '';
            return [adapter.id, fromEnv || fromFile || 'auto'];
        })),
    };
}

function decoratePlayback(playback) {
    if (!playback) return playback;
    const next = { ...playback };
    if (next.embedUrl) next.embedUrl = withAutoplay(next.embedUrl);
    if (next.kind === 'embed' && next.url) next.url = withAutoplay(next.url);
    return next;
}

function list() {
    return adapters.map(publicSource);
}

function disabledIds() {
    return adapters.filter((adapter) => !mirrors.enabledFor(adapter.id)).map((adapter) => adapter.id);
}

function get(id) {
    return byId.get(id) || null;
}

function proxyView(id) {
    const adapter = byId.get(id);
    if (!adapter) return null;
    return {
        id: adapter.id,
        mediaHosts: mergedHosts(adapter),
        mediaReferer: adapter.mediaReferer,
        mediaHeaders: adapter.mediaHeaders,
    };
}

function domainStatus() {
    return mirrors.status();
}

function errorMessage(err) {
    const message = (err && err.message) ? err.message : 'Unknown error';
    return message.replace(/\s+/g, ' ').slice(0, 400);
}

// Key for one board. A source with metrics (TwiKeep 保存数/表示数) keeps one
// entry per metric, so switching metric never serves the other board.
function rankingCacheKey(sourceId, periodId, metric) {
    return metric ? `${sourceId}:${periodId}:${metric}` : `${sourceId}:${periodId}`;
}

async function fetchRanking(sourceId, requestedPeriod, options = {}) {
    const adapter = byId.get(sourceId);
    if (!adapter) {
        const error = new Error(`Unknown source "${sourceId}"`);
        error.status = 404;
        throw error;
    }
    const resolved = resolvePeriod(adapter.periods, requestedPeriod);
    const metric = metricFor(adapter, options.metric);
    // Checked before the cache: a disabled source serves no board at all and
    // does not count as a failure.
    if (!mirrors.enabledFor(adapter.id)) {
        const disabled = {
            ok: false,
            cached: false,
            disabled: true,
            source: publicSource(adapter),
            period: { id: resolved.period.id, label: resolved.period.label },
            requestedPeriod: resolved.requestedPeriod,
            fallback: false,
            fallbackReason: null,
            error: `${adapter.name} は設定で無効になっています`,
            reason: 'disabled',
            hidden: true,
            videos: [],
        };
        if (metric) disabled.metric = metric;
        return disabled;
    }
    const cacheKey = rankingCacheKey(adapter.id, resolved.period.id, metric);
    const ttl = adapter.cacheTtlMs || mirrors.settings().cacheTtlMs;
    const timeout = adapter.timeoutMs || mirrors.settings().requestTimeoutMs;
    try {
        const loaded = await rankingCache.getOrLoad(cacheKey, ttl, async () => {
            const videos = await withTimeout(
                Promise.resolve(adapter.fetchRanking(resolved.period.id, metric ? { metric } : {})),
                timeout,
                adapter.name
            );
            // The whole board is kept (up to RANKING_MAX); /api/videos hands
            // it out PAGE_SIZE at a time for the feed's infinite scroll.
            const finalized = finalizeVideos(withEmbeds(adapter, videos), RANKING_MAX);
            if (finalized.length === 0) {
                throw new Error(`${adapter.name} returned an empty ranking`);
            }
            // An adapter may say it showed a substitute board (TokyoMotion
            // 今日 is empty → 今週).
            const notice = videos && typeof videos.notice === 'string' ? videos.notice : '';
            return { videos: finalized, notice };
        });
        noteSourceResult(adapter.id, true);
        const result = {
            ok: true,
            cached: loaded.cached,
            source: publicSource(adapter),
            period: { id: resolved.period.id, label: resolved.period.label },
            requestedPeriod: resolved.requestedPeriod,
            fallback: resolved.fallback,
            fallbackReason: resolved.fallbackReason,
            notice: loaded.value.notice || null,
            videos: loaded.value.videos,
        };
        if (metric) result.metric = metric;
        return result;
    } catch (err) {
        console.error(`[${adapter.id}] ${resolved.period.id} failed:`, err.message);
        const raw = errorMessage(err);
        noteSourceResult(adapter.id, false, raw);
        const result = {
            ok: false,
            cached: false,
            source: publicSource(adapter),
            period: { id: resolved.period.id, label: resolved.period.label },
            requestedPeriod: resolved.requestedPeriod,
            fallback: resolved.fallback,
            fallbackReason: resolved.fallback ? resolved.fallbackReason : null,
            error: friendlyFailure(adapter.name, raw),
            reason: failureReason(raw),
            detail: raw,
            hidden: sourceHidden(adapter.id),
            videos: [],
        };
        if (metric) result.metric = metric;
        return result;
    }
}

// Short category for the UI note when it moves to another source.
function failureReason(raw) {
    const text = String(raw || '');
    if (/block page|cloudflare|attention required|just a moment|しばらくお待ち/i.test(text)) return 'blocked';
    if (/timed out|timeout|aborted/i.test(text)) return 'timeout';
    if (/empty ranking|no ranking cards|no ranking items|empty board/i.test(text)) return 'empty';
    if (/HTTP \d{3}/.test(text)) return 'http';
    return 'error';
}

async function resolvePlayback(sourceId, videoId, options = {}) {
    const adapter = byId.get(sourceId);
    if (!adapter) {
        const error = new Error(`Unknown source "${sourceId}"`);
        error.status = 404;
        throw error;
    }
    if (!adapter.resolvePlayback) {
        const error = new Error(`${adapter.name} does not resolve playback separately`);
        error.status = 400;
        throw error;
    }
    if (!videoId || String(videoId).length > 80) {
        const error = new Error('Invalid video id');
        error.status = 400;
        throw error;
    }
    const cacheKey = `${adapter.id}:${videoId}`;
    if (options.fresh) resolveCache.delete(cacheKey);
    const timeout = adapter.timeoutMs || mirrors.settings().requestTimeoutMs;
    try {
        const baseTtl = mirrors.settings().resolveTtlMs;
        const loaded = await resolveCache.getOrLoad(cacheKey, (playback) => resolveCacheTtl(playback, baseTtl, Date.now()), () => (
            withTimeout(Promise.resolve(adapter.resolvePlayback(String(videoId))), timeout, adapter.name)
        ));
        return { ok: true, cached: loaded.cached, playback: decoratePlayback(loaded.value) };
    } catch (err) {
        console.error(`[${adapter.id}] resolve ${videoId} failed:`, err.message);
        const embedUrl = embedFor(adapter, { id: String(videoId) });
        if (embedUrl) {
            return {
                ok: true,
                cached: false,
                playback: decoratePlayback({ kind: 'embed', url: embedUrl, embedUrl }),
                via: 'embed',
            };
        }
        if (err && err.unavailable) {
            // Definitive (e.g. the CDN answers 403 for every variant): the
            // client skips to the next video instead of waiting on a dead URL.
            return {
                ok: false,
                unavailable: true,
                error: '元の動画が削除されているため再生できません',
                detail: errorMessage(err),
                playback: null,
            };
        }
        return { ok: false, error: errorMessage(err), playback: null };
    }
}

async function lookupExternal(sourceId, videoId) {
    const adapter = byId.get(sourceId);
    if (!adapter || !adapter.lookupExternal) {
        const error = new Error('This source has no external lookup');
        error.status = 400;
        throw error;
    }
    const url = await adapter.lookupExternal(String(videoId || ''));
    if (!/^https?:\/\//i.test(url)) {
        throw new Error('Lookup did not return a URL');
    }
    return url;
}

module.exports = {
    list,
    disabledIds,
    get,
    proxyView,
    domainStatus,
    playbackConfig,
    fetchRanking,
    pageRanking,
    PAGE_SIZE,
    RANKING_MAX,
    resolvePlayback,
    lookupExternal,
    rankingCacheKey,
    noteSourceResult,
    sourceHidden,
    failureState,
    failureReason,
    resetFailures,
};
