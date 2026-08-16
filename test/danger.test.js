// Unit tests for src/danger.js (the redline alarm level + heartbeat).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dangerOf,
  stackTopRow,
  dangerBeat,
  dangerPulse,
  DANGER_SAFE_ROW,
  DANGER_FULL_ROW,
  DANGER_PERIOD,
  DANGER_PULSE_AMP,
} from '../src/danger.js';

const ROWS = 22;
const boardWithTop = (top) => {
  const b = Array.from({ length: ROWS }, () => Array(10).fill(null));
  for (let x = 0; x < 10; x++) b[top][x] = 'T';
  return b;
};

test('constants: alarm window and heartbeat shape', () => {
  assert.equal(DANGER_SAFE_ROW, 13);
  assert.equal(DANGER_FULL_ROW, 7);
  assert.ok(DANGER_PERIOD > 0 && DANGER_PERIOD < 2);
  assert.ok(DANGER_PULSE_AMP > 0);
  assert.ok(DANGER_SAFE_ROW > DANGER_FULL_ROW);
});

test('stackTopRow: -1 for an empty well, smallest occupied row otherwise', () => {
  const empty = Array.from({ length: ROWS }, () => Array(10).fill(null));
  assert.equal(stackTopRow(empty), -1);
  assert.equal(stackTopRow(boardWithTop(5)), 5);
  const b = boardWithTop(19);
  b[3][7] = 'I'; // a stray block above the main stack
  assert.equal(stackTopRow(b), 3);
});

test('dangerOf: empty well and low stacks read 0', () => {
  const empty = Array.from({ length: ROWS }, () => Array(10).fill(null));
  assert.equal(dangerOf(empty), 0);
  assert.equal(dangerOf(boardWithTop(21)), 0); // floor
  assert.equal(dangerOf(boardWithTop(17)), 0);
  assert.equal(dangerOf(boardWithTop(13)), 0); // exactly the safe row
});

test('dangerOf: linear ramp between the safe and full rows', () => {
  const d = (top) => dangerOf(boardWithTop(top));
  assert.ok(Math.abs(d(12) - (DANGER_SAFE_ROW - 12) / (DANGER_SAFE_ROW - DANGER_FULL_ROW)) < 1e-9);
  assert.ok(Math.abs(d(10) - (DANGER_SAFE_ROW - 10) / (DANGER_SAFE_ROW - DANGER_FULL_ROW)) < 1e-9);
  assert.ok(d(12) < d(10) && d(10) < d(8), 'monotonic in height');
  assert.ok(Math.abs(d(10) - 0.5) < 1e-9, `midpoint ${d(10)}`);
});

test('dangerOf: full alarm at DANGER_FULL_ROW and beyond (hidden rows too)', () => {
  assert.equal(dangerOf(boardWithTop(7)), 1);
  assert.equal(dangerOf(boardWithTop(2)), 1);
  assert.equal(dangerOf(boardWithTop(0)), 1); // hidden-row tower: lock-out
});

test('dangerBeat: trough at t=0, periodic, bounded 0..1, NaN-safe', () => {
  assert.equal(dangerBeat(0), 0);
  assert.ok(dangerBeat(NaN) === 0);
  assert.ok(dangerBeat(Infinity) === 0);
  for (const t of [0.2, 0.7, 3.3]) {
    const a = dangerBeat(t);
    assert.ok(a >= 0 && a <= 1, `beat(${t}) = ${a}`);
    assert.ok(Math.abs(a - dangerBeat(t + DANGER_PERIOD)) < 1e-9, 'periodic');
    assert.ok(Math.abs(a - dangerBeat(t + 5 * DANGER_PERIOD)) < 1e-9, '5 periods');
  }
  // A full sweep finds the thump peak (~1).
  let peak = 0;
  for (let i = 0; i < 400; i++) peak = Math.max(peak, dangerBeat((i / 400) * DANGER_PERIOD));
  assert.ok(peak > 0.95, `peak ${peak}`);
});

test('dangerBeat: negative times are finite and in range', () => {
  for (const t of [-0.1, -1.1, -100]) {
    const b = dangerBeat(t);
    assert.ok(Number.isFinite(b) && b >= 0 && b <= 1, `beat(${t}) = ${b}`);
  }
});

test('dangerPulse: level 0 is the exact identity at every t', () => {
  for (const t of [0, 0.3, 1.1, 7.7]) assert.equal(dangerPulse(t, 0), 1);
});

test('dangerPulse: full level swings 1 -> 1+AMP over the beat', () => {
  let peak = 0;
  for (let i = 0; i < 400; i++) peak = Math.max(peak, dangerPulse((i / 400) * DANGER_PERIOD, 1));
  assert.ok(Math.abs(peak - (1 + DANGER_PULSE_AMP)) < 1e-6, `peak ${peak}`);
  assert.equal(dangerPulse(0, 1), 1); // trough
  assert.ok(dangerPulse(0.55, 1) > 1.2); // mid-thump
});

test('dangerPulse: out-of-range and NaN levels are clamped, not trusted', () => {
  assert.ok(Math.abs(dangerPulse(0.55, 7) - dangerPulse(0.55, 1)) < 1e-9, 'clamps above 1');
  assert.equal(dangerPulse(0.55, NaN), 1);
  assert.equal(dangerPulse(0.55, -3), 1);
});