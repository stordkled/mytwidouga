const path = require('path');

// Only the PWA's own files are served. The repository root also holds
// server code, config, .git and possibly .env, and none of that is public.
const ROOT_FILES = new Set(['index.html', 'sw.js', 'manifest.webmanifest']);
const PUBLIC_DIRS = new Set(['src', 'icons']);

function staticPath(rawUrl, root) {
    const pathname = String(rawUrl || '/').split('?')[0].split('#')[0];
    let decoded;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        return null;
    }
    if (decoded === '/' || decoded === '') decoded = '/index.html';
    if (decoded.includes('\0') || decoded.includes('\\')) return null;
    const parts = decoded.split('/').filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.some((part) => part === '.' || part === '..' || part.startsWith('.'))) return null;
    if (parts.length === 1 ? !ROOT_FILES.has(parts[0]) : !PUBLIC_DIRS.has(parts[0])) return null;
    const absolute = path.resolve(root, ...parts);
    const base = path.resolve(root);
    if (absolute !== base && !absolute.startsWith(base + path.sep)) return null;
    return absolute;
}

module.exports = { staticPath, ROOT_FILES, PUBLIC_DIRS };
