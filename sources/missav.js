const { loadHtml, cleanText, absUrl } = require('../lib/html');
const { gotoHtml } = require('../lib/browser');

// MissAV ranking paths. The site 302s /ja/today-hot onto a rotating /dmNNN/
// prefix, so the prefix is not hardcoded. weekly-hot and monthly-hot are the
// other two boards; there is no 3-day board. The HTML is behind Cloudflare,
// so listing and the watch page go through the shared browser.
//
// The player builds https://surrit.com/<uuid>/playlist.m3u8. The uuid is in
// the seek-preview URLs (and a packed script). surrit.com is on mediaHosts
// because the playlist and its segments must be proxied with a MissAV Referer.

const SITE_BASES = [
    'https://missav.ws',
    'https://missav.ai',
    'https://missav.live',
    'https://missav123.com',
];

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

let basePromise = null;

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

function extractPlaylist(html) {
    const escaped = html.match(/surrit\.com\\?\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (escaped) return `https://surrit.com/${escaped[1]}/playlist.m3u8`;
    const plain = html.match(/surrit\.com\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (plain) return `https://surrit.com/${plain[1]}/playlist.m3u8`;
    return null;
}

async function openRanking(base, path) {
    const result = await gotoHtml(base + path, {
        waitFor: SELECTORS.card,
        challengeTimeout: 40000,
    });
    const videos = parseListing(result.html, base);
    if (videos.length === 0) {
        throw new Error(`MissAV page ${result.url} had no ${SELECTORS.card} cards.`);
    }
    return videos;
}

async function discoverBase() {
    const errors = [];
    for (const base of SITE_BASES) {
        try {
            const videos = await openRanking(base, PERIODS['24h'].path);
            console.log('[missav] Using', base);
            return { base, warmup: videos };
        } catch (err) {
            errors.push(`${base} (${err.message})`);
        }
    }
    throw new Error(`MissAV is unreachable. Tried ${errors.join('; ')}. Domains are SITE_BASES in sources/missav.js.`);
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
    if (!period) throw new Error(`missav has no period ${periodId}`);
    const found = await getBase();
    if (periodId === '24h' && found.warmup) {
        const videos = found.warmup;
        delete found.warmup;
        return videos;
    }
    return openRanking(found.base, period.path);
}

async function resolvePlayback(id) {
    if (!/^[a-z0-9-]+$/i.test(id)) throw new Error('Invalid MissAV video id');
    const found = await getBase();
    const pageUrl = `${found.base}/ja/${id}`;
    const result = await gotoHtml(pageUrl, { challengeTimeout: 40000 });
    const playlist = extractPlaylist(result.html);
    if (!playlist) {
        throw new Error('MissAV watch page had no surrit.com playlist id. Update extractPlaylist in sources/missav.js.');
    }
    return { kind: 'hls', url: playlist, referer: found.base + '/' };
}

module.exports = {
    id: 'missav',
    name: 'MissAV',
    color: '#7c5cff',
    homepage: 'https://missav.ws/',
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
    mediaReferer: 'https://missav.ws/',
    cacheTtlMs: 10 * 60 * 1000,
    timeoutMs: 50000,
    fetchRanking,
    resolvePlayback,
    parseListing,
    extractPlaylist,
    SELECTORS,
    PERIODS,
    SITE_BASES,
};
