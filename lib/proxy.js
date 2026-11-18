const http = require('http');
const https = require('https');
const { UA } = require('./http');

const MAX_REDIRECTS = 5;
const PLAYLIST_LIMIT = 2 * 1024 * 1024;
const UPSTREAM_IDLE_MS = 30000;

function proxySettings() {
    try {
        return require('./mirrors').settings();
    } catch {
        return {};
    }
}

function maxStreams() {
    return proxySettings().maxProxyStreams || 3;
}

function maxStreamsPerClient() {
    return proxySettings().maxProxyStreamsPerClient || 2;
}

function queueMs() {
    return proxySettings().proxyQueueMs || 8000;
}

// Counts open full relays, globally and per viewer. A viewer over its share
// waits in a short queue instead of getting an instant 429, and one viewer
// cannot take every slot from the others.
function createStreamLimiter(options = {}) {
    const read = (value, fallback) => {
        const raw = typeof value === 'function' ? value() : value;
        const parsed = Number(raw);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    };
    const maxOf = () => read(options.max, 3);
    const perClientOf = () => read(options.perClient, Infinity);
    let active = 0;
    const byClient = new Map();
    const queue = [];

    function canTake(key) {
        return active < maxOf() && (byClient.get(key) || 0) < perClientOf();
    }

    function take(key) {
        active += 1;
        byClient.set(key, (byClient.get(key) || 0) + 1);
        let done = false;
        return function release() {
            if (done) return;
            done = true;
            active = Math.max(0, active - 1);
            const left = (byClient.get(key) || 1) - 1;
            if (left <= 0) byClient.delete(key);
            else byClient.set(key, left);
            pump();
        };
    }

    function pump() {
        for (let i = 0; i < queue.length;) {
            const waiter = queue[i];
            if (!canTake(waiter.key)) {
                i += 1;
                continue;
            }
            queue.splice(i, 1);
            clearTimeout(waiter.timer);
            waiter.resolve(take(waiter.key));
        }
    }

    function drop(waiter) {
        const at = queue.indexOf(waiter);
        if (at < 0) return;
        queue.splice(at, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(null);
    }

    // Resolves to a release function, or null when no slot opened in time.
    // The promise has cancel() so a viewer that hangs up leaves the queue.
    function acquire(key, waitMs = 0) {
        const id = String(key || '');
        if (canTake(id)) {
            const ready = Promise.resolve(take(id));
            ready.cancel = () => {};
            return ready;
        }
        let waiter = null;
        const pending = new Promise((resolve) => {
            if (!(waitMs > 0)) {
                resolve(null);
                return;
            }
            waiter = { key: id, resolve, timer: null };
            waiter.timer = setTimeout(() => drop(waiter), waitMs);
            queue.push(waiter);
        });
        pending.cancel = () => {
            if (waiter) drop(waiter);
        };
        return pending;
    }

    function status() {
        return { active, waiting: queue.length, clients: byClient.size };
    }

    return { acquire, status };
}

const streamLimiter = createStreamLimiter({ max: maxStreams, perClient: maxStreamsPerClient });

function proxyStatus() {
    const state = streamLimiter.status();
    return {
        activeStreams: state.active,
        waiting: state.waiting,
        clients: state.clients,
        maxStreams: maxStreams(),
        maxStreamsPerClient: maxStreamsPerClient(),
    };
}

function clientKey(req) {
    if (/^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '')) {
        const forwarded = req.headers && req.headers['x-forwarded-for'];
        if (forwarded) return String(forwarded).split(',')[0].trim();
    }
    return (req.socket && req.socket.remoteAddress) || '';
}

function hostAllowed(hostname, patterns) {
    const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
    return (patterns || []).some((pattern) => {
        const needle = String(pattern || '').toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
        return host === needle || host.endsWith('.' + needle);
    });
}

function isPublicHttpUrl(raw) {
    let url;
    try {
        url = new URL(raw);
    } catch {
        return false;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
    if (host === '0.0.0.0' || host === '::1' || host === '[::1]') return false;
    const match = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (match) {
        const a = Number(match[1]);
        const b = Number(match[2]);
        if (a === 10 || a === 127 || a === 0) return false;
        if (a === 169 && b === 254) return false;
        if (a === 172 && b >= 16 && b <= 31) return false;
        if (a === 192 && b === 168) return false;
        if (a === 100 && b >= 64 && b <= 127) return false;
    }
    return true;
}

function isPlaylistUri(uri) {
    try {
        return /\.m3u8(\?|$)/i.test(new URL(uri, 'https://cdn.example/').pathname);
    } catch {
        return /\.m3u8(\?|$)/i.test(String(uri || ''));
    }
}

function rewritePlaylist(body, playlistUrl, sourceId, options = {}) {
    const segmentMode = options.segmentMode === 'direct' ? 'direct' : 'proxy';
    const origin = options.origin || '';
    const base = new URL(playlistUrl);
    const mapUri = (uri) => {
        const absolute = new URL(uri, base).href;
        if (segmentMode === 'direct' && !isPlaylistUri(absolute)) return absolute;
        const path = segmentMode === 'direct' && isPlaylistUri(absolute) ? '/proxy/playlist' : '/proxy/media';
        const proxied = `${path}?source=${encodeURIComponent(sourceId)}&url=${encodeURIComponent(absolute)}`;
        return origin ? `${origin}${proxied}` : proxied;
    };
    return String(body).split(/\r?\n/).map((line) => {
        if (!line) return line;
        if (line.startsWith('#')) {
            return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${mapUri(uri)}"`);
        }
        const trimmed = line.trim();
        if (!trimmed) return line;
        return mapUri(trimmed);
    }).join('\n');
}

function originOf(referer) {
    try {
        return new URL(referer).origin;
    } catch {
        return '';
    }
}

function storeCookies(jar, requestHost, setCookie) {
    const list = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
    for (const cookie of list) {
        const [pair] = String(cookie).split(';');
        const eq = pair.indexOf('=');
        if (eq <= 0) continue;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        const domainMatch = /;\s*domain=([^;]+)/i.exec(cookie);
        const domain = (domainMatch ? domainMatch[1] : requestHost).trim().replace(/^\./, '').toLowerCase();
        jar.set(name + '@' + domain, { name, value, domain });
    }
}

function cookieHeader(jar, hostname) {
    const host = hostname.toLowerCase();
    const parts = [];
    for (const cookie of jar.values()) {
        if (host === cookie.domain || host.endsWith('.' + cookie.domain)) {
            parts.push(`${cookie.name}=${cookie.value}`);
        }
    }
    return parts.join('; ');
}

const MEDIA_CHUNK = 8 * 1024 * 1024;

// Chrome asks for `bytes=N-` and then keeps that response open. On a
// rate-limited file it drops the socket and asks for the same tail again,
// so an open-ended answer is re-downloaded for the rest of the movie.
// A bounded 206 lets the element ask for the next slice when it needs it.
function boundMediaRange(header, chunkSize = MEDIA_CHUNK) {
    const chunk = Math.max(1, chunkSize);
    if (!header) return `bytes=0-${chunk - 1}`;
    const match = /^bytes=(\d*)-(\d*)$/i.exec(String(header).trim());
    if (!match || match[1] === '') return header;
    const start = Number(match[1]);
    if (!Number.isFinite(start) || start < 0) return header;
    const requestedEnd = match[2] === '' ? start + chunk - 1 : Number(match[2]);
    const end = Math.min(requestedEnd, start + chunk - 1);
    if (!Number.isFinite(end) || end < start) return header;
    return `bytes=${start}-${end}`;
}

// The timeout is a socket idle timeout, so it also ends a relay whose viewer
// stopped reading (paused tab) and frees that slot.
function requestOnce(targetUrl, headers, timeout, onRequest, lookup) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(targetUrl);
        const lib = parsed.protocol === 'http:' ? http : https;
        const req = lib.request({
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            port: parsed.port || undefined,
            path: parsed.pathname + parsed.search,
            method: 'GET',
            headers,
            ...(lookup ? { lookup } : {}),
        }, resolve);
        req.on('error', reject);
        req.setTimeout(timeout, () => req.destroy(new Error('Upstream timeout')));
        if (onRequest) onRequest(req);
        req.end();
    });
}

function readBody(response, limit) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit) {
                response.destroy();
                reject(new Error('Playlist too large'));
                return;
            }
            chunks.push(chunk);
        });
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', reject);
        // destroy() without an error emits only 'close'; settle so nothing waits forever.
        response.on('close', () => reject(new Error('Upstream closed')));
    });
}

function sendText(clientRes, status, body, contentType, extraHeaders) {
    if (clientRes.headersSent || clientRes.destroyed) return;
    clientRes.writeHead(status, {
        'Content-Type': contentType || 'text/plain; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        ...(extraHeaders || {}),
    });
    clientRes.end(body);
}

// Once the status line is out, the only honest failure is a reset. Ending
// normally would leave the browser waiting for the rest of Content-Length.
function failClient(clientRes, status, body) {
    if (!clientRes.headersSent) {
        sendText(clientRes, status, body);
        return;
    }
    if (!clientRes.destroyed) clientRes.destroy();
}

function releaseSlot(ctx) {
    const release = ctx.release;
    ctx.release = null;
    if (release) release();
}

const IMAGE_PATH = /\.(jpe?g|png|gif|webp|avif)$/i;

async function proxyMedia(targetUrl, source, clientReq, clientRes, options = {}) {
    if (clientRes.destroyed || (clientReq.socket && clientReq.socket.destroyed)) return;
    const ctx = {
        source,
        clientReq,
        clientRes,
        options,
        jar: new Map(),
        closed: false,
        upstreamReq: null,
        upstream: null,
        waiting: null,
        release: null,
    };
    // Registered before any await, so a viewer that hangs up at any point
    // (queued, waiting for headers, or mid-body) tears down the upstream
    // request and gives the slot back.
    clientRes.once('close', () => {
        ctx.closed = true;
        if (ctx.waiting) ctx.waiting.cancel();
        // With an error, so the pending requestOnce() promise always settles.
        if (ctx.upstreamReq) ctx.upstreamReq.destroy(new Error('Viewer closed'));
        if (ctx.upstream) ctx.upstream.destroy();
        releaseSlot(ctx);
    });
    try {
        await relay(targetUrl, ctx, MAX_REDIRECTS);
    } catch {
        if (ctx.upstream) ctx.upstream.destroy();
        releaseSlot(ctx);
        failClient(clientRes, 502, 'Proxy error');
    }
}

async function relay(targetUrl, ctx, redirectsLeft) {
    const { source, clientReq, clientRes, options, jar } = ctx;
    if (ctx.closed) return;
    if (!isPublicHttpUrl(targetUrl) || !hostAllowed(new URL(targetUrl).hostname, source.mediaHosts)) {
        releaseSlot(ctx);
        sendText(clientRes, 400, 'Media host is not allowed for this source');
        return;
    }
    if (redirectsLeft < 0) {
        releaseSlot(ctx);
        sendText(clientRes, 502, 'Too many redirects');
        return;
    }

    const parsed = new URL(targetUrl);
    const headers = {
        'User-Agent': UA,
        Accept: '*/*',
        Referer: source.mediaReferer || originOf(targetUrl) + '/',
        ...(source.mediaHeaders || {}),
    };
    const origin = originOf(source.mediaReferer || '');
    if (origin) headers.Origin = origin;
    const pathLooksPlaylist = /\.m3u8$/i.test(parsed.pathname);
    const progressiveFile = /\.mp4$/i.test(parsed.pathname);
    if (progressiveFile) headers.Range = boundMediaRange(clientReq.headers.range);
    else if (clientReq.headers.range) headers.Range = clientReq.headers.range;
    const cookie = cookieHeader(jar, parsed.hostname);
    if (cookie) headers.Cookie = cookie;

    // Playlists and thumbnails are short reads and do not hold a relay slot.
    // Everything else waits for one before the upstream is contacted, so a
    // refused viewer never opens a CDN connection.
    const needsSlot = !options.playlistOnly && !pathLooksPlaylist && !IMAGE_PATH.test(parsed.pathname);
    if (needsSlot && !ctx.release) {
        const limiter = options.limiter || streamLimiter;
        const waiting = limiter.acquire(clientKey(clientReq), options.queueMs != null ? options.queueMs : queueMs());
        ctx.waiting = waiting;
        const release = await waiting;
        ctx.waiting = null;
        if (ctx.closed) {
            if (release) release();
            return;
        }
        if (!release) {
            sendText(clientRes, 429, 'Too many proxied streams', null, { 'Retry-After': '2' });
            return;
        }
        ctx.release = release;
    }

    let upstream;
    try {
        upstream = await requestOnce(
            targetUrl,
            headers,
            options.upstreamIdleMs || UPSTREAM_IDLE_MS,
            (req) => { ctx.upstreamReq = req; },
            options.lookup
        );
    } catch (err) {
        ctx.upstreamReq = null;
        releaseSlot(ctx);
        if (ctx.closed) return;
        sendText(clientRes, err.message === 'Upstream timeout' ? 504 : 502, 'Proxy error');
        return;
    }
    ctx.upstreamReq = null;
    if (ctx.closed) {
        upstream.destroy();
        releaseSlot(ctx);
        return;
    }
    ctx.upstream = upstream;

    storeCookies(jar, parsed.hostname, upstream.headers['set-cookie']);

    if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
        const next = new URL(upstream.headers.location, targetUrl).href;
        // Drop the redirect hop outright: draining its body with resume()
        // would keep that socket open after the viewer leaves.
        upstream.destroy();
        ctx.upstream = null;
        await relay(next, ctx, redirectsLeft - 1);
        return;
    }

    const contentType = upstream.headers['content-type'] || '';
    const typeLooksPlaylist = /mpegurl/i.test(contentType);
    if (pathLooksPlaylist || typeLooksPlaylist) {
        releaseSlot(ctx);
        try {
            const body = (await readBody(upstream, PLAYLIST_LIMIT)).toString('utf8');
            if (body.startsWith('#EXTM3U')) {
                const rewritten = rewritePlaylist(body, targetUrl, source.id, {
                    segmentMode: options.playlistOnly ? 'direct' : 'proxy',
                    origin: options.origin || '',
                });
                sendText(clientRes, upstream.statusCode || 200, rewritten, 'application/vnd.apple.mpegurl');
                return;
            }
            sendText(clientRes, upstream.statusCode || 200, body, contentType || 'text/plain');
        } catch (err) {
            sendText(clientRes, 502, err.message || 'Playlist error');
        }
        return;
    }

    if (options.playlistOnly) {
        upstream.destroy();
        sendText(clientRes, 415, 'Not a playlist');
        return;
    }

    const isImage = /^image\//i.test(contentType);
    if (isImage) releaseSlot(ctx);
    const ok2xx = upstream.statusCode >= 200 && upstream.statusCode < 300;
    const out = {
        'Content-Type': contentType || 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        // A proxied thumbnail is the same for everyone; let the browser keep it.
        'Cache-Control': !ok2xx ? 'no-store' : (isImage ? 'public, max-age=86400' : 'private, max-age=120'),
    };
    const contentRange = upstream.headers['content-range'];
    const upstreamLength = Number(upstream.headers['content-length']);
    if (contentRange) out['Content-Range'] = contentRange;
    if (upstream.headers['content-length'] != null && Number.isFinite(upstreamLength)) {
        out['Content-Length'] = String(upstreamLength);
    }
    clientRes.writeHead(upstream.statusCode || 200, out);

    let received = 0;
    const expected = out['Content-Length'] != null ? upstreamLength : Infinity;
    upstream.on('data', (chunk) => {
        if (ctx.closed || clientRes.writableEnded) return;
        received += chunk.length;
        if (!clientRes.write(chunk)) upstream.pause();
    });
    clientRes.on('drain', () => {
        if (!upstream.destroyed) upstream.resume();
    });
    upstream.on('end', () => {
        releaseSlot(ctx);
        if (clientRes.writableEnded || clientRes.destroyed) return;
        // Only a known, finite length can be "short". A chunked or
        // close-delimited body has no declared length and ends normally.
        if (Number.isFinite(expected) && received < expected) {
            clientRes.destroy();
            return;
        }
        clientRes.end();
    });
    upstream.on('error', () => {
        releaseSlot(ctx);
        failClient(clientRes, 502, 'Upstream error');
    });
    upstream.on('close', () => {
        releaseSlot(ctx);
        if (!clientRes.writableEnded && !clientRes.destroyed) clientRes.destroy();
    });
}

module.exports = {
    hostAllowed,
    isPublicHttpUrl,
    rewritePlaylist,
    boundMediaRange,
    proxyMedia,
    proxyStatus,
    isPlaylistUri,
    createStreamLimiter,
    clientKey,
};
