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
const resolvedCache = new Map();

function mediaProxy(sourceId, url) {
    if (!url) return '';
    return `/proxy/media?source=${encodeURIComponent(sourceId)}&url=${encodeURIComponent(url)}`;
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

function renderSourceBar() {
    sourceBar.replaceChildren();
    sources.forEach((source) => {
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

    const poster = video.thumbUrl ? mediaProxy(currentSource.id, video.thumbUrl) : '';
    const chipColor = safeColor(currentSource.color);

    card.innerHTML = `
    <div class="video-wrapper">
      <video loop muted playsinline preload="none" ${poster ? `poster="${poster.replace(/"/g, '')}"` : ''}></video>
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
        media.pause();
        media.removeAttribute('src');
        media.style.display = '';
        media.load();
    }
    const frame = card.querySelector('iframe.embed-player');
    if (frame) frame.remove();
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

async function resolvePlayback(video) {
    const key = `${currentSource.id}:${video.id}`;
    if (resolvedCache.has(key)) return resolvedCache.get(key);
    const response = await fetch(`/api/resolve?source=${encodeURIComponent(currentSource.id)}&id=${encodeURIComponent(video.id)}`);
    const data = await response.json();
    if (!data.ok || !data.playback) {
        if (video.playback.embedUrl) {
            return { kind: 'embed', url: video.playback.embedUrl, embedUrl: video.playback.embedUrl };
        }
        throw new Error(data.error || '再生情報を取得できませんでした');
    }
    resolvedCache.set(key, data.playback);
    return data.playback;
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
        frame.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');
        wrapper.appendChild(frame);
    }
    if (frame.src !== embedUrl) frame.src = embedUrl;
    const overlay = card.querySelector('.play-pause-overlay');
    if (overlay) overlay.style.display = 'none';
    const progress = card.querySelector('.video-progress');
    if (progress) progress.style.display = 'none';
}

function mountFile(card, index, url) {
    const media = card.querySelector('video');
    media.style.display = '';
    media.src = url;
    media.muted = isMuted;
    const playPromise = media.play();
    if (playPromise) {
        playPromise.then(() => showPlayIcon(index, false, false)).catch(() => showPlayIcon(index, true, true));
    }
    startProgressTracking(media, index);
    media.onerror = () => {
        const embedUrl = videos[index] && videos[index].playback.embedUrl;
        if (embedUrl) {
            showCardMessage(card, '直接再生できないため、埋め込みプレイヤーに切り替えます');
            mountEmbed(card, embedUrl);
        } else {
            showCardMessage(card, 'この動画を再生できませんでした');
        }
    };
}

function mountHls(card, index, url) {
    const media = card.querySelector('video');
    media.style.display = '';
    const embedUrl = videos[index] && videos[index].playback.embedUrl;
    const fail = () => {
        if (card._hls) {
            card._hls.destroy();
            card._hls = null;
        }
        if (embedUrl) {
            showCardMessage(card, 'HLSを再生できないため、埋め込みプレイヤーに切り替えます');
            mountEmbed(card, embedUrl);
        } else {
            showCardMessage(card, 'この動画を再生できませんでした');
        }
    };

    if (media.canPlayType('application/vnd.apple.mpegurl')) {
        mountFile(card, index, url);
        return;
    }
    if (!window.Hls || !window.Hls.isSupported()) {
        fail();
        return;
    }
    const hls = new window.Hls({ enableWorker: true });
    card._hls = hls;
    hls.loadSource(url);
    hls.attachMedia(media);
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        media.muted = isMuted;
        media.play().then(() => showPlayIcon(index, false, false)).catch(() => showPlayIcon(index, true, true));
        startProgressTracking(media, index);
    });
    hls.on(window.Hls.Events.ERROR, (_, data) => {
        if (data && data.fatal) fail();
    });
}

async function playCard(index) {
    const card = cardAt(index);
    const video = videos[index];
    if (!card || !video) return;
    if (activePlay === index) return;
    activePlay = index;
    const token = ++playToken;
    currentVideoIndex = index;
    videoFeed.querySelectorAll('.video-card').forEach((other, otherIndex) => {
        if (otherIndex !== index) stopCard(other);
    });
    let playback = video.playback;
    try {
        if (playback.kind === 'resolve') playback = await resolvePlayback(video);
    } catch (err) {
        if (token !== playToken) return;
        activePlay = -1;
        if (video.playback.embedUrl) {
            mountEmbed(card, video.playback.embedUrl);
            return;
        }
        showCardMessage(card, err.message || '再生情報を取得できませんでした');
        showPlayIcon(index, true, true);
        return;
    }
    if (token !== playToken || currentVideoIndex !== index) return;

    const kind = playback.kind === 'hls' || (playback.url && /\.m3u8(\?|$)/i.test(playback.url))
        ? 'hls'
        : playback.kind;
    if (kind === 'embed' || (!playback.url && playback.embedUrl)) {
        mountEmbed(card, playback.embedUrl || playback.url);
        return;
    }
    const proxied = mediaProxy(currentSource.id, playback.url);
    if (kind === 'hls') mountHls(card, index, proxied);
    else mountFile(card, index, proxied);

    const indicator = document.getElementById('scrollIndicator');
    if (indicator && index > 0) indicator.classList.add('hidden');
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

function setupEventListeners() {
    videoFeed.querySelectorAll('.play-pause-overlay').forEach((overlay) => {
        overlay.addEventListener('click', (event) => {
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
