const { loadHtml, cleanText, absUrl } = require('../lib/html');
const { UA, getText, responseFailure } = require('../lib/http');
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

// ja Accept-Language redirects onto jp.pornhub.com. The watch page also
// alternates the signed host on www: ev-h.phncdn.com URLs (validfrom/hash)
// return a playlist, while hv-h.phncdn.com URLs (?h=&e=) answer 410 to a
// plain GET. Resolve probes a candidate and refetches until one plays.
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

// hv-h links signed with ?h=&e= are rejected by the CDN (410). ev-h links
// signed with validfrom/validto/hash return a playlist from the same IP.
function shortSignedHls(url) {
    const value = String(url || '');
    if (/hv-h\.phncdn\.com/i.test(value)) return true;
    return /[?&]h=/.test(value) && !/[?&]validfrom=/.test(value);
}

function mediaScore(item) {
    const url = String(item.videoUrl || '');
    let score = 0;
    if (item.format === 'hls') score += 100;
    else if (item.format === 'mp4') score += 40;
    if (String(item.quality) === '720') score += 30;
    else if (item.defaultQuality) score += 20;
    const height = Number(item.height) || Number(item.quality) || 0;
    if (height > 0 && height <= 1080) score += height / 100;
    if (shortSignedHls(url)) score -= 80;
    if (item.remote || url.includes('/video/get_media')) score -= 5;
    return score;
}

function rankMedia(definitions) {
    return (definitions || [])
        .filter((item) => item && item.videoUrl && (item.format === 'hls' || item.format === 'mp4' || item.remote))
        .map((item, index) => ({ item, index }))
        .sort((a, b) => mediaScore(b.item) - mediaScore(a.item) || a.index - b.index)
        .map((entry) => entry.item);
}

function pickMedia(definitions) {
    const preferred = rankMedia(definitions).find((item) => !item.remote && !String(item.videoUrl).includes('/video/get_media'));
    if (!preferred) return null;
    if (preferred.format === 'mp4') return { kind: 'file', url: preferred.videoUrl };
    return { kind: 'hls', url: preferred.videoUrl };
}

function mergeCookies(header, setCookie) {
    const jar = new Map();
    for (const part of String(header || '').split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0) jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }
    for (const cookie of setCookie || []) {
        const pair = String(cookie).split(';')[0];
        const eq = pair.indexOf('=');
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

function firstUri(playlist) {
    for (const line of String(playlist || '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) return trimmed;
    }
    return '';
}

async function fetchBytes(url, referer, headers) {
    const requestHeaders = {
        'User-Agent': UA,
        Accept: '*/*',
        ...headers,
    };
    if (referer) requestHeaders.Referer = referer;
    const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(12000),
        headers: requestHeaders,
    });
    return response;
}

async function playlistText(url, referer) {
    const response = await fetchBytes(url, referer);
    const text = await response.text();
    if (!response.ok || !text.startsWith('#EXTM3U')) return null;
    return { text, url: response.url || url };
}

async function startsWithSyncByte(url, referer) {
    const response = await fetchBytes(url, referer, { Range: 'bytes=0-187' });
    if (response.status !== 200 && response.status !== 206) {
        if (response.body) await response.body.cancel();
        return false;
    }
    const reader = response.body.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    return Boolean(value && value[0] === 0x47);
}

async function fileStarts(url, referer) {
    const response = await fetchBytes(url, referer, { Range: 'bytes=0-31' });
    if (response.status !== 200 && response.status !== 206) {
        if (response.body) await response.body.cancel();
        return false;
    }
    const reader = response.body.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    if (!value) return false;
    return Buffer.from(value).includes(Buffer.from('ftyp'));
}

// A usable HLS URL is one whose master is a playlist and whose first media
// segment loads with the watch-page Referer. Segments 404 when that Referer
// is missing, which is why playback goes through the relay.
async function hlsPlays(masterUrl, referer) {
    const master = await playlistText(masterUrl, referer);
    if (!master) return false;
    const listed = firstUri(master.text);
    if (!listed) return false;
    let mediaUrl = new URL(listed, master.url).href;
    if (/\.m3u8(\?|$)/i.test(new URL(mediaUrl).pathname)) {
        const variant = await playlistText(mediaUrl, referer);
        if (!variant) return false;
        const segment = firstUri(variant.text);
        if (!segment) return true;
        mediaUrl = new URL(segment, variant.url).href;
    }
    return startsWithSyncByte(mediaUrl, referer);
}

async function expandItem(item, referer, cookie) {
    const url = String(item.videoUrl || '');
    if (!url.includes('/video/get_media')) {
        if (item.format === 'mp4') return [{ kind: 'file', url }];
        if (item.format === 'hls') return [{ kind: 'hls', url }];
        return [];
    }
    let response;
    try {
        response = await fetch(url, {
            redirect: 'manual',
            signal: AbortSignal.timeout(12000),
            headers: {
                'User-Agent': UA,
                Accept: 'application/json, text/javascript, */*; q=0.01',
                Referer: referer,
                Origin: new URL(referer).origin,
                'X-Requested-With': 'XMLHttpRequest',
                Cookie: cookie,
            },
        });
    } catch {
        return [];
    }
    if (!response.ok) {
        if (response.body) await response.body.cancel();
        return [];
    }
    let data;
    try {
        data = await response.json();
    } catch {
        return [];
    }
    if (!Array.isArray(data)) return [];
    const expanded = [];
    for (const entry of rankMedia(data)) {
        const nested = String(entry.videoUrl || '');
        if (!nested || nested.includes('/video/get_media')) continue;
        expanded.push({ kind: entry.format === 'mp4' ? 'file' : 'hls', url: nested });
    }
    return expanded;
}

function choosePlayable(file, hls) {
    if (file && !file.needsReferer) return file;
    if (file) return file;
    return hls || null;
}

async function candidatePlays(media, referer) {
    try {
        if (media.kind === 'hls') return await hlsPlays(media.url, referer);
        const withReferer = await fileStarts(media.url, referer);
        if (!withReferer) return false;
        let withoutReferer = false;
        try {
            withoutReferer = await fileStarts(media.url, '');
        } catch {
            withoutReferer = false;
        }
        media.needsReferer = !withoutReferer;
        return true;
    } catch {
        return false;
    }
}

const RESOLVE_ATTEMPTS = 4;

async function findPlayable(base, id) {
    const pageUrl = `${base}/view_video.php?viewkey=${id}`;
    const referer = `${base}/`;
    let cookie = PAGE_HEADERS.Cookie;
    for (let attempt = 0; attempt < RESOLVE_ATTEMPTS; attempt += 1) {
        const response = await getText(pageUrl, {
            timeout: 12000,
            headers: { ...PAGE_HEADERS, Cookie: cookie },
            referer,
        });
        const failure = responseFailure(response);
        if (failure) throw new Error(failure);
        cookie = mergeCookies(cookie, response.cookies);
        let file = null;
        let hls = null;
        let probedShort = false;
        for (const item of rankMedia(extractMediaDefinitions(response.text))) {
            if (file && hls) break;
            const options = await expandItem(item, referer, cookie);
            for (const media of options) {
                if (media.kind === 'file' && file) continue;
                if (media.kind === 'hls' && hls) continue;
                if (media.kind === 'hls' && shortSignedHls(media.url)) {
                    if (probedShort) continue;
                    probedShort = true;
                }
                if (await candidatePlays(media, referer)) {
                    if (media.kind === 'file') file = media;
                    else hls = media;
                }
            }
        }
        const chosen = choosePlayable(file, hls);
        if (chosen) {
            console.log(`[pornhub] playable ${chosen.kind} on attempt ${attempt + 1} (${new URL(chosen.url).host})`);
            return chosen;
        }
    }
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
            const media = await findPlayable(base, id);
            if (!media) throw new Error('no playable media');
            return media;
        });
        return {
            kind: result.kind,
            url: result.url,
            embedUrl,
            referer: `${currentBase()}/`,
            needsReferer: !!result.needsReferer,
        };
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
    rankMedia,
    shortSignedHls,
    choosePlayable,
    SELECTORS,
    PERIODS,
};
