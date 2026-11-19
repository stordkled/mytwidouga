const { parseCount } = require('../src/feed-logic');

const KINDS = new Set(['file', 'hls', 'embed', 'resolve']);
const STAT_KEYS = ['saves', 'likes', 'views'];

// Popularity counts a source knows ({ saves, likes, views }), used by the
// client's weighted shuffle. Numbers and count text ("12,345", "1.2K",
// "1万") become numbers; anything else is dropped. null when none is left.
function cleanStats(stats) {
    if (!stats || typeof stats !== 'object') return null;
    const out = {};
    for (const key of STAT_KEYS) {
        const value = parseCount(stats[key]);
        if (value != null) out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : null;
}

function finalizeVideos(list, limit = 24) {
    const out = [];
    for (const video of list || []) {
        if (!video || video.id == null || video.id === '') continue;
        if (!video.playback || !KINDS.has(video.playback.kind)) continue;
        const rank = out.length + 1;
        const stats = cleanStats(video.stats);
        out.push({
            id: String(video.id).slice(0, 80),
            title: String(video.title || '').replace(/\s+/g, ' ').trim(),
            rank,
            rankLabel: video.rankLabel || `No.${rank}`,
            pageUrl: video.pageUrl || '',
            thumbUrl: video.thumbUrl || '',
            duration: video.duration || '',
            views: video.views || '',
            author: video.author || '',
            externalUrl: video.externalUrl || video.pageUrl || '',
            lookup: Boolean(video.lookup),
            playback: {
                kind: video.playback.kind,
                url: video.playback.url || null,
                embedUrl: video.playback.embedUrl || null,
                referer: video.playback.referer || null,
            },
        });
        if (stats) out[out.length - 1].stats = stats;
        if (out.length >= limit) break;
    }
    return out;
}

// The board size kept per source/period/metric, and one /api/videos page.
const RANKING_MAX = 240;
const PAGE_SIZE = 24;

// One page of a ranking result (page 1 = the first PAGE_SIZE videos, as
// /api/videos returned before). Ranks stay the board's own (page 2 starts
// at No.25), and `hasMore` tells the client whether to ask for the next
// page (the feed's infinite scroll).
function pageRanking(result, requestedPage, size = PAGE_SIZE) {
    if (!result || !Array.isArray(result.videos)) return result;
    const parsed = Number.parseInt(requestedPage, 10);
    const page = Number.isFinite(parsed) && parsed >= 1 ? Math.min(parsed, 1000) : 1;
    const start = (page - 1) * size;
    const all = result.videos;
    return {
        ...result,
        videos: all.slice(start, start + size),
        page,
        hasMore: result.ok !== false && start + size < all.length,
    };
}

module.exports = {
    finalizeVideos, cleanStats, pageRanking, PAGE_SIZE, RANKING_MAX,
};
