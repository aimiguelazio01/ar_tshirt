/**
 * Task frame scheduler and worker result validator.
 * Enforces one capture/inference in flight, fair task interleaving,
 * quality-driven rates, and rejection of stale or mismatched inferences.
 */
export function createTrackingScheduler() {
  let pendingFrame = null;
  let isCapturingFrame = false;
  let lastPoseTime = 0;
  let lastHandTime = 0;
  let lastTaskDispatched = null;
  let nextFrameId = 0;

  return {
    getPendingFrame() {
      return pendingFrame;
    },
    isBusy() {
      return pendingFrame !== null || isCapturingFrame;
    },
    setCapturing(val) {
      isCapturingFrame = !!val;
    },
    determineNextTask({ now, policy, isPoseEnabled = true, isHandEnabled = true }) {
      const poseHz = (policy && policy.poseCeilingHz) || 10;
      const handHz = (policy && policy.handCeilingHz) || 15;
      const poseInterval = Math.round(1000 / poseHz);
      const handInterval = Math.round(1000 / handHz);

      const isPoseDue = isPoseEnabled && (now - lastPoseTime >= poseInterval);
      const isHandDue = isHandEnabled && (now - lastHandTime >= handInterval);

      if (!isPoseDue && !isHandDue) return null;

      let chosenTask = 'pose';
      if (isPoseDue && isHandDue) {
        chosenTask = lastTaskDispatched === 'pose' ? 'hand' : 'pose';
      } else if (isHandDue) {
        chosenTask = 'hand';
      } else {
        chosenTask = 'pose';
      }
      return chosenTask;
    },
    dispatchFrame({ chosenTask, now, currentWorkerId, currentSessionId }) {
      const frameId = ++nextFrameId;
      lastTaskDispatched = chosenTask;
      if (chosenTask === 'pose') lastPoseTime = now;
      if (chosenTask === 'hand') lastHandTime = now;
      pendingFrame = {
        id: frameId,
        capturedAt: now,
        task: chosenTask,
        workerId: currentWorkerId,
        sessionId: currentSessionId
      };
      isCapturingFrame = false;
      return pendingFrame;
    },
    acceptResult({ data, now, currentWorkerId, currentSessionId, maxStaleMs = 350 }) {
      const matches =
        Boolean(data) &&
        data.workerId === currentWorkerId &&
        data.sessionId === currentSessionId &&
        Boolean(pendingFrame) &&
        data.frameId === pendingFrame.id;

      if (!matches) {
        return { accepted: false, reason: 'mismatch' };
      }

      pendingFrame = null;

      if (now - data.capturedAt > maxStaleMs) {
        return { accepted: false, reason: 'stale-age' };
      }

      return { accepted: true };
    },
    reset() {
      pendingFrame = null;
      isCapturingFrame = false;
      lastTaskDispatched = null;
    }
  };
}
