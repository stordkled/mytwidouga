// Test-only DNS shim. The spawned server requires this so ev.phncdn.com
// resolves to the local rate-limited file server. It is not used in production.
const dns = require('dns');

const original = dns.lookup;
dns.lookup = function lookup(hostname, options, callback) {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }
    if (hostname === 'ev.phncdn.com') {
        if (typeof callback === 'function') {
            if (options && options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
            else callback(null, '127.0.0.1', 4);
        }
        return {};
    }
    return original.call(dns, hostname, options, callback);
};
