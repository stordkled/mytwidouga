const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Stealth plugin hides headless Chrome fingerprints from Cloudflare
puppeteer.use(StealthPlugin());

const PORT = process.env.PORT || 3000;

// MIME types
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
    '.webmanifest': 'application/manifest+json',
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

// ---- Find browser executable across platforms ----
function findBrowserPath() {
    // 1. Environment variable (set by Docker image)
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        return process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    // 2. Linux
    const linuxPaths = [
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
    ];
    for (const p of linuxPaths) {
        if (fs.existsSync(p)) return p;
    }

    // 3. Windows
    const winPaths = [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];
    for (const p of winPaths) {
        if (fs.existsSync(p)) return p;
    }

    // 4. macOS
    const macPaths = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
    for (const p of macPaths) {
        if (fs.existsSync(p)) return p;
    }

    throw new Error('No browser found! Set PUPPETEER_EXECUTABLE_PATH env var.');
}

// ---- Persistent browser for Cloudflare bypass ----
let browser = null;
let page = null;
let browserReady = false;

async function initBrowser() {
    const execPath = findBrowserPath();
    console.log('[Browser] Using:', execPath);

    browser = await puppeteer.launch({
        executablePath: execPath,
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--window-size=1920,1080',
        ],
    });

    page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1920, height: 1080 });

    // Set extra headers to appear more like a real browser
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    });

    console.log('[Browser] Navigating to twivideo.net...');
    try {
        await page.goto('https://twivideo.net/?ranking', {
            waitUntil: 'networkidle2',
            timeout: 60000,
        });
    } catch (e) {
        console.warn('[Browser] Navigation timeout:', e.message);
    }

    const title = await page.title();
    console.log('[Browser] Page title:', title);

    if (title.includes('Just a moment')) {
        console.log('[Browser] Cloudflare challenge detected, waiting...');
        try {
            await page.waitForFunction(
                () => !document.title.includes('Just a moment'),
                { timeout: 45000 }
            );
            console.log('[Browser] Challenge passed!');
        } catch (e) {
            console.warn('[Browser] Challenge timeout. Retrying navigation...');
            // Retry once
            await new Promise(r => setTimeout(r, 5000));
            try {
                await page.goto('https://twivideo.net/?ranking', {
                    waitUntil: 'networkidle2',
                    timeout: 60000,
                });
                const retryTitle = await page.title();
                console.log('[Browser] Retry title:', retryTitle);
                if (retryTitle.includes('Just a moment')) {
                    await page.waitForFunction(
                        () => !document.title.includes('Just a moment'),
                        { timeout: 30000 }
                    );
                }
            } catch (e2) {
                console.error('[Browser] Retry also failed:', e2.message);
            }
        }
        await new Promise(r => setTimeout(r, 3000));
    }

    // Check if we actually got through
    const finalTitle = await page.title();
    const hasVideos = await page.evaluate(() => document.querySelectorAll('.art_li').length);
    console.log(`[Browser] Final title: ${finalTitle}, Videos on page: ${hasVideos}`);

    if (hasVideos > 0) {
        browserReady = true;
        console.log('[Browser] Ready ✓');
    } else {
        console.error('[Browser] WARNING: No videos found on page. Cloudflare may still be blocking.');
        // Still mark as ready to allow retries via API
        browserReady = true;
    }
}

// ---- Navigate to specific sort page ----
async function navigateToSort(sort) {
    const sortMap = {
        '24': '?ranking',
        '7': '?ranking_w',
        '30': '?ranking_m',
    };
    const path = sortMap[sort] || '?ranking';
    const url = `https://twivideo.net/${path}`;

    console.log(`[Browser] Navigating to ${url}...`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    const title = await page.title();
    if (title.includes('Just a moment')) {
        await page.waitForFunction(
            () => !document.title.includes('Just a moment'),
            { timeout: 30000 }
        ).catch(() => { });
        await new Promise(r => setTimeout(r, 3000));
    }
}

// ---- Fetch videos via browser context ----
async function fetchVideosViaBrowser(sort = '24', offset = 0, limit = 30) {
    if (!browserReady || !page) {
        if (!browser) await initBrowser();
        if (!browserReady) throw new Error('Browser not ready');
    }

    try {
        // For initial load, scrape current page
        if (offset === 0) {
            await navigateToSort(sort);
            const count = await page.evaluate(() => document.querySelectorAll('.art_li').length);
            console.log(`[API] Found ${count} videos on page`);

            if (count > 0) {
                return await page.evaluate(() => document.documentElement.outerHTML);
            }
        }

        // For pagination, use fetch within browser context
        const html = await page.evaluate(async (sort, offset, limit) => {
            const body = `offset=${offset}&limit=${limit}&tag=null&type=ranking&order=${sort}&le=1000&ty=p6&myarray=[]&offset_int=${offset}`;
            const resp = await fetch('https://twivideo.net/templates/view_lists.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body,
            });
            return await resp.text();
        }, sort, offset, limit);

        if (html && html.includes('Just a moment')) {
            console.log('[API] Cloudflare in fetch response, re-navigating...');
            await navigateToSort(sort);
            return await page.evaluate(() => document.documentElement.outerHTML);
        }

        return html;
    } catch (err) {
        console.error('[API] Error:', err.message);
        if (err.message.includes('Target closed') || err.message.includes('Session closed')) {
            browserReady = false;
            browser = null;
        }
        throw err;
    }
}

// ---- Proxy: stream remote content ----
function proxyStream(targetUrl, clientReq, clientRes) {
    const parsed = new URL(targetUrl);
    const options = {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
            'User-Agent': UA,
            'Referer': 'https://twitter.com/',
            'Origin': 'https://twitter.com',
        },
    };

    if (clientReq.headers.range) {
        options.headers['Range'] = clientReq.headers.range;
    }

    const proxyReq = https.request(options, (proxyRes) => {
        if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
            proxyStream(proxyRes.headers.location, clientReq, clientRes);
            proxyRes.resume();
            return;
        }

        const headers = {
            'Content-Type': proxyRes.headers['content-type'] || 'application/octet-stream',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=3600',
        };
        if (proxyRes.headers['content-length']) headers['Content-Length'] = proxyRes.headers['content-length'];
        if (proxyRes.headers['content-range']) headers['Content-Range'] = proxyRes.headers['content-range'];
        if (proxyRes.headers['accept-ranges']) headers['Accept-Ranges'] = proxyRes.headers['accept-ranges'];

        clientRes.writeHead(proxyRes.statusCode, headers);
        proxyRes.pipe(clientRes);
    });

    proxyReq.on('error', (err) => {
        console.error('[Proxy] Error:', err.message);
        if (!clientRes.headersSent) { clientRes.writeHead(502); clientRes.end('Proxy Error'); }
    });
    proxyReq.setTimeout(30000, () => {
        proxyReq.destroy();
        if (!clientRes.headersSent) { clientRes.writeHead(504); clientRes.end('Timeout'); }
    });
    proxyReq.end();
}

// ---- Serve static files ----
function serveStatic(req, res) {
    let filePath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    const absPath = path.join(__dirname, filePath);

    if (!absPath.startsWith(__dirname)) {
        res.writeHead(403); res.end('Forbidden'); return;
    }

    const ext = path.extname(absPath);
    const contentType = MIME[ext] || 'application/octet-stream';

    fs.readFile(absPath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not Found'); return; }
        res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
        });
        res.end(data);
    });
}

// ---- HTTP Server ----
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Debug endpoint to check browser status
    if (req.url === '/api/status') {
        const status = {
            browserReady,
            hasBrowser: !!browser,
            hasPage: !!page,
            timestamp: new Date().toISOString(),
        };
        if (page) {
            try {
                status.pageTitle = await page.title();
                status.videoCount = await page.evaluate(() => document.querySelectorAll('.art_li').length);
            } catch (e) {
                status.error = e.message;
            }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status, null, 2));
        return;
    }

    if (req.url.startsWith('/api/videos')) {
        if (!browserReady) {
            res.writeHead(503, { 'Content-Type': 'text/plain' });
            res.end('Browser still initializing...');
            return;
        }
        try {
            const url = new URL(req.url, `http://localhost:${PORT}`);
            const sort = url.searchParams.get('sort') || '24';
            const offset = parseInt(url.searchParams.get('offset') || '0');
            const limit = parseInt(url.searchParams.get('limit') || '30');

            console.log(`[API] sort=${sort} offset=${offset} limit=${limit}`);
            const html = await fetchVideosViaBrowser(sort, offset, limit);

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
        } catch (err) {
            console.error('[API] Error:', err.message);
            res.writeHead(500); res.end('Server Error: ' + err.message);
        }
        return;
    }

    if (req.url.startsWith('/proxy/media')) {
        const url = new URL(req.url, `http://localhost:${PORT}`);
        const targetUrl = url.searchParams.get('url');
        if (!targetUrl || (!targetUrl.includes('twimg.com') && !targetUrl.includes('twitter.com'))) {
            res.writeHead(400); res.end('Bad Request'); return;
        }
        proxyStream(targetUrl, req, res);
        return;
    }

    serveStatic(req, res);
});

// ---- Startup ----
(async () => {
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`\n  🎬 TWIVIDEO Shorts`);
        console.log(`  ➜  Local:   http://localhost:${PORT}/`);
        console.log(`  ➜  Launching browser...\n`);
    });

    try {
        await initBrowser();
    } catch (err) {
        console.error('[FATAL] Browser init failed:', err.message);
    }
})();

process.on('SIGINT', async () => {
    console.log('\n[Shutdown] Closing browser...');
    if (browser) await browser.close().catch(() => { });
    process.exit(0);
});

process.on('SIGTERM', async () => {
    if (browser) await browser.close().catch(() => { });
    process.exit(0);
});
