const { loadHtml, cleanText, absUrl } = require('../lib/html');
const { getText, responseFailure } = require('../lib/http');
const { withMirror, activeBase, embedTemplateFor, fillTemplate } = require('../lib/mirrors');

// Most-viewed boards. Pornhub's public listing is /video?o=mv with t=t|w|m
// (today / week / month). There is no 3-day board. Logged-out sessions in some
// regions are redirected to the safe-for-work homepage; listingIsRanking rejects
// that page so we don't present it as the ranking.
//
// Card markup (SELECTORS) matches the live pcVideoListItem component.
// Playback is resolved per video from mediaDefinitions on the watch page,
// which is HLS on *.phncdn.com. embedUrl is the iframe fallback.

const DEFAULT_BASES = [
    'https://www.pornhub.com',
    'https://jp.pornhub.com',
    'https://rt.pornhub.com',
];
const ORIGIN = DEFAULT_BASES[0];

// ja Accept-Language redirects onto jp.pornhub.com, whose mediaDefinitions
// point at hv-h.phncdn.com URLs that return 410. en-US stays on www and
// returns ev-h.phncdn.com playlists that actually stream.
const PAGE_HEADERS = {
    Cookie: 'accessAgeDisclaimerPH=2',
    'Accept-Language': 'en-US,en;q=0.9',
};

const SELECTORS = {
    card: 'li.pcVideoListItem',
    link: 'a',
    title: 'a.thumbnailTitle',
    duration: '.duration',
    views: '.views',
    author: '.usernameWrap a',
};

const PERIODS = {
    '24h': { label: '24時間', query: 't=t' },
    '7d': { label: '1週間', query: 't=w' },
    '30d': { label: '1ヶ月', query: 't=m' },
};

function currentBase() {
    return activeBase('pornhub') || ORIGIN;
}

function listingIsRanking(html, finalUrl) {
    let path = '';
    try {
        path = new URL(finalUrl).pathname;
    } catch {
        return false;
    }
    if (!/^\/video(\/|$)/.test(path)) return false;
    if (/pageKeyStat\s*=\s*["']sfw_homepage["']/.test(html)) return false;
    return html.includes('pcVideoListItem');
}

function parseListing(html, base = ORIGIN) {
    const root = loadHtml(html);
    const videos = [];
    for (const card of root.querySelectorAll(SELECTORS.card)) {
        const vkey = card.getAttribute('data-video-vkey');
        if (!vkey) continue;
        const titleEl = card.querySelector(SELECTORS.title);
        const link = card.querySelector(SELECTORS.link);
        const img = card.querySelector('img');
        const title = cleanText(
            titleEl?.getAttribute('title')
            || link?.getAttribute('title')
            || titleEl?.text
            || ''
        );
        const thumb = img?.getAttribute('data-mediumthumb') || img?.getAttribute('src') || '';
        videos.push({
            id: vkey,
            title,
            pageUrl: `${base}/view_video.php?viewkey=${encodeURIComponent(vkey)}`,
            thumbUrl: absUrl(thumb, base + '/'),
            duration: cleanText(card.querySelector(SELECTORS.duration)?.text),
            views: cleanText(card.querySelector(SELECTORS.views)?.text),
            author: cleanText(card.querySelector(SELECTORS.author)?.text),
            externalUrl: `${base}/view_video.php?viewkey=${encodeURIComponent(vkey)}`,
            playback: {
                kind: 'resolve',
                referer: base + '/',
            },
        });
    }
    return videos;
}

function extractMediaDefinitions(html) {
    const key = '"mediaDefinitions":';
    const at = html.indexOf(key);
    if (at < 0) return [];
    const start = html.indexOf('[', at);
    if (start < 0) return [];
    let depth = 0;
    for (let i = start; i < html.length; i += 1) {
        const ch = html[i];
        if (ch === '[') depth += 1;
        else if (ch === ']') {
            depth -= 1;
            if (depth === 0) {
                const raw = html.slice(start, i + 1).replace(/\\\//g, '/');
                try {
                    return JSON.parse(raw);
                } catch {
                    return [];
                }
            }
        }
    }
    return [];
}

function pickMedia(definitions) {
    const playable = (definitions || []).filter((item) => item && item.videoUrl && (item.format === 'hls' || item.format === 'mp4'));
    const hls = playable.filter((item) => item.format === 'hls');
    const preferred = hls.find((item) => item.defaultQuality)
        || hls.find((item) => String(item.quality) === '720')
        || hls.slice().sort((a, b) => (b.height || 0) - (a.height || 0))[0];
    if (preferred) return { kind: 'hls', url: preferred.videoUrl };
    const mp4 = playable.find((item) => item.format === 'mp4');
    if (mp4) return { kind: 'file', url: mp4.videoUrl };
    return null;
}

function getEmbedUrl(video) {
    const template = embedTemplateFor('pornhub');
    const base = currentBase();
    if (template) return fillTemplate(template, video, base);
    if (!video || !/^[a-zA-Z0-9]+$/.test(String(video.id || ''))) return null;
    return `${base}/embed/${video.id}`;
}

async function fetchRanking(periodId) {
    const period = PERIODS[periodId];
    if (!period) throw new Error(`pornhub has no period ${periodId}`);
    const { result } = await withMirror('pornhub', DEFAULT_BASES, async (base) => {
        const url = `${base}/video?o=mv&${period.query}`;
        const response = await getText(url, {
            timeout: 12000,
            headers: PAGE_HEADERS,
            referer: `${base}/`,
        });
        const failure = responseFailure(response);
        if (failure) throw new Error(failure);
        if (!listingIsRanking(response.text, response.url)) {
            throw new Error('redirected away from the ranking');
        }
        const videos = parseListing(response.text, base);
        if (videos.length === 0) throw new Error('no ranking cards');
        return videos;
    });
    return result;
}

async function resolvePlayback(id) {
    if (!/^[a-zA-Z0-9]+$/.test(id)) throw new Error('Invalid Pornhub video id');
    const embedUrl = getEmbedUrl({ id });
    try {
        const { result } = await withMirror('pornhub', DEFAULT_BASES, async (base) => {
            const pageUrl = `${base}/view_video.php?viewkey=${id}`;
            const response = await getText(pageUrl, {
                timeout: 12000,
                headers: PAGE_HEADERS,
                referer: `${base}/`,
            });
            const failure = responseFailure(response);
            if (failure) throw new Error(failure);
            const media = pickMedia(extractMediaDefinitions(response.text));
            if (!media) throw new Error('no mediaDefinitions');
            return media;
        });
        return { kind: result.kind, url: result.url, embedUrl, referer: `${currentBase()}/` };
    } catch (err) {
        if (!embedUrl) throw err;
        return { kind: 'embed', url: embedUrl, embedUrl, referer: `${currentBase()}/` };
    }
}

module.exports = {
    id: 'pornhub',
    name: 'Pornhub',
    color: '#ff9900',
    homepage: ORIGIN + '/',
    bases: DEFAULT_BASES,
    periods: Object.entries(PERIODS).map(([id, period]) => ({ id, label: period.label })),
    mediaHosts: ['pornhub.com', 'phncdn.com', 'phprcdn.com', 'ypncdn.com'],
    get mediaReferer() {
        return `${currentBase()}/`;
    },
    timeoutMs: 60000,
    fetchRanking,
    resolvePlayback,
    getEmbedUrl,
    parseListing,
    listingIsRanking,
    extractMediaDefinitions,
    pickMedia,
    SELECTORS,
    PERIODS,
};
