const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const Logic = require('../src/feed-logic');
const { TtlCache } = require('../lib/cache');
const { proxyMedia, createStreamLimiter } = require('../lib/proxy');
const pornhub = require('../sources/pornhub');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

function memoryStorage(initial = {}) {
    const data = new Map(Object.entries(initial));
    return {
        getItem: (key) => (data.has(key) ? data.get(key) : null),
        setItem: (key, value) => data.set(key, String(value)),
    };
}

test('each ladder step has its own wait, and only the relay outlasts its queue', () => {
    assert.equal(Logic.stepTimeoutMs('direct'), 6000);
    assert.equal(Logic.stepTimeoutMs('playlist-proxy'), 7000);
    assert.equal(Logic.stepTimeoutMs('proxy'), Logic.STALL_MS);
    assert.ok(Logic.stepTimeoutMs('proxy') > 8000);
    const stuck = { readyState: 0, networkState: 2, elapsedMs: 6000 };
    assert.equal(Logic.mediaStalled({ ...stuck, stallMs: 6000 }), true);
    assert.equal(Logic.mediaStalled(stuck), false, 'the default stays STALL_MS');
});

test('the learned step goes first and every other step stays reachable', () => {
    const ladder = ['direct', 'playlist-proxy', 'proxy', 'embed'];
    assert.deepEqual(Logic.orderModes(ladder, 'proxy'), ['proxy', 'direct', 'playlist-proxy', 'embed']);
    assert.deepEqual(Logic.orderModes(ladder, null), ladder);
    assert.deepEqual(Logic.orderModes(['proxy', 'embed'], 'direct'), ['proxy', 'embed'], 'a step this URL cannot use is ignored');
});

test('ladder memory persists per source and kind, expires, and never stores embed', () => {
    let now = 1000;
    const storage = memoryStorage();
    const clock = { now: () => now, ttlMs: 500 };
    const memory = Logic.createLadderMemory(storage, 'k', clock);
    memory.set('pornhub', 'file', 'proxy');
    memory.set('pornhub', 'hls', 'embed');
    assert.equal(memory.get('pornhub', 'file'), 'proxy');
    assert.equal(memory.get('pornhub', 'hls'), null);
    assert.equal(memory.get('85po', 'file'), null);

    const reloaded = Logic.createLadderMemory(storage, 'k', clock);
    assert.equal(reloaded.get('pornhub', 'file'), 'proxy', 'survives a reload');
    now = 1500;
    assert.equal(reloaded.get('pornhub', 'file'), null, 'expired');

    now = 1000;
    memory.set('85po', 'file', 'direct');
    memory.forget('85po', 'file');
    assert.equal(memory.get('85po', 'file'), null);

    for (const raw of ['not json', '[]', '{"a:file":{"mode":"embed","expires":9}}']) {
        const broken = Logic.createLadderMemory(memoryStorage({ k: raw }), 'k');
        assert.equal(broken.get('a', 'file'), null);
    }
    const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); } };
    const inMemory = Logic.createLadderMemory(throwing, 'k');
    inMemory.set('a', 'file', 'direct');
    assert.equal(inMemory.get('a', 'file'), 'direct');
});

test('an expired or nearly expired signed URL is not reused', () => {
    const now = 1_800_000_000_000;
    const seconds = Math.floor(now / 1000);
    assert.equal(Logic.signedUrlExpiry(`https://c.test/a.mp4?validto=${seconds}`), seconds * 1000);
    assert.equal(Logic.signedUrlExpiry(`https://c.test/a.mp4?expires=${now}`), now);
    assert.equal(Logic.signedUrlExpiry('https://c.test/a.mp4?validfrom=1&validto=2'), null, 'not a timestamp');
    assert.equal(Logic.signedUrlExpiry('nonsense'), null);

    const at = (offsetMs) => ({ url: `https://c.test/a.mp4?validto=${Math.floor((now + offsetMs) / 1000)}` });
    assert.equal(Logic.playbackFresh(at(60000), now), true);
    assert.equal(Logic.playbackFresh(at(Logic.SIGNED_URL_MARGIN_MS - 1000), now), false);
    assert.equal(Logic.playbackFresh(at(-1000), now), false);
    assert.equal(Logic.playbackFresh({ url: 'https://c.test/a.mp4' }, now), true);

    assert.equal(Logic.resolveCacheTtl({ url: 'https://c.test/a.mp4' }, 180000, now), 180000);
    assert.equal(Logic.resolveCacheTtl(at(60000), 180000, now), 60000 - Logic.SIGNED_URL_MARGIN_MS);
    assert.equal(Logic.resolveCacheTtl(at(-1000), 180000, now), 0);
    assert.equal(Logic.resolveCacheTtl({ kind: 'embed', url: 'https://c.test/e' }, 180000, now), Logic.EMBED_RESOLVE_TTL_MS);
});

test('the cache takes a per-value lifetime, skips a dead one and shares a running load', async () => {
    const cache = new TtlCache();
    let loads = 0;
    const load = async () => { loads += 1; return 'url'; };
    await cache.getOrLoad('dead', () => 0, load);
    assert.equal(cache.size, 0, 'a lifetime of 0 is not stored');
    await cache.getOrLoad('live', (value) => (value === 'url' ? 60000 : 0), load);
    assert.equal((await cache.getOrLoad('live', 60000, load)).cached, true);
    assert.equal(loads, 2);

    let finish;
    let shared = 0;
    const slow = () => { shared += 1; return new Promise((resolve) => { finish = resolve; }); };
    const both = [cache.getOrLoad('same', 60000, slow), cache.getOrLoad('same', 60000, slow)];
    await new Promise((resolve) => setImmediate(resolve));
    finish('v');
    assert.deepEqual((await Promise.all(both)).map((item) => item.value), ['v', 'v']);
    assert.equal(shared, 1);
});

test('only the next two cards stay warm', () => {
    assert.deepEqual([4, 5, 6, 7, 8].map((card) => Logic.keepWarm(card, 5)), [false, false, true, true, false]);
    assert.equal(Logic.preloadLevel(1), 'auto');
    assert.equal(Logic.preloadLevel(2), 'metadata');
    assert.equal(Logic.preloadLevel(3), 'none');
});

test('an HLS step succeeds only on a decoded video frame', () => {
    const frame = { readyState: 2, videoWidth: 1280, hasError: false };
    assert.equal(Logic.hlsFrameReady(frame), true);
    assert.equal(Logic.hlsFrameReady({ ...frame, readyState: 0 }), false, 'fragments loaded, nothing decoded');
    assert.equal(Logic.hlsFrameReady({ ...frame, readyState: 1 }), false, 'metadata only');
    assert.equal(Logic.hlsFrameReady({ ...frame, videoWidth: 0 }), false, 'audio without a picture');
    assert.equal(Logic.hlsFrameReady({ ...frame, hasError: true }), false);
    assert.ok(Logic.HLS_FIRST_FRAME_GRACE_MS > 0);
});

test('the startup board request carries the boot mark and stays a first page', () => {
    const board = Logic.videosUrl('85po', '24h', '');
    assert.equal(Logic.bootRequestUrl(board), `${board}&boot=1`);
    assert.equal(new URL(Logic.bootRequestUrl(board), 'http://x').searchParams.get('page'), null);
});

test('only a plain first-page board URL is requested at startup', () => {
    assert.equal(Logic.isBootUrl(Logic.videosUrl('pornhub', '24h', '')), true);
    assert.equal(Logic.isBootUrl(Logic.videosUrl('twikeep', '7d', 'views')), true);
    assert.equal(Logic.isBootUrl(Logic.videosUrl('twikeep', '7d', 'views', 2)), false);
    for (const bad of ['', null, 'https://evil.test/api/videos?source=a&period=b', '/api/resolve?source=a&id=b']) {
        assert.equal(Logic.isBootUrl(bad), false);
    }
});

test('the timing log reports percentiles and stays bounded', () => {
    const log = Logic.createTimingLog(3, 1);
    [100, 200, 300, 400].forEach((ms) => log.add('a', ms));
    log.add('b', 1);
    log.add('a', Number.NaN);
    assert.deepEqual(log.summary(), { a: { count: 3, p50: 300, p95: 400, max: 400 } });
});

async function withFetch(handler, fn) {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), headers: (init && init.headers) || {} });
        return handler(String(url));
    };
    try {
        await fn(calls);
    } finally {
        globalThis.fetch = original;
    }
}

const watchPage = (definitions) => new Response(
    `<script>var flashvars = {"mediaDefinitions":${JSON.stringify(definitions)}};</script>`,
    { status: 200, headers: { 'content-type': 'text/html' } }
);

test('pornhub: a working IP-bound file is chosen in two requests, without probing HLS', async () => {
    const mp4 = 'https://ev.phncdn.com/v/720P.mp4?validfrom=1&validto=2&ip=203.0.113.5&hash=x';
    const master = 'https://ev-h.phncdn.com/hls/a/master.m3u8?validfrom=1&validto=2&hash=x';
    await withFetch((url) => {
        if (url.includes('view_video.php')) {
            return watchPage([
                { format: 'hls', quality: '720', videoUrl: master },
                { format: 'mp4', quality: '720', videoUrl: mp4 },
            ]);
        }
        assert.equal(url, mp4, 'HLS is not probed once a file plays');
        return new Response('....ftypisom', { status: 206, headers: { 'content-type': 'video/mp4' } });
    }, async (calls) => {
        const playback = await pornhub.resolvePlayback('abc123');
        assert.equal(playback.kind, 'file');
        assert.equal(playback.url, mp4);
        assert.equal(playback.needsReferer, true);
        assert.equal(calls.length, 2, 'watch page + one file probe');
    });
});

test('pornhub: HLS is used when no file plays, and is marked relay-only', async () => {
    const master = 'https://ev-h.phncdn.com/hls/a/master.m3u8?validfrom=1&validto=2&hash=x';
    await withFetch((url) => {
        if (url.includes('view_video.php')) return watchPage([{ format: 'hls', quality: '720', videoUrl: master }]);
        if (url === master) return new Response('#EXTM3U\nseg-1.ts\n', { status: 200 });
        return new Response(new Uint8Array([0x47, 0, 0, 0]), { status: 206 });
    }, async () => {
        const playback = await pornhub.resolvePlayback('abc123');
        assert.equal(playback.kind, 'hls');
        assert.equal(playback.needsReferer, true, 'the viewer skips steps that cannot send the Referer');
    });
});

function lookup(hostname, options, callback) {
    if (options && options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
    else callback(null, '127.0.0.1', 4);
}

const SOURCE = { id: 'test', mediaHosts: ['cdn.test'], mediaReferer: 'https://site.test/' };
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const shutdown = (server) => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(() => resolve()));
};

async function startRelay(t, upstreamHandler, options) {
    const upstream = http.createServer(upstreamHandler);
    const upstreamPort = await listen(upstream);
    const app = http.createServer((req, res) => {
        proxyMedia(`http://cdn.test:${upstreamPort}${req.url}`, SOURCE, req, res, {
            lookup,
            limiter: createStreamLimiter({ max: 4 }),
            ...options,
        });
    });
    const appPort = await listen(app);
    t.after(async () => {
        await shutdown(app);
        await shutdown(upstream);
    });
    return { upstream, get: (url) => http.get({ host: '127.0.0.1', port: appPort, path: url, agent: false }) };
}

const bodyOf = (client) => new Promise((resolve, reject) => {
    client.on('error', reject);
    client.on('response', (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString()));
    });
});

test('the relay reuses one upstream connection across requests', async (t) => {
    const agent = new http.Agent({ keepAlive: true });
    t.after(() => agent.destroy());
    const { upstream, get } = await startRelay(t, (req, res) => {
        res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Length': '4' });
        res.end('data');
    }, { agent });
    let connections = 0;
    upstream.on('connection', () => { connections += 1; });
    assert.equal(await bodyOf(get('/v/a.mp4')), 'data');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(await bodyOf(get('/v/a.mp4')), 'data');
    assert.equal(connections, 1);
});

test('the relay sends headers before the first body byte and reports the time', async (t) => {
    const seen = [];
    let finishBody;
    const { get } = await startRelay(t, (req, res) => {
        res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Length': '4' });
        res.flushHeaders();
        finishBody = () => res.end('data');
    }, { onFirstByte: (ms) => seen.push(ms) });
    const client = get('/v/a.mp4');
    const response = await new Promise((resolve, reject) => {
        client.on('response', resolve);
        client.on('error', reject);
    });
    assert.equal(response.statusCode, 206, 'answered while the body is still pending');
    assert.equal(seen.length, 1);
    response.resume();
    const ended = new Promise((resolve) => response.on('end', resolve));
    finishBody();
    await ended;
});

test('main.js keeps preloads, learns the ladder and does not wait for the poster probe', () => {
    const main = read('src', 'main.js');
    assert.match(main, /holdsWarmMedia\(card, mode, playback\)/, 'a preload is adopted, not thrown away');
    assert.match(main, /otherIndex !== index && !isWarmAhead\(other, otherIndex, index\)/);
    assert.match(main, /ladderMemory\.set\(sourceId, ladderKind\(\), mode\)/);
    assert.match(main, /ladderMemory\.forget\(sourceId, ladderKind\(\)\)/);
    assert.doesNotMatch(main, /await ensureThumbMode/);
    assert.match(main, /setCardLoading\(card, true\)/);
    assert.match(read('src', 'style.css'), /\.video-card\.is-loading \.card-spinner/);
});
