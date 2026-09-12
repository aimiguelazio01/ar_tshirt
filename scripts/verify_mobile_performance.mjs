// Contract validation for Mobile Performance Implementation Plan
import fs from 'fs';
import path from 'path';
import assert from 'node:assert/strict';

console.log('🔍 Validating mobile performance contracts...');

const indexHtml = fs.readFileSync('index.html', 'utf8');
const trackingWorker = fs.readFileSync('tracking_worker.js', 'utf8');

// 1. Step 1: Trustworthy measurements & isolation flags
assert.ok(indexHtml.includes('PerformanceDiagnostics'), 'PerformanceDiagnostics missing');
assert.ok(indexHtml.includes('DISABLE_POSE') && indexHtml.includes('DISABLE_HANDS') && indexHtml.includes('DISABLE_VFX'), 'Isolation switches missing');
assert.ok(indexHtml.includes('recordFrame(renderer)') && indexHtml.includes('recordFrame(simRenderer)'), 'recordFrame calls missing');
assert.ok(indexHtml.includes('time-to-first-character'), 'time-to-first-character measure missing');
console.log('✅ Step 1 contracts passed');

// 2. Step 2: Lifecycle leaks & visibility pause
assert.ok(indexHtml.includes('renderer.setAnimationLoop(null)'), 'renderer.setAnimationLoop(null) missing in cleanup');
assert.ok(indexHtml.includes('simCleanupFn'), 'simCleanupFn listener registry missing');
assert.ok(indexHtml.includes('disposeSceneOwnedPlanes'), 'disposeSceneOwnedPlanes missing');
assert.ok(indexHtml.includes('visibilitychange') && indexHtml.includes('isDocumentHidden'), 'visibilitychange pause missing');
assert.ok(indexHtml.includes('activeLoops'), 'activeLoops metric missing');
console.log('✅ Step 2 contracts passed');

// 3. Step 3: Off-thread tracking worker & scheduler
assert.ok(fs.existsSync('tracking_worker.js'), 'tracking_worker.js file missing');
assert.ok(trackingWorker.includes('FilesetResolver') && trackingWorker.includes('PoseLandmarker') && trackingWorker.includes('HandLandmarker'), 'Worker tasks-vision missing');
assert.ok(indexHtml.includes('initTrackingWorker'), 'initTrackingWorker missing');
assert.ok(indexHtml.includes('GESTURE_DEBOUNCE_MS = 70'), 'GESTURE_DEBOUNCE_MS = 70 missing');
assert.ok(indexHtml.includes('MAIN_THREAD_FALLBACK_INTERVAL = 200'), '5Hz fallback interval missing');
console.log('✅ Step 3 contracts passed');

// 4. Step 4: Adaptive mobile rendering & zero-allocation budget
assert.ok(indexHtml.includes('QualityPolicy'), 'QualityPolicy missing');
assert.ok(indexHtml.includes('maxBufferPixels: 1000000') && indexHtml.includes('maxBufferPixels: 650000'), 'Buffer pixel limits missing');
assert.ok(indexHtml.includes('applyBufferBudget'), 'applyBufferBudget missing');
assert.ok(indexHtml.includes('consecutiveHighWindows') && indexHtml.includes('consecutiveLowWindows'), 'Hysteresis logic missing');
assert.ok(indexHtml.includes('updateEffects(delta)'), 'Delta-driven updateEffects missing');
console.log('✅ Step 4 contracts passed');

// 5. Step 5: Startup scheduling, memoized MindAR & retry UI
assert.ok(indexHtml.includes('ensureMindARReady'), 'ensureMindARReady missing');
assert.ok(indexHtml.includes('mindarReadyPromise'), 'mindarReadyPromise memoization missing');
assert.ok(indexHtml.includes('retryModelLoad'), 'retryModelLoad handler missing');
assert.ok(indexHtml.includes('showToast') && indexHtml.includes('actionCallback'), 'actionCallback support in showToast missing');
assert.ok(indexHtml.includes('ensureExplosionTexture') && indexHtml.includes('ensureStormTexture'), 'Shared effect texture promises missing');
console.log('✅ Step 5 contracts passed');

// 6. Step 6: Build-time CSS compilation, content-hashed assets & test suite
assert.ok(fs.existsSync('tailwind.config.js'), 'tailwind.config.js missing');
assert.ok(fs.existsSync('scripts/build.mjs'), 'scripts/build.mjs missing');
assert.ok(fs.existsSync('test/mobile_performance.test.mjs'), 'test/mobile_performance.test.mjs missing');
assert.ok(fs.existsSync('dist/index.html'), 'dist/index.html missing');
assert.ok(fs.existsSync('dist/manifest.json'), 'dist/manifest.json missing');

const distHtml = fs.readFileSync('dist/index.html', 'utf8');
assert.ok(!distHtml.includes('https://cdn.tailwindcss.com'), 'dist/index.html must not use Tailwind Play CDN');
assert.ok(distHtml.includes('assets/versioned/app.'), 'dist/index.html must include compiled versioned CSS');
assert.ok(distHtml.includes('window.__ASSET_CONFIG__'), 'dist/index.html must include inlined asset config');

const vercelJson = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
assert.equal(vercelJson.outputDirectory, 'dist', 'vercel.json must output to dist');
const immutableRule = vercelJson.headers.find(h => h.source === '/assets/versioned/(.*)');
assert.ok(immutableRule && immutableRule.headers.some(hdr => hdr.value.includes('immutable')), 'Immutable cache header missing for versioned assets');

console.log('✅ Step 6 contracts passed');

console.log('\n🎉 ALL MOBILE PERFORMANCE CONTRACTS VERIFIED SUCCESSFULLY!');
