import { createAnimationTime } from './animation-time.mjs';

/**
 * Creates and transitions active WebAR/Simulator sessions with authoritative mode,
 * session abort signals, and cleanup lifecycle.
 */
export function createSessionManager() {
  let nextSessionId = 0;
  let activeSession = null;
  let currentCameraAttemptId = 0;

  return {
    getActiveSession() {
      return activeSession;
    },
    createSession(mode) {
      if (activeSession && !activeSession.abort?.signal?.aborted) {
        try { activeSession.abort.abort(); } catch (e) {}
        activeSession.cleanups?.forEach(fn => {
          try { fn(); } catch (e) {}
        });
        activeSession.cleanups?.clear();
      }

      const session = {
        id: ++nextSessionId,
        mode,
        startedAt: (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(),
        firstCharacterVisible: false,
        optionalFeaturesStarted: false,
        abort: new AbortController(),
        cleanups: new Set(),
        animationTime: createAnimationTime()
      };

      activeSession = session;
      return session;
    },
    isCurrent(session) {
      return activeSession === session && session !== null && !session.abort?.signal?.aborted;
    },
    createCameraAttempt() {
      return ++currentCameraAttemptId;
    },
    getCurrentCameraAttemptId() {
      return currentCameraAttemptId;
    },
    isCameraAttemptCurrent(attemptId) {
      return attemptId === currentCameraAttemptId;
    },
    cleanupCameraAttempt(stream) {
      if (stream && typeof stream.getTracks === 'function') {
        stream.getTracks().forEach(track => {
          try { track.stop(); } catch (e) {}
        });
      }
    }
  };
}
