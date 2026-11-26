const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createAccessControl, COOKIE_NAME, MAX_FAILURES } = require('../lib/auth');

const ROOT = path.join(__dirname, '..');
const USER = 'friend';
const PASS = 'correct:horse battery';
const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
const GOOD = basic(USER, PASS);

function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

function cleanEnv(extra) {
    const env = { ...process.env, ...extra };
    if (!('BASIC_AUTH_USER' in extra)) delete env.BASIC_AUTH_USER;
    if (!('BASIC_AUTH_PASS' in extra)) delete env.BASIC_AUTH_PASS;
    if (!('TRUST_PROXY' in extra)) delete env.TRUST_PROXY;
    return env;
}

async function startServer(t, extra = {}) {
    const port = await freePort();
    const child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: cleanEnv({ ...extra, PORT: String(port) }),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => child.kill());
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('server did not start')), 15000);
        child.stdout.on('data', (chunk) => {
            if (String(chunk).includes('Local:')) {
                clearTimeout(timer);
                resolve();
            }
        });
        child.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`server exited with ${code}`));
        });
    });
    return port;
}

function get(port, urlPath, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: urlPath, headers, agent: false }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        req.on('error', reject);
    });
}

function fakeRes() {
    const res = {
        status: 0,
        headers: {},
        setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
        removeHeader(name) { delete this.headers[name.toLowerCase()]; },
        writeHead(status, headers = {}) {
            this.status = status;
            for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
        },
        end() {},
    };
    return res;
}

const fakeReq = (headers = {}, url = '/', address = '203.0.113.5') => ({
    url,
    headers,
    socket: { remoteAddress: address },
});

const RELAY = `/proxy/media?source=twikeep&url=${encodeURIComponent('https://not-allowed.example/a.mp4')}`;

test('without a password the server stays open as before', async (t) => {
    const port = await startServer(t);
    const page = await get(port, '/');
    assert.equal(page.status, 200);
    assert.equal(page.headers['access-control-allow-origin'], '*');
    assert.match(page.headers['cache-control'], /no-cache/);
    const api = await get(port, '/api/sources');
    assert.equal(api.status, 200);
    assert.equal(api.headers['access-control-allow-origin'], '*');
    assert.equal(api.headers['set-cookie'], undefined);
});

test('with a password every route needs it, and the relay keeps its allowlist', async (t) => {
    const port = await startServer(t, { BASIC_AUTH_USER: USER, BASIC_AUTH_PASS: PASS });
    const routes = ['/', '/index.html', '/sw.js', '/manifest.webmanifest', '/robots.txt', '/sitemap.xml', '/src/main.js', '/icons/icon-192.png',
        '/favicon.ico', '/api/status', '/api/sources', '/api/videos', '/api/resolve', '/api/external',
        '/embed/pornhub?id=phTest&start=5', '/src/embed-player.js',
        '/proxy/media', '/proxy/playlist', RELAY, '/does-not-exist'];
    for (const route of routes) {
        const denied = await get(port, route);
        assert.equal(denied.status, 401, route);
        assert.match(denied.headers['www-authenticate'], /^Basic /, route);
        assert.equal(denied.headers['access-control-allow-origin'], undefined, route);
    }
    assert.equal((await get(port, '/api/status', { Authorization: basic(USER, 'wrong') })).status, 401);

    const page = await get(port, '/', { Authorization: GOOD });
    assert.equal(page.status, 200);
    assert.equal(page.headers['access-control-allow-origin'], undefined);
    const cookie = page.headers['set-cookie'][0];
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.doesNotMatch(cookie, /Secure/);

    const icon = await get(port, '/icons/icon-192.png', { Authorization: GOOD });
    assert.match(icon.headers['cache-control'], /^private/);

    // A <video> that only carries the cookie still plays, and an authorized
    // viewer still cannot point the relay at an arbitrary host.
    const session = cookie.split(';')[0];
    assert.equal((await get(port, '/api/status', { Cookie: session })).status, 200);
    const relayed = await get(port, RELAY, { Cookie: session });
    assert.equal(relayed.status, 400);
    assert.match(relayed.body, /not allowed/);
    assert.equal(relayed.headers['access-control-allow-origin'], undefined);

    for (const site of ['cross-site', 'same-site']) {
        const blocked = await get(port, RELAY, { Cookie: session, 'Sec-Fetch-Site': site, 'Sec-Fetch-Dest': 'video' });
        assert.equal(blocked.status, 403);
    }
    const opened = await get(port, '/', {
        Cookie: session,
        'Sec-Fetch-Site': 'cross-site',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Dest': 'document',
    });
    assert.equal(opened.status, 200);
});

test('the cookie is Secure behind the HTTPS proxy', async (t) => {
    const port = await startServer(t, { BASIC_AUTH_USER: USER, BASIC_AUTH_PASS: PASS, TRUST_PROXY: '1' });
    const page = await get(port, '/', { Authorization: GOOD, 'X-Forwarded-Proto': 'https' });
    assert.match(page.headers['set-cookie'][0], /; Secure/);
});

test('a half-finished login setting stops the server instead of opening it', async () => {
    assert.throws(() => createAccessControl({ BASIC_AUTH_USER: USER }), /BASIC_AUTH_PASS/);
    assert.throws(() => createAccessControl({ BASIC_AUTH_PASS: '   ' }), /BASIC_AUTH_PASS/);
    assert.throws(() => createAccessControl({ BASIC_AUTH_USER: 'a:b', BASIC_AUTH_PASS: 'x' }), /":"/);
    assert.equal(createAccessControl({}).enabled, false);
    assert.equal(createAccessControl({ BASIC_AUTH_PASS: 'x' }).enabled, true);
});

test('repeated wrong passwords lock out that client only, then expire', () => {
    let clock = 1000;
    const access = createAccessControl({ BASIC_AUTH_USER: USER, BASIC_AUTH_PASS: PASS }, { now: () => clock });
    const attempt = (authorization, address) => {
        const res = fakeRes();
        access.guard(fakeReq({ authorization }, '/', address), res);
        return res.status || 200;
    };
    for (let i = 0; i < MAX_FAILURES; i += 1) assert.equal(attempt(basic(USER, 'bad'), '203.0.113.9'), 401);
    assert.equal(attempt(GOOD, '203.0.113.9'), 429);
    assert.equal(attempt(GOOD, '203.0.113.10'), 200);
    clock += 16 * 60 * 1000;
    assert.equal(attempt(GOOD, '203.0.113.9'), 200);
});

test('a forged, expired, or old-password cookie is refused', () => {
    let clock = 1000;
    const env = { BASIC_AUTH_USER: USER, BASIC_AUTH_PASS: PASS };
    const access = createAccessControl(env, { now: () => clock });
    const login = fakeRes();
    assert.equal(access.guard(fakeReq({ authorization: GOOD }), login), true);
    const session = login.headers['set-cookie'].split(';')[0];
    const [, value] = session.split('=');
    const [expires, mac] = value.split('.');

    const withCookie = (control, cookie) => control.guard(fakeReq({ cookie }), fakeRes());
    assert.equal(withCookie(access, session), true);
    assert.equal(withCookie(access, `${COOKIE_NAME}=${Number(expires) + 1}.${mac}`), false);
    assert.equal(withCookie(access, `${COOKIE_NAME}=${expires}.${'0'.repeat(64)}`), false);
    assert.equal(withCookie(createAccessControl({ ...env, BASIC_AUTH_PASS: 'new password' }, { now: () => clock }), session), false);
    clock = Number(expires);
    assert.equal(withCookie(access, session), false);
});

test('the deployment files keep the app behind Caddy and the secrets out of git', () => {
    const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');
    const compose = read('docker-compose.yml');
    assert.match(compose, /BASIC_AUTH_PASS: \$\{BASIC_AUTH_PASS:\?/);
    assert.match(compose, /DOMAIN: \$\{DOMAIN:\?/);
    const appBlock = compose.slice(compose.indexOf('  app:'), compose.indexOf('  caddy:'));
    assert.doesNotMatch(appBlock, /^\s+ports:/m);
    assert.match(read('Caddyfile'), /reverse_proxy app:/);
    assert.match(read('.gitignore'), /^\.env\r?$/m);
    assert.match(read('.dockerignore'), /^\.env\r?$/m);
    assert.doesNotMatch(read('.dockerignore'), /package-lock/);
});
