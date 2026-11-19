// いいね一覧 (bookmarks): storage, toggle and limit logic in src/feed-logic.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Logic = require('../src/feed-logic');

const KEY = 'shorts.bookmarks';

function memoryStorage(initial = {}) {
    const data = new Map(Object.entries(initial));
    return {
        data,
        getItem: (key) => (data.has(key) ? data.get(key) : null),
        setItem: (key, value) => { data.set(key, String(value)); },
        removeItem: (key) => { data.delete(key); },
    };
}

function video(id, extra = {}) {
    return {
        id,
        title: `動画 ${id}`,
        rank: 1,
        rankLabel: 'No.1',
        pageUrl: `https://example.com/watch/${id}`,
        thumbUrl: `https://cdn.example.com/${id}.jpg`,
        duration: '0:30',
        views: '10K',
        externalUrl: `https://example.com/watch/${id}`,
        lookup: false,
        playback: { kind: 'file', url: `https://cdn.example.com/${id}.mp4`, embedUrl: null, referer: null },
        _sourceId: 'twikeep',
        ...extra,
    };
}

test('a liked video is stored with what the list and the playback ladder need', () => {
    const entry = Logic.bookmarkFromVideo(video('1', {
        playback: { kind: 'resolve', url: null, embedUrl: 'https://85po.com/embed/1/', referer: null },
    }), '85po', 1000);
    assert.deepEqual(entry, {
        sourceId: '85po',
        id: '1',
        pageUrl: 'https://example.com/watch/1',
        externalUrl: 'https://example.com/watch/1',
        title: '動画 1',
        thumbUrl: 'https://cdn.example.com/1.jpg',
        duration: '0:30',
        lookup: false,
        likedAt: 1000,
        playback: { kind: 'resolve', url: null, embedUrl: 'https://85po.com/embed/1/' },
    });
    assert.equal(Logic.bookmarkFromVideo(video('2', { playback: { kind: 'bogus' } }), 'twikeep', 1), null);
    assert.equal(Logic.bookmarkFromVideo(video(''), 'twikeep', 1), null);
    assert.equal(Logic.bookmarkFromVideo(video('3'), '', 1), null);

    // Back in the feed it is a normal card video with its own source.
    const [back] = Logic.bookmarkVideos([entry]);
    assert.equal(back._sourceId, '85po');
    assert.equal(back._bookmark, true);
    assert.equal(back.id, '1');
    assert.deepEqual(back.playback, entry.playback);
    assert.equal(Logic.resolveUrl(back._sourceId, back.id, false), '/api/resolve?source=85po&id=1');
});

test('toggle likes, unlikes, and keys by source + id', () => {
    let list = [];
    let result = Logic.toggleBookmark(list, video('a'), 'twikeep', 1);
    assert.equal(result.liked, true);
    list = result.list;
    assert.equal(Logic.isBookmarked(list, 'twikeep', 'a'), true);
    assert.equal(Logic.isBookmarked(list, '85po', 'a'), false, 'same id on another site is another video');

    result = Logic.toggleBookmark(list, video('a'), '85po', 2);
    list = result.list;
    assert.equal(list.length, 2);
    assert.equal(list[0].sourceId, '85po', 'newest first');

    result = Logic.toggleBookmark(list, video('a'), 'twikeep', 3);
    assert.equal(result.liked, false);
    list = result.list;
    assert.deepEqual(list.map((entry) => `${entry.sourceId}/${entry.id}`), ['85po/a']);

    // Adding twice (double tap) does not duplicate.
    assert.equal(Logic.addBookmark(list, video('a'), '85po', 9).length, 1);
    assert.equal(Logic.removeBookmark(list, '85po', 'a').length, 0);
});

test('the list keeps at most BOOKMARK_LIMIT entries and drops the oldest', () => {
    assert.equal(Logic.BOOKMARK_LIMIT, 500);
    let list = [];
    for (let i = 0; i < Logic.BOOKMARK_LIMIT + 5; i += 1) {
        list = Logic.toggleBookmark(list, video(String(i)), 'twikeep', 1000 + i).list;
    }
    assert.equal(list.length, Logic.BOOKMARK_LIMIT);
    assert.equal(list[0].id, String(Logic.BOOKMARK_LIMIT + 4), 'newest kept');
    assert.equal(Logic.isBookmarked(list, 'twikeep', '0'), false, 'oldest dropped');
    assert.equal(Logic.isBookmarked(list, 'twikeep', '5'), true);

    const small = Logic.addBookmark(Logic.addBookmark([], video('x'), 's', 1, 2), video('y'), 's', 2, 2);
    assert.deepEqual(Logic.addBookmark(small, video('z'), 's', 3, 2).map((entry) => entry.id), ['z', 'y']);
});

test('save and load round-trip, newest first', () => {
    const storage = memoryStorage();
    let list = Logic.toggleBookmark([], video('old'), 'twikeep', 100).list;
    list = Logic.toggleBookmark(list, video('new'), 'tokyomotion', 200).list;
    const saved = Logic.saveBookmarks(storage, KEY, list);
    assert.equal(saved.ok, true);
    assert.equal(saved.trimmed, 0);
    const loaded = Logic.loadBookmarks(storage, KEY);
    assert.deepEqual(loaded, list);
    assert.deepEqual(Logic.bookmarkVideos(loaded).map((item) => item.id), ['new', 'old']);
    assert.deepEqual(Logic.bookmarkVideos(loaded).map((item) => item.rankLabel), ['1/2', '2/2']);
});

test('a corrupt, foreign or unreadable value loads as an empty (or cleaned) list', () => {
    assert.deepEqual(Logic.loadBookmarks(memoryStorage(), KEY), []);
    assert.deepEqual(Logic.loadBookmarks(memoryStorage({ [KEY]: '{not json' }), KEY), []);
    assert.deepEqual(Logic.loadBookmarks(memoryStorage({ [KEY]: '{"a":1}' }), KEY), []);
    assert.deepEqual(Logic.loadBookmarks(memoryStorage({ [KEY]: 'null' }), KEY), []);
    assert.deepEqual(Logic.loadBookmarks(null, KEY), []);
    const throwing = { getItem() { throw new Error('SecurityError'); } };
    assert.deepEqual(Logic.loadBookmarks(throwing, KEY), []);

    const good = Logic.bookmarkFromVideo(video('ok'), 'twikeep', 5);
    const mixed = JSON.stringify([
        null,
        42,
        { sourceId: 'twikeep' },
        { sourceId: 'twikeep', id: 'x', playback: { kind: 'evil' } },
        good,
        { ...good, likedAt: 1 },
    ]);
    const loaded = Logic.loadBookmarks(memoryStorage({ [KEY]: mixed }), KEY);
    assert.equal(loaded.length, 1, 'bad rows and duplicates are dropped');
    assert.equal(loaded[0].id, 'ok');
    assert.equal(loaded[0].likedAt, 5);

    const tooMany = Array.from({ length: 520 }, (_, i) => Logic.bookmarkFromVideo(video(String(i)), 'twikeep', i));
    assert.equal(Logic.loadBookmarks(memoryStorage({ [KEY]: JSON.stringify(tooMany) }), KEY).length, Logic.BOOKMARK_LIMIT);
});

test('a full localStorage trims the oldest likes instead of throwing', () => {
    let list = [];
    for (let i = 0; i < 8; i += 1) list = Logic.toggleBookmark(list, video(String(i)), 'twikeep', i).list;
    const storage = memoryStorage();
    const realSet = storage.setItem;
    storage.setItem = (key, value) => {
        if (JSON.parse(value).length > 2) {
            const error = new Error('quota');
            error.name = 'QuotaExceededError';
            throw error;
        }
        realSet(key, value);
    };
    const result = Logic.saveBookmarks(storage, KEY, list);
    assert.equal(result.ok, true);
    assert.deepEqual(result.saved.map((entry) => entry.id), ['7', '6'], 'the newest likes survive');
    assert.equal(result.trimmed, 6);
    assert.equal(Logic.loadBookmarks(storage, KEY).length, 2);

    const broken = { setItem() { throw new Error('disabled'); } };
    const failed = Logic.saveBookmarks(broken, KEY, list);
    assert.equal(failed.ok, false);
    assert.equal(failed.saved.length, 8, 'kept in memory for this page');
    assert.equal(Logic.saveBookmarks(null, KEY, list).ok, false);
});

test('main.js wires likes to localStorage and keeps the ranking order and ladder', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    assert.match(main, /const STORAGE_BOOKMARKS = 'shorts\.bookmarks';/);
    assert.match(main, /Logic\.toggleBookmark\(/);
    assert.match(main, /Logic\.saveBookmarks\(bookmarkStorage\(\), STORAGE_BOOKMARKS, bookmarks\)/);
    assert.match(main, /まだいいねした動画はありません/);
    assert.match(main, /ランキングに戻る/);
    assert.doesNotMatch(main, /button\.classList\.toggle\('liked'\)/, 'the like is no longer DOM-only');
    assert.match(main, /const PLAYBACK_LADDER = \['direct', 'playlist-proxy', 'proxy', 'embed'\];/);
    assert.match(main, /selectSource\(Logic\.initialSource\(visibleSources\(\), saved\), false\)/);
});
