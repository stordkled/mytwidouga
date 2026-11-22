const { loadHtml, cleanText, absUrl } = require('../lib/html');
const { getText, responseFailure } = require('../lib/http');
const { withMirror, activeBase, embedTemplateFor, fillTemplate } = require('../lib/mirrors');

// Ranking URLs and card selectors. twivideo.net is behind Cloudflare, so this
// adapter renders the page in the shared browser. If the markup changes, update
// SELECTORS. Period ids match the site's order= values (24 / 7 / 30). There is
// no 3-day board; a request for 3d falls back in the registry.

const DEFAULT_BASES = ['https://twivideo.net'];
const ORIGIN = DEFAULT_BASES[0];

function currentBase() {
    return activeBase('twivideo') || ORIGIN;
}

const SELECTORS = {
    card: '.art_li',
    link: 'a.item_link',
    thumb: 'img',
    rank: '.item_ranking',
};

const PERIODS = {
    '24h': { label: '24時間', path: '?ranking', order: '24' },
    '7d': { label: '1週間', path: '?ranking_w', order: '7' },
    '30d': { label: '1ヶ月', path: '?ranking_m', order: '30' },
};

function parseListing(html, base = ORIGIN) {
    const root = loadHtml(html);
    const videos = [];
    for (const card of root.querySelectorAll(SELECTORS.card)) {
        const link = card.querySelector(SELECTORS.link);
        const img = card.querySelector(SELECTORS.thumb);
        if (!link || !img) continue;
        const videoUrl = absUrl(link.getAttribute('href'), base + '/');
        const thumbUrl = absUrl(img.getAttribute('src'), base + '/');
        if (!videoUrl) continue;
        const id = link.getAttribute('data-id') || videoUrl;
        const rankLabel = cleanText(card.querySelector(SELECTORS.rank)?.text) || '';
        videos.push({
            id,
            title: rankLabel ? `ランキング ${rankLabel}` : '',
            rankLabel: rankLabel || undefined,
            pageUrl: videoUrl,
            thumbUrl,
            externalUrl: '',
            lookup: true,
            playback: {
                kind: 'file',
                url: videoUrl,
                referer: 'https://twitter.com/',
            },
        });
    }
    return videos;
}

function getEmbedUrl(video) {
    const template = embedTemplateFor('twivideo');
    if (!template || !video) return null;
    return fillTemplate(template, video, currentBase());
}

async function fetchRanking(periodId) {
    const period = PERIODS[periodId];
    if (!period) throw new Error(`twivideo has no period ${periodId}`);
    const { result } = await withMirror('twivideo', DEFAULT_BASES, async (base) => {
        const response = await getText(`${base}/${period.path}`, { timeout: 12000, referer: `${base}/` });
        const failure = responseFailure(response);
        if (failure) throw new Error(failure);
        const videos = parseListing(response.text, base);
        if (videos.length === 0) throw new Error('no ranking cards');
        return videos;
    });
    return result;
}

async function lookupExternal(id) {
    const base = currentBase();
    const response = await getText(`${base}/api/link.php?id=${encodeURIComponent(id)}`, {
        timeout: 12000,
        accept: 'text/plain,*/*',
    });
    const failure = responseFailure(response);
    if (failure) throw new Error(failure);
    const url = response.text.trim();
    if (!/^https?:\/\//i.test(url)) {
        throw new Error('twivideo did not return an original post URL');
    }
    return url;
}

module.exports = {
    id: 'twivideo',
    name: 'TWIVIDEO',
    color: '#1d9bf0',
    homepage: ORIGIN + '/',
    bases: DEFAULT_BASES,
    periods: Object.entries(PERIODS).map(([id, period]) => ({ id, label: period.label })),
    mediaHosts: ['twimg.com', 'twitter.com', 'x.com', 'twivideo.net'],
    mediaReferer: 'https://twitter.com/',
    timeoutMs: 60000,
    fetchRanking,
    lookupExternal,
    getEmbedUrl,
    parseListing,
    SELECTORS,
    PERIODS,
};
