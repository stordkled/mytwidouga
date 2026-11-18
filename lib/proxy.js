const http = require('http');
const https = require('https');
const { UA } = require('./http');

const MAX_REDIRECTS = 5;
const PLAYLIST_LIMIT = 2 * 1024 * 1024;
let activeStreams = 0;

function maxStreams() {
    try {
        return require('./mirrors').settings().maxProxyStreams;
    } catch {
        return 3;
    }
}

function proxyStatus() {
    return { activeStreams, maxStreams: maxStreams() };
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

function requestOnce(targetUrl, headers, timeout) {
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
        }, resolve);
        req.on('error', reject);
        req.setTimeout(timeout, () => req.destroy(new Error('Upstream timeout')));
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
    });
}

function sendText(clientRes, status, body, contentType) {
    if (clientRes.headersSent) return;
    clientRes.writeHead(status, {
        'Content-Type': contentType || 'text/plain; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
    });
    clientRes.end(body);
}

async function proxyMedia(targetUrl, source, clientReq, clientRes, redirectsLeft = MAX_REDIRECTS, jar = new Map(), options = {}) {
    if (!isPublicHttpUrl(targetUrl) || !hostAllowed(new URL(targetUrl).hostname, source.mediaHosts)) {
        sendText(clientRes, 400, 'Media host is not allowed for this source');
        return;
    }
    if (redirectsLeft < 0) {
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

    let upstream;
    try {
        upstream = await requestOnce(targetUrl, headers, 30000);
    } catch (err) {
        sendText(clientRes, err.message === 'Upstream timeout' ? 504 : 502, 'Proxy error');
        return;
    }

    storeCookies(jar, parsed.hostname, upstream.headers['set-cookie']);

    if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
        const next = new URL(upstream.headers.location, targetUrl).href;
        upstream.resume();
        await proxyMedia(next, source, clientReq, clientRes, redirectsLeft - 1, jar, options);
        return;
    }

    const contentType = upstream.headers['content-type'] || '';
    const typeLooksPlaylist = /mpegurl/i.test(contentType);
    if (pathLooksPlaylist || typeLooksPlaylist) {
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
        sendText(clientRes, 415, 'Not a playlist');
        return;
    }
    if (activeStreams >= maxStreams()) {
        upstream.resume();
        sendText(clientRes, 429, 'Too many proxied streams');
        return;
    }
    activeStreams += 1;
    const release = () => {
        if (release.done) return;
        release.done = true;
        activeStreams = Math.max(0, activeStreams - 1);
    };
    const stopUpstream = () => {
        upstream.destroy();
        release();
    };
    clientRes.on('close', stopUpstream);
    upstream.on('end', release);
    upstream.on('error', release);

    const out = {
        'Content-Type': contentType || 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'private, max-age=120',
    };
    const contentRange = upstream.headers['content-range'];
    const upstreamLength = Number(upstream.headers['content-length']);
    if (contentRange) out['Content-Range'] = contentRange;
    if (Number.isFinite(upstreamLength)) out['Content-Length'] = String(upstreamLength);
    clientRes.writeHead(upstream.statusCode || 200, out);

    let received = 0;
    const limit = Number.isFinite(upstreamLength) ? upstreamLength : Infinity;
    upstream.on('data', (chunk) => {
        if (clientRes.writableEnded) return;
        received += chunk.length;
        const ok = clientRes.write(chunk);
        if (received >= limit) {
            upstream.destroy();
            clientRes.end();
            return;
        }
        if (!ok) upstream.pause();
    });
    clientRes.on('drain', () => {
        if (!upstream.destroyed) upstream.resume();
    });
    upstream.on('end', () => {
        if (!clientRes.writableEnded) clientRes.end();
    });
    upstream.on('error', () => {
        if (!clientRes.headersSent) clientRes.writeHead(502);
        if (!clientRes.writableEnded) clientRes.end();
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
};
