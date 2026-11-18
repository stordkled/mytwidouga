// Regressions from the 2026-11-18 17:30 JST Chrome playtest.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { finalizeVideos } = require('../lib/video');
const tokyomotion = require('../sources/tokyomotion');
const sources = require('../sources');
const Logic = require('../src/feed-logic');

const FIXTURES = path.join(__dirname, 'fixtures');
const tmWeek = fs.readFileSync(path.join(FIXTURES, 'tokyomotion-videos-mv-w.html'), 'utf8');
const tmTodayEmpty = fs.readFileSync(path.join(FIXTURES, 'tokyomotion-videos-mv-t-empty.html'), 'utf8');
const twikeepJson = fs.readFileSync(path.join(FIXTURES, 'twikeep-ranking-downloads-24h.json'), 'utf8');

async function withFetch(handler, fn) {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), headers: (init && init.headers) || {} });
        const { status = 200, body = '', type = 'text/html' } = handler(String(url));
        return new Response(body, { status, headers: { 'content-type': type } });
    };
    try {
        await fn(calls);
    } finally {
        globalThis.fetch = original;
    }
}

// ---- 3. TokyoMotion -------------------------------------------------------

test('tokyomotion parses the current card markup without a.thumb-popu', () => {
    assert.equal(tmWeek.includes('thumb-popu'), false);
    const videos = finalizeVideos(tokyomotion.parseListing(tmWeek));
    assert.deepEqual(videos.map((video) => video.id), ['7216911', '7221572', '7217880', '7218603', '7218013']);
    const [first, , third, , fifth] = videos;
    assert.equal(first.title, 'サンプル動画 一', 'title link text, not the "HD01:43" image link');
    assert.equal(first.pageUrl, 'https://www.tokyomotion.net/video/7216911/sample-one');
    assert.equal(first.thumbUrl, 'https://cdn.tokyo-motion.net/media/videos/tmb225/7216911/16.jpg');
    assert.equal(first.duration, '01:43');
    assert.equal(first.views, '41934 views');
    assert.equal(first.playback.kind, 'resolve');
    assert.equal(third.thumbUrl, 'https://cdn.tokyo-motion.net/media/videos/tmb225/7217880/1.jpg', 'lazy data-src wins over a data: placeholder');
    assert.equal(third.views, '31,056 views');
    assert.equal(fifth.duration, '1:03:30');
    assert.equal(videos.some((video) => video.id === '99999'), false, 'links to other hosts are not cards');
});

test('tokyomotion still reads the older thumb-popu markup', () => {
    const videos = tokyomotion.parseListing(`
      <div class="row">
        <div class="well well-sm">
          <a href="/video/1/a" class="thumb-popu"><img src="/t/1.jpg" alt="A"><span class="video-title">一</span><div class="duration">00:26</div></a>
          <div class="video-views">12 観覧</div>
        </div>
        <div class="well well-sm">
          <a href="/video/2/b" class="thumb-popu"><img src="/t/2.jpg" alt="B"><div class="duration">10:00</div></a>
        </div>
      </div>`);
    assert.deepEqual(videos.map((video) => [video.id, video.title, video.duration, video.views]), [
        ['1', '一', '00:26', '12 観覧'],
        ['2', 'B', '10:00', ''],
    ]);
});

test('tokyomotion: an empty "today" board is detected and 今日 falls back to this week', async () => {
    assert.equal(tokyomotion.parseListing(tmTodayEmpty).length, 0);
    assert.equal(tokyomotion.isEmptyBoard(tmTodayEmpty), true);
    assert.equal(tokyomotion.isEmptyBoard(tmWeek), false);

    const pages = new Map([
        ['https://www.tokyomotion.net/videos?o=mv&t=t', tmTodayEmpty],
        ['https://www.tokyomotion.net/videos?o=mv&t=w', tmWeek],
    ]);
    await withFetch((url) => {
        assert.ok(pages.has(url), `unexpected request: ${url}`);
        return { body: pages.get(url) };
    }, async (calls) => {
        const videos = await tokyomotion.fetchRanking('24h');
        assert.equal(videos.length, 5);
        assert.match(videos.notice, /今日の動画がまだない/);
        assert.deepEqual(calls.map((call) => call.url), [
            'https://www.tokyomotion.net/videos?o=mv&t=t',
            'https://www.tokyomotion.net/videos?o=mv&t=w',
        ]);

        const result = await sources.fetchRanking('tokyomotion', '24h');
        assert.equal(result.ok, true);
        assert.equal(result.videos.length, 5);
        assert.match(result.notice, /今週の再生数順/);
    });

    // A page that is neither cards nor "No Videos Found" is still an error,
    // and a week board does not fall back further.
    await withFetch(() => ({ body: '<html><body>maintenance</body></html>' }), async () => {
        await assert.rejects(() => tokyomotion.fetchRanking('7d'), /no ranking cards/);
    });
    await withFetch(() => ({ body: tmTodayEmpty }), async () => {
        await assert.rejects(() => tokyomotion.fetchRanking('7d'), /empty board/);
    });
});

// ---- 4a. Hiding failed sources, and recovering --------------------------

test('one block page does not hide a source; a streak does, and it comes back later', () => {
    sources.resetFailures();
    const t0 = 1_000_000;
    const retry = 600000;
    sources.noteSourceResult('pornhub', false, 'All mirrors failed: https://www.pornhub.com (block page)', t0);
    assert.equal(sources.sourceHidden('pornhub', t0), false, 'a single block page is often transient');
    sources.noteSourceResult('pornhub', false, 'block page', t0 + 1000);
    assert.equal(sources.sourceHidden('pornhub', t0 + 1000), false);
    sources.noteSourceResult('pornhub', false, 'HTTP 503', t0 + 2000);
    assert.equal(sources.sourceHidden('pornhub', t0 + 2000), true, 'three in a row hide it');
    assert.equal(sources.list().find((source) => source.id === 'pornhub').hidden, false, 'the real clock is far past the test window');

    assert.equal(sources.sourceHidden('pornhub', t0 + 2000 + retry - 1), true);
    assert.equal(sources.sourceHidden('pornhub', t0 + 2000 + retry + 1), false, 'offered again after hiddenRetryMs');
    sources.noteSourceResult('pornhub', false, 'block page', t0 + 2000 + retry + 5);
    assert.equal(sources.sourceHidden('pornhub', t0 + 2000 + retry + 5), true, 'one more failure hides it again');
    sources.noteSourceResult('pornhub', true);
    assert.equal(sources.sourceHidden('pornhub', t0 + 2000 + retry + 6), false, 'a success clears it');
    assert.equal(sources.failureState('pornhub'), null);

    // Failures far apart are not a streak.
    sources.noteSourceResult('85po', false, 'timed out', t0);
    sources.noteSourceResult('85po', false, 'timed out', t0 + retry * 2);
    sources.noteSourceResult('85po', false, 'timed out', t0 + retry * 4);
    assert.equal(sources.failureState('85po').count, 1);
    assert.equal(sources.sourceHidden('85po', t0 + retry * 4), false);
    sources.resetFailures();
});

test('a failed ranking says why, in a short category for the UI', async () => {
    assert.equal(sources.failureReason('All mirrors failed: x (block page)'), 'blocked');
    assert.equal(sources.failureReason('TokyoMotion timed out after 60000ms'), 'timeout');
    assert.equal(sources.failureReason('All mirrors failed: x (no ranking cards)'), 'empty');
    assert.equal(sources.failureReason('All mirrors failed: x (HTTP 503)'), 'http');
    assert.equal(sources.failureReason('weird'), 'error');

    sources.resetFailures();
    await withFetch(() => ({ status: 403, body: '<title>Just a moment...</title>' }), async () => {
        const result = await sources.fetchRanking('twihozon', '7d');
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'blocked');
        assert.equal(result.hidden, false, 'one block page leaves it in the switcher');
        assert.match(result.error, /このネットワークから開けません/);
    });
    sources.resetFailures();
});

// ---- 5. TwiKeep metric ----------------------------------------------------

test('twikeep ranking cache is per metric and /api/videos?metric= reaches the upstream query', async () => {
    assert.equal(sources.rankingCacheKey('twikeep', '24h', 'views'), 'twikeep:24h:views');
    assert.equal(sources.rankingCacheKey('twikeep', '24h', 'downloads'), 'twikeep:24h:downloads');
    assert.equal(sources.rankingCacheKey('twihozon', '24h', null), 'twihozon:24h');

    const listed = sources.list().find((source) => source.id === 'twikeep');
    assert.deepEqual(listed.metrics.map((metric) => metric.id), ['downloads', 'views']);
    assert.equal(listed.defaultMetric, 'downloads');
    assert.equal(sources.list().find((source) => source.id === 'twihozon').metrics, undefined);

    await withFetch(() => ({ body: twikeepJson, type: 'application/json' }), async (calls) => {
        const downloads = await sources.fetchRanking('twikeep', '30d', { metric: 'downloads' });
        const views = await sources.fetchRanking('twikeep', '30d', { metric: 'views' });
        assert.equal(downloads.metric, 'downloads');
        assert.equal(views.metric, 'views');
        assert.equal(views.cached, false, 'switching metric is not served the other board from cache');
        assert.equal(downloads.videos[0].views, '3 保存');
        assert.equal(views.videos[0].views, '3 表示');
        assert.deepEqual(calls.map((call) => new URL(call.url).searchParams.get('metric')), ['downloads', 'views']);

        const again = await sources.fetchRanking('twikeep', '30d', { metric: 'views' });
        assert.equal(again.cached, true);
        assert.equal(again.videos[0].views, '3 表示');
        const bogus = await sources.fetchRanking('twikeep', '30d', { metric: 'bogus' });
        assert.equal(bogus.metric, 'downloads', 'an unknown metric falls back to the configured one');
        assert.equal(bogus.cached, true);
        assert.equal(calls.length, 2);
    });
});

test('server.js passes ?metric= to the ranking', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(server, /searchParams\.get\('metric'\)/);
    assert.match(server, /fetchRanking\(sourceId, period, \{ metric \}\)/);
});

// ---- 4b / 6. Client decisions (src/feed-logic.js) -------------------------

const SOURCES = [
    { id: 'twivideo', name: 'TWIVIDEO', hidden: true },
    { id: 'pornhub', name: 'Pornhub', hidden: false },
    { id: 'tokyomotion', name: 'TokyoMotion', hidden: false },
    { id: 'missav', name: 'MissAV', hidden: true },
    { id: 'twikeep', name: 'TwiKeep', hidden: false },
];

test('automatic source switching skips hidden and already-failed sources and stops when none is left', () => {
    const failed = new Set(['pornhub']);
    assert.equal(Logic.fallbackSource(SOURCES, 'pornhub', failed).id, 'tokyomotion');
    failed.add('tokyomotion');
    assert.equal(Logic.fallbackSource(SOURCES, 'tokyomotion', failed).id, 'twikeep');
    failed.add('twikeep');
    assert.equal(Logic.fallbackSource(SOURCES, 'twikeep', failed), null, 'never a hidden one, never a failed one');

    const allHidden = SOURCES.map((source) => ({ ...source, hidden: true }));
    assert.equal(Logic.fallbackSource(allHidden, 'pornhub', new Set()), null);
    assert.equal(Logic.barSources(allHidden, 'pornhub').length, 5, 'the bar still lets the user pick one by hand');
    assert.deepEqual(Logic.barSources(SOURCES, 'missav').map((source) => source.id), ['pornhub', 'tokyomotion', 'missav', 'twikeep']);
});

test('every source hidden: the bar offers all of them, whichever one is current', () => {
    const allHidden = SOURCES.map((source) => ({ ...source, hidden: true }));
    for (const current of [undefined, 'pornhub', 'missav']) {
        assert.deepEqual(Logic.barSources(allHidden, current).map((source) => source.id), SOURCES.map((source) => source.id));
    }
    const onlyCurrentShown = SOURCES.map((source) => ({ ...source, hidden: source.id !== 'twikeep' }));
    assert.deepEqual(Logic.barSources(onlyCurrentShown, 'pornhub').map((source) => source.id), ['pornhub', 'twikeep']);
});

test('a source hidden after a failure streak comes back on an open page', () => {
    sources.resetFailures();
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) sources.noteSourceResult('pornhub', false, 'block page', now + i);
    const listed = sources.list();
    const hidden = listed.find((source) => source.id === 'pornhub');
    assert.equal(hidden.hidden, true);
    assert.equal(hidden.retryLater, true, 'the client is told to re-check later');
    assert.equal(listed.find((source) => source.id === 'twikeep').retryLater, undefined);

    // Client: it polls only while a temporarily hidden source exists.
    let client = Logic.mergeSourceStatus(SOURCES.map((source) => ({ ...source, hidden: false })), listed);
    assert.equal(client.find((source) => source.id === 'pornhub').hidden, true);
    assert.equal(Logic.barSources(client, 'twikeep').some((source) => source.id === 'pornhub'), false);
    assert.equal(Logic.fallbackSource(client, 'twikeep', new Set()).id, 'tokyomotion');
    assert.equal(Logic.needsSourceRefresh(client, 1000, 1000 + Logic.SOURCES_REFRESH_MS - 1), false);
    assert.equal(Logic.needsSourceRefresh(client, 1000, 1000 + Logic.SOURCES_REFRESH_MS), true);
    const configHiddenOnly = [{ id: 'missav', hidden: true }];
    assert.equal(Logic.needsSourceRefresh(configHiddenOnly, 0, 1e12), false, 'config-hidden sources are not polled');

    // Server: after hiddenRetryMs the flag is gone; the merged client list
    // shows it again and it is a fallback candidate again.
    sources.resetFailures();
    const later = sources.list();
    assert.equal(later.find((source) => source.id === 'pornhub').hidden, false);
    client = Logic.mergeSourceStatus(client, later);
    assert.equal(client.find((source) => source.id === 'pornhub').hidden, false);
    assert.equal(Logic.barSources(client, 'twikeep').some((source) => source.id === 'pornhub'), true);
    assert.equal(Logic.fallbackSource(client, 'twikeep', new Set()).id, 'pornhub');
    assert.equal(Logic.needsSourceRefresh(client, 0, 1e12), false);

    const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    assert.match(main, /setInterval\(\(\) => \{ refreshSources\(false\); \}, Logic\.SOURCES_REFRESH_MS\)/);
    assert.match(main, /await refreshSources\(true\);\s*loadVideos\(\);/, 'retry re-reads the hidden flags first');
});

test('twihozon: transient 5xx/429 probes are not reported as deleted', async () => {
    const twihozon = require('../sources/twihozon');
    const play = fs.readFileSync(path.join(FIXTURES, 'twihozon-play-14725.html'), 'utf8');
    for (const status of [503, 429]) {
        await withFetch((url) => {
            if (url === 'https://www.twihozon.org/play-14725-video.html') return { body: play };
            return { status, body: '', type: 'text/plain' };
        }, async () => {
            const playback = await twihozon.resolvePlayback('14725');
            assert.equal(playback.kind, 'file');
            assert.match(playback.url, /^https:\/\/video\.twimg\.com\//, `HTTP ${status} leaves it to the player ladder`);
        });
    }
});

test('switching source automatically shows a short reason', () => {
    assert.equal(
        Logic.switchNote('TokyoMotion', 'TwiKeep', 'empty', false),
        'TokyoMotion: ランキングが空でした → TwiKeep に切り替えました'
    );
    assert.match(Logic.switchNote('Pornhub', 'TwiKeep', 'blocked', true), /^Pornhub: このネットワークから開けません（しばらく非表示） → TwiKeep/);
    assert.equal(Logic.reasonText('nonsense'), '読み込みに失敗しました');
    assert.equal(Logic.joinNotes('a', '', null, 'b'), 'a / b');

    const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    assert.match(main, /loadVideos\(\{ note: Logic\.switchNote\(/, 'the note is passed into the next load');
    assert.match(main, /setFallbackNote\(switchNote\)/, 'and is not wiped when that load starts');
});

test('a stale playback attempt never sends the old ?fresh=1 resolve', () => {
    const attempt = { token: 7, index: 2, sourceId: 'twihozon' };
    assert.equal(Logic.playbackCurrent(attempt, { token: 7, index: 2, sourceId: 'twihozon' }), true);
    assert.equal(Logic.playbackCurrent(attempt, { token: 8, index: 0, sourceId: 'twikeep' }), false, 'source switched');
    assert.equal(Logic.playbackCurrent(attempt, { token: 7, index: 3, sourceId: 'twihozon' }), false, 'scrolled on');

    const base = { ok: false, mode: 'direct', alreadyResolved: false, kind: 'resolve' };
    assert.equal(Logic.shouldReResolve({ ...base, current: true }), true);
    assert.equal(Logic.shouldReResolve({ ...base, current: false }), false);
    assert.equal(Logic.shouldReResolve({ ...base, current: true, alreadyResolved: true }), false);
    assert.equal(Logic.shouldReResolve({ ...base, current: true, kind: 'file' }), false);
    assert.equal(Logic.shouldReResolve({ ...base, current: true, mode: 'embed' }), false);
    assert.equal(Logic.shouldReResolve({ ...base, current: true, ok: true }), false);

    assert.equal(Logic.resolveUrl('twihozon', '14725', true), '/api/resolve?source=twihozon&id=14725&fresh=1');
    assert.equal(Logic.resolveUrl('a&b', 'x y', false), '/api/resolve?source=a%26b&id=x%20y');

    const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    assert.doesNotMatch(main, /\/api\/resolve\?source=\$\{encodeURIComponent\(currentSource\.id\)\}/, 'resolve uses the video\'s own source');
    assert.match(main, /current: current\(\)/, 'the re-resolve checks the attempt is still on screen');
});

test('a video stuck at readyState 0 counts as failed, so the feed moves on', () => {
    assert.equal(Logic.mediaStalled({ readyState: 0, networkState: 2, elapsedMs: 1000 }), false);
    assert.equal(Logic.mediaStalled({ readyState: 0, networkState: 3, elapsedMs: 1000 }), true, 'NETWORK_NO_SOURCE');
    assert.equal(Logic.mediaStalled({ readyState: 0, networkState: 2, elapsedMs: Logic.STALL_MS }), true);
    assert.equal(Logic.mediaStalled({ readyState: 1, networkState: 2, elapsedMs: 60000 }), false);
    assert.ok(Logic.STALL_MS > 8000, 'longer than the relay queue wait');
});

test('metric toggle helpers and the videos URL', () => {
    const twikeep = { id: 'twikeep', metrics: [{ id: 'downloads' }, { id: 'views' }], defaultMetric: 'downloads' };
    assert.equal(Logic.pickMetric(twikeep, 'views'), 'views');
    assert.equal(Logic.pickMetric(twikeep, 'bogus'), 'downloads');
    assert.equal(Logic.pickMetric({ id: 'twihozon' }, 'views'), '');
    assert.equal(Logic.nextMetric(twikeep.metrics, 'downloads'), 'views');
    assert.equal(Logic.nextMetric(twikeep.metrics, 'views'), 'downloads');
    assert.equal(Logic.videosUrl('twikeep', '24h', 'views'), '/api/videos?source=twikeep&period=24h&metric=views');
    assert.equal(Logic.videosUrl('twihozon', '7d', ''), '/api/videos?source=twihozon&period=7d');
});
