import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression } from '@gltf-transform/extensions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';

function computeHash(buffer, length = 16) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, length);
}

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

async function build() {
  console.log('🚀 Starting deterministic static build...');
  const startTime = Date.now();

  // 1. Determine Git Commit SHA
  let gitCommit = '3700930';
  try {
    gitCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch (e) {
    if (process.env.VERCEL_GIT_COMMIT_SHA) {
      gitCommit = process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7);
    }
  }
  console.log(`📌 Build Commit SHA: ${gitCommit}`);

  // 2. Prepare Directories
  const distDir = path.resolve('dist');
  const versionedDir = path.join(distDir, 'assets', 'versioned');
  const localVersionedDir = path.resolve('assets', 'versioned');

  if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
  fs.mkdirSync(versionedDir, { recursive: true });
  if (!fs.existsSync(localVersionedDir)) {
    fs.mkdirSync(localVersionedDir, { recursive: true });
  }

  // 3. Compile and Minify Tailwind CSS
  console.log('🎨 Compiling Tailwind CSS...');
  if (!fs.existsSync('src')) fs.mkdirSync('src', { recursive: true });
  const rawHtml = fs.readFileSync('index.html', 'utf8');
  const styleMatch = rawHtml.match(/<style>([\s\S]*?)<\/style>/);
  const customCss = styleMatch ? styleMatch[1].trim() : '';
  const inputCss = `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n${customCss}\n`;
  fs.writeFileSync('src/input.css', inputCss);

  const tempCssPath = path.join(distDir, 'temp_app.css');
  try {
    execSync(`npx tailwindcss -i src/input.css -o "${tempCssPath}" --minify`, { stdio: 'inherit' });
  } catch (err) {
    // Fallback if npx needs cmd.exe wrapper on Windows
    execSync(`cmd.exe /c "npx tailwindcss -i src/input.css -o \\"${tempCssPath}\\" --minify"`, { stdio: 'inherit' });
  }

  const cssBuffer = fs.readFileSync(tempCssPath);
  const cssHash = computeHash(cssBuffer);
  const cssFileName = `app.${cssHash}.css`;
  fs.writeFileSync(path.join(versionedDir, cssFileName), cssBuffer);
  fs.unlinkSync(tempCssPath);
  console.log(`✅ CSS compiled: assets/versioned/${cssFileName} (${(cssBuffer.length / 1024).toFixed(2)} KB)`);

  // 4. Compress & Hash 3D Character Model (Meshopt)
  console.log('🤖 Compressing 3D monster model...');
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;

  const glbInputPath = path.resolve('assets/3d/monster/monster_anime_bs_v02.glb');
  const io = new NodeIO()
    .registerExtensions([EXTMeshoptCompression])
    .registerDependencies({
      'meshopt.encoder': MeshoptEncoder,
      'meshopt.decoder': MeshoptDecoder
    });

  const doc = await io.read(glbInputPath);
  const ext = doc.createExtension(EXTMeshoptCompression);
  ext.setRequired(true);

  // Hash the EMITTED bytes per plan specification
  const emittedBytes = await io.writeBinary(doc);
  const glbHash = computeHash(emittedBytes);
  const glbFileName = `monster_anime_bs_v02.${glbHash}.opt.glb`;
  fs.writeFileSync(path.join(versionedDir, glbFileName), emittedBytes);
  // Also preserve locally in assets/versioned for local development parity
  fs.writeFileSync(path.join(localVersionedDir, glbFileName), emittedBytes);
  console.log(`✅ Model compressed: assets/versioned/${glbFileName} (${(emittedBytes.byteLength / 1024 / 1024).toFixed(2)} MB)`);

  // 5. Content-hash Versioned Production Assets
  console.log('📦 Content-hashing binary and texture assets...');

  // Target Marker (.mind)
  const mindBuf = fs.readFileSync('assets/monster_tshirt.mind');
  const mindHash = computeHash(mindBuf);
  const mindFileName = `monster_tshirt.${mindHash}.mind`;
  fs.writeFileSync(path.join(versionedDir, mindFileName), mindBuf);
  fs.writeFileSync(path.join(localVersionedDir, mindFileName), mindBuf);

  // Explosion Texture
  const expBuf = fs.readFileSync('assets/textures/explosion_01.png');
  const expHash = computeHash(expBuf);
  const expFileName = `explosion_01.${expHash}.png`;
  fs.writeFileSync(path.join(versionedDir, expFileName), expBuf);
  fs.writeFileSync(path.join(localVersionedDir, expFileName), expBuf);

  // Storm Texture
  const stormBuf = fs.readFileSync('assets/textures/storm_01.png');
  const stormHash = computeHash(stormBuf);
  const stormFileName = `storm_01.${stormHash}.png`;
  fs.writeFileSync(path.join(versionedDir, stormFileName), stormBuf);
  fs.writeFileSync(path.join(localVersionedDir, stormFileName), stormBuf);

  // Pose Landmarker Model
  const poseBuf = fs.readFileSync('assets/models/pose_landmarker_lite.task');
  const poseHash = computeHash(poseBuf);
  const poseFileName = `pose_landmarker_lite.${poseHash}.task`;
  fs.writeFileSync(path.join(versionedDir, poseFileName), poseBuf);
  fs.writeFileSync(path.join(localVersionedDir, poseFileName), poseBuf);

  // Hand Landmarker Model
  const handBuf = fs.readFileSync('assets/models/hand_landmarker.task');
  const handHash = computeHash(handBuf);
  const handFileName = `hand_landmarker.${handHash}.task`;
  fs.writeFileSync(path.join(versionedDir, handFileName), handBuf);
  fs.writeFileSync(path.join(localVersionedDir, handFileName), handBuf);

  // 6. Copy Root & Static Assets to dist
  console.log('📂 Copying static assets & worker...');
  fs.copyFileSync('tracking_worker.js', path.join(distDir, 'tracking_worker.js'));
  if (fs.existsSync('stitch')) copyDirRecursive('stitch', path.join(distDir, 'stitch'));

  // Copy assets subdirectories to dist/assets
  copyDirRecursive('assets/textures', path.join(distDir, 'assets', 'textures'));
  copyDirRecursive('assets/models', path.join(distDir, 'assets', 'models'));
  copyDirRecursive('assets/3d', path.join(distDir, 'assets', '3d'));
  if (fs.existsSync('assets/social.png')) fs.copyFileSync('assets/social.png', path.join(distDir, 'assets', 'social.png'));
  if (fs.existsSync('assets/monster_tshirt.mind')) fs.copyFileSync('assets/monster_tshirt.mind', path.join(distDir, 'assets', 'monster_tshirt.mind'));
  if (fs.existsSync('assets/target_refrence.png')) fs.copyFileSync('assets/target_refrence.png', path.join(distDir, 'assets', 'target_refrence.png'));
  if (fs.existsSync('favicon.ico')) fs.copyFileSync('favicon.ico', path.join(distDir, 'favicon.ico'));

  // 7. Generate Production HTML
  console.log('📄 Inlining configuration & generating dist/index.html...');
  let builtHtml = rawHtml;

  // Replace build commit meta tag
  builtHtml = builtHtml.replace(
    /<meta name="app-build" content="[^"]*"\s*\/?>/i,
    `<meta name="app-build" content="${gitCommit}" />`
  );

  // Replace Tailwind Play CDN and inline <style> block with compiled CSS link
  const tailwindCdnRegex = /<!-- Tailwind CSS Engine -->[\s\S]*?<script src="https:\/\/cdn\.tailwindcss\.com"><\/script>[\s\S]*?<script id="tailwind-config">[\s\S]*?<\/script>/i;
  builtHtml = builtHtml.replace(
    tailwindCdnRegex,
    `<!-- Compiled Production Tailwind CSS -->\n  <link rel="stylesheet" href="assets/versioned/${cssFileName}" />`
  );

  const inlineStyleRegex = /<style>[\s\S]*?<\/style>/i;
  builtHtml = builtHtml.replace(inlineStyleRegex, '');

  // Inject Asset Configuration Script right before </head>
  const assetConfigScript = `
  <!-- Production Content-Hashed Asset Map (Zero Manifest Roundtrip) -->
  <script>
    window.__ASSET_CONFIG__ = {
      build: "${gitCommit}",
      css: "assets/versioned/${cssFileName}",
      monsterModel: "assets/versioned/${glbFileName}",
      targetMarker: "assets/versioned/${mindFileName}",
      explosionTexture: "assets/versioned/${expFileName}",
      stormTexture: "assets/versioned/${stormFileName}",
      poseModel: "assets/versioned/${poseFileName}",
      handModel: "assets/versioned/${handFileName}"
    };
  </script>
`;
  builtHtml = builtHtml.replace('</head>', `${assetConfigScript}</head>`);

  fs.writeFileSync(path.join(distDir, 'index.html'), builtHtml, 'utf8');

  // 8. Generate Asset Inventory Manifest
  const manifest = {
    build: gitCommit,
    timestamp: new Date().toISOString(),
    assets: {
      css: `assets/versioned/${cssFileName}`,
      monsterModel: `assets/versioned/${glbFileName}`,
      targetMarker: `assets/versioned/${mindFileName}`,
      explosionTexture: `assets/versioned/${expFileName}`,
      stormTexture: `assets/versioned/${stormFileName}`,
      poseModel: `assets/versioned/${poseFileName}`,
      handModel: `assets/versioned/${handFileName}`
    },
    inventory: [
      { name: 'CSS Bundle', path: `assets/versioned/${cssFileName}`, size: cssBuffer.length, hash: cssHash },
      { name: 'Monster GLB', path: `assets/versioned/${glbFileName}`, size: emittedBytes.byteLength, hash: glbHash },
      { name: 'Target Mind', path: `assets/versioned/${mindFileName}`, size: mindBuf.length, hash: mindHash },
      { name: 'Explosion Texture', path: `assets/versioned/${expFileName}`, size: expBuf.length, hash: expHash },
      { name: 'Storm Texture', path: `assets/versioned/${stormFileName}`, size: stormBuf.length, hash: stormHash },
      { name: 'Pose Landmarker', path: `assets/versioned/${poseFileName}`, size: poseBuf.length, hash: poseHash },
      { name: 'Hand Landmarker', path: `assets/versioned/${handFileName}`, size: handBuf.length, hash: handHash }
    ]
  };

  const manifestJson = JSON.stringify(manifest, null, 2);
  fs.writeFileSync(path.join(distDir, 'manifest.json'), manifestJson);
  fs.writeFileSync(path.join(versionedDir, 'manifest.json'), manifestJson);
  fs.writeFileSync(path.join(localVersionedDir, 'manifest.json'), manifestJson);

  // Copy vercel.json into dist if needed
  fs.copyFileSync('vercel.json', path.join(distDir, 'vercel.json'));

  const durationMs = Date.now() - startTime;
  console.log(`\n✨ Static build complete in ${(durationMs / 1000).toFixed(2)}s!`);
  console.log('📦 Asset Inventory:');
  for (const item of manifest.inventory) {
    console.log(`  - [${item.name}] ${item.path} (${(item.size / 1024).toFixed(1)} KB, hash: ${item.hash})`);
  }
}

build().catch(err => {
  console.error('❌ Build failed:', err);
  process.exit(1);
});
