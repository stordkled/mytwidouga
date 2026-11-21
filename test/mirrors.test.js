const test = require('node:test');
const assert = require('node:assert/strict');
const mirrors = require('../lib/mirrors');
const { responseFailure } = require('../lib/http');

test('mirror fallback skips a block page and remembers the domain that worked', async () => {
    mirrors.forget('example');
    const seen = [];
    const { base, result } = await mirrors.withMirror('example', [
        'https://blocked.example',
        'https://ok.example',
    ], async (candidate) => {
        seen.push(candidate);
        if (candidate.includes('blocked')) {
            const failure = responseFailure({ status: 403, ok: false, blocked: true, text: 'Just a moment' });
            throw new Error(failure);
        }
        return 'videos';
    });
    assert.deepEqual(seen, ['https://blocked.example', 'https://ok.example']);
    assert.equal(base, 'https://ok.example');
    assert.equal(result, 'videos');
    assert.equal(mirrors.activeBase('example'), 'https://ok.example');

    const again = [];
    await mirrors.withMirror('example', [
        'https://blocked.example',
        'https://ok.example',
    ], async (candidate) => {
        again.push(candidate);
        return 'cached-domain';
    });
    assert.deepEqual(again, ['https://ok.example']);
    mirrors.forget('example');
});

test('a dead remembered domain is dropped and the next mirror is used', async () => {
    mirrors.forget('example2');
    mirrors.remember('example2', 'https://old.example');
    const seen = [];
    const { base } = await mirrors.withMirror('example2', [
        'https://old.example',
        'https://new.example',
    ], async (candidate) => {
        seen.push(candidate);
        if (candidate.includes('old')) throw new Error('HTTP 503');
        return 'ok';
    });
    assert.deepEqual(seen, ['https://old.example', 'https://new.example']);
    assert.equal(base, 'https://new.example');
    mirrors.forget('example2');
});

test('block pages, 403s, and 5xx are mirror failures', () => {
    assert.equal(responseFailure({ status: 200, ok: true, blocked: false, text: 'Just a moment...' }), 'block page');
    assert.equal(responseFailure({ status: 403, ok: false, blocked: false, text: '' }), 'HTTP 403');
    assert.equal(responseFailure({ status: 502, ok: false, blocked: false, text: '' }), 'HTTP 502');
    assert.equal(responseFailure({ status: 200, ok: true, blocked: false, text: '<html>ok</html>' }), null);
});

test('env override replaces the configured base list', () => {
    const key = 'SOURCE_BASES_EXAMPLE3';
    process.env[key] = 'https://a.example, https://b.example';
    try {
        assert.deepEqual(mirrors.basesFor('example3', ['https://default.example']), [
            'https://a.example',
            'https://b.example',
        ]);
    } finally {
        delete process.env[key];
    }
});
