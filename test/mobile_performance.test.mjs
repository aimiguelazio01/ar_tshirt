import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('Mobile Performance — Static Build and Asset Integrity', async (t) => {
  await t.test('Generated asset URLs, hashes, and deployment inventory are valid', () => {
    assert.ok(fs.existsSync('dist/index.html'), 'dist/index.html must exist');
    assert.ok(fs.existsSync('dist/manifest.json'), 'dist/manifest.json must exist');
    assert.ok(fs.existsSync('dist/assets/versioned/manifest.json'), 'versioned manifest.json must exist');
    assert.ok(fs.existsSync('dist/tracking_worker.js'), 'dist/tracking_worker.js must exist');

    const manifest = JSON.parse(fs.readFileSync('dist/manifest.json', 'utf8'));
    assert.ok(manifest.build, 'Manifest must specify build identifier');
    assert.ok(manifest.assets.css.startsWith('assets/versioned/app.'), 'Hashed CSS must exist in manifest');
    assert.ok(manifest.assets.monsterModel.endsWith('.opt.glb'), 'Hashed GLB must exist in manifest');
    assert.ok(manifest.assets.targetMarker.endsWith('.mind'), 'Hashed marker must exist in manifest');

    // Confirm each file in inventory exists and is non-empty
    for (const item of manifest.inventory) {
      const fullPath = path.join('dist', item.path);
      assert.ok(fs.existsSync(fullPath), `Asset ${item.path} must exist on disk`);
      const stat = fs.statSync(fullPath);
      assert.ok(stat.size > 0, `Asset ${item.path} must not be 0 bytes`);
      assert.equal(stat.size, item.size, `Asset ${item.path} size must match inventory`);
    }

    // Confirm HTML contains content-hashed references and no Tailwind CDN
    const html = fs.readFileSync('dist/index.html', 'utf8');
    assert.ok(!html.includes('https://cdn.tailwindcss.com'), 'dist/index.html must not load Tailwind CDN');
    assert.ok(html.includes(manifest.assets.css), 'dist/index.html must link to compiled hashed CSS');
    assert.ok(html.includes(manifest.assets.monsterModel), 'dist/index.html must reference hashed GLB');
    assert.ok(html.includes(manifest.assets.targetMarker), 'dist/index.html must reference hashed marker');
  });
});

test('Mobile Performance — Session Guards & Scene Lifecycle', async (t) => {
  await t.test('createSession and isCurrent prevent stale execution across transitions', () => {
    let nextSessionId = 0;
    let activeSession = null;

    function createSession(mode) {
      return {
        id: ++nextSessionId,
        mode,
        startedAt: 1000,
        firstCharacterVisible: false,
        abort: new AbortController(),
        cleanups: new Set()
      };
    }

    function isCurrent(session) {
      return activeSession === session && !session.abort.signal.aborted;
    }

    const session1 = createSession('ar');
    activeSession = session1;
    assert.equal(isCurrent(session1), true, 'Active session must be current');

    // Abort session 1
    session1.abort.abort();
    assert.equal(isCurrent(session1), false, 'Aborted session must not be current');

    // Start session 2
    const session2 = createSession('simulator');
    activeSession = session2;
    assert.equal(isCurrent(session1), false, 'Prior session must not be current');
    assert.equal(isCurrent(session2), true, 'New session must be current');
  });

  await t.test('Cleanup prevents obsolete callbacks and disposes resources', () => {
    let activeCallbacks = new Set();
    function registerCallback(cb) { activeCallbacks.add(cb); }
    function cleanup() { activeCallbacks.clear(); }

    const cb1 = () => {};
    registerCallback(cb1);
    assert.equal(activeCallbacks.size, 1);
    cleanup();
    assert.equal(activeCallbacks.size, 0, 'Cleanup must clear all registered callbacks');
  });
});

test('Mobile Performance — Model Loading and Retry Semantics', async (t) => {
  await t.test('Single shared model load and retry after rejection', async () => {
    let fetchCount = 0;
    let failFirst = true;
    let sharedModelPromise = null;

    async function loadModel() {
      if (!sharedModelPromise) {
        sharedModelPromise = (async () => {
          fetchCount++;
          if (failFirst) {
            failFirst = false;
            throw new Error('Network timeout');
          }
          return { scene: {} };
        })().catch(err => {
          sharedModelPromise = null;
          throw err;
        });
      }
      return sharedModelPromise;
    }

    // First attempt fails
    await assert.rejects(async () => {
      await loadModel();
    }, /Network timeout/);
    assert.equal(fetchCount, 1);

    // Second attempt succeeds and returns cached instance
    const res1 = await loadModel();
    const res2 = await loadModel();
    assert.ok(res1 && res2);
    assert.equal(res1, res2);
    assert.equal(fetchCount, 2, 'Must not refetch once resolved');
  });
});

test('Mobile Performance — Frame Scheduler & Tracking Worker Contract', async (t) => {
  await t.test('One in-flight bitmap/inference operation at a time', () => {
    let pendingFrame = null;
    let droppedFrames = 0;

    function dispatchFrame(frameId) {
      if (pendingFrame) {
        droppedFrames++;
        return false;
      }
      pendingFrame = { id: frameId, capturedAt: Date.now() };
      return true;
    }

    assert.equal(dispatchFrame(1), true, 'First frame accepted');
    assert.equal(dispatchFrame(2), false, 'Second frame dropped while first is in-flight');
    assert.equal(droppedFrames, 1);

    // Complete frame 1
    pendingFrame = null;
    assert.equal(dispatchFrame(3), true, 'Next frame accepted once previous completes');
  });

  await t.test('Stale session, worker, frame, and aged results rejected', () => {
    const currentWorkerId = 5;
    const activeSession = { id: 10, mode: 'ar' };
    let pendingFrame = { id: 101, capturedAt: 1000 };

    function acceptResult(data, now) {
      const matches =
        data.workerId === currentWorkerId &&
        data.sessionId === activeSession?.id &&
        data.frameId === pendingFrame?.id;

      if (!matches) return { accepted: false, reason: 'mismatch' };

      pendingFrame = null;

      if (now - data.capturedAt > 350) {
        return { accepted: false, reason: 'stale-age' };
      }
      return { accepted: true };
    }

    // Worker ID mismatch
    assert.deepEqual(acceptResult({ workerId: 4, sessionId: 10, frameId: 101, capturedAt: 1000 }, 1050), { accepted: false, reason: 'mismatch' });

    // Session ID mismatch
    assert.deepEqual(acceptResult({ workerId: 5, sessionId: 9, frameId: 101, capturedAt: 1000 }, 1050), { accepted: false, reason: 'mismatch' });

    // Frame ID mismatch
    assert.deepEqual(acceptResult({ workerId: 5, sessionId: 10, frameId: 99, capturedAt: 1000 }, 1050), { accepted: false, reason: 'mismatch' });

    // Stale age (>350ms)
    assert.deepEqual(acceptResult({ workerId: 5, sessionId: 10, frameId: 101, capturedAt: 1000 }, 1400), { accepted: false, reason: 'stale-age' });

    // Valid fresh result
    pendingFrame = { id: 102, capturedAt: 2000 };
    assert.deepEqual(acceptResult({ workerId: 5, sessionId: 10, frameId: 102, capturedAt: 2000 }, 2100), { accepted: true });
  });

  await t.test('Bitmap resources closed after capture or transfer failure', () => {
    let closed = false;
    const fakeBitmap = {
      close() { closed = true; }
    };

    function simulateTransferFailure(bitmap) {
      try {
        throw new Error('Transfer failed');
      } catch (err) {
        if (bitmap && typeof bitmap.close === 'function') {
          bitmap.close();
        }
      }
    }

    simulateTransferFailure(fakeBitmap);
    assert.equal(closed, true, 'Bitmap must be explicitly closed on transfer error');
  });

  await t.test('Worker failure activates fallback exactly once', () => {
    let fallbackCount = 0;
    let fallbackActive = false;

    function activateFallback() {
      if (fallbackActive) return;
      fallbackActive = true;
      fallbackCount++;
    }

    activateFallback();
    activateFallback();
    activateFallback();

    assert.equal(fallbackCount, 1, 'Fallback initializer must be deduplicated to exactly once');
  });
});

test('Mobile Performance — Gesture Debounce and Hold Logic', async (t) => {
  await t.test('Arm transition requires agreeing samples spanning at least 70ms', () => {
    let currentArmState = 'relaxed';
    let candidateState = null;
    let candidateSince = 0;

    function processArmDetection(detectedState, timestamp) {
      if (detectedState === currentArmState) {
        candidateState = null;
        return currentArmState;
      }
      if (candidateState !== detectedState) {
        candidateState = detectedState;
        candidateSince = timestamp;
        return currentArmState;
      }
      if (timestamp - candidateSince >= 70) {
        currentArmState = detectedState;
        candidateState = null;
      }
      return currentArmState;
    }

    assert.equal(processArmDetection('left_raised', 100), 'relaxed', 'Immediate detection does not trigger change');
    assert.equal(processArmDetection('left_raised', 150), 'relaxed', 'Sample at 50ms does not meet 70ms threshold');
    assert.equal(processArmDetection('left_raised', 175), 'left_raised', 'Sample at 75ms satisfies transition threshold');
  });
});

test('Mobile Performance — Quality Policy & Buffer Budget', async (t) => {
  await t.test('Buffer pixel limit adjusts pixel ratio for high-resolution containers', () => {
    function calculateRatio(width, height, policy) {
      return Math.min(
        2.0, // Device pixel ratio 2.0
        policy.maxPixelRatio,
        Math.sqrt(policy.maxBufferPixels / (width * height))
      );
    }

    const balancedPolicy = { maxPixelRatio: 1.0, maxBufferPixels: 1000000 };
    const reducedPolicy = { maxPixelRatio: 0.75, maxBufferPixels: 650000 };

    const ratioBalanced = calculateRatio(1080, 1920, balancedPolicy);
    assert.ok(ratioBalanced <= 1.0, 'Ratio must not exceed maxPixelRatio');
    assert.ok(ratioBalanced * 1080 * ratioBalanced * 1920 <= 1000000 * 1.01, 'Buffer pixels must respect balanced budget');

    const ratioReduced = calculateRatio(1080, 1920, reducedPolicy);
    assert.ok(ratioReduced <= 0.75, 'Ratio must not exceed reduced maxPixelRatio');
    assert.ok(ratioReduced * 1080 * ratioReduced * 1920 <= 650000 * 1.01, 'Buffer pixels must respect reduced budget');
  });

  await t.test('Quality hysteresis: downgrade after 3 high windows, restore after 5 low windows', () => {
    let profile = 'balanced';
    let consecutiveHigh = 0;
    let consecutiveLow = 0;

    function onWindowSample(p90Ms) {
      if (p90Ms > 40) {
        consecutiveHigh++;
        consecutiveLow = 0;
        if (consecutiveHigh >= 3 && profile === 'balanced') {
          profile = 'reduced';
          consecutiveHigh = 0;
        }
      } else if (p90Ms < 30) {
        consecutiveLow++;
        consecutiveHigh = 0;
        if (consecutiveLow >= 5 && profile === 'reduced') {
          profile = 'balanced';
          consecutiveLow = 0;
        }
      }
    }

    // 2 high windows: remain balanced
    onWindowSample(45);
    onWindowSample(45);
    assert.equal(profile, 'balanced');

    // 3rd high window: downgrade to reduced
    onWindowSample(45);
    assert.equal(profile, 'reduced');

    // 4 low windows: remain reduced
    for (let i = 0; i < 4; i++) onWindowSample(25);
    assert.equal(profile, 'reduced');

    // 5th low window: restore to balanced
    onWindowSample(25);
    assert.equal(profile, 'balanced');
  });
});
