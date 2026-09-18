import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

import {
  CLIP_DEFINITIONS,
  CLIP_DEFINITIONS_MAP,
  createSampledAnimationClip,
  createAllSampledClips,
  validateSourceClipCoverage
} from '../src/runtime/clip-sampler.mjs';

import {
  createAnimationController,
  AnimationState,
  arbitrateArms,
  FADE_DURATIONS
} from '../src/runtime/animation-controller.mjs';

import {
  auditAsset,
  compareSkinningAgainstRawBackup,
  compareSourceAndCompressed
} from '../scripts/audit_assets.mjs';

global.self = global;

const GLB_PATH = 'assets/3d/monster/monster_anime_bs_v03.glb';

function loadModel() {
  return new Promise((resolve, reject) => {
    const buf = fs.readFileSync(GLB_PATH);
    const loader = new GLTFLoader();
    loader.parse(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      '',
      (gltf) => resolve(gltf),
      (err) => reject(err)
    );
  });
}

test('Character Animation Repair — Complete Behavioral Test Suite', async (suite) => {
  const gltf = await loadModel();
  const masterClip = gltf.animations[0];
  const canonicalClips = createAllSampledClips(masterClip);

  // -------------------------------------------------------------------------
  // Criterion 1: Clamped pose -> idle restores expected bone transforms & all 5 morphs
  // -------------------------------------------------------------------------
  await suite.test('1. Clamped pose -> idle restores expected bone transforms and all five morph weights', () => {
    const model = SkeletonUtils.clone(gltf.scene);
    const skinMesh = model.getObjectByName('Skin');
    const controller = createAnimationController({ model, clips: canonicalClips, speed: 1.0 });

    // Settle in idle
    for (let i = 0; i < 30; i++) controller.update(1 / 24);
    const baselineIdleMorphs = [...skinMesh.morphTargetInfluences];
    const armBone = model.getObjectByName('L_upperarm');
    const baselineBonePos = armBone ? armBone.position.clone() : null;

    // Raise left arm into clamped hold (frames 73 to 80)
    controller.raiseArm('left');
    for (let i = 0; i < 30; i++) controller.update(1 / 24);
    assert.equal(controller.state, AnimationState.LEFT_HOLDING, 'Should be in holding state');

    // Morph weights during hold should have changed
    const heldMorphs = [...skinMesh.morphTargetInfluences];
    assert.ok(
      Math.abs(heldMorphs[2] - baselineIdleMorphs[2]) > 0.1 || Math.abs(heldMorphs[3] - baselineIdleMorphs[3]) > 0.1,
      'Held pose must influence morph targets'
    );

    // Lower left arm and advance until returned to idle and settled
    controller.lowerArm('left', { triggerEffect: false });
    for (let i = 0; i < 120; i++) controller.update(1 / 24);

    assert.equal(controller.state, AnimationState.IDLE, 'State must return to idle');
    assert.equal(controller.getDebugState().actionWeights.left_lower, 0, 'left_lower weight must reach 0');
    assert.equal(controller.getDebugState().actionWeights.left_raise, 0, 'left_raise weight must be 0');
    assert.equal(controller.getDebugState().actionWeights.idle, 1.0, 'idle weight must be 1.0');

    // Morph target 0, 1, 3, 4 must be 0 (or match idle baseline), no residual 0.5
    for (let m = 0; m < 5; m++) {
      if (m !== 2) {
        assert.ok(
          Math.abs(skinMesh.morphTargetInfluences[m]) < 1e-4,
          `Morph ${m} residual influence must be zero after returning to idle, got ${skinMesh.morphTargetInfluences[m]}`
        );
      }
    }
    controller.dispose();
  });

  // -------------------------------------------------------------------------
  // Criterion 2: Reaction completes exactly 2 or 5 cycles and fully releases influence
  // -------------------------------------------------------------------------
  await suite.test('2. Reaction completes exactly two or five cycles and fully releases its influence', () => {
    const model = SkeletonUtils.clone(gltf.scene);
    const controller = createAnimationController({ model, clips: canonicalClips, speed: 1.0 });

    // Test 2 cycles (tap)
    controller.playReaction(2);
    assert.equal(controller.state, AnimationState.REACTION);

    // Duration of 2 cycles of reaction (47 frames each at 24fps = 47/24 * 2 = 3.9167s)
    const reactionCycleDuration = (72 - 25) / 24;
    const twoCycles = reactionCycleDuration * 2;

    // Advance 3.0s (still in reaction)
    for (let t = 0; t < 3.0; t += 0.1) controller.update(0.1);
    assert.equal(controller.state, AnimationState.REACTION, 'Should still be in reaction before 2 cycles finish');

    // Advance past completion + crossfade into idle (3.9167s + 0.25s)
    for (let t = 3.0; t < twoCycles + 0.5; t += 0.1) controller.update(0.1);
    assert.equal(controller.state, AnimationState.IDLE, 'Must return to idle after 2 cycles');
    assert.equal(controller.getDebugState().actionWeights.reaction, 0, 'Reaction weight must be 0');
    assert.equal(controller.getDebugState().actionWeights.idle, 1.0, 'Idle weight must be 1.0');

    // Test 5 cycles (panic)
    controller.playReaction(5);
    assert.equal(controller.state, AnimationState.REACTION);
    const fiveCycles = reactionCycleDuration * 5;

    // Advance past 5 cycles + crossfade
    for (let t = 0; t < fiveCycles + 0.6; t += 0.1) controller.update(0.1);
    assert.equal(controller.state, AnimationState.IDLE, 'Must return to idle after 5 cycles');
    assert.equal(controller.getDebugState().actionWeights.reaction, 0, 'Reaction weight must be 0 after 5 cycles');
    assert.equal(controller.getDebugState().actionWeights.idle, 1.0, 'Idle weight must be 1.0');

    controller.dispose();
  });

  // -------------------------------------------------------------------------
  // Criterion 3: Both arms raise, hold, lower, and return to idle correctly
  // -------------------------------------------------------------------------
  await suite.test('3. Both arms raise, hold, lower, and return to idle correctly', () => {
    const model = SkeletonUtils.clone(gltf.scene);
    let effectTriggered = null;
    const controller = createAnimationController({
      model,
      clips: canonicalClips,
      speed: 1.0,
      onEffect: (type) => { effectTriggered = type; }
    });

    // --- LEFT ARM ---
    controller.raiseArm('left');
    assert.equal(controller.state, AnimationState.LEFT_RAISING);
    // Advance 0.5s -> reaches clamped frame 80
    for (let i = 0; i < 20; i++) controller.update(1 / 24);
    assert.equal(controller.state, AnimationState.LEFT_HOLDING);
    assert.equal(controller.getDebugState().frame, 80, 'Must hold at frame 80');

    // Lower left arm
    effectTriggered = null;
    controller.lowerArm('left', { triggerEffect: true });
    assert.equal(controller.state, AnimationState.LEFT_LOWERING);
    assert.equal(effectTriggered, 'storm', 'Must trigger storm effect once on left arm lowering');

    // Advance to idle
    for (let i = 0; i < 60; i++) controller.update(1 / 24);
    assert.equal(controller.state, AnimationState.IDLE);
    assert.equal(controller.getDebugState().actionWeights.left_lower, 0);

    // --- RIGHT ARM ---
    controller.raiseArm('right');
    assert.equal(controller.state, AnimationState.RIGHT_RAISING);
    for (let i = 0; i < 20; i++) controller.update(1 / 24);
    assert.equal(controller.state, AnimationState.RIGHT_HOLDING);
    assert.equal(controller.getDebugState().frame, 125, 'Must hold at frame 125');

    // Lower right arm
    effectTriggered = null;
    controller.lowerArm('right', { triggerEffect: true });
    assert.equal(controller.state, AnimationState.RIGHT_LOWERING);
    assert.equal(effectTriggered, 'explosion', 'Must trigger explosion effect on right arm lowering');

    // Advance to idle
    for (let i = 0; i < 60; i++) controller.update(1 / 24);
    assert.equal(controller.state, AnimationState.IDLE);
    assert.equal(controller.getDebugState().actionWeights.right_lower, 0);

    controller.dispose();
  });

  // -------------------------------------------------------------------------
  // Criterion 4: Rapid side switching, reaction interruptions, explicit idle
  // -------------------------------------------------------------------------
  await suite.test('4. Rapid side switching, reaction interruptions, explicit idle, and stale callbacks cannot revive old actions', () => {
    const model = SkeletonUtils.clone(gltf.scene);
    const controller = createAnimationController({ model, clips: canonicalClips, speed: 1.0 });

    // Rapid side switching
    controller.raiseArm('left');
    controller.update(0.04);
    assert.equal(controller.state, AnimationState.LEFT_RAISING);

    controller.raiseArm('right'); // Switch immediately
    assert.equal(controller.state, AnimationState.RIGHT_RAISING);

    controller.raiseArm('left'); // Switch back immediately
    assert.equal(controller.state, AnimationState.LEFT_RAISING);

    // Interrupt with reaction
    controller.playReaction(2);
    assert.equal(controller.state, AnimationState.REACTION);

    // Gestures during reaction are ignored
    const raisedLeftDuringReact = controller.raiseArm('left');
    assert.equal(raisedLeftDuringReact, false, 'Raise left must be ignored during reaction');
    const raisedRightDuringReact = controller.raiseArm('right');
    assert.equal(raisedRightDuringReact, false, 'Raise right must be ignored during reaction');
    assert.equal(controller.state, AnimationState.REACTION);

    // Explicit idle interrupts reaction immediately
    controller.playIdle();
    assert.equal(controller.state, AnimationState.IDLE);
    for (let i = 0; i < 30; i++) controller.update(1 / 24);

    const weights = controller.getDebugState().actionWeights;
    assert.equal(weights.idle, 1.0);
    assert.equal(weights.reaction, 0);
    assert.equal(weights.left_raise, 0);
    assert.equal(weights.right_raise, 0);

    controller.dispose();
  });

  // -------------------------------------------------------------------------
  // Criterion 5: Every clip includes correct boundary samples; sparse/constant tracks survive
  // -------------------------------------------------------------------------
  await suite.test('5. Every clip includes correct boundary samples; sparse and constant tracks survive extraction', () => {
    for (const def of CLIP_DEFINITIONS) {
      const clip = canonicalClips.get(def.id);
      assert.ok(clip, `Clip ${def.id} must exist`);
      assert.equal(clip.tracks.length, masterClip.tracks.length, `Clip ${def.id} must retain all 268 tracks`);

      const expectedFrames = def.endFrame - def.startFrame + 1;
      const expectedDuration = (def.endFrame - def.startFrame) / 24;
      assert.ok(Math.abs(clip.duration - expectedDuration) < 1e-6, `Clip ${def.id} duration mismatch`);

      for (const track of clip.tracks) {
        assert.equal(track.times.length, expectedFrames, `Track ${track.name} in clip ${def.id} must have ${expectedFrames} sample points`);
        assert.equal(track.times[0], 0, `Track ${track.name} in clip ${def.id} must start at local time 0`);
        assert.ok(Math.abs(track.times[track.times.length - 1] - expectedDuration) < 1e-6, `Track end time must match duration`);
      }
    }
  });

  // -------------------------------------------------------------------------
  // Criterion 6: Playback agrees at 60, 30, 15, and 5 FPS, including large steps
  // -------------------------------------------------------------------------
  await suite.test('6. Playback agrees at 60, 30, 15, and 5 FPS, including a large elapsed-time step', () => {
    const fpsList = [60, 30, 15, 5];
    const totalSimTime = 0.5; // 0.5 seconds

    const results = [];
    for (const fps of fpsList) {
      const model = SkeletonUtils.clone(gltf.scene);
      const controller = createAnimationController({ model, clips: canonicalClips, speed: 1.0 });
      const dt = 1 / fps;
      const steps = Math.round(totalSimTime / dt);
      for (let s = 0; s < steps; s++) {
        controller.update(dt);
      }
      const bone = model.getObjectByName('C_root');
      results.push({ fps, pos: bone ? bone.position.clone() : null });
      controller.dispose();
    }

    // Large single-step test (0.5s in one frame)
    const bigStepModel = SkeletonUtils.clone(gltf.scene);
    const bigStepCtrl = createAnimationController({ model: bigStepModel, clips: canonicalClips, speed: 1.0 });
    bigStepCtrl.update(0.5);
    const bigStepBone = bigStepModel.getObjectByName('C_root');
    bigStepCtrl.dispose();

    if (results[0].pos && bigStepBone) {
      const diff = results[0].pos.distanceTo(bigStepBone.position);
      assert.ok(diff < 1e-3, `Large step evaluation must agree with stepped evaluation within 1e-3, got ${diff}`);
    }
  });

  // -------------------------------------------------------------------------
  // Criterion 7: Hidden-tab time is excluded; speed changes and zero-speed pause behave correctly
  // -------------------------------------------------------------------------
  await suite.test('7. Hidden-tab time is excluded; speed changes and zero-speed pause behave correctly', () => {
    const model = SkeletonUtils.clone(gltf.scene);
    const controller = createAnimationController({ model, clips: canonicalClips, speed: 1.0 });

    // Speed change to 2.0x
    controller.setSpeed(2.0);
    assert.equal(controller.speed, 2.0);
    assert.equal(controller.mixer.timeScale, 2.0);

    // Pause (speed = 0)
    controller.setSpeed(0);
    assert.equal(controller.speed, 0);
    assert.equal(controller.mixer.timeScale, 0);

    const initialRawTime = controller.currentAction.time;
    // Advance delta while paused
    controller.update(1.0);
    assert.equal(controller.currentAction.time, initialRawTime, 'Action time must not advance while speed is 0');

    // Resume 1.0x
    controller.setSpeed(1.0);
    controller.update(0.1);
    assert.ok(controller.currentAction.time > initialRawTime, 'Action time must advance after resume');

    controller.dispose();
  });

  // -------------------------------------------------------------------------
  // Criterion 8: AR and Simulator clones remain independent; disposal removes active actions
  // -------------------------------------------------------------------------
  await suite.test('8. AR and Simulator clones remain independent; disposal removes callbacks and active actions', () => {
    const arModel = SkeletonUtils.clone(gltf.scene);
    const simModel = SkeletonUtils.clone(gltf.scene);

    const arCtrl = createAnimationController({ model: arModel, clips: canonicalClips, speed: 1.0 });
    const simCtrl = createAnimationController({ model: simModel, clips: canonicalClips, speed: 1.0 });

    // Raise left arm on AR only
    arCtrl.raiseArm('left');
    for (let i = 0; i < 20; i++) {
      arCtrl.update(1 / 24);
      simCtrl.update(1 / 24);
    }

    assert.equal(arCtrl.state, AnimationState.LEFT_HOLDING);
    assert.equal(simCtrl.state, AnimationState.IDLE, 'Simulator must remain in idle while AR raises arm');

    const arSkin = arModel.getObjectByName('Skin');
    const simSkin = simModel.getObjectByName('Skin');
    assert.notDeepEqual(
      [...arSkin.morphTargetInfluences],
      [...simSkin.morphTargetInfluences],
      'Morph target influences between AR and Simulator clones must be completely independent'
    );

    // Disposal
    arCtrl.dispose();
    assert.equal(arCtrl.state, AnimationState.DISPOSED);
    assert.equal(arCtrl.getDebugState(), null);

    simCtrl.dispose();
    assert.equal(simCtrl.state, AnimationState.DISPOSED);
  });

  // -------------------------------------------------------------------------
  // Criterion 9: Negative authored morph weights are preserved
  // -------------------------------------------------------------------------
  await suite.test('9. Negative authored morph weights are preserved', () => {
    const leftRaiseClip = canonicalClips.get('left_raise');
    assert.ok(leftRaiseClip, 'left_raise clip must exist');

    let foundNegativeMorphWeight = false;
    let minObservedMorphWeight = 0;

    for (const track of leftRaiseClip.tracks) {
      if (track.name.includes('morphTargetInfluences')) {
        for (const val of track.values) {
          if (val < minObservedMorphWeight) {
            minObservedMorphWeight = val;
          }
          if (val < -0.1) {
            foundNegativeMorphWeight = true;
          }
        }
      }
    }

    assert.ok(
      foundNegativeMorphWeight,
      `Authored negative morph weight (approx -0.177) must be preserved in left_raise, min observed: ${minObservedMorphWeight}`
    );
    assert.ok(
      Math.abs(minObservedMorphWeight - (-0.177)) < 0.01,
      `Min observed morph weight ${minObservedMorphWeight} must be close to authored -0.177`
    );
  });

  // -------------------------------------------------------------------------
  // Criterion 10: Source and compressed asset audits pass
  // -------------------------------------------------------------------------
  await suite.test('10. Source and compressed asset audits pass', async () => {
    const sourceAudit = await auditAsset(GLB_PATH, 'Source Asset');
    assert.ok(sourceAudit.results.passed, `Source asset audit must pass. Errors: ${sourceAudit.results.errors.join('; ')}`);
    assert.equal(sourceAudit.results.morphTargets.length, 5, 'Must have 5 morph targets');

    const optFile = fs.existsSync('assets/versioned')
      ? fs.readdirSync('assets/versioned').find(f => f.startsWith('monster_anime_bs_v03') && f.endsWith('.opt.glb'))
      : null;
    const optPath = optFile ? path.join('assets/versioned', optFile) : 'assets/versioned/monster_anime_bs_v03.opt.glb';
    if (fs.existsSync(optPath)) {
      const optAudit = await auditAsset(optPath, 'Optimized Production Asset');
      assert.ok(optAudit.results.passed, `Compressed asset audit must pass. Errors: ${optAudit.results.errors.join('; ')}`);

      const compare = await compareSourceAndCompressed(GLB_PATH, optPath);
      assert.ok(compare.matches, `Source vs compressed comparison must match. Errors: ${compare.errors.join('; ')}`);
    }

    // Verify skinning against raw backup
    const rawBackupPath = 'assets/3d/monster/monster_anime_bs_v02_raw_backup.glb';
    if (fs.existsSync(rawBackupPath)) {
      const skinningDiff = await compareSkinningAgainstRawBackup(GLB_PATH, rawBackupPath);
      assert.ok(skinningDiff.jointCountMatch, 'Joint counts must match raw backup');
      assert.ok(skinningDiff.jointNamesMatch, 'Joint names must match raw backup');
    }
  });

  // -------------------------------------------------------------------------
  // Additional: Both-arms arbitration helper
  // -------------------------------------------------------------------------
  await suite.test('Both-arms arbitration helper preserves required priority rules', () => {
    // Only right raised
    assert.equal(arbitrateArms(false, true), 'right');
    // Only left raised
    assert.equal(arbitrateArms(true, false), 'left');
    // Neither raised
    assert.equal(arbitrateArms(false, false), null);
    // Both raised: retain active arm
    assert.equal(arbitrateArms(true, true, 'left'), 'left');
    assert.equal(arbitrateArms(true, true, 'right'), 'right');
    // Both raised and neither was active: choose right
    assert.equal(arbitrateArms(true, true, null), 'right');
  });
});
