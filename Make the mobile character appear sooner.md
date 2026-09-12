# Make the mobile character appear sooner

## Summary

Optimize the live website while preserving the character’s appearance, rig, and animations. Load gesture recognition and effects after the character becomes visible.

Inspection found these concrete opportunities:

| Finding | Implementation response |
|---|---|
| Active character is 3.42 MB, with approximately 10,500 triangles | Preserve geometry; apply lossless compression |
| GLTFLoader and MediaPipe share one module, delaying loader availability until both imports complete | Separate essential 3D imports from optional tracking imports |
| Preload, AR, and simulator each independently load the model | Share one download-and-parse promise |
| Gesture models and effect textures total approximately 17.8 MB | Move them behind the first visible character frame |
| Marker preload follows model loading | Start essential downloads concurrently |
| Production assets use `max-age=0, must-revalidate` | Cache content-versioned assets for repeat visits |

These are code-level findings. Actual mobile timings and deployed response headers still need measurement.

## Step-by-step code changes

### 1. Measure the current startup before changing behavior

In [index.html](E:/_desktop_2026/VibeCoding/monster_ar_tshirt/index.html), add performance marks around:

- Core libraries becoming ready.
- Character download start and completion.
- GLB parsing completion.
- Camera start request and first video frame.
- First marker detection.
- First rendered frame containing the visible character.
- Each optional feature becoming ready.

Use consistent names:

```js
performance.mark('model-download-start');
performance.mark('model-download-end');

performance.measure(
  'model-download',
  'model-download-start',
  'model-download-end'
);
```

Separate “model loaded” from “character visible.” In AR, visibility requires a detected marker; time spent pointing the camera must not be counted as download delay.

Put diagnostics behind `?debugPerformance=1`. Disable the existing `/log?...` request for every console message during normal production use. Keep errors available in the browser console.

**Deliverable:** baseline results from five cold-cache and five warm-cache runs, recording device, browser, connection, transferred bytes, and each measured stage.

### 2. Separate the essential imports from optional tracking

Replace the current mixed module at approximately line 1281:

- Import Three.js, GLTFLoader, and SkeletonUtils as essential dependencies.
- Move the application script into a module so its top-level `THREE` references execute only after imports resolve.
- Remove the separate classic Three.js script; retain version `0.157.0` throughout this change.
- Preserve necessary `window` exports for existing compatibility checks.
- Keep MediaPipe behind a memoized dynamic import.

```js
let visionModulePromise;

function loadVisionModule() {
  return visionModulePromise ??= import(
    'https://cdn.jsdelivr.net/npm/' +
    '@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs'
  ).catch(error => {
    visionModulePromise = null;
    throw error;
  });
}
```

Give MindAR its own dependency-ready promise. Replace polling loops with awaited readiness and explicit errors. Retain the existing image-target capabilities, including the compiler path, when reorganizing its imports.

**Acceptance:** blocked MediaPipe requests cannot prevent the character from loading or the simulator from opening.

### 3. Share one character load across every entry point

Replace the independent loader blocks in `runPreload()`, `attachMonsterModel()`, and `startSimulatorMode()` with one function:

```js
let modelPromise;

function loadMonsterAsset() {
  if (!modelPromise) {
    modelPromise = fetchAndParseMonster().catch(error => {
      modelPromise = null;
      throw error;
    });
  }

  return modelPromise;
}
```

Implement `fetchAndParseMonster()` to:

1. Fetch the configured GLB once.
2. Reject unsuccessful HTTP responses.
3. Report downloaded bytes when content length is available.
4. Parse through the shared GLTFLoader.
5. Return the parsed GLTF for reuse.

Use a 30-second download timeout with cancellation and a visible retry action. When length is unavailable, show an indeterminate loading indicator rather than a fabricated percentage.

All three callers await the same promise and use `SkeletonUtils.clone()` for their scene instance. Keep shared geometry and textures alive across mode changes.

Add a scene-generation counter: an asynchronous load completing after the user exits or changes modes must not attach a model to an obsolete scene.

**Acceptance:** immediately selecting 3D Preview during preload results in one GLB fetch and one parse.

### 4. Reorder startup around essential readiness

Refactor `runPreload()` to start character and marker loading together. Give marker loading its own shared promise so `getTargetSrc()` and preload reuse the same result.

```js
const modelReady = loadMonsterAsset();
const markerReady = loadMarkerAsset();

await Promise.all([modelReady, markerReady]);
```

Maintain separate states for:

- Character loading.
- AR dependencies and marker readiness.
- Camera readiness.
- Optional feature readiness.

The simulator waits only for the character and essential 3D libraries. AR waits for its essential dependencies and camera, never for gesture models or effects.

Remove the unconditional 150 ms preload delay. Prevent concurrent `initAR()` calls with one in-flight initialization promise, including camera auto-start and button clicks.

Keep existing camera permission behavior. Show specific errors with retry or the existing simulator alternative instead of leaving “PREPARING AR…” indefinitely.

**Acceptance:** marker download overlaps model download, and optional-feature failures do not block AR readiness.

### 5. Start optional features after the first visible character frame

Remove unconditional `initPoseTracking()`, `initExplosionTexture()`, and `initStormTexture()` calls from preload and AR initialization.

After a render containing the visible character, start a single optional-feature queue:

1. Load the MediaPipe module and shared vision fileset.
2. Initialize pose tracking.
3. Initialize hand tracking.
4. Load explosion and storm textures.

Yield between initialization jobs using `requestIdleCallback` with a bounded timeout and a `setTimeout` fallback. This schedules work; it does not move MediaPipe processing off the main thread.

Give each initializer its own shared promise. Remove the current hand-tracker initialization inside `initPoseTracking()` so the queue controls ordering.

In simulator mode, load effects after the character appears, but skip camera-based gesture models.

Show “Gestures loading…” while tracking initializes. Enable effect controls when their texture is ready; guard keyboard and gesture entry points too. An early effect request joins the existing load and executes once ready only if the scene is still active.

Pause inference when the page is hidden or AR is inactive. Clean up obsolete render loops and renderers on mode changes without disposing shared cached model assets.

**Acceptance:** no pose, hand, or effect-texture requests begin before the character’s first visible frame.

### 6. Compress the GLB without changing its appearance

Add a reproducible development-only asset command with locked dependency versions.

Use glTF Transform’s `EXT_meshopt_compression` extension directly, preserving existing attribute precision. Avoid the convenience `meshopt()` transform because it also applies quantization. Meshopt supports geometry, morph-target, and animation compression. [glTF Transform documentation](https://gltf-transform.dev/modules/functions/functions/meshopt)

For this implementation:

- Preserve texture bytes and dimensions.
- Preserve vertices, bone names, hierarchy, skin weights, morph targets, and animation timing.
- Do not simplify geometry or resample animations.
- Write a separate content-hashed output; retain the original asset.
- Require `EXT_meshopt_compression`, compatible with the pinned loader.

Configure the loader before parsing:

```js
import { MeshoptDecoder } from
  'three/addons/libs/meshopt_decoder.module.js';

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
```

The project’s Three.js release supports this decoder interface. [Three.js r157 source](https://raw.githubusercontent.com/mrdoob/three.js/r157/examples/jsm/loaders/GLTFLoader.js)

Compare compressed and original assets on mobile, including decoder download and decoding time. Promote the compressed asset only if total character readiness improves and visual checks pass; otherwise retain the original while shipping the scheduling improvements.

**Acceptance:** identical appearance and animation behavior, with a measured reduction in total loading cost.

### 7. Cache versioned production assets

Update [vercel.json](E:/_desktop_2026/VibeCoding/monster_ar_tshirt/vercel.json):

- Keep HTML revalidating so releases are discovered.
- Put generated content-versioned assets under `/assets/versioned/`.
- Apply the following header only to that directory:

```json
{
  "source": "/assets/versioned/(.*)",
  "headers": [
    {
      "key": "Cache-Control",
      "value": "public, max-age=31536000, immutable"
    }
  ]
}
```

Include the selected character, marker, gesture models, and effect textures in a generated asset manifest. Update all consumers, including alternate effect-loading paths, to use manifest URLs.

Remove conflicting cache rules for those responses. Preserve existing MIME and CORS headers. Never overwrite an immutable asset at the same URL. This follows Vercel’s content-versioned asset caching guidance. [Vercel documentation](https://vercel.com/docs/caching/cache-control-headers)

**Acceptance:** repeat visits reuse cached assets; a changed asset gets a new URL and loads after release.

## Validation and release

Test on physical Android Chrome and iPhone Safari, using a production-equivalent HTTPS preview. Include the user’s affected phone when available.

Required scenarios:

- Cold and warm visits on Wi-Fi and mobile data.
- Immediate 3D Preview selection during preload.
- Camera permission granted, denied, and already granted.
- Marker visible immediately and presented later.
- Failed character request followed by retry.
- Blocked MediaPipe or effect requests.
- Rapid AR/preview switching and leaving during loading.
- Backgrounding and resuming the page.
- Idle, reaction, recovery, both arm sequences, facial morphs, gestures, and effects.

Release criteria:

- One character fetch and parse per successful page session.
- Optional downloads begin after the first visible character frame.
- No visual or animation regression.
- No stale scene attachments or duplicate initialization.
- Warm visits reuse versioned assets.
- Target at least a 30% reduction in median character-readiness time under the same controlled mobile conditions; report actual results rather than treating this as guaranteed.

Implement and validate each step separately. Prepare a preview for mobile comparison before production release. Retain the previous deployment and original asset for rollback.

## Assumptions and interface changes

- The live site corresponds to this repository; confirm that during baseline capture.
- Preserve the current design, camera flow, and character quality.
- Gestures and effects may become available after the character.
- Internal additions: shared asset promises, dependency readiness, startup state, performance marks, and a versioned asset manifest.
- No new backend API, framework migration, service worker, or lower-detail character is required.
