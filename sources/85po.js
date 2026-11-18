const { loadHtml, cleanText, absUrl } = require('../lib/html');
const { getText, looksBlocked } = require('../lib/http');

// 85po is a KVS site. The popular board is /ja/most-popular/ and the period
// switch is an async block, not a plain query string (the full page ignores
// ?sort_by= and stays on "today"). There is no 3-day sort.
//
// 85po.com is often behind Cloudflare. SITE_BASES tries it first, then the
// 85po.net mirror that serves the same templates. Playback URLs are get_file
// MP4s that redirect to a CDN (ppxdd.com as of 2026-11); keep that host in
// mediaHosts if the CDN changes.

const SITE_BASES = [
    'https://www.85po.com',
    'https://85po.com',
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

let basePromise = null;
let activeReferer = 'https://www.85po.net/';

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

async function discoverBase() {
    const errors = [];
    for (const base of SITE_BASES) {
        try {
            const response = await getText(`${base}/ja/most-popular/`, { timeout: 12000 });
            const usable = response.status === 200
                && !response.blocked
                && !looksBlocked(response.text)
                && response.text.includes(BLOCK_ID);
            if (usable) {
                activeReferer = base + '/';
                console.log('[85po] Using', base);
                return base;
            }
            errors.push(`${base} (${response.status}${response.blocked ? ', blocked' : ''})`);
        } catch (err) {
            errors.push(`${base} (${err.message})`);
        }
    }
    throw new Error(`85po is unreachable. Tried ${errors.join('; ')}.`);
}

function getBase() {
    if (!basePromise) {
        basePromise = discoverBase().catch((err) => {
            basePromise = null;
            throw err;
        });
    }
    return basePromise;
}

async function fetchRanking(periodId) {
    const period = PERIODS[periodId];
    if (!period) throw new Error(`85po has no period ${periodId}`);
    const base = await getBase();
    const url = `${base}/ja/most-popular/?mode=async&function=get_block&block_id=${BLOCK_ID}&sort_by=${period.sort}`;
    const response = await getText(url, { timeout: 20000, referer: `${base}/ja/most-popular/` });
    if (!response.ok || response.blocked) {
        throw new Error(`85po ranking request failed (${response.status}).`);
    }
    const videos = parseListing(response.text, base);
    if (videos.length === 0) {
        throw new Error('85po returned no .item cards. Update SELECTORS in sources/85po.js.');
    }
    return videos;
}

async function resolvePlayback(id) {
    if (!/^\d+$/.test(id)) throw new Error('Invalid 85po video id');
    const base = await getBase();
    const pageUrl = `${base}/ja/v/${id}.html`;
    const response = await getText(pageUrl, { timeout: 20000, referer: `${base}/ja/most-popular/` });
    if (!response.ok || response.blocked) {
        throw new Error(`85po video page failed (${response.status}).`);
    }
    const url = pickMp4(response.text);
    if (!url) throw new Error('85po video page had no get_file MP4. Update pickMp4 in sources/85po.js.');
    return { kind: 'file', url, referer: pageUrl };
}

module.exports = {
    id: '85po',
    name: '85po',
    color: '#ff4d6d',
    homepage: 'https://www.85po.com/',
    periods: Object.entries(PERIODS).map(([id, period]) => ({ id, label: period.label })),
    mediaHosts: ['85po.com', '85po.net', '85ro.com', 'ppxdd.com'],
    get mediaReferer() {
        return activeReferer;
    },
    cacheTtlMs: 10 * 60 * 1000,
    timeoutMs: 25000,
    fetchRanking,
    resolvePlayback,
    parseListing,
    pickMp4,
    SELECTORS,
    PERIODS,
    SITE_BASES,
};
