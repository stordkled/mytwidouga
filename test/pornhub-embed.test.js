const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const Logic = require('../src/feed-logic');
const sources = require('../sources');
const mirrors = require('../lib/mirrors');
const { embedPlayerHtml, servePornhubEmbed } = require('../lib/pornhub-embed');

const mediaUrl = 'https://ev.phncdn.com/a.mp4?ip=203.0.113.5';
const embedPage = () => `<html><head></head><body><script>var flashvars = {
    "mediaDefinitions":[{"format":"mp4","quality":"720","videoUrl":"${mediaUrl}"}]
}; window.untrustedUpstreamCode = true;</script></body></html>`;

function fullProxy(t, value) {
    const previous = process.env.FULL_PROXY;
    process.env.FULL_PROXY = value;
    t.after(() => {
        if (previous === undefined) delete process.env.FULL_PROXY;
        else process.env.FULL_PROXY = previous;
    });
}

function player(html, { nativeHls = false, Hls } = {}) {
    const config = JSON.parse(/<script id="playback" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
    const listeners = new Map();
    const media = {
        duration: NaN, readyState: 0, currentTime: 0, plays: 0,
        canPlayType: () => nativeHls ? 'probably' : '',
        play() { this.plays += 1; return Promise.resolve(); },
        addEventListener(name, fn) {
            if (!listeners.has(name)) listeners.set(name, []);
            listeners.get(name).push(fn);
        },
    };
    const error = { hidden: true };
    const context = vm.createContext({
        window: { FeedLogic: Logic, Hls },
        document: { getElementById: (id) => ({ player: media, playback: { textContent: JSON.stringify(config) }, error }[id]) },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/embed-player.js'), 'utf8'), context);
    return { media, config, error, fire: (event) => (listeners.get(event) || []).forEach((fn) => fn()) };
}

function makeCard(index) {
    let frame;
    const media = { style: {}, paused: true, hasAttribute: () => false };
    const wrapper = {
        querySelector: (selector) => selector === 'video' ? media : frame,
        appendChild: (element) => { frame = element; },
    };
    return {
        dataset: { index: String(index) },
        classList: { add() {}, remove() {} },
        querySelector(selector) {
            if (selector === 'video') return media;
            if (selector === '.video-wrapper') return wrapper;
            if (selector === 'iframe.embed-player') return frame;
            if (selector === '.embed-exit') return {};
            return null;
        },
    };
}

function client(videos, config, fetch, currentSource = 'pornhub') {
    const cards = videos.map((_, index) => makeCard(index));
    const feed = { querySelectorAll: () => cards };
    const context = vm.createContext({
        window: { FeedLogic: Logic, addEventListener() {} },
        document: {
            getElementById: (id) => id === 'videoFeed' ? feed : null,
            addEventListener() {},
            createElement() {
                let src = '';
                return {
                    navigations: 0,
                    setAttribute() {},
                    getAttribute: (name) => name === 'src' ? src : null,
                    get src() { return src ? new URL(src, 'http://app.test').href : ''; },
                    set src(value) { src = value; this.navigations += 1; },
                };
            },
        },
        setInterval() {},
        fetch,
        initialVideos: videos,
        initialConfig: config,
        initialSource: currentSource,
        cards,
    });
    // Run the complete client except automatic page boot; exercise its real
    // resolve, fallback, preload and iframe-mount functions below.
    const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
    assert.match(main, /\ninit\(\);\s*$/);
    vm.runInContext(main.replace(/\ninit\(\);\s*$/, ''), context);
    vm.runInContext(`videos = initialVideos; playbackConfig = initialConfig;
        currentSource = { id: initialSource }; activePlay = 0;`, context);
    return { context, cards };
}

function responseRecorder() {
    return {
        writeHead(status, headers) { this.status = status; this.headers = headers; },
        end(body) { this.body = body; },
    };
}

test('upstream 403 -> real resolve -> embed fallback initializes the player at 5 seconds', async (t) => {
    fullProxy(t, '1');
    const originalFetch = globalThis.fetch;
    const requests = [];
    t.after(() => { globalThis.fetch = originalFetch; mirrors.forget('pornhub'); });
    mirrors.forget('pornhub');
    globalThis.fetch = async (url) => {
        const parsed = new URL(url);
        requests.push(parsed);
        if (parsed.pathname === '/view_video.php') return new Response('blocked', { status: 403 });
        if (parsed.pathname === '/a.mp4') return new Response('....ftypisom', { status: 206, headers: { 'content-type': 'video/mp4' } });
        assert.equal(parsed.pathname, '/embed/phReview03');
        return new Response(embedPage());
    };
    const video = { id: 'phReview03', _sourceId: 'pornhub', playback: { kind: 'resolve' } };
    const { context, cards } = client([video], sources.playbackConfig(), async (url) => {
        assert.equal(url, '/api/resolve?source=pornhub&id=phReview03&fresh=1');
        return { json: () => sources.resolvePlayback('pornhub', 'phReview03', { fresh: true }) };
    }, 'twikeep'); // Mixed-source bookmarks must use the video's own source.
    assert.equal(await vm.runInContext(`resolvePlayback(videos[0], true)
        .then((playback) => tryMode('embed', playback, cards[0], 0))`, context), true);
    const frame = cards[0].querySelector('iframe.embed-player');
    assert.equal(frame.src, 'http://app.test/embed/pornhub?id=phReview03&start=5');
    assert.ok(requests.some((url) => url.pathname === '/view_video.php'), 'the 403 path was exercised');

    const response = responseRecorder();
    await servePornhubEmbed({ method: 'GET' }, response, new URL(frame.src, 'http://app.test'));
    assert.equal(response.status, 200);
    assert.match(response.headers['Content-Security-Policy'], /script-src 'self' https:\/\/cdn\.jsdelivr\.net/);
    assert.match(response.headers['Content-Security-Policy'], /media-src 'self' blob:; connect-src 'self';/);
    assert.equal(response.headers['Cache-Control'], 'no-store');
    assert.doesNotMatch(response.body, /untrustedUpstreamCode|flashvars/, 'never execute upstream HTML/scripts on the app origin');
    const { media, config, fire } = player(response.body);
    assert.equal(config.offset, 5);
    assert.equal(config.url, `/proxy/media?source=pornhub&url=${encodeURIComponent(mediaUrl)}`);
    media.duration = 120;
    media.readyState = 1;
    fire('loadedmetadata');
    assert.equal(media.currentTime, 5, 'the iframe video actually seeks, rather than just adding a URL parameter');
});

for (const proxy of ['1', '0']) {
    test(`regional embed fallback survives forgotten mirror memory with FULL_PROXY=${proxy}`, async (t) => {
        fullProxy(t, proxy);
        const originalFetch = globalThis.fetch;
        t.after(() => { globalThis.fetch = originalFetch; mirrors.forget('pornhub'); });
        mirrors.remember('pornhub', 'https://jp.pornhub.com');
        const id = `phRegionalMirror${proxy}`;
        const directUrl = 'https://ev.phncdn.com/regional.mp4';
        const requests = [];
        globalThis.fetch = async (url, options = {}) => {
            const parsed = new URL(url);
            requests.push(parsed);
            if (parsed.pathname === '/view_video.php') return new Response('blocked', { status: 403 });
            if (parsed.pathname === `/embed/${id}`) {
                if (parsed.hostname === 'www.pornhub.com') return new Response('unavailable', { status: 502 });
                assert.equal(parsed.hostname, 'jp.pornhub.com');
                assert.equal(options.headers.Referer, 'https://jp.pornhub.com/');
                return new Response(`<script>var flashvars = {"mediaDefinitions":[{"format":"mp4","videoUrl":"${directUrl}"}]};</script>`);
            }
            assert.equal(url, directUrl);
            if (proxy === '0') assert.equal(options.headers.Referer, undefined);
            else if (options.headers.Referer) assert.equal(options.headers.Referer, 'https://jp.pornhub.com/');
            return new Response('....ftypisom', { status: 206 });
        };
        const resolved = await sources.resolvePlayback('pornhub', id, { fresh: true });
        assert.equal(resolved.ok, true);
        assert.equal(resolved.playback.kind, 'embed');
        assert.equal(new URL(resolved.playback.embedUrl).hostname, 'jp.pornhub.com');
        assert.equal(requests.filter((url) => url.pathname === '/view_video.php').length, 3);
        assert.equal(mirrors.activeBase('pornhub'), null, 'all watch-page mirrors failed and cleared the remembered jp base');

        const video = { id, _sourceId: 'pornhub', playback: resolved.playback };
        const { context, cards } = client([video], sources.playbackConfig());
        await vm.runInContext("tryMode('embed', videos[0].playback, cards[0], 0)", context);
        const response = responseRecorder();
        await servePornhubEmbed({ method: 'GET' }, response, new URL(cards[0].querySelector('iframe.embed-player').src));
        assert.equal(response.status, 200);
        assert.deepEqual(requests.filter((url) => url.pathname.startsWith('/embed/')).map((url) => url.hostname),
            ['www.pornhub.com', 'jp.pornhub.com']);
        assert.equal(mirrors.activeBase('pornhub'), 'https://jp.pornhub.com');
        const { config, media, fire } = player(response.body);
        assert.equal(config.url, proxy === '0'
            ? directUrl : `/proxy/media?source=pornhub&url=${encodeURIComponent(directUrl)}`);
        media.duration = 120;
        media.readyState = 1;
        fire('loadedmetadata');
        assert.equal(media.currentTime, 5);
    });
}

test('FULL_PROXY=0 embed skips relay-dependent files and plays a direct candidate from 5 seconds', async (t) => {
    fullProxy(t, '0');
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    const directUrl = 'https://ev.phncdn.com/direct.mp4?hash=public';
    const refererOnlyUrl = 'https://ev.phncdn.com/referer-only.mp4';
    const requests = [];
    globalThis.fetch = async (url, options = {}) => {
        requests.push({ url: String(url), options });
        if (new URL(url).pathname === '/embed/phNoRelay') {
            return new Response(`<script>var flashvars = {"mediaDefinitions":${JSON.stringify([
                { format: 'mp4', quality: '720', videoUrl: mediaUrl },
                { format: 'mp4', quality: '720', videoUrl: refererOnlyUrl },
                { format: 'mp4', quality: '720', videoUrl: directUrl },
            ])}};</script>`);
        }
        assert.equal(options.headers.Referer, undefined, 'direct candidates are probed without a Referer');
        if (url === refererOnlyUrl) return new Response('needs referer', { status: 403 });
        assert.equal(url, directUrl, 'never select or probe the server IP-bound candidate in direct mode');
        return new Response('....ftypisom', { status: 206, headers: { 'content-type': 'video/mp4' } });
    };
    const video = { id: 'phNoRelay', _sourceId: 'pornhub', playback: {
        kind: 'embed', embedUrl: 'https://www.pornhub.com/embed/phNoRelay',
    } };
    const { context, cards } = client([video], sources.playbackConfig());
    await vm.runInContext("tryMode('embed', videos[0].playback, cards[0], 0)", context);
    const response = responseRecorder();
    await servePornhubEmbed({ method: 'GET' }, response, new URL(cards[0].querySelector('iframe.embed-player').src));
    assert.equal(response.status, 200, JSON.stringify(requests));
    assert.equal(response.headers['Referrer-Policy'], 'no-referrer');
    const csp = response.headers['Content-Security-Policy'];
    for (const directive of ['media-src', 'connect-src']) {
        assert.match(csp.split('; ').find((part) => part.startsWith(directive)), /https:\/\/\*\.phncdn\.com/);
    }
    assert.equal(csp.split('; ').find((part) => part.startsWith('script-src')), "script-src 'self' https://cdn.jsdelivr.net");
    assert.doesNotMatch(response.body, /\/proxy\/media|untrustedUpstreamCode/);
    const { media, config, fire } = player(response.body);
    assert.equal(config.url, directUrl);
    assert.equal(media.src, directUrl);
    media.duration = 120;
    media.readyState = 1;
    fire('loadedmetadata');
    assert.equal(media.currentTime, 5);
    fire('ended');
    assert.equal(media.currentTime, 5);
    assert.equal(requests.length, 3, 'embed HTML, rejected Referer-only file, and direct file');
    assert.equal(mirrors.settings().fullProxyEnabled, false, 'playback never enables the relay');
});

test('FULL_PROXY=0 HLS resolves and seeks through both native HLS and hls.js without the relay', async (t) => {
    fullProxy(t, '0');
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    const master = 'https://ev.phncdn.com/master.m3u8';
    const variant = 'https://ev.phncdn.com/720.m3u8';
    const segment = 'https://ev.phncdn.com/seg.ts';
    globalThis.fetch = async (url, options = {}) => {
        if (new URL(url).pathname.startsWith('/embed/')) {
            return new Response(`<script>var flashvars = {"mediaDefinitions":[{"format":"hls","videoUrl":"${master}"}]};</script>`);
        }
        assert.equal(options.headers.Referer, undefined);
        if (url === master) return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\n720.m3u8\n');
        if (url === variant) return new Response('#EXTM3U\n#EXTINF:10,\nseg.ts\n');
        assert.equal(url, segment);
        return new Response(new Uint8Array([0x47, 0, 0, 0]), { status: 206 });
    };
    const response = responseRecorder();
    await servePornhubEmbed({ method: 'GET' }, response, new URL('http://app.test/embed/pornhub?id=phDirectHls&start=5'));
    assert.equal(response.status, 200);
    const native = player(response.body, { nativeHls: true });
    assert.equal(native.media.src, master);
    let instance;
    class Hls {
        static Events = { MANIFEST_PARSED: 'manifest', ERROR: 'error' };
        static isSupported() { return true; }
        constructor() { instance = this; }
        on() {}
        loadSource(url) { this.url = url; }
        attachMedia(media) { this.media = media; }
    }
    const hls = player(response.body, { Hls });
    assert.equal(instance.url, master);
    for (const playback of [native, hls]) {
        playback.media.duration = 120;
        playback.media.readyState = 1;
        playback.fire('loadedmetadata');
        assert.equal(playback.media.currentTime, 5);
    }
});

test('FULL_PROXY=0 fails explicitly if an embed has only IP-bound or Referer-dependent media', async (t) => {
    fullProxy(t, '0');
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    for (const url of [mediaUrl, 'https://ev.phncdn.com/referer-only.mp4', 'https://ev.phncdn.com/referer-only.m3u8']) {
        globalThis.fetch = async (target) => {
            if (new URL(target).pathname.startsWith('/embed/')) {
                return new Response(`<script>var flashvars = {"mediaDefinitions":[{"format":"${url.includes('m3u8') ? 'hls' : 'mp4'}","videoUrl":"${url}"}]};</script>`);
            }
            assert.notEqual(target, mediaUrl, 'IP-bound files cannot become direct playback');
            return new Response('needs referer', { status: 403 });
        };
        const response = responseRecorder();
        await servePornhubEmbed({ method: 'GET' }, response, new URL('http://app.test/embed/pornhub?id=phNoDirect&start=5'));
        assert.equal(response.status, 502);
        assert.doesNotMatch(response.body, /\/proxy\/media|<iframe|<video/, 'never bypass the relay switch or silently fall back to a zero start');
    }
});

test('the real server with FULL_PROXY=0 serves a direct offset player while /proxy/media stays disabled', async (t) => {
    const port = await new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const port = probe.address().port;
            probe.close(() => resolve(port));
        });
    });
    const directUrl = 'https://ev.phncdn.com/direct.mp4';
    const env = { ...process.env, PORT: String(port), FULL_PROXY: '0' };
    delete env.BASIC_AUTH_USER;
    delete env.BASIC_AUTH_PASS;
    const app = spawn(process.execPath, ['-e', `
        globalThis.fetch = async (url) => {
            if (new URL(url).pathname === '/embed/phServer') {
                return new Response('<script>var flashvars = {"mediaDefinitions":[{"format":"mp4","videoUrl":"${directUrl}"}]};</script>');
            }
            if (url === '${directUrl}') return new Response('....ftypisom', { status: 206 });
            throw new Error('Unexpected network request');
        };
        require('./server');
    `], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => app.kill());
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
        app.stdout.on('data', (chunk) => {
            if (String(chunk).includes('Local:')) { clearTimeout(timer); resolve(); }
        });
        app.once('error', (err) => { clearTimeout(timer); reject(err); });
        app.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited with ${code}`)); });
    });
    const get = (url) => new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port, path: url, agent: false }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
        }).on('error', reject);
    });
    const response = await get('/embed/pornhub?id=phServer&start=5');
    assert.equal(response.status, 200);
    const { config, media, fire } = player(response.body);
    assert.equal(config.url, directUrl);
    media.duration = 120;
    media.readyState = 1;
    fire('loadedmetadata');
    assert.equal(media.currentTime, 5);
    const blocked = await get(`/proxy/media?source=pornhub&url=${encodeURIComponent(directUrl)}`);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body, 'Full proxy disabled');
    assert.equal(JSON.parse((await get('/api/sources')).body).playback.fullProxyEnabled, false);
});

test('Pornhub embed preloading cannot play past the offset before the card becomes visible', async () => {
    const videos = ['phFirst', 'phNext'].map((id) => ({ id, _sourceId: 'pornhub', playback: {
        kind: 'embed', url: `https://www.pornhub.com/embed/${id}?autoplay=1&muted=1`,
        embedUrl: `https://www.pornhub.com/embed/${id}?autoplay=1&muted=1`,
    } }));
    const { context, cards } = client(videos, { startOffsets: { pornhub: 5 } });
    vm.runInContext('preloadCard(0, 1)', context);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cards[1].querySelector('iframe.embed-player'), undefined, 'resolve ahead, but do not autoplay offscreen');
    await vm.runInContext("tryMode('embed', videos[1].playback, cards[1], 1)", context);
    const frame = cards[1].querySelector('iframe.embed-player');
    assert.equal(frame.src, 'http://app.test/embed/pornhub?id=phNext&start=5');
    await vm.runInContext("tryMode('embed', videos[1].playback, cards[1], 1)", context);
    assert.equal(cards[1].querySelector('iframe.embed-player'), frame);
    assert.equal(frame.src, 'http://app.test/embed/pornhub?id=phNext&start=5');
    assert.equal(frame.navigations, 1, 'adopting the relative embed URL must not reload the iframe');
});

test('embed offsets honor overrides and disabling, without changing other sources', async () => {
    for (const [source, offset, expected] of [
        ['pornhub', 12, 'http://app.test/embed/pornhub?id=phOffset&start=12'],
        ['pornhub', 0, 'https://www.pornhub.com/embed/phOffset?autoplay=1&muted=1'],
        ['twikeep', 5, 'https://www.twikeep.com/embed/phOffset?autoplay=1&muted=1'],
    ]) {
        const embedUrl = `https://www.${source}.com/embed/phOffset?autoplay=1&muted=1`;
        const video = { id: 'phOffset', _sourceId: source, playback: { kind: 'embed', embedUrl } };
        const { context, cards } = client([video], { startOffsets: { [source]: offset } });
        await vm.runInContext("tryMode('embed', videos[0].playback, cards[0], 0)", context);
        assert.equal(cards[0].querySelector('iframe.embed-player').src, expected);
    }
});

test('the embed player uses metadata for short clips, allows manual seeking, and loops to the offset', () => {
    for (const [duration, offset, expected] of [
        [120, 5, 5], [120, 12, 12], [5.1, 5, 5], [5, 5, 0], [3, 5, 0],
        [Infinity, 5, 0], [120, 0, 0],
    ]) {
        const { media, fire } = player(embedPlayerHtml({ kind: 'file', url: mediaUrl }, offset));
        fire('durationchange'); // Unknown duration must not consume the initial seek.
        media.duration = duration;
        media.readyState = 1;
        fire('loadedmetadata');
        assert.equal(media.currentTime, expected);
        media.currentTime = 1;
        fire('durationchange');
        fire('loadedmetadata');
        assert.equal(media.currentTime, 1, 'a later event never undoes a manual seek');
        fire('ended');
        assert.equal(media.currentTime, expected);
        media.currentTime = 0;
        fire('emptied');
        fire('loadedmetadata');
        assert.equal(media.currentTime, expected, 'a new resource gets its initial offset');
    }
});

test('native HLS and hls.js share the iframe start seek and keep requests on the existing relay', () => {
    const html = embedPlayerHtml({ kind: 'hls', url: 'https://ev.phncdn.com/master.m3u8' }, 5);
    const native = player(html, { nativeHls: true });
    assert.equal(native.media.src, native.config.url);
    native.media.duration = 120;
    native.media.readyState = 1;
    native.fire('loadedmetadata');
    assert.equal(native.media.currentTime, 5);
    let instance;
    class Hls {
        static Events = { MANIFEST_PARSED: 'manifest', ERROR: 'error' };
        static isSupported() { return true; }
        constructor() { instance = this; this.handlers = {}; }
        on(name, fn) { this.handlers[name] = fn; }
        loadSource(url) { this.url = url; }
        attachMedia(media) { this.media = media; }
        destroy() { this.destroyed = true; }
    }
    const hls = player(html, { Hls });
    assert.equal(instance.url, hls.config.url);
    assert.equal(instance.media, hls.media);
    hls.media.duration = 120;
    hls.media.readyState = 1;
    hls.fire('loadedmetadata');
    assert.equal(hls.media.currentTime, 5);
    instance.handlers.error(null, { fatal: true });
    assert.equal(hls.error.hidden, false);
    assert.equal(instance.destroyed, true);
});

test('the embed endpoint rejects bad input before fetching and fails closed on upstream errors or changed markup', async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = () => assert.fail('invalid input must not reach the network');
    for (const query of ['id=../x&start=5', 'id=phX&start=-1', 'id=phX&start=Infinity', 'id=phX&start=', 'id=phX']) {
        const response = responseRecorder();
        await servePornhubEmbed({ method: 'GET' }, response, new URL(`http://app.test/embed/pornhub?${query}`));
        assert.equal(response.status, 400);
    }
    const method = responseRecorder();
    await servePornhubEmbed({ method: 'POST' }, method, new URL('http://app.test/embed/pornhub?id=phX&start=5'));
    assert.equal(method.status, 405);
    for (const [status, body] of [[403, 'blocked'], [200, '<html><head></head><body>changed player</body></html>']]) {
        globalThis.fetch = async () => new Response(body, { status });
        const response = responseRecorder();
        await servePornhubEmbed({ method: 'GET' }, response, new URL('http://app.test/embed/pornhub?id=phX&start=5'));
        assert.equal(response.status, 502, 'never silently play from zero or serve unpatched third-party HTML');
    }
});
