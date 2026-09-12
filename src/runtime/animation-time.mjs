/**
 * Precise session-bound elapsed active time tracker.
 * Discards hidden interval time, maintains real-time animation playback
 * across variable frame rates without artificial slow-motion clamping.
 */
export function createAnimationTime() {
  let previous = null;
  return {
    reset() {
      previous = null;
    },
    tick(nowMs) {
      if (previous === null) {
        previous = nowMs;
        return 0;
      }
      const seconds = Math.max(0, (nowMs - previous) / 1000);
      previous = nowMs;
      return seconds;
    }
  };
}

/**
 * Filtered mixer 'finished' event listener for robust action completion.
 * Avoids timer/animation desync from setTimeout when frame rate drops or timeScale changes.
 *
 * @param {THREE.AnimationMixer} mixer
 * @param {THREE.AnimationAction} action
 * @param {Object} session
 * @param {Function} complete
 * @param {Function} [isCurrentFn] Optional predicate, defaults to checking session.abort.signal
 * @returns {Function} cancellation/removal cleanup function
 */
export function onActionFinished(mixer, action, session, complete, isCurrentFn = null) {
  if (!mixer || !action) return () => {};

  const isSessionCurrent = () => {
    if (typeof isCurrentFn === 'function') return isCurrentFn(session);
    return session && !session.abort?.signal?.aborted;
  };

  const handler = (event) => {
    if (event.action !== action) return;
    remove();
    if (isSessionCurrent()) {
      complete();
    }
  };

  function remove() {
    try {
      mixer.removeEventListener('finished', handler);
    } catch (e) {}
    if (session && session.cleanups) {
      session.cleanups.delete(remove);
    }
  }

  mixer.addEventListener('finished', handler);
  if (session && session.cleanups) {
    session.cleanups.add(remove);
  }
  return remove;
}
