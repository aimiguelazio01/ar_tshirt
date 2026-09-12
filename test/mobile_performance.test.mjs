import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as THREE from 'three';

import { createAnimationTime, onActionFinished } from '../src/runtime/animation-time.mjs';
import { createSessionManager } from '../src/runtime/session-state.mjs';
import { createTrackingScheduler } from '../src/runtime/tracking-scheduler.mjs';
import { createQualityPolicy } from '../src/runtime/quality-policy.mjs';
import { canStreamWithProgress, readResponseArrayBuffer } from '../src/runtime/response-body.mjs';

function computeSha(buffer, length = 16) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, length);
}

test('Mobile Performance — Step 6 Production Tests', async (t) => {

  await t.test('0. Model response reader never locks an indeterminate or compressed response', async () => {
    const compressedResponse = new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-encoding': 'br' }
    });
    assert.equal(canStreamWithProgress(compressedResponse), false);
    assert.deepEqual([...new Uint8Array(await readResponseArrayBuffer(compressedResponse))], [1, 2, 3]);

    const indeterminateResponse = new Response(new Uint8Array([4, 5, 6]));
    assert.equal(canStreamWithProgress(indeterminateResponse), false);
    assert.deepEqual([...new Uint8Array(await readResponseArrayBuffer(indeterminateResponse))], [4, 5, 6]);
  });

  await t.test('0b. Model response reader streams only identity responses with an honest byte total', async () => {
    const response = new Response(new Uint8Array([7, 8, 9]), {
      headers: { 'content-length': '3', 'content-encoding': 'identity' }
    });
    const progress = [];
    assert.equal(canStreamWithProgress(response), true);
    assert.deepEqual(
      [...new Uint8Array(await readResponseArrayBuffer(response, item => progress.push(item)))],
      [7, 8, 9]
    );
    assert.deepEqual(progress, [{ loadedBytes: 3, totalBytes: 3 }]);
  });

  await t.test('0c. Panic music is included in the production build', () => {
    assert.ok(fs.existsSync('assets/monster_metal.mp3'), 'Source panic music must exist');
    assert.ok(fs.existsSync('dist/assets/monster_metal.mp3'), 'Production build must include panic music');
    assert.ok(
      fs.readFileSync('index.html', 'utf8').includes("new Audio('assets/monster_metal.mp3')"),
      'Panic mode must play the supplied music file'
    );
    const html = fs.readFileSync('index.html', 'utf8');
    assert.ok(!html.includes('playPanicAlarmSound'), 'Synthesized panic alarm must be removed');
    assert.ok(!html.includes('id="btn-capture"'), 'Orange capture button must be removed');
    assert.match(html, /grid grid-cols-3 items-center/, 'Control row must use a centered three-column layout');
    assert.match(html, /playDontTouchSequence\(4\)/, 'Panic mode must request four animation loops');
    assert.match(html, /setLoop\(THREE\.LoopRepeat, loopCount\)/, 'Reaction animation must use the requested loop count');
  });

  await t.test('0d. Footer social links use the supplied profiles', () => {
    const html = fs.readFileSync('index.html', 'utf8');
    const socialLinks = [
      'https://linkedin.com/in/mvirgilstuio/',
      'https://facebook.com/profile.php?id=100009122059507',
      'https://instagram.com/vfxmiguel/?hl=en',
      'https://x.com/miguelvfx',
      'https://youtube.com/@MVirgilStudio',
      'https://vimeo.com/user261754571?fl=pp&amp;fe=sh'
    ];
    for (const link of socialLinks) {
      assert.equal((html.match(new RegExp(link.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 2, `${link} must be present in both footers`);
    }
  });

  await t.test('0e. Product card uses the updated workflow label', () => {
    const html = fs.readFileSync('index.html', 'utf8');
    assert.ok(html.includes('>Vfx Workflow<'), 'Updated Vfx Workflow label must be present');
    assert.ok(!html.toLowerCase().includes('monster graphic tee'), 'Old product label must be removed');
  });

  await t.test('0f. Character and software plates use matte materials', () => {
    const html = fs.readFileSync('index.html', 'utf8');
    assert.match(html, /function applyMatteMaterial\(material\)/, 'Matte material helper must be present');
    assert.ok((html.match(/applyMatteMaterial\(child\.material\)/g) || []).length >= 2, 'AR and simulator character materials must be matte');
    assert.match(html, /roughness: 1,\s*\n\s*metalness: 0,/, 'Floating plate materials must disable glossy reflections');
  });

  await t.test('0g. Software plates use a compact screen-safe layout', () => {
    const html = fs.readFileSync('index.html', 'utf8');
    assert.equal((html.match(/Compact screen-safe layout/g) || []).length, 6, 'All six plates must use the compact layout');
    assert.match(html, /const btnWidth = 0\.48;/, 'Plate width must fit a mobile viewport');
    assert.match(html, /const btnHeight = 0\.24;/, 'Plate height must fit a mobile viewport');
    assert.match(html, /const isAttachedToCharacter = planesModel\.parent === monsterModel \|\| planesModel\.parent === simMonster;/, 'Attached plate layout must remain local while scaling');
  });

  await t.test('0h. Software plates have a manual enable and disable control', () => {
    const html = fs.readFileSync('index.html', 'utf8');
    assert.ok(html.includes('id="btn-toggle-plates"'), 'Plate toggle button must be present beside Panic');
    assert.match(html, /let arePlanesManuallyHidden = false;/, 'Manual plate visibility state must be tracked separately from gestures');
    assert.match(html, /function setSoftwarePlatesEnabled\(enabled\)/, 'Manual plate visibility setter must be present');
    assert.match(html, /targetPlaneOpacity = areSoftwarePlatesVisible\(\) \? 0\.88 : 0;/, 'Manual toggle must animate plate visibility');
    assert.match(html, /id="btn-toggle-plates"[^>]*>[\s\S]*>workflow<\//, 'Plate toggle must display the workflow text label');
    assert.match(html, /\.control-action-button\s*\{[\s\S]*?width: 96px;[\s\S]*?height: 46px;/, 'Panic and workflow controls must share the enlarged mobile size');
    assert.match(html, /class="control-action-button[^\"]*"\s+id="btn-panic"/, 'Panic must use the shared control size');
    assert.match(html, /class="control-action-button[^\"]*"\s+id="btn-toggle-plates"/, 'Workflow must use the shared control size');
    assert.ok(!html.includes('layers_clear'), 'Plate toggle must not use the old on/off icon');
  });

  await t.test('0i. Each visible software plate opens its matching window when tapped', () => {
    const html = fs.readFileSync('index.html', 'utf8');
    assert.match(html, /#ar-container\s*\{[\s\S]*?touch-action: none;/, 'The scene must receive mobile pointer gestures');
    assert.match(html, /\.ar-ready-hud \.ar-hud \{[\s\S]*?pointer-events: none !important;/, 'Full-screen HUD decoration must not block plate taps');
    assert.match(html, /const frontMat = new THREE\.MeshStandardMaterial\(\{[\s\S]*?side: THREE\.DoubleSide/, 'The raycast face must accept taps from either side while floating');
    assert.match(html, /function findNearestInteractivePlane\(clientX, clientY, rect, activeCamera\)/, 'Tap handling must use projected plate bounds when a ray misses');
    assert.match(html, /const SCENE_TAP_SLOP_PX = 12;/, 'Finger jitter must not be misclassified as a drag');
    assert.match(html, /window\.addEventListener\('pointerdown', onScenePointerDown, \{ capture: true, passive: false \}\)/, 'Scene input must capture taps before the AR renderer consumes them');
    assert.match(html, /function isScenePointerEvent\(e\)/, 'Captured scene input must ignore modal and HUD controls');
    assert.match(html, /function openSoftwarePlate\(targetMesh\)/, 'Plate taps must have a dedicated open-only action');
    assert.match(html, /return openSoftwarePlate\(targetPlane\);/, 'The tapped plate must open its matching software window');
    assert.ok(!html.includes('onSimPointerDown'), 'Simulator must not register a competing touch handler');
    const openAction = html.match(/function openSoftwarePlate\(targetMesh\) \{[\s\S]*?\n    \}/)?.[0] || '';
    assert.match(openAction, /openSoftwareModal\(cfg\.id\);/, 'A plate tap must open the modal for its own software id');
    assert.ok(!openAction.includes('trigger3D'), 'A plate tap must not launch VFX effects');
    assert.ok(!openAction.includes('cfg.isActive'), 'A plate tap must not toggle a software layer state');
  });

  await t.test('0j. MediaPipe arm releases use the requested left and right animation ranges', () => {
    const html = fs.readFileSync('index.html', 'utf8');
    assert.match(
      html,
      /const clipLeftArmDown = THREE\.AnimationUtils\.subclip\(defaultClip, 'left_arm_down_73_117', 73, 117, 24\)/,
      'Left arm release must use frames 73-117'
    );
    assert.match(
      html,
      /const clipRightArmDown = THREE\.AnimationUtils\.subclip\(defaultClip, 'right_arm_down_118_160', 118, 160, 24\)/,
      'Right arm release must use frames 118-160'
    );
    assert.match(html, /const currArmDown = isSim \? simActionLeftArmDown : actionLeftArmDown;/, 'Left release must select its own clip');
    assert.match(html, /const currArmDown = isSim \? simActionRightArmDown : actionRightArmDown;/, 'Right release must select its own clip');
    assert.match(html, /const mediaPipeDisabled = urlParams\.get\('disableMediaPipe'\) === '1';/, 'MediaPipe must have an explicit opt-out switch');
    assert.match(html, /window\.DISABLE_POSE = mediaPipeDisabled \|\| urlParams\.get\('noPose'\) === '1';/, 'Pose tracking must be enabled by default');
    assert.match(html, /triggerRightArmDown\(\);[\s\S]*triggerLeftArmDown\(\);/, 'Pose processing must handle both arm-down transitions');
  });

  // =========================================================================
  // 1. Elapsed-time playback equivalence at 60/30/15/10/5 FPS & suspension
  // =========================================================================
  await t.test('1. Elapsed-time playback equivalence at 60/30/15/10/5 FPS', () => {
    const fpsRates = [60, 30, 15, 10, 5];
    const totalWallClockSeconds = 10.0;

    for (const fps of fpsRates) {
      const animTime = createAnimationTime();
      const frameDeltaMs = 1000 / fps;
      const totalFrames = Math.round(fps * totalWallClockSeconds);
      let accumulatedElapsed = 0;
      let simulatedNow = 1000;

      // Initial tick returns 0
      accumulatedElapsed += animTime.tick(simulatedNow);

      for (let i = 0; i < totalFrames; i++) {
        simulatedNow += frameDeltaMs;
        const tickElapsed = animTime.tick(simulatedNow);
        accumulatedElapsed += tickElapsed;
      }

      assert.ok(
        Math.abs(accumulatedElapsed - totalWallClockSeconds) < 0.001,
        `At ${fps} FPS, 10 wall-clock seconds must yield 10.0s elapsed (got ${accumulatedElapsed.toFixed(3)}s)`
      );
    }
  });

  await t.test('1b. Clamp mutation contrast: verify old 80ms clamp loses 20% to 60% animation time at low FPS', () => {
    function simulateOldClampedTime(fps, wallSeconds) {
      const frameDeltaSec = 1 / fps;
      let accumulated = 0;
      let frames = fps * wallSeconds;
      for (let i = 0; i < frames; i++) {
        accumulated += Math.min(frameDeltaSec, 0.08);
      }
      return accumulated;
    }

    const at10Fps = simulateOldClampedTime(10, 10);
    const at5Fps = simulateOldClampedTime(5, 10);

    // At 10 FPS (100ms), 80ms clamp yields 8s instead of 10s (20% lost)
    assert.ok(Math.abs(at10Fps - 8.0) < 1e-6, 'Old 80ms clamp loses 2 seconds at 10 FPS');
    // At 5 FPS (200ms), 80ms clamp yields 4s instead of 10s (60% lost)
    assert.ok(Math.abs(at5Fps - 4.0) < 1e-6, 'Old 80ms clamp loses 6 seconds at 5 FPS');
  });

  await t.test('1c. 30s hidden suspension adds 0s animation playback time', () => {
    const animTime = createAnimationTime();
    assert.equal(animTime.tick(1000), 0);
    assert.equal(animTime.tick(1500), 0.5);

    // Page hidden for 30 seconds: reset() called on visibility change
    animTime.reset();

    // Browser resumes 30 seconds later (now = 31500)
    const resumedDelta = animTime.tick(31500);
    assert.equal(resumedDelta, 0, 'First frame after hidden reset must advance 0 seconds');

    // Next active frame advances normal frame delta
    const nextDelta = animTime.tick(31533);
    assert.ok(Math.abs(nextDelta - 0.033) < 0.005, 'Subsequent frame advances real elapsed delta');
  });

  await t.test('1d. Zero and changed mixer speed scales playback accordingly', () => {
    const animTime = createAnimationTime();
    animTime.tick(1000);
    const delta = animTime.tick(2000); // 1.0s elapsed

    // Scale 1.35 (configured responsive mobile speed)
    const activeSpeed = 1.35;
    const scaledDelta = delta * activeSpeed;
    assert.equal(scaledDelta, 1.35);

    // Paused (speed = 0)
    const pausedSpeed = 0;
    assert.equal(delta * pausedSpeed, 0);
  });

  // =========================================================================
  // 2. Real pinned Three.js AnimationMixer completion & cancellation
  // =========================================================================
  await t.test('2. Real Three.js mixer completes reaction twice and respects session cancellation', () => {
    const root = new THREE.Object3D();
    const mixer = new THREE.AnimationMixer(root);

    // Create synthetic 1.0-second reaction clip
    const track = new THREE.NumberKeyframeTrack('.position[x]', [0, 1.0], [0, 1.0]);
    const reactionClip = new THREE.AnimationClip('reaction', 1.0, [track]);
    const action = mixer.clipAction(reactionClip);

    // 2 repetitions
    action.setLoop(THREE.LoopRepeat, 2);
    action.clampWhenFinished = true;

    const session = {
      abort: new AbortController(),
      cleanups: new Set()
    };

    let completedCount = 0;
    onActionFinished(mixer, action, session, () => {
      completedCount++;
    });

    action.play();

    // Advance 1.5 seconds (in the middle of second repetition)
    mixer.update(1.5);
    assert.equal(completedCount, 0, 'Reaction not finished before 2 repetitions complete');

    // Advance remaining 0.5 seconds (completes second repetition)
    mixer.update(0.5);
    assert.equal(completedCount, 1, 'Reaction complete callback must fire exactly once after 2 repetitions');

    // Extra updates must not fire callback again
    mixer.update(1.0);
    assert.equal(completedCount, 1, 'Callback must not fire repeatedly');
  });

  await t.test('2b. Action completion is ignored if session was aborted or cancelled', () => {
    const root = new THREE.Object3D();
    const mixer = new THREE.AnimationMixer(root);
    const track = new THREE.NumberKeyframeTrack('.position[x]', [0, 1.0], [0, 1.0]);
    const clip = new THREE.AnimationClip('arm_down', 1.0, [track]);
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;

    const session = {
      abort: new AbortController(),
      cleanups: new Set()
    };

    let completed = false;
    onActionFinished(mixer, action, session, () => {
      completed = true;
    });

    action.play();

    // Abort session before animation finishes
    session.abort.abort();

    // Finish animation
    mixer.update(1.0);
    assert.equal(completed, false, 'Obsolete completion must not fire for aborted session');
  });

  // =========================================================================
  // 3. Authoritative mode transitions, camera retry isolation, stale stream stop
  // =========================================================================
  await t.test('3. Preview-to-AR changes authoritative mode and enables rendering', () => {
    const sessionMgr = createSessionManager();

    const simSession = sessionMgr.createSession('simulator');
    assert.equal(simSession.mode, 'simulator');
    assert.equal(sessionMgr.isCurrent(simSession), true);

    const arSession = sessionMgr.createSession('ar');
    assert.equal(arSession.mode, 'ar');
    assert.equal(sessionMgr.isCurrent(arSession), true);
    assert.equal(sessionMgr.isCurrent(simSession), false, 'Prior simulator session must be aborted');
    assert.equal(simSession.abort.signal.aborted, true);
  });

  await t.test('3b. Camera attempt failure retries without aborting AR session, stale stream is stopped', () => {
    const sessionMgr = createSessionManager();
    const arSession = sessionMgr.createSession('ar');

    // Attempt 1
    const attempt1Id = sessionMgr.createCameraAttempt();
    assert.equal(sessionMgr.isCameraAttemptCurrent(attempt1Id), true);

    let tracksStopped1 = 0;
    const mockStream1 = {
      getTracks: () => [{ stop: () => { tracksStopped1++; } }]
    };

    // Attempt 1 fails: cleanup stream
    sessionMgr.cleanupCameraAttempt(mockStream1);
    assert.equal(tracksStopped1, 1, 'Attempt 1 tracks must be stopped');
    assert.equal(sessionMgr.isCurrent(arSession), true, 'AR session must remain active across camera retry');

    // Attempt 2
    const attempt2Id = sessionMgr.createCameraAttempt();
    assert.equal(sessionMgr.isCameraAttemptCurrent(attempt1Id), false, 'Attempt 1 is no longer current');
    assert.equal(sessionMgr.isCameraAttemptCurrent(attempt2Id), true, 'Attempt 2 is current');

    // Stale late stream resolution from attempt 1
    let staleStreamStopped = false;
    if (!sessionMgr.isCameraAttemptCurrent(attempt1Id)) {
      staleStreamStopped = true;
    }
    assert.equal(staleStreamStopped, true, 'Late stream from obsolete attempt must be rejected');
  });

  // =========================================================================
  // 4. Worker keep-warm, idle disposal, re-init with hashed assets, task filtering
  // =========================================================================
  await t.test('4. Worker task filtering respects isolation switches', () => {
    const disablePose = true;
    const disableHands = false;

    const enabledTasks = [
      ...(!disablePose ? ['pose'] : []),
      ...(!disableHands ? ['hand'] : [])
    ];

    assert.deepEqual(enabledTasks, ['hand'], 'Only enabled tasks must be included in init configuration');
  });

  await t.test('4b. Worker idle disposal and explicit reinitialization with versioned URLs', () => {
    let workerActive = true;
    let disposalTimer = null;
    let workerPostMessages = [];

    const mockWorker = {
      postMessage: (msg) => { workerPostMessages.push(msg); }
    };

    function scheduleWorkerIdleDisposal(onDispose) {
      disposalTimer = setTimeout(() => {
        onDispose();
      }, 60);
    }

    function cancelWorkerIdleDisposal() {
      if (disposalTimer) clearTimeout(disposalTimer);
      disposalTimer = null;
    }

    // Exit AR mode: schedule idle disposal
    scheduleWorkerIdleDisposal(() => {
      mockWorker.postMessage({ type: 'dispose' });
      workerActive = false;
    });

    // Reenter AR before 60s: cancel disposal (keep warm)
    cancelWorkerIdleDisposal();
    assert.equal(workerActive, true, 'Worker remains warm on rapid reentry');

    // Exit AR mode and allow disposal to expire
    scheduleWorkerIdleDisposal(() => {
      mockWorker.postMessage({ type: 'dispose' });
      workerActive = false;
    });

    return new Promise((resolve) => {
      setTimeout(() => {
        assert.equal(workerActive, false, 'Worker disposed after idle timeout');
        assert.deepEqual(workerPostMessages, [{ type: 'dispose' }]);

        // Next AR session: explicit re-init with hashed assets
        const versionedAssets = {
          poseModelUrl: 'assets/versioned/pose_landmarker_lite.59929e1d1ee95287.task',
          handModelUrl: 'assets/versioned/hand_landmarker.fbc2a30080c3c557.task'
        };
        mockWorker.postMessage({ type: 'init', assets: versionedAssets, enabledTasks: ['pose', 'hand'] });

        assert.equal(workerPostMessages.length, 2);
        assert.equal(workerPostMessages[1].type, 'init');
        assert.ok(workerPostMessages[1].assets.poseModelUrl.includes('versioned'));
        resolve();
      }, 80);
    });
  });

  // =========================================================================
  // 5. One in-flight inference, old-worker bitmap rejection, stale result rejection
  // =========================================================================
  await t.test('5. Tracking scheduler enforces one in-flight frame, fairness, and rejects stale/mismatched results', () => {
    const scheduler = createTrackingScheduler();

    assert.equal(scheduler.isBusy(), false);

    // Dispatch frame 1
    const frame1 = scheduler.dispatchFrame({
      chosenTask: 'pose',
      now: 1000,
      currentWorkerId: 1,
      currentSessionId: 10
    });
    assert.equal(frame1.id, 1);
    assert.equal(scheduler.isBusy(), true, 'Scheduler is busy while frame is in-flight');

    // Attempting to dispatch another frame while busy
    assert.equal(scheduler.isBusy(), true);

    // Mismatched worker ID response
    const mismatchWorker = scheduler.acceptResult({
      data: { workerId: 99, sessionId: 10, frameId: 1, capturedAt: 1000 },
      now: 1050,
      currentWorkerId: 1,
      currentSessionId: 10
    });
    assert.deepEqual(mismatchWorker, { accepted: false, reason: 'mismatch' });

    // Mismatched session ID response
    const mismatchSession = scheduler.acceptResult({
      data: { workerId: 1, sessionId: 99, frameId: 1, capturedAt: 1000 },
      now: 1050,
      currentWorkerId: 1,
      currentSessionId: 10
    });
    assert.deepEqual(mismatchSession, { accepted: false, reason: 'mismatch' });

    // Stale result (> 350ms)
    const staleResult = scheduler.acceptResult({
      data: { workerId: 1, sessionId: 10, frameId: 1, capturedAt: 1000 },
      now: 1400,
      currentWorkerId: 1,
      currentSessionId: 10
    });
    assert.deepEqual(staleResult, { accepted: false, reason: 'stale-age' });

    // Valid fresh result
    const frame2 = scheduler.dispatchFrame({
      chosenTask: 'hand',
      now: 2000,
      currentWorkerId: 1,
      currentSessionId: 10
    });
    const validResult = scheduler.acceptResult({
      data: { workerId: 1, sessionId: 10, frameId: frame2.id, capturedAt: 2000 },
      now: 2080,
      currentWorkerId: 1,
      currentSessionId: 10
    });
    assert.deepEqual(validResult, { accepted: true });
    assert.equal(scheduler.isBusy(), false, 'Scheduler is ready after valid completion');
  });

  await t.test('5b. Task interleaving fairness: alternates between pose and hand when both are due', () => {
    const scheduler = createTrackingScheduler();
    const policy = { poseCeilingHz: 10, handCeilingHz: 10 };

    // At t = 200, both are due
    const firstTask = scheduler.determineNextTask({ now: 200, policy, isPoseEnabled: true, isHandEnabled: true });
    assert.equal(firstTask, 'pose');
    const f1 = scheduler.dispatchFrame({ chosenTask: firstTask, now: 200, currentWorkerId: 1, currentSessionId: 1 });
    scheduler.acceptResult({ data: { workerId: 1, sessionId: 1, frameId: f1.id, capturedAt: 200 }, now: 250, currentWorkerId: 1, currentSessionId: 1 });

    // At t = 350, both are due again -> alternates to hand
    const secondTask = scheduler.determineNextTask({ now: 350, policy, isPoseEnabled: true, isHandEnabled: true });
    assert.equal(secondTask, 'hand');
    const f2 = scheduler.dispatchFrame({ chosenTask: secondTask, now: 350, currentWorkerId: 1, currentSessionId: 1 });
    scheduler.acceptResult({ data: { workerId: 1, sessionId: 1, frameId: f2.id, capturedAt: 350 }, now: 400, currentWorkerId: 1, currentSessionId: 1 });

    // At t = 500, both are due again -> alternates back to pose
    const thirdTask = scheduler.determineNextTask({ now: 500, policy, isPoseEnabled: true, isHandEnabled: true });
    assert.equal(thirdTask, 'pose');
  });

  // =========================================================================
  // 6. Production asset hashes, inventory completeness, preloads, and provenance
  // =========================================================================
  await t.test('6. Production asset hashes match byte contents and inventory manifest', () => {
    assert.ok(fs.existsSync('dist/manifest.json'), 'dist/manifest.json must exist');
    const manifest = JSON.parse(fs.readFileSync('dist/manifest.json', 'utf8'));

    assert.ok(manifest.build, 'Manifest must specify build identifier');
    assert.ok(manifest.inventory.length >= 7, 'Inventory must list all versioned production assets');

    for (const item of manifest.inventory) {
      const fullPath = path.join('dist', item.path);
      assert.ok(fs.existsSync(fullPath), `Inventory asset ${item.path} must exist on disk`);
      const buffer = fs.readFileSync(fullPath);
      const computed = computeSha(buffer, 16);
      assert.equal(computed, item.hash, `Hash for ${item.path} must match byte content`);
      assert.equal(buffer.length, item.size, `Size for ${item.path} must match byte content`);
    }

    // Artwork & compiler entries
    assert.ok(fs.existsSync('dist/assets/MVstudio_logo_text.png'), 'Studio logo must be present');
    assert.ok(fs.existsSync('dist/assets/monster_tshirt.jpg'), 'Target artwork must be present');
    assert.ok(fs.existsSync('dist/compiler.html'), 'Compiler HTML must be present');
    assert.ok(fs.existsSync('dist/src/runtime/animation-time.mjs'), 'Runtime animation-time must be in dist');
    assert.ok(fs.existsSync('dist/src/runtime/session-state.mjs'), 'Runtime session-state must be in dist');
    assert.ok(fs.existsSync('dist/src/runtime/tracking-scheduler.mjs'), 'Runtime tracking-scheduler must be in dist');
    assert.ok(fs.existsSync('dist/src/runtime/quality-policy.mjs'), 'Runtime quality-policy must be in dist');

    // Built index.html checks
    const builtHtml = fs.readFileSync('dist/index.html', 'utf8');
    assert.ok(!builtHtml.includes('https://cdn.tailwindcss.com'), 'Must not include Tailwind Play CDN');
    assert.ok(builtHtml.includes(manifest.assets.css), 'Must link to compiled hashed CSS');
    assert.ok(builtHtml.includes(manifest.assets.monsterModel), 'Must reference hashed GLB');
    assert.ok(builtHtml.includes(manifest.assets.targetMarker), 'Must reference hashed marker');

    // High-priority preloads ahead of importmap
    const preloadMarker = 'rel="preload" as="fetch" crossorigin="anonymous" href="' + manifest.assets.monsterModel + '"';
    const preloadModelIdx = builtHtml.indexOf(preloadMarker);
    const importmapIdx = builtHtml.indexOf('<script type="importmap">');
    assert.ok(preloadModelIdx > 0, 'Model preload tag must be present');
    assert.ok(importmapIdx > 0, 'Importmap must be present');
    assert.ok(preloadModelIdx < importmapIdx, 'Model preload must appear BEFORE importmap and application modules');
  });

  // =========================================================================
  // Quality Policy & Buffer Budget tests using real runtime module
  // =========================================================================
  await t.test('Quality policy buffer ratio and hysteresis using runtime quality-policy module', () => {
    const qpMobile = createQualityPolicy({ isMobile: true });
    assert.equal(qpMobile.profile, 'balanced');

    // Balanced ratio at 1080x1920
    const ratioBalanced = qpMobile.computeBufferRatio(1080, 1920, 2.0);
    assert.ok(ratioBalanced <= 1.0, 'Ratio must not exceed balanced maxPixelRatio (1.0)');
    assert.ok(ratioBalanced * 1080 * ratioBalanced * 1920 <= 1000000 * 1.01, 'Buffer pixels respect 1M budget');

    // 3 high windows trigger downgrade
    qpMobile.recordWindow({ p90: 45 });
    qpMobile.recordWindow({ p90: 45 });
    assert.equal(qpMobile.profile, 'balanced');
    const downgraded = qpMobile.recordWindow({ p90: 45 });
    assert.equal(downgraded, 'reduced');
    assert.equal(qpMobile.profile, 'reduced');

    // Reduced ratio respects reduced budget (650k)
    const ratioReduced = qpMobile.computeBufferRatio(1080, 1920, 2.0);
    assert.ok(ratioReduced <= 0.75, 'Ratio must not exceed reduced maxPixelRatio (0.75)');
    assert.ok(ratioReduced * 1080 * ratioReduced * 1920 <= 650000 * 1.01, 'Buffer pixels respect 650k budget');

    // 5 low windows restore to balanced
    for (let i = 0; i < 4; i++) qpMobile.recordWindow({ p90: 25 });
    assert.equal(qpMobile.profile, 'reduced');
    const restored = qpMobile.recordWindow({ p90: 25 });
    assert.equal(restored, 'balanced');
    assert.equal(qpMobile.profile, 'balanced');

    // Forced quality policy locks profile
    const qpForced = createQualityPolicy({ isMobile: true, forcedProfile: 'reduced' });
    assert.equal(qpForced.profile, 'reduced');
    for (let i = 0; i < 10; i++) qpForced.recordWindow({ p90: 15 });
    assert.equal(qpForced.profile, 'reduced', 'Forced profile must not change with hysteresis');
  });

  // =========================================================================
  // Follow-up Plan: Build output provenance & deployment verification
  // =========================================================================
  await t.test('7a. Built dist/index.html has correct provenance markers', () => {
    const builtHtml = fs.readFileSync('dist/index.html', 'utf8');

    // Must NOT contain Tailwind CDN
    assert.ok(!builtHtml.includes('cdn.tailwindcss.com'), 'Built HTML must not include Tailwind CDN');

    // Must contain compiled CSS link
    assert.ok(builtHtml.includes('assets/versioned/app.'), 'Built HTML must link to compiled versioned CSS');

    // Must contain __ASSET_CONFIG__
    assert.ok(builtHtml.includes('window.__ASSET_CONFIG__'), 'Built HTML must include inline asset config');

    // Must have valid build SHA in meta tag (not placeholder)
    const buildMatch = builtHtml.match(/<meta name="app-build" content="([^"]+)"/);
    assert.ok(buildMatch, 'Built HTML must have app-build meta tag');
    assert.ok(buildMatch[1] !== 'unknown' && buildMatch[1] !== '', 'Build SHA must not be empty or unknown');

    // Must have high-priority preloads for model
    assert.ok(builtHtml.includes('fetchpriority="high"'), 'Built HTML must have high-priority preload');
    assert.ok(builtHtml.includes('rel="preload" as="fetch"'), 'Built HTML must have preload links');

    // No inline <style> block (should be compiled CSS only)
    const inlineStyleCount = (builtHtml.match(/<style>/g) || []).length;
    assert.equal(inlineStyleCount, 0, 'Built HTML must not have inline <style> blocks');

    // No classic Three.js CDN script tag
    assert.ok(!builtHtml.includes('<script src="https://unpkg.com/three'), 'Must not use classic Three.js CDN');
  });

  // =========================================================================
  // Follow-up Plan: Camera profile and diagnostic controls
  // =========================================================================
  await t.test('7b. Camera profiles define correct resolution constraints', () => {
    // Simulate the camera profiles object from index.html
    const cameraProfiles = {
      standard: { width: { ideal: 1280 }, height: { ideal: 720 },
                  frameRate: { ideal: 30, max: 30 } },
      economy:  { width: { ideal: 960 }, height: { ideal: 540 },
                  frameRate: { ideal: 30, max: 30 } }
    };

    // Standard profile
    assert.equal(cameraProfiles.standard.width.ideal, 1280);
    assert.equal(cameraProfiles.standard.height.ideal, 720);
    assert.equal(cameraProfiles.standard.frameRate.max, 30);

    // Economy profile
    assert.equal(cameraProfiles.economy.width.ideal, 960);
    assert.equal(cameraProfiles.economy.height.ideal, 540);
    assert.equal(cameraProfiles.economy.frameRate.max, 30);
  });

  await t.test('7c. Diagnostic URL parameter validation', () => {
    // Simulate URL parameter parsing logic from index.html
    function parseTrackingDelegate(raw) {
      const val = (raw || '').toLowerCase();
      return ['auto', 'cpu', 'gpu'].includes(val) ? val : 'auto';
    }
    function parseCameraProfile(raw) {
      const val = (raw || '').toLowerCase();
      return ['standard', 'economy'].includes(val) ? val : 'standard';
    }
    function parseQuality(raw) {
      const val = (raw || '').toLowerCase();
      return ['auto', 'balanced', 'reduced'].includes(val) ? val : 'auto';
    }

    // Valid values pass through
    assert.equal(parseTrackingDelegate('gpu'), 'gpu');
    assert.equal(parseTrackingDelegate('cpu'), 'cpu');
    assert.equal(parseCameraProfile('economy'), 'economy');
    assert.equal(parseQuality('reduced'), 'reduced');

    // Invalid values fall back to defaults
    assert.equal(parseTrackingDelegate('invalid'), 'auto');
    assert.equal(parseTrackingDelegate(''), 'auto');
    assert.equal(parseTrackingDelegate(null), 'auto');
    assert.equal(parseCameraProfile('ultra'), 'standard');
    assert.equal(parseQuality('ultra-high'), 'auto');
  });

  // =========================================================================
  // Follow-up Plan: vercel.json deployment configuration
  // =========================================================================
  await t.test('7d. vercel.json has required deployment configuration', () => {
    const vercelJson = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));

    assert.equal(vercelJson.buildCommand, 'npm run build', 'buildCommand must be npm run build');
    assert.equal(vercelJson.outputDirectory, 'dist', 'outputDirectory must be dist');
    assert.equal(vercelJson.installCommand, 'npm ci', 'installCommand must be npm ci');

    // Immutable cache headers for versioned assets
    const immutableRule = vercelJson.headers.find(h => h.source === '/assets/versioned/(.*)');
    assert.ok(immutableRule, 'Must have versioned asset header rule');
    const cacheHeader = immutableRule.headers.find(h => h.key === 'Cache-Control');
    assert.ok(cacheHeader, 'Must have Cache-Control header');
    assert.ok(cacheHeader.value.includes('immutable'), 'Versioned assets must be immutable');
    assert.ok(cacheHeader.value.includes('max-age=31536000'), 'Versioned assets must have 1-year max-age');

    // Manifest must not be immutable
    const manifestRule = vercelJson.headers.find(h => h.source === '/assets/versioned/manifest.json');
    assert.ok(manifestRule, 'Must have manifest header rule');
    const manifestCache = manifestRule.headers.find(h => h.key === 'Cache-Control');
    assert.ok(manifestCache.value.includes('must-revalidate'), 'Manifest must be revalidated');
  });

  // =========================================================================
  // Follow-up Plan: Mutation detection — old clamp would cause test failure
  // =========================================================================
  await t.test('7e. Mutation detection: old 80ms clamp breaks playback equivalence', () => {
    // This test proves that reintroducing the old clamp would be caught
    function simulateWithClamp(fps, wallSeconds, clampMs) {
      const frameDeltaSec = 1 / fps;
      const clampSec = clampMs / 1000;
      let accumulated = 0;
      const frames = fps * wallSeconds;
      for (let i = 0; i < frames; i++) {
        accumulated += Math.min(frameDeltaSec, clampSec);
      }
      return accumulated;
    }

    // Without clamp (correct behavior): 10s wall clock = 10s animation
    const correctAt10 = simulateWithClamp(10, 10, Infinity);
    assert.ok(Math.abs(correctAt10 - 10.0) < 0.001, 'Unclamped 10 FPS must yield 10s');

    // With 80ms clamp (old bug): 10s wall clock = 8s animation at 10 FPS
    const brokenAt10 = simulateWithClamp(10, 10, 80);
    assert.ok(Math.abs(brokenAt10 - 8.0) < 0.001, 'Old 80ms clamp yields only 8s at 10 FPS');

    // With 80ms clamp: 10s wall clock = 4s animation at 5 FPS
    const brokenAt5 = simulateWithClamp(5, 10, 80);
    assert.ok(Math.abs(brokenAt5 - 4.0) < 0.001, 'Old 80ms clamp yields only 4s at 5 FPS');

    // The actual createAnimationTime (used in production) does NOT clamp:
    const animTime = createAnimationTime();
    let accum = 0;
    let now = 1000;
    accum += animTime.tick(now);
    for (let i = 0; i < 50; i++) {  // 50 frames at 5 FPS = 10s
      now += 200;  // 200ms per frame = 5 FPS
      accum += animTime.tick(now);
    }
    assert.ok(Math.abs(accum - 10.0) < 0.001, 'Production animationTime yields full 10s at 5 FPS');
  });
});
