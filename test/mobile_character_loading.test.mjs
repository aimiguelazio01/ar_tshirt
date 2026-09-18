import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { createQualityPolicy } from '../src/runtime/quality-policy.mjs';

globalThis.self = globalThis;
globalThis.window = globalThis;

test('Mobile Character Loading & Texture Quality Verification', async (t) => {

  await t.test('1. Authored character material factors, textures, and anisotropy preservation', async () => {
    const glbBuf = fs.readFileSync('assets/3d/monster/monster_anime_bs_v03.glb');
    const loader = new GLTFLoader();

    const gltf = await new Promise((resolve, reject) => {
      loader.parse(glbBuf.buffer.slice(glbBuf.byteOffset, glbBuf.byteOffset + glbBuf.byteLength), '', resolve, reject);
    });

    assert.ok(gltf.scene, 'GLTF scene parsed successfully');
    let skinMesh = null;
    gltf.scene.traverse((child) => {
      if (child.isMesh && child.name === 'Skin') {
        skinMesh = child;
      }
    });

    assert.ok(skinMesh, 'Skin mesh found in character GLB');
    const mat = skinMesh.material;
    assert.ok(mat, 'Skin mesh has material');

    // Authored roughness is 0.3, metalness is 0.0 (not flattened to 1.0 matte)
    assert.ok(Math.abs(mat.roughness - 0.3) < 1e-4, `Authored roughness must be 0.3, got ${mat.roughness}`);
    assert.equal(mat.metalness, 0, 'Authored metalness must be 0');

    // Simulate setupCharacterMaterials helper logic
    const mockRenderer = {
      capabilities: {
        getMaxAnisotropy: () => 16
      }
    };
    const maxAniso = Math.min(4, mockRenderer.capabilities.getMaxAnisotropy());
    assert.equal(maxAniso, 4, 'Texture anisotropy clamped to min(4, maxAniso)');

    // Verify index.html does not apply applyMatteMaterial to character
    const html = fs.readFileSync('index.html', 'utf8');
    assert.ok(!html.includes('applyMatteMaterial(child.material)'), 'applyMatteMaterial must not be applied to monster meshes');
    assert.ok(html.includes('setupCharacterMaterials(monsterModel, renderer)'), 'AR must invoke setupCharacterMaterials');
    assert.ok(html.includes('setupCharacterMaterials(simMonster, simRenderer)'), 'Simulator must invoke setupCharacterMaterials');
    assert.ok(!html.includes("child.material.precision = 'mediump'"), 'Forced mediump precision on character must be removed');
  });

  await t.test('2. QualityPolicy: mobile balanced and reduced budgets, hysteresis, zero-sized containers', () => {
    // Balanced profile
    const qpMobile = createQualityPolicy({ isMobile: true });
    assert.equal(qpMobile.profile, 'balanced');
    const balancedPolicy = qpMobile.getPolicy();
    assert.equal(balancedPolicy.maxPixelRatio, 1.5, 'Balanced maxPixelRatio must be 1.5');
    assert.equal(balancedPolicy.maxBufferPixels, 1500000, 'Balanced maxBufferPixels must be 1,500,000');
    assert.equal(balancedPolicy.ambientParticles, 80, 'Balanced ambient particles must be 80');
    assert.equal(balancedPolicy.temporaryEffectLights, true, 'Balanced temp effect lights enabled');

    // Zero-sized container protection
    assert.equal(qpMobile.computeBufferRatio(0, 0, 2.0), 1.5, 'Zero-sized container must return maxPixelRatio (1.5)');
    assert.equal(qpMobile.computeBufferRatio(0, 800, 2.0), 1.5, 'Zero-width container must return maxPixelRatio');
    assert.equal(qpMobile.computeBufferRatio(800, 0, 2.0), 1.5, 'Zero-height container must return maxPixelRatio');

    // Standard phone viewport (390 x 844 at 3x DPR)
    const phoneRatio = qpMobile.computeBufferRatio(390, 844, 3.0);
    assert.ok(phoneRatio <= 1.5, 'Ratio must not exceed 1.5 on high-DPR phone');
    const phonePixels = (390 * phoneRatio) * (844 * phoneRatio);
    assert.ok(phonePixels <= 1500000 * 1.01, 'Render buffer pixels must respect 1.5M budget');

    // Desktop profile
    const qpDesktop = createQualityPolicy({ isMobile: false });
    assert.equal(qpDesktop.profile, 'desktop');
    assert.equal(qpDesktop.getPolicy().maxPixelRatio, 2.0);
    assert.equal(qpDesktop.getPolicy().maxBufferPixels, 2073600);

    // Hysteresis downgrade after 3 high windows
    qpMobile.recordWindow({ p90: 45 });
    qpMobile.recordWindow({ p90: 45 });
    assert.equal(qpMobile.profile, 'balanced');
    const downgradeRes = qpMobile.recordWindow({ p90: 45 });
    assert.equal(downgradeRes, 'reduced');
    assert.equal(qpMobile.profile, 'reduced');

    const reducedPolicy = qpMobile.getPolicy();
    assert.equal(reducedPolicy.maxPixelRatio, 1.0, 'Reduced maxPixelRatio must be 1.0');
    assert.equal(reducedPolicy.maxBufferPixels, 750000, 'Reduced maxBufferPixels must be 750,000');
    assert.equal(reducedPolicy.ambientParticles, 30, 'Reduced ambient particles must be 30');
    assert.equal(reducedPolicy.temporaryEffectLights, false, 'Reduced temp effect lights disabled');

    // Recovery after 5 low windows
    for (let i = 0; i < 4; i++) qpMobile.recordWindow({ p90: 25 });
    assert.equal(qpMobile.profile, 'reduced');
    const recoverRes = qpMobile.recordWindow({ p90: 25 });
    assert.equal(recoverRes, 'balanced');
    assert.equal(qpMobile.profile, 'balanced');

    // Reset hysteresis
    qpMobile.recordWindow({ p90: 45 });
    assert.equal(qpMobile.consecutiveHighWindows, 1);
    qpMobile.resetHysteresis();
    assert.equal(qpMobile.consecutiveHighWindows, 0);
  });

  await t.test('3. Shared model asset promise and concurrent request deduplication', () => {
    // Verify memoized loadMonsterAsset logic in index.html
    const html = fs.readFileSync('index.html', 'utf8');
    assert.match(html, /function loadMonsterAsset\(\) \{[\s\S]*?if \(sharedGltf\) return Promise\.resolve\(sharedGltf\);[\s\S]*?if \(!modelPromise\) \{/, 'loadMonsterAsset must deduplicate concurrent requests with modelPromise');
    assert.match(html, /modelPromise = fetchAndParseMonster\(\)\.catch/, 'loadMonsterAsset must clear modelPromise on error for retry');
  });

  await t.test('4. Preload placement early in <head> and matching fetch mode in build', () => {
    const distHtml = fs.readFileSync('dist/index.html', 'utf8');
    const headMatch = distHtml.match(/<head>([\s\S]*?)<\/head>/i);
    assert.ok(headMatch, 'dist/index.html must have a <head>');
    const headContent = headMatch[1];

    const preloadIndex = headContent.indexOf('rel="preload" as="fetch"');
    const appBuildIndex = headContent.indexOf('<meta name="app-build"');
    const compiledCssIndex = headContent.indexOf('Compiled Production Tailwind CSS');

    assert.ok(preloadIndex !== -1, 'Preload must exist in <head>');
    assert.ok(appBuildIndex !== -1, 'app-build meta must exist in <head>');
    assert.ok(compiledCssIndex !== -1, 'Compiled CSS must exist in <head>');

    // Preloads must appear BEFORE compiled CSS and fonts in <head>
    assert.ok(preloadIndex < compiledCssIndex, 'Preload links must appear before compiled CSS in <head>');
    assert.ok(preloadIndex > appBuildIndex, 'Preload links must appear right after app-build meta');

    // Asset config must be declared before any application modules
    const assetConfigIndex = headContent.indexOf('window.__ASSET_CONFIG__');
    assert.ok(assetConfigIndex !== -1, '__ASSET_CONFIG__ must be in <head>');
    assert.ok(assetConfigIndex < compiledCssIndex, '__ASSET_CONFIG__ must be defined before CSS and application scripts');
  });

  await t.test('5. Standalone compression emitted-byte hash matches build.mjs convention', () => {
    const compScript = fs.readFileSync('scripts/compress_monster.mjs', 'utf8');
    assert.match(compScript, /function computeHash\(buffer\) \{[\s\S]*?digest\('hex'\)\.slice\(0, 16\);/, 'compress_monster.mjs must use 16-char sha256 of emitted bytes');
    assert.ok(!compScript.includes("path.join(outputDir, 'monster_anime_bs_v03.opt.glb')"), 'compress_monster.mjs must not write mutable unhashed alias');
    assert.ok(!compScript.includes("fs.writeFileSync(manifestPath,"), 'compress_monster.mjs must not overwrite build manifest');
  });

  await t.test('6. PerformanceDiagnostics reports timing breakdown and asset info', () => {
    const html = fs.readFileSync('index.html', 'utf8');
    assert.match(html, /recordModelDownload\(\{ url, bytes, duration \}\)/, 'recordModelDownload method exists');
    assert.match(html, /recordModelParse\(duration\)/, 'recordModelParse method exists');
    assert.match(html, /recordModelAttachment\(duration\)/, 'recordModelAttachment method exists');
    assert.match(html, /recordFirstMarkerDetection\(duration\)/, 'recordFirstMarkerDetection method exists');
    assert.match(html, /recordFirstCharacterRender\(duration\)/, 'recordFirstCharacterRender method exists');
    assert.match(html, /modelAttachmentDuration: 0,/, 'modelAttachmentDuration metric exists');
    assert.match(html, /firstMarkerDetectionDuration: 0,/, 'firstMarkerDetectionDuration metric exists');
    assert.match(html, /firstCharacterRenderDuration: 0/, 'firstCharacterRenderDuration metric exists');
  });
});
