const { loadHtml, cleanText, absUrl } = require('../lib/html');
const { gotoHtml, waitForClearance } = require('../lib/browser');
const { getText } = require('../lib/http');

// Ranking URLs and card selectors. twivideo.net is behind Cloudflare, so this
// adapter renders the page in the shared browser. If the markup changes, update
// SELECTORS. Period ids match the site's order= values (24 / 7 / 30). There is
// no 3-day board; a request for 3d falls back in the registry.

const ORIGIN = 'https://twivideo.net';

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

function parseListing(html) {
    const root = loadHtml(html);
    const videos = [];
    for (const card of root.querySelectorAll(SELECTORS.card)) {
        const link = card.querySelector(SELECTORS.link);
        const img = card.querySelector(SELECTORS.thumb);
        if (!link || !img) continue;
        const videoUrl = absUrl(link.getAttribute('href'), ORIGIN + '/');
        const thumbUrl = absUrl(img.getAttribute('src'), ORIGIN + '/');
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

async function loadRankingHtml(page, period) {
    const url = `${ORIGIN}/${period.path}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await waitForClearance(page);
    const count = await page.evaluate((selector) => document.querySelectorAll(selector).length, SELECTORS.card);
    if (count > 0) return page.content();

    return page.evaluate(async (order) => {
        const body = `offset=0&limit=30&tag=null&type=ranking&order=${order}&le=1000&ty=p6&myarray=[]&offset_int=0`;
        const response = await fetch('https://twivideo.net/templates/view_lists.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });
        return response.text();
    }, period.order);
}

async function fetchRanking(periodId) {
    const period = PERIODS[periodId];
    if (!period) throw new Error(`twivideo has no period ${periodId}`);
    const { withPage } = require('../lib/browser');
    const html = await withPage((page) => loadRankingHtml(page, period));
    const videos = parseListing(html);
    if (videos.length === 0) {
        throw new Error('twivideo.net returned no ranking cards. Cloudflare may be blocking this network. Selectors live in sources/twivideo.js (SELECTORS).');
    }
    return videos;
}

async function lookupExternal(id) {
    const response = await getText(`${ORIGIN}/api/link.php?id=${encodeURIComponent(id)}`, {
        timeout: 15000,
        accept: 'text/plain,*/*',
    });
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
    periods: Object.entries(PERIODS).map(([id, period]) => ({ id, label: period.label })),
    mediaHosts: ['twimg.com', 'twitter.com', 'x.com', 'twivideo.net'],
    mediaReferer: 'https://twitter.com/',
    cacheTtlMs: 10 * 60 * 1000,
    timeoutMs: 50000,
    fetchRanking,
    lookupExternal,
    parseListing,
    SELECTORS,
    PERIODS,
};
