/* =====================================================================
   TAPWEAR WebAR — Off-Thread Gesture Tracking Worker
   Runs MediaPipe PoseLandmarker & HandLandmarker off the main thread.
   ===================================================================== */

import { FilesetResolver, PoseLandmarker, HandLandmarker } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';

let poseLandmarker = null;
let handLandmarker = null;
let isInitializing = false;
let isReady = false;

async function initVision() {
  if (isReady || isInitializing) return;
  isInitializing = true;
  try {
    const vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
    );

    const localPoseUrl = new URL('assets/models/pose_landmarker_lite.task', self.location.href).href;
    const remotePoseUrl = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
    const localHandUrl = new URL('assets/models/hand_landmarker.task', self.location.href).href;
    const remoteHandUrl = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

    async function createPose(url, delegate) {
      return PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: url, delegate },
        runningMode: 'IMAGE',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5
      });
    }

    async function createHand(url, delegate) {
      return HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: url, delegate },
        runningMode: 'IMAGE',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5
      });
    }

    const [pose, hand] = await Promise.all([
      createPose(localPoseUrl, 'GPU')
        .catch(() => createPose(localPoseUrl, 'CPU'))
        .catch(() => createPose(remotePoseUrl, 'GPU'))
        .catch(err => {
          console.warn('[Worker] GPU/local delegate failed for pose, falling back to CPU remote:', err);
          return createPose(remotePoseUrl, 'CPU');
        }),
      createHand(localHandUrl, 'GPU')
        .catch(() => createHand(localHandUrl, 'CPU'))
        .catch(() => createHand(remoteHandUrl, 'GPU'))
        .catch(err => {
          console.warn('[Worker] GPU/local delegate failed for hands, falling back to CPU remote:', err);
          return createHand(remoteHandUrl, 'CPU');
        })
    ]);

    poseLandmarker = pose;
    handLandmarker = hand;
    isReady = true;
    isInitializing = false;
    self.postMessage({ type: 'ready' });
  } catch (err) {
    isInitializing = false;
    self.postMessage({ type: 'error', error: err.message || String(err) });
  }
}

self.onmessage = async (e) => {
  const { type, bitmap, timestamp, disablePose, disableHands, task } = e.data;

  if (type === 'init') {
    initVision();
    return;
  }

  if (type === 'detect') {
    if (!isReady) {
      if (!isInitializing) initVision();
      if (bitmap && typeof bitmap.close === 'function') bitmap.close();
      self.postMessage({ type: 'busy', timestamp });
      return;
    }

    const duration = { pose: 0, hand: 0 };
    let poseResult = null;
    let handResult = null;
    const requestedTask = task || 'both';

    try {
      const shouldRunPose = (requestedTask === 'both' || requestedTask === 'pose') && !disablePose && poseLandmarker;
      const shouldRunHand = (requestedTask === 'both' || requestedTask === 'hand') && !disableHands && handLandmarker;

      if (shouldRunPose) {
        const t0 = performance.now();
        const res = poseLandmarker.detect(bitmap);
        duration.pose = performance.now() - t0;
        if (res && res.landmarks && res.landmarks.length > 0) {
          poseResult = {
            landmarks: res.landmarks.map(list => list.map(pt => ({ x: pt.x, y: pt.y, z: pt.z })))
          };
        }
      }

      if (shouldRunHand) {
        const t0 = performance.now();
        const res = handLandmarker.detect(bitmap);
        duration.hand = performance.now() - t0;
        if (res && res.landmarks && res.landmarks.length > 0) {
          handResult = {
            landmarks: res.landmarks.map(list => list.map(pt => ({ x: pt.x, y: pt.y, z: pt.z }))),
            handednesses: res.handednesses || []
          };
        }
      }
    } catch (err) {
      console.warn('[Worker] Inference error:', err);
    } finally {
      if (bitmap && typeof bitmap.close === 'function') {
        bitmap.close();
      }
    }

    self.postMessage({
      type: 'result',
      timestamp,
      task: requestedTask,
      pose: poseResult,
      hands: handResult,
      duration
    });
  }
};
