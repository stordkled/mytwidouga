// Canonical period ids the UI and /api/videos understand.
// Sources only declare the periods they actually publish. Anything else
// falls back along FALLBACK so a missing "3 days" tab still returns a list.

const ALIASES = {
    '24': '24h',
    '3days': '3d',
    '3day': '3d',
    week: '7d',
    '7': '7d',
    '30': '30d',
    month: '30d',
    day: '24h',
    daily: '24h',
    weekly: '7d',
    monthly: '30d',
};

const REQUEST_LABELS = {
    '24h': '24時間',
    '3d': '3日間',
    '7d': '1週間',
    '30d': '1ヶ月',
};

const FALLBACK = {
    '24h': ['7d', '3d', '30d'],
    '3d': ['7d', '24h', '30d'],
    '7d': ['30d', '3d', '24h'],
    '30d': ['7d', '3d', '24h'],
};

function resolvePeriod(periods, requested) {
    if (!periods || periods.length === 0) {
        throw new Error('Source has no periods');
    }
    const raw = String(requested || '').trim();
    if (!raw) {
        return {
            period: periods[0],
            requestedPeriod: periods[0].id,
            fallback: false,
            fallbackReason: null,
        };
    }

    const want = ALIASES[raw] || raw;
    const match = periods.find((period) => period.id === want);
    if (match) {
        return {
            period: match,
            requestedPeriod: want,
            fallback: false,
            fallbackReason: null,
        };
    }

    const chain = FALLBACK[want] || periods.map((period) => period.id);
    const fallbackId = chain.find((id) => periods.some((period) => period.id === id)) || periods[0].id;
    const period = periods.find((item) => item.id === fallbackId);
    const requestedLabel = REQUEST_LABELS[want] || want;
    return {
        period,
        requestedPeriod: want,
        fallback: true,
        fallbackReason: `${requestedLabel}のランキングがないため、${period.label}を表示しています`,
    };
}

module.exports = { resolvePeriod, ALIASES, REQUEST_LABELS };
