// TwiKeep and Twihozon are off in the shipped config, with their adapters kept.
delete process.env.SOURCES_CONFIG;
delete process.env.SOURCE_ENABLED_TWIKEEP;
delete process.env.SOURCE_ENABLED_TWIHOZON;
delete process.env.SOURCE_HIDDEN_TWIKEEP;
delete process.env.SOURCE_HIDDEN_TWIHOZON;

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const sources = require('../sources');
const Logic = require('../src/feed-logic');

const ROOT = path.join(__dirname, '..');
const DISABLED = ['twikeep', 'twihozon'];

async function withFetch(handler, fn) {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url) => {
        calls.push(String(url));
        const { status = 200, body = '' } = handler(String(url));
        return new Response(body, { status, headers: { 'content-type': 'text/html' } });
    };
    try {
        await fn(calls);
    } finally {
        globalThis.fetch = original;
    }
}

function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

function getJson(port, urlPath) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: urlPath, agent: false }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({
                status: res.statusCode,
                body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            }));
        }).on('error', reject);
    });
}

test('the shipped config disables both sources and keeps their adapters', () => {
    const list = sources.list();
    assert.deepEqual(sources.disabledIds(), DISABLED);
    for (const id of DISABLED) {
        const entry = list.find((source) => source.id === id);
        assert.equal(entry.enabled, false);
        assert.equal(entry.hidden, true);
        assert.equal(entry.retryLater, undefined, 'a disabled source is not polled');
        assert.ok(sources.get(id), 'the adapter is still registered');
    }
    assert.deepEqual(Logic.barSources(list, undefined).map((source) => source.id), ['pornhub', '85po', 'tokyomotion']);
});

test('a disabled source is never offered, even as current or when all others are hidden', () => {
    const list = sources.list();
    assert.equal(Logic.barSources(list, 'twikeep').some((source) => source.id === 'twikeep'), false);
    const allHidden = list.map((source) => ({ ...source, hidden: true }));
    const offered = Logic.barSources(allHidden, 'twihozon').map((source) => source.id);
    assert.deepEqual(offered, ['pornhub', '85po', 'twivideo', 'tokyomotion']);
    const failed = new Set(['pornhub', '85po', 'tokyomotion']);
    assert.equal(Logic.fallbackSource(list, 'tokyomotion', failed), null);
});

test('a disabled ranking contacts nobody and is not recorded as a failure', async () => {
    sources.resetFailures();
    await withFetch(() => {
        throw new Error('no upstream request is allowed');
    }, async (calls) => {
        for (const id of DISABLED) {
            const result = await sources.fetchRanking(id, '24h');
            assert.equal(result.ok, false);
            assert.equal(result.disabled, true);
            assert.equal(result.reason, 'disabled');
            assert.deepEqual(result.videos, []);
            assert.equal(sources.failureState(id), null);
            assert.equal(sources.pageRanking(result, '1').hasMore, false);
        }
        assert.deepEqual(calls, []);
    });
    assert.match(Logic.switchNote('TwiKeep', 'Pornhub', 'disabled', false), /設定で無効/);
});

test('SOURCE_ENABLED_<ID> brings a source back; SOURCE_HIDDEN does not', () => {
    process.env.SOURCE_HIDDEN_TWIKEEP = '0';
    try {
        assert.equal(sources.list().find((source) => source.id === 'twikeep').enabled, false);
        assert.equal(sources.sourceHidden('twikeep'), true);
    } finally {
        delete process.env.SOURCE_HIDDEN_TWIKEEP;
    }
    process.env.SOURCE_ENABLED_TWIKEEP = '1';
    try {
        const entry = sources.list().find((source) => source.id === 'twikeep');
        assert.equal(entry.enabled, true);
        assert.equal(entry.hidden, false);
        assert.deepEqual(sources.disabledIds(), ['twihozon']);
    } finally {
        delete process.env.SOURCE_ENABLED_TWIKEEP;
    }
});

test('a browser saved on a disabled source opens on Pornhub and forgets it', () => {
    const offered = Logic.barSources(sources.list(), undefined);
    for (const id of DISABLED) assert.equal(Logic.initialSource(offered, id).id, 'pornhub');
    const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
    assert.match(main, /saved && !sources\.some\(\(source\) => source\.id === saved && source\.enabled !== false\)/);
    assert.match(main, /localStorage\.removeItem\(STORAGE_SOURCE\)/);
});

test('bookmarks of a disabled source stay and can still resolve', async () => {
    const video = {
        id: '14725',
        title: 'saved',
        pageUrl: 'https://www.twihozon.org/play-14725-video.html',
        thumbUrl: 'https://pbs.twimg.com/a.jpg',
        playback: { kind: 'resolve' },
    };
    const list = Logic.toggleBookmark([], video, 'twihozon', 1).list;
    assert.equal(Logic.isBookmarked(Logic.normalizeBookmarks(list), 'twihozon', '14725'), true);
    assert.equal(Logic.bookmarkVideos(list)[0]._sourceId, 'twihozon');
    assert.ok(sources.proxyView('twihozon'), 'the media relay still accepts it');
    assert.ok(sources.proxyView('twikeep'));

    const page = fs.readFileSync(path.join(__dirname, 'fixtures', 'twihozon-play-14725.html'), 'utf8');
    await withFetch((url) => {
        if (url === video.pageUrl) return { body: page };
        throw new TypeError('fetch failed');
    }, async () => {
        const result = await sources.resolvePlayback('twihozon', '14725', { fresh: true });
        assert.equal(result.ok, true);
        assert.equal(result.playback.kind, 'file');
        assert.match(result.playback.url, /^https:\/\/video\.twimg\.com\//);
    });
});

test('/api/status reports the disabled sources and /api/videos declines them', async (t) => {
    const port = await freePort();
    const env = { ...process.env, PORT: String(port) };
    for (const key of ['BASIC_AUTH_USER', 'BASIC_AUTH_PASS', 'TRUST_PROXY']) delete env[key];
    const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => child.kill());
    const banner = await new Promise((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error('server did not start')), 15000);
        child.stdout.on('data', (chunk) => {
            output += String(chunk);
            if (output.includes('Access:')) {
                clearTimeout(timer);
                resolve(output);
            }
        });
        child.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`server exited with ${code}`));
        });
    });
    assert.doesNotMatch(banner, /Sources:.*(twikeep|twihozon)/);

    const status = await getJson(port, '/api/status');
    assert.equal(status.status, 200);
    assert.deepEqual(status.body.disabledSources, DISABLED);
    assert.equal(status.body.sources.find((source) => source.id === 'twikeep').enabled, false);

    const videos = await getJson(port, '/api/videos?source=twikeep&period=24h');
    assert.equal(videos.status, 200);
    assert.equal(videos.body.ok, false);
    assert.equal(videos.body.disabled, true);
    assert.deepEqual(videos.body.videos, []);

    const boot = await getJson(port, '/api/videos?source=twihozon&period=24h&boot=1');
    assert.equal(boot.body.bootSkipped, true);
});
