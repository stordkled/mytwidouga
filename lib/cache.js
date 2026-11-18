class TtlCache {
    constructor() {
        this.store = new Map();
        this.inflight = new Map();
    }

    async getOrLoad(key, ttlMs, loader) {
        const hit = this.store.get(key);
        if (hit && hit.expires > Date.now()) {
            return { value: hit.value, cached: true };
        }
        if (this.inflight.has(key)) {
            const value = await this.inflight.get(key);
            return { value, cached: false };
        }

        const pending = Promise.resolve().then(loader);
        this.inflight.set(key, pending);
        try {
            const value = await pending;
            this.store.set(key, { value, expires: Date.now() + ttlMs });
            return { value, cached: false };
        } finally {
            this.inflight.delete(key);
        }
    }
}

function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`${label || 'Request'} timed out after ${ms}ms`));
        }, ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (err) => {
                clearTimeout(timer);
                reject(err);
            }
        );
    });
}

module.exports = { TtlCache, withTimeout };
