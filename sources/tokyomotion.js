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

// The listing used to be parsed from a.thumb-popu. As of 2026-11-18 a card
// is an image (alt/title = title, cdn.tokyo-motion.net/media/videos/tmbNNN/
// <id>/N.jpg), an "HD" badge, the duration, a separate title link to
// /video/<id>/<slug>, an age ("2 days ago") and "<n> views". The parser
// no longer depends on class names: a card is the largest element around a
// /video/<id> link that links to no other video. Class hints are used only
// when present.
//
// o=mv&t=t ("added today") is often an empty board: HTTP 200, ~19 KB,
// "No Videos Found". That is not a parser failure; 今日 then falls back to
// this week's most viewed and says so.
const SELECTORS = {
    videoLink: 'a[href*="/video/"]',
    thumb: 'img',
    title: '.video-title',
    duration: '.duration',
    views: '.video-views',
};

const VIDEO_ID = /\/video\/(\d{1,12})(?=[/?#]|$)/;
const VIDEO_ID_ALL = /\/video\/(\d{1,12})(?=[/?#"'\s>]|$)/g;
const EMPTY_BOARD = /No Videos Found|動画が見つかりません|該当する動画はありません/i;
const DURATION = /^(?:\d{1,2}:)?\d{1,2}:\d{2}$/;
const BADGES = /^(?:HD)?\s*(?:(?:\d{1,2}:)?\d{1,2}:\d{2})?$/i;
const VIEWS = /^([\d,.]+\s*[KkMm]?)\s*(?:views?|回視聴|視聴|観覧|再生)/i;
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']);

const PERIODS = {
    '24h': {
        label: '今日',
        query: 'o=mv&t=t',
        fallback: { query: 'o=mv&t=w', notice: 'TokyoMotion の今日の動画がまだないため、今週の再生数順を表示しています' },
    },
    '7d': { label: '今週', query: 'o=mv&t=w' },
    '30d': { label: '今月', query: 'o=mv&t=m' },
};

function videoIdsIn(html) {
    return new Set(Array.from(String(html || '').matchAll(VIDEO_ID_ALL), (match) => match[1]));
}

function cardFor(link, id) {
    let card = link;
    let parent = link.parentNode;
    while (parent && parent.tagName && parent.tagName !== 'BODY') {
        const ids = videoIdsIn(parent.outerHTML);
        if (ids.size > 1 || (ids.size === 1 && !ids.has(id))) break;
        card = parent;
        parent = parent.parentNode;
    }
    return card;
}

function textSegments(node, out = []) {
    for (const child of node.childNodes || []) {
        if (child.nodeType === 3) {
            const text = cleanText(child.text);
            if (text) out.push(text);
        } else if (child.nodeType === 1 && !SKIP_TAGS.has(child.tagName)) {
            textSegments(child, out);
        }
    }
    return out;
}

function imageUrl(img, base) {
    if (!img) return '';
    for (const name of ['data-src', 'data-original', 'data-lazy-src', 'src']) {
        const value = (img.getAttribute(name) || '').trim();
        if (!value || /^data:/i.test(value) || /blank|spacer|placeholder|loading/i.test(value)) continue;
        const url = absUrl(value, base + '/');
        if (/^https?:/i.test(url)) return url;
    }
    return '';
}

function slugTitle(href) {
    const slug = (String(href).split(/[?#]/)[0].match(/\/video\/\d+\/([^/]+)/) || [])[1];
    if (!slug) return '';
    try {
        return cleanText(decodeURIComponent(slug).replace(/-/g, ' '));
    } catch {
        return '';
    }
}

function parseCard(card, links, id, base) {
    const hrefs = links.map((link) => absUrl(link.getAttribute('href'), base + '/'));
    const page = hrefs.find((href) => /\/video\/\d+\/[^/?#]/.test(href)) || hrefs[0];
    const img = card.querySelector(SELECTORS.thumb);
    const segments = textSegments(card);
    // The title link is the one without the thumbnail; the image link's
    // text is just badges ("HD01:43").
    const usable = (text) => text && !BADGES.test(text) && !VIEWS.test(text);
    const longest = (list) => list.map((link) => cleanText(link.text)).filter(usable)
        .sort((a, b) => b.length - a.length)[0] || '';
    const longestLink = longest(links.filter((link) => !link.querySelector('img')))
        || longest(links);
    const title = cleanText(card.querySelector(SELECTORS.title)?.text || '')
        || longestLink
        || cleanText(img?.getAttribute('alt') || img?.getAttribute('title') || '')
        || cleanText(links.map((link) => link.getAttribute('title')).find(Boolean) || '')
        || slugTitle(page);
    const duration = cleanText(card.querySelector(SELECTORS.duration)?.text || '')
        || segments.find((text) => DURATION.test(text))
        || '';
    const viewsText = cleanText(card.querySelector(SELECTORS.views)?.text || '')
        || segments.find((text) => VIEWS.test(text))
        || '';
    return {
        id,
        title: title.slice(0, 200),
        pageUrl: page,
        thumbUrl: imageUrl(img, base),
        duration,
        views: viewsText,
        externalUrl: page,
        playback: {
            kind: 'resolve',
            referer: ORIGIN + '/',
        },
    };
}

function isEmptyBoard(html) {
    return EMPTY_BOARD.test(String(html || ''));
}

function parseListing(html, base = ORIGIN) {
    const root = loadHtml(html);
    const order = [];
    const linksById = new Map();
    for (const link of root.querySelectorAll(SELECTORS.videoLink)) {
        const href = absUrl(link.getAttribute('href'), base + '/');
        let path = '';
        try {
            const url = new URL(href);
            // Same site only; a link to another host is not a listing card.
            if (url.hostname.replace(/^www\./, '') !== new URL(base).hostname.replace(/^www\./, '')) continue;
            path = url.pathname;
        } catch {
            continue;
        }
        const match = path.match(VIDEO_ID);
        if (!match) continue;
        if (!linksById.has(match[1])) {
            linksById.set(match[1], []);
            order.push(match[1]);
        }
        linksById.get(match[1]).push(link);
    }
    const videos = [];
    for (const id of order) {
        const links = linksById.get(id);
        const card = cardFor(links[0], id);
        // Every link to this id that sits inside the card (image + title).
        const inCard = links.filter((link) => link === card || card.outerHTML.includes(link.outerHTML));
        videos.push(parseCard(card, inCard.length ? inCard : links, id, base));
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
        const load = async (query) => {
            const response = await getText(`${base}/videos?${query}`, { timeout: 12000, referer: `${base}/` });
            const failure = responseFailure(response);
            if (failure) throw new Error(failure);
            const videos = parseListing(response.text, base);
            return { videos, empty: videos.length === 0 && isEmptyBoard(response.text) };
        };
        const first = await load(period.query);
        if (first.videos.length) return first.videos;
        if (first.empty && period.fallback) {
            const second = await load(period.fallback.query);
            if (second.videos.length) {
                second.videos.notice = period.fallback.notice;
                return second.videos;
            }
        }
        throw new Error(first.empty ? 'empty board (No Videos Found)' : 'no ranking cards');
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
    isEmptyBoard,
    parsePlayback,
    parseEmbedToken,
    SELECTORS,
    PERIODS,
};
