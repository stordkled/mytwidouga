const test = require('node:test');
const assert = require('node:assert/strict');
const Logic = require('../src/feed-logic');
const { finalizeVideos } = require('../lib/video');
const twihozon = require('../sources/twihozon');

// Same card shape as the live board (test/fixtures/twihozon-top.html).
function card(id, views, saves) {
    return `<div class="item"><div class="thumb"><a href="/play-${id}-video.html"><img src="https://pbs.twimg.com/ext_tw_video_thumb/${id}/pu/img/a.jpg"></a></div>`
        + `<div class="text"><p class="title">video ${id}</p><div class="count"><p class="view-count"><span>${views}</span>件の表示</p>`
        + `<p class="favorite-count"><img src="/images/index/h.png" alt="">&nbsp;<span>${saves}</span></p></div>`
        + `<div class="info"><p class="author"><a href="/author-1.html">someone</a></p><p class="date">2025-04-24</p></div></div>`
        + `<div><a class="dl-link" href="/play-${id}-video.html">動画を保存する</a></div></div>`;
}

test('Twihozon keeps unit counts ("1.2K", "1万") through to the shuffle weights', () => {
    const html = `<html><body>${card(1, '50', '1.2K')}${card(2, '50', '1万')}${card(3, '12,345', '7')}${card(4, '2.5万', '0')}</body></html>`;
    const videos = finalizeVideos(twihozon.parseListing(html));
    assert.deepEqual(videos.map((video) => video.stats && video.stats.saves), [1200, 10000, 7, 0]);
    assert.deepEqual(videos.map((video) => video.stats && video.stats.views), [50, 50, 12345, 25000]);
    assert.equal(videos[0].views, '50 回表示 · 1,200 保存');
    assert.equal(videos[1].views, '50 回表示 · 10,000 保存');

    const weights = Logic.feedWeights(videos.slice(0, 2));
    assert.ok(weights[1] > weights[0], `1万 outweighs 1.2K: ${weights}`);
});
