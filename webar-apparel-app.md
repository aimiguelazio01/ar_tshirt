# WebAR Apparel App — Technical & Product Specification

**Project:** NFC-Enabled WebAR Phygital Apparel Experience
**Type:** Web-based Augmented Reality Application (no native install required)

---

## 1. Overview

A browser-based AR app triggered by tapping an NFC tag embedded in a physical garment. The app opens instantly in the phone's default browser, activates the camera, locks a 3D digital experience onto the garment's printed artwork, and renders it in real time — with zero app downloads.

**Core promise:** Tap shirt → open browser → see AR magic on the fabric.

---

## 2. User Flow

1. **NFC Tap** — User taps phone against the tag sewn into the garment.
2. **Web Launch** — Phone opens a URL in Safari (iOS) or Chrome (Android); branded splash screen loads while 3D assets preload in the background.
3. **Camera Permission** — User taps "Start"; camera access requested via a direct user gesture (required by browser privacy rules).
4. **Lens Selection** — User optionally picks main vs. ultra-wide rear camera.
5. **Image Tracking** — App detects the printed artwork pattern on the garment and begins tracking its position, tilt, and movement.
6. **AR Playback** — 3D animation, particle effects, and spatial audio render locked to the artwork; tracking recovers gracefully if the artwork briefly leaves frame.

---

## 3. App Architecture

```
┌─────────────────────────────────────────────┐
│              Entry Point (URL)               │
│     NFC tag → NDEF record → HTTPS link        │
└───────────────────┬───────────────────────────┘
                     ▼
┌─────────────────────────────────────────────┐
│            Splash / Preload Screen            │
│   - Brand UI                                   │
│   - Asset preloading (glTF/GLB models,         │
│     textures, audio)                           │
└───────────────────┬───────────────────────────┘
                     ▼
┌─────────────────────────────────────────────┐
│         Permission & Camera Setup              │
│   - getUserMedia() on tap gesture              │
│   - Rear camera constraint selection           │
└───────────────────┬───────────────────────────┘
                     ▼
┌─────────────────────────────────────────────┐
│         Computer Vision Tracking Layer         │
│   - Image target recognition                  │
│   - Pose estimation (position/rotation)        │
│   - One-Euro filtering for jitter reduction    │
│   - Fabric-motion tolerant re-acquisition      │
└───────────────────┬───────────────────────────┘
                     ▼
┌─────────────────────────────────────────────┐
│              3D Rendering Layer                │
│   - WebGL scene (Three.js / Babylon.js)        │
│   - Animated models, particles, shaders        │
│   - Spatial audio (Web Audio API)              │
└─────────────────────────────────────────────┘
```

---

## 4. Recommended Tech Stack

| Layer | Technology Options |
|---|---|
| **AR Engine / Image Tracking** | MindAR, 8th Wall, Zappar WebAR SDK |
| **3D Rendering** | Three.js or Babylon.js (WebGL) |
| **Camera Access** | `getUserMedia()` (WebRTC), `facingMode: environment` |
| **Asset Format** | glTF/GLB (compressed with Draco/Meshopt) |
| **Audio** | Web Audio API (spatial/positional audio) |
| **NFC Trigger** | NDEF-formatted NTAG213/215/216 chip → static or dynamic URL |
| **Hosting** | CDN-backed static hosting (Vercel, Netlify, Cloudflare Pages) for fast first-load |
| **Analytics** | Privacy-respecting event tracking (tap → scan → engagement time) |

---

## 5. Key Technical Requirements

### 5.1 Performance
- Initial load under ~3 seconds on 4G/5G.
- 3D assets optimized and compressed (target <5MB total payload for first experience).
- Target 30–60 FPS tracking and render loop on mid-range mobile devices.

### 5.2 Image Tracking Robustness
- Must tolerate fabric deformation: wrinkles, folds, stretching, and movement.
- Adaptive filtering (e.g., One-Euro filter) to smooth jitter without introducing lag.
- Graceful re-acquisition when the tracked artwork leaves and re-enters frame.
- Must perform under varied lighting (daylight, indoor, low-light/neon).

### 5.3 Privacy & Permissions
- Camera/microphone access requested only after a direct user tap (no auto-prompt).
- All computer vision processing done on-device; no video frames uploaded to a server.
- Clear, brand-consistent permission-priming screen before the OS permission dialog.

### 5.4 Cross-Platform Compatibility
- iOS Safari and Android Chrome/Samsung Internet as primary targets.
- Fallback UI/message for unsupported browsers or devices lacking WebGL/WebRTC support.

### 5.5 Content Updatability
- AR content served dynamically from a CMS or asset server so brands can swap experiences (seasonal themes, drops, unlockables) without reissuing the physical garment.

---

## 6. Feature Set

- [ ] NFC tap → instant web launch (NDEF URL record)
- [ ] Branded preload/splash screen with progress indicator
- [ ] Camera permission flow (gesture-gated)
- [ ] Front/rear + wide-angle lens selector
- [ ] Real-time image tracking on printed garment artwork
- [ ] Jitter-smoothing motion filter for fabric movement
- [ ] 3D animated overlay (characters, logos, particle effects)
- [ ] Spatial/positional audio
- [ ] Tracking-loss recovery and re-lock
- [ ] Screenshot / video capture + social share
- [ ] Remote content management (swap AR content per campaign)
- [ ] Optional: loyalty point award / unlock code on successful scan

---

## 7. Use Cases

| Use Case | Description |
|---|---|
| Limited-edition streetwear drops | Unique AR art tied to individual garments; collectible and shareable |
| Concert & festival merch | Unlocks stage visuals, artist avatars, or song previews |
| Anti-counterfeit / authenticity | NFC verifies genuine product; AR acts as proof-of-authenticity layer |
| VIP loyalty & gamification | Tap-to-unlock rewards, secret drops, or point accrual |

---

## 8. Success Metrics

- **Tap-to-launch conversion rate** (NFC tap → page load)
- **Camera activation rate** (splash → permission granted)
- **Tracking lock time** (time to first stable AR lock)
- **Session duration** (time spent in AR experience)
- **Share rate** (screenshots/videos shared post-experience)

---

## 9. Open Questions / Next Steps

- Which WebAR SDK best balances tracking quality vs. licensing cost (MindAR is open-source; 8th Wall/Zappar are commercial with stronger fabric-tracking support)?
- What is the target device baseline (minimum OS/browser versions to support)?
- Will content be static per garment or personalized per user/session?
- What CMS or backend will manage dynamic AR content swaps?
