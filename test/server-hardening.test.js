const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { TtlCache } = require('../lib/cache');
const { createLaunchGate } = require('../lib/browser');
const { staticPath } = require('../lib/static');
const mirrors = require('../lib/mirrors');
const sources = require('../sources');

test('a fresh resolve is not overwritten by the older load that finishes later', async () => {
    const cache = new TtlCache();
    let finishOld;
    const old = cache.getOrLoad('pornhub:abc', 60000, () => new Promise((resolve) => { finishOld = resolve; }));
    await new Promise((resolve) => setImmediate(resolve));

    // /api/resolve?fresh=1 drops the entry and loads again.
    cache.delete('pornhub:abc');
    const fresh = await cache.getOrLoad('pornhub:abc', 60000, async () => 'new-url');
    assert.equal(fresh.value, 'new-url');

    finishOld('expired-url');
    assert.equal((await old).value, 'expired-url');

    const next = await cache.getOrLoad('pornhub:abc', 60000, async () => 'should-not-load');
    assert.equal(next.cached, true);
    assert.equal(next.value, 'new-url');
});

test('the resolve cache drops expired entries and stays bounded', async () => {
    const cache = new TtlCache({ maxEntries: 3 });
    await cache.getOrLoad('short', 1, async () => 'x');
    await new Promise((resolve) => setTimeout(resolve, 5));
    for (const key of ['a', 'b', 'c', 'd']) {
        await cache.getOrLoad(key, 60000, async () => key);
    }
    assert.equal(cache.size, 3);
    assert.equal((await cache.getOrLoad('d', 60000, async () => 'reloaded')).cached, true);
    assert.equal((await cache.getOrLoad('a', 60000, async () => 'reloaded')).value, 'reloaded');
});

test('closing the browser while it is still launching closes that Chrome too', async () => {
    const gate = createLaunchGate();
    let finish;
    const pending = gate.start(() => new Promise((resolve) => { finish = resolve; }));
    await new Promise((resolve) => setImmediate(resolve));
    await gate.close();

    let closed = 0;
    finish({ connected: true, on() {}, close: async () => { closed += 1; } });
    await assert.rejects(pending, /closed during launch/);
    assert.equal(closed, 1);
    assert.equal(gate.current(), null);
});

test('static files are limited to the PWA itself', () => {
    const root = path.resolve(__dirname, '..');
    assert.equal(staticPath('/', root), path.join(root, 'index.html'));
    assert.equal(staticPath('/src/main.js?v=8', root), path.join(root, 'src', 'main.js'));
    assert.equal(staticPath('/icons/icon-192.png', root), path.join(root, 'icons', 'icon-192.png'));
    assert.equal(staticPath('/sw.js', root), path.join(root, 'sw.js'));
    for (const blocked of [
        '/server.js',
        '/package.json',
        '/config/sources.json',
        '/.env',
        '/.git/config',
        '/src/../server.js',
        '/src/%2e%2e/server.js',
        '/src/..%5c.env',
        '/src/..%2f.env',
        '/%00',
        '/src/%E0%A4%A',
    ]) {
        assert.equal(staticPath(blocked, root), null, blocked);
    }
});

test('a source hidden in config is left out of the switcher until an env override', () => {
    const hidden = Object.fromEntries(sources.list().map((source) => [source.id, source.hidden]));
    assert.equal(hidden.twivideo, true);
    assert.equal(hidden.twikeep, false);
    assert.equal(hidden.pornhub, false);
    assert.equal(hidden['85po'], false);
    assert.equal(hidden.tokyomotion, false);

    process.env.SOURCE_HIDDEN_TWIVIDEO = '0';
    try {
        assert.equal(mirrors.hiddenFor('twivideo'), false);
        assert.equal(sources.list().find((source) => source.id === 'twivideo').hidden, false);
    } finally {
        delete process.env.SOURCE_HIDDEN_TWIVIDEO;
    }
    assert.equal(sources.list().find((source) => source.id === 'twivideo').hidden, true);
});

test('relay limits come from config', () => {
    const settings = mirrors.settings();
    assert.ok(settings.maxProxyStreams >= 1);
    assert.ok(settings.maxProxyStreamsPerClient >= 1);
    assert.ok(settings.proxyQueueMs > 0);
});
