import * as THREE from 'three';

export const CLIP_DEFINITIONS = [
  { id: 'idle', name: 'idle', startFrame: 1, endFrame: 24, loop: 'repeat' },
  { id: 'reaction', name: 'reaction', startFrame: 25, endFrame: 72, loop: 'repeat' },
  { id: 'secondary', name: 'secondary', startFrame: 42, endFrame: 60, loop: 'repeat' },
  { id: 'recovery', name: 'recovery', startFrame: 61, endFrame: 85, loop: 'once' },
  { id: 'left_raise', name: 'left_raise', startFrame: 73, endFrame: 80, loop: 'clamp' },
  { id: 'left_lower', name: 'left_lower', startFrame: 81, endFrame: 116, loop: 'once' },
  { id: 'right_raise', name: 'right_raise', startFrame: 117, endFrame: 125, loop: 'clamp' },
  { id: 'right_lower', name: 'right_lower', startFrame: 126, endFrame: 160, loop: 'once' }
];

export const CLIP_DEFINITIONS_MAP = Object.fromEntries(
  CLIP_DEFINITIONS.map(def => [def.id, def])
);

/**
 * Validates that sourceClip covers [startFrame, endFrame] at fps within float tolerance.
 */
export function validateSourceClipCoverage(sourceClip, startFrame, endFrame, fps = 24, tolerance = 1e-6) {
  if (!sourceClip || !sourceClip.tracks || sourceClip.tracks.length === 0) {
    throw new Error('[ClipSampler] Source clip is empty or invalid');
  }
  const minRequiredTime = (startFrame - 1) / fps;
  const maxRequiredTime = (endFrame - 1) / fps;

  if (sourceClip.duration < maxRequiredTime - tolerance) {
    throw new Error(`[ClipSampler] Source clip duration (${sourceClip.duration}s) does not reach required endpoint ${maxRequiredTime}s (frame ${endFrame})`);
  }

  for (const track of sourceClip.tracks) {
    const times = track.times;
    if (!times || times.length === 0) continue;
    const trackStart = times[0];
    const trackEnd = times[times.length - 1];
    if (trackStart > minRequiredTime + tolerance) {
      throw new Error(`[ClipSampler] Track ${track.name} starts at ${trackStart}s, after required start ${minRequiredTime}s`);
    }
    if (trackEnd < maxRequiredTime - tolerance) {
      throw new Error(`[ClipSampler] Track ${track.name} ends at ${trackEnd}s, before required end ${maxRequiredTime}s`);
    }
  }
  return true;
}

/**
 * Evaluates track interpolant at exact source time for frame f.
 */
export function sampleTrackAtSourceFrame(track, frame, fps = 24) {
  const sourceTime = (frame - 1) / fps;
  const interpolant = track.createInterpolant();
  return interpolant.evaluate(sourceTime);
}

/**
 * Creates a sampled AnimationClip from sourceClip for inclusive frames [startFrame, endFrame].
 */
export function createSampledAnimationClip(sourceClip, { name, startFrame, endFrame, fps = 24, Three = THREE }) {
  if (startFrame < 1) {
    throw new Error(`[ClipSampler] startFrame (${startFrame}) must be >= 1 (frame 1 = time 0, excluding negative preroll)`);
  }
  if (endFrame < startFrame) {
    throw new Error(`[ClipSampler] endFrame (${endFrame}) must be >= startFrame (${startFrame})`);
  }

  validateSourceClipCoverage(sourceClip, startFrame, endFrame, fps);

  const numFrames = endFrame - startFrame + 1;
  const duration = (endFrame - startFrame) / fps;
  const sampledTracks = [];

  for (const origTrack of sourceClip.tracks) {
    const TrackConstructor = origTrack.constructor;
    const valueSize = origTrack.getValueSize();
    const interpolant = origTrack.createInterpolant();

    const times = new Float32Array(numFrames);
    const values = new Float32Array(numFrames * valueSize);

    for (let fIdx = 0; fIdx < numFrames; fIdx++) {
      const frame = startFrame + fIdx;
      const sourceTime = (frame - 1) / fps;
      const localTime = fIdx / fps;
      times[fIdx] = localTime;

      const sample = interpolant.evaluate(sourceTime);
      for (let v = 0; v < valueSize; v++) {
        values[fIdx * valueSize + v] = sample[v];
      }
    }

    const interpType = typeof origTrack.getInterpolation === 'function' ? origTrack.getInterpolation() : undefined;
    const newTrack = new TrackConstructor(origTrack.name, times, values, interpType);
    sampledTracks.push(newTrack);
  }

  const AnimationClipClass = (Three && Three.AnimationClip) || THREE.AnimationClip;
  const newClip = new AnimationClipClass(name, duration, sampledTracks);
  newClip.userData = {
    startFrame,
    endFrame,
    fps,
    frameCount: numFrames
  };
  return newClip;
}

/**
 * Generates all canonical sampled clips from the master animation clip.
 */
export function createAllSampledClips(sourceClip, fps = 24, Three = THREE) {
  const clips = new Map();
  for (const def of CLIP_DEFINITIONS) {
    const sampledClip = createSampledAnimationClip(sourceClip, {
      name: def.id,
      startFrame: def.startFrame,
      endFrame: def.endFrame,
      fps,
      Three
    });
    clips.set(def.id, sampledClip);
  }
  return clips;
}
