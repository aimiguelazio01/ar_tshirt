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

  // 1. Determine Git / Vercel Commit SHA
  let gitCommit = null;
  if (process.env.VERCEL_GIT_COMMIT_SHA) {
    gitCommit = process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7);
  } else {
    try {
      gitCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    } catch (e) {
      gitCommit = 'unknown-local';
    }
  }
  console.log(`📌 Build Commit SHA: ${gitCommit}`);

  // 2. Safely Resolve and Clean Output Directory (Strictly inside project root)
  const repoRoot = path.resolve('.');
  const distDir = path.resolve(repoRoot, 'dist');
  if (!distDir.startsWith(repoRoot) || distDir === repoRoot) {
    throw new Error(`Unsafe dist directory target: ${distDir}`);
  }

  if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true, force: true });
  }

  const versionedDir = path.join(distDir, 'assets', 'versioned');
  fs.mkdirSync(versionedDir, { recursive: true });

  // 3. Compile Tailwind CSS from tracked src/input.css into dist
  console.log('🎨 Compiling Tailwind CSS...');
  const tempBuildDir = path.join(distDir, '.build_temp');
  fs.mkdirSync(tempBuildDir, { recursive: true });
  const tempCssPath = path.join(tempBuildDir, 'app.compiled.css');

  try {
    execSync(`npx tailwindcss -i src/input.css -o "${tempCssPath}" --minify`, { stdio: 'inherit' });
  } catch (err) {
    execSync(`cmd.exe /c "npx tailwindcss -i src/input.css -o \\"${tempCssPath}\\" --minify"`, { stdio: 'inherit' });
  }

  const cssBuffer = fs.readFileSync(tempCssPath);
  const cssHash = computeHash(cssBuffer);
  const cssFileName = `app.${cssHash}.css`;
  fs.writeFileSync(path.join(versionedDir, cssFileName), cssBuffer);
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

  // Hash the EMITTED bytes strictly per specification
  const emittedBytes = await io.writeBinary(doc);
  const glbHash = computeHash(emittedBytes);
  const glbFileName = `monster_anime_bs_v02.${glbHash}.opt.glb`;
  fs.writeFileSync(path.join(versionedDir, glbFileName), emittedBytes);
  console.log(`✅ Model compressed: assets/versioned/${glbFileName} (${(emittedBytes.byteLength / 1024 / 1024).toFixed(2)} MB)`);

  // 5. Content-hash Versioned Production Assets into dist ONLY
  console.log('📦 Content-hashing binary and texture assets...');

  // Target Marker (.mind)
  const mindBuf = fs.readFileSync('assets/monster_tshirt.mind');
  const mindHash = computeHash(mindBuf);
  const mindFileName = `monster_tshirt.${mindHash}.mind`;
  fs.writeFileSync(path.join(versionedDir, mindFileName), mindBuf);

  // Explosion Texture
  const expBuf = fs.readFileSync('assets/textures/explosion_01.png');
  const expHash = computeHash(expBuf);
  const expFileName = `explosion_01.${expHash}.png`;
  fs.writeFileSync(path.join(versionedDir, expFileName), expBuf);

  // Storm Texture
  const stormBuf = fs.readFileSync('assets/textures/storm_01.png');
  const stormHash = computeHash(stormBuf);
  const stormFileName = `storm_01.${stormHash}.png`;
  fs.writeFileSync(path.join(versionedDir, stormFileName), stormBuf);

  // Pose Landmarker Model
  const poseBuf = fs.readFileSync('assets/models/pose_landmarker_lite.task');
  const poseHash = computeHash(poseBuf);
  const poseFileName = `pose_landmarker_lite.${poseHash}.task`;
  fs.writeFileSync(path.join(versionedDir, poseFileName), poseBuf);

  // Hand Landmarker Model
  const handBuf = fs.readFileSync('assets/models/hand_landmarker.task');
  const handHash = computeHash(handBuf);
  const handFileName = `hand_landmarker.${handHash}.task`;
  fs.writeFileSync(path.join(versionedDir, handFileName), handBuf);

  // 6. Copy Root & Static Runtime Assets into dist
  console.log('📂 Copying static runtime assets, studio logos & compiler...');
  fs.copyFileSync('tracking_worker.js', path.join(distDir, 'tracking_worker.js'));
  if (fs.existsSync('compiler.html')) fs.copyFileSync('compiler.html', path.join(distDir, 'compiler.html'));
  if (fs.existsSync('cam_test.html')) fs.copyFileSync('cam_test.html', path.join(distDir, 'cam_test.html'));
  if (fs.existsSync('favicon.ico')) fs.copyFileSync('favicon.ico', path.join(distDir, 'favicon.ico'));

  // Copy textures (software logos, centered VFX sprites)
  copyDirRecursive('assets/textures', path.join(distDir, 'assets', 'textures'));
  // Copy fallback models & 3D character assets
  copyDirRecursive('assets/models', path.join(distDir, 'assets', 'models'));
  copyDirRecursive('assets/3d', path.join(distDir, 'assets', '3d'));

  // Copy root-referenced artwork & studio branding
  if (fs.existsSync('assets/monster_tshirt.jpg')) fs.copyFileSync('assets/monster_tshirt.jpg', path.join(distDir, 'assets', 'monster_tshirt.jpg'));
  if (fs.existsSync('assets/MVstudio_logo_text.png')) fs.copyFileSync('assets/MVstudio_logo_text.png', path.join(distDir, 'assets', 'MVstudio_logo_text.png'));
  if (fs.existsSync('assets/monster_tshirt.mind')) fs.copyFileSync('assets/monster_tshirt.mind', path.join(distDir, 'assets', 'monster_tshirt.mind'));
  if (fs.existsSync('assets/social.png')) fs.copyFileSync('assets/social.png', path.join(distDir, 'assets', 'social.png'));
  if (fs.existsSync('assets/target_refrence.png')) fs.copyFileSync('assets/target_refrence.png', path.join(distDir, 'assets', 'target_refrence.png'));
  if (fs.existsSync('stitch')) copyDirRecursive('stitch', path.join(distDir, 'stitch'));

  // Copy runtime helper modules if existing
  if (fs.existsSync('src/runtime')) {
    copyDirRecursive('src/runtime', path.join(distDir, 'src', 'runtime'));
  }

  // 7. Generate Production HTML with preloads and inlined asset configuration
  console.log('📄 Injecting high-priority preloads & generating dist/index.html...');
  const rawHtml = fs.readFileSync('index.html', 'utf8');
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

  // High-priority Preload tags for 3D model and marker ahead of application modules
  const highPriorityPreloads = `
  <!-- High-Priority Preloads: Stream essential 3D character and target marker before module execution -->
  <link rel="preload" as="fetch" crossorigin="anonymous" href="assets/versioned/${glbFileName}" fetchpriority="high">
  <link rel="preload" as="fetch" crossorigin="anonymous" href="assets/versioned/${mindFileName}">
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
  if (builtHtml.includes('<script type="importmap">')) {
    builtHtml = builtHtml.replace('<script type="importmap">', `${highPriorityPreloads}  <script type="importmap">`);
  } else {
    builtHtml = builtHtml.replace('</head>', `${highPriorityPreloads}</head>`);
  }

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
      handModel: `assets/versioned/${handFileName}`,
      studioLogo: 'assets/MVstudio_logo_text.png',
      targetArtwork: 'assets/monster_tshirt.jpg',
      compiler: 'compiler.html'
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

  // Clean up temporary build directory
  fs.rmSync(tempBuildDir, { recursive: true, force: true });

  // Copy vercel.json into dist
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
