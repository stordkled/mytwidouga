/* ============================================
   TWIVIDEO Shorts - Main Application
   ============================================ */

// ---- State ----
let videos = [];
let currentSort = '24';
let isMuted = true;
let currentVideoIndex = 0;
let isLoading = false;
let lastTapTime = 0;

const videoFeed = document.getElementById('videoFeed');
const loadingScreen = document.getElementById('loadingScreen');
const bottomNav = document.getElementById('bottomNav');

// ---- Helper: proxy URL through our server ----
function proxyUrl(url) {
    return '/proxy/media?url=' + encodeURIComponent(url);
}

// ---- Parse HTML Response ----
function parseVideoList(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<div>${html}</div>`, 'text/html');
    const items = doc.querySelectorAll('.art_li');
    const result = [];

    items.forEach((item, index) => {
        const link = item.querySelector('a.item_link');
        const img = item.querySelector('img');
        const rankEl = item.querySelector('.item_ranking');

        if (link && img) {
            const videoUrl = link.getAttribute('href');
            const thumbUrl = img.getAttribute('src');
            const rank = rankEl ? rankEl.textContent.trim() : `No.${index + 1}`;
            const dataId = link.getAttribute('data-id') || '';

            result.push({
                id: dataId,
                videoUrl: proxyUrl(videoUrl),
                thumbUrl: proxyUrl(thumbUrl),
                originalVideoUrl: videoUrl,
                rank,
                rankNum: index + 1,
            });
        }
    });

    return result;
}

// ---- Fetch Videos from API ----
async function fetchVideos(sort = '24', offset = 0, limit = 30) {
    const params = new URLSearchParams({ sort, offset, limit });
    const response = await fetch(`/api/videos?${params}`);

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    return parseVideoList(html);
}

// ---- Create Video Card ----
function createVideoCard(video, index) {
    const card = document.createElement('div');
    card.className = 'video-card';
    card.dataset.index = index;
    card.dataset.id = video.id;

    // Determine rank class
    let rankClass = '';
    if (video.rankNum === 1) rankClass = 'rank-1';
    else if (video.rankNum === 2) rankClass = 'rank-2';
    else if (video.rankNum === 3) rankClass = 'rank-3';

    // Rank icon
    let rankIcon = '<i class="fas fa-medal rank-icon"></i>';
    if (video.rankNum === 1) rankIcon = '<i class="fas fa-crown rank-icon"></i>';
    else if (video.rankNum <= 3) rankIcon = '<i class="fas fa-medal rank-icon"></i>';
    else rankIcon = '<i class="fas fa-hashtag rank-icon"></i>';

    card.innerHTML = `
    <div class="video-wrapper">
      <video
        src="${video.videoUrl}"
        poster="${video.thumbUrl}"
        loop
        muted
        playsinline
        preload="auto"
      ></video>
    </div>

    <div class="gradient-top"></div>
    <div class="gradient-bottom"></div>

    <div class="ranking-badge ${rankClass}">
      ${rankIcon}
      <span>${video.rank}</span>
    </div>

    <div class="play-pause-overlay" data-index="${index}">
      <div class="play-icon" id="playIcon-${index}">
        <i class="fas fa-play"></i>
      </div>
    </div>

    <div class="side-actions">
      <button class="action-btn like-btn" data-id="${video.id}">
        <div class="btn-icon"><i class="fas fa-heart"></i></div>
        <span class="btn-label">いいね</span>
      </button>
      <button class="action-btn sound-btn ${isMuted ? 'muted' : ''}">
        <div class="btn-icon"><i class="fas ${isMuted ? 'fa-volume-xmark' : 'fa-volume-high'}"></i></div>
        <span class="btn-label">${isMuted ? 'ミュート' : '音あり'}</span>
      </button>
      <button class="action-btn share-btn" data-url="${video.originalVideoUrl}">
        <div class="btn-icon"><i class="fas fa-share"></i></div>
        <span class="btn-label">共有</span>
      </button>
      <button class="action-btn twitter-btn" data-id="${video.id}">
        <div class="btn-icon"><i class="fa-brands fa-x-twitter"></i></div>
        <span class="btn-label">元ポスト</span>
      </button>
    </div>

    <div class="video-info">
      <div class="info-source">
        <i class="fa-brands fa-x-twitter"></i>
        Twitter/X 動画
      </div>
      <div class="info-title">ランキング ${video.rank} の動画</div>
    </div>

    <div class="video-progress">
      <div class="progress-fill" id="progress-${index}"></div>
    </div>

    ${index === 0 ? `
    <div class="scroll-indicator" id="scrollIndicator">
      <i class="fas fa-chevron-down"></i>
      <span>スワイプして次へ</span>
    </div>
    ` : ''}
  `;

    return card;
}

// ---- Render Videos ----
function renderVideos(videoList) {
    videoFeed.innerHTML = '';
    videoList.forEach((video, index) => {
        const card = createVideoCard(video, index);
        videoFeed.appendChild(card);
    });
    setupObserver();
    setupEventListeners();
}

// ---- Intersection Observer for Auto-play ----
function setupObserver() {
    const observer = new IntersectionObserver(
        (entries) => {
            entries.forEach((entry) => {
                const video = entry.target.querySelector('video');
                const index = parseInt(entry.target.dataset.index);

                if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
                    currentVideoIndex = index;
                    playVideo(video, index);

                    // Hide scroll indicator after first scroll
                    const indicator = document.getElementById('scrollIndicator');
                    if (indicator && index > 0) {
                        indicator.classList.add('hidden');
                    }
                } else {
                    pauseVideo(video, index);
                }
            });
        },
        {
            threshold: [0.5],
            root: videoFeed,
        }
    );

    document.querySelectorAll('.video-card').forEach((card) => {
        observer.observe(card);
    });
}

// ---- Play / Pause ----
function playVideo(video, index) {
    if (!video) return;
    video.muted = isMuted;

    // Add error handler for debugging
    video.onerror = function () {
        console.error('Video error:', video.error, video.src);
    };

    const playPromise = video.play();
    if (playPromise !== undefined) {
        playPromise.then(() => {
            console.log('Playing video #' + index);
        }).catch((err) => {
            console.warn('Auto-play blocked for #' + index + ':', err.message);
            // Show a persistent play icon so user knows to tap
            showPlayIcon(index, true, true);
        });
    }

    // Start progress tracking
    startProgressTracking(video, index);
}

function pauseVideo(video, index) {
    if (!video) return;
    video.pause();
}

function togglePlayPause(index) {
    const card = document.querySelectorAll('.video-card')[index];
    if (!card) return;
    const video = card.querySelector('video');
    if (!video) return;

    if (video.paused) {
        video.muted = isMuted;
        video.play().then(() => {
            showPlayIcon(index, false, false);
        }).catch((err) => {
            console.warn('Play failed:', err.message);
        });
    } else {
        video.pause();
        showPlayIcon(index, true, false);
    }
}

function showPlayIcon(index, isPaused, persistent) {
    const icon = document.getElementById(`playIcon-${index}`);
    if (!icon) return;

    const i = icon.querySelector('i');
    // Show play icon when paused (user needs to click to play)
    // Show pause icon briefly when playing (feedback that it's now playing)
    i.className = isPaused ? 'fas fa-play' : 'fas fa-pause';

    icon.classList.add('visible');
    if (!persistent) {
        setTimeout(() => {
            icon.classList.remove('visible');
        }, 600);
    }
}

// ---- Progress Bar ----
function startProgressTracking(video, index) {
    const progressFill = document.getElementById(`progress-${index}`);
    if (!progressFill) return;

    function update() {
        if (video.duration) {
            const pct = (video.currentTime / video.duration) * 100;
            progressFill.style.width = pct + '%';
        }
        if (!video.paused) {
            requestAnimationFrame(update);
        }
    }
    requestAnimationFrame(update);
}

// ---- Event Listeners ----
function setupEventListeners() {
    // Play/Pause on tap - immediate response, no delay
    document.querySelectorAll('.play-pause-overlay').forEach((overlay) => {
        overlay.addEventListener('click', (e) => {
            const now = Date.now();
            const index = parseInt(overlay.dataset.index);

            // Double-tap → like (within 400ms)
            if (now - lastTapTime < 400) {
                handleDoubleTap(e, index);
                lastTapTime = 0;
                return;
            }

            lastTapTime = now;

            // Single tap → play/pause immediately
            togglePlayPause(index);
        });
    });

    // Like button
    document.querySelectorAll('.like-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            btn.classList.toggle('liked');
        });
    });

    // Sound button
    document.querySelectorAll('.sound-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            isMuted = !isMuted;
            updateAllMuteState();
        });
    });

    // Share button
    document.querySelectorAll('.share-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const url = btn.dataset.url;
            if (navigator.share) {
                try {
                    await navigator.share({ title: 'TWIVIDEO Shorts', url });
                } catch { }
            } else {
                await navigator.clipboard.writeText(url);
                btn.querySelector('.btn-label').textContent = 'コピー済';
                setTimeout(() => {
                    btn.querySelector('.btn-label').textContent = '共有';
                }, 1500);
            }
        });
    });

    // Twitter link button
    document.querySelectorAll('.twitter-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const dataId = btn.dataset.id;
            try {
                const resp = await fetch(`https://twivideo.net/api/link.php?id=${encodeURIComponent(dataId)}`);
                if (resp.ok) {
                    const url = (await resp.text()).trim();
                    if (url) window.open(url, '_blank', 'noopener,noreferrer');
                }
            } catch {
                // fallback: just open twivideo page
            }
        });
    });

    // Bottom nav
    bottomNav.querySelectorAll('.nav-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const sort = btn.dataset.sort;
            if (sort === currentSort) return;
            currentSort = sort;

            bottomNav.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');

            loadVideos(sort);
        });
    });
}

// ---- Double Tap Heart ----
function handleDoubleTap(e, index) {
    // Show heart animation at tap position
    const card = document.querySelectorAll('.video-card')[index];
    if (!card) return;

    const heart = document.createElement('div');
    heart.className = 'double-tap-heart';
    heart.innerHTML = '<i class="fas fa-heart"></i>';

    const rect = card.getBoundingClientRect();
    heart.style.left = (e.clientX - rect.left - 40) + 'px';
    heart.style.top = (e.clientY - rect.top - 40) + 'px';

    card.appendChild(heart);
    setTimeout(() => heart.remove(), 900);

    // Also toggle like button
    const likeBtn = card.querySelector('.like-btn');
    if (likeBtn && !likeBtn.classList.contains('liked')) {
        likeBtn.classList.add('liked');
    }
}

// ---- Mute State ----
function updateAllMuteState() {
    document.querySelectorAll('video').forEach((v) => {
        v.muted = isMuted;
    });

    document.querySelectorAll('.sound-btn').forEach((btn) => {
        const icon = btn.querySelector('.btn-icon i');
        const label = btn.querySelector('.btn-label');
        if (isMuted) {
            btn.classList.add('muted');
            icon.className = 'fas fa-volume-xmark';
            label.textContent = 'ミュート';
        } else {
            btn.classList.remove('muted');
            icon.className = 'fas fa-volume-high';
            label.textContent = '音あり';
        }
    });
}

// ---- Load Videos ----
async function loadVideos(sort = '24') {
    isLoading = true;
    loadingScreen.classList.remove('hidden');

    // Pause all current videos
    document.querySelectorAll('video').forEach((v) => {
        v.pause();
        v.src = '';
    });

    try {
        videos = await fetchVideos(sort, 0, 30);

        if (videos.length === 0) {
            videoFeed.innerHTML = `
        <div class="error-state">
          <i class="fas fa-video-slash"></i>
          <h3>動画が見つかりませんでした</h3>
          <p>しばらくしてからもう一度お試しください</p>
          <button onclick="loadVideos('${sort}')">再読み込み</button>
        </div>
      `;
            loadingScreen.classList.add('hidden');
            return;
        }

        renderVideos(videos);
        currentVideoIndex = 0;

        // Scroll to top
        videoFeed.scrollTo({ top: 0 });

        // Small delay then hide loading
        setTimeout(() => {
            loadingScreen.classList.add('hidden');
        }, 500);
    } catch (err) {
        console.error('Failed to load videos:', err);
        videoFeed.innerHTML = `
      <div class="error-state">
        <i class="fas fa-exclamation-triangle"></i>
        <h3>読み込みに失敗しました</h3>
        <p>通信エラーが発生しました。再読み込みしてください。</p>
        <button onclick="loadVideos('${sort}')">再読み込み</button>
      </div>
    `;
        loadingScreen.classList.add('hidden');
    } finally {
        isLoading = false;
    }
}

// ---- Keyboard Navigation ----
document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        const nextCard = document.querySelectorAll('.video-card')[currentVideoIndex + 1];
        if (nextCard) nextCard.scrollIntoView({ behavior: 'smooth' });
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        const prevCard = document.querySelectorAll('.video-card')[currentVideoIndex - 1];
        if (prevCard) prevCard.scrollIntoView({ behavior: 'smooth' });
    } else if (e.key === ' ') {
        e.preventDefault();
        togglePlayPause(currentVideoIndex);
    } else if (e.key === 'm') {
        isMuted = !isMuted;
        updateAllMuteState();
    }
});

// ---- Init ----
loadVideos('24');
