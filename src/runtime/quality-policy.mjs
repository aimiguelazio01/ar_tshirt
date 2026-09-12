/**
 * Adaptive hardware policy and buffer calculation.
 * Implements hysteresis thresholds for mobile performance throttling.
 */
export function createQualityPolicy({ isMobile = false, forcedProfile = null } = {}) {
  let profile = forcedProfile || (isMobile ? 'balanced' : 'desktop');
  let consecutiveHighWindows = 0;
  let consecutiveLowWindows = 0;

  function getPolicy() {
    if (!isMobile && !forcedProfile) {
      return {
        maxPixelRatio: 2.0,
        maxBufferPixels: 2073600,
        ambientParticles: 160,
        sparksPerEffect: 20,
        particleMultiplier: 1.0,
        enableSecondaryLights: true,
        temporaryEffectLights: true,
        enableVfxBursts: true,
        poseCeilingHz: 15,
        handCeilingHz: 20,
        trackingFrameMaxEdge: 720,
        profile: 'desktop'
      };
    }
    if (profile === 'reduced') {
      return {
        maxPixelRatio: 0.75,
        maxBufferPixels: 650000,
        ambientParticles: 30,
        sparksPerEffect: 6,
        particleMultiplier: 0.5,
        enableSecondaryLights: false,
        temporaryEffectLights: false,
        enableVfxBursts: true,
        poseCeilingHz: 6,
        handCeilingHz: 10,
        trackingFrameMaxEdge: 480,
        profile: 'reduced'
      };
    }
    return {
      maxPixelRatio: 1.0,
      maxBufferPixels: 1000000,
      ambientParticles: 80,
      sparksPerEffect: 12,
      particleMultiplier: 1.0,
      enableSecondaryLights: true,
      temporaryEffectLights: true,
      enableVfxBursts: true,
      poseCeilingHz: 10,
      handCeilingHz: 15,
      trackingFrameMaxEdge: 640,
      profile: 'balanced'
    };
  }

  function recordWindow({ p90 }) {
    if (forcedProfile || !isMobile) return null;
    if (p90 > 40) {
      consecutiveHighWindows++;
      consecutiveLowWindows = 0;
      if (consecutiveHighWindows >= 3 && profile !== 'reduced') {
        profile = 'reduced';
        consecutiveHighWindows = 0;
        return 'reduced';
      }
    } else if (p90 < 30) {
      consecutiveLowWindows++;
      consecutiveHighWindows = 0;
      if (consecutiveLowWindows >= 5 && profile !== 'balanced') {
        profile = 'balanced';
        consecutiveLowWindows = 0;
        return 'balanced';
      }
    } else {
      consecutiveHighWindows = 0;
      consecutiveLowWindows = 0;
    }
    return null;
  }

  function computeBufferRatio(width, height, dpr = 1.0) {
    const policy = getPolicy();
    return Math.min(
      dpr,
      policy.maxPixelRatio,
      Math.sqrt(policy.maxBufferPixels / (width * height))
    );
  }

  return {
    get profile() { return profile; },
    get forcedProfile() { return forcedProfile; },
    get consecutiveHighWindows() { return consecutiveHighWindows; },
    get consecutiveLowWindows() { return consecutiveLowWindows; },
    getPolicy,
    recordWindow,
    computeBufferRatio,
    setProfile(p) { profile = p; }
  };
}
