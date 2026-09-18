import fs from 'fs';
import path from 'path';
import { NodeIO } from '@gltf-transform/core';

export async function repairSkinning(inputPath, outputPath) {
  const io = new NodeIO();
  const doc = await io.read(inputPath);
  const root = doc.getRoot();

  const meshes = root.listMeshes();
  if (meshes.length === 0) {
    throw new Error('No meshes found in model');
  }

  const prim = meshes[0].listPrimitives()[0];
  if (!prim) {
    throw new Error('No primitive found in first mesh');
  }

  const skins = root.listSkins();
  if (skins.length === 0) {
    throw new Error('No skin found in model');
  }
  const skin = skins[0];
  const numJoints = skin.listJoints().length;
  console.log(`[Repair] Skeleton joint count: ${numJoints}`);

  const posAttr = prim.getAttribute('POSITION');
  const numVertices = posAttr.getCount();
  console.log(`[Repair] Vertex count: ${numVertices}`);

  // Locate all JOINTS and WEIGHTS attribute sets
  const jointAttrs = [];
  const weightAttrs = [];
  for (let s = 0; s < 10; s++) {
    const jAcc = prim.getAttribute(`JOINTS_${s}`);
    const wAcc = prim.getAttribute(`WEIGHTS_${s}`);
    if (jAcc && wAcc) {
      jointAttrs.push(jAcc);
      weightAttrs.push(wAcc);
    }
  }

  console.log(`[Repair] Detected ${jointAttrs.length} joint/weight influence sets (${jointAttrs.length * 4} influences per vertex)`);
  if (jointAttrs.length === 0) {
    throw new Error('No skinning attributes found');
  }

  const newJoints = new Uint16Array(numVertices * 4);
  const newWeights = new Float32Array(numVertices * 4);

  let mergedDuplicatesCount = 0;
  let truncatedInfluencesCount = 0;

  for (let v = 0; v < numVertices; v++) {
    const jointWeightMap = new Map();

    for (let setIdx = 0; setIdx < jointAttrs.length; setIdx++) {
      const jArr = jointAttrs[setIdx].getArray();
      const wArr = weightAttrs[setIdx].getArray();

      for (let c = 0; c < 4; c++) {
        const joint = jArr[v * 4 + c];
        const weight = wArr[v * 4 + c];

        // Validate joint index
        if (!Number.isInteger(joint) || joint < 0 || joint >= numJoints) {
          throw new Error(`Invalid joint index ${joint} at vertex ${v}, set ${setIdx}, component ${c}`);
        }

        // Validate weight value
        if (!Number.isFinite(weight) || weight < 0) {
          throw new Error(`Invalid weight ${weight} at vertex ${v}, set ${setIdx}, component ${c}`);
        }

        if (weight > 0) {
          if (jointWeightMap.has(joint)) {
            mergedDuplicatesCount++;
            jointWeightMap.set(joint, jointWeightMap.get(joint) + weight);
          } else {
            jointWeightMap.set(joint, weight);
          }
        }
      }
    }

    let totalWeight = 0;
    for (const w of jointWeightMap.values()) {
      totalWeight += w;
    }

    if (totalWeight <= 1e-7) {
      throw new Error(`Zero or non-positive total weight (${totalWeight}) at vertex ${v}`);
    }

    // Sort descending by weight
    const sortedEntries = Array.from(jointWeightMap.entries()).sort((a, b) => b[1] - a[1]);

    if (sortedEntries.length > 4) {
      truncatedInfluencesCount++;
    }

    const top4 = sortedEntries.slice(0, 4);
    const top4Sum = top4.reduce((sum, e) => sum + e[1], 0);

    if (top4Sum <= 1e-7) {
      throw new Error(`Top 4 weights sum to ${top4Sum} at vertex ${v}`);
    }

    // Assign and normalize top 4
    let verifySum = 0;
    for (let slot = 0; slot < 4; slot++) {
      if (slot < top4.length) {
        const [joint, weight] = top4[slot];
        const normalizedWeight = weight / top4Sum;
        newJoints[v * 4 + slot] = joint;
        newWeights[v * 4 + slot] = normalizedWeight;
        verifySum += normalizedWeight;
      } else {
        newJoints[v * 4 + slot] = 0;
        newWeights[v * 4 + slot] = 0.0;
      }
    }

    if (Math.abs(verifySum - 1.0) > 1e-5) {
      throw new Error(`Normalized weight sum ${verifySum} != 1.0 at vertex ${v}`);
    }
  }

  console.log(`[Repair] Merged duplicate joint influences: ${mergedDuplicatesCount}`);
  console.log(`[Repair] Vertices with >4 raw influences condensed to top 4: ${truncatedInfluencesCount}`);

  // Update existing JOINTS_0 and WEIGHTS_0 accessors in place
  prim.getAttribute('JOINTS_0').setArray(newJoints);
  prim.getAttribute('WEIGHTS_0').setArray(newWeights);

  // Remove and dispose all extra JOINTS_* and WEIGHTS_* attribute sets (1..9)
  for (let s = 1; s < 10; s++) {
    const jAcc = prim.getAttribute(`JOINTS_${s}`);
    if (jAcc) {
      prim.setAttribute(`JOINTS_${s}`, null);
      jAcc.dispose();
    }
    const wAcc = prim.getAttribute(`WEIGHTS_${s}`);
    if (wAcc) {
      prim.setAttribute(`WEIGHTS_${s}`, null);
      wAcc.dispose();
    }
  }

  // Validate morph targets were preserved
  const targets = prim.listTargets();
  console.log(`[Repair] Preserved morph targets count: ${targets.length}`);
  if (targets.length !== 5) {
    throw new Error(`Expected 5 morph targets, found ${targets.length}`);
  }

  // Validate animations were preserved
  const anims = root.listAnimations();
  console.log(`[Repair] Preserved animations count: ${anims.length}, channels: ${anims[0]?.listChannels().length}`);

  const outBuffer = await io.writeBinary(doc);
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, outBuffer);

  console.log(`[Repair] Successfully wrote repaired GLB to: ${outputPath} (${(outBuffer.byteLength / 1024 / 1024).toFixed(2)} MB)`);
  return {
    numVertices,
    mergedDuplicatesCount,
    truncatedInfluencesCount,
    fileSize: outBuffer.byteLength
  };
}

if (process.argv[1] && process.argv[1].endsWith('repair_v03_skinning.mjs')) {
  const input = path.resolve('assets/3d/monster/monster_anime_bs_v03.glb');
  const output = path.resolve('assets/3d/monster/monster_anime_bs_v03_repaired.glb');
  repairSkinning(input, output)
    .then(() => console.log('✅ Deterministic skinning repair complete!'))
    .catch((err) => {
      console.error('❌ Repair failed:', err);
      process.exit(1);
    });
}
