const { loadHtml, cleanText, absUrl } = require('../lib/html');
const { getText } = require('../lib/http');

// TokyoMotion's video list is /videos. o=mv is "most viewed" and t=t|w|m limits
// that to videos added today / this week / this month (the site has no separate
// "viewed during" window, and no 3-day filter). The watch page exposes a
// same-origin /vsrc/... MP4 that 301s to wwwNN.tokyomotion.net. Both hosts are
// covered by mediaHosts.

const ORIGIN = 'https://www.tokyomotion.net';

const SELECTORS = {
    card: 'a.thumb-popu',
    thumb: 'img',
    title: '.video-title',
    duration: '.duration',
    views: '.video-views',
};

const PERIODS = {
    '24h': { label: '今日', query: 'o=mv&t=t' },
    '7d': { label: '今週', query: 'o=mv&t=w' },
    '30d': { label: '今月', query: 'o=mv&t=m' },
};

function parseListing(html) {
    const root = loadHtml(html);
    const videos = [];
    for (const link of root.querySelectorAll(SELECTORS.card)) {
        const href = absUrl(link.getAttribute('href'), ORIGIN + '/');
        const idMatch = href.match(/\/video\/(\d+)/);
        if (!idMatch) continue;
        const card = link.parentNode || link;
        const img = link.querySelector(SELECTORS.thumb);
        videos.push({
            id: idMatch[1],
            title: cleanText(link.querySelector(SELECTORS.title)?.text || img?.getAttribute('alt')),
            pageUrl: href,
            thumbUrl: absUrl(img?.getAttribute('src'), ORIGIN + '/'),
            duration: cleanText(link.querySelector(SELECTORS.duration)?.text),
            views: cleanText(card.querySelector?.(SELECTORS.views)?.text || ''),
            externalUrl: href,
            playback: {
                kind: 'resolve',
                referer: ORIGIN + '/',
            },
        });
    }
    return videos;
}

function parsePlayback(html) {
    const root = loadHtml(html);
    const playable = root.querySelectorAll('video source')
        .map((source) => ({
            src: absUrl(source.getAttribute('src'), ORIGIN + '/'),
            label: (source.getAttribute('title') || '').toLowerCase(),
            type: (source.getAttribute('type') || '').toLowerCase(),
        }))
        .filter((source) => source.src && (source.type.includes('mp4') || /\/vsrc\//.test(source.src) || /\.mp4(\?|$)/i.test(source.src)));
    const best = playable.find((source) => source.label === 'hd' || /\/hd\//.test(source.src)) || playable[0];
    return best ? best.src : null;
}

async function fetchRanking(periodId) {
    const period = PERIODS[periodId];
    if (!period) throw new Error(`tokyomotion has no period ${periodId}`);
    const url = `${ORIGIN}/videos?${period.query}`;
    const response = await getText(url, { timeout: 20000, referer: ORIGIN + '/' });
    if (!response.ok || response.blocked) {
        throw new Error(`TokyoMotion ranking failed (${response.status}).`);
    }
    const videos = parseListing(response.text);
    if (videos.length === 0) {
        throw new Error('TokyoMotion returned no a.thumb-popu cards. Update SELECTORS in sources/tokyomotion.js.');
    }
    return videos;
}

async function resolvePlayback(id) {
    if (!/^\d+$/.test(id)) throw new Error('Invalid TokyoMotion video id');
    const pageUrl = `${ORIGIN}/video/${id}`;
    const response = await getText(pageUrl, { timeout: 20000, referer: ORIGIN + '/videos' });
    if (!response.ok || response.blocked) {
        throw new Error(`TokyoMotion video page failed (${response.status}).`);
    }
    const url = parsePlayback(response.text);
    if (!url) throw new Error('TokyoMotion video page had no <video><source>. Update parsePlayback in sources/tokyomotion.js.');
    return { kind: 'file', url, referer: response.url || pageUrl };
}

module.exports = {
    id: 'tokyomotion',
    name: 'TokyoMotion',
    color: '#ff7a18',
    homepage: ORIGIN + '/',
    periods: Object.entries(PERIODS).map(([id, period]) => ({ id, label: period.label })),
    mediaHosts: ['tokyomotion.net', 'tokyo-motion.net'],
    mediaReferer: ORIGIN + '/',
    cacheTtlMs: 10 * 60 * 1000,
    timeoutMs: 25000,
    fetchRanking,
    resolvePlayback,
    parseListing,
    parsePlayback,
    SELECTORS,
    PERIODS,
};
