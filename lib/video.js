const KINDS = new Set(['file', 'hls', 'embed', 'resolve']);

function finalizeVideos(list, limit = 24) {
    const out = [];
    for (const video of list || []) {
        if (!video || video.id == null || video.id === '') continue;
        if (!video.playback || !KINDS.has(video.playback.kind)) continue;
        const rank = out.length + 1;
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
        if (out.length >= limit) break;
    }
    return out;
}

module.exports = { finalizeVideos };
