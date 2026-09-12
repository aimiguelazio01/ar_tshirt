# Mobile slowdown follow-up plan for Gemini 3.8 Flash

Prepared 2026-09-12. Inspected checkout: `da6cb41ce0c75d51820a116fa514160a0fcb0814`.
Production: https://mvartshirt.vercel.app/

This replaces the earlier performance plan as the implementation handoff. Several earlier recommendations are now implemented locally, but production still serves older code. Implement the remaining fixes below; do not repeat already completed work.

## 1. Goal, evidence, and limits

Make the actual character appear sooner and keep animation at its intended real-time speed with smoother rendering on Android Chrome and iPhone Safari. Preserve the character, rig, facial morphs, gestures, touch controls, and existing animation sequences. Adaptive resolution and simpler decorative effects remain acceptable.

### Fresh inspection results

| Priority | Confirmed finding | Consequence |
|---|---|---|
| P0 | Production HTML is 238,083 bytes, contains the Tailwind CDN and classic Three.js script, and references the original GLB. It has no worker initialization, compiled CSS marker, or injected asset map. `/manifest.json` and `/tracking_worker.js` return 404. | The recent local optimizations are not reaching the live domain. Fix deployment provenance before comparing releases. |
| P0 | Both local rendering loops use `Math.min(rawDelta || 0.016, 0.08)` before `mixer.update(delta)`. | At 10 FPS, ten wall-clock seconds advance the mixer by eight seconds before timeScale. At 5 FPS they advance it by four. This creates actual slow motion in addition to choppy frames. This finding concerns local code, not the older production HTML. |
| P0 | Reaction/arm completion uses `action.timeScale || mixer.timeScale`, plus wall-clock timers. | The action's default scale of 1 masks the mixer scale. Timers and animation can disagree, especially during dropped frames, speed changes, and backgrounding. |
| P0 | `startSimulatorMode()` sets `isSimulatorMode = true`; AR entry never restores it to false. | Returning to AR can leave the rendering loop returning immediately. |
| P0 | Cleanup sends `dispose` to the gesture worker but retains the worker and its main-thread ready flag. The worker auto-initializes on a later frame without the original asset configuration. | Subsequent sessions can use inconsistent readiness, reload the models, and fall back to unversioned URLs. |
| P1 | Essential model fetch begins inside the application module, after its static dependency graph has loaded and evaluated. | The 1.72 MB optimized model download cannot overlap that initial library-loading period. |
| P1 | `scheduleOptionalFeatures()` calls a void `initTrackingWorker()` and schedules effects without awaiting worker readiness. Worker initialization always enables both tasks. | Heavy optional model initialization and texture work can overlap; isolation switches still download/initialize disabled tasks. |
| P1 | Camera requests prefer 1280 x 720. MindAR processing is separate from the gesture worker. The visibility handler stops rendering but never calls MindAR's processing lifecycle. | Moving gestures to a worker does not eliminate marker-tracking cost or hidden-tab work. Relative device impact still needs measurement. |
| P1 | Existing `dist` is build `9931595`. Required artwork, studio logo, and compiler page are absent. Build code writes `src/input.css` and the source asset manifest. | A green build inventory is incomplete, and building can modify source state. |
| P1 | Seventeen Node tests pass, but behavioral tests implement their own helper functions instead of importing the application's helpers. | They do not prove the actual mode transitions, timing, worker lifecycle, or scheduler work. |

Already implemented locally: shared GLB loading and Meshopt decoding; video-mode gesture inference in a worker; session identifiers; bitmap backpressure; adaptive pixel budgets; 80/30 ambient particles; effect updates in the render clock; production CSS compilation and emitted-byte hashes. Retain these and repair their integration.

Asset inspection: source GLB 3,416,360 bytes; optimized GLB 1,721,096 bytes; 10,467 triangles, 100 skin joints, five morph targets, and one animation containing 268 channels. Embedded JPEGs total approximately 483 KB. Pose/hand models plus the two effect textures total 17,852,129 bytes. This does not establish the GPU bottleneck, and does not justify reducing character quality by default. Meshopt transfer compression also does not inherently reduce decoded animation or skinning work.

Verification performed for this plan: current source inspection; production HTML/route HTTP checks; existing Node tests (17 passed); GLB metadata inspection; numerical reproduction of the elapsed-time clamp. No physical-phone FPS, timeline trace, or thermal measurement was performed. Do not label these future acceptance tests as passed.

## 2. Ordered implementation steps

### Step 1 — Establish a reproducible candidate and working deployment

1. Preserve the existing uncommitted changes to `assets/3d/monster/color.jpg`, `normal.jpg`, and `roughness.jpg`. Do not regenerate the character from them as part of this task.
2. Create an implementation branch `codex/mobile-performance-followup`. Record the original production deployment for rollback.
3. Inspect the Vercel project owning the domain: GitHub repository, production branch, root directory, build command, output directory, domain alias, and deployed SHA. Expected repository is `aimiguelazio01/ar_tshirt`; use the configured intended production branch, normally `main`. Determine the actual mismatch instead of assuming an unpushed commit is the only cause.
4. Set the project build command to `npm run build` and output directory to `dist`; make the build command explicit in root `vercel.json`. Preserve existing required headers.
5. Fix `scripts/build.mjs` before using it for baseline comparisons: generate all temporary CSS under a checked workspace build directory; write production artifacts only into `dist`; remove writes to tracked `src/input.css`, source `assets/versioned`, and its manifest. Resolve/check the absolute `dist` deletion target against the repository root before deleting it.
6. Replace the fabricated fallback SHA with the actual Git/Vercel SHA. If neither exists, use an explicit `unknown-local` value for local development and fail production provenance verification.
7. Add the referenced artwork, studio logo, compiler entry point, and its transitive assets to the build inventory. Verify runtime HTML/CSS/JS asset references, not only the seven manually listed binaries. Keep original source assets outside the deployment unless a current runtime or fallback path needs them. Reducing deployment-directory size alone is not a mobile-download improvement.
8. Create a Vercel preview from this branch. Confirm the preview serves its recorded build SHA, compiled CSS, worker, injected asset map, and all referenced assets with HTTP 200. Verify immutable headers on hashed assets and revalidation on HTML/manifests/worker.

Use this command order after build-source writes are removed:

```text
npm ci
npm run build
npm test
npm run verify
git diff --exit-code -- index.html tracking_worker.js src/input.css assets/versioned/manifest.json
```

Capture the original production and repaired local candidate separately. Do not treat the existing `dist` as a fresh build. Do not promote unfinished local code merely to correct the domain mismatch.

**Checkpoint:** preview provenance and assets verified; reproducible build leaves tracked application files unchanged. Record a baseline before performance edits.

### Step 2 — Fix real animation time and animation completion

Extract a small production helper into `src/runtime/animation-time.mjs`; import it from the app and from Node tests. Copy runtime modules into `dist` during the build.

Use a separate elapsed-time clock per active session. Reset it on explicit pause, resume, mode changes, and renderer creation. Do not discard visible frame time just because FPS falls below 12.5.

```js
export function createAnimationTime() {
  let previous = null;
  return {
    reset() { previous = null; },
    tick(nowMs) {
      if (previous === null) {
        previous = nowMs;
        return 0;
      }
      const seconds = Math.max(0, (nowMs - previous) / 1000);
      previous = nowMs;
      return seconds;
    }
  };
}

// In both active rendering loops:
const elapsed = session.animationTime.tick(performance.now());
activeMixer?.update(elapsed); // timeScale is applied by the mixer
const decorativeDelta = Math.min(elapsed, 0.05);
updateDecorations(decorativeDelta);
```

Integrate this with the existing AR/preview render functions; do not add a second render loop. Finite effects must expire using accumulated active elapsed time, even if decorative movement is capped. On a long visible stall, animation catches up rather than slowly replaying the missed time. On a hidden interval, reset the clock so hidden time does not advance playback. Do not simulate missing frames with hundreds of fixed substeps.

Replace the reaction and arm-down completion `setTimeout` blocks with filtered mixer `finished` listeners. Keep the reaction's two repetitions and existing arm clips. Completion should update idle/UI/effects once, only for the intended action and current session:

```js
function onActionFinished(mixer, action, session, complete) {
  const handler = event => {
    if (event.action !== action) return;
    remove();
    if (isCurrent(session)) complete();
  };
  function remove() {
    mixer.removeEventListener('finished', handler);
    session.cleanups.delete(remove);
  }
  mixer.addEventListener('finished', handler);
  session.cleanups.add(remove);
  return remove; // also call when this action is cancelled/replaced
}
```

Register completion before playing an action. Ensure repeated triggers remove the previous listener. Preserve crossfades and intentional gesture hold durations. If an estimated duration is needed only for display, use `clipDuration * repetitions / abs(mixer.timeScale * action.getEffectiveTimeScale())`; handle paused/zero-speed playback explicitly. Do not use that estimate as the transition authority.

Keep the current user-selected/default playback speed for this patch. Increasing 1.35 further will not improve FPS or fix time discarded by the clamp.

**Checkpoint:** at simulated 60, 30, 15, 10, and 5 FPS, ten active seconds advance the mixer by ten seconds times its scale within numeric tolerance. A hidden 30-second interval adds zero animation time. Clip completion, speed changes, cancellation, and both effects stay synchronized.

### Step 3 — Repair session, camera, and worker ownership

Make `activeSession.mode` authoritative. During the incremental migration, assign the legacy flag inside `createSession(mode)` so every entry path agrees:

```js
activeSession = session;
isSimulatorMode = mode === 'simulator';
modeEntryMark = session.startedAt;
session.animationTime = createAnimationTime();
```

Fix camera retries: `_executeInitAR()` currently calls `cleanARContainer()` in its catch block and then reuses the now-aborted captured session. Separate cleanup of a failed camera attempt from ending the requested AR session. Retry using a fresh attempt identifier; never resolve successful camera startup for an aborted request. Stop any late-created stream from an obsolete attempt.

Make camera switching pass through the same attempt/scheduler setup. Cancel the old video-frame callback, bind the new video, refresh the crop/projection through MindAR, reapply the buffer budget, and invalidate old camera results. Updating the facing flag and calling `start()` alone is insufficient.

Choose this gesture-worker lifecycle:

- Keep one ready worker and its initialized tasks while switching modes; stop submitting frames outside AR. Do not send `dispose` for ordinary session cleanup.
- Retain it for up to 60 seconds outside AR for quick reentry. Cancel that idle-disposal timer on AR entry. On expiry, request disposal, terminate after acknowledgement or a 250 ms grace period, clear readiness/pending frames, and unregister it.
- Always fully terminate/reset on unrecoverable worker failure. Increment the worker identifier before accepting a replacement.
- A frame received before initialization returns `busy`; it must not auto-initialize from default URLs. Only explicit `init` supplies the asset map and enabled tasks.
- Capture the actual worker reference, identifier, and camera/session identifier before bitmap creation; revalidate all after its promise resolves. Close obsolete bitmaps.
- Handle worker initialization that finishes after disposal without leaving live task instances behind.

Retain the existing worker GPU-to-CPU fallback, session/result guards, video-frame scheduling, and one-in-flight limit. Refactor readiness into a shared promise that rejects on worker errors/timeouts; reset a rejected promise so retry is possible.

Pause MindAR's controller video processing when hidden, not only Three.js rendering. Resume processing once when the existing stream is usable; otherwise run the guarded camera restart. Stop MindAR before nulling the video stream on mode exit. Dispose/terminate outgoing MindAR controller workers before replacement while retaining a single wrapper/renderer where supported. Keep library lifecycle handling in one adapter and validate against pinned 1.2.5; do not invent a `pause()` API.

**Checkpoint:** preview-to-AR renders; camera fallback really runs; switching lenses restores gestures; AR reentry reuses ready gesture tasks; idle disposal reinitializes through the original hashed configuration; no obsolete callbacks or worker growth after ten transitions.

### Step 4 — Start essential downloads sooner and stage optional work

Retain the current optimized GLB, shared fetch/parse promise, decoder, and parallel marker download. The next improvement is moving network discovery before the application's static imports finish.

Have the production build inject exact hashed model and marker preloads in the head, immediately after their URLs are known, ahead of application modules. Build the URLs from the same asset configuration used by `CONFIG`:

```html
<link rel="preload" as="fetch" crossorigin="anonymous"
      href="GENERATED_HASHED_MODEL_URL" fetchpriority="high">
<link rel="preload" as="fetch" crossorigin="anonymous"
      href="GENERATED_HASHED_MARKER_URL">
```

Use matching fetch URL/credentials/mode in the existing loaders and confirm the browser reuses these requests. Do not preload the fallback GLB, gesture models, or effects. Add `modulepreload` for the pinned Three.js entry and GLTFLoader only after measuring their network waterfall; preserve versions and avoid duplicate classic/module Three.js in built HTML.

Prime the memoized MindAR import after essential requests are dispatched, even when camera permission has not yet been granted. This downloads code only; it must not request camera access. Keep preview independent of its success. Give import/readiness failure a bounded UI error rather than indefinite preparing text.

Record separately: navigation-to-fetch-start, download, parse, model instantiation, first GPU render, camera permission wait, first decoded video frame, first marker detection, and overlay dismissal. Attach video-frame observation before playback can pass unnoticed; a late `onplaying` assignment is not a reliable first-frame measurement.

Wait for an actual browser presentation opportunity after first visible render before optional work. Make tracker initialization awaitable. Initialize enabled pose tracking first, yield, then enabled hands. Start effect texture loading sequentially after tracking settles, including its failed state. Support a feature-ready message so pose can work while hands load. Pass real isolation settings:

```js
const enabledTasks = [
  ...(!window.DISABLE_POSE ? ['pose'] : []),
  ...(!window.DISABLE_HANDS ? ['hand'] : [])
];
await ensureTrackingReady({ session, enabledTasks });
if (!isCurrent(session)) return;
await ensureExplosionTexture();
if (!isCurrent(session)) return;
await ensureStormTexture();
```

Wire error handling so tracking failure does not suppress touch effects. Preserve the existing texture-promise guard for early user requests, but do not start optional assets while the character is still loading. Queue an early effect intent for the current session instead. Bound queued intent to one pending request per effect.

Keep one parsed GLTF per page and reuse it across modes. Do not dispose shared geometry/textures when a clone leaves. Avoid a new format, texture re-encoding, or character simplification until measurements show the current 1.72 MB model/parse is the remaining dominant cost.

**Checkpoint:** a cold network trace shows model/marker requests starting before core module readiness; one successful model transfer and parse; no optional assets before visible character; tracker and effect initialization do not overlap unexpectedly. Exact first-character timing excludes permission/aiming from the software-only comparison.

### Step 5 — Reduce the remaining mobile work with measured controls

Add diagnostic-only controls `trackingDelegate=auto|cpu|gpu`, `cameraProfile=standard|economy`, and `quality=auto|balanced|reduced`. Forced settings must be visible in the performance report and reset when absent. Normal production uses `auto`, `standard`, and `auto` initially.

Use an isolation matrix on each phone: preview only; AR with both gestures disabled; AR with pose only; hands only; both tasks; both plus effects. Count actual task frames. A worker still shares the phone's CPU/GPU resources; moving inference off the UI thread does not guarantee free rendering time. Compare CPU and GPU delegates in the worker without initializing duplicate detector sets concurrently.

Add an economy camera profile at acquisition time:

```js
const cameraProfiles = {
  standard: { width: { ideal: 1280 }, height: { ideal: 720 },
              frameRate: { ideal: 30, max: 30 } },
  economy:  { width: { ideal: 960 }, height: { ideal: 540 },
              frameRate: { ideal: 30, max: 30 } }
};
```

Use ideal dimensions, retain device/facing preferences, and record actual `track.getSettings()` because browsers may choose different sizes. Do not resize a running camera stream behind an existing MindAR controller. Apply profile changes through guarded restart, with dimensions and projection rebuilt consistently.

Promotion rule: make economy the mobile default only if both test phones show at least 15% better p95 frame interval or marker-ready initialization time, without more than 20% worse marker reacquisition time or failed alignment checks. Otherwise retain standard. Avoid switching camera dimensions continuously with the visual quality policy.

Keep the existing rendering caps (balanced DPR <= 1, reduced <= 0.75) and 80/30 particles. Drive scheduler intervals from `QualityPolicy` fields rather than duplicated hardcoded constants. For sustained frame intervals above 40 ms, reduce both GPU resolution and optional task rates using existing hysteresis. Preserve all gesture capabilities and the 350 ms stale-result rule.

Measure marker-only performance before changing character geometry. Retain the current light/material setup initially; if rendering-only traces still miss the gate, test disabling the secondary point light and large backdrop blur in reduced mode. Keep a simplified visible effect response. Do not claim particle savings are the main fix without evidence.

**Checkpoint:** report whether the dominant delay is network, code startup, marker initialization, animation update, gesture inference, or rendering. Change production defaults only by the stated comparison rule; retain measured values and device details in the report.

### Step 6 — Replace illustrative tests with production tests

Extract only the helpers needed for timing, session transitions, worker state/scheduling, and asset mapping into small runtime modules. Import those exact modules in the application and Node tests. Remove behavioral tests that redeclare a similar implementation in the test body.

Required tests:

1. Elapsed-time playback equivalence at 60/30/15/10/5 FPS; suspension adds no playback time; zero/changed mixer speed works.
2. Actual pinned Three.js mixer completes the configured reaction twice and each arm-down once; cancellation/session change prevents obsolete completions. Use a small synthetic clip for timing, then validate the actual character clips in the browser.
3. Preview-to-AR changes authoritative mode and enables rendering; a failed camera attempt can retry; a stale attempt stops its stream.
4. Worker keep-warm/reentry, explicit initialization after idle disposal, enabled-task filtering, readiness rejection/retry, and preservation of hashed asset URLs.
5. One capture/inference in flight, old-worker bitmap rejection, stale result rejection, correct timeout cleanup, and task fairness.
6. Production asset hashes recomputed from bytes; all runtime references exist; no Tailwind CDN/classic Three.js in built HTML; fresh build provenance; required artwork/logo/compiler present.

Add browser integration checks against the built preview for actual module loading, preview appearance, mode changes, resource request order/counts, retry UI, and console errors. Use browser mocks for repeatable camera/worker failure cases, then run real-camera tests on physical phones. Desktop emulation supplements those tests.

Do not run the build against tracked files until Step 1 removes source writes. Separate source-unit tests from generated-output tests, or document the required build-first command order. A source-string grep may supplement these checks but cannot replace them.

**Checkpoint:** deliberately restore the 80 ms clamp or omit the AR mode assignment locally and verify the relevant tests fail; then restore the fix. This mutation check demonstrates the tests cover the actual regressions.

### Step 7 — Measure, publish, and verify the real domain

Use the same affected Android and iPhone throughout each before/after comparison. Record model, OS/browser version, connection, viewport, actual camera settings, build SHA, delegate, thermal starting condition, and warm/cold cache status.

Required measurements: five cold and five warm starts; 60 seconds of AR with both gestures; a five-minute sustained session; ten mode/camera switches. Measure controlled marker visibility separately from user aiming. Keep original production baseline and the pre-fix local-candidate baseline distinct.

Release gates:

- At least 25% lower median software-controlled character startup than the original production baseline under equivalent conditions. Report navigation-to-character and model-ready-to-character separately.
- At least 30 FPS median and p95 frame intervals <= 50 ms in the 60-second AR gesture scenario on both test phones.
- Animation advances according to elapsed active time and chosen scale at all tested frame rates; completion differs by at most one presented frame from expected timing, rather than accumulating slowdown.
- Normal worker-path gesture feedback within 350 ms excluding the intentional two-second hold; both gestures/effects and touch remain usable.
- No growing worker/loop/resource count after repeated transitions, and no sustained p95 regression greater than 20% between comparable minute-one and minute-five workloads.
- Every production runtime URL returns successfully and the live build identifier matches the approved deployment.

If a gate fails, record the actual bottleneck and failed scenario; do not mark the task optimized from green static tests. Merge through the configured GitHub production branch only after preview validation, verify Vercel built that commit, then confirm the domain alias and repeat the mobile smoke test. Retain the prior deployment for rollback. No framework migration or hosting-provider change is required.

## 3. Gemini execution prompt

Use `gemini-3.8-flash`. High thinking is appropriate for timing and lifecycle changes; medium for build/inventory edits. No Gemini API should be added to the app.

Copy this instruction with the plan:

> Inspect the current checkout before editing; this plan was prepared against da6cb41. Preserve unrelated texture changes. Implement Steps 1-7 in order, one reviewable patch per step. Keep working functionality from the previous optimization. Prioritize deployment provenance, real elapsed-time animation, scene/worker ownership, and earlier essential loading. Do not compensate for dropped frame time by increasing animationSpeed. Import production helpers in tests instead of reimplementing them. For each step report changed functions, commands and actual results, checkpoint status, and remaining failures. Use browser and physical-phone evidence for runtime performance claims. Do not declare completion until the real Vercel domain serves the approved build and measured gates pass; if physical testing is unavailable, report it as pending.

Deliver implementation patches, a before/after performance report with traces, test results, the preview URL and build SHA, and production verification/rollback details. This document itself is a plan, not evidence that the app has been fixed.

## 4. Reference documentation

- [Three.js AnimationMixer](https://threejs.org/docs/pages/AnimationMixer.html): delta-time updates and global timeScale. Keep the project's pinned r157 implementation; do not upgrade merely to follow current examples.
- [Three.js AnimationAction](https://threejs.org/docs/pages/AnimationAction.html): action timeScale, repetition, and completion behavior; verify event handling against r157 when implementing.
- [MindAR 1.2.5 wrapper source](https://raw.githubusercontent.com/hiukim/mind-ar-js/v1.2.5/src/image-target/three.js): separate controller processing, startup, renderer, and resize ownership.
- [MediaPipe hand tracking for Web](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/web_js): synchronous inference and video-mode tracking. Preserve MediaPipe 0.10.14.
- [Gemini 3.8 Flash model](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash): model identifier and supported thinking levels.
