const { getText, responseFailure } = require('../lib/http');
const { withMirror, sourceConfig } = require('../lib/mirrors');
const { videoUrl, thumbUrl, tweetUrl } = require('../lib/twimg');

// TwiKeep's /ranking page is a Next.js client page. The HTML has no media,
// but the page loads the same board from a public JSON endpoint:
//   GET /api/ranking?metric=downloads|views&range=24h|1w|1m|1y
//   -> { ok: true, items: [{ mediaKey, tweetId, bestVideoUrl, thumbnailUrl,
//        count, userId, userName, userDisplayName, updatedAt }], nextCursor }
// bestVideoUrl is a video.twimg.com MP4 and thumbnailUrl a pbs.twimg.com JPG,
// so this adapter needs no browser and plays direct.
//
// metric defaults to "downloads" (保存数). Set "metric": "views" for this
// source in config/sources.json, or SOURCE_METRIC_TWIKEEP=views.

const DEFAULT_BASES = ['https://www.twikeep.com'];
const ORIGIN = DEFAULT_BASES[0];

const API_PATH = '/api/ranking';
const METRICS = {
    downloads: { label: '保存' },
    views: { label: '表示' },
};
const DEFAULT_METRIC = 'downloads';

const PERIODS = {
    '24h': { label: '24時間', range: '24h' },
    '7d': { label: '1週間', range: '1w' },
    '30d': { label: '1ヶ月', range: '1m' },
    '1y': { label: '1年', range: '1y' },
};

function currentMetric() {
    const raw = process.env.SOURCE_METRIC_TWIKEEP || sourceConfig('twikeep').metric || DEFAULT_METRIC;
    const metric = String(raw).trim().toLowerCase();
    return Object.hasOwn(METRICS, metric) ? metric : DEFAULT_METRIC;
}

// A metric the client asked for (/api/videos?metric=views), else the default.
function resolveMetric(requested) {
    const metric = String(requested || '').trim().toLowerCase();
    return Object.hasOwn(METRICS, metric) ? metric : currentMetric();
}

function rankingUrl(base, periodId, metric = currentMetric()) {
    const period = PERIODS[periodId];
    if (!period) throw new Error(`twikeep has no period ${periodId}`);
    const query = new URLSearchParams({ metric, range: period.range });
    return `${base}${API_PATH}?${query}`;
}

function pageUrl(base, periodId, metric = currentMetric()) {
    const period = PERIODS[periodId] || PERIODS['24h'];
    const query = new URLSearchParams({ metric, range: period.range });
    return `${base}/ranking?${query}`;
}

function formatCount(count, metric) {
    const value = Number(count);
    if (!Number.isFinite(value) || value < 0) return '';
    return `${value.toLocaleString('ja-JP')} ${METRICS[metric] ? METRICS[metric].label : ''}`.trim();
}

function parseRanking(body, metric = DEFAULT_METRIC) {
    let data = body;
    if (typeof body === 'string') {
        try {
            data = JSON.parse(body);
        } catch {
            throw new Error('twikeep ranking was not JSON');
        }
    }
    if (!data || typeof data !== 'object') throw new Error('twikeep ranking was empty');
    if (data.ok === false) throw new Error(`twikeep ranking error: ${String(data.error || 'ok=false').slice(0, 120)}`);
    const items = Array.isArray(data.items) ? data.items : [];
    const videos = [];
    const seen = new Set();
    for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const id = String(item.mediaKey || item.tweetId || '').trim();
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || seen.has(id)) continue;
        const url = videoUrl(item.bestVideoUrl);
        if (!url) continue;
        seen.add(id);
        const userName = /^[A-Za-z0-9_]{1,30}$/.test(String(item.userName || '')) ? item.userName : '';
        const display = typeof item.userDisplayName === 'string' ? item.userDisplayName.trim().slice(0, 80) : '';
        const tweet = tweetUrl(userName, item.tweetId);
        videos.push({
            id,
            title: display || (userName ? `@${userName}` : ''),
            author: userName ? `@${userName}` : '',
            views: formatCount(item.count, metric),
            pageUrl: tweet,
            externalUrl: tweet,
            thumbUrl: thumbUrl(item.thumbnailUrl),
            playback: {
                kind: 'file',
                url,
            },
        });
    }
    return videos;
}

async function fetchRanking(periodId, options = {}) {
    if (!PERIODS[periodId]) throw new Error(`twikeep has no period ${periodId}`);
    const metric = resolveMetric(options.metric);
    const { result } = await withMirror('twikeep', DEFAULT_BASES, async (base) => {
        const response = await getText(rankingUrl(base, periodId, metric), {
            timeout: 12000,
            accept: 'application/json,text/plain,*/*',
            referer: pageUrl(base, periodId, metric),
        });
        const failure = responseFailure(response);
        if (failure) throw new Error(failure);
        const videos = parseRanking(response.text, metric);
        if (videos.length === 0) throw new Error('no ranking items');
        return videos;
    });
    return result;
}

module.exports = {
    id: 'twikeep',
    name: 'TwiKeep',
    color: '#22c55e',
    homepage: ORIGIN + '/',
    bases: DEFAULT_BASES,
    periods: Object.entries(PERIODS).map(([id, period]) => ({ id, label: period.label })),
    metrics: [
        { id: 'downloads', label: '保存数' },
        { id: 'views', label: '表示数' },
    ],
    mediaHosts: ['twimg.com'],
    mediaReferer: 'https://x.com/',
    timeoutMs: 30000,
    fetchRanking,
    parseRanking,
    rankingUrl,
    currentMetric,
    resolveMetric,
    PERIODS,
    METRICS,
};
