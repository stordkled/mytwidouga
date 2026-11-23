// These adapters stay tested while the shipped config disables them
// (see disabled-sources.test.js).
process.env.SOURCE_ENABLED_TWIKEEP = '1';
process.env.SOURCE_ENABLED_TWIHOZON = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { finalizeVideos } = require('../lib/video');
const { resolvePeriod } = require('../lib/periods');
const { hostAllowed } = require('../lib/proxy');
const twimg = require('../lib/twimg');
const twikeep = require('../sources/twikeep');
const twihozon = require('../sources/twihozon');
const sources = require('../sources');

const FIXTURES = path.join(__dirname, 'fixtures');
const twikeepJson = fs.readFileSync(path.join(FIXTURES, 'twikeep-ranking-downloads-24h.json'), 'utf8');
const twihozonHtml = fs.readFileSync(path.join(FIXTURES, 'twihozon-top.html'), 'utf8');
const twihozonPlayHtml = fs.readFileSync(path.join(FIXTURES, 'twihozon-play-14725.html'), 'utf8');
const twihozonMp4 = 'https://video.twimg.com/amplify_video/1914335359569391616/vid/avc1/1920x1080/6xFkQlYjswjBxEaq.mp4?tag=16';

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

test('twimg helpers only accept the Twitter CDN hosts', () => {
    assert.equal(twimg.videoUrl('https://video.twimg.com/a/b.mp4?tag=1&amp;x=2'), 'https://video.twimg.com/a/b.mp4?tag=1&x=2');
    assert.equal(twimg.videoUrl('https://evil.example/video.twimg.com/a.mp4'), '');
    assert.equal(twimg.videoUrl('https://video.twimg.com.evil.example/a.mp4'), '');
    assert.equal(twimg.thumbUrl('javascript:alert(1)'), '');
    assert.equal(
        twimg.bestVideo('x "https:\\/\\/video.twimg.com\\/v\\/vid\\/avc1\\/320x568\\/a.mp4" https://video.twimg.com/v/vid/avc1/720x1280/b.mp4 https://video.twimg.com/v/pl/list.m3u8'),
        'https://video.twimg.com/v/vid/avc1/720x1280/b.mp4'
    );
    assert.equal(twimg.tweetUrl('user_1', '2119370603694063955'), 'https://x.com/user_1/status/2119370603694063955');
    assert.equal(twimg.tweetUrl('bad name', '2119370603694063955'), 'https://x.com/i/status/2119370603694063955');
    assert.equal(twimg.tweetUrl('user', 'abc'), '');
});

test('twikeep API fixture becomes direct twimg files', () => {
    const videos = finalizeVideos(twikeep.parseRanking(twikeepJson, 'downloads'));
    assert.equal(videos.length, 3, 'duplicate and non-twimg rows are dropped');
    const [first, second, third] = videos;
    assert.equal(first.id, '2119370603694063955');
    assert.equal(first.rank, 1);
    assert.equal(first.title, '@noeronolife69');
    assert.equal(first.author, '@noeronolife69');
    assert.equal(first.views, '3 保存');
    assert.equal(first.playback.kind, 'file');
    assert.equal(first.playback.url, 'https://video.twimg.com/amplify_video/2119367799462055936/vid/avc1/1080x1920/uT3nFE-SvzNjzumb.mp4?tag=29');
    assert.equal(first.playback.referer, null);
    assert.equal(first.thumbUrl, 'https://pbs.twimg.com/amplify_video_thumb/2119367799462055936/img/SQKUvd23_1HP9aPc.jpg');
    assert.equal(first.externalUrl, 'https://x.com/noeronolife69/status/2119370603694063955');
    assert.equal(second.title, 'サンプル');
    assert.equal(second.views, '1,234 保存');
    assert.equal(third.thumbUrl, '', 'a non-twimg thumbnail is dropped');
    assert.equal(third.author, '');
    assert.equal(third.externalUrl, 'https://x.com/i/status/2119000000000000002');

    assert.equal(twikeep.parseRanking(twikeepJson, 'views')[0].views, '3 表示');
    assert.throws(() => twikeep.parseRanking('<html>nope</html>'), /not JSON/);
    assert.throws(() => twikeep.parseRanking('{"ok":false,"error":"bad range"}'), /bad range/);
    assert.deepEqual(twikeep.parseRanking('{"ok":true,"items":[]}'), []);
});

test('twikeep periods map onto range= and default to the downloads metric', async () => {
    assert.deepEqual(twikeep.periods.map((period) => period.id), ['24h', '7d', '30d', '1y']);
    assert.equal(twikeep.currentMetric(), 'downloads');
    assert.equal(
        twikeep.rankingUrl('https://www.twikeep.com', '1y'),
        'https://www.twikeep.com/api/ranking?metric=downloads&range=1y'
    );
    process.env.SOURCE_METRIC_TWIKEEP = 'views';
    try {
        assert.equal(twikeep.currentMetric(), 'views');
    } finally {
        delete process.env.SOURCE_METRIC_TWIKEEP;
    }
    process.env.SOURCE_METRIC_TWIKEEP = 'bogus';
    try {
        assert.equal(twikeep.currentMetric(), 'downloads');
    } finally {
        delete process.env.SOURCE_METRIC_TWIKEEP;
    }

    await withFetch(() => ({ body: twikeepJson, type: 'application/json' }), async (calls) => {
        for (const [periodId, range] of [['24h', '24h'], ['7d', '1w'], ['30d', '1m'], ['1y', '1y']]) {
            const videos = await twikeep.fetchRanking(periodId);
            assert.equal(videos.length, 3);
            const call = calls.at(-1);
            assert.equal(call.url, `https://www.twikeep.com/api/ranking?metric=downloads&range=${range}`);
            assert.match(call.headers.Accept, /application\/json/);
        }
    });

    await withFetch(() => ({ status: 403, body: '<title>Just a moment...</title>' }), async () => {
        await assert.rejects(() => twikeep.fetchRanking('24h'), /block page/);
    });
});

test('twihozon saved top-page HTML yields 20 ordered cards that resolve via their play pages', () => {
    const videos = finalizeVideos(twihozon.parseListing(twihozonHtml));
    assert.deepEqual(videos.map((video) => video.id), [
        '14725', '14721', '14718', '14716', '14720', '14722', '14727', '14717', '14723', '14724',
        '14719', '14728', '14663', '14726', '14729', '14715', '14712', '14714', '14713', '14711',
    ]);
    for (const [index, video] of videos.entries()) {
        assert.equal(video.rank, index + 1);
        assert.equal(video.pageUrl, `https://www.twihozon.org/play-${video.id}-video.html`);
        assert.equal(video.externalUrl, video.pageUrl);
        assert.equal(new URL(video.thumbUrl).hostname, 'pbs.twimg.com');
        assert.equal(video.playback.kind, 'resolve', `${video.id} has no card-local MP4 in the saved HTML`);
        assert.equal(video.playback.url, null);
    }
    const [first, second] = videos;

    assert.equal(first.thumbUrl, 'https://pbs.twimg.com/amplify_video_thumb/1914335359569391616/img/ACBmSW29d8cll4cG.jpg');
    assert.equal(first.author, '夜雨声烦');
    assert.equal(first.title, '夜雨声烦 (@992ultra) の動画', 'a bare t.co link is not a title; the tweet has no other text');
    assert.equal(first.views, '235,086 回表示 · 3,900 保存');

    assert.equal(second.thumbUrl, 'https://pbs.twimg.com/amplify_video_thumb/1913595915182776320/img/8jZNkdvjivuzYoE9.jpg');
    assert.equal(second.title, '夜雨声烦 (@992ultra) の動画');
    // Cards cut the tweet text at ~50 chars ("…知りた..."); the page's
    // userinfo record has the whole text.
    assert.equal(videos[16].id, '14712');
    assert.equal(videos[16].title, 'RT @linguisticszx: 広末さん逮捕と生活保護窓口の闇を知りたい?');
    assert.equal(videos[18].id, '14713');
    assert.equal(videos[18].title, 'RT @linguisticszx: 配信活動終了より動画の続き気になる人はリプ?');
    assert.equal(videos[17].title, 'RT @linguisticszx: Mood', 'an untruncated card title is kept');
    const fallbackTitles = videos.filter((video) => / の動画$/.test(video.title));
    assert.equal(fallbackTitles.length, 15, 'only the 15 tweets that are just a t.co link have no text');
    assert.equal(second.views, '284,571 回表示 · 2,544 保存', 'the preceding t.co suffix 8 must not join the count');
    assert.equal(videos[5].views, '162,794 回表示 · 1,463 保存', 'the preceding t.co suffix 2 must not join the count');

    const last = videos.at(-1);
    assert.equal(last.author, 'Aprilia');
    assert.equal(last.title, 'RT @wendy791: Mood');
    assert.equal(last.views, '25,625 回表示 · 0 保存');
    assert.equal(last.thumbUrl, 'https://pbs.twimg.com/amplify_video_thumb/1914568152048132100/img/Bqw8_F8aHOYKWfPh.jpg');
});

test('twihozon saved play-page HTML resolves to a direct Twitter CDN MP4', () => {
    assert.equal(twihozon.parsePlayPage(twihozonPlayHtml), twihozonMp4);
});

test('twihozon synthetic minified cards keep view counts separate from neighbouring text', () => {
    const html = fs.readFileSync(path.join(FIXTURES, 'twihozon-top-minified.html'), 'utf8');
    const videos = twihozon.parseListing(html);
    assert.deepEqual(videos.map((video) => video.id), ['14721', '14722']);
    const [first, second] = videos;
    assert.equal(first.views, '284,571 回表示 · 2,544 保存', 't.co text ending in 8 must not join the count');
    assert.equal(first.title, '夜雨声烦 の動画');
    assert.equal(second.views, '162,794 回表示 · 1,203 保存', 't.co text ending in 2 must not join the count');
    assert.equal(second.title, 'ねこ2');
    assert.match(first.playback.url, /V14721\.mp4$/);
    assert.match(second.playback.url, /V14722\.mp4$/);
});

test('twihozon falls back to the raw slice when cards share one container', () => {
    const html = `
      <div id="list">
        <a href="/play-1-video.html">動画を保存する</a><span>10件の表示</span>
        <img src="https://pbs.twimg.com/media/one.jpg">
        <source src="https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/480x852/one.mp4">
        <a href="/play-2-video.html">動画を保存する</a><span>20件の表示</span>
        <img src="https://pbs.twimg.com/media/two.jpg">
        <source src="https://video.twimg.com/ext_tw_video/2/pu/vid/avc1/480x852/two.mp4">
      </div>`;
    const videos = twihozon.parseListing(html);
    assert.equal(videos.length, 2);
    assert.match(videos[0].playback.url, /one\.mp4$/);
    assert.match(videos[0].thumbUrl, /one\.jpg$/);
    assert.match(videos[1].playback.url, /two\.mp4$/);
    assert.match(videos[1].thumbUrl, /two\.jpg$/);
});

test('twihozon board fetches and playback resolution use saved HTTP response bodies', async () => {
    assert.deepEqual(twihozon.periods.map((period) => period.id), ['24h', '7d', '30d']);
    const pages = new Map([
        ['https://www.twihozon.org/', twihozonHtml],
        ['https://www.twihozon.org/week.html', twihozonHtml],
        ['https://www.twihozon.org/month.html', twihozonHtml],
        ['https://www.twihozon.org/play-14725-video.html', twihozonPlayHtml],
    ]);
    await withFetch((url) => {
        // resolvePlayback probes the MP4 with a one-byte range request.
        if (url === twihozonMp4) return { status: 206, body: 'x', type: 'video/mp4' };
        assert.ok(pages.has(url), `unexpected request: ${url}`);
        return { body: pages.get(url) };
    }, async (calls) => {
        let first;
        for (const [periodId, pathname] of [['24h', '/'], ['7d', '/week.html'], ['30d', '/month.html']]) {
            const videos = await twihozon.fetchRanking(periodId);
            assert.equal(videos.length, 20);
            first = videos[0];
            assert.equal(first.playback.kind, 'resolve');
            assert.equal(calls.at(-1).url, `https://www.twihozon.org${pathname}`);
        }
        const playback = await twihozon.resolvePlayback(first.id);
        assert.deepEqual(playback, { kind: 'file', url: twihozonMp4 });
        assert.equal(calls.at(-2).url, first.pageUrl);
        assert.equal(calls.at(-1).url, twihozonMp4);
        assert.equal(calls.at(-1).headers.Range, 'bytes=0-0');
        assert.equal(calls.at(-1).headers.Referer, undefined, 'probed like the player: no Referer');
        const [video] = finalizeVideos([{ ...first, playback }]);
        assert.equal(video.playback.referer, null, 'resolved MP4 starts on the direct playback step');
        await assert.rejects(() => twihozon.resolvePlayback('../x'), /Invalid/);
        assert.equal(calls.length, 5, 'invalid ids make no HTTP request');
    });
});

test('twihozon userinfo data carries every MP4 variant, the tweet id and the handle', () => {
    const info = twihozon.parseUserInfo(twihozonHtml);
    assert.equal(info.size, 20);
    const record = info.get('14725');
    assert.equal(record.tweetId, '1914339872619610170');
    assert.equal(record.screenName, '992ultra');
    assert.deepEqual(record.variants.map((url) => url.match(/avc1\/(\d+x\d+)/)[1]), [
        '1920x1080', '1280x720', '640x360', '480x270',
    ]);
    assert.equal(info.get('14712').fullText, 'RT @linguisticszx: https://t.co/cg5aO4aLud\n広末さん逮捕と生活保護窓口の闇を知りたい?');
    assert.equal(twihozon.parseUserInfo('<html>no data</html>').size, 0);
    assert.equal(twihozon.parseUserInfo('var userinfo = %7Bbroken%7D;').size, 0);
});

test('twihozon play-page title: the saved page has only a t.co link, real text is kept', () => {
    assert.equal(twihozon.parsePlayTitle(twihozonPlayHtml), '');
    assert.equal(
        twihozon.parsePlayTitle('<title>ねこの日https://t.co/AbCdEf1234動画保存_簡単!｜Twitter動画ダウンローダーTwihozon</title><h1>ねこの日https://t.co/AbCdEf1234動画を簡単に保存</h1>'),
        'ねこの日'
    );
});

// Live check 2026-11-18: video.twimg.com answered 403 for 4 of 4 sampled
// Twihozon MP4s (1080p and 270p of 14725, 14714, 14711) while a TwiKeep
// MP4 from the same CDN downloaded. Resolve must not hand those to the player.
test('twihozon resolve probes variants: skips a dead one, reports all-dead as unavailable', async () => {
    twihozon.parseListing(twihozonHtml); // remembers the board's variants
    const play = 'https://www.twihozon.org/play-14725-video.html';
    const hd = 'https://video.twimg.com/amplify_video/1914335359569391616/vid/avc1/1280x720/RV5c_oRgYmsgErei.mp4?tag=16';

    await withFetch((url) => {
        if (url === play) return { body: twihozonPlayHtml };
        if (url === hd) return { status: 206, body: 'x', type: 'video/mp4' };
        return { status: 403, body: '', type: 'text/plain' };
    }, async (calls) => {
        const playback = await twihozon.resolvePlayback('14725');
        assert.deepEqual(playback, { kind: 'file', url: hd }, 'the 1080p variant is 403, the 720p one plays');
        assert.deepEqual(calls.slice(1).map((call) => call.url), [twihozonMp4, hd]);
    });

    await withFetch((url) => {
        if (url === play) return { body: twihozonPlayHtml };
        return { status: 403, body: '', type: 'text/plain' };
    }, async (calls) => {
        await assert.rejects(() => twihozon.resolvePlayback('14725'), (err) => {
            assert.equal(err.unavailable, true);
            assert.match(err.message, /HTTP 403 for all 4 MP4 variants/);
            return true;
        });
        assert.equal(calls.length, 5, 'play page + four variants, no more');

        const viaRegistry = await sources.resolvePlayback('twihozon', '14725', { fresh: true });
        assert.equal(viaRegistry.ok, false);
        assert.equal(viaRegistry.unavailable, true, 'the client skips instead of waiting at readyState 0');
        assert.equal(viaRegistry.playback, null);
    });

    await withFetch((url) => {
        if (url === play) return { body: twihozonPlayHtml };
        throw new TypeError('fetch failed');
    }, async () => {
        const playback = await twihozon.resolvePlayback('14725');
        assert.deepEqual(playback, { kind: 'file', url: twihozonMp4 }, 'an unreachable CDN is not proof the media is gone');
    });

    await withFetch((url) => {
        if (url === 'https://www.twihozon.org/play-777-video.html') return { body: '<html><h1>x</h1></html>' };
        throw new Error(`unexpected ${url}`);
    }, async () => {
        await assert.rejects(() => twihozon.resolvePlayback('777'), (err) => err.unavailable === true);
    });
});

test('both Twitter sources are in the switcher, proxy only to twimg, and fall back by period', () => {
    const list = sources.list();
    for (const id of ['twikeep', 'twihozon']) {
        const entry = list.find((source) => source.id === id);
        assert.ok(entry, `${id} is registered`);
        assert.equal(entry.hidden, false);
        const view = sources.proxyView(id);
        assert.equal(hostAllowed('video.twimg.com', view.mediaHosts), true);
        assert.equal(hostAllowed('pbs.twimg.com', view.mediaHosts), true);
    }
    assert.equal(resolvePeriod(twikeep.periods, 'year').period.id, '1y');
    const noYear = resolvePeriod(twihozon.periods, '1y');
    assert.equal(noYear.fallback, true);
    assert.equal(noYear.period.id, '30d');
    assert.equal(resolvePeriod(twihozon.periods, '3d').period.id, '7d');
});
