const fs = require('fs');
const path = require('path');

const DEFAULTS = {
    cacheTtlMs: 30 * 60 * 1000,
    resolveTtlMs: 3 * 60 * 1000,
    domainMemoryTtlMs: 30 * 60 * 1000,
    mirrorTimeoutMs: 12000,
    requestTimeoutMs: 60000,
};

function envId(sourceId) {
    return String(sourceId || '').toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function splitList(value) {
    return String(value || '').split(',').map((part) => part.trim()).filter(Boolean);
}

function readConfig() {
    const file = process.env.SOURCES_CONFIG || path.join(__dirname, '..', 'config', 'sources.json');
    if (!fs.existsSync(file)) return {};
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        console.error('[config] Could not parse', file, err.message);
        return {};
    }
}

function numberSetting(envName, fileValue, fallback) {
    const raw = process.env[envName];
    const parsed = raw != null && raw !== '' ? Number(raw) : Number(fileValue);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function settings() {
    const file = readConfig();
    return {
        cacheTtlMs: numberSetting('CACHE_TTL_MS', file.cacheTtlMs, DEFAULTS.cacheTtlMs),
        resolveTtlMs: numberSetting('RESOLVE_TTL_MS', file.resolveTtlMs, DEFAULTS.resolveTtlMs),
        domainMemoryTtlMs: numberSetting('DOMAIN_MEMORY_TTL_MS', file.domainMemoryTtlMs, DEFAULTS.domainMemoryTtlMs),
        mirrorTimeoutMs: numberSetting('MIRROR_TIMEOUT_MS', file.mirrorTimeoutMs, DEFAULTS.mirrorTimeoutMs),
        requestTimeoutMs: numberSetting('REQUEST_TIMEOUT_MS', file.requestTimeoutMs, DEFAULTS.requestTimeoutMs),
        playbackMode: process.env.PLAYBACK_MODE || file.playbackMode || 'auto',
        fullProxyEnabled: process.env.FULL_PROXY != null
            ? !/^(0|false|no)$/i.test(process.env.FULL_PROXY)
            : file.fullProxyEnabled !== false,
        maxProxyStreams: numberSetting('MAX_PROXY_STREAMS', file.maxProxyStreams, 3),
    };
}

function playbackModeFor(sourceId) {
    const fromEnv = process.env[`SOURCE_PLAYBACK_${envId(sourceId)}`];
    if (fromEnv && fromEnv.trim()) return fromEnv.trim();
    const fromFile = sourceConfig(sourceId).playbackMode;
    if (fromFile) return String(fromFile);
    return settings().playbackMode;
}

function sourceConfig(sourceId) {
    const file = readConfig();
    return (file.sources && file.sources[sourceId]) || {};
}

function basesFor(sourceId, defaults) {
    const fromEnv = splitList(process.env[`SOURCE_BASES_${envId(sourceId)}`]);
    if (fromEnv.length) return fromEnv;
    const fromFile = sourceConfig(sourceId).bases;
    if (Array.isArray(fromFile) && fromFile.length) return fromFile.slice();
    return (defaults || []).slice();
}

function playlistHostsFor(sourceId, defaults) {
    const fromEnv = splitList(process.env[`SOURCE_PLAYLIST_HOSTS_${envId(sourceId)}`]);
    if (fromEnv.length) return fromEnv;
    const fromFile = sourceConfig(sourceId).playlistHosts;
    if (Array.isArray(fromFile) && fromFile.length) return fromFile.slice();
    return (defaults || []).slice();
}

function embedTemplateFor(sourceId) {
    const fromEnv = process.env[`SOURCE_EMBED_${envId(sourceId)}`];
    if (fromEnv && fromEnv.trim()) return fromEnv.trim();
    const fromFile = sourceConfig(sourceId).embedTemplate;
    return fromFile ? String(fromFile) : '';
}

function hostOf(base) {
    try {
        return new URL(base).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
        return '';
    }
}

const memory = new Map();

function remember(sourceId, base) {
    memory.set(sourceId, {
        base,
        expires: Date.now() + settings().domainMemoryTtlMs,
    });
}

function forget(sourceId) {
    memory.delete(sourceId);
}

function activeBase(sourceId) {
    const hit = memory.get(sourceId);
    if (!hit) return null;
    if (hit.expires <= Date.now()) {
        memory.delete(sourceId);
        return null;
    }
    return hit.base;
}

function orderBases(sourceId, defaults) {
    const bases = basesFor(sourceId, defaults);
    const active = activeBase(sourceId);
    if (active && bases.includes(active)) {
        return [active, ...bases.filter((base) => base !== active)];
    }
    return bases;
}

async function withMirror(sourceId, defaults, attempt) {
    const bases = orderBases(sourceId, defaults);
    if (bases.length === 0) throw new Error(`${sourceId} has no base domains`);
    const errors = [];
    for (const base of bases) {
        try {
            const result = await attempt(base);
            remember(sourceId, base);
            console.log(`[${sourceId}] using ${base}`);
            return { base, result };
        } catch (err) {
            errors.push(`${base} (${(err && err.message) || err})`);
        }
    }
    forget(sourceId);
    throw new Error(`All mirrors failed: ${errors.join('; ')}`);
}

function status() {
    const file = readConfig();
    const ids = new Set([
        ...Object.keys(file.sources || {}),
        ...memory.keys(),
    ]);
    const domains = {};
    for (const id of ids) {
        const hit = memory.get(id);
        const fresh = hit && hit.expires > Date.now();
        domains[id] = {
            active: fresh ? hit.base : null,
            expiresAt: fresh ? new Date(hit.expires).toISOString() : null,
            candidates: basesFor(id, []),
        };
    }
    return domains;
}

function fillTemplate(template, video, base) {
    return String(template)
        .replaceAll('{id}', encodeURIComponent(video.id))
        .replaceAll('{base}', String(base || '').replace(/\/$/, ''));
}

module.exports = {
    settings,
    playbackModeFor,
    basesFor,
    playlistHostsFor,
    embedTemplateFor,
    hostOf,
    withMirror,
    activeBase,
    remember,
    forget,
    status,
    fillTemplate,
    orderBases,
};
