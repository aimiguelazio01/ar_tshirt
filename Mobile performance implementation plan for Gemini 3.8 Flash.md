# Mobile performance implementation plan for Gemini 3.8 Flash

## 1. Objective and inspection findings

Improve **startup time and AR smoothness on Android Chrome and iPhone Safari**. Preserve the character, animations, arm gestures, two-hand interaction, and touch controls. Allow adaptive rendering resolution and simpler decorative effects.

**The first problem is deployment: the live website does not match the current repository.**

Inspection of [the live app](https://mvartshirt.vercel.app/) and the local checkout found:

| Area | Live website | Local repository |
|---|---|---|
| Character loading | Original GLB; separate loader paths | Shared loading; compressed GLB |
| Character asset size locally | Original: 3.42 MB | Compressed: 1.72 MB |
| Gesture inference | Main-thread `detectForVideo()` | Worker exists, but needs corrections |
| Optional loading | Tracking and effects initialized during startup | Deferred initialization exists |
| Diagnostic traffic | Sends `/log?...` requests | Local diagnostics |
| Optimized deployment files | Worker, manifest, compressed model return **404** | Files exist |
| Asset caching | Checked assets revalidate | Immutable rule exists, but includes mutable filenames |

Additional local findings:

- Worker detection uses `IMAGE` mode for camera frames.
- Worker-reported initialization errors are ignored; asynchronous failures do not initialize the fallback.
- Worker results lack scene identifiers and freshness rejection.
- First-character and optional-feature flags are never reset between modes.
- Quality changes do not update existing particle counts; balanced mobile starts with 220 particles.
- Reduced quality disables effects entirely.
- Effects use independent timers that cleanup does not consistently cancel.
- Tailwind compiles styles in the browser.
- Existing verification scripts pass, but primarily check strings and file existence. Their `console.assert()` checks do not reliably fail the process.

These are source and HTTP findings. Physical-phone FPS, thermal behavior, and startup improvements remain unmeasured.

## 2. Ordered implementation procedure

### Step 1 — Establish deployment identity and trustworthy measurements

**Procedure**

1. Record the current production deployment and retain its rollback reference.
2. In Vercel, inspect the project owning `mvartshirt.vercel.app`: connected GitHub repository, production branch, root directory, deployment commit, and domain assignment.
3. Confirm the repository is `aimiguelazio01/ar_tshirt`. Use `main` as the production branch unless the existing project intentionally specifies another branch.
4. Compare the deployed commit with the checkout. Local `main` currently points to `3700930` and is ahead of its locally recorded `origin/main` by one commit; fetch before concluding what GitHub currently contains.
5. Create `codex/mobile-performance` from the inspected checkout. Preserve the three existing uncommitted character-texture changes; exclude them from this performance patch.
6. Create a Vercel preview from the implementation branch. Do not promote the unfinished local optimizations directly to production.

**Code changes**

Add a build identifier to generated HTML and expose it in diagnostics:

```html
<meta name="app-build" content="GENERATED_COMMIT_SHA">
```

Extend `PerformanceDiagnostics` to record:

- Model download and parse durations.
- Camera request and first decoded video frame.
- Mode entry, first marker detection, and first rendered character.
- Median, p90, and p95 frame intervals.
- Actual inference rates, inference duration, and result age.
- Drawing-buffer dimensions, renderer resources, and registered active loops/workers.

Count actual loop registrations rather than inferring them from mode flags. Reset frame windows after mode changes and backgrounding. Keep sampling bounded; enable detailed diagnostics only with `?debugPerformance=1`.

Mark the first character after rendering, with the welcome overlay fully dismissed. Use separate per-session marks. Report permission waiting and marker-aiming time separately from loading.

**Checkpoint**

Capture production and preview baselines separately: five cold starts, five warm starts, and a 60-second AR session per test phone. Preserve existing `noPose`, `noHands`, and `noVfx` isolation switches.

### Step 2 — Make scene lifecycle and asynchronous work reliable

Update `cleanARContainer()`, mode entry, camera switching, and optional initialization in [index.html](C:/Users/b550xe/Desktop/monster_ar_tshirt/index.html).

**Code changes**

Replace page-global visibility/initialization flags with session state:

```js
let nextSessionId = 0;
let activeSession = null;

function createSession(mode) {
  return {
    id: ++nextSessionId,
    mode,
    startedAt: performance.now(),
    firstCharacterVisible: false,
    abort: new AbortController(),
    cleanups: new Set()
  };
}

function isCurrent(session) {
  return activeSession === session && !session.abort.signal.aborted;
}
```

Every asynchronous callback captures its session. After each `await`, verify that session before attaching a model, starting a camera, updating UI, or triggering an effect.

On departure:

1. Invalidate the session and stop frame submission.
2. Cancel render callbacks, video callbacks, idle jobs, animation timers, and effect timers.
3. Stop MindAR processing before clearing the video stream.
4. Stop camera tracks and clear gesture holds and reticles.
5. Dispose scene-owned geometry, materials, canvas textures, mixers, and simulator renderer resources.
6. Preserve cached character geometry/textures and shared effect textures.

Retain one MindAR renderer/wrapper to avoid accumulating its internally registered resize listener. Manage its controller separately: before a restart replaces the controller, stop/dispose the outgoing controller and terminate its outgoing worker. Verify resource counts plateau across restarts.

On backgrounding, stop both application rendering and MindAR video processing. Resume exactly once with fresh timing; restart the camera through the same guarded path if its tracks ended.

Keep shared asset promises separate from per-session activation. Preview-first entry must not prevent AR gestures from initializing later.

**Checkpoint**

Ten preview/AR transitions and ten camera switches produce no stale attachments, accumulating workers, duplicate loops, or actions fired after leaving a scene.

### Step 3 — Repair and optimize the tracking worker

Modify [tracking_worker.js](C:/Users/b550xe/Desktop/monster_ar_tshirt/tracking_worker.js) and its main-thread scheduler.

**Worker changes**

Keep MediaPipe `0.10.14`. Initialize enabled tasks sequentially to reduce simultaneous initialization pressure. Try GPU, then CPU inside the worker, closing partially initialized resources on failure.

Change both tasks to video mode:

```js
// Apply to both PoseLandmarker and HandLandmarker options:
runningMode: 'VIDEO'

// Each selected task processes the transferred camera frame:
const result = landmarker.detectForVideo(bitmap, timestampMs);
```

Use strictly increasing timestamps generated on the main thread. Keep one pose and two hands.

Video mode allows hand tracking to avoid repeating palm detection when tracking remains valid. Both detection APIs are synchronous, so inference should remain in the worker. [MediaPipe documentation](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/web_js)

**Internal message contract**

```js
// Main → worker
{ type: 'init', workerId, assets, enabledTasks }
{ type: 'frame', workerId, sessionId, frameId,
  task, capturedAt, timestampMs, bitmap }
{ type: 'dispose', workerId }

// Worker → main
{ type: 'ready', workerId }
{ type: 'result', workerId, sessionId, frameId,
  task, capturedAt, durationMs, landmarks, handednesses }
{ type: 'error', workerId, stage, message }
```

Use `requestVideoFrameCallback()` to schedule fresh frames. Where unavailable, check `video.currentTime` from a separate scheduler. Remove tracking dispatch from `renderLoop()`.

Maintain **one capture/inference operation in flight**, including asynchronous bitmap creation. Alternate eligible tasks; drop intermediate frames.

Before accepting results:

```js
const matches =
  data.workerId === currentWorkerId &&
  data.sessionId === activeSession?.id &&
  data.frameId === pendingFrame?.id;

if (!matches) return;

pendingFrame = null;

if (document.hidden ||
    activeSession.mode !== 'ar' ||
    performance.now() - data.capturedAt > 350) {
  clearPendingGestures();
  return;
}
```

Also clear gesture state when no fresh result arrives for 350 ms. A stale response must never clear a newer request’s busy state.

Handle synchronous and asynchronous bitmap failures. Try video capture, then a resized canvas capture; if bitmap transfer is unavailable, activate the main-thread fallback. Close bitmaps on every abandoned or failed-transfer path.

Route constructor errors, worker `error` messages, `onerror`, `onmessageerror`, a 30-second initialization timeout, and a 2-second inference timeout through one deduplicated fallback initializer. Terminate the failed worker first.

Fallback: run at most one inference every 100 ms, alternating tasks, with a 5 Hz ceiling per task. Schedule outside rendering. If a task cannot initialize, retain touch interaction and show its unavailable state.

Preserve coordinate mapping and mirroring. Require two fresh agreeing samples spanning at least 70 ms for arm transitions. Preserve the two-second hand hold and reset it on tracking loss.

**Checkpoint**

Normal operation has no main-thread MediaPipe inference, no queued frame backlog, and working gestures after every worker failure scenario.

### Step 4 — Apply a complete rendering budget

Keep the existing adaptive policy, but make every setting affect the active scene.

| Setting | Balanced mobile | Reduced mobile |
|---|---:|---:|
| Maximum pixel ratio | 1.0 | 0.75 |
| Maximum buffer pixels | 1,000,000 | 650,000 |
| Ambient particles | 80 | 30 |
| Sparks per effect | 12 | 6 |
| Temporary effect lights | On | Off |
| Pose ceiling | 10 Hz | 6 Hz |
| Hand ceiling | 15 Hz | 10 Hz |
| Tracking-frame longest edge | 640 px | 480 px |

Use the AR container’s dimensions, not the window:

```js
function applyBufferBudget(renderer, container, policy) {
  const width = container.clientWidth;
  const height = container.clientHeight;
  if (!width || !height) return;

  const ratio = Math.min(
    window.devicePixelRatio || 1,
    policy.maxPixelRatio,
    Math.sqrt(policy.maxBufferPixels / (width * height))
  );

  renderer.setPixelRatio(ratio);
  renderer.setSize(width, height, false);
}
```

Let MindAR calculate its AR camera projection and video crop. Apply the buffer budget after its resize operation without overriding that projection. Update preview-camera aspect separately. The pinned library owns these resize calculations. [MindAR 1.2.5 source](https://raw.githubusercontent.com/hiukim/mind-ar-js/v1.2.5/src/image-target/three.js)

Additional changes:

- Allocate particle capacity once; change `geometry.setDrawRange()` and update only active particles.
- Preserve a simplified explosion/storm response in reduced mode instead of returning without feedback.
- Update lights when a scene is created and when its quality profile changes.
- Replace effect intervals with `updateEffects(delta)` in the active rendering loop.
- Use elapsed time for particle movement, rotation, fades, and press recovery.
- Cache root bones and active video references outside frame loops.
- In reduced mode, replace large live-camera backdrop blurs with opaque/translucent backgrounds.
- Keep current animation playback timing; increasing `animationSpeed` is not an FPS optimization.

Retain two-second quality windows: downgrade after three p90 windows above 40 ms; restore after five below 30 ms. Reset sampling on transitions and visibility changes.

**Checkpoint**

Rotation preserves marker alignment, hand targeting, and screenshots. Reduced quality preserves every interaction.

### Step 5 — Complete startup scheduling

Build on the shared model and marker promises already present.

1. Move essential Three.js imports into the application module itself; remove dependence on another module populating globals first.
2. Preserve Three.js `0.157.0` and the configured Meshopt decoder.
3. Replace MindAR polling with one memoized import promise. Load compiler support only for the image-compilation path.
4. Start model and marker loading concurrently; preview waits only for its required 3D dependencies.
5. Start optional tracking after the first visible character render and a browser yield.
6. Load effect textures sequentially after tracking initialization settles; preview loads effects without tracking.
7. Make early effect requests await their shared texture promise and verify the session before execution.
8. Make Retry resume the requested operation. The current `showToast()` does not implement the callback passed by `showModelRetryUI()`, so use an actual retry button handler.
9. Remove all production `/log?...` traffic by deploying the corrected implementation.

**Checkpoint**

One successful GLB fetch and parse per page session. No tracking-model or effect downloads before first character visibility. Preview works when MindAR or MediaPipe is unavailable.

### Step 6 — Compile CSS and make asset caching reproducible

Replace the Tailwind Play CDN with build-time CSS using a locked Tailwind 3 release and the existing theme configuration. Scan HTML and application JavaScript; explicitly include dynamically assembled classes. Preserve current styling and CSS precedence.

Tailwind documents its browser CDN as a development tool. [Tailwind documentation](https://v3.tailwindcss.com/docs/installation/play-cdn)

Add a deterministic static build that:

1. Compiles and minifies CSS.
2. Generates content-hashed production assets.
3. Injects asset URLs and the Git commit into the built HTML.
4. Writes a `dist` directory containing the app, worker, required assets, and the existing compiler entry point and dependencies.
5. Produces an asset inventory for automated validation.

Fix asset hashing to use **emitted bytes**, including compressed GLB bytes:

```js
const emittedBytes = await io.writeBinary(doc);
const hash = crypto.createHash('sha256')
  .update(emittedBytes)
  .digest('hex')
  .slice(0, 16);
```

Fingerprint the GLB, marker, gesture models, effect textures, and compiled CSS. Generate their configuration into HTML so startup does not require an extra manifest fetch. Pass tracking-model URLs to the worker during initialization.

Keep manifests, HTML, and unversioned worker code revalidating. Place only genuinely content-hashed files under the directory receiving:

```http
Cache-Control: public, max-age=31536000, immutable
```

Remove mutable aliases from that immutable directory in the build output. Preserve MIME/CORS behavior and verify actual deployed headers. [Vercel caching documentation](https://vercel.com/docs/caching/cache-control-headers)

Configure Vercel to run `npm run build` and publish `dist`. Add scripts for asset verification, behavioral tests, and the build.

**Checkpoint**

A clean `npm ci` followed by tests and build succeeds. Changed asset bytes produce a different URL; warm visits reuse unchanged assets. Every generated URL returns HTTP 200.

## 3. Tests and release procedure

Replace string-based success checks with `node:test` and `node:assert/strict`. Test extracted scheduler and lifecycle helpers using fake clocks, workers, and camera frames.

Required automated scenarios:

- Single shared model load, rejected load followed by retry.
- Preview-first followed by AR optional initialization.
- One in-flight bitmap/inference operation.
- Duplicate video frames skipped.
- Stale session, worker, frame, and aged results rejected.
- Worker failure and timeout activate fallback once.
- Bitmap resources closed after capture/transfer failures.
- Gesture debounce and hold reset after tracking loss.
- Quality hysteresis and buffer-pixel limits.
- Cleanup prevents obsolete callbacks.
- Generated asset URLs, hashes, and deployment inventory are valid.

Use real Android Chrome and iPhone Safari for:

- Cold/warm starts and permission granted/denied.
- Marker loss/recovery, both arms, two-hand holds, touch actions, and effects.
- Preview/AR transitions, camera switching, rotation, and background/resume.
- A five-minute session to expose heat and resource accumulation.
- Character appearance, skinning, morphs, animation timing, and alignment.

**Release gates**

- At least 25% lower median controlled startup time than the current live build.
- At least 30 FPS median and p95 frame interval no greater than 50 ms during a 60-second balanced AR session.
- Normal worker-path gesture response within 300 ms, excluding intentional holds.
- No accumulating loops, workers, or scene resources after repeated transitions.
- No interaction or character-appearance regression.

Treat these as measured targets, not guaranteed outcomes. Record device, browser, connection, build SHA, sample counts, and failures. Missing physical-device results remain pending.

After preview validation, merge through GitHub and confirm that the production domain serves the approved commit, worker, and hashed assets. Repeat mobile smoke tests. Roll back to the retained deployment if release gates regress.

## 4. Gemini execution instructions and defaults

Use **`gemini-3.8-flash`**, with high thinking for worker/lifecycle changes and medium for build/asset wiring. Google documents these supported settings. [Gemini model documentation](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)

Give Gemini this instruction:

> Implement this plan against the inspected repository, one numbered step at a time. Read the relevant functions before editing. Preserve unrelated changes and existing character behavior. Make a small reviewable patch per step and run its checkpoint before continuing. Report changed behavior, commands run, results, and remaining failures. Do not treat string checks, faster animation playback, or desktop emulation as proof of mobile performance. Do not claim deployment success until the production domain serves the expected build and assets.

Defaults: retain GitHub/Vercel hosting, current tracking-library versions, character assets, and camera permission flow. No framework migration, backend service, or Gemini API integration is required.
