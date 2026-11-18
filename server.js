const http = require('http');
const fs = require('fs');
const path = require('path');
const sources = require('./sources');
const { proxyMedia } = require('./lib/proxy');
const { closeBrowser, status: browserStatus } = require('./lib/browser');

const PORT = process.env.PORT || 3000;

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
    const filePath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    const absPath = path.join(__dirname, filePath);
    if (!absPath.startsWith(__dirname)) {
        res.writeHead(403);
        res.end('Forbidden');
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

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === '/api/status') {
        sendJson(res, 200, {
            browser: browserStatus(),
            sources: sources.list(),
            timestamp: new Date().toISOString(),
        });
        return;
    }

    if (url.pathname === '/api/sources') {
        sendJson(res, 200, { sources: sources.list() });
        return;
    }

    if (url.pathname === '/api/videos') {
        const sourceId = url.searchParams.get('source') || 'twivideo';
        const period = url.searchParams.get('period') || url.searchParams.get('sort') || '';
        try {
            const result = await sources.fetchRanking(sourceId, period);
            const count = result.videos.length;
            console.log(`[API] ${sourceId} ${result.period && result.period.id} ok=${result.ok} videos=${count}${result.cached ? ' cached' : ''}${result.fallback ? ' fallback' : ''}`);
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
            const result = await sources.resolvePlayback(sourceId, id);
            sendJson(res, result.ok ? 200 : 502, result);
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

    if (url.pathname === '/proxy/media') {
        const sourceId = url.searchParams.get('source') || '';
        const targetUrl = url.searchParams.get('url') || '';
        const source = sources.get(sourceId);
        if (!source || !targetUrl) {
            res.writeHead(400);
            res.end('Bad Request');
            return;
        }
        await proxyMedia(targetUrl, source, req, res);
        return;
    }

    serveStatic(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  TWIVIDEO Shorts`);
    console.log(`  Local:   http://localhost:${PORT}/`);
    console.log(`  Sources: ${sources.list().map((source) => source.id).join(', ')}`);
    console.log('  Browser launches on demand.\n');
});

async function shutdown() {
    console.log('\n[Shutdown] Closing browser...');
    server.close();
    await closeBrowser();
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
