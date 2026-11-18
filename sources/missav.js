const { loadHtml, cleanText, absUrl } = require('../lib/html');
const { getText, responseFailure } = require('../lib/http');
const { withMirror, activeBase, playlistHostsFor, embedTemplateFor, fillTemplate } = require('../lib/mirrors');

// MissAV ranking paths. /ja/today-hot redirects onto a rotating /dmNNN/ prefix,
// so the prefix is not hardcoded. A block page tries the next base in
// config/sources.json. Plain HTTP only: a Cloudflare challenge is a failure,
// not something this adapter solves.
//
// The player builds https://surrit.com/<uuid>/playlist.m3u8. Extra playlist
// hosts belong in playlistHosts / SOURCE_PLAYLIST_HOSTS_MISSAV. No official
// embed URL was found; set SOURCE_EMBED_MISSAV=https://host/embed/{id} to add one.

const DEFAULT_BASES = [
    'https://missav.ws',
    'https://missav.ai',
    'https://missav.live',
    'https://missav123.com',
];
const DEFAULT_PLAYLIST_HOSTS = ['surrit.com'];

const SELECTORS = {
    card: '.thumbnail.group',
    link: 'a[href]',
    thumb: 'img',
    title: '.my-2 a',
    duration: 'span.absolute',
};

const PERIODS = {
    '24h': { label: '今日', path: '/ja/today-hot' },
    '7d': { label: '週間', path: '/ja/weekly-hot' },
    '30d': { label: '月間', path: '/ja/monthly-hot' },
};

function currentBase() {
    return activeBase('missav') || DEFAULT_BASES[0];
}

function parseListing(html, base) {
    const root = loadHtml(html);
    const videos = [];
    const seen = new Set();
    for (const card of root.querySelectorAll(SELECTORS.card)) {
        const link = card.querySelector(SELECTORS.title) || card.querySelector('a[href]');
        const href = absUrl(link?.getAttribute('href'), base + '/');
        if (!href) continue;
        let id = '';
        try {
            const parts = new URL(href).pathname.split('/').filter(Boolean);
            id = parts[parts.length - 1];
        } catch {
            continue;
        }
        if (!id || seen.has(id) || id.includes('today-hot') || id.includes('weekly-hot') || id.includes('monthly-hot')) continue;
        seen.add(id);
        const img = card.querySelector(SELECTORS.thumb);
        const thumb = img?.getAttribute('src') || img?.getAttribute('data-src') || '';
        videos.push({
            id,
            title: cleanText(card.querySelector(SELECTORS.title)?.text || img?.getAttribute('alt')),
            pageUrl: href,
            thumbUrl: absUrl(thumb, base + '/'),
            duration: cleanText(card.querySelector(SELECTORS.duration)?.text),
            externalUrl: href,
            playback: {
                kind: 'resolve',
                referer: base + '/',
            },
        });
    }
    return videos;
}

function extractPlaylist(html, hosts = playlistHostsFor('missav', DEFAULT_PLAYLIST_HOSTS)) {
    const list = hosts.length ? hosts : DEFAULT_PLAYLIST_HOSTS;
    for (const host of list) {
        const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = html.match(new RegExp(`${escaped}\\\\?/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`, 'i'));
        if (match) return `https://${host}/${match[1]}/playlist.m3u8`;
    }
    return null;
}

function getEmbedUrl(video) {
    const template = embedTemplateFor('missav');
    if (!template || !video) return null;
    return fillTemplate(template, video, currentBase());
}

async function fetchRanking(periodId) {
    const period = PERIODS[periodId];
    if (!period) throw new Error(`missav has no period ${periodId}`);
    const { result } = await withMirror('missav', DEFAULT_BASES, async (base) => {
        const response = await getText(base + period.path, { timeout: 12000, referer: `${base}/` });
        const failure = responseFailure(response);
        if (failure) throw new Error(failure);
        const videos = parseListing(response.text, base);
        if (videos.length === 0) throw new Error('no ranking cards');
        return videos;
    });
    return result;
}

async function resolvePlayback(id) {
    if (!/^[a-z0-9-]+$/i.test(id)) throw new Error('Invalid MissAV video id');
    const embedUrl = getEmbedUrl({ id });
    try {
        const { result } = await withMirror('missav', DEFAULT_BASES, async (base) => {
            const response = await getText(`${base}/ja/${id}`, { timeout: 12000, referer: `${base}/` });
            const failure = responseFailure(response);
            if (failure) throw new Error(failure);
            const playlist = extractPlaylist(response.text);
            if (!playlist) throw new Error('no playlist id');
            return { playlist, referer: `${base}/` };
        });
        return { kind: 'hls', url: result.playlist, embedUrl, referer: result.referer };
    } catch (err) {
        if (!embedUrl) throw err;
        return { kind: 'embed', url: embedUrl, embedUrl, referer: `${currentBase()}/` };
    }
}

module.exports = {
    id: 'missav',
    name: 'MissAV',
    color: '#7c5cff',
    homepage: 'https://missav.ws/',
    bases: DEFAULT_BASES,
    playlistHosts: DEFAULT_PLAYLIST_HOSTS,
    periods: Object.entries(PERIODS).map(([id, period]) => ({ id, label: period.label })),
    mediaHosts: [
        'missav.ws',
        'missav.ai',
        'missav.live',
        'missav123.com',
        'missav.com',
        'surrit.com',
        'fourhoi.com',
    ],
    get mediaReferer() {
        return `${currentBase()}/`;
    },
    timeoutMs: 60000,
    fetchRanking,
    resolvePlayback,
    getEmbedUrl,
    parseListing,
    extractPlaylist,
    SELECTORS,
    PERIODS,
};
