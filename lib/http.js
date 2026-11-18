const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function looksBlocked(html) {
    const head = String(html || '').slice(0, 2500);
    return /Just a moment|しばらくお待ちください|Attention Required|cf-browser-verification|Sorry, you have been blocked|you are unable to access/i.test(head);
}

async function getText(url, options = {}) {
    const headers = {
        'User-Agent': UA,
        Accept: options.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
        ...(options.headers || {}),
    };
    if (options.referer) headers.Referer = options.referer;

    const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(options.timeout || 20000),
        headers,
    });
    const text = await response.text();
    return {
        ok: response.ok,
        status: response.status,
        url: response.url,
        text,
        blocked: looksBlocked(text),
    };
}

module.exports = { UA, getText, looksBlocked };
