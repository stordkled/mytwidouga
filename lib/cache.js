class TtlCache {
    constructor(options = {}) {
        this.store = new Map();
        this.inflight = new Map();
        this.maxEntries = options.maxEntries > 0 ? options.maxEntries : 500;
    }

    get size() {
        return this.store.size;
    }

    delete(key) {
        this.store.delete(key);
        this.inflight.delete(key);
    }

    prune(now = Date.now()) {
        for (const [key, hit] of this.store) {
            if (hit.expires <= now) this.store.delete(key);
        }
        while (this.store.size > this.maxEntries) {
            this.store.delete(this.store.keys().next().value);
        }
    }

    async getOrLoad(key, ttlMs, loader) {
        const hit = this.store.get(key);
        if (hit && hit.expires > Date.now()) {
            return { value: hit.value, cached: true };
        }
        const running = this.inflight.get(key);
        if (running) {
            const value = await running;
            return { value, cached: false };
        }

        const pending = Promise.resolve().then(loader);
        this.inflight.set(key, pending);
        try {
            const value = await pending;
            // delete() (a fresh=1 resolve) may have started a newer load for
            // this key. The older result must not overwrite it.
            if (this.inflight.get(key) === pending) {
                this.store.delete(key);
                // A function lets the value set its own lifetime (a signed
                // URL that ends sooner); 0 or less is not stored at all.
                const ttl = typeof ttlMs === 'function' ? ttlMs(value) : ttlMs;
                if (ttl > 0) this.store.set(key, { value, expires: Date.now() + ttl });
                this.prune();
            }
            return { value, cached: false };
        } finally {
            if (this.inflight.get(key) === pending) this.inflight.delete(key);
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
