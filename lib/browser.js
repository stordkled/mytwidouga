const fs = require('fs');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { UA } = require('./http');

puppeteer.use(StealthPlugin());

const CHALLENGE = /just a moment|しばらくお待ちください|checking your browser|cf-browser-verification|please wait/i;
const BLOCKED = /attention required|sorry, you have been blocked|you are unable to access/i;

let browser = null;
let launching = null;
let lastError = null;
let active = 0;
const waiters = [];
const MAX_PAGES = 2;

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

function status() {
    return {
        state: browser && browser.connected ? 'ready' : lastError ? 'failed' : 'idle',
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
            '--window-size=1366,900',
            '--lang=ja-JP',
        ],
    });
    instance.on('disconnected', () => {
        if (browser === instance) browser = null;
    });
    browser = instance;
    lastError = null;
    console.log('[Browser] Ready');
    return instance;
}

async function getBrowser() {
    if (browser && browser.connected) return browser;
    if (!launching) {
        launching = launch().catch((err) => {
            launching = null;
            lastError = err.message;
            throw err;
        });
    }
    return launching;
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
    if (browser) {
        await browser.close().catch(() => {});
        browser = null;
    }
}

module.exports = {
    findBrowserPath,
    status,
    withPage,
    gotoHtml,
    waitForClearance,
    closeBrowser,
};
