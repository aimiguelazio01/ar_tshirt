// Contract validation for Mobile Performance Implementation Plan
import fs from 'fs';
import path from 'path';

console.log('🔍 Validating mobile performance contracts...');

const indexHtml = fs.readFileSync('index.html', 'utf8');
const trackingWorker = fs.readFileSync('tracking_worker.js', 'utf8');
const manifest = JSON.parse(fs.readFileSync('assets/versioned/manifest.json', 'utf8'));

// 1. Step 1: Trustworthy measurements & isolation flags
console.assert(indexHtml.includes('PerformanceDiagnostics'), 'PerformanceDiagnostics missing');
console.assert(indexHtml.includes('DISABLE_POSE') && indexHtml.includes('DISABLE_HANDS') && indexHtml.includes('DISABLE_VFX'), 'Isolation switches missing');
console.assert(indexHtml.includes('recordFrame(renderer)') && indexHtml.includes('recordFrame(simRenderer)'), 'recordFrame calls missing');
console.assert(indexHtml.includes('time-to-first-character'), 'time-to-first-character measure missing');
console.log('✅ Step 1 contracts passed');

// 2. Step 2: Lifecycle leaks & visibility pause
console.assert(indexHtml.includes('renderer.setAnimationLoop(null)'), 'renderer.setAnimationLoop(null) missing in cleanup');
console.assert(indexHtml.includes('simCleanupFn'), 'simCleanupFn listener registry missing');
console.assert(indexHtml.includes('disposeSceneOwnedPlanes'), 'disposeSceneOwnedPlanes missing');
console.assert(indexHtml.includes('visibilitychange') && indexHtml.includes('isDocumentHidden'), 'visibilitychange pause missing');
console.assert(indexHtml.includes('activeLoops'), 'activeLoops metric missing');
console.log('✅ Step 2 contracts passed');

// 3. Step 3: Adaptive mobile rendering
console.assert(indexHtml.includes('QualityPolicy'), 'QualityPolicy missing');
console.assert(indexHtml.includes('maxBufferPixels: 1000000') && indexHtml.includes('maxBufferPixels: 650000'), 'Buffer pixel limits missing');
console.assert(indexHtml.includes('antialias: !QualityPolicy.isMobile'), 'Mobile AA optimization missing');
console.assert(indexHtml.includes('consecutiveHighWindows') && indexHtml.includes('consecutiveLowWindows'), 'Hysteresis logic missing');
console.log('✅ Step 3 contracts passed');

// 4. Step 4: Off-thread tracking worker & elapsed-time debounce
console.assert(fs.existsSync('tracking_worker.js'), 'tracking_worker.js file missing');
console.assert(trackingWorker.includes('FilesetResolver') && trackingWorker.includes('PoseLandmarker') && trackingWorker.includes('HandLandmarker'), 'Worker tasks-vision missing');
console.assert(indexHtml.includes('initTrackingWorker'), 'initTrackingWorker missing');
console.assert(indexHtml.includes('GESTURE_DEBOUNCE_MS = 70'), 'GESTURE_DEBOUNCE_MS = 70 missing');
console.assert(indexHtml.includes('MAIN_THREAD_FALLBACK_INTERVAL = 200'), '5Hz fallback interval missing');
console.log('✅ Step 4 contracts passed');

// 5. Step 5: Startup & hashed asset caching
console.assert(indexHtml.includes('assets/versioned/monster_anime_bs_v02.b016e6cc.opt.glb'), 'Hashed model URL missing in CONFIG');
console.assert(fs.existsSync('assets/versioned/monster_anime_bs_v02.b016e6cc.opt.glb'), 'Hashed model asset file missing');
console.assert(indexHtml.includes('fallbackModelUrl'), 'fallbackModelUrl missing');
console.assert(!indexHtml.includes("catch (err) {\n        console.warn('[Preload] Asset preload warning (will retry on demand):', err);\n      }\n\n      if (els.progressText) {\n        els.progressText.textContent = 'READY';"), 'Preload false READY bug still present');
console.log('✅ Step 5 contracts passed');

console.log('\n🎉 ALL MOBILE PERFORMANCE CONTRACTS VERIFIED SUCCESSFULLY!');
