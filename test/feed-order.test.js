const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Logic = require('../src/feed-logic');
const { finalizeVideos } = require('../lib/video');
const twikeep = require('../sources/twikeep');

// Deterministic PRNG (mulberry32) so the statistical tests are repeatable.
function seeded(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function board(count, extra = () => ({})) {
    return Array.from({ length: count }, (_, index) => ({
        id: `v${index + 1}`,
        rank: index + 1,
        views: '',
        _sourceId: 'twikeep',
        ...extra(index),
    }));
}

test('parseCount reads 1.2K, 12,345, 1万 and friends', () => {
    assert.equal(Logic.parseCount('1.2K'), 1200);
    assert.equal(Logic.parseCount('12,345'), 12345);
    assert.equal(Logic.parseCount('1万'), 10000);
    assert.equal(Logic.parseCount('1.5万回再生'), 15000);
    assert.equal(Logic.parseCount('3.4M views'), 3400000);
    assert.equal(Logic.parseCount('2億'), 200000000);
    assert.equal(Logic.parseCount('１２３ 保存'), 123, 'full-width digits');
    assert.equal(Logic.parseCount('1,234 保存'), 1234);
    assert.equal(Logic.parseCount('12 min'), 12, 'a word starting with m is not a unit');
    assert.equal(Logic.parseCount(42), 42);
    assert.equal(Logic.parseCount(''), null);
    assert.equal(Logic.parseCount('なし'), null);
    assert.equal(Logic.parseCount(null), null);
    assert.equal(Logic.parseCount(-1), null);
    assert.equal(Logic.parseCount(NaN), null);
});

test('popularityOf prefers structured stats and reads the display text', () => {
    assert.deepEqual(Logic.popularityOf({ stats: { saves: 5 }, views: '9 回表示' }), { saves: 5, likes: null, views: 9 });
    assert.deepEqual(Logic.popularityOf({ views: '1,234 回表示 · 56 保存' }), { saves: 56, likes: null, views: 1234 });
    assert.deepEqual(Logic.popularityOf({ views: '1.2K いいね' }), { saves: null, likes: 1200, views: null });
    assert.deepEqual(Logic.popularityOf({ views: '3.4M views' }), { saves: null, likes: null, views: 3400000 });
    assert.deepEqual(Logic.popularityOf({ views: '' }), { saves: null, likes: null, views: null });
    assert.deepEqual(Logic.popularityOf(null), { saves: null, likes: null, views: null });
});

test('weights use saves > likes > views > rank, log-compressed with a floor', () => {
    const list = [
        { id: 'a', rank: 1, stats: { saves: 10, views: 1000000 } },
        { id: 'b', rank: 2, stats: { saves: 100000, views: 1 } },
        { id: 'c', rank: 3, views: '5 いいね' },
    ];
    const weights = Logic.feedWeights(list);
    assert.ok(weights[1] > weights[0], 'saves decide, not views');
    assert.equal(weights[1], 1, 'the top count has weight 1');
    assert.equal(weights[2], Logic.MIN_WEIGHT, 'no saves -> the floor, still > 0');
    assert.ok(weights[0] > Logic.MIN_WEIGHT * 1.5, 'log compression keeps a 10-save video in play');

    const likesOnly = Logic.feedWeights([{ id: 'a', views: '10 いいね · 1万 回表示' }, { id: 'b', views: '1000 いいね · 1 回表示' }]);
    assert.ok(likesOnly[1] > likesOnly[0], 'likes beat views');

    const viewsOnly = Logic.feedWeights([{ id: 'a', views: '1.2K' }, { id: 'b', views: '12,345' }, { id: 'c', views: '1万' }]);
    assert.ok(viewsOnly[1] > viewsOnly[2] && viewsOnly[2] > viewsOnly[0]);

    const ranked = Logic.feedWeights(board(24));
    assert.equal(ranked.length, 24);
    for (let i = 1; i < ranked.length; i += 1) assert.ok(ranked[i] < ranked[i - 1], 'higher rank, higher weight');
    assert.ok(ranked[23] >= Logic.MIN_WEIGHT && ranked[23] > 0);
    assert.ok(ranked[0] / ranked[23] < 6, 'the spread is bounded');

    const zeros = Logic.feedWeights(board(3, () => ({ stats: { saves: 0 } })));
    assert.ok(zeros[0] > zeros[2], 'all-zero counts fall back to rank');
    assert.deepEqual(Logic.feedWeights([]), []);
});

test('weightedShuffle keeps every item exactly once and uses the injected rng', () => {
    const items = board(24);
    const weights = Logic.feedWeights(items);
    for (let seed = 1; seed <= 50; seed += 1) {
        const out = Logic.weightedShuffle(items, weights, seeded(seed));
        assert.equal(out.length, items.length);
        assert.equal(new Set(out.map((video) => video.id)).size, items.length, 'no repeats');
        assert.deepEqual(out.map((video) => video.id).sort(), items.map((video) => video.id).sort(), 'nothing lost');
    }
    const a = Logic.weightedShuffle(items, weights, seeded(7)).map((video) => video.id);
    const b = Logic.weightedShuffle(items, weights, seeded(7)).map((video) => video.id);
    const c = Logic.weightedShuffle(items, weights, seeded(8)).map((video) => video.id);
    assert.deepEqual(a, b, 'same rng, same order');
    assert.notDeepEqual(a, c, 'another rng, another order');
    // A broken rng (0, 1, NaN) still returns a full list.
    for (const value of [0, 1, NaN]) {
        assert.equal(Logic.weightedShuffle(items, weights, () => value).length, items.length);
    }
});

test('popular videos come first more often, but low ones still appear early', () => {
    const items = board(20, (index) => ({ stats: { saves: index === 0 ? 50000 : (index < 5 ? 2000 : 3) } }));
    const rng = seeded(12345);
    const runs = 4000;
    const firstCount = new Map();
    const position = new Array(items.length).fill(0);
    let bottomInTopFive = 0;
    for (let run = 0; run < runs; run += 1) {
        const out = Logic.orderFeed(items, 'random', { rng });
        firstCount.set(out[0].id, (firstCount.get(out[0].id) || 0) + 1);
        out.forEach((video, at) => { position[Number(video.id.slice(1)) - 1] += at; });
        if (out.slice(0, 5).some((video) => Number(video.id.slice(1)) > 5)) bottomInTopFive += 1;
    }
    const avg = position.map((sum) => sum / runs);
    assert.ok(avg[0] < avg[10], 'the most saved video averages earlier than a low one');
    assert.ok(avg[1] < avg[15]);
    const topFirst = firstCount.get('v1') || 0;
    const lowFirst = firstCount.get('v20') || 0;
    assert.ok(topFirst > lowFirst * 2, `v1 first ${topFirst} times vs v20 ${lowFirst}`);
    assert.ok(topFirst < runs * 0.5, 'not always the same opener');
    assert.ok(bottomInTopFive > runs * 0.3, 'low videos still reach the top five');
});

test('without any numbers the board rank drives the shuffle', () => {
    const items = board(24);
    const rng = seeded(99);
    const runs = 3000;
    const position = new Array(items.length).fill(0);
    for (let run = 0; run < runs; run += 1) {
        Logic.orderFeed(items, 'random', { rng }).forEach((video, at) => { position[video.rank - 1] += at; });
    }
    const avg = position.map((sum) => sum / runs);
    assert.ok(avg[0] < avg[11] && avg[11] < avg[23], `No.1 ${avg[0].toFixed(1)}, No.12 ${avg[11].toFixed(1)}, No.24 ${avg[23].toFixed(1)}`);
});

test('orderFeed: ranking order is untouched, duplicates are dropped either way', () => {
    const items = board(5);
    const doubled = [...items, { ...items[2] }, { id: '', rank: 9 }, null];
    assert.deepEqual(Logic.orderFeed(doubled, 'ranking').map((video) => video.id), ['v1', 'v2', 'v3', 'v4', 'v5']);
    const shuffled = Logic.orderFeed(doubled, 'random', { rng: seeded(3) });
    assert.equal(shuffled.length, 5);
    assert.equal(new Set(shuffled.map((video) => video.id)).size, 5);
    assert.equal(Logic.orderFeed(items, 'bogus', { rng: seeded(3) }).length, 5, 'unknown order = random');
    // The same id from another source is a different video.
    const mixed = [{ id: '1', _sourceId: 'a' }, { id: '1', _sourceId: 'b' }];
    assert.equal(Logic.orderFeed(mixed, 'ranking').length, 2);
});

test('appendFeed orders the next page the same way and skips what is already shown', () => {
    const first = Logic.orderFeed(board(10), 'random', { rng: seeded(1) });
    const page2 = board(15).slice(5); // v6..v15, v6..v10 already shown
    const all = Logic.appendFeed(first, page2, 'random', { rng: seeded(2) });
    assert.deepEqual(all.slice(0, 10), first, 'what was shown stays in place');
    assert.equal(all.length, 15);
    assert.equal(new Set(all.map((video) => video.id)).size, 15, 'no repeats');
    assert.deepEqual(all.slice(10).map((video) => video.id).sort(), ['v11', 'v12', 'v13', 'v14', 'v15']);
    const ranked = Logic.appendFeed(board(3), board(5), 'ranking');
    assert.deepEqual(ranked.map((video) => video.id), ['v1', 'v2', 'v3', 'v4', 'v5']);
});

test('feed order setting: random by default, toggles, junk falls back', () => {
    assert.equal(Logic.DEFAULT_FEED_ORDER, 'random');
    assert.equal(Logic.pickFeedOrder(null), 'random');
    assert.equal(Logic.pickFeedOrder('ranking'), 'ranking');
    assert.equal(Logic.pickFeedOrder('nonsense'), 'random');
    assert.equal(Logic.nextFeedOrder('random'), 'ranking');
    assert.equal(Logic.nextFeedOrder('ranking'), 'random');
});

test('the server passes popularity stats through; TwiKeep reports saves or views', () => {
    const item = (id, count) => ({
        mediaKey: id,
        tweetId: '1',
        bestVideoUrl: `https://video.twimg.com/ext_tw_video/${id}.mp4`,
        thumbnailUrl: `https://pbs.twimg.com/${id}.jpg`,
        count,
        userName: 'someone',
    });
    const body = JSON.stringify({ ok: true, items: [item('a1', 1234), item('b2', null)] });
    const saves = finalizeVideos(twikeep.parseRanking(body, 'downloads'));
    assert.deepEqual(saves[0].stats, { saves: 1234 });
    assert.equal(saves[1].stats, undefined, 'no count, no stats');
    const views = finalizeVideos(twikeep.parseRanking(body, 'views'));
    assert.deepEqual(views[0].stats, { views: 1234 });

    const cleaned = finalizeVideos([{ id: 'x', playback: { kind: 'file', url: 'u' }, stats: { saves: '1,200', likes: -1, views: 'abc' } }]);
    assert.deepEqual(cleaned[0].stats, { saves: 1200 });
    const units = finalizeVideos([{ id: 'y', playback: { kind: 'file', url: 'u' }, stats: { saves: '1.2K', likes: '1万', views: '12,345' } }]);
    assert.deepEqual(units[0].stats, { saves: 1200, likes: 10000, views: 12345 });
});

test('TwiKeep count text (1.2K, 1万, 12,345) reaches the weights end to end', () => {
    const item = (id, count) => ({
        mediaKey: id,
        tweetId: '1',
        bestVideoUrl: `https://video.twimg.com/ext_tw_video/${id}.mp4`,
        thumbnailUrl: `https://pbs.twimg.com/${id}.jpg`,
        count,
        userName: 'someone',
    });
    const body = JSON.stringify({ ok: true, items: [item('k1', '1.2K'), item('m1', '1万'), item('c1', '12,345'), item('z1', 'n/a')] });
    const videos = finalizeVideos(twikeep.parseRanking(body, 'downloads'));
    assert.deepEqual(videos.map((video) => video.stats && video.stats.saves), [1200, 10000, 12345, undefined]);
    assert.equal(videos[0].views, '1,200 保存');
    assert.equal(videos[1].views, '10,000 保存');
    assert.equal(videos[3].views, '', 'unreadable count, no label');

    // Two boards of 1.2K vs 1万 saves: the 1万 one (ranked 2nd) leads more
    // often, because the saves decide and not the board rank.
    const pair = finalizeVideos(twikeep.parseRanking(JSON.stringify({ ok: true, items: [item('k1', '1.2K'), item('m1', '1万')] }), 'downloads'));
    const rng = seeded(2024);
    let manFirst = 0;
    const runs = 4000;
    for (let run = 0; run < runs; run += 1) {
        if (Logic.orderFeed(pair, 'random', { rng })[0].id === 'm1') manFirst += 1;
    }
    assert.ok(manFirst > runs * 0.5, `1万 first ${manFirst}/${runs}`);
});

test('the server pages a board for the infinite scroll', () => {
    const sources = require('../lib/video');
    const all = board(60);
    const result = { ok: true, videos: all, period: { id: '24h' } };
    const first = sources.pageRanking(result, null);
    assert.equal(first.page, 1);
    assert.deepEqual(first.videos.map((video) => video.id), all.slice(0, sources.PAGE_SIZE).map((video) => video.id), 'page 1 is what /api/videos returned before');
    assert.equal(first.hasMore, true);
    const second = sources.pageRanking(result, '2');
    assert.equal(second.videos[0].rank, sources.PAGE_SIZE + 1, 'ranks continue on the next page');
    assert.equal(second.hasMore, true);
    const third = sources.pageRanking(result, '3');
    assert.equal(third.videos.length, 60 - 2 * sources.PAGE_SIZE);
    assert.equal(third.hasMore, false);
    assert.equal(sources.pageRanking(result, '9').videos.length, 0);
    assert.equal(sources.pageRanking(result, 'junk').page, 1);
    assert.equal(sources.pageRanking({ ok: false, videos: [] }, '2').hasMore, false);
    assert.ok(sources.RANKING_MAX > sources.PAGE_SIZE);

    assert.equal(Logic.videosUrl('twikeep', '24h', 'views', 2), '/api/videos?source=twikeep&period=24h&metric=views&page=2');
    assert.equal(Logic.videosUrl('twikeep', '24h', 'views', 1), '/api/videos?source=twikeep&period=24h&metric=views');
    assert.equal(Logic.shouldLoadMore({ index: 21, total: 24, hasMore: true, loading: false }), true);
    assert.equal(Logic.shouldLoadMore({ index: 10, total: 24, hasMore: true, loading: false }), false);
    assert.equal(Logic.shouldLoadMore({ index: 23, total: 24, hasMore: false, loading: false }), false);
    assert.equal(Logic.shouldLoadMore({ index: 23, total: 24, hasMore: true, loading: true }), false);

    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(server, /sources\.pageRanking\(board, url\.searchParams\.get\('page'\)\)/);
});

test('main.js appends the next page through appendFeed', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    assert.match(main, /videos = Logic\.appendFeed\(videos, pageVideos, feedOrder\)/);
    assert.match(main, /Logic\.videosUrl\(source\.id, currentPeriod, currentMetric, page\)/);
    assert.match(main, /playCard\(index\);\s*maybeLoadMore\(index\);/, 'the scroll observer asks for more');
    assert.match(main, /rankingHasMore = Boolean\(data\.hasMore\)/);
});

test('main.js shuffles rankings only, keeps bookmarks newest first and saves the toggle', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    assert.match(main, /const STORAGE_ORDER = 'shorts\.order';/);
    assert.match(main, /Logic\.pickFeedOrder\(readSetting\(STORAGE_ORDER\)\)/);
    assert.match(main, /writeSetting\(STORAGE_ORDER, feedOrder\)/);
    assert.match(main, /videos = Logic\.orderFeed\(rankingVideos, /);
    assert.match(main, /videos = Logic\.bookmarkVideos\(bookmarks\);/, 'the いいね一覧 is not shuffled');
    assert.match(main, /const PLAYBACK_LADDER = \['direct', 'playlist-proxy', 'proxy', 'embed'\];/);
});
