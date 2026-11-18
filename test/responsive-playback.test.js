const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';
const ROOT = path.join(__dirname, '..');
const FILE = process.env.SLOW_MP4 || '/tmp/slow.mp4';
const RATE = 60 * 1024;

function parseRange(header, size) {
    if (!header) return null;
    const match = /^bytes=(\d*)-(\d*)$/i.exec(String(header).trim());
    if (!match) return null;
    let start = match[1] === '' ? null : Number(match[1]);
    let end = match[2] === '' ? null : Number(match[2]);
    if (start === null) {
        start = Math.max(0, size - (end || 0));
        end = size - 1;
    } else if (end === null || end >= size) {
        end = size - 1;
    }
    if (start < 0 || start >= size || end < start) return null;
    return { start, end };
}

function startSlowFile(data) {
    const server = http.createServer((req, res) => {
        const size = data.length;
        const range = parseRange(req.headers.range, size);
        const start = range ? range.start : 0;
        const end = range ? range.end : size - 1;
        const headers = {
            'Content-Type': 'video/mp4',
            'Accept-Ranges': 'bytes',
            'Content-Length': String(end - start + 1),
            'Cache-Control': 'no-store',
        };
        if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
        res.writeHead(range ? 206 : 200, headers);
        let offset = start;
        let timer = null;
        const chunk = 16 * 1024;
        const gap = Math.max(5, Math.round((chunk / RATE) * 1000));
        const write = () => {
            if (res.writableEnded || offset > end) return;
            const next = Math.min(end + 1, offset + chunk);
            const ok = res.write(data.subarray(offset, next));
            offset = next;
            if (offset > end) {
                res.end();
                return;
            }
            if (!ok) {
                res.once('drain', () => { timer = setTimeout(write, gap); });
                return;
            }
            timer = setTimeout(write, gap);
        };
        write();
        res.on('close', () => { if (timer) clearTimeout(timer); });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function waitFor(url) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
            const req = http.get(url, (res) => {
                res.resume();
                resolve();
            });
            req.on('error', () => {
                if (Date.now() - started > 10000) reject(new Error(`timed out waiting for ${url}`));
                else setTimeout(tick, 100);
            });
        };
        tick();
    });
}

test('a slow proxied Pornhub MP4 keeps page.evaluate under a second', { timeout: 180000 }, async (t) => {
    if (!fs.existsSync(CHROME) || !fs.existsSync(FILE)) {
        t.skip('needs Chrome and a local MP4');
        return;
    }
    const puppeteer = require('puppeteer-core');
    const data = fs.readFileSync(FILE);
    const slow = await startSlowFile(data);
    const port = slow.address().port;
    const appPort = 3467;
    const app = spawn(process.execPath, ['-r', path.join(__dirname, 'dns-preload.js'), 'server.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(appPort) },
        stdio: 'ignore',
    });
    t.after(() => {
        app.kill('SIGTERM');
        slow.close();
    });
    await waitFor(`http://127.0.0.1:${appPort}/api/sources`);

    const browser = await puppeteer.launch({
        executablePath: CHROME,
        headless: 'new',
        protocolTimeout: 5000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--autoplay-policy=no-user-gesture-required'],
    });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const fileUrl = `http://ev.phncdn.com:${port}/720P_4000K_64285895.mp4?validfrom=1&validto=2&rate=500k&burst=1600k&ip=203.0.113.5&ipa=1&hash=abc`;
    await page.evaluateOnNewDocument((mediaUrl) => {
        localStorage.setItem('shorts.source', 'pornhub');
        localStorage.setItem('shorts.period.pornhub', '24h');
        const orig = window.fetch.bind(window);
        window.fetch = (input, init) => {
            const url = String((input && input.url) || input);
            const json = (body) => Promise.resolve(new Response(JSON.stringify(body), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }));
            if (url.includes('/api/videos')) {
                return json({
                    ok: true,
                    period: { id: '24h', label: '24時間' },
                    source: { id: 'pornhub' },
                    videos: [{
                        id: '64285895',
                        title: 'Slow file',
                        rank: 1,
                        rankLabel: 'No.1',
                        duration: '0:40',
                        views: '1',
                        thumbUrl: '',
                        pageUrl: 'https://www.pornhub.com/view_video.php?viewkey=64285895',
                        playback: { kind: 'resolve', embedUrl: 'https://www.pornhub.com/embed/64285895' },
                    }],
                });
            }
            if (url.includes('/api/resolve')) {
                return json({
                    ok: true,
                    playback: {
                        kind: 'file',
                        needsReferer: true,
                        url: mediaUrl,
                        referer: 'https://www.pornhub.com/',
                        embedUrl: 'https://www.pornhub.com/embed/64285895',
                    },
                });
            }
            return orig(input, init);
        };
    }, fileUrl);
    await page.goto(`http://127.0.0.1:${appPort}/`, { waitUntil: 'domcontentloaded' });

    const samples = [];
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const started = Date.now();
        const info = await page.evaluate(() => {
            const media = document.querySelector('video');
            return {
                videos: document.querySelectorAll('video').length,
                iframe: !!document.querySelector('iframe.embed-player'),
                ready: media ? media.readyState : -1,
                src: media ? (media.currentSrc || '').slice(0, 24) : '',
            };
        });
        const elapsed = Date.now() - started;
        samples.push({ elapsed, ...info });
        assert.ok(elapsed < 1000, `page.evaluate took ${elapsed}ms`);
    }
    assert.ok(samples.length >= 30, 'expected about two minutes of samples');
    assert.ok(samples.some((sample) => sample.videos === 1 && sample.ready >= 1), 'the proxied file never exposed media data');
    assert.equal(samples.filter((sample) => sample.iframe).length, 0);
});
