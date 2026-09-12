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

    const [pose, hand] = await Promise.all([
      PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
          delegate: 'GPU'
        },
        runningMode: 'IMAGE',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5
      }).catch(err => {
        console.warn('[Worker] GPU delegate failed for pose, falling back to CPU:', err);
        return PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
            delegate: 'CPU'
          },
          runningMode: 'IMAGE',
          numPoses: 1
        });
      }),
      HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
          delegate: 'GPU'
        },
        runningMode: 'IMAGE',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5
      }).catch(err => {
        console.warn('[Worker] GPU delegate failed for hands, falling back to CPU:', err);
        return HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
            delegate: 'CPU'
          },
          runningMode: 'IMAGE',
          numHands: 2
        });
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
  const { type, bitmap, timestamp, disablePose, disableHands } = e.data;

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

    try {
      if (!disablePose && poseLandmarker) {
        const t0 = performance.now();
        const res = poseLandmarker.detect(bitmap);
        duration.pose = performance.now() - t0;
        if (res && res.landmarks && res.landmarks.length > 0) {
          poseResult = {
            landmarks: res.landmarks.map(list => list.map(pt => ({ x: pt.x, y: pt.y, z: pt.z })))
          };
        }
      }

      if (!disableHands && handLandmarker) {
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
      pose: poseResult,
      hands: handResult,
      duration
    });
  }
};
