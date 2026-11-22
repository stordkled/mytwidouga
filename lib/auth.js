const crypto = require('crypto');
const { clientKey } = require('./proxy');

const COOKIE_NAME = 'shorts_access';
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED_CLIENTS = 10000;
const DEFAULT_USER = 'friend';

function sha256(value) {
    return crypto.createHash('sha256').update(String(value)).digest();
}

function sameText(a, b) {
    return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function readCookie(header, name) {
    for (const part of String(header || '').split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
    }
    return '';
}

function parseBasic(header) {
    const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(String(header || '').trim());
    if (!match) return null;
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) return null;
    return { user: decoded.slice(0, colon), pass: decoded.slice(colon + 1) };
}

// A login page or a shared link may open the app from another site. Nothing
// else from another site may use a friend's saved login, above all the relay.
function crossSiteBlocked(req) {
    const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    if (site !== 'cross-site' && site !== 'same-site') return false;
    const pathname = String(req.url || '').split(/[?#]/)[0];
    const openingApp = (pathname === '/' || pathname === '/index.html')
        && req.headers['sec-fetch-mode'] === 'navigate'
        && req.headers['sec-fetch-dest'] === 'document';
    return !openingApp;
}

// Every response path ends in writeHead, including the ones inside the relay.
// With a login in place nothing may be readable cross-origin or stored by a
// shared cache.
function lockDownResponse(res) {
    const writeHead = res.writeHead;
    res.writeHead = function lockedWriteHead(status, ...rest) {
        res.removeHeader('Access-Control-Allow-Origin');
        const headers = rest[rest.length - 1];
        if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
            for (const key of Object.keys(headers)) {
                const lower = key.toLowerCase();
                if (lower === 'access-control-allow-origin') delete headers[key];
                else if (lower === 'cache-control') headers[key] = String(headers[key]).replace(/\bpublic\b/i, 'private');
            }
        }
        return writeHead.call(this, status, ...rest);
    };
}

function createFailureLog(now) {
    const clients = new Map();

    function current(key) {
        const entry = clients.get(key);
        if (!entry) return null;
        if (entry.resetAt > now()) return entry;
        clients.delete(key);
        return null;
    }

    function makeRoom() {
        if (clients.size < MAX_TRACKED_CLIENTS) return;
        for (const key of clients.keys()) current(key);
        if (clients.size >= MAX_TRACKED_CLIENTS) clients.delete(clients.keys().next().value);
    }

    return {
        retryAfterS(key) {
            const entry = current(key);
            if (!entry || entry.count < MAX_FAILURES) return 0;
            return Math.max(1, Math.ceil((entry.resetAt - now()) / 1000));
        },
        add(key) {
            const entry = current(key);
            if (entry) {
                entry.count += 1;
                return;
            }
            makeRoom();
            clients.set(key, { count: 1, resetAt: now() + FAILURE_WINDOW_MS });
        },
        clear(key) {
            clients.delete(key);
        },
    };
}

// Off when neither variable is set, so a local run behaves as before. A
// half-finished setting stops the server instead of running without a login.
function createAccessControl(env = process.env, options = {}) {
    const rawUser = env.BASIC_AUTH_USER || '';
    const pass = env.BASIC_AUTH_PASS || '';
    if (!rawUser && !pass) return { enabled: false, guard: () => true };
    if (!pass.trim()) throw new Error('BASIC_AUTH_USER is set but BASIC_AUTH_PASS is empty');
    const user = rawUser || DEFAULT_USER;
    if (user.includes(':')) throw new Error('BASIC_AUTH_USER must not contain ":"');

    const now = options.now || Date.now;
    const failures = createFailureLog(now);
    // Derived from the login, so a restart keeps sessions and a new password
    // ends them. scrypt keeps a copied cookie from being a cheap password test.
    const cookieKey = crypto.scryptSync(`${user}\0${pass}`, 'twivideo-shorts-access-v1', 32);

    function sign(expires) {
        return crypto.createHmac('sha256', cookieKey).update(String(expires)).digest('hex');
    }

    function validCookie(req) {
        const token = readCookie(req.headers.cookie, COOKIE_NAME);
        const match = /^(\d+)\.([0-9a-f]{64})$/.exec(token);
        if (!match || Number(match[1]) <= now()) return false;
        return sameText(match[2], sign(match[1]));
    }

    function issueCookie(req, res) {
        const expires = now() + COOKIE_MAX_AGE_S * 1000;
        const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
        const https = /^(1|true|yes)$/i.test(env.TRUST_PROXY || '') && forwarded === 'https';
        res.setHeader('Set-Cookie', `${COOKIE_NAME}=${expires}.${sign(expires)}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Lax${https ? '; Secure' : ''}`);
    }

    function deny(res, status, body, headers = {}) {
        res.writeHead(status, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
            ...headers,
        });
        res.end(body);
        return false;
    }

    function challenge(res) {
        return deny(res, 401, 'Authentication required', {
            'WWW-Authenticate': 'Basic realm="TWIVIDEO Shorts", charset="UTF-8"',
        });
    }

    // True when the request may continue. Otherwise the response is finished.
    function guard(req, res) {
        lockDownResponse(res);
        if (crossSiteBlocked(req)) return deny(res, 403, 'Forbidden');
        if (validCookie(req)) return true;
        if (!req.headers.authorization) return challenge(res);

        const key = clientKey(req);
        const retryAfter = failures.retryAfterS(key);
        if (retryAfter > 0) {
            return deny(res, 429, 'Too many failed logins', { 'Retry-After': String(retryAfter) });
        }
        const login = parseBasic(req.headers.authorization);
        // Both are always compared, so timing does not reveal the user name.
        const userOk = login ? sameText(login.user, user) : false;
        const passOk = login ? sameText(login.pass, pass) : false;
        if (!userOk || !passOk) {
            failures.add(key);
            return challenge(res);
        }
        failures.clear(key);
        issueCookie(req, res);
        return true;
    }

    return { enabled: true, guard };
}

module.exports = { createAccessControl, COOKIE_NAME, MAX_FAILURES };
