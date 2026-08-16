// Unit tests for src/fall-dust.js (the stardust wake accumulator).

import test from 'node:test';
import assert from 'node:assert/strict';
import { wakeStep, wakeBank, WAKE_STEP, WAKE_DRAIN, WAKE_CAP } from '../src/fall-dust.js';

test('constant: one mote per WAKE_STEP of fall, drain is 2x', () => {
  assert.equal(WAKE_STEP, 0.3);
  assert.equal(WAKE_DRAIN, 2);
});

test('one gravity row (dy=1.0) sheds exactly 3 motes, keeping the 0.1 remainder', () => {
  const r = wakeStep(0, 1.0);
  assert.equal(r.n, 3);
  assert.ok(Math.abs(r.acc - 0.1) < 1e-9, `acc ${r.acc}`);
});

test('sub-step falls bank without shedding, then shed on the crossing', () => {
  const a = wakeStep(0, 0.2);
  assert.equal(a.n, 0);
  assert.ok(Math.abs(a.acc - 0.2) < 1e-9);
  const b = wakeStep(a.acc, 0.2); // 0.4 total crosses the 0.3 step
  assert.equal(b.n, 1);
  assert.ok(Math.abs(b.acc - 0.1) < 1e-9, `acc ${b.acc}`);
});

test('upward motion drains the bank WAKE_DRAIN times faster than it fills', () => {
  // 0.4 banked, a 0.1 kick up removes 0.2 of bank.
  const r = wakeStep(0.4, -0.1);
  assert.equal(r.n, 0);
  assert.ok(Math.abs(r.acc - 0.2) < 1e-9, `acc ${r.acc}`);
  // A big kick up empties the bank (floored at 0, never negative).
  const r2 = wakeStep(0.4, -0.5);
  assert.equal(r2.n, 0);
  assert.equal(r2.acc, 0);
});

test('no motion neither banks nor sheds', () => {
  const r = wakeStep(0.15, 0);
  assert.equal(r.n, 0);
  assert.ok(Math.abs(r.acc - 0.15) < 1e-9);
});

test('non-finite input is treated safely (NaN dy = no motion, NaN/Inf acc resets)', () => {
  assert.equal(wakeStep(0.1, NaN).n, 0);
  assert.ok(Math.abs(wakeStep(0.1, NaN).acc - 0.1) < 1e-9);
  // A NaN bank resets to 0, then the (finite) dy is banked as normal.
  const r = wakeStep(NaN, 5);
  assert.equal(r.n, 16);
  assert.ok(Math.abs(r.acc - (5 - 16 * WAKE_STEP)) < 1e-9, `acc ${r.acc}`);
  assert.equal(wakeStep(Infinity, NaN).n, 0);
});

test('wakeBank banks/drains without spending (hidden-row descent stays unspent)', () => {
  let a = 0;
  a = wakeBank(a, 1.0);
  assert.ok(Math.abs(a - 1.0) < 1e-9); // nothing spent: full row still banked
  a = wakeBank(a, 1.0);
  assert.ok(Math.abs(a - 2.0) < 1e-9);
  a = wakeBank(a, -0.5); // kick up drains 2x: 2.0 - 1.0
  assert.ok(Math.abs(a - 1.0) < 1e-9);
  assert.equal(wakeBank(0.4, -1.0), 0); // floored at 0
  assert.ok(Math.abs(wakeBank(0.1, NaN) - 0.1) < 1e-9);
  assert.equal(wakeBank(NaN, 0.5), 0.5);
});

test('a huge single-frame jump is capped at WAKE_CAP motes', () => {
  const r = wakeStep(0, 100);
  assert.equal(r.n, WAKE_CAP);
});