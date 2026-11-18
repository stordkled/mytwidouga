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

let sources = [];
let currentSource = null;
let currentPeriod = '';
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
    const shown = sources.filter((source) => !source.hidden);
    return shown.length ? shown : sources;
}

function renderSourceBar() {
    sourceBar.replaceChildren();
    visibleSources().forEach((source) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'source-btn' + (source.id === currentSource.id ? ' active' : '');
        button.textContent = source.name;
        button.style.borderColor = source.id === currentSource.id ? 'transparent' : safeColor(source.color);
        button.setAttribute('aria-pressed', source.id === currentSource.id ? 'true' : 'false');
        button.addEventListener('click', () => {
            if (source.id === currentSource.id) return;
            currentSource = source;
            const saved = localStorage.getItem(STORAGE_PERIOD + source.id);
            currentPeriod = source.periods.some((period) => period.id === saved)
                ? saved
                : source.periods[0].id;
            localStorage.setItem(STORAGE_SOURCE, source.id);
            resolvedCache.clear();
            renderSourceBar();
            renderPeriodBar();
            loadVideos();
        });
        sourceBar.appendChild(button);
    });
}

function renderPeriodBar() {
    bottomNav.replaceChildren();
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
}

function showMessage(title, message, onRetry) {
    videoFeed.replaceChildren();
    const wrap = document.createElement('div');
    wrap.className = 'error-state';
    const icon = document.createElement('i');
    icon.className = 'fas fa-exclamation-triangle';
    const heading = document.createElement('h3');
    heading.textContent = title;
    const paragraph = document.createElement('p');
    paragraph.textContent = message;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '再読み込み';
    button.addEventListener('click', onRetry);
    wrap.append(icon, heading, paragraph, button);
    videoFeed.appendChild(wrap);
}

function createVideoCard(video, index) {
    const card = document.createElement('div');
    card.className = 'video-card';
    card.dataset.index = String(index);

    const poster = posterFor(currentSource.id, video.thumbUrl);
    const chipColor = safeColor(currentSource.color);

    card.innerHTML = `
    <div class="video-wrapper">
      <video muted playsinline preload="none" referrerpolicy="no-referrer" ${poster ? `poster="${poster.replace(/"/g, '')}"` : ''}></video>
    </div>
    <div class="gradient-top"></div>
    <div class="gradient-bottom"></div>
    <div class="ranking-badge ${rankClass(video.rank)}">
      <i class="fas ${rankIcon(video.rank)} rank-icon"></i>
      <span></span>
    </div>
    <div class="play-pause-overlay" data-index="${index}">
      <div class="play-icon" id="playIcon-${index}"><i class="fas fa-play"></i></div>
    </div>
    <div class="side-actions">
      <button class="action-btn like-btn" type="button">
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
    sourceChip.querySelector('span').textContent = currentSource.name;
    sourceChip.style.color = chipColor;
    sourceChip.style.borderColor = chipColor;
    sourceChip.style.background = 'rgba(255,255,255,0.06)';
    card.querySelector('.info-title').textContent = video.title || `ランキング ${video.rankLabel || video.rank}`;
    const meta = [video.duration, video.views].filter(Boolean).join(' · ');
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

function stopCard(card) {
    if (!card) return;
    if (card._hls) {
        card._hls.destroy();
        card._hls = null;
    }
    const media = card.querySelector('video');
    if (media) {
        media.onerror = null;
        media.pause();
        media.removeAttribute('src');
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
    if (!progressFill) return;
    const update = () => {
        if (media.duration) progressFill.style.width = ((media.currentTime / media.duration) * 100) + '%';
        if (!media.paused) requestAnimationFrame(update);
    };
    requestAnimationFrame(update);
}

function resolvedKey(video) {
    return `${currentSource.id}:${video.id}`;
}

function cachedPlayback(video) {
    const hit = resolvedCache.get(resolvedKey(video));
    if (!hit) return null;
    if (hit.expires <= Date.now()) {
        resolvedCache.delete(resolvedKey(video));
        return null;
    }
    return hit.playback;
}

function rememberPlayback(video, playback) {
    resolvedCache.set(resolvedKey(video), { playback, expires: Date.now() + RESOLVE_TTL_MS });
}

function forgetPlayback(video) {
    if (video && currentSource) resolvedCache.delete(resolvedKey(video));
}

async function resolvePlayback(video, fresh) {
    if (video.playback.kind !== 'resolve') return video.playback;
    const response = await fetch(`/api/resolve?source=${encodeURIComponent(currentSource.id)}&id=${encodeURIComponent(video.id)}${fresh ? '&fresh=1' : ''}`);
    const data = await response.json();
    if (!data.ok || !data.playback) {
        if (video.playback.embedUrl) {
            return { kind: 'embed', url: video.playback.embedUrl, embedUrl: video.playback.embedUrl };
        }
        throw new Error(data.error || '再生情報を取得できませんでした');
    }
    if (data.playback.embedUrl) video.playback.embedUrl = data.playback.embedUrl;
    return data.playback;
}

function failDirectPlayback(card, index, embedUrl, message) {
    forgetPlayback(videos[index]);
    activePlay = -1;
    const media = card.querySelector('video');
    if (media) {
        media.onerror = null;
        media.removeAttribute('src');
    }
    if (embedUrl) {
        mountEmbed(card, embedUrl);
        return;
    }
    showCardMessage(card, message);
    showPlayIcon(index, true, true);
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

function waitUntilPlaying(media, timeout = 8000) {
    return new Promise((resolve) => {
        if (media.error) {
            resolve(false);
            return;
        }
        const timer = setTimeout(() => finish(false), timeout);
        const ok = () => finish(!media.error && media.currentTime > 0);
        const bad = () => finish(false);
        function finish(success) {
            clearTimeout(timer);
            media.removeEventListener('timeupdate', ok);
            media.removeEventListener('error', bad);
            resolve(success);
        }
        media.addEventListener('timeupdate', ok);
        media.addEventListener('error', bad);
    });
}

function mountFile(card, index, url) {
    const media = card.querySelector('video');
    media.style.display = '';
    prepareVideo(media);
    const started = waitUntilPlaying(media);
    media.src = url;
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
    const media = card.querySelector('video');
    if (media) {
        media.onerror = null;
        media.pause();
        media.removeAttribute('src');
    }
}

async function tryMode(mode, playback, card, index) {
    clearMedia(card);
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
        played = await mountHls(card, index, playlistProxy(currentSource.id, playback.url));
    } else if (mode === 'proxy') {
        const proxied = mediaProxy(currentSource.id, playback.url);
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

    const forced = (playbackConfig.sources && playbackConfig.sources[currentSource.id]) || playbackConfig.mode || 'auto';
    let playback = video.playback;
    try {
        playback = await resolvePlayback(video, false);
    } catch (err) {
        playback = { kind: 'embed', url: video.playback.embedUrl, embedUrl: video.playback.embedUrl, error: err.message };
    }
    if (token !== playToken || currentVideoIndex !== index) return;

    let modes = modesFor(forced, isHls(playback), playbackNeedsProxy(playback));
    const known = sourceStrategy.get(currentSource.id);
    if (known && !playback.needsReferer) {
        const at = modes.indexOf(known);
        if (at > 0) modes = modes.slice(at);
    }

    let resolvedOnceMore = false;
    let steps = 0;
    for (let i = 0; i < modes.length && steps < MAX_LADDER_STEPS; i += 1) {
        const mode = modes[i];
        steps += 1;
        if (token !== playToken || currentVideoIndex !== index) return;
        await yieldToBrowser();
        if (token !== playToken || currentVideoIndex !== index) return;
        let ok = await tryMode(mode, playback, card, index);
        if (!ok && mode !== 'embed' && !resolvedOnceMore && video.playback.kind === 'resolve') {
            resolvedOnceMore = true;
            try {
                playback = await resolvePlayback(video, true);
            } catch { /* keep the previous URL */ }
            if (token !== playToken || currentVideoIndex !== index) return;
            modes = modesFor(forced, isHls(playback), playbackNeedsProxy(playback));
            i = -1;
            continue;
        }
        if (ok) {
            if (forced === 'auto') sourceStrategy.set(currentSource.id, mode);
            showPlayIcon(index, false, false);
            const indicator = document.getElementById('scrollIndicator');
            if (indicator && index > 0) indicator.classList.add('hidden');
            preloadNext(index);
            return;
        }
        clearMedia(card);
    }
    if (token !== playToken) return;
    activePlay = -1;
    showCardMessage(card, 'この動画を再生できませんでした');
    showPlayIcon(index, true, true);
}

function preloadNext(index) {
    const next = videos[index + 1];
    const card = cardAt(index + 1);
    if (!next || !card || next._preloading || next._preloaded) return;
    const mode = sourceStrategy.get(currentSource.id);
    if (mode === 'proxy') return;
    next._preloading = true;
    resolvePlayback(next, false).then((playback) => {
        next._preloaded = true;
        if (currentVideoIndex !== index) return;
        if (mode === 'embed' || (playback && playback.kind === 'embed')) {
            const embedUrl = (playback && (playback.embedUrl || playback.url)) || next.playback.embedUrl;
            if (embedUrl && !card.querySelector('iframe.embed-player')) mountEmbed(card, embedUrl);
            return;
        }
        if (!playback || !playback.url || mode === 'proxy') return;
        const media = card.querySelector('video');
        if (!media || media.getAttribute('src')) return;
        prepareVideo(media);
        media.preload = 'metadata';
        if (!isHls(playback) && (mode === 'direct' || !mode)) media.src = playback.url;
    }).catch(() => {
        next._preloaded = true;
    });
}

function setupObserver() {
    const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            const index = Number(entry.target.dataset.index);
            if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
                playCard(index);
            } else if (index !== currentVideoIndex) {
                stopCard(entry.target);
            }
        });
    }, { threshold: [0.6], root: videoFeed });
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

function setupEventListeners() {
    videoFeed.querySelectorAll('.play-pause-overlay').forEach((overlay) => {
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
                const like = card.querySelector('.like-btn');
                if (like) like.classList.add('liked');
                return;
            }
            lastTapTime = now;
            togglePlayPause(index);
        });
    });

    videoFeed.querySelectorAll('.like-btn').forEach((button) => {
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            button.classList.toggle('liked');
        });
    });

    videoFeed.querySelectorAll('.sound-btn').forEach((button) => {
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            isMuted = !isMuted;
            updateAllMuteState();
        });
    });

    videoFeed.querySelectorAll('.share-btn').forEach((button, index) => {
        button.addEventListener('click', async (event) => {
            event.stopPropagation();
            const video = videos[index];
            const url = (video && (video.externalUrl || video.pageUrl)) || location.href;
            if (navigator.share) {
                try { await navigator.share({ title: currentSource.name, url }); } catch { /* dismissed */ }
            } else {
                await navigator.clipboard.writeText(url);
                const label = button.querySelector('.btn-label');
                label.textContent = 'コピー済';
                setTimeout(() => { label.textContent = '共有'; }, 1500);
            }
        });
    });

    videoFeed.querySelectorAll('.origin-btn').forEach((button, index) => {
        button.addEventListener('click', async (event) => {
            event.stopPropagation();
            const video = videos[index];
            if (!video) return;
            if (video.lookup) {
                try {
                    const response = await fetch(`/api/external?source=${encodeURIComponent(currentSource.id)}&id=${encodeURIComponent(video.id)}`);
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

async function loadVideos() {
    if (!currentSource) return;
    if (loadController) loadController.abort();
    loadController = new AbortController();
    const { signal } = loadController;
    const source = currentSource;
    const period = currentPeriod;
    isLoading = true;
    stopAll();
    setFallbackNote('');
    setLoading(true, `${source.name} を読み込み中...`);

    try {
        const response = await fetch(`/api/videos?source=${encodeURIComponent(source.id)}&period=${encodeURIComponent(period)}`, { signal });
        const data = await response.json();
        if (signal.aborted || source.id !== currentSource.id) return;
        if (!data.ok) {
            if (data.source) {
                const listed = sources.find((item) => item.id === data.source.id);
                if (listed) listed.hidden = !!data.source.hidden;
            }
            if (data.hidden) {
                renderSourceBar();
                const next = visibleSources().find((item) => item.id !== source.id);
                if (next && visibleSources().some((item) => item.id === next.id) && sources.some((item) => item.hidden)) {
                    currentSource = next;
                    const savedPeriod = localStorage.getItem(STORAGE_PERIOD + next.id);
                    currentPeriod = next.periods.some((period) => period.id === savedPeriod) ? savedPeriod : next.periods[0].id;
                    localStorage.setItem(STORAGE_SOURCE, next.id);
                    renderSourceBar();
                    renderPeriodBar();
                    setFallbackNote(`${source.name} はこのネットワークから開けないため非表示にしました`);
                    setLoading(false);
                    isLoading = false;
                    loadVideos();
                    return;
                }
            }
            showMessage(`${source.name} を読み込めませんでした`, data.error || '不明なエラー', () => loadVideos());
            setLoading(false);
            return;
        }
        videos = data.videos || [];
        setFallbackNote(data.fallback ? data.fallbackReason : '');
        if (videos.length === 0) {
            showMessage('動画が見つかりませんでした', 'しばらくしてからもう一度お試しください', () => loadVideos());
            setLoading(false);
            return;
        }
        const sample = videos.find((video) => video.thumbUrl);
        await ensureThumbMode(source.id, sample && sample.thumbUrl);
        if (signal.aborted || source.id !== currentSource.id) return;
        renderVideos(videos);
        currentVideoIndex = 0;
        videoFeed.scrollTo({ top: 0 });
        setLoading(false);
    } catch (err) {
        if (err.name === 'AbortError') return;
        showMessage(`${source.name} を読み込めませんでした`, '通信エラーが発生しました。再読み込みしてください。', () => loadVideos());
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
        playbackConfig = data.playback || playbackConfig;
        if (sources.length === 0) throw new Error('ソースがありません');
        const saved = localStorage.getItem(STORAGE_SOURCE);
        currentSource = sources.find((source) => source.id === saved) || sources[0];
        const savedPeriod = localStorage.getItem(STORAGE_PERIOD + currentSource.id);
        currentPeriod = currentSource.periods.some((period) => period.id === savedPeriod)
            ? savedPeriod
            : currentSource.periods[0].id;
        renderSourceBar();
        renderPeriodBar();
        await loadVideos();
    } catch (err) {
        showMessage('起動に失敗しました', err.message || 'ソース一覧を取得できませんでした', () => init());
        setLoading(false);
    }
}

init();
