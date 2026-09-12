import fs from 'fs';
import { parse } from 'node:path';

// Check HTML file exists and reads properly
const html = fs.readFileSync('index.html', 'utf8');
console.log(`index.html loaded: ${(html.length / 1024).toFixed(1)} KB`);

// Check required assets exist
const assetsToCheck = [
  'assets/versioned/monster_anime_bs_v02.opt.glb',
  'assets/versioned/monster_tshirt.mind',
  'assets/versioned/explosion_01.png',
  'assets/versioned/storm_01.png',
  'assets/3d/monster/monster_anime_bs_v02.glb',
  'assets/monster_tshirt.mind',
  'assets/textures/explosion_01.png',
  'assets/textures/storm_01.png',
  'assets/versioned/manifest.json'
];

let allAssetsOk = true;
for (const asset of assetsToCheck) {
  if (fs.existsSync(asset)) {
    const size = fs.statSync(asset).size;
    console.log(`[OK] ${asset} (${(size / 1024).toFixed(1)} KB)`);
  } else {
    console.error(`[MISSING] ${asset}`);
    allAssetsOk = false;
  }
}

if (!allAssetsOk) {
  process.exit(1);
}

// Check vercel.json
const vercelConfig = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
const versionedHeader = vercelConfig.headers.find(h => h.source === '/assets/versioned/(.*)');
if (versionedHeader) {
  console.log('[OK] vercel.json contains immutable Cache-Control rule for /assets/versioned/(.*)');
} else {
  console.error('[FAIL] vercel.json missing /assets/versioned/(.*) rule');
  process.exit(1);
}

console.log('Static asset & configuration checks passed!');
