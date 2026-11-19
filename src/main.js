/* ============================================
   Shorts ranking feed
   ============================================ */

const videoFeed = document.getElementById('videoFeed');
const loadingScreen = document.getElementById('loadingScreen');
const loadingText = document.getElementById('loadingText');
const bottomNav = document.getElementById('bottomNav');
const sourceBar = document.getElementById('sourceBar');
const periodNote = document.getElementById('periodNote');

const STORAGE_SOURCE = 'shorts.source';
const STORAGE_PERIOD = 'shorts.period.';
const STORAGE_METRIC = 'shorts.metric.';
const STORAGE_BOOKMARKS = 'shorts.bookmarks';
const STORAGE_ORDER = 'shorts.order';
const Logic = window.FeedLogic;

// localStorage itself can throw (storage disabled, private mode).
function bookmarkStorage() {
    try {
        return window.localStorage;
    } catch {
        return null;
    }
}

function readSetting(key) {
    try {
        const storage = bookmarkStorage();
        return storage ? storage.getItem(key) : null;
    } catch {
        return null;
    }
}

function writeSetting(key, value) {
    try {
        const storage = bookmarkStorage();
        if (storage) storage.setItem(key, value);
    } catch { /* kept for this page only */ }
}

// 'random' (weighted by saves/likes/views, default) or 'ranking'.
let feedOrder = Logic.pickFeedOrder(readSetting(STORAGE_ORDER));
// The ranking as the server sent it (board order), so the order toggle can
// re-sort without a new request. The feed itself (`videos`) is ordered.
let rankingVideos = [];
// Infinite scroll: the last /api/videos page in the feed, whether the board
// has more, and the request for the next one. `feedGeneration` changes on
// every new feed (load, source/period/metric switch, いいね一覧), so a late
// page for an old feed is dropped.
let rankingPage = 0;
let rankingHasMore = false;
let moreController = null;
let feedGeneration = 0;

// Liked videos (newest first), kept in memory and mirrored to localStorage.
let bookmarks = Logic.loadBookmarks(bookmarkStorage(), STORAGE_BOOKMARKS);
// True while the feed shows the いいね一覧 instead of a ranking.
let bookmarkMode = false;

let sources = [];
let currentSource = null;
let currentPeriod = '';
let currentMetric = '';
// Sources that failed since the user last picked one; automatic switching
// never goes back to them (or to hidden ones), so an all-failed state stops.
const failedChain = new Set();
let videos = [];
let isMuted = true;
let currentVideoIndex = 0;
let isLoading = false;
let lastTapTime = 0;
let loadController = null;
let playToken = 0;
let activePlay = -1;
let playbackConfig = { mode: 'auto', fullProxyEnabled: true, maxProxyStreams: 3, sources: {} };
const sourceStrategy = new Map();
const thumbStrategy = new Map();

function thumbPreference(sourceId) {
    const configured = playbackConfig.thumbs && playbackConfig.thumbs[sourceId];
    if (configured === 'direct' || configured === 'proxy') return configured;
    return thumbStrategy.get(sourceId) || 'direct';
}

function posterFor(sourceId, remote) {
    if (!remote) return '';
    return thumbPreference(sourceId) === 'proxy' ? mediaProxy(sourceId, remote) : remote;
}

function ensureThumbMode(sourceId, sample) {
    if (!sample || thumbStrategy.has(sourceId)) return Promise.resolve();
    const configured = playbackConfig.thumbs && playbackConfig.thumbs[sourceId];
    if (configured === 'direct' || configured === 'proxy') {
        thumbStrategy.set(sourceId, configured);
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        const img = new Image();
        const finish = (mode) => {
            thumbStrategy.set(sourceId, mode);
            resolve();
        };
        const timer = setTimeout(() => finish('proxy'), 4000);
        img.referrerPolicy = 'no-referrer';
        img.onload = () => {
            clearTimeout(timer);
            finish('direct');
        };
        img.onerror = () => {
            clearTimeout(timer);
            finish('proxy');
        };
        img.src = sample;
    });
}

const PLAYBACK_LADDER = ['direct', 'playlist-proxy', 'proxy', 'embed'];

function mediaProxy(sourceId, url) {
    if (!url) return '';
    return `/proxy/media?source=${encodeURIComponent(sourceId)}&url=${encodeURIComponent(url)}`;
}

function playlistProxy(sourceId, url) {
    return `/proxy/playlist?source=${encodeURIComponent(sourceId)}&url=${encodeURIComponent(url)}`;
}

function playbackNeedsProxy(playback) {
    if (!playback) return false;
    if (playback.needsReferer) return true;
    return /[?&](?:ip|ipa)=/i.test(playback.url || '');
}

function modesFor(mode, hls, needsReferer) {
    if (mode === 'embed') return ['embed'];
    const start = !mode || mode === 'auto' ? 0 : PLAYBACK_LADDER.indexOf(mode);
    let list = start >= 0 ? PLAYBACK_LADDER.slice(start) : PLAYBACK_LADDER.slice();
    if (!playbackConfig.fullProxyEnabled) list = list.filter((item) => item !== 'proxy');
    if (!hls) list = list.filter((item) => item !== 'playlist-proxy');
    if (needsReferer) list = list.filter((item) => item === 'proxy' || item === 'embed');
    if (!list.includes('embed')) list.push('embed');
    return list;
}

function safeColor(color) {
    return /^#[0-9a-fA-F]{6}$/.test(color || '') ? color : '#ffffff';
}

function periodIcon(id) {
    if (id === '24h') return 'fa-fire';
    if (id === '7d') return 'fa-chart-line';
    if (id === '30d') return 'fa-trophy';
    if (id === '1y') return 'fa-crown';
    return 'fa-clock';
}

function rankClass(rank) {
    if (rank === 1) return 'rank-1';
    if (rank === 2) return 'rank-2';
    if (rank === 3) return 'rank-3';
    return '';
}

function rankIcon(rank) {
    if (rank === 1) return 'fa-crown';
    if (rank <= 3) return 'fa-medal';
    return 'fa-hashtag';
}

function setLoading(visible, message) {
    loadingText.textContent = message || '動画を読み込み中...';
    loadingScreen.classList.toggle('hidden', !visible);
}

function setFallbackNote(text) {
    if (text) {
        periodNote.textContent = text;
        periodNote.classList.remove('hidden');
        document.body.classList.add('has-note');
    } else {
        periodNote.textContent = '';
        periodNote.classList.add('hidden');
        document.body.classList.remove('has-note');
    }
}

function visibleSources() {
    return Logic.barSources(sources, currentSource && currentSource.id);
}

function selectSource(source, remember) {
    currentSource = source;
    const saved = localStorage.getItem(STORAGE_PERIOD + source.id);
    currentPeriod = source.periods.some((period) => period.id === saved)
        ? saved
        : source.periods[0].id;
    currentMetric = Logic.pickMetric(source, localStorage.getItem(STORAGE_METRIC + source.id));
    if (remember) localStorage.setItem(STORAGE_SOURCE, source.id);
}

function renderSourceBar() {
    sourceBar.replaceChildren();
    visibleSources().forEach((source) => {
        const active = !bookmarkMode && source.id === currentSource.id;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'source-btn' + (active ? ' active' : '');
        button.textContent = source.name;
        button.style.borderColor = active ? 'transparent' : safeColor(source.color);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
        button.addEventListener('click', () => {
            if (bookmarkMode) {
                // From the いいね一覧 any site button goes back to the rankings.
                bookmarkMode = false;
                failedChain.clear();
                if (source.id !== currentSource.id) selectSource(source, true);
                renderSourceBar();
                renderPeriodBar();
                loadVideos();
                return;
            }
            if (source.id === currentSource.id) return;
            failedChain.clear();
            selectSource(source, true);
            renderSourceBar();
            renderPeriodBar();
            loadVideos();
        });
        sourceBar.appendChild(button);
    });
    // The いいね一覧 entry sits after the sites (pinned to the right edge by
    // CSS), so the site order is unchanged.
    const bookmarkButton = document.createElement('button');
    bookmarkButton.type = 'button';
    bookmarkButton.className = 'source-btn bookmark-entry' + (bookmarkMode ? ' active' : '');
    bookmarkButton.title = 'いいね一覧';
    bookmarkButton.setAttribute('aria-pressed', bookmarkMode ? 'true' : 'false');
    bookmarkButton.innerHTML = '<i class="fas fa-heart"></i><span></span>';
    bookmarkButton.querySelector('span').textContent = `ブクマ ${bookmarks.length}`;
    bookmarkButton.addEventListener('click', () => {
        if (bookmarkMode) exitBookmarks();
        else openBookmarks();
    });
    sourceBar.appendChild(bookmarkButton);
}

function updateBookmarkCount() {
    const label = sourceBar.querySelector('.bookmark-entry span');
    if (label) label.textContent = `ブクマ ${bookmarks.length}`;
}

// Persist the in-memory list. A full or broken localStorage never throws
// into the UI; the note bar says what happened.
function persistBookmarks() {
    const result = Logic.saveBookmarks(bookmarkStorage(), STORAGE_BOOKMARKS, bookmarks);
    bookmarks = result.saved;
    if (!result.ok) {
        setFallbackNote('いいねを保存できませんでした（ブラウザの保存領域を使えません）');
    } else if (result.trimmed > 0) {
        setFallbackNote(`保存領域が足りないため古いいいねを ${result.trimmed} 件削除しました`);
    }
    updateBookmarkCount();
}

function setLikeButton(button, liked) {
    if (!button) return;
    button.classList.toggle('liked', liked);
    button.setAttribute('aria-pressed', liked ? 'true' : 'false');
}

// Like or unlike the video on card `index`; `forceLike` (double tap) only adds.
function likeVideo(index, forceLike) {
    const video = videos[index];
    const card = cardAt(index);
    if (!video) return;
    const sourceId = sourceOf(video);
    const liked = Logic.isBookmarked(bookmarks, sourceId, video.id);
    if (forceLike && liked) {
        setLikeButton(card && card.querySelector('.like-btn'), true);
        return;
    }
    const result = Logic.toggleBookmark(bookmarks, video, sourceId, Date.now());
    bookmarks = result.list;
    persistBookmarks();
    setLikeButton(card && card.querySelector('.like-btn'), Logic.isBookmarked(bookmarks, sourceId, video.id));
}

function stopMoreLoad() {
    feedGeneration += 1;
    if (moreController) moreController.abort();
    moreController = null;
}

function stopRankingLoad() {
    if (loadController) loadController.abort();
    loadController = null;
    isLoading = false;
    stopMoreLoad();
    rankingHasMore = false;
}

function maybeLoadMore(index) {
    if (bookmarkMode || isLoading) return;
    if (!Logic.shouldLoadMore({ index, total: videos.length, hasMore: rankingHasMore, loading: Boolean(moreController) })) return;
    loadMoreVideos();
}

// The next page of the same board, ordered like the first one (weighted
// shuffle or board order) and appended below; videos already in the feed
// are skipped (Logic.appendFeed). Cards on screen are left as they are.
async function loadMoreVideos() {
    if (!currentSource || bookmarkMode) return;
    const generation = feedGeneration;
    const source = currentSource;
    const page = rankingPage + 1;
    const controller = new AbortController();
    moreController = controller;
    let nothingNew = false;
    try {
        const response = await fetch(Logic.videosUrl(source.id, currentPeriod, currentMetric, page), { signal: controller.signal });
        const data = await response.json();
        if (generation !== feedGeneration || bookmarkMode) return;
        if (!data.ok) {
            rankingHasMore = false;
            return;
        }
        const pageVideos = (data.videos || []).map((video) => ({ ...video, _sourceId: source.id }));
        rankingPage = page;
        rankingHasMore = Boolean(data.hasMore) && pageVideos.length > 0;
        rankingVideos = Logic.uniqueVideos(rankingVideos.concat(pageVideos));
        const start = videos.length;
        videos = Logic.appendFeed(videos, pageVideos, feedOrder);
        appendCards(start);
        nothingNew = videos.length === start;
    } catch (err) {
        // A network error stops the scroll here; a reload starts over.
        if (err.name !== 'AbortError' && generation === feedGeneration) rankingHasMore = false;
    } finally {
        if (moreController === controller) moreController = null;
    }
    // A page made only of videos already shown adds no card to scroll to,
    // so ask for the one after it straight away.
    if (nothingNew && generation === feedGeneration) maybeLoadMore(currentVideoIndex);
}

// Add cards for videos[start..] without touching the ones already shown.
function appendCards(start) {
    const added = [];
    for (let index = start; index < videos.length; index += 1) {
        const card = createVideoCard(videos[index], index);
        videoFeed.appendChild(card);
        added.push(card);
    }
    if (added.length === 0) return;
    if (feedObserver) added.forEach((card) => feedObserver.observe(card));
    setupEventListeners(added);
}

async function openBookmarks() {
    stopRankingLoad();
    bookmarkMode = true;
    // Pick up likes made in another tab.
    bookmarks = Logic.loadBookmarks(bookmarkStorage(), STORAGE_BOOKMARKS);
    renderSourceBar();
    renderPeriodBar();
    stopAll();
    setFallbackNote('');
    videos = Logic.bookmarkVideos(bookmarks);
    if (videos.length === 0) {
        setLoading(false);
        showMessage('まだいいねした動画はありません', 'フィードで ♥ を押すと、ここからあとで見返せます', exitBookmarks, {
            buttonText: 'ランキングに戻る',
            icon: 'fa-heart',
        });
        return;
    }
    const list = videos;
    setLoading(true, 'いいね一覧を読み込み中...');
    const samples = new Map();
    list.forEach((video) => {
        if (video.thumbUrl && !samples.has(video._sourceId)) samples.set(video._sourceId, video.thumbUrl);
    });
    await Promise.all([...samples].map(([sourceId, sample]) => ensureThumbMode(sourceId, sample)));
    if (!bookmarkMode || videos !== list) return;
    renderVideos(videos);
    currentVideoIndex = 0;
    videoFeed.scrollTo({ top: 0 });
    setLoading(false);
}

function exitBookmarks() {
    if (!bookmarkMode) return;
    bookmarkMode = false;
    stopAll();
    renderSourceBar();
    renderPeriodBar();
    loadVideos();
}

window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_BOOKMARKS && event.key !== null) return;
    bookmarks = Logic.loadBookmarks(bookmarkStorage(), STORAGE_BOOKMARKS);
    updateBookmarkCount();
    videoFeed.querySelectorAll('.video-card').forEach((card) => {
        const video = videos[Number(card.dataset.index)];
        if (video) setLikeButton(card.querySelector('.like-btn'), Logic.isBookmarked(bookmarks, sourceOf(video), video.id));
    });
});

function metricIcon(id) {
    return id === 'views' ? 'fa-eye' : 'fa-download';
}

function renderPeriodBar() {
    bottomNav.replaceChildren();
    if (bookmarkMode) {
        // In the いいね一覧 the bottom bar is the way back to the ranking.
        const back = document.createElement('button');
        back.type = 'button';
        back.className = 'nav-btn back-to-ranking';
        back.innerHTML = '<i class="fas fa-arrow-left"></i><span></span>';
        back.querySelector('span').textContent = currentSource ? `${currentSource.name} ランキングに戻る` : 'ランキングに戻る';
        back.addEventListener('click', exitBookmarks);
        const label = document.createElement('button');
        label.type = 'button';
        label.className = 'nav-btn active';
        label.disabled = true;
        label.innerHTML = '<i class="fas fa-heart"></i><span>いいね一覧</span>';
        bottomNav.append(back, label);
        return;
    }
    currentSource.periods.forEach((period) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'nav-btn' + (period.id === currentPeriod ? ' active' : '');
        button.innerHTML = `<i class="fas ${periodIcon(period.id)}"></i><span></span>`;
        button.querySelector('span').textContent = period.label;
        button.addEventListener('click', () => {
            if (period.id === currentPeriod) return;
            currentPeriod = period.id;
            localStorage.setItem(STORAGE_PERIOD + currentSource.id, period.id);
            renderPeriodBar();
            loadVideos();
        });
        bottomNav.appendChild(button);
    });
    // TwiKeep ranks by 保存数 or 表示数; one button flips between them.
    const metrics = currentSource.metrics || [];
    if (metrics.length > 1 && currentMetric) {
        const active = metrics.find((metric) => metric.id === currentMetric) || metrics[0];
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'nav-btn metric-btn active';
        button.title = 'ランキングの基準を切り替え';
        button.innerHTML = `<i class="fas ${metricIcon(active.id)}"></i><span></span>`;
        button.querySelector('span').textContent = active.label;
        button.addEventListener('click', () => {
            currentMetric = Logic.nextMetric(metrics, currentMetric);
            localStorage.setItem(STORAGE_METRIC + currentSource.id, currentMetric);
            renderPeriodBar();
            loadVideos();
        });
        bottomNav.appendChild(button);
    }
    bottomNav.appendChild(orderButton());
}

// ランダム ⇄ ランキング順. Saved per browser; the いいね一覧 is not affected.
function orderButton() {
    const random = feedOrder === 'random';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'nav-btn order-btn' + (random ? ' active' : '');
    button.title = random ? 'ランダム順（人気ほど出やすい）→ ランキング順に切り替え' : 'ランキング順 → ランダム順に切り替え';
    button.setAttribute('aria-pressed', random ? 'true' : 'false');
    button.innerHTML = `<i class="fas ${random ? 'fa-shuffle' : 'fa-list-ol'}"></i><span></span>`;
    button.querySelector('span').textContent = random ? 'ランダム' : 'ランキング順';
    button.addEventListener('click', () => {
        feedOrder = Logic.nextFeedOrder(feedOrder);
        writeSetting(STORAGE_ORDER, feedOrder);
        renderPeriodBar();
        applyFeedOrder();
    });
    return button;
}

// Re-order the loaded ranking in place (a fresh shuffle each time). While a
// load is running, that load applies the new order when it renders.
function applyFeedOrder() {
    if (bookmarkMode || isLoading || rankingVideos.length === 0) return;
    const fresh = rankingVideos.map(({ _preloading, _preloaded, ...video }) => video);
    videos = Logic.orderFeed(fresh, feedOrder);
    renderVideos(videos);
    currentVideoIndex = 0;
    videoFeed.scrollTo({ top: 0 });
}

function showMessage(title, message, onRetry, options = {}) {
    videoFeed.replaceChildren();
    const wrap = document.createElement('div');
    wrap.className = 'error-state';
    const icon = document.createElement('i');
    icon.className = `fas ${options.icon || 'fa-exclamation-triangle'}`;
    const heading = document.createElement('h3');
    heading.textContent = title;
    const paragraph = document.createElement('p');
    paragraph.textContent = message;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = options.buttonText || '再読み込み';
    button.addEventListener('click', onRetry);
    wrap.append(icon, heading, paragraph, button);
    videoFeed.appendChild(wrap);
}

function createVideoCard(video, index) {
    const card = document.createElement('div');
    card.className = 'video-card';
    card.dataset.index = String(index);

    // A bookmarked video keeps its own source (the list mixes sites).
    const cardSource = sourceInfo(sourceOf(video));
    const poster = posterFor(cardSource.id, video.thumbUrl);
    const chipColor = safeColor(cardSource.color);
    const liked = Logic.isBookmarked(bookmarks, cardSource.id, video.id);
    const badgeIcon = video._bookmark ? 'fa-heart' : rankIcon(video.rank);

    card.innerHTML = `
    <div class="video-wrapper">
      <video muted playsinline preload="none" referrerpolicy="no-referrer" ${poster ? `poster="${poster.replace(/"/g, '')}"` : ''}></video>
    </div>
    <div class="gradient-top"></div>
    <div class="gradient-bottom"></div>
    <div class="ranking-badge ${rankClass(video.rank)}">
      <i class="fas ${badgeIcon} rank-icon"></i>
      <span></span>
    </div>
    <div class="play-pause-overlay" data-index="${index}">
      <div class="play-icon" id="playIcon-${index}"><i class="fas fa-play"></i></div>
    </div>
    <div class="side-actions">
      <button class="action-btn like-btn${liked ? ' liked' : ''}" type="button" aria-pressed="${liked ? 'true' : 'false'}">
        <div class="btn-icon"><i class="fas fa-heart"></i></div>
        <span class="btn-label">いいね</span>
      </button>
      <button class="action-btn sound-btn ${isMuted ? 'muted' : ''}" type="button">
        <div class="btn-icon"><i class="fas ${isMuted ? 'fa-volume-xmark' : 'fa-volume-high'}"></i></div>
        <span class="btn-label">${isMuted ? 'ミュート' : '音あり'}</span>
      </button>
      <button class="action-btn share-btn" type="button">
        <div class="btn-icon"><i class="fas fa-share"></i></div>
        <span class="btn-label">共有</span>
      </button>
      <button class="action-btn origin-btn" type="button">
        <div class="btn-icon"><i class="fas fa-arrow-up-right-from-square"></i></div>
        <span class="btn-label">${video.lookup ? '元ポスト' : '元ページ'}</span>
      </button>
    </div>
    <div class="video-info">
      <div class="info-source"><span></span></div>
      <div class="info-title"></div>
      <div class="info-meta"></div>
    </div>
    <div class="video-progress"><div class="progress-fill" id="progress-${index}"></div></div>
    `;

    card.querySelector('.ranking-badge span').textContent = video.rankLabel || `No.${video.rank}`;
    const sourceChip = card.querySelector('.info-source');
    sourceChip.querySelector('span').textContent = cardSource.name;
    sourceChip.style.color = chipColor;
    sourceChip.style.borderColor = chipColor;
    sourceChip.style.background = 'rgba(255,255,255,0.06)';
    card.querySelector('.info-title').textContent = video.title || `ランキング ${video.rankLabel || video.rank}`;
    const likedOn = video._bookmark && video.likedAt
        ? `${new Date(video.likedAt).toLocaleDateString('ja-JP')} にいいね`
        : '';
    const meta = [video.duration, video.views, likedOn].filter(Boolean).join(' · ');
    card.querySelector('.info-meta').textContent = meta;
    const media = card.querySelector('video');
    media.addEventListener('error', () => {
        if (media.getAttribute('poster')) media.removeAttribute('poster');
    });
    media.addEventListener('ended', () => {
        if (media.dataset.rewinding === '1') return;
        if (!Number.isFinite(media.duration) || media.duration < 1) return;
        if (media.currentTime + 0.75 < media.duration) return;
        media.dataset.rewinding = '1';
        const resume = () => {
            media.dataset.rewinding = '';
            const playPromise = media.play();
            if (playPromise) playPromise.catch(() => {});
        };
        media.addEventListener('seeked', resume, { once: true });
        try {
            media.currentTime = 0;
        } catch {
            media.dataset.rewinding = '';
        }
    });

    if (index === 0) {
        const hint = document.createElement('div');
        hint.className = 'scroll-indicator';
        hint.id = 'scrollIndicator';
        hint.innerHTML = '<i class="fas fa-chevron-down"></i><span>スワイプして次へ</span>';
        card.appendChild(hint);
    }
    return card;
}

function renderVideos(list) {
    stopAll();
    videoFeed.replaceChildren();
    list.forEach((video, index) => videoFeed.appendChild(createVideoCard(video, index)));
    setupObserver();
    setupEventListeners();
}

function cardAt(index) {
    return videoFeed.querySelectorAll('.video-card')[index] || null;
}

// Removing src alone does not stop the download: the element keeps the old
// resource (and its /proxy/media connection and relay slot) until load()
// runs the load algorithm again with no source.
function releaseMedia(media) {
    if (!media) return;
    media.onerror = null;
    if (!media.paused) media.pause();
    if (media.hasAttribute('src') || media.currentSrc) {
        media.removeAttribute('src');
        try {
            media.load();
        } catch { /* nothing to abort */ }
    }
}

function stopCard(card) {
    if (!card) return;
    if (card._hls) {
        card._hls.destroy();
        card._hls = null;
    }
    const media = card.querySelector('video');
    if (media) {
        releaseMedia(media);
        media.style.display = '';
    }
    const frame = card.querySelector('iframe.embed-player');
    if (frame) frame.remove();
    card.classList.remove('embed-shield', 'embed-interactive');
    const exit = card.querySelector('.embed-exit');
    if (exit) exit.remove();
    const hint = card.querySelector('.embed-hint');
    if (hint) hint.remove();
    const overlay = card.querySelector('.play-pause-overlay');
    if (overlay) overlay.style.display = '';
    const progress = card.querySelector('.video-progress');
    if (progress) progress.style.display = '';
}

function stopAll() {
    playToken += 1;
    activePlay = -1;
    videoFeed.querySelectorAll('.video-card').forEach(stopCard);
}

function showPlayIcon(index, isPaused, persistent) {
    const icon = document.getElementById(`playIcon-${index}`);
    if (!icon) return;
    icon.querySelector('i').className = isPaused ? 'fas fa-play' : 'fas fa-pause';
    icon.classList.add('visible');
    if (!persistent) {
        setTimeout(() => icon.classList.remove('visible'), 600);
    }
}

function showCardMessage(card, text) {
    let note = card.querySelector('.card-message');
    if (!note) {
        note = document.createElement('div');
        note.className = 'card-message';
        card.appendChild(note);
    }
    note.textContent = text;
}

function startProgressTracking(media, index) {
    const progressFill = document.getElementById(`progress-${index}`);
    if (!progressFill || media.dataset.progress === '1') return;
    media.dataset.progress = '1';
    const update = () => {
        const duration = media.duration;
        if (!Number.isFinite(duration) || duration <= 0) return;
        progressFill.style.width = ((media.currentTime / duration) * 100) + '%';
    };
    media.addEventListener('timeupdate', update);
}

function sourceOf(video) {
    return (video && video._sourceId) || currentSource.id;
}

// Name and color for a source id; one the server no longer lists (a liked
// video from a removed source) still gets a chip with its id.
function sourceInfo(sourceId) {
    return sources.find((source) => source.id === sourceId)
        || (currentSource && currentSource.id === sourceId ? currentSource : null)
        || { id: sourceId, name: sourceId, color: '' };
}

async function resolvePlayback(video, fresh) {
    if (video.playback.kind !== 'resolve') return video.playback;
    const response = await fetch(Logic.resolveUrl(sourceOf(video), video.id, fresh));
    const data = await response.json();
    if (!data.ok || !data.playback) {
        if (video.playback.embedUrl) {
            return { kind: 'embed', url: video.playback.embedUrl, embedUrl: video.playback.embedUrl };
        }
        const error = new Error(data.error || '再生情報を取得できませんでした');
        error.unavailable = Boolean(data.unavailable);
        throw error;
    }
    if (data.playback.embedUrl) video.playback.embedUrl = data.playback.embedUrl;
    return data.playback;
}

// The card title from the play page when the listing had none.
function applyResolvedTitle(card, video, playback) {
    if (!playback || !playback.title || playback.title === video.title) return;
    video.title = playback.title;
    const node = card.querySelector('.info-title');
    if (node) node.textContent = playback.title;
}

// A video that cannot play moves the feed on instead of sitting at
// readyState 0 behind a spinner.
const SKIP_DELAY_MS = 1200;

function skipAfter(card, index, attempt, text) {
    showCardMessage(card, text);
    showPlayIcon(index, true, true);
    // A liked video that no longer plays stays in the list (the user can
    // unlike it); the note bar says which one it was.
    if (bookmarkMode) {
        const video = videos[index];
        const name = (video && video.title) || 'いいねした動画';
        setFallbackNote(`いいね一覧: 「${name.slice(0, 40)}」を再生できませんでした（♥で解除できます）`);
    }
    setTimeout(() => {
        if (!Logic.playbackCurrent(attempt, playbackState())) return;
        const next = cardAt(index + 1);
        if (next) next.scrollIntoView({ behavior: 'smooth' });
    }, SKIP_DELAY_MS);
}

function playbackState() {
    // The いいね一覧 mixes sources, so there the on-screen video's own source
    // is the current one (a mode switch bumps playToken anyway).
    if (bookmarkMode) {
        const video = videos[currentVideoIndex];
        return { token: playToken, index: currentVideoIndex, sourceId: video ? sourceOf(video) : '' };
    }
    return { token: playToken, index: currentVideoIndex, sourceId: currentSource && currentSource.id };
}

function mountEmbed(card, embedUrl) {
    const wrapper = card.querySelector('.video-wrapper');
    const media = wrapper.querySelector('video');
    if (media) media.style.display = 'none';
    let frame = wrapper.querySelector('iframe.embed-player');
    if (!frame) {
        frame = document.createElement('iframe');
        frame.className = 'embed-player';
        frame.setAttribute('allow', 'autoplay; fullscreen; encrypted-media; picture-in-picture');
        frame.setAttribute('allowfullscreen', '');
        frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
        wrapper.appendChild(frame);
    }
    if (frame.src !== embedUrl) frame.src = embedUrl;
    card.classList.add('embed-shield');
    card.classList.remove('embed-interactive');
    const overlay = card.querySelector('.play-pause-overlay');
    if (overlay) {
        overlay.style.display = '';
        if (!overlay.querySelector('.embed-hint')) {
            const hint = document.createElement('div');
            hint.className = 'embed-hint';
            hint.textContent = 'スワイプで移動 · タップで操作';
            overlay.appendChild(hint);
        }
    }
    if (!card.querySelector('.embed-exit')) {
        const exit = document.createElement('button');
        exit.type = 'button';
        exit.className = 'embed-exit';
        exit.textContent = 'スワイプに戻す';
        exit.addEventListener('click', (event) => {
            event.stopPropagation();
            card.classList.remove('embed-interactive');
        });
        card.appendChild(exit);
    }
    const progress = card.querySelector('.video-progress');
    if (progress) progress.style.display = 'none';
}

function prepareVideo(media) {
    media.referrerPolicy = 'no-referrer';
    media.setAttribute('referrerpolicy', 'no-referrer');
    media.muted = isMuted;
    media.playsInline = true;
}

function waitUntilPlaying(media, timeout = 15000) {
    return new Promise((resolve) => {
        if (media.error) {
            resolve(false);
            return;
        }
        const timer = setTimeout(() => finish(media.readyState >= 1 && !media.error), timeout);
        // A 403 MP4 can leave the element at readyState 0 without an error
        // event; give up on it early instead of waiting out the timeout.
        const started = Date.now();
        const stall = setInterval(() => {
            if (Logic.mediaStalled({
                readyState: media.readyState,
                networkState: media.networkState,
                elapsedMs: Date.now() - started,
            })) finish(false);
        }, 1000);
        const ok = () => {
            if (media.error) {
                finish(false);
                return;
            }
            if (media.currentTime > 0 || media.readyState >= 2) finish(true);
        };
        const bad = () => finish(false);
        let settled = false;
        function finish(success) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearInterval(stall);
            media.removeEventListener('timeupdate', ok);
            media.removeEventListener('loadeddata', ok);
            media.removeEventListener('error', bad);
            resolve(success);
        }
        media.addEventListener('timeupdate', ok);
        media.addEventListener('loadeddata', ok);
        media.addEventListener('error', bad);
    });
}

function mountFile(card, index, url) {
    const media = card.querySelector('video');
    media.style.display = '';
    prepareVideo(media);
    // Assign src first: that resets media.error. Waiting first would see the
    // error left by the previous ladder step and fail this step at once.
    media.src = url;
    const started = waitUntilPlaying(media);
    const playPromise = media.play();
    if (playPromise) playPromise.catch(() => {});
    startProgressTracking(media, index);
    return started;
}

function useNativeHls(media) {
    const ua = navigator.userAgent;
    const safari = /Safari/i.test(ua) && !/Chrome|Chromium|Edg|OPR|Android/i.test(ua);
    const ios = /iPhone|iPad|iPod/i.test(ua);
    if (!(safari || ios)) return false;
    return !!media.canPlayType('application/vnd.apple.mpegurl');
}

function mountHls(card, index, url) {
    const media = card.querySelector('video');
    media.style.display = '';
    prepareVideo(media);
    if (useNativeHls(media)) {
        return mountFile(card, index, url);
    }
    if (!window.Hls || !window.Hls.isSupported()) return Promise.resolve(false);
    if (card._hls) {
        card._hls.destroy();
        card._hls = null;
    }
    const hls = new window.Hls({
        enableWorker: true,
        lowLatencyMode: false,
        maxBufferLength: 8,
        maxMaxBufferLength: 14,
        maxBufferSize: 8 * 1000 * 1000,
    });
    card._hls = hls;
    return new Promise((resolve) => {
        let settled = false;
        const finish = (ok) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            media.removeEventListener('timeupdate', progress);
            if (!ok && card._hls === hls) {
                hls.destroy();
                card._hls = null;
            }
            resolve(ok);
        };
        const timer = setTimeout(() => finish(media.currentTime > 0 && !media.error), 8000);
        const progress = () => {
            if (media.currentTime > 0 && !media.error) finish(true);
        };
        media.addEventListener('timeupdate', progress);
        hls.on(window.Hls.Events.ERROR, (_, data) => {
            if (data && data.fatal) finish(false);
        });
        hls.on(window.Hls.Events.FRAG_LOADED, progress);
        hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
            media.muted = isMuted;
            media.play().then(() => {
                showPlayIcon(index, false, false);
                startProgressTracking(media, index);
            }).catch(() => showPlayIcon(index, true, true));
        });
        hls.loadSource(url);
        hls.attachMedia(media);
    });
}

function isHls(playback) {
    return Boolean(playback && (playback.kind === 'hls' || (playback.url && /\.m3u8(\?|$)/i.test(playback.url))));
}

function clearMedia(card) {
    if (card._hls) {
        card._hls.destroy();
        card._hls = null;
    }
    releaseMedia(card.querySelector('video'));
}

async function tryMode(mode, playback, card, index) {
    clearMedia(card);
    const sourceId = sourceOf(videos[index]);
    const embedUrl = (playback && playback.embedUrl) || (videos[index] && videos[index].playback.embedUrl);
    if (mode === 'embed') {
        if (!embedUrl) return false;
        mountEmbed(card, embedUrl);
        return true;
    }
    if (!playback || !playback.url) return false;
    const hls = isHls(playback);
    let played = false;
    if (mode === 'direct') {
        played = hls ? await mountHls(card, index, playback.url) : await mountFile(card, index, playback.url);
    } else if (mode === 'playlist-proxy' && hls) {
        played = await mountHls(card, index, playlistProxy(sourceId, playback.url));
    } else if (mode === 'proxy') {
        const proxied = mediaProxy(sourceId, playback.url);
        played = hls ? await mountHls(card, index, proxied) : await mountFile(card, index, proxied);
    }
    return played;
}

let syncPlay = false;
const MAX_LADDER_STEPS = 6;

function yieldToBrowser() {
    return new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
}

async function playCard(index) {
    if (syncPlay) return;
    const card = cardAt(index);
    const video = videos[index];
    if (!card || !video) return;
    if (activePlay === index) return;
    syncPlay = true;
    activePlay = index;
    const token = ++playToken;
    currentVideoIndex = index;
    try {
        videoFeed.querySelectorAll('.video-card').forEach((other, otherIndex) => {
            if (otherIndex !== index) stopCard(other);
        });
    } finally {
        syncPlay = false;
    }

    const sourceId = sourceOf(video);
    // Everything below belongs to this attempt; a source switch, a new
    // render or a scroll makes it stale and it must stop, including the
    // one-time fresh re-resolve.
    const attempt = { token, index, sourceId };
    const current = () => Logic.playbackCurrent(attempt, playbackState());
    const stale = card.querySelector('.card-message');
    if (stale) stale.remove();

    const forced = (playbackConfig.sources && playbackConfig.sources[sourceId]) || playbackConfig.mode || 'auto';
    let playback = video.playback;
    try {
        playback = await resolvePlayback(video, false);
    } catch (err) {
        if (!current()) return;
        if (err.unavailable) {
            activePlay = -1;
            skipAfter(card, index, attempt, '元の動画が削除されているため次へ進みます');
            return;
        }
        playback = { kind: 'embed', url: video.playback.embedUrl, embedUrl: video.playback.embedUrl, error: err.message };
    }
    if (!current()) return;
    applyResolvedTitle(card, video, playback);

    let modes = modesFor(forced, isHls(playback), playbackNeedsProxy(playback));
    const known = sourceStrategy.get(sourceId);
    if (known && !playback.needsReferer) {
        const at = modes.indexOf(known);
        if (at > 0) modes = modes.slice(at);
    }

    let resolvedOnceMore = false;
    let steps = 0;
    for (let i = 0; i < modes.length && steps < MAX_LADDER_STEPS; i += 1) {
        const mode = modes[i];
        steps += 1;
        if (!current()) return;
        await yieldToBrowser();
        if (!current()) return;
        let ok = await tryMode(mode, playback, card, index);
        if (Logic.shouldReResolve({
            ok,
            mode,
            alreadyResolved: resolvedOnceMore,
            kind: video.playback.kind,
            current: current(),
        })) {
            resolvedOnceMore = true;
            try {
                playback = await resolvePlayback(video, true);
            } catch (err) {
                if (!current()) return;
                if (err.unavailable) {
                    clearMedia(card);
                    activePlay = -1;
                    skipAfter(card, index, attempt, '元の動画が削除されているため次へ進みます');
                    return;
                }
                /* otherwise keep the previous URL */
            }
            if (!current()) return;
            modes = modesFor(forced, isHls(playback), playbackNeedsProxy(playback));
            i = -1;
            continue;
        }
        if (!current()) return;
        if (ok) {
            if (forced === 'auto') sourceStrategy.set(sourceId, mode);
            showPlayIcon(index, false, false);
            const indicator = document.getElementById('scrollIndicator');
            if (indicator && index > 0) indicator.classList.add('hidden');
            preloadNext(index);
            return;
        }
        clearMedia(card);
    }
    if (!current()) return;
    activePlay = -1;
    skipAfter(card, index, attempt, 'この動画を再生できませんでした。次へ進みます');
}

function preloadNext(index) {
    const next = videos[index + 1];
    const card = cardAt(index + 1);
    if (!next || !card || next._preloading || next._preloaded) return;
    const sourceId = sourceOf(next);
    const mode = sourceStrategy.get(sourceId);
    if (mode === 'proxy') return;
    next._preloading = true;
    resolvePlayback(next, false).then((playback) => {
        next._preloaded = true;
        if (videos[index + 1] !== next || cardAt(index + 1) !== card) return;
        if (currentVideoIndex !== index || (!bookmarkMode && (!currentSource || currentSource.id !== sourceId))) return;
        if (mode === 'embed' || (playback && playback.kind === 'embed')) {
            const embedUrl = (playback && (playback.embedUrl || playback.url)) || next.playback.embedUrl;
            if (embedUrl && !card.querySelector('iframe.embed-player')) mountEmbed(card, embedUrl);
            return;
        }
        // An IP-bound or Referer-checked URL only plays through the relay;
        // a direct preload would just fail against the CDN.
        if (!playback || !playback.url || mode === 'proxy' || playbackNeedsProxy(playback)) return;
        const media = card.querySelector('video');
        if (!media || media.getAttribute('src')) return;
        prepareVideo(media);
        media.preload = 'metadata';
        if (!isHls(playback) && (mode === 'direct' || !mode)) media.src = playback.url;
    }).catch(() => {
        next._preloaded = true;
    });
}

let feedObserver = null;

function setupObserver() {
    // One observer per feed. A new one per render kept the old cards (and
    // their <video> elements) reachable after a source or period switch.
    if (feedObserver) feedObserver.disconnect();
    const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            const index = Number(entry.target.dataset.index);
            if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
                playCard(index);
                maybeLoadMore(index);
            } else if (index !== currentVideoIndex) {
                stopCard(entry.target);
            }
        });
    }, { threshold: [0.6], root: videoFeed });
    feedObserver = observer;
    videoFeed.querySelectorAll('.video-card').forEach((card) => observer.observe(card));
}

function togglePlayPause(index) {
    const card = cardAt(index);
    if (!card || card.querySelector('iframe.embed-player')) return;
    const media = card.querySelector('video');
    if (!media || !media.src) {
        playCard(index);
        return;
    }
    if (media.paused) {
        media.muted = isMuted;
        media.play().then(() => showPlayIcon(index, false, false)).catch(() => {});
    } else {
        media.pause();
        showPlayIcon(index, true, false);
    }
}

function updateAllMuteState() {
    videoFeed.querySelectorAll('video').forEach((media) => {
        media.muted = isMuted;
    });
    videoFeed.querySelectorAll('.sound-btn').forEach((button) => {
        const icon = button.querySelector('.btn-icon i');
        const label = button.querySelector('.btn-label');
        button.classList.toggle('muted', isMuted);
        icon.className = isMuted ? 'fas fa-volume-xmark' : 'fas fa-volume-high';
        label.textContent = isMuted ? 'ミュート' : '音あり';
    });
}

function bindEmbedShield(overlay) {
    let startY = 0;
    let lastY = 0;
    let moved = false;
    overlay.addEventListener('pointerdown', (event) => {
        if (!overlay.closest('.embed-shield')) return;
        startY = lastY = event.clientY;
        moved = false;
        overlay.setPointerCapture(event.pointerId);
    });
    overlay.addEventListener('pointermove', (event) => {
        if (!overlay.closest('.embed-shield')) return;
        const dy = event.clientY - lastY;
        if (Math.abs(event.clientY - startY) > 10) {
            moved = true;
            videoFeed.scrollTop -= dy;
            lastY = event.clientY;
        }
    });
    overlay.addEventListener('pointerup', (event) => {
        if (!overlay.closest('.embed-shield')) return;
        try { overlay.releasePointerCapture(event.pointerId); } catch { /* already released */ }
        if (moved) return;
        overlay.style.pointerEvents = 'none';
        const under = document.elementFromPoint(event.clientX, event.clientY);
        overlay.style.pointerEvents = '';
        if (under && under !== overlay) {
            under.dispatchEvent(new MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                clientX: event.clientX,
                clientY: event.clientY,
                view: window,
            }));
        }
    });
    overlay.addEventListener('wheel', (event) => {
        if (!overlay.closest('.embed-shield')) return;
        videoFeed.scrollTop += event.deltaY;
        event.preventDefault();
    }, { passive: false });
}

// `cards`: only these (cards appended by the infinite scroll); default all.
function setupEventListeners(cards) {
    const scope = cards || [...videoFeed.querySelectorAll('.video-card')];
    const all = (selector) => scope.flatMap((card) => [...card.querySelectorAll(selector)]);
    const indexOf = (node) => Number(node.closest('.video-card').dataset.index);
    all('.play-pause-overlay').forEach((overlay) => {
        bindEmbedShield(overlay);
        overlay.addEventListener('click', (event) => {
            const card = overlay.closest('.video-card');
            if (card && card.classList.contains('embed-shield')) return;
            const now = Date.now();
            const index = Number(overlay.dataset.index);
            if (now - lastTapTime < 400) {
                lastTapTime = 0;
                const card = cardAt(index);
                if (!card) return;
                const heart = document.createElement('div');
                heart.className = 'double-tap-heart';
                heart.innerHTML = '<i class="fas fa-heart"></i>';
                const rect = card.getBoundingClientRect();
                heart.style.left = (event.clientX - rect.left - 40) + 'px';
                heart.style.top = (event.clientY - rect.top - 40) + 'px';
                card.appendChild(heart);
                setTimeout(() => heart.remove(), 900);
                likeVideo(index, true);
                return;
            }
            lastTapTime = now;
            togglePlayPause(index);
        });
    });

    all('.like-btn').forEach((button) => {
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            const card = button.closest('.video-card');
            if (card) likeVideo(Number(card.dataset.index), false);
        });
    });

    all('.sound-btn').forEach((button) => {
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            isMuted = !isMuted;
            updateAllMuteState();
        });
    });

    all('.share-btn').forEach((button) => {
        button.addEventListener('click', async (event) => {
            event.stopPropagation();
            const video = videos[indexOf(button)];
            const url = (video && (video.externalUrl || video.pageUrl)) || location.href;
            if (navigator.share) {
                try { await navigator.share({ title: sourceInfo(sourceOf(video)).name, url }); } catch { /* dismissed */ }
            } else {
                await navigator.clipboard.writeText(url);
                const label = button.querySelector('.btn-label');
                label.textContent = 'コピー済';
                setTimeout(() => { label.textContent = '共有'; }, 1500);
            }
        });
    });

    all('.origin-btn').forEach((button) => {
        button.addEventListener('click', async (event) => {
            event.stopPropagation();
            const video = videos[indexOf(button)];
            if (!video) return;
            if (video.lookup) {
                try {
                    const response = await fetch(`/api/external?source=${encodeURIComponent(sourceOf(video))}&id=${encodeURIComponent(video.id)}`);
                    const data = await response.json();
                    if (data.ok && data.url) {
                        window.open(data.url, '_blank', 'noopener,noreferrer');
                        return;
                    }
                } catch { /* fall through */ }
            }
            const url = video.externalUrl || video.pageUrl;
            if (url) window.open(url, '_blank', 'noopener,noreferrer');
        });
    });
}

// Re-read the hidden flags from /api/sources. The server un-hides a source
// after hiddenRetryMs; without this an open page would keep it out of the
// bar (and out of the fallback candidates) until a reload.
let sourcesRefreshedAt = 0;

async function refreshSources(force) {
    if (!force && !Logic.needsSourceRefresh(sources, sourcesRefreshedAt, Date.now())) return false;
    sourcesRefreshedAt = Date.now();
    try {
        const response = await fetch('/api/sources');
        const data = await response.json();
        const before = sources.map((source) => `${source.id}:${source.hidden}`).join();
        sources = Logic.mergeSourceStatus(sources, data.sources);
        if (currentSource) currentSource = sources.find((source) => source.id === currentSource.id) || currentSource;
        const changed = before !== sources.map((source) => `${source.id}:${source.hidden}`).join();
        if (changed && currentSource) renderSourceBar();
        return changed;
    } catch {
        return false;
    }
}

setInterval(() => { refreshSources(false); }, Logic.SOURCES_REFRESH_MS);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshSources(false);
});

async function retryCurrent() {
    failedChain.clear();
    await refreshSources(true);
    loadVideos();
}

async function loadVideos(options = {}) {
    if (!currentSource || bookmarkMode) return;
    if (loadController) loadController.abort();
    loadController = new AbortController();
    const { signal } = loadController;
    const source = currentSource;
    const period = currentPeriod;
    const metric = currentMetric;
    // Why the feed is on this source (set when it switched by itself). It
    // stays up with the board's own notes instead of being wiped here.
    const switchNote = options.note || '';
    rankingVideos = [];
    stopMoreLoad();
    rankingPage = 0;
    rankingHasMore = false;
    isLoading = true;
    stopAll();
    setFallbackNote(switchNote);
    setLoading(true, `${source.name} を読み込み中...`);

    try {
        const response = await fetch(Logic.videosUrl(source.id, period, metric), { signal });
        const data = await response.json();
        if (signal.aborted || source.id !== currentSource.id) return;
        if (!data.ok) {
            if (data.source) {
                sources = Logic.mergeSourceStatus(sources, [data.source]);
                currentSource = sources.find((item) => item.id === source.id) || currentSource;
            }
            failedChain.add(source.id);
            const next = Logic.fallbackSource(sources, source.id, failedChain);
            if (next) {
                selectSource(next, false);
                renderSourceBar();
                renderPeriodBar();
                setLoading(false);
                isLoading = false;
                loadVideos({ note: Logic.switchNote(source.name, next.name, data.reason, !!data.hidden) });
                return;
            }
            // Nothing left that has not failed: stop here (no more requests
            // until the user retries or picks a source).
            renderSourceBar();
            setFallbackNote(switchNote);
            showMessage(`${source.name} を読み込めませんでした`, data.error || Logic.reasonText(data.reason), retryCurrent);
            setLoading(false);
            return;
        }
        failedChain.clear();
        // Every load (source / period / metric switch, retry, reload) gets a
        // new random order; the board order is kept for the toggle.
        rankingVideos = (data.videos || []).map((video) => ({ ...video, _sourceId: source.id }));
        // Page 1 of the board; the infinite scroll asks for page 2, 3, ...
        rankingPage = 1;
        rankingHasMore = Boolean(data.hasMore);
        let orderUsed = feedOrder;
        videos = Logic.orderFeed(rankingVideos, orderUsed);
        setFallbackNote(Logic.joinNotes(switchNote, data.fallback ? data.fallbackReason : '', data.notice));
        if (videos.length === 0) {
            showMessage('動画が見つかりませんでした', 'しばらくしてからもう一度お試しください', retryCurrent);
            setLoading(false);
            return;
        }
        const sample = videos.find((video) => video.thumbUrl);
        await ensureThumbMode(source.id, sample && sample.thumbUrl);
        if (signal.aborted || source.id !== currentSource.id) return;
        // The order toggle was flipped while the thumbnails were probed.
        if (orderUsed !== feedOrder) {
            orderUsed = feedOrder;
            videos = Logic.orderFeed(rankingVideos, orderUsed);
        }
        renderVideos(videos);
        currentVideoIndex = 0;
        videoFeed.scrollTo({ top: 0 });
        setLoading(false);
    } catch (err) {
        if (err.name === 'AbortError') return;
        showMessage(`${source.name} を読み込めませんでした`, '通信エラーが発生しました。再読み込みしてください。', retryCurrent);
        setLoading(false);
    } finally {
        isLoading = false;
    }
}

document.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'j') {
        event.preventDefault();
        const next = cardAt(currentVideoIndex + 1);
        if (next) next.scrollIntoView({ behavior: 'smooth' });
    } else if (event.key === 'ArrowUp' || event.key === 'k') {
        event.preventDefault();
        const prev = cardAt(currentVideoIndex - 1);
        if (prev) prev.scrollIntoView({ behavior: 'smooth' });
    } else if (event.key === ' ') {
        event.preventDefault();
        togglePlayPause(currentVideoIndex);
    } else if (event.key === 'm') {
        isMuted = !isMuted;
        updateAllMuteState();
    }
});

async function init() {
    setLoading(true, 'サイトを読み込み中...');
    try {
        const response = await fetch('/api/sources');
        const data = await response.json();
        sources = data.sources || [];
        sourcesRefreshedAt = Date.now();
        playbackConfig = data.playback || playbackConfig;
        if (sources.length === 0) throw new Error('ソースがありません');
        const saved = localStorage.getItem(STORAGE_SOURCE);
        // A source the server no longer has (a removed adapter) is
        // forgotten, so this browser opens on the default from now on.
        if (saved && !sources.some((source) => source.id === saved)) {
            localStorage.removeItem(STORAGE_SOURCE);
        }
        // A source hidden in config/sources.json is not offered, even if it
        // was the last one this browser used. With nothing saved: TwiKeep.
        selectSource(Logic.initialSource(visibleSources(), saved), false);
        renderSourceBar();
        renderPeriodBar();
        await loadVideos();
    } catch (err) {
        showMessage('起動に失敗しました', err.message || 'ソース一覧を取得できませんでした', () => init());
        setLoading(false);
    }
}

init();
