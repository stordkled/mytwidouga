/* Offset-aware Pornhub fallback. The parent card still handles feed gestures. */
(() => {
    const media = document.getElementById('player');
    const config = JSON.parse(document.getElementById('playback').textContent);
    const error = document.getElementById('error');
    const startAt = () => window.FeedLogic.startPosition(config.offset, media.duration);
    let startPending = true;
    const applyStart = () => {
        if (!startPending || media.readyState < 1 || Number.isNaN(media.duration)) return;
        startPending = false;
        const target = startAt();
        if (target > 0 && media.currentTime < target) media.currentTime = target;
    };
    const play = () => { media.play().catch(() => {}); };
    media.addEventListener('emptied', () => { startPending = true; });
    media.addEventListener('loadedmetadata', applyStart);
    media.addEventListener('durationchange', applyStart);
    media.addEventListener('ended', () => {
        media.currentTime = startAt();
        play();
    });
    media.addEventListener('error', () => { error.hidden = false; });
    if (config.kind === 'hls' && !media.canPlayType('application/vnd.apple.mpegurl')) {
        if (!window.Hls || !window.Hls.isSupported()) {
            error.hidden = false;
            return;
        }
        const hls = new window.Hls({ maxBufferLength: 20, maxMaxBufferLength: 40 });
        hls.on(window.Hls.Events.MANIFEST_PARSED, play);
        hls.on(window.Hls.Events.ERROR, (_, data) => {
            if (data && data.fatal) { error.hidden = false; hls.destroy(); }
        });
        hls.loadSource(config.url);
        hls.attachMedia(media);
    } else {
        media.src = config.url;
        play();
    }
})();
