import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression } from '@gltf-transform/extensions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';

async function main() {
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;

  const inputPath = path.resolve('assets/3d/monster/monster_anime_bs_v02.glb');
  const outputDir = path.resolve('assets/versioned');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const rawBuffer = fs.readFileSync(inputPath);
  const hash = crypto.createHash('sha256').update(rawBuffer).digest('hex').slice(0, 8);
  const outputPath = path.join(outputDir, `monster_anime_bs_v02.${hash}.opt.glb`);
  const staticAliasPath = path.join(outputDir, 'monster_anime_bs_v02.opt.glb');

  console.log(`Reading input: ${inputPath} (${(rawBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

  const io = new NodeIO()
    .registerExtensions([EXTMeshoptCompression])
    .registerDependencies({
      'meshopt.encoder': MeshoptEncoder,
      'meshopt.decoder': MeshoptDecoder
    });

  const doc = await io.read(inputPath);
  const ext = doc.createExtension(EXTMeshoptCompression);
  ext.setRequired(true);

  const compressedBuffer = await io.writeBinary(doc);
  fs.writeFileSync(outputPath, compressedBuffer);
  fs.writeFileSync(staticAliasPath, compressedBuffer);

  const compSize = compressedBuffer.byteLength;
  console.log(`Wrote compressed GLB to:`);
  console.log(` - ${outputPath} (${(compSize / 1024 / 1024).toFixed(2)} MB)`);
  console.log(` - ${staticAliasPath}`);
  console.log(`Reduction: -${(((rawBuffer.length - compSize) / rawBuffer.length) * 100).toFixed(1)}%`);

  // Write/update asset manifest
  const manifestPath = path.join(outputDir, 'manifest.json');
  const manifest = {
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    assets: {
      monsterModel: `assets/versioned/monster_anime_bs_v02.${hash}.opt.glb`,
      monsterModelAlias: 'assets/versioned/monster_anime_bs_v02.opt.glb',
      targetMarker: 'assets/monster_tshirt.mind',
      explosionTexture: 'assets/textures/explosion_01.png',
      stormTexture: 'assets/textures/storm_01.png',
      poseModel: 'assets/models/pose_landmarker_lite.task',
      handModel: 'assets/models/hand_landmarker.task'
    }
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Asset manifest written to: ${manifestPath}`);
}

main().catch(err => {
  console.error('Compression failed:', err);
  process.exit(1);
});
