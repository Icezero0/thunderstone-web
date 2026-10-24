import test from 'node:test';
import assert from 'node:assert/strict';
import {handInsertionIndex, layoutHand} from '../.test-dist/probe-hand-layout.js';
import {FaceFlip} from '../.test-dist/probe-face-flip.js';

test('hand layout covers empty, singleton, exact fit and dense/narrow hands without overflow or uneven spacing', () => {
  for (const count of [0, 1, 2, 6, 12, 30]) for (const width of [0, 70, 144, 300, 460, 1000, 2000]) {
    const result = layoutHand(count, width, 144), size = Math.min(width, 144);
    assert.equal(result.positions.length, count);
    assert.ok(result.positions.every(value => Number.isFinite(value) && value >= 0));
    if (!count) continue;
    assert.ok(result.positions.at(-1) + size <= width + 1e-8);
    assert.ok(Math.abs(result.positions[0] - (width - result.positions.at(-1) - size)) < 1e-8);
    for (let index = 1; index < count; index++) {
      assert.ok(Math.abs(result.positions[index] - result.positions[index - 1] - result.step) < 1e-8);
    }
  }
  const exact = layoutHand(3, 460, 144);
  assert.deepEqual(exact.positions, [0, 158, 316]); assert.equal(exact.overlap, 0);
  const touching = layoutHand(3, 432, 144);
  assert.deepEqual(touching.positions, [0, 144, 288]); assert.equal(touching.overlap, 0);
});

test('drop slots follow pointer midpoints in both separated and overlapped hands, and clamp at both ends', () => {
  for (const count of [2, 6, 30]) for (const width of [300, 1000, 2000]) {
    const layout = layoutHand(count, width, 144);
    layout.positions.forEach((left, index) => assert.equal(handInsertionIndex(left, layout, 0), index));
    for (let index = 1; index < count; index++) {
      const middle = (layout.positions[index - 1] + layout.positions[index]) / 2;
      assert.equal(handInsertionIndex(middle - .01, layout, index), index - 1);
      assert.equal(handInsertionIndex(middle + .01, layout, index - 1), index);
    }
    assert.equal(handInsertionIndex(-10000, layout, count - 1), 0);
    assert.equal(handInsertionIndex(10000, layout, 0), count - 1);
  }
  // With no horizontal space, retain the current slot instead of collapsing all cards to index 0.
  assert.equal(handInsertionIndex(0, layoutHand(6, 144, 144), 4), 4);
});

function animation({reducedMotion = false, faceUp = true} = {}) {
  const animations = [], faces = [];
  const surface = {animate(keyframes, options) {
    const value = {keyframes, options, playState: 'running', onfinish: null, oncancel: null,
      finish() {if (this.playState === 'running') {this.playState = 'finished'; this.onfinish?.();}},
      cancel() {this.playState = 'idle'; this.oncancel?.();}};
    animations.push(value); return value;
  }};
  const flip = new FaceFlip(surface, face => faces.push(face), () => reducedMotion, faceUp);
  return {flip, animations, faces};
}

test('programmatic flipping changes the face at the midpoint and releases the animation layer at rest', () => {
  const ui = animation(); ui.flip.setFaceUp(false);
  assert.equal(ui.faces.at(-1), true);
  assert.match(ui.animations[0].keyframes[1].transform, /rotateY\(-90deg\)/);
  ui.animations[0].finish(); assert.equal(ui.faces.at(-1), false);
  assert.equal(ui.animations[0].playState, 'idle');
  assert.match(ui.animations[1].keyframes[0].transform, /rotateY\(90deg\)/);
  ui.animations[1].finish(); assert.equal(ui.flip.isAnimating, false);
  assert.ok(ui.animations.every(value => value.playState === 'idle'));
  ui.flip.setFaceUp(false); assert.equal(ui.animations.length, 2);
  ui.flip.setFaceUp(true); ui.animations[2].finish(); ui.animations[3].finish();
  assert.equal(ui.faces.at(-1), true);
});

test('programmatic reversals use the latest requested orientation in either half', () => {
  const ui = animation(); ui.flip.setFaceUp(false); ui.flip.setFaceUp(true);
  assert.equal(ui.animations.length, 1);
  ui.animations[0].finish(); assert.equal(ui.faces.at(-1), true);
  ui.animations[1].finish(); assert.equal(ui.flip.isAnimating, false);
  ui.flip.setFaceUp(false); ui.animations[2].finish(); ui.flip.setFaceUp(true);
  ui.animations[3].finish(); assert.equal(ui.animations.length, 5);
  ui.animations[4].finish(); ui.animations[5].finish();
  assert.equal(ui.faces.at(-1), true); assert.equal(ui.flip.isAnimating, false);
  assert.ok(ui.animations.every(value => value.playState === 'idle'));
});

test('interruption and disposal settle the latest face and ignore stale completion callbacks', () => {
  for (const opening of [false, true]) {
    const ui = animation(); ui.flip.setFaceUp(false);
    if (opening) {ui.animations[0].finish(); ui.flip.setFaceUp(true);}
    const late = ui.animations.at(-1).onfinish;
    ui.flip.settle(); assert.equal(ui.faces.at(-1), opening); assert.equal(ui.flip.isAnimating, false);
    const count = ui.animations.length; late(); assert.equal(ui.animations.length, count);
    ui.flip.dispose(); ui.flip.setFaceUp(!opening); assert.equal(ui.animations.length, count);
  }
});

test('initial back-side orientation, reduced motion and cancellation remain deterministic', () => {
  const back = animation({faceUp: false}); back.flip.setFaceUp(false); assert.equal(back.animations.length, 0);
  back.flip.setFaceUp(true); back.animations[0].finish(); back.animations[1].finish();
  assert.equal(back.faces.at(-1), true);
  const reduced = animation({reducedMotion: true}); reduced.flip.setFaceUp(false);
  assert.equal(reduced.faces.at(-1), false); assert.equal(reduced.animations.length, 0);
  const cancelled = animation(); cancelled.flip.setFaceUp(false); cancelled.animations[0].cancel();
  assert.equal(cancelled.faces.at(-1), false); assert.equal(cancelled.flip.isAnimating, false);
});
