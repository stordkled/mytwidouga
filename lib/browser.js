const fs = require('fs');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { UA } = require('./http');

puppeteer.use(StealthPlugin());

const CHALLENGE = /just a moment|しばらくお待ちください|checking your browser|cf-browser-verification|please wait/i;
const BLOCKED = /attention required|sorry, you have been blocked|you are unable to access/i;

let lastError = null;
let active = 0;
const waiters = [];
const MAX_PAGES = 1;

function findBrowserPath() {
    if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
        return process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    const candidates = [
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
    throw new Error('No browser found. Set PUPPETEER_EXECUTABLE_PATH.');
}

function createLaunchGate() {
    const state = { browser: null, launching: null, generation: 0 };

    function forget(instance, generation) {
        if (state.browser === instance) state.browser = null;
        if (state.generation === generation) state.launching = null;
    }

    function start(factory) {
        if (state.browser && state.browser.connected) return Promise.resolve(state.browser);
        if (state.launching) {
            const pending = state.launching;
            return pending.then((instance) => {
                if (instance && instance.connected && state.browser === instance) return instance;
                if (state.launching === pending) state.launching = null;
                return start(factory);
            }, (err) => {
                if (state.launching === pending) state.launching = null;
                throw err;
            });
        }

        const generation = ++state.generation;
        const pending = Promise.resolve()
            .then(factory)
            .then((instance) => {
                if (instance && typeof instance.on === 'function') {
                    instance.on('disconnected', () => forget(instance, generation));
                }
                state.browser = instance;
                return instance;
            })
            .catch((err) => {
                if (state.generation === generation) state.launching = null;
                throw err;
            });
        state.launching = pending;
        return pending;
    }

    function current() {
        return state.browser && state.browser.connected ? state.browser : null;
    }

    async function close() {
        const instance = state.browser;
        state.browser = null;
        state.launching = null;
        state.generation += 1;
        if (instance && typeof instance.close === 'function') {
            await instance.close().catch(() => {});
        }
    }

    return { start, current, close };
}

const launchGate = createLaunchGate();

function status() {
    return {
        state: launchGate.current() ? 'ready' : lastError ? 'failed' : 'idle',
        error: lastError,
        activePages: active,
    };
}

async function launch() {
    const executablePath = findBrowserPath();
    console.log('[Browser] Launching', executablePath);
    const instance = await puppeteer.launch({
        executablePath,
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-default-apps',
            '--mute-audio',
            '--no-first-run',
            '--renderer-process-limit=1',
            '--js-flags=--max-old-space-size=128',
            '--window-size=1280,720',
            '--lang=ja-JP',
        ],
    });
    lastError = null;
    console.log('[Browser] Ready');
    return instance;
}

function getBrowser() {
    return launchGate.start(() => launch().catch((err) => {
        lastError = err.message;
        throw err;
    }));
}

function acquire() {
    if (active < MAX_PAGES) {
        active += 1;
        return Promise.resolve();
    }
    return new Promise((resolve) => waiters.push(resolve));
}

function release() {
    active -= 1;
    const next = waiters.shift();
    if (next) {
        active += 1;
        next();
    }
}

async function waitForClearance(page, timeout = 40000) {
    const started = Date.now();
    let title = await page.title().catch(() => '');
    if (BLOCKED.test(title)) {
        throw new Error(`Cloudflare blocked this network (${title})`);
    }
    while (CHALLENGE.test(title) && Date.now() - started < timeout) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        title = await page.title().catch(() => '');
        if (BLOCKED.test(title)) {
            throw new Error(`Cloudflare blocked this network (${title})`);
        }
    }
    if (CHALLENGE.test(title)) {
        throw new Error('Cloudflare challenge did not clear in time');
    }
    return title;
}

async function withPage(fn) {
    let acquired = false;
    let page = null;
    try {
        await acquire();
        acquired = true;
        const instance = await getBrowser();
        page = await instance.newPage();
        await page.setUserAgent(UA);
        await page.setViewport({ width: 1366, height: 900 });
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        });
        page.setDefaultNavigationTimeout(45000);
        return await fn(page);
    } finally {
        if (page) await page.close().catch(() => {});
        if (acquired) release();
    }
}

async function gotoHtml(url, options = {}) {
    return withPage(async (page) => {
        if (options.prepare) await options.prepare(page);
        const response = await page.goto(url, {
            waitUntil: options.waitUntil || 'domcontentloaded',
            timeout: options.timeout || 45000,
        });
        await waitForClearance(page, options.challengeTimeout || 40000);
        if (options.waitFor) {
            await page.waitForSelector(options.waitFor, { timeout: options.waitForTimeout || 12000 }).catch(() => {});
        }
        return {
            html: await page.content(),
            url: page.url(),
            status: response ? response.status() : 0,
        };
    });
}

async function closeBrowser() {
    await launchGate.close();
}

module.exports = {
    findBrowserPath,
    status,
    withPage,
    gotoHtml,
    waitForClearance,
    closeBrowser,
    createLaunchGate,
};
