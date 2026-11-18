const { TtlCache, withTimeout } = require('../lib/cache');
const { resolvePeriod } = require('../lib/periods');
const { finalizeVideos } = require('../lib/video');
const mirrors = require('../lib/mirrors');
const { withAutoplay } = require('../lib/playback');

// Register a source by adding its module here. The file must export the
// fields documented in the README section "Adding a source".
const adapters = [
    require('./twivideo'),
    require('./pornhub'),
    require('./85po'),
    require('./tokyomotion'),
    require('./missav'),
    require('./twikeep'),
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
const sourceFailures = new Map();

function noteSourceResult(sourceId, ok, message) {
    if (ok) {
        sourceFailures.set(sourceId, { count: 0, blocked: false });
        return;
    }
    const blocked = /block page|cloudflare|attention required|just a moment|しばらくお待ち/i.test(message || '');
    const previous = sourceFailures.get(sourceId) || { count: 0, blocked: false };
    const bump = blocked ? mirrors.settings().hideAfterFailures : 1;
    sourceFailures.set(sourceId, { count: previous.count + bump, blocked: blocked || previous.blocked });
}

function sourceHidden(sourceId) {
    if (mirrors.hiddenFor(sourceId)) return true;
    if (!mirrors.settings().hideFailedSources) return false;
    const record = sourceFailures.get(sourceId);
    if (!record) return false;
    return record.count >= mirrors.settings().hideAfterFailures;
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

function publicSource(adapter) {
    return {
        id: adapter.id,
        name: adapter.name,
        color: adapter.color || '#ffffff',
        hidden: sourceHidden(adapter.id),
        periods: adapter.periods.map((period) => ({ id: period.id, label: period.label })),
    };
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

async function fetchRanking(sourceId, requestedPeriod) {
    const adapter = byId.get(sourceId);
    if (!adapter) {
        const error = new Error(`Unknown source "${sourceId}"`);
        error.status = 404;
        throw error;
    }
    const resolved = resolvePeriod(adapter.periods, requestedPeriod);
    const cacheKey = `${adapter.id}:${resolved.period.id}`;
    const ttl = adapter.cacheTtlMs || mirrors.settings().cacheTtlMs;
    const timeout = adapter.timeoutMs || mirrors.settings().requestTimeoutMs;
    try {
        const loaded = await rankingCache.getOrLoad(cacheKey, ttl, async () => {
            const videos = await withTimeout(
                Promise.resolve(adapter.fetchRanking(resolved.period.id)),
                timeout,
                adapter.name
            );
            const finalized = finalizeVideos(withEmbeds(adapter, videos));
            if (finalized.length === 0) {
                throw new Error(`${adapter.name} returned an empty ranking`);
            }
            return finalized;
        });
        noteSourceResult(adapter.id, true);
        return {
            ok: true,
            cached: loaded.cached,
            source: publicSource(adapter),
            period: { id: resolved.period.id, label: resolved.period.label },
            requestedPeriod: resolved.requestedPeriod,
            fallback: resolved.fallback,
            fallbackReason: resolved.fallbackReason,
            videos: loaded.value,
        };
    } catch (err) {
        console.error(`[${adapter.id}] ${resolved.period.id} failed:`, err.message);
        const raw = errorMessage(err);
        noteSourceResult(adapter.id, false, raw);
        return {
            ok: false,
            cached: false,
            source: publicSource(adapter),
            period: { id: resolved.period.id, label: resolved.period.label },
            requestedPeriod: resolved.requestedPeriod,
            fallback: resolved.fallback,
            fallbackReason: resolved.fallback ? resolved.fallbackReason : null,
            error: friendlyFailure(adapter.name, raw),
            detail: raw,
            hidden: sourceHidden(adapter.id),
            videos: [],
        };
    }
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
        const loaded = await resolveCache.getOrLoad(cacheKey, mirrors.settings().resolveTtlMs, () => (
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
    get,
    proxyView,
    domainStatus,
    playbackConfig,
    fetchRanking,
    resolvePlayback,
    lookupExternal,
};
