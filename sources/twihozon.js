const { loadHtml, cleanText, absUrl } = require('../lib/html');
const { getText, responseFailure } = require('../lib/http');
const { withMirror, activeBase } = require('../lib/mirrors');
const { bestVideo, firstThumb } = require('../lib/twimg');

// Twihozon is plain server-rendered HTML. Each ranking card links to
// /play-<id>-video.html and carries the pbs.twimg.com thumbnail and the
// video.twimg.com MP4. Boards: / (24時間), /week.html, /month.html
// (/all.html is all-time and not offered). There is no 3-day board.
//
// The card markup is not pinned to class names: a card is the largest
// element around a play link that contains no other video's play link.
// If a card has no MP4 in the listing, playback resolves from its play page.

const DEFAULT_BASES = ['https://www.twihozon.org'];
const ORIGIN = DEFAULT_BASES[0];

function currentBase() {
    return activeBase('twihozon') || ORIGIN;
}

const SELECTORS = {
    playLink: 'a[href*="play-"]',
    author: 'a[href*="/author-"]',
};
const PLAY_ID = /play-(\d{1,12})-video\.html/;
const PLAY_ID_ALL = /play-(\d{1,12})-video\.html/g;

const PERIODS = {
    '24h': { label: '24時間', path: '/' },
    '7d': { label: '1週間', path: '/week.html' },
    '30d': { label: '1ヶ月', path: '/month.html' },
};

function playIdsIn(html) {
    return new Set(Array.from(String(html || '').matchAll(PLAY_ID_ALL), (match) => match[1]));
}

function cardFor(link, id) {
    let card = link;
    let parent = link.parentNode;
    while (parent && parent.tagName) {
        const ids = playIdsIn(parent.outerHTML);
        if (ids.size > 1 || (ids.size === 1 && !ids.has(id))) break;
        card = parent;
        parent = parent.parentNode;
    }
    return card;
}

// Raw slice from this video's first play link up to the next video's first
// link. Used when cards are not wrapped in their own element.
function rawSlice(html, id, order) {
    const index = order.indexOf(id);
    const start = html.indexOf(`play-${id}-video.html`);
    if (start < 0) return '';
    const next = order[index + 1];
    const end = next ? html.indexOf(`play-${next}-video.html`, start) : -1;
    return html.slice(start, end > start ? end : start + 4000);
}

function numberText(value) {
    const match = String(value || '').match(/\d[\d,]*/);
    return match ? match[0].replace(/,/g, '') : '';
}

const VIEWS_ONLY = /^([\d,]+)\s*件の表示$/;
const VIEWS_IN = /(?<![\d,])([\d,]+)\s*件の表示/;
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']);

// Text of every text node in document order, one segment per node. The live
// page has no whitespace between elements, so `card.text` glues e.g. the end
// of a t.co link ("…OYez8") onto the view count ("284571件の表示"). Keeping
// node boundaries stops digits from neighbouring elements merging.
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

// The element that holds only "<n>件の表示" (e.g. <p class="views">).
function viewsElement(card) {
    if (VIEWS_ONLY.test(cleanText(card.text))) return card;
    return card.querySelectorAll('*').find((el) => VIEWS_ONLY.test(cleanText(el.text))) || null;
}

function parseCard(card) {
    const segmented = textSegments(card).join(' ');
    const element = viewsElement(card);
    const dedicated = element ? cleanText(element.text).match(VIEWS_ONLY) : null;
    const viewMatch = segmented.match(VIEWS_IN);
    const views = numberText(dedicated ? dedicated[1] : viewMatch?.[1]);
    // The save count follows the view count (an icon, then the number) and
    // must be a segment of its own (so a following date is not read as one).
    const after = viewMatch ? segmented.slice(viewMatch.index + viewMatch[0].length) : '';
    const saves = viewMatch ? numberText(after.match(/^\s*([\d,]+)(?=\s|$)/)?.[1]) : '';
    const title = cleanText(viewMatch ? segmented.slice(0, viewMatch.index) : segmented)
        .replace(/動画を保存する/g, '')
        .replace(/https?:\/\/t\.co\/\S+/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 140);
    return { views, saves, title };
}

function parseListing(html, base = ORIGIN) {
    const source = String(html || '');
    const root = loadHtml(source);
    const order = [];
    const firstLink = new Map();
    for (const link of root.querySelectorAll(SELECTORS.playLink)) {
        const match = (link.getAttribute('href') || '').match(PLAY_ID);
        if (!match) continue;
        if (!firstLink.has(match[1])) {
            firstLink.set(match[1], link);
            order.push(match[1]);
        }
    }

    const videos = [];
    for (const id of order) {
        const card = cardFor(firstLink.get(id), id);
        const cardHtml = card.outerHTML;
        let videoUrl = bestVideo(cardHtml);
        let thumb = firstThumb(cardHtml);
        if (!videoUrl || !thumb) {
            // Cards not wrapped in their own element: read from this
            // video's play link up to the next video's play link.
            const slice = rawSlice(source, id, order);
            videoUrl = videoUrl || bestVideo(slice);
            thumb = thumb || firstThumb(slice);
        }
        const { views, saves, title } = parseCard(card);
        const author = cleanText(card.querySelector(SELECTORS.author)?.text || '');
        const page = absUrl(`/play-${id}-video.html`, base + '/');
        videos.push({
            id,
            title: title || (author ? `${author} の動画` : ''),
            author,
            views: [
                views ? `${Number(views).toLocaleString('ja-JP')} 回表示` : '',
                saves ? `${Number(saves).toLocaleString('ja-JP')} 保存` : '',
            ].filter(Boolean).join(' · '),
            pageUrl: page,
            externalUrl: page,
            thumbUrl: thumb,
            playback: videoUrl
                ? { kind: 'file', url: videoUrl }
                : { kind: 'resolve' },
        });
    }
    return videos;
}

function parsePlayPage(html) {
    return bestVideo(html) || null;
}

async function fetchRanking(periodId) {
    const period = PERIODS[periodId];
    if (!period) throw new Error(`twihozon has no period ${periodId}`);
    const { result } = await withMirror('twihozon', DEFAULT_BASES, async (base) => {
        const response = await getText(`${base}${period.path}`, { timeout: 12000, referer: `${base}/` });
        const failure = responseFailure(response);
        if (failure) throw new Error(failure);
        const videos = parseListing(response.text, base);
        if (videos.length === 0) throw new Error('no ranking cards');
        return videos;
    });
    return result;
}

async function resolvePlayback(id) {
    if (!/^\d{1,12}$/.test(id)) throw new Error('Invalid Twihozon video id');
    const { result } = await withMirror('twihozon', DEFAULT_BASES, async (base) => {
        const response = await getText(`${base}/play-${id}-video.html`, { timeout: 12000, referer: `${base}/` });
        const failure = responseFailure(response);
        if (failure) throw new Error(failure);
        const url = parsePlayPage(response.text);
        if (!url) throw new Error('no video.twimg.com MP4 on the play page');
        return url;
    });
    return { kind: 'file', url: result };
}

module.exports = {
    id: 'twihozon',
    name: 'Twihozon',
    color: '#f59e0b',
    get homepage() {
        return currentBase() + '/';
    },
    bases: DEFAULT_BASES,
    periods: Object.entries(PERIODS).map(([id, period]) => ({ id, label: period.label })),
    mediaHosts: ['twimg.com'],
    mediaReferer: 'https://x.com/',
    timeoutMs: 30000,
    fetchRanking,
    resolvePlayback,
    parseListing,
    parsePlayPage,
    SELECTORS,
    PERIODS,
};
