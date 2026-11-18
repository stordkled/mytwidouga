/* Pure feed decisions shared by src/main.js (window.FeedLogic) and the
   Node tests (require). No DOM access here. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.FeedLogic = api;
}(typeof self !== 'undefined' ? self : this, () => {
    function videosUrl(sourceId, period, metric) {
        let url = `/api/videos?source=${encodeURIComponent(sourceId)}&period=${encodeURIComponent(period || '')}`;
        if (metric) url += `&metric=${encodeURIComponent(metric)}`;
        return url;
    }

    // The source id is the video's own, never "whatever is selected now":
    // a late re-resolve after a source switch must not ask the new source
    // for the old source's video id.
    function resolveUrl(sourceId, videoId, fresh) {
        return `/api/resolve?source=${encodeURIComponent(sourceId)}&id=${encodeURIComponent(videoId)}${fresh ? '&fresh=1' : ''}`;
    }

    // Sources for the switcher: the non-hidden ones, plus the current one so
    // the user can see where they are. If every source is hidden, show all
    // (the user may still pick one by hand).
    function barSources(sources, currentId) {
        const all = sources || [];
        // Only the current one (or nothing) left visible: that is "every
        // source hidden" from the user's point of view, so offer them all.
        if (!all.some((source) => !source.hidden)) return all.slice();
        return all.filter((source) => !source.hidden || source.id === currentId);
    }

    // The source a page opens on. The one this browser saved, if it is still
    // offered; otherwise TwiKeep; otherwise the first offered one. A saved id
    // the server no longer has (a removed source) or a hidden one falls
    // through to the default instead of failing.
    const DEFAULT_SOURCE_ID = 'twikeep';

    function initialSource(offered, savedId) {
        const list = offered || [];
        return list.find((source) => source.id === savedId)
            || list.find((source) => source.id === DEFAULT_SOURCE_ID)
            || list[0]
            || null;
    }

    // Merge a fresh /api/sources answer into the client list: the server's
    // hidden flag (which clears after hiddenRetryMs) wins, so a hidden
    // source comes back on an open page without a reload.
    function mergeSourceStatus(sources, fresh) {
        const byId = new Map((fresh || []).map((source) => [source.id, source]));
        return (sources || []).map((source) => {
            const update = byId.get(source.id);
            if (!update) return source;
            return { ...source, hidden: Boolean(update.hidden), retryLater: Boolean(update.retryLater) };
        });
    }

    // How often an open page re-asks /api/sources while a source is hidden
    // only for a while (config-hidden ones never come back, so no polling).
    const SOURCES_REFRESH_MS = 60000;

    function needsSourceRefresh(sources, lastRefreshAt, now) {
        if (!(sources || []).some((source) => source.hidden && source.retryLater)) return false;
        return !lastRefreshAt || now - lastRefreshAt >= SOURCES_REFRESH_MS;
    }

    // Where to go automatically after `currentId` failed. Never a hidden
    // source and never one that already failed in this chain, so when every
    // source fails the feed stops instead of cycling through them.
    function fallbackSource(sources, currentId, failedIds) {
        const failed = failedIds instanceof Set ? failedIds : new Set(failedIds || []);
        return (sources || []).find((source) => (
            source.id !== currentId && !source.hidden && !failed.has(source.id)
        )) || null;
    }

    const REASONS = {
        blocked: 'このネットワークから開けません',
        timeout: '応答がありません',
        empty: 'ランキングが空でした',
        http: 'サイトがエラーを返しました',
        error: '読み込みに失敗しました',
    };

    function reasonText(reason) {
        return REASONS[reason] || REASONS.error;
    }

    // Shown in the note bar when the feed moves to another source by itself.
    function switchNote(fromName, toName, reason, hidden) {
        const tail = hidden ? '（しばらく非表示）' : '';
        return `${fromName}: ${reasonText(reason)}${tail} → ${toName} に切り替えました`;
    }

    function joinNotes(...notes) {
        return notes.filter(Boolean).join(' / ');
    }

    // Is a playback attempt still the one on screen?
    function playbackCurrent(attempt, now) {
        return Boolean(attempt && now
            && attempt.token === now.token
            && attempt.index === now.index
            && attempt.sourceId === now.sourceId);
    }

    // After a failed ladder step: fetch a fresh URL once, but only for
    // "resolve" videos and only while this attempt is still on screen.
    function shouldReResolve({ ok, mode, alreadyResolved, kind, current }) {
        return !ok && mode !== 'embed' && !alreadyResolved && kind === 'resolve' && Boolean(current);
    }

    // A <video> that has no data after this long, or that the browser has
    // already given up on (NETWORK_NO_SOURCE), is a failed step. Longer than
    // the relay queue wait (proxyQueueMs, 8 s) so a queued proxy still counts.
    const STALL_MS = 12000;

    function mediaStalled({ readyState, networkState, elapsedMs }) {
        if (readyState >= 1) return false;
        if (networkState === 3) return true;
        return elapsedMs >= STALL_MS;
    }

    function nextMetric(metrics, current) {
        const list = (metrics || []).map((metric) => metric.id);
        if (list.length === 0) return '';
        const at = list.indexOf(current);
        return list[(at + 1) % list.length];
    }

    function pickMetric(source, saved) {
        if (!source || !Array.isArray(source.metrics) || source.metrics.length === 0) return '';
        if (source.metrics.some((metric) => metric.id === saved)) return saved;
        return source.defaultMetric || source.metrics[0].id;
    }

    return {
        videosUrl,
        resolveUrl,
        barSources,
        DEFAULT_SOURCE_ID,
        initialSource,
        mergeSourceStatus,
        needsSourceRefresh,
        SOURCES_REFRESH_MS,
        fallbackSource,
        reasonText,
        switchNote,
        joinNotes,
        playbackCurrent,
        shouldReResolve,
        mediaStalled,
        STALL_MS,
        nextMetric,
        pickMetric,
    };
}));
