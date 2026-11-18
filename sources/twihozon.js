const { loadHtml, cleanText, absUrl } = require('../lib/html');
const { getText, responseFailure, probeMedia } = require('../lib/http');
const { withMirror, activeBase } = require('../lib/mirrors');
const { bestVideo, allVideos, sortVideos, firstThumb, videoUrl } = require('../lib/twimg');

// Twihozon is plain server-rendered HTML. Each ranking card links to
// /play-<id>-video.html and carries the pbs.twimg.com thumbnail and the
// video.twimg.com MP4. Boards: / (24時間), /week.html, /month.html
// (/all.html is all-time and not offered). There is no 3-day board.
//
// The card markup is not pinned to class names: a card is the largest
// element around a play link that contains no other video's play link.
// If a card has no MP4 in the listing, playback resolves from its play page.
//
// Checked live on 2026-11-18: every board still lists tweets from April
// 2025, and their video.twimg.com MP4s answer 403 in every resolution
// (the media is gone upstream; thumbnails still load). TwiKeep MP4s from
// the same CDN play, so this is not a Referer or signing problem. Resolve
// therefore probes each candidate MP4 and reports `unavailable` instead of
// handing the player a URL that stays at readyState 0.
//
// Card titles are the tweet text cut to ~50 chars, and many tweets are
// only a t.co link. The top page also carries the full records in an
// HTML comment (`var userinfo = <urlencoded JSON>`), which has the full
// text and every MP4 variant; both are used when present.

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
    const title = cleanTitle(viewMatch ? segmented.slice(0, viewMatch.index) : segmented);
    return { views, saves, title };
}

// t.co ids are alphanumeric; text glued after one (…AtXE動画) must survive.
function cleanTitle(text) {
    return cleanText(String(text || ''))
        .replace(/動画を保存する/g, '')
        .replace(/https?:\/\/t\.co\/[A-Za-z0-9]+/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 140);
}

const TRUNCATED = /(?:\.\.\.|…)$/;

// Card text first; the full tweet text when the card is empty or cut off.
function pickTitle(cardTitle, fullText) {
    const full = cleanTitle(fullText);
    if (!cardTitle) return full;
    if (full && TRUNCATED.test(cardTitle) && full.length >= cardTitle.replace(TRUNCATED, '').length) return full;
    return cardTitle;
}

// <!-- <script> var userinfo = %7B…%7D; … </script> --> on the board pages.
// Keys are play ids. Form-encoded: "+" is a space, a real "+" is %2B.
function parseUserInfo(html) {
    const out = new Map();
    const match = String(html || '').match(/var\s+userinfo\s*=\s*(%7B[A-Za-z0-9%._~+\-*!'()]*?%7D)\s*;/i);
    if (!match) return out;
    let data;
    try {
        data = JSON.parse(decodeURIComponent(match[1].replace(/\+/g, ' ')));
    } catch {
        return out;
    }
    if (!data || typeof data !== 'object') return out;
    for (const [key, item] of Object.entries(data)) {
        if (!/^\d{1,12}$/.test(key) || !item || typeof item !== 'object') continue;
        const variants = item.video_urls && typeof item.video_urls === 'object'
            ? sortVideos(Object.values(item.video_urls).map(videoUrl).filter(Boolean))
            : [];
        out.set(key, {
            fullText: typeof item.full_text === 'string' ? item.full_text.slice(0, 1000) : '',
            tweetId: /^\d{5,25}$/.test(String(item.tid || '')) ? String(item.tid) : '',
            screenName: /^[A-Za-z0-9_]{1,30}$/.test(String(item.screen_name || '')) ? item.screen_name : '',
            variants,
        });
    }
    return out;
}

// MP4 variants seen on the boards, by play id, for resolvePlayback. Bounded.
const knownVariants = new Map();
const MAX_KNOWN = 1000;

function rememberVariants(id, urls) {
    if (!urls || urls.length === 0) return;
    knownVariants.delete(id);
    knownVariants.set(id, urls.slice(0, 8));
    while (knownVariants.size > MAX_KNOWN) knownVariants.delete(knownVariants.keys().next().value);
}

function parseListing(html, base = ORIGIN) {
    const source = String(html || '');
    const info = parseUserInfo(source);
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
        const { views, saves, title: cardTitle } = parseCard(card);
        const record = info.get(id);
        if (record) rememberVariants(id, record.variants);
        const title = pickTitle(cardTitle, record && record.fullText);
        const author = cleanText(card.querySelector(SELECTORS.author)?.text || '');
        const page = absUrl(`/play-${id}-video.html`, base + '/');
        // A tweet that is only a t.co link has no text anywhere on the site
        // (the play page <title>/<h1> repeat the link), so name the poster.
        const handle = record && record.screenName ? `@${record.screenName}` : '';
        const fallback = author
            ? `${author}${handle ? ` (${handle})` : ''} の動画`
            : (handle ? `${handle} の動画` : '');
        videos.push({
            id,
            title: title || fallback,
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

// "<tweet text>動画を簡単に保存" in <h1>, "<tweet text>動画保存_簡単!｜…" in <title>.
function parsePlayTitle(html) {
    const root = loadHtml(String(html || ''));
    const heading = cleanText(root.querySelector('h1')?.text || '').replace(/動画を簡単に保存$/, '');
    const title = cleanText(root.querySelector('title')?.text || '').replace(/動画保存_簡単!?[｜|].*$/, '');
    return cleanTitle(heading) || cleanTitle(title);
}

const MAX_PROBES = 6;

function transientStatus(status) {
    return status === 0 || status === 408 || status === 429 || status >= 500;
}

function unavailable(message) {
    const error = new Error(message);
    error.unavailable = true;
    return error;
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
    const { result: html } = await withMirror('twihozon', DEFAULT_BASES, async (base) => {
        const response = await getText(`${base}/play-${id}-video.html`, { timeout: 12000, referer: `${base}/` });
        const failure = responseFailure(response);
        if (failure) throw new Error(failure);
        return response.text;
    });
    const title = parsePlayTitle(html);
    // The play page names one variant; the board data may list the others.
    const candidates = [...new Set([...allVideos(html), ...(knownVariants.get(id) || [])])].slice(0, MAX_PROBES);
    if (candidates.length === 0) throw unavailable('no video.twimg.com MP4 on the play page');
    const statuses = [];
    for (const url of candidates) {
        const probe = await probeMedia(url, { timeout: 6000 });
        if (probe.ok) return withTitle({ kind: 'file', url }, title);
        statuses.push(probe.status);
    }
    // A probe that could not reach the CDN (0) or got a transient
    // 408/429/5xx says nothing about the media: let the player's own ladder
    // try the best URL instead of calling it deleted and skipping it.
    if (statuses.some(transientStatus)) {
        return withTitle({ kind: 'file', url: candidates[0] }, title);
    }
    throw unavailable(`video.twimg.com answered HTTP ${[...new Set(statuses)].join('/')} for all ${candidates.length} MP4 variants (deleted upstream)`);
}

function withTitle(playback, title) {
    return title ? { ...playback, title } : playback;
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
    parsePlayTitle,
    parseUserInfo,
    knownVariants,
    SELECTORS,
    PERIODS,
};
