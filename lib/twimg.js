// Helpers for sources whose media lives on the Twitter CDN.
// video.twimg.com MP4s and pbs.twimg.com thumbnails play/load without a
// Referer, so these sources start on the "direct" step of the ladder.

const VIDEO_HOST = 'video.twimg.com';
const THUMB_HOST = 'pbs.twimg.com';

function decodeEntities(value) {
    return String(value || '')
        .replace(/\\\//g, '/')
        .replace(/&amp;/gi, '&')
        .replace(/&#x2F;/gi, '/')
        .replace(/&#47;/g, '/')
        .replace(/&quot;/gi, '"');
}

function cleanTwimgUrl(raw, host) {
    if (!raw) return '';
    let url;
    try {
        // &quot; inside an attribute ends the URL once decoded.
        url = new URL(decodeEntities(raw).split('"')[0].trim());
    } catch {
        return '';
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    if (url.hostname.toLowerCase() !== host) return '';
    url.protocol = 'https:';
    return url.href;
}

function videoUrl(raw) {
    return cleanTwimgUrl(raw, VIDEO_HOST);
}

function thumbUrl(raw) {
    return cleanTwimgUrl(raw, THUMB_HOST);
}

// Every video.twimg.com / pbs.twimg.com URL in a chunk of HTML or JSON,
// in document order, de-duplicated. MP4s come before playlists.
function findTwimg(text, host) {
    const escaped = host.replace(/\./g, '\\.');
    // Also matches the JSON-escaped form (https:\/\/video.twimg.com\/…).
    const pattern = new RegExp(`https?:(?:\\\\/|/){2}${escaped}(?:\\\\/|/)(?:[^"'\\s<>()\\\\]|\\\\/)*`, 'gi');
    const out = [];
    for (const match of String(text || '').matchAll(pattern)) {
        const url = cleanTwimgUrl(match[0], host);
        if (url && !out.includes(url)) out.push(url);
    }
    return out;
}

function bestVideo(text) {
    const all = findTwimg(text, VIDEO_HOST);
    const mp4 = all.filter((url) => /\.mp4(?:$|\?)/i.test(url));
    if (mp4.length === 0) return '';
    // Prefer the largest WxH in the path (…/vid/avc1/720x1280/…).
    const area = (url) => {
        const size = url.match(/\/(\d{2,4})x(\d{2,4})\//);
        return size ? Number(size[1]) * Number(size[2]) : 0;
    };
    return mp4.slice().sort((a, b) => area(b) - area(a))[0];
}

function firstThumb(text) {
    return findTwimg(text, THUMB_HOST)[0] || '';
}

function tweetUrl(userName, tweetId) {
    if (!/^\d{5,25}$/.test(String(tweetId || ''))) return '';
    const user = /^[A-Za-z0-9_]{1,30}$/.test(String(userName || '')) ? userName : 'i';
    return `https://x.com/${user}/status/${tweetId}`;
}

module.exports = {
    VIDEO_HOST,
    THUMB_HOST,
    videoUrl,
    thumbUrl,
    findTwimg,
    bestVideo,
    firstThumb,
    tweetUrl,
    decodeEntities,
};
