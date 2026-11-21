const { parse } = require('node-html-parser');

function loadHtml(html) {
    return parse(html || '', { blockTextElements: { script: true, noscript: true, style: true } });
}

function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function absUrl(href, base) {
    if (!href) return '';
    try {
        return new URL(href, base).href;
    } catch {
        return '';
    }
}

module.exports = { loadHtml, cleanText, absUrl };
