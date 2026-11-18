const { loadHtml, cleanText, absUrl } = require('../lib/html');
const { getText, responseFailure } = require('../lib/http');
const { withMirror, activeBase, embedTemplateFor, fillTemplate } = require('../lib/mirrors');

// TokyoMotion's video list is /videos. o=mv is "most viewed" and t=t|w|m limits
// that to videos added today / this week / this month (the site has no separate
// "viewed during" window, and no 3-day filter). The watch page exposes a
// same-origin /vsrc/... MP4 that 301s to wwwNN.tokyomotion.net. Both hosts are
// covered by mediaHosts.

const DEFAULT_BASES = ['https://www.tokyomotion.net'];
const ORIGIN = DEFAULT_BASES[0];

function currentBase() {
    return activeBase('tokyomotion') || ORIGIN;
}

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

function parseListing(html, base = ORIGIN) {
    const root = loadHtml(html);
    const videos = [];
    for (const link of root.querySelectorAll(SELECTORS.card)) {
        const href = absUrl(link.getAttribute('href'), base + '/');
        const idMatch = href.match(/\/video\/(\d+)/);
        if (!idMatch) continue;
        const card = link.parentNode || link;
        const img = link.querySelector(SELECTORS.thumb);
        videos.push({
            id: idMatch[1],
            title: cleanText(link.querySelector(SELECTORS.title)?.text || img?.getAttribute('alt')),
            pageUrl: href,
            thumbUrl: absUrl(img?.getAttribute('src'), base + '/'),
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

function parsePlayback(html, base = ORIGIN) {
    const root = loadHtml(html);
    const playable = root.querySelectorAll('video source')
        .map((source) => ({
            src: absUrl(source.getAttribute('src'), base + '/'),
            label: (source.getAttribute('title') || '').toLowerCase(),
            type: (source.getAttribute('type') || '').toLowerCase(),
        }))
        .filter((source) => source.src && (source.type.includes('mp4') || /\/vsrc\//.test(source.src) || /\.mp4(\?|$)/i.test(source.src)));
    const best = playable.find((source) => source.label === 'hd' || /\/hd\//.test(source.src)) || playable[0];
    return best ? best.src : null;
}

function parseEmbedToken(html) {
    const match = html.match(/\/embed\/([a-f0-9]{8,})/i);
    return match ? match[1] : null;
}

function getEmbedUrl(video) {
    const template = embedTemplateFor('tokyomotion');
    const base = currentBase();
    if (template) return fillTemplate(template, video, base);
    if (!video || !video.embedToken) return null;
    return `${base}/embed/${video.embedToken}`;
}

async function fetchRanking(periodId) {
    const period = PERIODS[periodId];
    if (!period) throw new Error(`tokyomotion has no period ${periodId}`);
    const { result } = await withMirror('tokyomotion', DEFAULT_BASES, async (base) => {
        const response = await getText(`${base}/videos?${period.query}`, { timeout: 12000, referer: `${base}/` });
        const failure = responseFailure(response);
        if (failure) throw new Error(failure);
        const videos = parseListing(response.text, base);
        if (videos.length === 0) throw new Error('no ranking cards');
        return videos;
    });
    return result;
}

async function resolvePlayback(id) {
    if (!/^\d+$/.test(id)) throw new Error('Invalid TokyoMotion video id');
    const { base, result } = await withMirror('tokyomotion', DEFAULT_BASES, async (base) => {
        const response = await getText(`${base}/video/${id}`, { timeout: 12000, referer: `${base}/videos` });
        const failure = responseFailure(response);
        if (failure) throw new Error(failure);
        const url = parsePlayback(response.text, base);
        const embedToken = parseEmbedToken(response.text);
        if (!url && !embedToken) throw new Error('no media or embed token');
        return { url, embedToken };
    });
    const embedUrl = getEmbedUrl({ id, embedToken: result.embedToken });
    if (!result.url) return { kind: 'embed', url: embedUrl, embedUrl, referer: `${base}/` };
    return { kind: 'file', url: result.url, embedUrl, referer: `${base}/` };
}

module.exports = {
    id: 'tokyomotion',
    name: 'TokyoMotion',
    color: '#ff7a18',
    homepage: ORIGIN + '/',
    bases: DEFAULT_BASES,
    periods: Object.entries(PERIODS).map(([id, period]) => ({ id, label: period.label })),
    mediaHosts: ['tokyomotion.net', 'tokyo-motion.net'],
    get mediaReferer() {
        return `${currentBase()}/`;
    },
    timeoutMs: 60000,
    fetchRanking,
    resolvePlayback,
    getEmbedUrl,
    parseListing,
    parsePlayback,
    parseEmbedToken,
    SELECTORS,
    PERIODS,
};
