// Swipe / Shift+←→ source switching, the bottom ブクマ entry and the いいね一覧
// 一覧 / ランダム再生 modes (logic in src/feed-logic.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Logic = require('../src/feed-logic');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

// Shaped like /api/sources: TwiKeep / Twihozon are disabled, twivideo is
// hidden in config.
const SOURCES = [
    { id: 'pornhub', name: 'Pornhub', enabled: true, hidden: false },
    { id: '85po', name: '85po', enabled: true, hidden: false },
    { id: 'tokyomotion', name: 'TokyoMotion', enabled: true, hidden: false },
    { id: 'twivideo', name: 'TwiVideo', enabled: true, hidden: true },
    { id: 'twikeep', name: 'TwiKeep', enabled: false, hidden: false },
    { id: 'twihozon', name: 'Twihozon', enabled: false, hidden: false },
];

function seq(values) {
    let at = 0;
    return () => values[at++ % values.length];
}

test('stepSource walks the offered sources and loops at both ends', () => {
    const offered = Logic.barSources(SOURCES, 'pornhub');
    assert.deepEqual(offered.map((source) => source.id), ['pornhub', '85po', 'tokyomotion']);
    assert.equal(Logic.stepSource(offered, 'pornhub', 1).id, '85po');
    assert.equal(Logic.stepSource(offered, '85po', 1).id, 'tokyomotion');
    assert.equal(Logic.stepSource(offered, 'tokyomotion', 1).id, 'pornhub', 'loops after the last');
    assert.equal(Logic.stepSource(offered, 'pornhub', -1).id, 'tokyomotion', 'loops before the first');
    assert.equal(Logic.stepSource(offered, 'tokyomotion', -1).id, '85po');
});

test('stepSource never lands on a disabled or hidden source', () => {
    const offered = Logic.barSources(SOURCES, '85po');
    const seen = new Set();
    let id = 'pornhub';
    for (let i = 0; i < 10; i += 1) {
        id = Logic.stepSource(offered, id, 1).id;
        seen.add(id);
    }
    for (const off of ['twikeep', 'twihozon', 'twivideo']) assert.equal(seen.has(off), false, off);
});

test('stepSource edge cases: empty, single, unknown current', () => {
    assert.equal(Logic.stepSource([], 'pornhub', 1), null);
    assert.equal(Logic.stepSource(null, 'pornhub', -1), null);
    const one = [{ id: 'pornhub' }];
    assert.equal(Logic.stepSource(one, 'pornhub', 1), null, 'nothing else to go to');
    assert.equal(Logic.stepSource(one, 'pornhub', 0), null);
    const offered = Logic.barSources(SOURCES, 'pornhub');
    assert.equal(Logic.stepSource(offered, 'gone', 1).id, 'pornhub');
    assert.equal(Logic.stepSource(offered, 'gone', -1).id, 'tokyomotion');
});

test('swipeSourceDirection: clear sideways swipes only', () => {
    assert.equal(Logic.swipeSourceDirection(-120, 10), 'next', 'finger to the left');
    assert.equal(Logic.swipeSourceDirection(120, -10), 'prev', 'finger to the right');
    assert.equal(Logic.swipeSourceDirection(-30, 0), null, 'too short (tap / jitter)');
    assert.equal(Logic.swipeSourceDirection(-100, 80), null, 'too diagonal');
    assert.equal(Logic.swipeSourceDirection(10, -300), null, 'vertical swipe is the next video');
    assert.equal(Logic.swipeSourceDirection(0, 0), null);
    assert.equal(Logic.swipeSourceDirection(NaN, 0), null);
    assert.equal(Logic.swipeSourceDirection(-Logic.SWIPE_MIN_PX, 0), 'next');
    assert.equal(Logic.swipeSourceDirection(-Logic.SWIPE_MIN_PX + 1, 0), null);
});

function entry(sourceId, id, likedAt, playback) {
    return {
        sourceId,
        id,
        title: `${sourceId} ${id}`,
        pageUrl: `https://example.com/${id}`,
        likedAt,
        playback: playback || { kind: 'resolve', url: null, embedUrl: null },
    };
}

test('bookmark order: saved value is picked safely', () => {
    assert.equal(Logic.pickBookmarkOrder('random'), 'random');
    assert.equal(Logic.pickBookmarkOrder('list'), 'list');
    assert.equal(Logic.pickBookmarkOrder(null), 'list');
    assert.equal(Logic.pickBookmarkOrder('{broken'), 'list');
    assert.equal(Logic.DEFAULT_BOOKMARK_ORDER, 'list');
});

test('一覧 keeps newest first; ランダム再生 shuffles every source evenly', () => {
    const list = [
        entry('pornhub', 'a', 5),
        entry('85po', 'b', 4),
        entry('twikeep', 'c', 3, { kind: 'file', url: 'https://cdn.example.com/c.mp4' }),
        entry('twihozon', 'd', 2),
        entry('tokyomotion', 'e', 1),
    ];
    const feed = Logic.bookmarkVideos(list);
    const ordered = Logic.orderBookmarkVideos(feed, 'list');
    assert.deepEqual(ordered.map((video) => video.id), ['a', 'b', 'c', 'd', 'e']);

    const shuffled = Logic.orderBookmarkVideos(feed, 'random', seq([0.1, 0.9, 0.4, 0.7]));
    assert.deepEqual(shuffled.map((video) => video.id).sort(), ['a', 'b', 'c', 'd', 'e'], 'every like once');
    assert.notDeepEqual(shuffled.map((video) => video.id), ['a', 'b', 'c', 'd', 'e']);
    assert.ok(shuffled.some((video) => video._sourceId === 'twikeep'), 'disabled source included');
    assert.ok(shuffled.some((video) => video._sourceId === 'twihozon'), 'disabled source included');
    assert.deepEqual(shuffled.map((video) => video.rankLabel), ['1/5', '2/5', '3/5', '4/5', '5/5']);
    assert.ok(shuffled.every((video) => video._bookmark && video.playback), 'same card + ladder input');
    // The input is not modified.
    assert.deepEqual(feed.map((video) => video.id), ['a', 'b', 'c', 'd', 'e']);
    assert.equal(feed[0].rankLabel, '1/5');
});

test('shuffleList is uniform (not the weighted ranking order)', () => {
    const counts = new Map();
    // mulberry32: a small deterministic generator.
    let state = 12345;
    const rng = () => {
        state = (state + 0x6D2B79F5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const runs = 6000;
    for (let i = 0; i < runs; i += 1) {
        const first = Logic.shuffleList(['a', 'b', 'c'], rng)[0];
        counts.set(first, (counts.get(first) || 0) + 1);
    }
    for (const id of ['a', 'b', 'c']) {
        const share = counts.get(id) / runs;
        assert.ok(share > 0.28 && share < 0.39, `${id} first ${share}`);
    }
    assert.deepEqual(Logic.shuffleList([], rng), []);
    assert.deepEqual(Logic.shuffleList(null), []);
    assert.deepEqual(Logic.shuffleList(['x'], () => 0.99), ['x']);
    assert.deepEqual(Logic.shuffleList(['a', 'b'], () => 1).sort(), ['a', 'b'], 'a bad rng never loses items');
});

test('0 likes: both modes are empty (the empty-state message is shown)', () => {
    assert.deepEqual(Logic.orderBookmarkVideos(Logic.bookmarkVideos([]), 'list'), []);
    assert.deepEqual(Logic.orderBookmarkVideos(Logic.bookmarkVideos([]), 'random'), []);
    assert.deepEqual(Logic.orderBookmarkVideos(null, 'random'), []);
});

test('ランダム再生 leaves out likes with nothing to play, the 一覧 keeps them', () => {
    const feed = Logic.bookmarkVideos([
        entry('twikeep', 'dead', 3, { kind: 'file', url: null, embedUrl: null }),
        entry('twihozon', 'ok', 2),
        entry('85po', 'embed', 1, { kind: 'embed', url: null, embedUrl: 'https://85po.com/embed/1/' }),
    ]);
    assert.equal(Logic.bookmarkPlayable(feed[0]), false);
    assert.equal(Logic.bookmarkPlayable(feed[1]), true, 'resolve works for a disabled source');
    assert.equal(Logic.bookmarkPlayable(feed[2]), true);
    assert.equal(Logic.bookmarkPlayable(null), false);
    assert.deepEqual(Logic.orderBookmarkVideos(feed, 'list').map((video) => video.id), ['dead', 'ok', 'embed']);
    const random = Logic.orderBookmarkVideos(feed, 'random', () => 0);
    assert.deepEqual(random.map((video) => video.id).sort(), ['embed', 'ok']);
    assert.deepEqual(random.map((video) => video.rankLabel), ['1/2', '2/2']);
});

test('main.js wires the swipe, Shift+←→, the bottom ブクマ entry and the modes', () => {
    const main = read('src', 'main.js');
    assert.match(main, /const STORAGE_BOOKMARK_ORDER = 'shorts\.bookmarkOrder';/);
    assert.match(main, /Logic\.pickBookmarkOrder\(readSetting\(STORAGE_BOOKMARK_ORDER\)\)/);
    assert.match(main, /writeSetting\(STORAGE_BOOKMARK_ORDER, bookmarkOrder\)/);
    assert.match(main, /Logic\.stepSource\(visibleSources\(\), currentSource\.id, step\)/);
    assert.match(main, /if \(bookmarkMode \|\| !currentSource\) return false;/, 'no source switch in the いいね一覧');
    assert.match(main, /Logic\.swipeSourceDirection\(event\.clientX - start\.x, event\.clientY - start\.y\)/);
    assert.match(main, /selectSource\(source, true\);\s*renderSourceBar\(\);\s*renderPeriodBar\(\);\s*loadVideos\(\);/);
    assert.match(main, /event\.shiftKey && !event\.ctrlKey/);
    assert.match(main, /seekCurrentBy\(event\.key === 'ArrowLeft' \? -Logic\.SEEK_STEP : Logic\.SEEK_STEP\)/, 'plain ←/→ still seek');
    assert.match(main, /bookmark-nav/);
    assert.match(main, /bookmarkNav\.addEventListener\('click', \(\) => openBookmarks\(\)\)/);
    assert.match(main, /ランダム再生/);
    assert.match(main, /Logic\.orderBookmarkVideos\(videos, 'random'\)/);
    assert.match(main, /showToast\(target\.name\)/);
    assert.doesNotMatch(main, /setFallbackNote\(target\.name/, 'the note bar is not used for the switch');
    assert.match(read('index.html'), /id="sourceToast"/);
    assert.match(read('index.html'), /id="sourceBar"/, 'the header switcher stays');
});
