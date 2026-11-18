const LADDER = ['direct', 'playlist-proxy', 'proxy', 'embed'];

function modesFor({ mode = 'auto', fullProxyEnabled = true, hls = false } = {}) {
    if (mode === 'embed') return ['embed'];
    const start = mode === 'auto' ? 0 : LADDER.indexOf(mode);
    let list = start >= 0 ? LADDER.slice(start) : LADDER.slice();
    if (!fullProxyEnabled) list = list.filter((item) => item !== 'proxy');
    if (!hls) list = list.filter((item) => item !== 'playlist-proxy');
    if (!list.includes('embed')) list.push('embed');
    return list.length ? list : ['embed'];
}

function withAutoplay(url) {
    try {
        const parsed = new URL(url);
        if (!parsed.searchParams.has('autoplay')) parsed.searchParams.set('autoplay', '1');
        if (!parsed.searchParams.has('muted')) parsed.searchParams.set('muted', '1');
        return parsed.href;
    } catch {
        return url;
    }
}

module.exports = { LADDER, modesFor, withAutoplay };
