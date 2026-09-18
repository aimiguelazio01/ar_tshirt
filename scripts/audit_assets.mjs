import fs from 'fs';
import path from 'path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

// Setup global environment for loaders in Node
global.self = global;

const SOURCE_GLB = 'assets/3d/monster/monster_anime_bs_v02.glb';
const RAW_BACKUP_GLB = 'assets/3d/monster/monster_anime_bs_v02_raw_backup.glb';
const OPT_GLB = 'assets/versioned/monster_anime_bs_v02.opt.glb';

const EXPECTED_MORPH_TARGETS = [
  'monster.smile',
  'monster.open',
  'monster.pff',
  'monster.scary',
  'monster.closed'
];

async function loadGLB(filePath) {
  await MeshoptDecoder.ready;
  return new Promise((resolve, reject) => {
    const fullPath = path.resolve(filePath);
    if (!fs.existsSync(fullPath)) {
      return reject(new Error(`File not found: ${fullPath}`));
    }
    const buf = fs.readFileSync(fullPath);
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.parse(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      path.dirname(fullPath) + '/',
      (gltf) => resolve(gltf),
      (err) => reject(err)
    );
  });
}

function isFiniteArray(arr) {
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i])) return false;
  }
  return true;
}

export async function auditAsset(filePath, label = 'Asset') {
  console.log(`\n--- Auditing ${label}: ${filePath} ---`);
  const gltf = await loadGLB(filePath);
  const scene = gltf.scene;
  const animations = gltf.animations || [];

  const results = {
    filePath,
    label,
    passed: true,
    errors: [],
    warnings: [],
    skinningDiffsVsBackup: [],
    morphTargets: [],
    trackCount: animations.length > 0 ? animations[0].tracks.length : 0,
    skinnedMeshCount: 0,
    vertexCount: 0
  };

  // 1. Find SkinnedMesh
  let skinnedMesh = null;
  scene.traverse((node) => {
    if (node.isSkinnedMesh) {
      skinnedMesh = node;
      results.skinnedMeshCount++;
    }
  });

  if (!skinnedMesh) {
    results.errors.push('No SkinnedMesh found in scene');
    results.passed = false;
    return results;
  }

  const geometry = skinnedMesh.geometry;
  const positionAttr = geometry.attributes.position;
  results.vertexCount = positionAttr ? positionAttr.count : 0;

  // 2. Audit Morph Targets
  const dict = skinnedMesh.morphTargetDictionary || {};
  const morphNames = Object.keys(dict);
  results.morphTargets = morphNames;

  if (morphNames.length !== EXPECTED_MORPH_TARGETS.length) {
    results.errors.push(`Expected ${EXPECTED_MORPH_TARGETS.length} morph targets, found ${morphNames.length}: [${morphNames.join(', ')}]`);
    results.passed = false;
  }

  for (const expectedName of EXPECTED_MORPH_TARGETS) {
    if (dict[expectedName] === undefined) {
      results.errors.push(`Missing expected morph target: '${expectedName}'`);
      results.passed = false;
    }
  }

  if (geometry.morphAttributes) {
    const morphPos = geometry.morphAttributes.position || [];
    const morphNorm = geometry.morphAttributes.normal || [];

    if (morphPos.length !== EXPECTED_MORPH_TARGETS.length) {
      results.errors.push(`morphAttributes.position count (${morphPos.length}) != expected (${EXPECTED_MORPH_TARGETS.length})`);
      results.passed = false;
    }

    for (let i = 0; i < morphPos.length; i++) {
      const targetAttr = morphPos[i];
      if (targetAttr.itemSize !== 3) {
        results.errors.push(`morphAttributes.position[${i}] itemSize is ${targetAttr.itemSize}, expected 3`);
        results.passed = false;
      }
      if (targetAttr.count !== results.vertexCount) {
        results.errors.push(`morphAttributes.position[${i}] vertex count ${targetAttr.count} != mesh vertex count ${results.vertexCount}`);
        results.passed = false;
      }
      if (!isFiniteArray(targetAttr.array)) {
        results.errors.push(`morphAttributes.position[${i}] contains non-finite values`);
        results.passed = false;
      }
    }

    for (let i = 0; i < morphNorm.length; i++) {
      const targetAttr = morphNorm[i];
      if (targetAttr.itemSize !== 3) {
        results.errors.push(`morphAttributes.normal[${i}] itemSize is ${targetAttr.itemSize}, expected 3`);
        results.passed = false;
      }
      if (!isFiniteArray(targetAttr.array)) {
        results.errors.push(`morphAttributes.normal[${i}] contains non-finite values`);
        results.passed = false;
      }
    }
  } else {
    results.errors.push('geometry.morphAttributes is missing');
    results.passed = false;
  }

  // 3. Finite Bone Transforms and Inverse-Bind Matrices
  const skeleton = skinnedMesh.skeleton;
  if (!skeleton) {
    results.errors.push('skinnedMesh has no skeleton');
    results.passed = false;
  } else {
    const bones = skeleton.bones || [];
    for (let b = 0; b < bones.length; b++) {
      const bone = bones[b];
      if (!Number.isFinite(bone.position.x) || !Number.isFinite(bone.position.y) || !Number.isFinite(bone.position.z)) {
        results.errors.push(`Bone '${bone.name}' has non-finite position`);
        results.passed = false;
      }
      if (!Number.isFinite(bone.quaternion.x) || !Number.isFinite(bone.quaternion.y) || !Number.isFinite(bone.quaternion.z) || !Number.isFinite(bone.quaternion.w)) {
        results.errors.push(`Bone '${bone.name}' has non-finite quaternion`);
        results.passed = false;
      }
      if (!Number.isFinite(bone.scale.x) || !Number.isFinite(bone.scale.y) || !Number.isFinite(bone.scale.z)) {
        results.errors.push(`Bone '${bone.name}' has non-finite scale`);
        results.passed = false;
      }
    }

    const boneInverses = skeleton.boneInverses || [];
    for (let b = 0; b < boneInverses.length; b++) {
      const mat = boneInverses[b];
      if (!isFiniteArray(mat.elements)) {
        results.errors.push(`Bone inverse matrix at index ${b} contains non-finite values`);
        results.passed = false;
      }
    }

    // 4. Skinning Joint Indices & Nonnegative Weights
    const skinIndexAttr = geometry.attributes.skinIndex;
    const skinWeightAttr = geometry.attributes.skinWeight;

    if (!skinIndexAttr || !skinWeightAttr) {
      results.errors.push('Missing skinIndex or skinWeight attributes');
      results.passed = false;
    } else {
      const numVertices = positionAttr.count;
      const indexArr = skinIndexAttr.array;
      const weightArr = skinWeightAttr.array;
      const itemSize = skinIndexAttr.itemSize; // typically 4

      let invalidJointCount = 0;
      let negativeWeightCount = 0;
      let badWeightSumCount = 0;
      let maxWeightSumDelta = 0;

      for (let v = 0; v < numVertices; v++) {
        let weightSum = 0;
        for (let j = 0; j < itemSize; j++) {
          const jointIdx = indexArr[v * itemSize + j];
          const weight = weightArr[v * itemSize + j];

          if (jointIdx < 0 || jointIdx >= bones.length) {
            invalidJointCount++;
          }
          if (weight < 0) {
            negativeWeightCount++;
          }
          weightSum += weight;
        }

        const delta = Math.abs(weightSum - 1.0);
        if (delta > maxWeightSumDelta) {
          maxWeightSumDelta = delta;
        }
        if (delta > 1e-4) {
          badWeightSumCount++;
        }
      }

      if (invalidJointCount > 0) {
        results.errors.push(`Found ${invalidJointCount} invalid joint indices (out of range [0, ${bones.length - 1}])`);
        results.passed = false;
      }
      if (negativeWeightCount > 0) {
        results.errors.push(`Found ${negativeWeightCount} negative skin weights`);
        results.passed = false;
      }
      if (badWeightSumCount > 0) {
        results.errors.push(`Found ${badWeightSumCount} vertices whose skin weights do not sum to 1 within 1e-4 (max delta: ${maxWeightSumDelta.toExponential(3)})`);
        results.passed = false;
      }
    }
  }

  // 5. Runtime Animation Track Resolution to Cloned Scene
  if (animations.length > 0) {
    const clonedScene = SkeletonUtils.clone(scene);
    const masterClip = animations[0];
    const mixer = new THREE.AnimationMixer(clonedScene);

    for (const track of masterClip.tracks) {
      if (!isFiniteArray(track.times) || !isFiniteArray(track.values)) {
        results.errors.push(`Track '${track.name}' contains non-finite time or value samples`);
        results.passed = false;
      }
    }

    const originalWarn = console.warn;
    const bindingWarnings = [];
    console.warn = (...args) => {
      const msg = args.join(' ');
      if (msg.includes('PropertyBinding') || msg.includes('track')) {
        bindingWarnings.push(msg);
      }
      originalWarn.apply(console, args);
    };

    try {
      const action = mixer.clipAction(masterClip);
      action.play();
      mixer.update(0.01);

      if (bindingWarnings.length > 0) {
        for (const w of bindingWarnings) {
          results.errors.push(`Binding warning: ${w}`);
        }
        results.passed = false;
      }

      if (mixer._nActiveBindings !== masterClip.tracks.length) {
        results.errors.push(`Active bindings (${mixer._nActiveBindings}) != track count (${masterClip.tracks.length})`);
        results.passed = false;
      }
    } finally {
      console.warn = originalWarn;
      mixer.stopAllAction();
    }
  } else {
    results.warnings.push('Asset contains no animations');
  }

  return { results, gltf };
}

/**
 * Compare current skinning against raw backup and report differences separately.
 */
export async function compareSkinningAgainstRawBackup(currentPath, rawBackupPath) {
  console.log(`\n--- Comparing Current Skinning against Raw Backup ---`);
  console.log(`Current:    ${currentPath}`);
  console.log(`Raw Backup: ${rawBackupPath}`);

  const diffReport = {
    jointCountMatch: true,
    jointNamesMatch: true,
    skinWeightsDiffer: false,
    maxWeightDiff: 0,
    divergentVertices: 0,
    totalVertices: 0,
    notes: []
  };

  const curr = await loadGLB(currentPath);
  const raw = await loadGLB(rawBackupPath);

  let currMesh = null, rawMesh = null;
  curr.scene.traverse(n => { if (n.isSkinnedMesh && !currMesh) currMesh = n; });
  raw.scene.traverse(n => { if (n.isSkinnedMesh && !rawMesh) rawMesh = n; });

  if (!currMesh || !rawMesh) {
    diffReport.notes.push('Could not find SkinnedMesh in both files');
    return diffReport;
  }

  const currBones = (currMesh.skeleton && currMesh.skeleton.bones) || [];
  const rawBones = (rawMesh.skeleton && rawMesh.skeleton.bones) || [];

  if (currBones.length !== rawBones.length) {
    diffReport.jointCountMatch = false;
    diffReport.notes.push(`Joint count mismatch: current has ${currBones.length}, raw backup has ${rawBones.length}`);
  }

  const currNames = currBones.map(b => b.name);
  const rawNames = rawBones.map(b => b.name);
  const namesEqual = currNames.every((name, i) => name === rawNames[i]);
  if (!namesEqual) {
    diffReport.jointNamesMatch = false;
    diffReport.notes.push('Joint names or ordering differ between current and raw backup');
  }

  const currWeights = currMesh.geometry.attributes.skinWeight;
  const rawWeights = rawMesh.geometry.attributes.skinWeight;

  if (currWeights && rawWeights) {
    diffReport.totalVertices = currMesh.geometry.attributes.position.count;
    let maxDelta = 0;
    let diffCount = 0;

    const len = Math.min(currWeights.array.length, rawWeights.array.length);
    for (let i = 0; i < len; i++) {
      const delta = Math.abs(currWeights.array[i] - rawWeights.array[i]);
      if (delta > maxDelta) maxDelta = delta;
      if (delta > 1e-4) diffCount++;
    }

    diffReport.maxWeightDiff = maxDelta;
    if (diffCount > 0) {
      diffReport.skinWeightsDiffer = true;
      diffReport.divergentVertices = Math.round(diffCount / currWeights.itemSize);
      diffReport.notes.push(`Skinning weights differ from raw backup on ${diffReport.divergentVertices} vertices (max weight delta: ${maxDelta.toFixed(4)}).`);
    } else {
      diffReport.notes.push('Skinning weights are identical to raw backup.');
    }
  }

  return diffReport;
}

/**
 * Compare Source GLB with Compressed/Optimized Production Asset.
 */
export async function compareSourceAndCompressed(sourcePath, optPath) {
  console.log(`\n--- Comparing Source and Compressed Production Asset ---`);
  const src = await loadGLB(sourcePath);
  const opt = await loadGLB(optPath);

  const report = {
    matches: true,
    errors: [],
    morphTargetOrderMatch: true,
    vertexCountMatch: true
  };

  let srcMesh = null, optMesh = null;
  src.scene.traverse(n => { if (n.isSkinnedMesh && !srcMesh) srcMesh = n; });
  opt.scene.traverse(n => { if (n.isSkinnedMesh && !optMesh) optMesh = n; });

  if (srcMesh && optMesh) {
    if (srcMesh.geometry.attributes.position.count !== optMesh.geometry.attributes.position.count) {
      report.vertexCountMatch = false;
      report.matches = false;
      report.errors.push('Vertex counts do not match between source and compressed');
    }

    const srcDict = Object.keys(srcMesh.morphTargetDictionary || {});
    const optDict = Object.keys(optMesh.morphTargetDictionary || {});
    if (JSON.stringify(srcDict) !== JSON.stringify(optDict)) {
      report.morphTargetOrderMatch = false;
      report.matches = false;
      report.errors.push(`Morph target dictionary order differs: src=[${srcDict}], opt=[${optDict}]`);
    }
  }

  return report;
}

// CLI entrypoint
if (process.argv[1] && process.argv[1].endsWith('audit_assets.mjs')) {
  (async () => {
    try {
      const sourceAudit = await auditAsset(SOURCE_GLB, 'Source Asset');
      console.log('Source Audit passed:', sourceAudit.results.passed);
      if (sourceAudit.results.errors.length > 0) {
        console.error('Source Audit errors:', sourceAudit.results.errors);
      }

      const optAudit = await auditAsset(OPT_GLB, 'Optimized Production Asset');
      console.log('Optimized Audit passed:', optAudit.results.passed);
      if (optAudit.results.errors.length > 0) {
        console.error('Optimized Audit errors:', optAudit.results.errors);
      }

      const skinningDiff = await compareSkinningAgainstRawBackup(SOURCE_GLB, RAW_BACKUP_GLB);
      console.log('Skinning comparison notes:', skinningDiff.notes);

      const srcVsOpt = await compareSourceAndCompressed(SOURCE_GLB, OPT_GLB);
      console.log('Source vs Compressed match:', srcVsOpt.matches);

      if (!sourceAudit.results.passed || !optAudit.results.passed || !srcVsOpt.matches) {
        console.error('❌ Asset audit failed!');
        process.exit(1);
      } else {
        console.log('✅ Asset audit complete and verified!');
      }
    } catch (e) {
      console.error('Asset audit encountered error:', e);
      process.exit(1);
    }
  })();
}
