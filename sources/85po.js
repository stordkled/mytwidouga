const { loadHtml, cleanText, absUrl } = require('../lib/html');
const { getText, responseFailure } = require('../lib/http');
const { withMirror, activeBase, embedTemplateFor, fillTemplate } = require('../lib/mirrors');

// 85po is a KVS site. The popular board is /ja/most-popular/ and the period
// switch is an async block, not a plain query string (the full page ignores
// ?sort_by= and stays on "today"). There is no 3-day sort.
//
// 85po.com is often behind Cloudflare. SITE_BASES tries it first, then the
// 85po.net mirror that serves the same templates. Playback URLs are get_file
// MP4s that redirect to a CDN (ppxdd.com as of 2026-11); keep that host in
// mediaHosts if the CDN changes.

const DEFAULT_BASES = [
    'https://www.85po.com',
    'https://www.85po.net',
    'https://www.85ro.com',
];

const SELECTORS = {
    card: '#list_videos_common_videos_list_items .item',
    link: 'a',
    thumb: 'img.thumb',
    title: 'strong.title',
    duration: '.duration',
    views: '.views',
};

const PERIODS = {
    '24h': { label: '24時間', sort: 'video_viewed_today' },
    '7d': { label: '1週間', sort: 'video_viewed_week' },
    '30d': { label: '1ヶ月', sort: 'video_viewed_month' },
};

const BLOCK_ID = 'list_videos_common_videos_list';

function currentBase() {
    return activeBase('85po') || 'https://www.85po.net';
}

function parseListing(html, base) {
    const root = loadHtml(html);
    const videos = [];
    for (const card of root.querySelectorAll(SELECTORS.card)) {
        const link = card.querySelector(SELECTORS.link);
        if (!link) continue;
        const href = absUrl(link.getAttribute('href'), base + '/');
        const idMatch = href.match(/\/v\/(\d+)\.html/);
        if (!idMatch) continue;
        const img = card.querySelector(SELECTORS.thumb);
        const thumb = img?.getAttribute('data-original') || img?.getAttribute('data-webp') || '';
        videos.push({
            id: idMatch[1],
            title: cleanText(link.getAttribute('title') || card.querySelector(SELECTORS.title)?.text),
            pageUrl: href,
            thumbUrl: absUrl(thumb, base + '/'),
            duration: cleanText(card.querySelector(SELECTORS.duration)?.text),
            views: cleanText(card.querySelector(SELECTORS.views)?.text),
            externalUrl: href,
            playback: {
                kind: 'resolve',
                referer: base + '/',
            },
        });
    }
    return videos;
}

function pickMp4(html) {
    const found = new Set();
    const pattern = /https?:\\?\/\\?\/[^"'\\\s]+?\.mp4\/?(?:\?[^"'\\\s]*)?/gi;
    for (const match of html.matchAll(pattern)) {
        found.add(match[0].replace(/\\\//g, '/'));
    }
    const candidates = [...found].filter((url) => url.includes('/get_file/') && !url.includes('download=') && !url.includes('preview'));
    return candidates.find((url) => url.includes('720p'))
        || candidates.find((url) => /\/\d+\.mp4\/?$/.test(url.split('?')[0]))
        || candidates[0]
        || null;
}

function getEmbedUrl(video) {
    const template = embedTemplateFor('85po');
    const base = currentBase();
    if (template) return fillTemplate(template, video, base);
    if (!video || !/^\d+$/.test(String(video.id || ''))) return null;
    return `${base}/embed/${video.id}/`;
}

async function fetchRanking(periodId) {
    const period = PERIODS[periodId];
    if (!period) throw new Error(`85po has no period ${periodId}`);
    const { result } = await withMirror('85po', DEFAULT_BASES, async (base) => {
        const url = `${base}/ja/most-popular/?mode=async&function=get_block&block_id=${BLOCK_ID}&sort_by=${period.sort}`;
        const response = await getText(url, { timeout: 12000, referer: `${base}/ja/most-popular/` });
        const failure = responseFailure(response);
        if (failure) throw new Error(failure);
        const videos = parseListing(response.text, base);
        if (videos.length === 0) throw new Error('no ranking cards');
        return videos;
    });
    return result;
}

async function resolvePlayback(id) {
    if (!/^\d+$/.test(id)) throw new Error('Invalid 85po video id');
    const { base, result } = await withMirror('85po', DEFAULT_BASES, async (base) => {
        const pageUrl = `${base}/ja/v/${id}.html`;
        const response = await getText(pageUrl, { timeout: 12000, referer: `${base}/ja/most-popular/` });
        const failure = responseFailure(response);
        if (failure) throw new Error(failure);
        const url = pickMp4(response.text);
        if (!url) throw new Error('no get_file MP4');
        return { url, pageUrl };
    });
    const embedUrl = getEmbedUrl({ id });
    return { kind: 'file', url: result.url, embedUrl, referer: result.pageUrl || `${base}/` };
}

module.exports = {
    id: '85po',
    name: '85po',
    color: '#ff4d6d',
    homepage: 'https://www.85po.com/',
    periods: Object.entries(PERIODS).map(([id, period]) => ({ id, label: period.label })),
    bases: DEFAULT_BASES,
    mediaHosts: ['85po.com', '85po.net', '85ro.com', 'ppxdd.com'],
    get mediaReferer() {
        return `${currentBase()}/`;
    },
    timeoutMs: 60000,
    fetchRanking,
    resolvePlayback,
    getEmbedUrl,
    parseListing,
    pickMp4,
    SELECTORS,
    PERIODS,
};
