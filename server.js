const http = require('http');
const fs = require('fs');
const path = require('path');
const sources = require('./sources');
const { proxyMedia, proxyStatus } = require('./lib/proxy');
const mirrors = require('./lib/mirrors');
const { closeBrowser, status: browserStatus } = require('./lib/browser');
const { staticPath } = require('./lib/static');
const { createAccessControl } = require('./lib/auth');
const { createTimingLog } = require('./src/feed-logic');

const PORT = process.env.PORT || 3000;
const access = createAccessControl();

// Rolling server-side timings per source and stage, read from /api/status.
// Only registered source ids are recorded, so a request cannot add labels.
const timings = createTimingLog();

function noteTiming(sourceId, stage, startedAt) {
    if (sources.get(sourceId)) timings.add(`${sourceId}:${stage}`, Date.now() - startedAt);
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
    '.webmanifest': 'application/manifest+json',
};

function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
    });
    res.end(payload);
}

function serveStatic(req, res) {
    const absPath = staticPath(req.url, __dirname);
    if (!absPath) {
        res.writeHead(404);
        res.end('Not Found');
        return;
    }
    const ext = path.extname(absPath);
    fs.readFile(absPath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not Found');
            return;
        }
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
        });
        res.end(data);
    });
}

// A rejected promise from this handler would be an unhandled rejection and
// take the whole server down for every viewer, so it is caught here.
const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
        console.error('[Server]', req.method, req.url && req.url.slice(0, 120), err && err.message);
        if (!res.headersSent) {
            sendJson(res, 500, { ok: false, error: 'Internal error' });
        } else if (!res.destroyed) {
            res.destroy();
        }
    });
});

async function handle(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (!access.guard(req, res)) return;
    let url;
    try {
        url = new URL(req.url, `http://localhost:${PORT}`);
    } catch {
        res.writeHead(400);
        res.end('Bad Request');
        return;
    }

    if (url.pathname === '/api/status') {
        sendJson(res, 200, {
            browser: browserStatus(),
            sources: sources.list(),
            disabledSources: sources.disabledIds(),
            domains: sources.domainStatus(),
            playback: sources.playbackConfig(),
            proxy: proxyStatus(),
            timings: timings.summary(),
            timestamp: new Date().toISOString(),
        });
        return;
    }

    if (url.pathname === '/api/sources') {
        sendJson(res, 200, { sources: sources.list(), playback: sources.playbackConfig() });
        return;
    }

    if (url.pathname === '/api/videos') {
        const sourceId = url.searchParams.get('source') || 'twivideo';
        const period = url.searchParams.get('period') || url.searchParams.get('sort') || '';
        const metric = (url.searchParams.get('metric') || '').slice(0, 20);
        // The client's startup request is sent before it knows what is hidden.
        if (url.searchParams.get('boot') === '1' && sources.sourceHidden(sourceId)) {
            sendJson(res, 200, { ok: false, bootSkipped: true, videos: [] });
            return;
        }
        try {
            const startedAt = Date.now();
            const board = await sources.fetchRanking(sourceId, period, { metric });
            noteTiming(sourceId, board.cached ? 'ranking-cached' : 'ranking', startedAt);
            // ?page=2,3,... is the infinite scroll's next page of the same board.
            const result = sources.pageRanking(board, url.searchParams.get('page'));
            const count = result.videos.length;
            console.log(`[API] ${sourceId} ${result.period && result.period.id}${result.metric ? ` ${result.metric}` : ''} page=${result.page || 1} ok=${result.ok} videos=${count}${result.cached ? ' cached' : ''}${result.fallback ? ' fallback' : ''}`);
            sendJson(res, 200, result);
        } catch (err) {
            sendJson(res, err.status || 500, { ok: false, error: err.message, videos: [] });
        }
        return;
    }

    if (url.pathname === '/api/resolve') {
        const sourceId = url.searchParams.get('source') || '';
        const id = url.searchParams.get('id') || '';
        try {
            const startedAt = Date.now();
            const result = await sources.resolvePlayback(sourceId, id, { fresh: url.searchParams.get('fresh') === '1' });
            noteTiming(sourceId, result.cached ? 'resolve-cached' : 'resolve', startedAt);
            // "unavailable" is a definite answer (media deleted), not a relay error.
            sendJson(res, result.ok || result.unavailable ? 200 : 502, result);
        } catch (err) {
            sendJson(res, err.status || 500, { ok: false, error: err.message, playback: null });
        }
        return;
    }

    if (url.pathname === '/api/external') {
        const sourceId = url.searchParams.get('source') || '';
        const id = url.searchParams.get('id') || '';
        try {
            const target = await sources.lookupExternal(sourceId, id);
            sendJson(res, 200, { ok: true, url: target });
        } catch (err) {
            sendJson(res, err.status || 502, { ok: false, error: err.message });
        }
        return;
    }

    if (url.pathname === '/favicon.ico') {
        res.writeHead(302, { Location: '/icons/icon-192.png' });
        res.end();
        return;
    }

    if (url.pathname === '/proxy/media' || url.pathname === '/proxy/playlist') {
        const sourceId = url.searchParams.get('source') || '';
        const targetUrl = url.searchParams.get('url') || '';
        const source = sources.proxyView(sourceId);
        const playlistOnly = url.pathname === '/proxy/playlist';
        if (!source || !targetUrl) {
            res.writeHead(400);
            res.end('Bad Request');
            return;
        }
        if (!playlistOnly && !mirrors.settings().fullProxyEnabled) {
            res.writeHead(403);
            res.end('Full proxy disabled');
            return;
        }
        const forwarded = req.headers['x-forwarded-proto'];
        const proto = forwarded ? String(forwarded).split(',')[0].trim() : 'http';
        const origin = req.headers.host ? `${proto}://${req.headers.host}` : '';
        await proxyMedia(targetUrl, source, req, res, {
            playlistOnly,
            origin,
            onFirstByte: (ms) => timings.add(`${sourceId}:proxy-first-byte`, ms),
        });
        return;
    }

    serveStatic(req, res);
}

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  TWIVIDEO Shorts`);
    console.log(`  Local:   http://localhost:${PORT}/`);
    console.log(`  Sources: ${sources.list().filter((source) => source.enabled).map((source) => source.id).join(', ')}`);
    console.log(`  Access:  ${access.enabled ? 'password required' : 'open (BASIC_AUTH_PASS is not set)'}`);
    console.log('  Browser launches on demand.\n');
});

let shuttingDown = false;

async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[Shutdown] Closing browser...');
    server.close();
    // Open relays would otherwise keep close() waiting.
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await closeBrowser();
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
