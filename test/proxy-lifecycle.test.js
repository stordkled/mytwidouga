const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { proxyMedia, createStreamLimiter } = require('../lib/proxy');

// cdn.test must look public to the proxy, but the bytes come from a local
// server. The resolver is injected per request, so nothing global changes.
function lookup(hostname, options, callback) {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }
    if (options && options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
    else callback(null, '127.0.0.1', 4);
}

const SOURCE = { id: 'test', mediaHosts: ['cdn.test'], mediaReferer: 'https://site.test/' };

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function shutdown(server) {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    return new Promise((resolve) => server.close(() => resolve()));
}

async function startPair(t, upstreamHandler, proxyOptions) {
    const upstream = http.createServer(upstreamHandler);
    const upstreamPort = await listen(upstream);
    const app = http.createServer((req, res) => {
        const target = new URL(req.url, 'http://app.local').searchParams.get('url');
        proxyMedia(target, SOURCE, req, res, { lookup, ...proxyOptions });
    });
    const appPort = await listen(app);
    t.after(async () => {
        await shutdown(app);
        await shutdown(upstream);
    });
    const mediaUrl = (path) => `http://cdn.test:${upstreamPort}${path}`;
    const get = (path) => http.get({
        host: '127.0.0.1',
        port: appPort,
        path: `/proxy/media?url=${encodeURIComponent(mediaUrl(path))}`,
        agent: false,
    });
    return { get };
}

function within(promise, ms, label) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} did not happen within ${ms}ms`)), ms);
        }),
    ]).finally(() => clearTimeout(timer));
}

async function eventually(check, ms, label) {
    const started = Date.now();
    while (!check()) {
        if (Date.now() - started > ms) throw new Error(`${label} still false after ${ms}ms`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

test('a viewer that hangs up before the CDN answers closes the upstream request and frees the slot', async (t) => {
    const limiter = createStreamLimiter({ max: 2 });
    let arrived;
    const upstreamArrived = new Promise((resolve) => { arrived = resolve; });
    let closed;
    const upstreamClosed = new Promise((resolve) => { closed = resolve; });
    const { get } = await startPair(t, (req, res) => {
        // Never answers: the relay is stuck waiting for headers.
        res.on('close', closed);
        arrived();
    }, { limiter });

    const client = get('/slow/file.mp4');
    client.on('error', () => {});
    await within(upstreamArrived, 3000, 'upstream request');
    assert.equal(limiter.status().active, 1);
    client.destroy();

    await within(upstreamClosed, 3000, 'upstream close');
    await eventually(() => limiter.status().active === 0, 2000, 'slot released');
});

test('a viewer that hangs up mid-body stops the upstream stream and frees the slot', async (t) => {
    const limiter = createStreamLimiter({ max: 2 });
    let closed;
    const upstreamClosed = new Promise((resolve) => { closed = resolve; });
    const { get } = await startPair(t, (req, res) => {
        res.writeHead(206, {
            'Content-Type': 'video/mp4',
            'Content-Length': String(8 * 1024 * 1024),
            'Content-Range': `bytes 0-${8 * 1024 * 1024 - 1}/${64 * 1024 * 1024}`,
        });
        res.write(Buffer.alloc(64 * 1024));
        res.on('close', closed);
    }, { limiter });

    const client = get('/v/file.mp4');
    client.on('error', () => {});
    await within(new Promise((resolve) => {
        client.on('response', (res) => {
            assert.equal(res.statusCode, 206);
            res.once('data', resolve);
        });
    }), 3000, 'first bytes');
    client.destroy();

    await within(upstreamClosed, 3000, 'upstream close');
    await eventually(() => limiter.status().active === 0, 2000, 'slot released');
});

test('an upstream that dies mid-body resets the viewer instead of leaving it waiting', async (t) => {
    const limiter = createStreamLimiter({ max: 2 });
    const { get } = await startPair(t, (req, res) => {
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': '100000' });
        res.write(Buffer.alloc(1000), () => setTimeout(() => req.socket.destroy(), 20));
    }, { limiter });

    const client = get('/v/file.mp4');
    const outcome = new Promise((resolve) => {
        client.on('error', () => resolve('error'));
        client.on('response', (res) => {
            res.on('error', () => {});
            res.resume();
            res.on('end', () => resolve(res.complete ? 'complete' : 'truncated'));
            res.on('close', () => resolve(res.complete ? 'complete' : 'truncated'));
        });
    });
    const result = await within(outcome, 4000, 'viewer notices the broken stream');
    assert.notEqual(result, 'complete');
    await eventually(() => limiter.status().active === 0, 2000, 'slot released');
});

function collect(client) {
    return new Promise((resolve, reject) => {
        client.on('error', reject);
        client.on('response', (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('error', reject);
            res.on('end', () => resolve({ res, body: Buffer.concat(chunks).toString('utf8'), complete: res.complete }));
        });
    });
}

test('a chunked body without Content-Length is relayed completely', async (t) => {
    const limiter = createStreamLimiter({ max: 2 });
    const { get } = await startPair(t, (req, res) => {
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        res.write('abcd');
        res.end('efgh');
    }, { limiter });

    const { res, body, complete } = await within(collect(get('/seg/0.ts')), 3000, 'chunked relay');
    assert.equal(res.statusCode, 200);
    assert.equal(body, 'abcdefgh');
    assert.equal(complete, true);
    await eventually(() => limiter.status().active === 0, 2000, 'slot released');
});

test('a chunked image without Content-Length is relayed completely', async (t) => {
    const { get } = await startPair(t, (req, res) => {
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        res.write('jp');
        res.end('eg');
    }, { limiter: createStreamLimiter({ max: 1 }) });

    const { body, complete } = await within(collect(get('/t/thumb.jpg')), 3000, 'chunked image');
    assert.equal(body, 'jpeg');
    assert.equal(complete, true);
});

test('a redirect hop is closed instead of drained when the proxy follows it', async (t) => {
    const limiter = createStreamLimiter({ max: 2 });
    let hopClosed;
    const redirectClosed = new Promise((resolve) => { hopClosed = resolve; });
    const { get } = await startPair(t, (req, res) => {
        if (req.url.startsWith('/hop/')) {
            // A 302 whose body never finishes: draining it would pin the socket.
            res.writeHead(302, { Location: '/v/final.mp4', 'Content-Type': 'text/plain' });
            res.write('moving');
            res.on('close', hopClosed);
            return;
        }
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': '4' });
        res.end('mp4!');
    }, { limiter });

    const { body } = await within(collect(get('/hop/file.mp4')), 3000, 'redirected relay');
    assert.equal(body, 'mp4!');
    await within(redirectClosed, 3000, 'redirect hop closed');
    await eventually(() => limiter.status().active === 0, 2000, 'slot released');
});

test('a viewer over the relay cap waits briefly, then gets 429 without opening a CDN connection', async (t) => {
    const limiter = createStreamLimiter({ max: 1 });
    let upstreamRequests = 0;
    const { get } = await startPair(t, (req, res) => {
        upstreamRequests += 1;
        res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Length': '1000000' });
        res.write(Buffer.alloc(1024));
    }, { limiter, queueMs: 150 });

    const first = get('/v/a.mp4');
    first.on('error', () => {});
    await within(new Promise((resolve) => first.on('response', resolve)), 3000, 'first relay');

    const second = get('/v/b.mp4');
    const response = await within(new Promise((resolve) => second.on('response', resolve)), 3000, 'second answer');
    response.resume();
    assert.equal(response.statusCode, 429);
    assert.equal(response.headers['retry-after'], '2');
    assert.equal(upstreamRequests, 1);
    first.destroy();
});

test('a queued viewer gets the slot as soon as the previous relay ends', async (t) => {
    const limiter = createStreamLimiter({ max: 1 });
    const { get } = await startPair(t, (req, res) => {
        res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Length': '1000000' });
        res.write(Buffer.alloc(1024));
    }, { limiter, queueMs: 3000 });

    const first = get('/v/a.mp4');
    first.on('error', () => {});
    await within(new Promise((resolve) => first.on('response', resolve)), 3000, 'first relay');

    const second = get('/v/b.mp4');
    second.on('error', () => {});
    const answered = new Promise((resolve) => second.on('response', resolve));
    await eventually(() => limiter.status().waiting === 1, 2000, 'second viewer queued');
    first.destroy();
    const response = await within(answered, 3000, 'queued viewer served');
    assert.equal(response.statusCode, 206);
    second.destroy();
});

test('thumbnails do not take a relay slot and are cacheable', async (t) => {
    const limiter = createStreamLimiter({ max: 1 });
    const { get } = await startPair(t, (req, res) => {
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': '4' });
        res.end('jpeg');
    }, { limiter, queueMs: 10 });

    // Hold the only slot with a never-finished media relay first.
    const release = await limiter.acquire('someone-else');
    const response = await within(new Promise((resolve) => get('/t/thumb.jpg').on('response', resolve)), 3000, 'thumb');
    response.resume();
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['cache-control'], /public/);
    release();
});

test('stream limiter caps each viewer and lets a cancelled waiter leave the queue', async () => {
    const limiter = createStreamLimiter({ max: 3, perClient: 1 });
    const a1 = await limiter.acquire('a');
    assert.equal(typeof a1, 'function');
    assert.equal(await limiter.acquire('a', 0), null, 'second stream for the same viewer is refused');
    const b1 = await limiter.acquire('b');
    assert.equal(typeof b1, 'function', 'another viewer still gets a slot');

    const waiting = limiter.acquire('a', 5000);
    assert.equal(limiter.status().waiting, 1);
    waiting.cancel();
    assert.equal(await waiting, null);
    assert.equal(limiter.status().waiting, 0);

    a1();
    a1();
    assert.equal(limiter.status().active, 1, 'double release counts once');
    b1();
    assert.equal(limiter.status().active, 0);
    assert.equal(limiter.status().clients, 0);
});
