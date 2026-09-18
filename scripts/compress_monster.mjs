import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression } from '@gltf-transform/extensions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';

function computeHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

async function main() {
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;

  const inputPath = path.resolve('assets/3d/monster/monster_anime_bs_v03.glb');
  const outputDir = path.resolve('assets/versioned');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const rawBuffer = fs.readFileSync(inputPath);
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

  // Hash the EMITTED bytes strictly per specification (16-char sha256)
  const compressedBuffer = await io.writeBinary(doc);
  const hash = computeHash(compressedBuffer);
  const outputPath = path.join(outputDir, `monster_anime_bs_v03.${hash}.opt.glb`);

  fs.writeFileSync(outputPath, compressedBuffer);

  const compSize = compressedBuffer.byteLength;
  console.log(`Wrote compressed GLB to:`);
  console.log(` - ${outputPath} (${(compSize / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`Reduction: -${(((rawBuffer.length - compSize) / rawBuffer.length) * 100).toFixed(1)}%`);
}

main().catch(err => {
  console.error('Compression failed:', err);
  process.exit(1);
});
