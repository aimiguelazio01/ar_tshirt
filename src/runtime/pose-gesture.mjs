export function classifyArm(points, side, confidence = 0.75) {
  const valid = p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1 && Number.isFinite(p.visibility) && p.visibility >= confidence && (p.presence === undefined || (Number.isFinite(p.presence) && p.presence >= confidence));
  if (!points || !valid(points[11]) || !valid(points[12])) return 'UNKNOWN';
  const [s, e, w, h] = side === 'left' ? [11,13,15,7] : [12,14,16,8];
  const shoulder = points[s], elbow = points[e], wrist = points[w];
  if (![shoulder, elbow, wrist].every(valid)) return 'UNKNOWN';
  const width = Math.hypot(points[11].x-points[12].x, points[11].y-points[12].y);
  if (width < 0.02) return 'UNKNOWN';
  if (wrist.y > shoulder.y + width * 0.2) return 'DOWN';
  const head = valid(points[h]) ? points[h] : valid(points[0]) ? points[0] : null;
  if (!head) return 'UNKNOWN';
  // Preserve the existing full-up geometry, after validating all required joints.
  if (((wrist.y < shoulder.y + 0.04 || wrist.y < head.y + 0.10) && wrist.y < elbow.y + 0.10) || elbow.y < shoulder.y + 0.04) return 'UP';
  return 'UNKNOWN';
}

export function createPoseGestureGate({ baselineMs = 400, transitionMs = 300, maxAgeMs = 350, minFrames = 3, confidence = 0.75, diagnostic = () => {} } = {}) {
  let arms, active, lastTimestamp;
  function reset() { arms = {left: {}, right: {}}; active = null; lastTimestamp = -Infinity; }
  reset();
  function update(points, capturedAt, now = capturedAt) {
    if (!Number.isFinite(capturedAt) || capturedAt <= lastTimestamp) { diagnostic('duplicate-or-out-of-order'); return []; }
    if (now - capturedAt > maxAgeMs || capturedAt > now) { diagnostic('stale'); return []; }
    const events = [];
    if (active && capturedAt - arms[active].lastValid > maxAgeMs) {
      events.push({type:'cancel',side:active});
      reset();
    }
    if (capturedAt-lastTimestamp > maxAgeMs) for (const arm of Object.values(arms)) { arm.candidate = null; if (!arm.raised) arm.armed = false; }
    lastTimestamp = capturedAt;
    for (const side of ['left','right']) {
      const arm = arms[side];
      const state = classifyArm(points, side, confidence);
      diagnostic(side, state);
      if (state === 'UNKNOWN') {
        arm.candidate = null;
        if (!arm.raised) arm.armed = false;
        if (arm.raised && capturedAt - arm.lastValid > maxAgeMs) {
          events.push({type:'cancel',side}); arms[side] = {}; active = null;
        }
        continue;
      }
      arm.lastValid = capturedAt;
      if (active && active !== side) { arm.candidate = null; arm.armed = false; continue; }
      if (!arm.candidate || arm.candidate.state !== state) arm.candidate = {state, start: capturedAt, frames:0};
      arm.candidate.frames++;
      const duration = capturedAt-arm.candidate.start;
      if (arm.candidate.frames < minFrames) continue;
      if (!arm.raised && state === 'DOWN' && duration >= baselineMs) arm.armed = true;
      if (!arm.raised && arm.armed && state === 'UP' && duration >= transitionMs) {
        arm.raised = true; active = side; arm.candidate = null; events.push({type:'raise',side});
      } else if (arm.raised && state === 'DOWN' && duration >= transitionMs) {
        events.push({type:'lower',side}); arms[side] = {}; active = null;
      }
    }
    return events;
  }
  return {update, reset};
}
