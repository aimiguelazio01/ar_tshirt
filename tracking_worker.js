/* =====================================================================
   TAPWEAR WebAR — Off-Thread Gesture Tracking Worker
   Runs MediaPipe PoseLandmarker & HandLandmarker in VIDEO runningMode.
   ===================================================================== */

import { FilesetResolver, PoseLandmarker, HandLandmarker } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';

let poseLandmarker = null;
let handLandmarker = null;
let currentWorkerId = null;
let isInitializing = false;
let isReady = false;
let lastTimestampMs = 0;

async function createLandmarker(type, vision, url, delegate) {
  if (type === 'pose') {
    return PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: url, delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5
    });
  } else {
    return HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: url, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5
    });
  }
}

async function initTask(type, vision, localUrl, remoteUrl, requestedDelegate = 'auto') {
  if (requestedDelegate === 'cpu') {
    try {
      return await createLandmarker(type, vision, localUrl, 'CPU');
    } catch (err) {
      console.warn(`[Worker] Local CPU failed for ${type}, trying remote CPU:`, err);
      return await createLandmarker(type, vision, remoteUrl, 'CPU');
    }
  }
  try {
    return await createLandmarker(type, vision, localUrl, 'GPU');
  } catch (err1) {
    if (requestedDelegate === 'gpu') {
      console.warn(`[Worker] Forced GPU failed for ${type}:`, err1);
      throw err1;
    }
    console.warn(`[Worker] GPU delegate failed for ${type}, falling back to CPU:`, err1);
    try {
      return await createLandmarker(type, vision, localUrl, 'CPU');
    } catch (err2) {
      console.warn(`[Worker] Local CPU failed for ${type}, trying remote GPU:`, err2);
      try {
        return await createLandmarker(type, vision, remoteUrl, 'GPU');
      } catch (err3) {
        console.warn(`[Worker] Remote GPU failed for ${type}, falling back to remote CPU:`, err3);
        return await createLandmarker(type, vision, remoteUrl, 'CPU');
      }
    }
  }
}

async function initVision(workerId, assets = {}, enabledTasks = ['pose', 'hand'], delegate = 'auto') {
  if (isReady) {
    self.postMessage({ type: 'ready', workerId });
    return;
  }
  if (isInitializing) return;
  isInitializing = true;
  currentWorkerId = workerId;

  try {
    const vision = await FilesetResolver.forVisionTasks(
      assets.wasmUrl || 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
    );

    if (!isInitializing || currentWorkerId !== workerId) {
      disposeLandmarkers();
      return;
    }

    const localPoseUrl = assets.poseModelUrl || new URL('assets/models/pose_landmarker_lite.task', self.location.href).href;
    const remotePoseUrl = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
    const localHandUrl = assets.handModelUrl || new URL('assets/models/hand_landmarker.task', self.location.href).href;
    const remoteHandUrl = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

    // Sequential initialization to reduce peak memory usage
    if (enabledTasks.includes('pose') && !poseLandmarker) {
      poseLandmarker = await initTask('pose', vision, localPoseUrl, remotePoseUrl, delegate);
      if (!isInitializing || currentWorkerId !== workerId) {
        disposeLandmarkers();
        return;
      }
    }
    if (enabledTasks.includes('hand') && !handLandmarker) {
      handLandmarker = await initTask('hand', vision, localHandUrl, remoteHandUrl, delegate);
      if (!isInitializing || currentWorkerId !== workerId) {
        disposeLandmarkers();
        return;
      }
    }

    isReady = true;
    isInitializing = false;
    self.postMessage({ type: 'ready', workerId });
  } catch (err) {
    isInitializing = false;
    isReady = false;
    disposeLandmarkers();
    self.postMessage({
      type: 'error',
      workerId,
      stage: 'init',
      message: err.message || String(err)
    });
  }
}

function disposeLandmarkers() {
  isInitializing = false;
  isReady = false;
  if (poseLandmarker) {
    try { poseLandmarker.close(); } catch (e) {}
    poseLandmarker = null;
  }
  if (handLandmarker) {
    try { handLandmarker.close(); } catch (e) {}
    handLandmarker = null;
  }
}

self.onmessage = async (e) => {
  const data = e.data;
  if (!data) return;

  const { type, workerId, sessionId, frameId, task, capturedAt, bitmap, assets, enabledTasks, delegate } = data;

  if (type === 'init') {
    initVision(workerId || 'default', assets, enabledTasks, delegate || 'auto');
    return;
  }

  if (type === 'dispose') {
    disposeLandmarkers();
    self.postMessage({ type: 'disposed', workerId });
    return;
  }

  // Handle both standard 'frame' and legacy 'detect' messages
  if (type === 'frame' || type === 'detect') {
    if (!isReady) {
      // Early frames return busy; do not auto-initialize with unversioned defaults
      if (bitmap && typeof bitmap.close === 'function') bitmap.close();
      self.postMessage({
        type: 'busy',
        workerId,
        sessionId,
        frameId,
        capturedAt: capturedAt || performance.now()
      });
      return;
    }

    // Ensure timestampMs is strictly increasing as required by MediaPipe VIDEO mode
    let targetTimestampMs = data.timestampMs || data.timestamp || performance.now();
    if (targetTimestampMs <= lastTimestampMs) {
      targetTimestampMs = lastTimestampMs + 1;
    }
    lastTimestampMs = targetTimestampMs;

    const requestedTask = task || (data.disablePose ? 'hand' : (data.disableHands ? 'pose' : 'pose'));
    let durationMs = 0;
    let landmarks = null;
    let handednesses = null;

    try {
      const t0 = performance.now();
      if (requestedTask === 'pose' && poseLandmarker) {
        const res = poseLandmarker.detectForVideo(bitmap, targetTimestampMs);
        durationMs = performance.now() - t0;
        if (res && res.landmarks && res.landmarks.length > 0) {
          landmarks = res.landmarks.map(list => list.map(pt => ({ x: pt.x, y: pt.y, z: pt.z })));
        }
      } else if (requestedTask === 'hand' && handLandmarker) {
        const res = handLandmarker.detectForVideo(bitmap, targetTimestampMs);
        durationMs = performance.now() - t0;
        if (res && res.landmarks && res.landmarks.length > 0) {
          landmarks = res.landmarks.map(list => list.map(pt => ({ x: pt.x, y: pt.y, z: pt.z })));
          handednesses = res.handednesses || [];
        }
      }
    } catch (err) {
      console.warn(`[Worker] Inference error on ${requestedTask}:`, err);
      self.postMessage({
        type: 'error',
        workerId,
        sessionId,
        frameId,
        stage: 'inference',
        message: err.message || String(err)
      });
    } finally {
      if (bitmap && typeof bitmap.close === 'function') {
        try { bitmap.close(); } catch (e) {}
      }
    }

    self.postMessage({
      type: 'result',
      workerId: workerId || currentWorkerId,
      sessionId,
      frameId,
      task: requestedTask,
      capturedAt: capturedAt || performance.now(),
      durationMs: Number(durationMs.toFixed(1)),
      landmarks,
      handednesses
    });
  }
};
