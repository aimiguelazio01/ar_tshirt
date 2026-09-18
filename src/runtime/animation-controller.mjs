import * as THREE from 'three';
import { CLIP_DEFINITIONS_MAP } from './clip-sampler.mjs';

/**
 * Explicit animation states
 */
export const AnimationState = Object.freeze({
  IDLE: 'idle',
  REACTION: 'reaction',
  LEFT_RAISING: 'left_raising',
  LEFT_HOLDING: 'left_holding',
  LEFT_LOWERING: 'left_lowering',
  RIGHT_RAISING: 'right_raising',
  RIGHT_HOLDING: 'right_holding',
  RIGHT_LOWERING: 'right_lowering',
  DISPOSED: 'disposed'
});

/**
 * Crossfade durations specified in requirements
 */
export const FADE_DURATIONS = Object.freeze({
  IDLE_TO_INTERACTION: 0.12,
  GESTURE_TRANSITION: 0.08,
  LOWERING_TO_IDLE: 0.15,
  REACTION_TO_IDLE: 0.20
});

/**
 * Arbitrates between left and right arms when both are detected.
 * Retains selected side; chooses right if neither is selected.
 */
export function arbitrateArms(isLeftUpRaw, isRightUpRaw, currentArm = null) {
  if (isRightUpRaw && !isLeftUpRaw) return 'right';
  if (isLeftUpRaw && !isRightUpRaw) return 'left';
  if (isRightUpRaw && isLeftUpRaw) {
    if (currentArm === 'right') return 'right';
    if (currentArm === 'left') return 'left';
    return 'right';
  }
  return null;
}

/**
 * Finds the first skinned mesh or mesh with morph target influences in the model hierarchy.
 */
function findMorphMesh(root) {
  if (!root) return null;
  let found = null;
  root.traverse((node) => {
    if (!found && node.morphTargetInfluences && node.morphTargetInfluences.length > 0) {
      found = node;
    }
  });
  return found;
}

/**
 * Shared Animation Controller for AR and Simulator.
 */
export class AnimationController {
  constructor({
    model,
    clips,
    mixer = null,
    speed = 1.0,
    onEffect = null,
    Three = THREE
  }) {
    if (!model) throw new Error('[AnimationController] model is required');
    if (!clips) throw new Error('[AnimationController] clips Map is required');

    this.THREE = Three;
    this.model = model;
    this.clips = clips;
    this.onEffect = onEffect;
    this.speed = Math.max(0, Number(speed) || 0);

    this.mixer = mixer || new this.THREE.AnimationMixer(this.model);
    this.mixer.timeScale = this.speed;

    this.morphMesh = findMorphMesh(this.model);

    // Generation token + session ID to reject obsolete completions
    this.sessionId = Math.random().toString(36).slice(2);
    this.generation = 0;

    this.state = AnimationState.IDLE;
    this.currentAction = null;
    this.currentClipId = null;

    // Outgoing transitions tracking: [{ action, startWeight, duration, elapsed }]
    this.outgoingFades = [];

    // Incoming transition tracking: { action, startWeight, duration, elapsed }
    this.incomingFade = null;

    // Enqueued finished events for processing after mixer.update()
    this.pendingEvents = [];

    // Pre-create actions from canonical sampled clips
    this.actions = new Map();
    for (const [clipId, clip] of this.clips.entries()) {
      const action = this.mixer.clipAction(clip);
      action.setEffectiveWeight(0);
      action.enabled = false;
      this.actions.set(clipId, action);
    }

    // Finished event listener on mixer
    this._onActionFinished = (event) => {
      this.pendingEvents.push({
        action: event.action,
        generation: this.generation,
        sessionId: this.sessionId
      });
    };
    this.mixer.addEventListener('finished', this._onActionFinished);

    // Start in idle
    this._startInitialIdle();
  }

  _startInitialIdle() {
    const idleAction = this.actions.get('idle');
    if (idleAction) {
      idleAction.reset();
      idleAction.setLoop(this.THREE.LoopRepeat);
      idleAction.enabled = true;
      idleAction.paused = false;
      idleAction.setEffectiveWeight(1.0);
      idleAction.play();
      this.currentAction = idleAction;
      this.currentClipId = 'idle';
      this.state = AnimationState.IDLE;
    }
  }

  getCurrentActiveArm() {
    if (this.state === AnimationState.LEFT_RAISING || this.state === AnimationState.LEFT_HOLDING) {
      return 'left';
    }
    if (this.state === AnimationState.RIGHT_RAISING || this.state === AnimationState.RIGHT_HOLDING) {
      return 'right';
    }
    return null;
  }

  /**
   * Transitions from current action(s) to target action with complementary weights.
   */
  _transitionTo(targetClipId, duration, loopMode = this.THREE.LoopRepeat, repetitions = Infinity, clampWhenFinished = false) {
    const targetAction = this.actions.get(targetClipId);
    if (!targetAction) {
      console.warn(`[AnimationController] Clip '${targetClipId}' not found`);
      return;
    }

    this.generation++;
    const prevAction = this.currentAction;

    // Convert previous action and any current incoming fade into outgoing fades
    const newOutgoingFades = [];

    // If there was an incoming fade in progress, treat it as outgoing from its current weight
    if (this.incomingFade && this.incomingFade.action !== targetAction) {
      const curW = this.incomingFade.action.getEffectiveWeight();
      if (curW > 0) {
        newOutgoingFades.push({
          action: this.incomingFade.action,
          startWeight: curW,
          duration,
          elapsed: 0
        });
      }
    } else if (prevAction && prevAction !== targetAction) {
      const curW = prevAction.getEffectiveWeight();
      if (curW > 0) {
        newOutgoingFades.push({
          action: prevAction,
          startWeight: curW,
          duration,
          elapsed: 0
        });
      }
    }

    // Preserve existing outgoing fades, scaling down from current weight
    for (const fade of this.outgoingFades) {
      if (fade.action !== targetAction) {
        const curW = fade.action.getEffectiveWeight();
        if (curW > 0) {
          newOutgoingFades.push({
            action: fade.action,
            startWeight: curW,
            duration,
            elapsed: 0
          });
        }
      }
    }
    this.outgoingFades = newOutgoingFades;

    // Reset and enable incoming target action explicitly
    targetAction.stopFading();
    targetAction.stopWarping();
    targetAction.reset();
    targetAction.enabled = true;
    targetAction.paused = false;
    targetAction.timeScale = 1.0;
    targetAction.clampWhenFinished = clampWhenFinished;
    targetAction.setLoop(loopMode, repetitions);

    const incomingStartWeight = (this.currentAction === targetAction) ? targetAction.getEffectiveWeight() : 0.0;
    targetAction.setEffectiveWeight(incomingStartWeight);
    targetAction.play();

    this.currentAction = targetAction;
    this.currentClipId = targetClipId;

    if (duration <= 0) {
      // Immediate switch
      targetAction.setEffectiveWeight(1.0);
      for (const fade of this.outgoingFades) {
        fade.action.stop();
        fade.action.setEffectiveWeight(0);
        fade.action.enabled = false;
      }
      this.outgoingFades = [];
      this.incomingFade = null;
    } else {
      this.incomingFade = {
        action: targetAction,
        startWeight: incomingStartWeight,
        duration,
        elapsed: 0
      };
    }
  }

  /**
   * Advances crossfades using mixer-scaled active delta time.
   */
  _advanceFades(activeDelta) {
    if (activeDelta <= 0) return;

    // Advance incoming fade
    if (this.incomingFade) {
      this.incomingFade.elapsed += activeDelta;
      const progress = Math.min(1.0, this.incomingFade.elapsed / this.incomingFade.duration);
      const w = this.incomingFade.startWeight + (1.0 - this.incomingFade.startWeight) * progress;
      this.incomingFade.action.setEffectiveWeight(w);

      if (progress >= 1.0) {
        this.incomingFade.action.setEffectiveWeight(1.0);
        this.incomingFade = null;
      }
    }

    // Advance outgoing fades
    if (this.outgoingFades.length > 0) {
      const remainingFades = [];
      for (const fade of this.outgoingFades) {
        fade.elapsed += activeDelta;
        const progress = Math.min(1.0, fade.elapsed / fade.duration);
        const w = fade.startWeight * (1.0 - progress);
        fade.action.setEffectiveWeight(w);

        if (progress >= 1.0 || w <= 1e-5) {
          // Stopped explicitly after weight reaches zero
          fade.action.stop();
          fade.action.setEffectiveWeight(0);
          fade.action.enabled = false;
        } else {
          remainingFades.push(fade);
        }
      }
      this.outgoingFades = remainingFades;
    }
  }

  /**
   * Handles action completion events enqueued from mixer 'finished' event.
   */
  _handleFinishedAction(finishedAction) {
    if (this.state === AnimationState.LEFT_RAISING && finishedAction === this.actions.get('left_raise')) {
      // Left raise finished and clamped at frame 80 -> enter holding
      this.state = AnimationState.LEFT_HOLDING;
      return;
    }

    if (this.state === AnimationState.RIGHT_RAISING && finishedAction === this.actions.get('right_raise')) {
      // Right raise finished and clamped at frame 125 -> enter holding
      this.state = AnimationState.RIGHT_HOLDING;
      return;
    }

    if (this.state === AnimationState.LEFT_LOWERING && finishedAction === this.actions.get('left_lower')) {
      // Left lowering finished -> transition to idle (0.15s)
      this.state = AnimationState.IDLE;
      this._transitionTo('idle', FADE_DURATIONS.LOWERING_TO_IDLE, this.THREE.LoopRepeat);
      return;
    }

    if (this.state === AnimationState.RIGHT_LOWERING && finishedAction === this.actions.get('right_lower')) {
      // Right lowering finished -> transition to idle (0.15s)
      this.state = AnimationState.IDLE;
      this._transitionTo('idle', FADE_DURATIONS.LOWERING_TO_IDLE, this.THREE.LoopRepeat);
      return;
    }

    if (this.state === AnimationState.REACTION && finishedAction === this.actions.get('reaction')) {
      // Reaction finished all repetitions -> transition to idle (0.20s)
      this.state = AnimationState.IDLE;
      this._transitionTo('idle', FADE_DURATIONS.REACTION_TO_IDLE, this.THREE.LoopRepeat);
      return;
    }
  }

  /**
   * Main per-frame update.
   */
  update(deltaSeconds) {
    if (this.state === AnimationState.DISPOSED) return;
    if (typeof deltaSeconds !== 'number' || isNaN(deltaSeconds) || deltaSeconds <= 0) return;

    const activeDelta = deltaSeconds * this.speed;

    // 1. Advance crossfades with active delta
    this._advanceFades(activeDelta);

    // 2. Update Three.js mixer
    if (this.speed > 0 && activeDelta > 0) {
      this.mixer.update(activeDelta);
    }

    // 3. Process enqueued completion events AFTER mixer.update() has returned
    if (this.pendingEvents.length > 0) {
      const events = this.pendingEvents;
      this.pendingEvents = [];
      for (const evt of events) {
        if (evt.generation === this.generation && evt.sessionId === this.sessionId) {
          this._handleFinishedAction(evt.action);
        }
      }
    }
  }

  /**
   * Triggers reaction animation (frames 25–72).
   * Interrupts gestures and clears their state.
   */
  playReaction(repetitions = 2) {
    if (this.state === AnimationState.DISPOSED) return;

    const count = Math.max(1, repetitions);
    this.state = AnimationState.REACTION;
    this._transitionTo(
      'reaction',
      FADE_DURATIONS.IDLE_TO_INTERACTION,
      this.THREE.LoopRepeat,
      count,
      true // clampWhenFinished
    );
  }

  /**
   * Raises arm ('left' or 'right').
   * Ignored if in reaction. Switching sides cancels the previous sequence.
   */
  raiseArm(side) {
    if (this.state === AnimationState.DISPOSED) return false;
    if (this.state === AnimationState.REACTION) return false;

    if (side === 'left') {
      if (this.state === AnimationState.LEFT_RAISING || this.state === AnimationState.LEFT_HOLDING) {
        return false; // Already raised / holding
      }
      const isSwitching = (
        this.state === AnimationState.RIGHT_RAISING ||
        this.state === AnimationState.RIGHT_HOLDING ||
        this.state === AnimationState.RIGHT_LOWERING ||
        this.state === AnimationState.LEFT_LOWERING
      );
      const fadeDur = isSwitching ? FADE_DURATIONS.GESTURE_TRANSITION : FADE_DURATIONS.IDLE_TO_INTERACTION;

      this.state = AnimationState.LEFT_RAISING;
      this._transitionTo('left_raise', fadeDur, this.THREE.LoopOnce, 1, true);
      return true;
    }

    if (side === 'right') {
      if (this.state === AnimationState.RIGHT_RAISING || this.state === AnimationState.RIGHT_HOLDING) {
        return false; // Already raised / holding
      }
      const isSwitching = (
        this.state === AnimationState.LEFT_RAISING ||
        this.state === AnimationState.LEFT_HOLDING ||
        this.state === AnimationState.LEFT_LOWERING ||
        this.state === AnimationState.RIGHT_LOWERING
      );
      const fadeDur = isSwitching ? FADE_DURATIONS.GESTURE_TRANSITION : FADE_DURATIONS.IDLE_TO_INTERACTION;

      this.state = AnimationState.RIGHT_RAISING;
      this._transitionTo('right_raise', fadeDur, this.THREE.LoopOnce, 1, true);
      return true;
    }

    return false;
  }

  /**
   * Lowers arm ('left' or 'right').
   * If lowered during a raise, transitions immediately to that side's lowering clip.
   */
  lowerArm(side, { triggerEffect = true } = {}) {
    if (this.state === AnimationState.DISPOSED) return false;
    if (this.state === AnimationState.REACTION) return false;

    if (side === 'left') {
      if (this.state !== AnimationState.LEFT_RAISING && this.state !== AnimationState.LEFT_HOLDING) {
        return false;
      }
      this.state = AnimationState.LEFT_LOWERING;
      this._transitionTo('left_lower', FADE_DURATIONS.GESTURE_TRANSITION, this.THREE.LoopOnce, 1, true);

      if (triggerEffect && typeof this.onEffect === 'function') {
        this.onEffect('storm');
      }
      return true;
    }

    if (side === 'right') {
      if (this.state !== AnimationState.RIGHT_RAISING && this.state !== AnimationState.RIGHT_HOLDING) {
        return false;
      }
      this.state = AnimationState.RIGHT_LOWERING;
      this._transitionTo('right_lower', FADE_DURATIONS.GESTURE_TRANSITION, this.THREE.LoopOnce, 1, true);

      if (triggerEffect && typeof this.onEffect === 'function') {
        this.onEffect('explosion');
      }
      return true;
    }

    return false;
  }

  /**
   * Returns immediately to idle, canceling pending gesture or reaction sequences.
   */
  playIdle() {
    if (this.state === AnimationState.DISPOSED) return;
    if (this.state === AnimationState.IDLE && this.outgoingFades.length === 0 && (!this.incomingFade || this.incomingFade.action === this.actions.get('idle'))) {
      return;
    }

    let fadeDur = FADE_DURATIONS.LOWERING_TO_IDLE;
    if (this.state === AnimationState.REACTION) {
      fadeDur = FADE_DURATIONS.REACTION_TO_IDLE;
    }

    this.state = AnimationState.IDLE;
    this._transitionTo('idle', fadeDur, this.THREE.LoopRepeat);
  }

  /**
   * Sets playback speed. Zero pauses playback cleanly.
   */
  setSpeed(value) {
    const val = parseFloat(value);
    if (!isNaN(val) && val >= 0) {
      this.speed = val;
      if (this.mixer) this.mixer.timeScale = val;
    }
    return this.speed;
  }

  /**
   * Returns comprehensive diagnostic and HUD state.
   */
  getDebugState() {
    if (this.state === AnimationState.DISPOSED) {
      return null;
    }

    let clipName = 'IDLE';
    let startFrame = 1;
    let endFrame = 24;
    let currentFrame = 1;
    let progress = 0;

    const action = this.currentAction;
    const rawTime = action ? action.time : 0;
    const clipDef = CLIP_DEFINITIONS_MAP[this.currentClipId];

    if (clipDef) {
      startFrame = clipDef.startFrame;
      endFrame = clipDef.endFrame;
      const totalFrames = endFrame - startFrame;
      const duration = (clipDef.endFrame - clipDef.startFrame) / 24;

      if (this.state === AnimationState.LEFT_HOLDING) {
        clipName = 'LEFT ARM UP';
        currentFrame = 80;
        progress = 1.0;
      } else if (this.state === AnimationState.RIGHT_HOLDING) {
        clipName = 'RIGHT ARM UP';
        currentFrame = 125;
        progress = 1.0;
      } else if (this.state === AnimationState.LEFT_RAISING) {
        clipName = 'LEFT ARM UP';
        const offset = Math.min(totalFrames, Math.max(0, Math.round(rawTime * 24)));
        currentFrame = startFrame + offset;
        progress = totalFrames > 0 ? offset / totalFrames : 1.0;
      } else if (this.state === AnimationState.LEFT_LOWERING) {
        clipName = 'LEFT ARM DOWN (STORM)';
        const offset = Math.min(totalFrames, Math.max(0, Math.round(rawTime * 24)));
        currentFrame = startFrame + offset;
        progress = totalFrames > 0 ? offset / totalFrames : 1.0;
      } else if (this.state === AnimationState.RIGHT_RAISING) {
        clipName = 'RIGHT ARM UP';
        const offset = Math.min(totalFrames, Math.max(0, Math.round(rawTime * 24)));
        currentFrame = startFrame + offset;
        progress = totalFrames > 0 ? offset / totalFrames : 1.0;
      } else if (this.state === AnimationState.RIGHT_LOWERING) {
        clipName = 'RIGHT ARM DOWN (BLAST)';
        const offset = Math.min(totalFrames, Math.max(0, Math.round(rawTime * 24)));
        currentFrame = startFrame + offset;
        progress = totalFrames > 0 ? offset / totalFrames : 1.0;
      } else if (this.state === AnimationState.REACTION) {
        clipName = "DON'T TOUCH";
        const cycleTime = duration > 0 ? (rawTime % duration) : 0;
        const offset = Math.min(totalFrames, Math.max(0, Math.round(cycleTime * 24)));
        currentFrame = startFrame + offset;
        progress = duration > 0 ? Math.min(1.0, (rawTime % duration) / duration) : 0;
      } else {
        // IDLE
        clipName = 'IDLE';
        const cycleTime = duration > 0 ? (rawTime % duration) : 0;
        const offset = Math.min(totalFrames, Math.max(0, Math.round(cycleTime * 24)));
        currentFrame = startFrame + offset;
        progress = duration > 0 ? Math.min(1.0, (rawTime % duration) / duration) : 0;
      }
    }

    // Action weights map
    const actionWeights = {};
    for (const [id, act] of this.actions.entries()) {
      actionWeights[id] = Number(act.getEffectiveWeight().toFixed(3));
    }

    // Morph target influences map
    const morphValues = {};
    if (this.morphMesh && this.morphMesh.morphTargetDictionary && this.morphMesh.morphTargetInfluences) {
      for (const [mName, mIdx] of Object.entries(this.morphMesh.morphTargetDictionary)) {
        morphValues[mName] = Number(this.morphMesh.morphTargetInfluences[mIdx].toFixed(4));
      }
    }

    return {
      state: this.state,
      clipName,
      frame: currentFrame,
      rangeText: `[${startFrame}–${endFrame}]`,
      progress: Math.min(1.0, Math.max(0, progress)),
      rawTime: Number(rawTime.toFixed(2)),
      effectiveWeight: action ? Number(action.getEffectiveWeight().toFixed(3)) : 0,
      actionWeights,
      morphValues
    };
  }

  /**
   * Cancels all actions, removes listeners, marks disposed.
   */
  dispose() {
    this.generation++;
    this.state = AnimationState.DISPOSED;
    this.pendingEvents = [];
    this.outgoingFades = [];
    this.incomingFade = null;

    if (this.mixer) {
      if (this._onActionFinished) {
        this.mixer.removeEventListener('finished', this._onActionFinished);
      }
      try {
        this.mixer.stopAllAction();
      } catch (e) { }
    }
  }
}

/**
 * Factory helper.
 */
export function createAnimationController(options) {
  return new AnimationController(options);
}
