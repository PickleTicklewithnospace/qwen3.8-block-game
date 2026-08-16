import { test } from 'node:test';
import assert from 'node:assert';
import {
  meteorState,
  meteorFade,
  meteorTailAngle,
  meteorSpawnSpec,
  FADE_IN,
  FADE_OUT_START,
} from '../src/meteor.js';

// A reference flight: from (10, 24) at t=5, velocity (-20, -8), life 1.25 s.
const m = { x0: 10, y0: 24, vx: -20, vy: -8, z: -30, t0: 5, life: 1.25, tail: 5 };

test('meteorState: null before t0 and after t0+life', () => {
  assert.equal(meteorState(m, 4.999), null);
  assert.equal(meteorState(m, 6.251), null);
});

test('meteorState: position is linear in the flight and u tracks the life', () => {
  const s = meteorState(m, 5.625); // half life
  assert.ok(Math.abs(s.u - 0.5) < 1e-9, `u=${s.u}`);
  assert.ok(Math.abs(s.x - -2.5) < 1e-9, `x=${s.x}`); // 10 + -20*0.625
  assert.ok(Math.abs(s.y - 19) < 1e-9, `y=${s.y}`); // 24 + -8*0.625
});

test('meteorState: endpoints are the spawn point and the end of the flight', () => {
  const a = meteorState(m, 5);
  assert.ok(Math.abs(a.x - 10) < 1e-9 && Math.abs(a.y - 24) < 1e-9);
  const b = meteorState(m, 6.25);
  assert.ok(Math.abs(b.x - -15) < 1e-9, `x=${b.x}`); // 10 + -20*1.25
  assert.ok(Math.abs(b.y - 14) < 1e-9, `y=${b.y}`); // 24 + -8*1.25
});

test('meteorFade: zero at both ends, full in the bright middle band', () => {
  assert.equal(meteorFade(0), 0);
  assert.equal(meteorFade(1), 0);
  assert.equal(meteorFade(-0.1), 0);
  assert.equal(meteorFade(1.1), 0);
  assert.ok(meteorFade(0.4) > 0.99, `f(0.4)=${meteorFade(0.4)}`);
  assert.ok(meteorFade(0.5) > 0.99);
});

test('meteorFade: still fading in inside the fade-in window', () => {
  assert.ok(meteorFade(FADE_IN * 0.5) < 1);
  assert.ok(meteorFade(FADE_IN * 0.5) > meteorFade(0));
});

test('meteorFade: rises monotonically up to the fade-out window start', () => {
  let prev = -1;
  for (let u = 0; u <= FADE_OUT_START + 1e-9; u += 0.01) {
    const v = meteorFade(u);
    assert.ok(v >= prev - 1e-9, `u=${u}`);
    prev = v;
  }
});

test('meteorTailAngle: points the bright end along the velocity', () => {
  assert.ok(Math.abs(meteorTailAngle(1, 0)) < 1e-9);
  assert.ok(Math.abs(meteorTailAngle(-1, 0) - Math.PI) < 1e-9);
  const a = meteorTailAngle(3, -4);
  assert.ok(Math.abs(Math.atan2(-4, 3) - a) < 1e-9, `a=${a}`);
});

test('meteorSpawnSpec: a side entry falling through the sky band', () => {
  for (let i = 0; i < 300; i++) {
    const s = meteorSpawnSpec(7.5);
    assert.ok(s.x0 !== 0);
    assert.ok(Math.sign(s.vx) === -Math.sign(s.x0), 'falls toward the center');
    assert.ok(s.vx !== 0 && s.vy < 0, 'moving, falling');
    assert.ok(s.y0 >= 20 && s.y0 <= 27, `y0=${s.y0}`); // above the frame top
    assert.ok(s.z === -30, 'in front of the aurora plane, behind the board');
    assert.ok(s.life >= 0.9 && s.life <= 1.4, `life=${s.life}`);
    assert.ok(s.tail >= 4.5 && s.tail <= 7, `tail=${s.tail}`);
    assert.equal(s.t0, 7.5);
  }
});