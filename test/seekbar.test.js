const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Logic = require('../src/feed-logic');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

test('formatTime: m:ss, h:mm:ss, and "--:--" for anything unknown', () => {
    assert.equal(Logic.formatTime(0), '0:00');
    assert.equal(Logic.formatTime(5.9), '0:05', 'floors, never rounds up past the real time');
    assert.equal(Logic.formatTime(65), '1:05');
    assert.equal(Logic.formatTime(599.99), '9:59');
    assert.equal(Logic.formatTime(600), '10:00');
    assert.equal(Logic.formatTime(3599), '59:59');
    assert.equal(Logic.formatTime(3600), '1:00:00');
    assert.equal(Logic.formatTime(3661), '1:01:01');
    assert.equal(Logic.formatTime(36000 + 59), '10:00:59');
    for (const bad of [NaN, Infinity, -Infinity, -1, null, undefined, '12', {}]) {
        assert.equal(Logic.formatTime(bad), Logic.UNKNOWN_TIME, String(bad));
    }
    assert.equal(Logic.UNKNOWN_TIME, '--:--');
});

test('seekInfo: a normal video (direct MP4, HLS VOD, relayed MP4)', () => {
    const info = Logic.seekInfo({ duration: 120, currentTime: 30 });
    assert.equal(info.canSeek, true);
    assert.equal(info.live, false);
    assert.equal(info.start, 0);
    assert.equal(info.end, 120);
    assert.equal(info.position, 0.25);
    assert.equal(info.currentText, '0:30');
    assert.equal(info.totalText, '2:00');
    assert.equal(Logic.seekbarState(info, false), 'active');

    // currentTime a hair past the duration (end of stream) stays at 100%.
    const over = Logic.seekInfo({ duration: 10, currentTime: 10.4 });
    assert.equal(over.position, 1);
    assert.equal(over.currentText, '0:10');
    // A negative or junk currentTime is 0.
    assert.equal(Logic.seekInfo({ duration: 10, currentTime: -3 }).position, 0);
    assert.equal(Logic.seekInfo({ duration: 10, currentTime: NaN }).currentText, '0:00');
});

test('seekInfo: nothing loaded, unknown length or live never throws', () => {
    for (const timing of [null, undefined, {}, { duration: NaN }, { duration: 0 }, { duration: -5 }, { duration: 'x' }]) {
        const info = Logic.seekInfo(timing);
        assert.equal(info.canSeek, false, JSON.stringify(timing));
        assert.equal(info.position, 0);
        assert.equal(info.totalText, '--:--');
        assert.equal(Logic.seekbarState(info, false), 'disabled');
    }

    // Live HLS: duration Infinity, but a seekable window -> seek inside it.
    const live = Logic.seekInfo({ duration: Infinity, currentTime: 150, seekableStart: 100, seekableEnd: 200 });
    assert.equal(live.canSeek, true);
    assert.equal(live.live, true);
    assert.equal(live.start, 100);
    assert.equal(live.end, 200);
    assert.equal(live.position, 0.5);
    assert.equal(live.totalText, 'LIVE');
    assert.equal(live.currentText, '2:30');

    // Live with no usable window: shown, not draggable.
    const bare = Logic.seekInfo({ duration: Infinity, currentTime: 12, seekableStart: NaN, seekableEnd: NaN });
    assert.equal(bare.canSeek, false);
    assert.equal(bare.totalText, 'LIVE');
    assert.equal(bare.currentText, '0:12');
    const tiny = Logic.seekInfo({ duration: Infinity, seekableStart: 5, seekableEnd: 5.5 });
    assert.equal(tiny.canSeek, false, 'a window under a second is not a seek range');
    // Unknown duration but the browser knows a seekable range.
    const ranged = Logic.seekInfo({ duration: NaN, currentTime: 0, seekableStart: 0, seekableEnd: 40 });
    assert.equal(ranged.canSeek, true);
    assert.equal(ranged.end, 40);
});

test('seekRatio: pointer x on the track -> 0..1, clamped', () => {
    assert.equal(Logic.seekRatio(150, 100, 200), 0.25);
    assert.equal(Logic.seekRatio(100, 100, 200), 0);
    assert.equal(Logic.seekRatio(300, 100, 200), 1);
    assert.equal(Logic.seekRatio(50, 100, 200), 0, 'left of the track');
    assert.equal(Logic.seekRatio(900, 100, 200), 1, 'a drag past the right edge');
    assert.equal(Logic.seekRatio(150, 100, 0), 0, 'a zero-width track (hidden)');
    assert.equal(Logic.seekRatio(NaN, 100, 200), 0);
    assert.equal(Logic.seekRatio(150, NaN, 200), 0);
});

test('seekTarget / clampSeekTime: seconds to seek to, never onto the last frame', () => {
    const info = Logic.seekInfo({ duration: 100, currentTime: 0 });
    assert.equal(Logic.seekTarget(0, info), 0);
    assert.equal(Logic.seekTarget(0.5, info), 50);
    assert.equal(Logic.seekTarget(1, info), 100 - Logic.SEEK_END_GUARD, 'the end would fire "ended" and loop');
    assert.equal(Logic.seekTarget(-1, info), 0);
    assert.equal(Logic.seekTarget(7, info), 100 - Logic.SEEK_END_GUARD);
    assert.equal(Logic.seekTarget(NaN, info), 0);

    // A clip shorter than the guard can still reach its end.
    const short = Logic.seekInfo({ duration: 0.6 });
    assert.equal(Logic.seekTarget(1, short), 0.6);

    const live = Logic.seekInfo({ duration: Infinity, currentTime: 150, seekableStart: 100, seekableEnd: 200 });
    assert.equal(Logic.seekTarget(0, live), 100, 'the start of the live window');
    assert.equal(Logic.seekTarget(0.5, live), 150);

    const none = Logic.seekInfo(null);
    assert.equal(Logic.seekTarget(0.5, none), null, 'nothing to seek');
    assert.equal(Logic.seekTarget(0.5, null), null);
    assert.equal(Logic.clampSeekTime(50, none), null);
    assert.equal(Logic.clampSeekTime(NaN, info), null);
    assert.equal(Logic.clampSeekTime(-4, info), 0);
    assert.equal(Logic.clampSeekTime(500, info), 100 - Logic.SEEK_END_GUARD);
    assert.equal(Logic.clampSeekTime(42, info), 42);
});

test('seekPosition and seekBy (keyboard ±5 s)', () => {
    const info = Logic.seekInfo({ duration: 60, currentTime: 10 });
    assert.equal(Logic.seekPosition(30, info), 0.5);
    assert.equal(Logic.seekPosition(-5, info), 0);
    assert.equal(Logic.seekPosition(99, info), 1);
    assert.equal(Logic.seekPosition(30, Logic.seekInfo(null)), 0);

    assert.equal(Logic.SEEK_STEP, 5);
    assert.equal(Logic.seekBy(info, 10, Logic.SEEK_STEP), 15);
    assert.equal(Logic.seekBy(info, 2, -Logic.SEEK_STEP), 0);
    assert.equal(Logic.seekBy(info, 58, Logic.SEEK_STEP), 60 - Logic.SEEK_END_GUARD);
    assert.equal(Logic.seekBy(Logic.seekInfo({}), 10, 5), null);
    assert.equal(Logic.seekBy(info, 10, NaN), null);
});

test('seekbarState: hidden for an embed, disabled until something seekable is loaded', () => {
    const playing = Logic.seekInfo({ duration: 30, currentTime: 1 });
    assert.equal(Logic.seekbarState(playing, true), 'hidden', 'the iframe player cannot be seeked from here');
    assert.equal(Logic.seekbarState(Logic.seekInfo(null), true), 'hidden');
    assert.equal(Logic.seekbarState(playing, false), 'active');
    assert.equal(Logic.seekbarState(Logic.seekInfo(null), false), 'disabled');
    assert.equal(Logic.seekbarState(null, false), 'disabled');
});

test('main.js: every card has a seek bar on its own <video>, kept apart from swipe and double tap', () => {
    const main = read('src', 'main.js');
    assert.match(main, /class="video-seek disabled" role="slider"/);
    assert.match(main, /class="seek-current"/);
    assert.match(main, /class="seek-total"/);
    assert.match(main, /bindSeekbar\(card\);/, 'bound once per card, for any playback step');
    // The bar reads the card's <video>, which direct / playlist-proxy / proxy all use.
    assert.match(main, /Logic\.seekInfo\(\{\s*duration: media\.duration,/);
    assert.match(main, /media\.seekable/);
    // Gesture separation.
    assert.match(main, /bar\.addEventListener\('pointerdown', \(event\) => \{\s*event\.stopPropagation\(\);/);
    assert.match(main, /bar\.setPointerCapture\(event\.pointerId\)/);
    assert.match(main, /bar\.addEventListener\('pointercancel', \(event\) => endDrag\(event, false\)\)/);
    assert.match(main, /lastTapTime = 0;/, 'a seek tap never completes a double-tap like');
    assert.match(main, /if \(commit\) seekMedia\(media, Logic\.clampSeekTime\(time, mediaTiming\(media\)\)\)/, 'the seek happens on release');
    // Embed hides it; stopping a card shows it again.
    assert.match(main, /No seek bar on embeds|no seek bar on embeds/);
    assert.match(main, /const seek = card\.querySelector\('\.video-seek'\);\s*if \(seek\) seek\.style\.display = 'none';/);
    assert.match(main, /const seek = card\.querySelector\('\.video-seek'\);\s*if \(seek\) seek\.style\.display = '';/);
    // Keyboard on a computer.
    assert.match(main, /event\.key === 'ArrowLeft' \|\| event\.key === 'ArrowRight'/);
    // Existing controls are still wired.
    assert.match(main, /all\('\.sound-btn'\)/);
    assert.match(main, /togglePlayPause\(index\);/);
    assert.match(main, /likeVideo\(index, true\);/);
    assert.doesNotMatch(main, /startProgressTracking/);
});

test('style.css: the seek strip takes its own touches and does not cover the info text', () => {
    const css = read('src', 'style.css');
    const block = css.match(/\.video-seek \{[^}]*\}/);
    assert.ok(block, '.video-seek rule');
    assert.match(block[0], /touch-action: none;/, 'a drag on the bar never scrolls the feed');
    assert.match(block[0], /z-index: 12;/, 'above the play/pause layer (z-index 5)');
    assert.match(css, /\.video-seek\.disabled \{[^}]*pointer-events: none;/, 'a disabled bar lets taps through');
    assert.doesNotMatch(css, /\.video-progress/);
});
