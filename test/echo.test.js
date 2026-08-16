// Unit tests for src/echo.js (holographic rotation echo envelope).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ECHO_LIFE,
  ECHO_THROTTLE,
  ECHO_GROWTH,
  echoFade,
  echoScale,
} from '../src/echo.js';

test('constants: brief life, sensible throttle, modest growth', () => {
  assert.equal(ECHO_LIFE, 0.34);
  assert.ok(ECHO_THROTTLE > 0 && ECHO_THROTTLE < ECHO_LIFE);
  assert.ok(ECHO_GROWTH > 0 && ECHO_GROWTH < 0.5);
});

test('echoFade is full at spawn and zero at/after the end', () => {
  assert.equal(echoFade(0), 1);
  assert.equal(echoFade(-0.5), 1);
  assert.equal(echoFade(1), 0);
  assert.equal(echoFade(3), 0);
});

test('echoFade decays monotonically with the eased curve (midpoint pinned)', () => {
  // The pow-0.6 ease-out holds the afterimage's shape a beat, then
  // dissolves: at half-life it is still brighter than the linear 0.5.
  assert.ok(echoFade(0.5) > 0.5);
  assert.equal(echoFade(0.5), Math.pow(0.5, 0.6));
  let prev = 1;
  for (let i = 1; i <= 10; i++) {
    const v = echoFade(i / 10);
    assert.ok(v <= prev && v >= 0, `decay at k=${i / 10}`);
    prev = v;
  }
});

test('echoFade is NaN-safe (out-of-range input never poisons the shader)', () => {
  assert.equal(echoFade(NaN), 1);
  assert.equal(echoFade(Infinity), 0);
});

test('echoScale starts at 1 and eases to the final swell', () => {
  assert.equal(echoScale(0), 1);
  assert.equal(echoScale(-1), 1);
  assert.equal(echoScale(1), 1 + ECHO_GROWTH);
  assert.equal(echoScale(2), 1 + ECHO_GROWTH);
  assert.equal(echoScale(0.5), 1 + ECHO_GROWTH * 0.5);
});

test('echoScale grows monotonically', () => {
  let prev = 1;
  for (let i = 1; i <= 10; i++) {
    const v = echoScale(i / 10);
    assert.ok(v >= prev, `growth at k=${i / 10}`);
    prev = v;
  }
});