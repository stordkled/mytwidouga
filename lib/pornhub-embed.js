const pornhub = require('../sources/pornhub');
const mirrors = require('./mirrors');

function embedPlayerHtml(playback, offset, { fullProxyEnabled = true } = {}) {
    // Serve only our player, never upstream HTML/scripts on the app's origin.
    // Respect the relay switch; direct playback is resolved without a Referer.
    const config = JSON.stringify({
        kind: playback.kind,
        url: fullProxyEnabled
            ? '/proxy/media?source=pornhub&url=' + encodeURIComponent(playback.url)
            : playback.url,
        offset,
    }).replace(/</g, '\\u003c');
    return [
        '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer">',
        '<title>動画プレイヤー</title><style>',
        'html,body{margin:0;width:100%;height:100%;background:#000;color:#fff}',
        'video{width:100%;height:100%;object-fit:contain}#error{position:absolute;inset:40% 1em;text-align:center}',
        '</style></head><body>',
        '<video id="player" autoplay muted playsinline controls></video><p id="error" hidden>動画を再生できませんでした</p>',
        '<script id="playback" type="application/json">' + config + '</script>',
        '<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.min.js"></script>',
        '<script src="/src/feed-logic.js?v=16"></script><script src="/src/embed-player.js?v=1"></script>',
        '</body></html>',
    ].join('\n');
}

async function servePornhubEmbed(req, res, url) {
    if (req.method !== 'GET') {
        res.writeHead(405, { Allow: 'GET' });
        res.end('Method Not Allowed');
        return;
    }
    const id = url.searchParams.get('id') || '';
    const rawOffset = url.searchParams.get('start');
    const offset = rawOffset && rawOffset.trim() ? Number(rawOffset) : NaN;
    if (!/^[a-zA-Z0-9]{1,80}$/.test(id) || !Number.isFinite(offset) || offset < 0) {
        res.writeHead(400);
        res.end('Bad Request');
        return;
    }
    try {
        const fullProxyEnabled = mirrors.settings().fullProxyEnabled;
        const playback = await pornhub.resolveEmbedPlayback(id, { directOnly: !fullProxyEnabled });
        // Allow CDN media/fetches only in direct mode. Scripts remain restricted
        // to our player and hls.js, including for an upstream-supplied URL.
        const cdn = fullProxyEnabled ? '' : pornhub.mediaHosts
            .flatMap((host) => [`https://${host}`, `https://*.${host}`]).join(' ');
        const mediaSources = ["'self'", cdn].filter(Boolean).join(' ');
        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy': `default-src 'none'; script-src 'self' https://cdn.jsdelivr.net; style-src 'unsafe-inline'; media-src ${mediaSources} blob:; connect-src ${mediaSources}; worker-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
        });
        res.end(embedPlayerHtml(playback, offset, { fullProxyEnabled }));
    } catch {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('Pornhubの埋め込みプレイヤーを読み込めませんでした');
    }
}

module.exports = { embedPlayerHtml, servePornhubEmbed };
