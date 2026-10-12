import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CdpConnectionManager, __setCdpForTest } from './connection.js';

/**
 * Build a fake CDP client supporting Page/Runtime stubs and an `__emit`
 * test hook for synchronously firing registered handlers.
 */
function makeFakeClient(initialFrameUrl, mainFrameId = 'main-frame-id') {
  const handlers = {};
  return {
    on: (event, fn) => {
      (handlers[event] ||= []).push(fn);
    },
    removeListener: (event, fn) => {
      handlers[event] = (handlers[event] || []).filter((h) => h !== fn);
    },
    close: async () => {},
    Page: {
      enable: async () => {},
      getFrameTree: async () => ({
        frameTree: {
          frame: { id: mainFrameId, url: initialFrameUrl, name: 'top' },
        },
      }),
    },
    Runtime: { enable: async () => {} },
    /** Test-only synchronous event emitter — invokes registered handlers. */
    __emit: (event, params) => {
      for (const fn of handlers[event] || []) fn(params);
    },
    __mainFrameId: mainFrameId,
  };
}

/**
 * Build a fake CDP factory function that mimics the real package's default
 * export: `CDP({ target, port, host })` returns a Client; `CDP.List(...)`
 * returns the discovered tab list.
 */
function makeFakeCdp(client, tab) {
  const fn = async () => client;
  fn.List = async () => [tab];
  return fn;
}

/**
 * Like makeFakeCdp but counts how many times the factory is invoked as
 * `CDP({...})`. Each connect/reconnect bumps the count, so `fn.calls > 1`
 * proves a reconnect actually happened. The same `client` singleton is
 * returned every call.
 */
function makeCountingCdp(client, tab) {
  const fn = async () => {
    fn.calls += 1;
    return client;
  };
  fn.calls = 0;
  fn.List = async () => [tab];
  return fn;
}

const OLD_URL = 'https://app.gohighlevel.com/v2/location/OLD/automation/workflows';
const NEW_URL = 'https://app.gohighlevel.com/v2/location/NEW/automation/workflows';
const SUB_URL = 'https://app.gohighlevel.com/v2/location/SUB/automation/workflows';

function makeTab(url) {
  return { id: 'tab-1', type: 'page', url, title: 'GHL workflows' };
}

describe('CdpConnectionManager onLocationChange', () => {
  afterEach(() => {
    __setCdpForTest(null);
  });

  it('main-frame same-document nav to a new locationId updates state and fires callback', async () => {
    const client = makeFakeClient(OLD_URL);
    __setCdpForTest(makeFakeCdp(client, makeTab(OLD_URL)));

    const mgr = new CdpConnectionManager(49222);
    await mgr.connect();
    assert.equal(mgr.getLocationId(), 'OLD');

    const calls = [];
    mgr.onLocationChange((newId, prevId) => calls.push([newId, prevId]));

    client.__emit('Page.navigatedWithinDocument', {
      frameId: client.__mainFrameId,
      url: NEW_URL,
    });

    assert.equal(mgr.getLocationId(), 'NEW');
    assert.deepEqual(calls, [['NEW', 'OLD']]);
  });

  it('sub-frame nav with a different locationId is ignored (no state change, no callback)', async () => {
    const client = makeFakeClient(OLD_URL);
    __setCdpForTest(makeFakeCdp(client, makeTab(OLD_URL)));

    const mgr = new CdpConnectionManager(49222);
    await mgr.connect();

    const calls = [];
    mgr.onLocationChange((newId, prevId) => calls.push([newId, prevId]));

    // frameNavigated for a sub-frame (parentId is the main frame id)
    client.__emit('Page.frameNavigated', {
      frame: {
        id: 'sub-frame-id',
        parentId: client.__mainFrameId,
        url: SUB_URL,
        name: 'iframe',
      },
    });

    assert.equal(mgr.getLocationId(), 'OLD');
    assert.deepEqual(calls, []);
  });

  it('main-frame nav to a non-GHL URL does not change locationId or fire callback', async () => {
    const client = makeFakeClient(OLD_URL);
    __setCdpForTest(makeFakeCdp(client, makeTab(OLD_URL)));

    const mgr = new CdpConnectionManager(49222);
    await mgr.connect();

    const calls = [];
    mgr.onLocationChange((newId, prevId) => calls.push([newId, prevId]));

    client.__emit('Page.navigatedWithinDocument', {
      frameId: client.__mainFrameId,
      url: 'https://example.com/foo',
    });

    assert.equal(mgr.getLocationId(), 'OLD');
    assert.deepEqual(calls, []);
  });

  it('main-frame nav to a non-/v2/ /location/<id> URL (workflow editor page) does not fire callback', async () => {
    // The workflow editor microfrontend uses /location/<id>/... without the
    // /v2/ prefix. Navigating into the editor stays inside the same sub-account
    // and must NOT trigger a locationId change — only /v2/location/ swaps count.
    const client = makeFakeClient(OLD_URL);
    __setCdpForTest(makeFakeCdp(client, makeTab(OLD_URL)));

    const mgr = new CdpConnectionManager(49222);
    await mgr.connect();

    const calls = [];
    mgr.onLocationChange((newId, prevId) => calls.push([newId, prevId]));

    client.__emit('Page.navigatedWithinDocument', {
      frameId: client.__mainFrameId,
      url: 'https://app.gohighlevel.com/location/SOMEOTHER/automation/workflows/builder/abc123',
    });

    assert.equal(mgr.getLocationId(), 'OLD');
    assert.deepEqual(calls, []);
  });

  it('callback registered after connect() still fires on the next main-frame nav', async () => {
    const client = makeFakeClient(OLD_URL);
    __setCdpForTest(makeFakeCdp(client, makeTab(OLD_URL)));

    const mgr = new CdpConnectionManager(49222);
    await mgr.connect();

    // Emit one nav before the callback is registered — should NOT throw, but
    // also should still update state (proving the listener is wired even
    // without a consumer).
    client.__emit('Page.navigatedWithinDocument', {
      frameId: client.__mainFrameId,
      url: NEW_URL,
    });
    assert.equal(mgr.getLocationId(), 'NEW');

    // Now register the callback and emit another nav.
    const calls = [];
    mgr.onLocationChange((newId, prevId) => calls.push([newId, prevId]));

    const URL2 = 'https://app.gohighlevel.com/v2/location/SECOND/automation/workflows';
    client.__emit('Page.navigatedWithinDocument', {
      frameId: client.__mainFrameId,
      url: URL2,
    });

    assert.equal(mgr.getLocationId(), 'SECOND');
    assert.deepEqual(calls, [['SECOND', 'NEW']]);
  });
});

describe('CdpConnectionManager reconnect on transport failure', () => {
  afterEach(() => {
    __setCdpForTest(null);
  });

  it('transport failure reconnects, retries once, and succeeds', async () => {
    const client = makeFakeClient(OLD_URL);
    let evalCalls = 0;
    client.Runtime.evaluate = async () => {
      evalCalls += 1;
      if (evalCalls === 1) throw new Error('socket hang up');
      return { result: { value: 'ok' } };
    };

    const cdp = makeCountingCdp(client, makeTab(OLD_URL));
    __setCdpForTest(cdp);

    const mgr = new CdpConnectionManager(49222);
    await mgr.connect(); // initial connect => cdp.calls === 1

    const value = await mgr.evaluate('1+1');

    assert.equal(value, 'ok');
    assert.equal(evalCalls, 2); // failed once, retried once
    assert.ok(cdp.calls > 1, 'reconnect should have invoked the CDP factory again');
  });

  it('in-page app error (exceptionDetails) is NOT retried', async () => {
    const client = makeFakeClient(OLD_URL);
    let evalCalls = 0;
    client.Runtime.evaluate = async () => {
      evalCalls += 1;
      return { exceptionDetails: { text: 'boom' } };
    };

    const cdp = makeCountingCdp(client, makeTab(OLD_URL));
    __setCdpForTest(cdp);

    const mgr = new CdpConnectionManager(49222);
    await mgr.connect(); // cdp.calls === 1

    await assert.rejects(() => mgr.evaluate('x'), /CDP evaluate failed/);

    assert.equal(evalCalls, 1); // no retry on app error
    assert.equal(cdp.calls, 1); // no reconnect beyond initial connect
  });

  it('a second transport failure propagates after exactly one retry (no loop)', async () => {
    const client = makeFakeClient(OLD_URL);
    let evalCalls = 0;
    client.Runtime.evaluate = async () => {
      evalCalls += 1;
      throw new Error('socket hang up');
    };

    const cdp = makeCountingCdp(client, makeTab(OLD_URL));
    __setCdpForTest(cdp);

    const mgr = new CdpConnectionManager(49222);
    await mgr.connect();

    await assert.rejects(() => mgr.evaluate('x'), /socket hang up/);

    assert.equal(evalCalls, 2); // initial + one retry only
  });
});
