const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Logic = require('../src/feed-logic');
const mirrors = require('../lib/mirrors');
const sources = require('../sources');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
const ENV = 'SOURCE_START_OFFSET_PORNHUB';

function withEnv(value, run) {
    const before = process.env[ENV];
    process.env[ENV] = value;
    try {
        run();
    } finally {
        if (before === undefined) delete process.env[ENV];
        else process.env[ENV] = before;
    }
}

test('startPosition: the offset, or 0 for a clip too short or of unknown length', () => {
    assert.equal(Logic.startPosition(5, 120), 5);
    assert.equal(Logic.startPosition(5, 6), 5);
    assert.equal(Logic.startPosition(5, 5), 0, 'exactly 5 s starts at 0');
    assert.equal(Logic.startPosition(5, 3), 0);
    assert.equal(Logic.startPosition(5, 5.1), 5, 'just over 5 s starts at 5');
    assert.equal(Logic.startPosition(5, 5 + Logic.SEEK_END_GUARD), 5, 'the end guard does not widen the exception');
    assert.equal(Logic.startPosition(0, 120), 0);
    for (const duration of [NaN, Infinity, undefined, null, '120']) {
        assert.equal(Logic.startPosition(5, duration), 0, String(duration));
    }
    for (const offset of [-1, NaN, Infinity, undefined, null]) {
        assert.equal(Logic.startPosition(offset, 120), 0, String(offset));
    }
});

test('startOffsetFor: reads the per-source value, anything unusable is 0', () => {
    const config = { startOffsets: { pornhub: 5, '85po': 0, bad: 'x', negative: -2 } };
    assert.equal(Logic.startOffsetFor(config, 'pornhub'), 5);
    assert.equal(Logic.startOffsetFor(config, '85po'), 0);
    assert.equal(Logic.startOffsetFor(config, 'bad'), 0);
    assert.equal(Logic.startOffsetFor(config, 'negative'), 0);
    assert.equal(Logic.startOffsetFor(config, 'missing'), 0);
    assert.equal(Logic.startOffsetFor({}, 'pornhub'), 0, 'an older server answer');
    assert.equal(Logic.startOffsetFor(null, 'pornhub'), 0);
});

test('config: Pornhub starts at 5 s and every other source at 0', () => {
    const { startOffsets } = sources.playbackConfig();
    assert.equal(startOffsets.pornhub, 5);
    for (const id of ['85po', 'twivideo', 'twikeep', 'tokyomotion', 'twihozon']) {
        assert.equal(startOffsets[id], 0, id);
    }
});

test('SOURCE_START_OFFSET_<ID> overrides the file, and a bad value is ignored', () => {
    withEnv('12', () => assert.equal(mirrors.startOffsetFor('pornhub'), 12));
    withEnv('0', () => assert.equal(mirrors.startOffsetFor('pornhub'), 0));
    for (const bad of ['abc', '-3', '', '  ']) {
        withEnv(bad, () => assert.equal(mirrors.startOffsetFor('pornhub'), 5, JSON.stringify(bad)));
    }
    withEnv('12', () => assert.equal(mirrors.startOffsetFor('85po'), 0, 'only that source'));
});

test('main.js: one start seek per resource, and the loop returns to the same spot', () => {
    const main = read('src', 'main.js');
    assert.match(main, /media\.addEventListener\('loadedmetadata', applyStartOffset\)/);
    assert.match(main, /media\.addEventListener\('emptied', \(\) => \{\s*startPending = true;/);
    assert.match(main, /startPending = false;\s*const target = startAt\(\);/);
    assert.match(main, /media\.currentTime = startAt\(\);/, 'the loop');
    assert.doesNotMatch(main, /media\.currentTime = 0;/);
    // Tied to no time event, so a manual seek before the offset is not undone.
    assert.doesNotMatch(main, /addEventListener\('(?:timeupdate|seeking|seeked)', applyStartOffset\)/);
});
