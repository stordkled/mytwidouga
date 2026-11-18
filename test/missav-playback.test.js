const test = require('node:test');
const assert = require('node:assert/strict');
const missav = require('../sources/missav');
const sources = require('../sources');

async function withSettings(settings, fn) {
    const original = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
    for (const [key, value] of Object.entries(settings)) process.env[key] = value;
    try {
        await fn();
    } finally {
        for (const [key, value] of Object.entries(original)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

function mockReadableWatchPage(t) {
    // This page would previously produce an HLS result. It must never be fetched,
    // even when it is readable and contains a recognizable playlist URL.
    return t.mock.method(globalThis, 'fetch', async () => new Response(`
        <html><script>
          const url = 'https://surrit.com/96d8d22e-6c4c-455a-82e6-2f01f3c4c609/playlist.m3u8';
        </script></html>
    `, { headers: { 'content-type': 'text/html' } }));
}

test('MissAV returns only the configured embed without fetching readable watch HTML', async (t) => {
    const fetch = mockReadableWatchPage(t);
    await withSettings({ SOURCE_EMBED_MISSAV: 'https://player.example/embed/{id}' }, async () => {
        const playback = await missav.resolvePlayback('dldss-575');
        assert.deepEqual(playback, {
            kind: 'embed',
            url: 'https://player.example/embed/dldss-575',
            embedUrl: 'https://player.example/embed/dldss-575',
            referer: 'https://missav.ws/',
        });
        await assert.rejects(() => missav.resolvePlayback('../invalid'), /Invalid MissAV video id/);
    });
    assert.equal(fetch.mock.callCount(), 0);
});

test('MissAV without an embed fails explicitly through the adapter and resolve API boundary', async (t) => {
    const fetch = mockReadableWatchPage(t);
    await withSettings({ SOURCE_EMBED_MISSAV: '' }, async () => {
        await assert.rejects(() => missav.resolvePlayback('no-embed'), /embed-only.*SOURCE_EMBED_MISSAV/);
        const result = await sources.resolvePlayback('missav', 'no-embed', { fresh: true });
        assert.equal(result.ok, false);
        assert.equal(result.playback, null);
        assert.match(result.error, /embed-only.*SOURCE_EMBED_MISSAV/);
    });
    assert.equal(fetch.mock.callCount(), 0);
});

test('a hidden MissAV source resolves to embed for fresh and cached API requests in direct mode', async (t) => {
    const fetch = mockReadableWatchPage(t);
    await withSettings({
        SOURCE_EMBED_MISSAV: 'https://player.example/embed/{id}',
        SOURCE_PLAYBACK_MISSAV: 'direct',
        SOURCE_HIDDEN_MISSAV: '1',
    }, async () => {
        assert.equal(sources.list().find((source) => source.id === 'missav').hidden, true);
        assert.equal(sources.playbackConfig().sources.missav, 'direct');
        for (const fresh of [true, false, true]) {
            const result = await sources.resolvePlayback('missav', 'embed-only', { fresh });
            assert.equal(result.ok, true);
            assert.equal(result.cached, !fresh);
            assert.equal(result.playback.kind, 'embed');
            const url = new URL(result.playback.url);
            assert.equal(url.origin + url.pathname, 'https://player.example/embed/embed-only');
            assert.equal(url.searchParams.get('autoplay'), '1');
            assert.equal(url.searchParams.get('muted'), '1');
            assert.equal(result.playback.embedUrl, result.playback.url);
        }
    });
    assert.equal(fetch.mock.callCount(), 0);
});
