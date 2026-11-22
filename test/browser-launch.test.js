const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { createLaunchGate } = require('../lib/browser');

function fakeBrowser() {
    const emitter = new EventEmitter();
    return {
        connected: true,
        on: emitter.on.bind(emitter),
        disconnect() {
            this.connected = false;
            emitter.emit('disconnected');
        },
    };
}

test('a disconnected browser is launched again', async () => {
    const gate = createLaunchGate();
    let launches = 0;
    const first = await gate.start(() => {
        launches += 1;
        return fakeBrowser();
    });
    first.disconnect();
    const second = await gate.start(() => {
        launches += 1;
        return fakeBrowser();
    });
    assert.equal(launches, 2);
    assert.notEqual(first, second);
    assert.equal(gate.current(), second);
});

test('one launch is shared until that browser disconnects', async () => {
    const gate = createLaunchGate();
    let launches = 0;
    let finish;
    const pending = gate.start(() => new Promise((resolve) => {
        launches += 1;
        finish = resolve;
    }));
    const again = gate.start(() => {
        launches += 1;
        return fakeBrowser();
    });
    await new Promise((resolve) => setImmediate(resolve));
    const browser = fakeBrowser();
    finish(browser);
    assert.equal(await pending, browser);
    assert.equal(await again, browser);
    assert.equal(launches, 1);
});
