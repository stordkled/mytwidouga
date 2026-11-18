const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePeriod } = require('../lib/periods');
const { rewritePlaylist, hostAllowed, isPublicHttpUrl } = require('../lib/proxy');
const { finalizeVideos } = require('../lib/video');
const pornhub = require('../sources/pornhub');
const po85 = require('../sources/85po');
const tokyomotion = require('../sources/tokyomotion');
const missav = require('../sources/missav');
const twivideo = require('../sources/twivideo');
const sources = require('../sources');

test('period fallback maps a missing 3-day board onto the weekly one', () => {
    const periods = [
        { id: '24h', label: '24時間' },
        { id: '7d', label: '1週間' },
        { id: '30d', label: '1ヶ月' },
    ];
    const exact = resolvePeriod(periods, 'week');
    assert.equal(exact.fallback, false);
    assert.equal(exact.period.id, '7d');

    const missing = resolvePeriod(periods, '3days');
    assert.equal(missing.fallback, true);
    assert.equal(missing.period.id, '7d');
    assert.match(missing.fallbackReason, /3日間/);
    assert.match(missing.fallbackReason, /1週間/);
});

test('playlist rewrite keeps variant and key URIs on the proxy', () => {
    const body = [
        '#EXTM3U',
        '#EXT-X-KEY:METHOD=AES-128,URI="key.key"',
        '#EXT-X-STREAM-INF:BANDWIDTH=1000',
        'index.m3u8?token=a',
        'https://cdn.example/seg-1.ts',
    ].join('\n');
    const rewritten = rewritePlaylist(body, 'https://cdn.example/hls/master.m3u8?token=a', 'missav');
    assert.match(rewritten, /URI="\/proxy\/media\?source=missav&url=[^"]+key\.key"/);
    assert.match(rewritten, /source=missav&url=[^\n]*index\.m3u8/);
    assert.match(rewritten, /source=missav&url=[^\n]*seg-1\.ts/);
    assert.doesNotMatch(rewritten, /^index\.m3u8/m);
});

test('proxy allowlist is per host suffix and rejects private targets', () => {
    assert.equal(hostAllowed('ev-h.phncdn.com', ['phncdn.com']), true);
    assert.equal(hostAllowed('evilphncdn.com', ['phncdn.com']), false);
    assert.equal(hostAllowed('www42.tokyomotion.net', ['tokyomotion.net']), true);
    assert.equal(isPublicHttpUrl('https://surrit.com/a/playlist.m3u8'), true);
    assert.equal(isPublicHttpUrl('http://127.0.0.1/secret'), false);
    assert.equal(isPublicHttpUrl('http://169.254.169.254/latest'), false);
    assert.equal(isPublicHttpUrl('file:///etc/passwd'), false);
});

test('twivideo cards become direct files', () => {
    const html = `
      <div class="art_li">
        <a class="item_link" data-id="99" href="https://video.twimg.com/ext_tw_video/1.mp4">
          <img src="https://pbs.twimg.com/ext_tw_video_thumb/1.jpg">
        </a>
        <span class="item_ranking">No.1</span>
      </div>`;
    const videos = finalizeVideos(twivideo.parseListing(html));
    assert.equal(videos.length, 1);
    assert.equal(videos[0].id, '99');
    assert.equal(videos[0].playback.kind, 'file');
    assert.equal(videos[0].playback.url, 'https://video.twimg.com/ext_tw_video/1.mp4');
    assert.equal(videos[0].lookup, true);
    assert.equal(videos[0].rankLabel, 'No.1');
});

test('pornhub listing parser and safe-for-work guard', () => {
    const html = `
      <li class="pcVideoListItem" data-video-vkey="abc123">
        <a href="/view_video.php?viewkey=abc123" title="Sample title"></a>
        <img data-mediumthumb="https://pix.phncdn.com/t.jpg" src="https://pix.phncdn.com/t.jpg">
        <a class="thumbnailTitle" title="Sample title">Sample title</a>
        <span class="duration">1:23</span>
        <span class="views"><var>10K</var></span>
        <div class="usernameWrap"><a>Studio</a></div>
      </li>`;
    const videos = pornhub.parseListing(html);
    assert.equal(videos[0].id, 'abc123');
    assert.equal(videos[0].title, 'Sample title');
    assert.equal(videos[0].playback.kind, 'resolve');
    assert.equal(pornhub.getEmbedUrl(videos[0]), 'https://www.pornhub.com/embed/abc123');
    assert.equal(pornhub.listingIsRanking(html, 'https://www.pornhub.com/video?o=mv&t=t'), true);
    assert.equal(pornhub.listingIsRanking(html + 'pageKeyStat = "sfw_homepage"', 'https://www.pornhub.com/video?o=mv&t=t'), false);
    assert.equal(pornhub.listingIsRanking(html, 'https://jp.pornhub.com/'), false);

    const defs = pornhub.extractMediaDefinitions('"mediaDefinitions":[{"format":"hls","videoUrl":"https:\\/\\/ev-h.phncdn.com\\/a.m3u8","quality":"720","defaultQuality":true,"height":720}]');
    const media = pornhub.pickMedia(defs);
    assert.equal(media.kind, 'hls');
    assert.equal(media.url, 'https://ev-h.phncdn.com/a.m3u8');
});

test('85po popular cards and mp4 picker', () => {
    const html = `
      <div id="list_videos_common_videos_list_items">
        <div class="item ">
          <a href="https://www.85po.net/ja/v/37398.html" title="サンプル">
            <img class="thumb lazy-load" data-original="https://www.85po.net/contents/videos_screenshots/1.jpg">
            <div class="duration">13:24</div>
            <strong class="title">サンプル</strong>
            <div class="views">172K</div>
          </a>
        </div>
      </div>`;
    const videos = po85.parseListing(html, 'https://www.85po.net');
    assert.equal(videos[0].id, '37398');
    assert.equal(videos[0].duration, '13:24');
    assert.equal(videos[0].thumbUrl, 'https://www.85po.net/contents/videos_screenshots/1.jpg');
    const picked = po85.pickMp4([
        'https://www.85po.net/ja/get_file/3/x/37398_1080p.mp4/?download=true',
        'https://www.85po.net/ja/get_file/3/x/37398_720p.mp4/',
        'https://www.85po.net/contents/videos_screenshots/preview.mp4.jpg',
    ].join(' '));
    assert.equal(picked, 'https://www.85po.net/ja/get_file/3/x/37398_720p.mp4/');
});

test('tokyomotion cards and vsrc playback', () => {
    const html = `
      <div class="well well-sm">
        <a href="/video/7223884/title" class="thumb-popu">
          <img src="https://cdn.tokyo-motion.net/media/videos/tmb/1.jpg" alt="タイトル">
          <span class="video-title">タイトル</span>
          <div class="duration">00:26</div>
        </a>
        <div class="video-views">12 観覧</div>
      </div>`;
    const videos = tokyomotion.parseListing(html);
    assert.equal(videos[0].id, '7223884');
    assert.equal(videos[0].title, 'タイトル');
    assert.equal(videos[0].views, '12 観覧');
    assert.equal(videos[0].pageUrl, 'https://www.tokyomotion.net/video/7223884/title');
    const media = tokyomotion.parsePlayback(`
      <video>
        <source src="https://www.tokyomotion.net/vsrc/sd/token" title="SD" type="video/mp4">
        <source src="https://www.tokyomotion.net/vsrc/hd/token" title="HD" type="video/mp4">
      </video>`);
    assert.equal(media, 'https://www.tokyomotion.net/vsrc/hd/token');
    const token = tokyomotion.parseEmbedToken('<iframe src="https://www.tokyomotion.net/embed/ae4cf059a153ca9875eb"></iframe>');
    assert.equal(token, 'ae4cf059a153ca9875eb');
    assert.equal(tokyomotion.getEmbedUrl({ id: '1', embedToken: token }), 'https://www.tokyomotion.net/embed/ae4cf059a153ca9875eb');
});

test('missav cards and surrit playlist id', () => {
    const html = `
      <div class="thumbnail group">
        <a href="https://missav.ws/ja/dldss-575">
          <img src="https://fourhoi.com/dldss-575/cover-t.jpg" alt="題名">
        </a>
        <span class="absolute bottom-1">2:45:54</span>
        <div class="my-2"><a href="https://missav.ws/ja/dldss-575">題名</a></div>
      </div>`;
    const videos = missav.parseListing(html, 'https://missav.ws');
    assert.equal(videos[0].id, 'dldss-575');
    assert.equal(videos[0].title, '題名');
    assert.equal(videos[0].duration, '2:45:54');
    assert.equal(videos[0].thumbUrl, 'https://fourhoi.com/dldss-575/cover-t.jpg');
    const packed = String.raw`https:\/\/surrit.com\/96d8d22e-6c4c-455a-82e6-2f01f3c4c609\/seek\/_0.jpg`;
    assert.equal(
        missav.extractPlaylist(packed),
        'https://surrit.com/96d8d22e-6c4c-455a-82e6-2f01f3c4c609/playlist.m3u8'
    );
});

test('registry exposes the five sources and only their periods', () => {
    const list = sources.list();
    assert.deepEqual(list.map((source) => source.id), ['twivideo', 'pornhub', '85po', 'tokyomotion', 'missav']);
    for (const source of list) {
        assert.ok(source.periods.length >= 1);
        assert.equal(source.periods.some((period) => period.id === '3d'), false);
        assert.equal(Object.hasOwn(source, 'mediaHosts'), false);
    }
});
