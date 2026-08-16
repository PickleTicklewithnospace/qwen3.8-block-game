// Horizontal key tracking (src/input.js). The rule under test: whatever
// direction key is physically held must keep driving the piece, no matter in
// what order the keys were pressed and released.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDirInput, pressDir, releaseDir, clearDirs } from '../src/input.js';

test('fresh press sets the direction and reports the change', () => {
  const i = createDirInput();
  assert.equal(pressDir(i, -1), true);
  assert.equal(i.dir, -1);
});

test('newest press wins while both keys are held', () => {
  const i = createDirInput();
  pressDir(i, -1);
  assert.equal(pressDir(i, 1), true);
  assert.equal(i.dir, 1);
});

test('releasing the active key falls back to the still-held key', () => {
  const i = createDirInput();
  pressDir(i, -1);
  pressDir(i, 1);
  // Historically this stopped all movement even though Left was still down,
  // and no further keydown ever arrived to restart it.
  assert.equal(releaseDir(i, 1), true, 'direction change reported');
  assert.equal(i.dir, -1);
});

test('releasing the inactive key does not change the direction', () => {
  const i = createDirInput();
  pressDir(i, -1);
  pressDir(i, 1);
  assert.equal(releaseDir(i, -1), false);
  assert.equal(i.dir, 1);
});

test('releasing the last key stops movement', () => {
  const i = createDirInput();
  pressDir(i, 1);
  assert.equal(releaseDir(i, 1), true);
  assert.equal(i.dir, 0);
  assert.deepEqual(i.held, []);
});

test('re-pressing a held key promotes it to the active direction', () => {
  const i = createDirInput();
  pressDir(i, -1);
  pressDir(i, 1);
  assert.equal(pressDir(i, -1), true);
  assert.equal(i.dir, -1);
  assert.equal(i.held.length, 2, 'no duplicate entries');
});

test('repeated presses never grow the held stack', () => {
  const i = createDirInput();
  for (let n = 0; n < 50; n++) {
    pressDir(i, -1);
    pressDir(i, 1);
  }
  assert.equal(i.held.length, 2);
});

test('releasing a key that was never pressed is a no-op', () => {
  const i = createDirInput();
  pressDir(i, 1);
  assert.equal(releaseDir(i, -1), false);
  assert.equal(i.dir, 1);
});

test('clearDirs (focus loss) drops every held key', () => {
  const i = createDirInput();
  pressDir(i, -1);
  pressDir(i, 1);
  assert.equal(clearDirs(i), true);
  assert.equal(i.dir, 0);
  assert.deepEqual(i.held, []);
  assert.equal(clearDirs(i), false, 'already clear');
});

test('invalid directions are rejected', () => {
  const i = createDirInput();
  assert.equal(pressDir(i, 0), false);
  assert.equal(pressDir(i, 2), false);
  assert.deepEqual(i.held, []);
  assert.equal(i.dir, 0);
});

test('every press/release sequence leaves dir consistent with held keys', () => {
  // Exhaustive over all sequences of 6 events on 2 keys.
  const events = [
    ['press', -1], ['press', 1], ['release', -1], ['release', 1],
  ];
  const walk = (i, held, depth) => {
    // Invariant: dir is 0 iff nothing is held, and is always a held key.
    if (i.dir === 0) assert.equal(held.size, 0, 'dir 0 but keys held');
    else assert.ok(held.has(i.dir), `dir ${i.dir} not held`);
    if (depth === 0) return;
    for (const [kind, dir] of events) {
      const snapshot = { held: [...i.held], dir: i.dir };
      const nextHeld = new Set(held);
      if (kind === 'press') { pressDir(i, dir); nextHeld.add(dir); }
      else { releaseDir(i, dir); nextHeld.delete(dir); }
      walk(i, nextHeld, depth - 1);
      i.held = snapshot.held;
      i.dir = snapshot.dir;
    }
  };
  walk(createDirInput(), new Set(), 6);
});
