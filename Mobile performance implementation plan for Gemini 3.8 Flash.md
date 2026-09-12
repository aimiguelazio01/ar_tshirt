# Mobile performance implementation plan for Gemini 3.8 Flash

## 1. Goal and confirmed findings

Improve **both loading time and animation smoothness on Android Chrome**, preserving the character, animations, two-hand interaction, and arm gestures. Reduce rendering resolution and decorative effects when necessary.

The previous startup optimization is already implemented. Build on the current code rather than repeating it.

Inspection of [index.html](E:/_desktop_2026/VibeCoding/monster_ar_tshirt/index.html) found:

| Finding | Required response |
|---|---|
| Pose and hand detection run synchronously inside the rendering loop, with intervals of 35 ms and 28 ms | Move inference into a worker and process fewer, fresh camera frames |
| AR inherits unrestricted device pixel density; preview allows pixel ratio 2 | Apply an explicit, adaptive rendering budget |
| AR cleanup does not stop its rendering loop or dispose renderers | Fix lifecycle ownership before further optimization |
| Preview adds window event listeners on every entry | Register removable listeners and clean them up |
| First-character timing occurs before rendering and references an undefined performance mark | Correct measurements |
| Optional-feature readiness uses global flags across modes | Separate asset readiness from active scene state |
| The active GLB URL uses an unhashed alias despite immutable caching | Use content-hashed asset URLs consistently |

Google confirms that MediaPipe detection calls block the calling thread and recommends workers. [MediaPipe documentation](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js). MindAR 1.2.5 explicitly sets its renderer to `window.devicePixelRatio`. [Pinned MindAR source](https://raw.githubusercontent.com/hiukim/mind-ar-js/v1.2.5/src/image-target/three.js).

These are code findings; their relative performance impact still needs measurement on the affected phone.

## 2. Ordered implementation steps

### Step 1 — Establish trustworthy measurements

Extend `?debugPerformance=1` with local diagnostics. Remove its per-console-message network requests because they distort results.

Record:

- Model download and parse duration.
- Camera request to first video frame.
- First marker detection and first rendered character, separately.
- Frame interval median and 95th percentile.
- Inference duration, result age, and effective pose/hand rates.
- Drawing-buffer dimensions, draw calls, triangles, and renderer resource counts.
- Active rendering loops, workers, and scene generation.

Measure the first character **after** a successful render with the model visible and the welcome overlay dismissed. Use navigation time zero for initial startup and separate start marks for subsequent mode entries.

Capture five cold and five warm starts, plus 60-second sessions with gestures and effects. Add debug switches to disable pose, hands, and effects independently for bottleneck isolation.

**Checkpoint:** Save an initial measurement report. Missing physical-phone measurements must remain explicitly pending.

### Step 2 — Fix lifecycle leaks

Make `cleanARContainer()` responsible for every resource owned by the departing scene:

- Stop the AR loop with `setAnimationLoop(null)` before clearing references.
- Cancel preview animation frames, scheduled scene callbacks, effect timers, and animation timers.
- Remove preview pointer, touch, and resize listeners.
- Stop camera tracks and dispose departing renderers and scene-owned resources.
- Preserve cached GLTF geometry and textures; dispose only resources owned by the scene.
- Extend the existing generation guard to camera startup, optional initialization, effects, and tracking results.

Use named handlers and a per-session cleanup registry. Retain one MindAR instance across AR restarts to avoid accumulating the library’s internally bound resize listeners; stop its camera and rendering while inactive.

Pause rendering and optional inference when hidden. Pause MindAR processing through its supported controller lifecycle, then resume once with fresh timing. Mode exit must stop the camera completely.

Replace global “first character” and “optional features started” flags with per-session visibility state and independent shared feature promises. Entering preview first must not prevent gestures from initializing later in AR.

**Checkpoint:** Ten AR/preview switches leave one active renderer loop, no obsolete callbacks, and no steadily increasing resource count after warm-up.

### Step 3 — Apply adaptive mobile rendering

Introduce one shared quality policy for AR and preview:

| Setting | Balanced default | Reduced quality |
|---|---:|---:|
| Maximum pixel ratio | 1.0 | 0.75 |
| Maximum drawing-buffer pixels | 1,000,000 | 650,000 |
| Decorative particles | 80 | 30 |
| Sparks per effect | 12 | 6 |
| Temporary effect lights | Enabled | Disabled |
| Pose inference ceiling | 10 Hz | 6 Hz |
| Hand inference ceiling | 15 Hz | 10 Hz |
| Tracking input longest edge | 640 px | 480 px |

Calculate the effective pixel ratio from both the ratio cap and pixel budget. Preserve MindAR’s canvas layout and camera projection; change rendering resolution only. Reapply after resizing, rotation, and camera changes.

Keep the character’s geometry, rig, morphs, animation clips, and materials. Disable preview antialiasing and logarithmic depth buffering on mobile; keep its existing near/far clipping range and verify overlapping surfaces.

Evaluate frame intervals in two-second windows after initialization:

- Reduce quality after three consecutive windows with 90th-percentile frame intervals above 40 ms.
- Restore balanced quality after five consecutive windows below 30 ms.
- Ignore hidden periods and reset sampling after mode changes.
- Never exceed balanced quality on mobile.

Cache frequently used bones, video/DOM references, vectors, and quaternions. Move decorative animation and sprite effects onto the active render clock, replacing their independent intervals. Preserve animation speed with elapsed-time updates and reset the clock after suspension.

**Checkpoint:** Rotation preserves marker alignment and touch coordinates; reduced quality preserves all interaction capabilities.

### Step 4 — Move gesture inference off the rendering thread

Create one dedicated tracking worker. Keep Three.js, DOM updates, raycasting, and gesture actions on the main thread.

Split existing tracking functions into:

1. Frame acquisition and inference scheduling.
2. Pose-result handling.
3. Hand-result handling.

Use this internal message contract:

- Requests: `init`, `frame`, `dispose`.
- Responses: `ready`, `result`, `error`.
- Each frame/result carries session generation, frame ID, task kind, and capture timestamp.

Worker behavior:

- Initialize the existing pinned MediaPipe version and models.
- Try GPU initialization with worker-compatible canvas support; fall back to CPU within the worker.
- Keep one pose and two-hand detection.
- Process one task at a time.

Main-thread scheduling:

- Use `requestVideoFrameCallback`; fall back to checking `video.currentTime`.
- Resize frames while preserving aspect ratio, then transfer an `ImageBitmap`.
- Permit only one capture/inference operation in flight. Drop intermediate frames instead of queueing them.
- Alternate eligible tasks according to the quality profile.
- Close transferred bitmaps after inference.
- Run inference only in active, visible AR. Pause hands when interactive plates cannot be used; preserve pose tracking while needed to restore them.
- Preserve existing mirroring, crop mapping, and normalized coordinates.

Discard obsolete-generation results and results older than 350 ms. Clear reticles and pending holds when results become stale.

Replace two-frame gesture debounce counters with a **70 ms elapsed-time threshold**, requiring at least two fresh agreeing samples. Preserve the existing two-second hand hold. Tracking loss must reset pending actions without triggering an effect.

If worker initialization fails, use one deduplicated main-thread scheduler capped at **5 Hz per task**, alternating tasks outside the render callback. Expose degraded tracking status and retain touch controls.

**Checkpoint:** The normal Android path contains no main-thread `detectForVideo()` calls, no inference backlog, and no gesture timing dependence on frame rate.

### Step 5 — Finish startup and caching corrections

Preserve shared model loading and the compressed GLB.

- Import essential Three.js dependencies directly into the application module.
- Start model and marker downloads concurrently.
- Replace MindAR readiness polling with a memoized import promise. Load compiler support only for image compilation.
- Keep preview usable independently of AR dependency readiness.
- Start optional initialization after the first visible render. Yield to the browser before dispatching worker initialization.
- Maintain separate readiness for the character, marker, camera, and optional features.
- Do not mark failed preload attempts as “READY.” Retry must resume the requested mode.
- Route early effect requests through the existing texture promise and discard requests belonging to departed scenes.

Update asset generation to hash the **actual emitted bytes**. Use hashed URLs for the model, marker, tracking models, and effects. Generate a small asset configuration consumed by the page without adding a blocking manifest request.

Keep HTML and mutable manifests revalidating. Apply immutable caching only to hashed assets; remove the active dependency on unhashed aliases. Use the same URLs in all fallback and effect paths.

**Checkpoint:** One successful GLB fetch and parse per page session; optional work starts after visibility; changed assets receive new URLs.

## 3. Validation and acceptance

Use the affected Android phone as the primary device and record its model, browser version, connection, and build. Desktop emulation supplements physical testing.

Targets:

- At least **30 FPS median**, with 95th-percentile frame intervals at or below **50 ms**, during a 60-second AR session with tracking.
- At least **25% lower median character startup time** against the current build under equivalent conditions, excluding permission-dialog and user aiming time.
- Gesture response within **300 ms** in balanced mode, excluding intentional hold duration.
- No sustained deterioration during a five-minute session.
- No accumulating loops, listeners, or scene resources after ten mode switches.

Required scenarios:

- Cold/warm startup, immediate preview selection, and preview → AR.
- Camera permission denial, model failure/retry, and unavailable optional assets.
- Worker GPU failure, CPU fallback, and total worker failure.
- Marker loss/recovery, both arm gestures, two-hand holds, touch actions, and both effects.
- Background/resume, camera switching, portrait/landscape rotation.
- Visual checks for skinning, facial morphs, clipping, animation timing, and plate alignment.

Add focused automated tests for scheduler backpressure, stale-result rejection, elapsed-time debounce, quality hysteresis, and cleanup. Replace the placeholder test command with these tests; existing asset checks alone do not validate performance.

Deliver a comparison report and HTTPS preview. Targets are release gates, not claimed results. If any fail, report the measured bottleneck and retain the previous deployment for rollback.

## 4. Gemini Flash 3.8 execution contract

Use `gemini-3.8-flash`. Recommended thinking level: **high** for lifecycle and worker integration; **medium** for diagnostics, quality settings, and asset wiring. These levels are supported by the model. [Google model documentation](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash).

Give Gemini this plan and require it to:

1. Implement the five steps in order, with a small reviewable patch per step.
2. Read the relevant functions before editing; preserve unrelated UI and behavior.
3. Run each checkpoint before advancing.
4. Report changed behavior, validation performed, measured results, and remaining failures after each step.
5. Never substitute successful syntax checks for mobile performance evidence.
6. Avoid rewriting the entire application, upgrading tracking libraries, simplifying the character, or introducing a new framework.

Defaults: Android Chrome, balanced visuals, existing library versions, current character assets, and existing camera permission flow. Gemini is the implementation assistant; no Gemini runtime API is added to the website.
