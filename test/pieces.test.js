// SRS compliance tests for src/pieces.js.
//
// The wall-kick table is the part of the rotation system that is easiest to
// get subtly wrong and hardest to notice in play: a single flipped kick only
// changes behaviour in specific wall/floor situations, so the behavioural
// tests (rotation succeeds, stays in bounds) pass even with a wrong table.
// These tests pin every kick value to the official Tetris Guideline SRS data
// so the table can never silently drift.
//
// Reference: tetris.wiki/Super_Rotation_System. The wiki states kicks with
// +y = up; this engine uses +y = down, so the reference is converted below.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PIECES, PIECE_TYPES, getCells, getKicks } from '../src/pieces.js';

// Official SRS kick data, +y = up, exactly as published. Keys are "from>to"
// using SRS state names mapped to this engine's numeric states
// (0=spawn, 1=R, 2=180, 3=L).
const OFFICIAL_JLSTZ = {
  '0>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '1>0': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '1>2': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '2>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '2>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '3>2': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '3>0': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '0>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
};

const OFFICIAL_I = {
  '0>1': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '1>0': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '1>2': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
  '2>1': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '2>3': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '3>2': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '3>0': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '0>3': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
};

// Convert +y=up reference data to this engine's +y=down convention.
// (+0 normalizes the -0 that negating a zero would otherwise produce.)
const toYDown = (table) =>
  Object.fromEntries(
    Object.entries(table).map(([k, kicks]) => [
      k,
      kicks.map(([x, y]) => [x + 0, -y + 0]),
    ]),
  );

const OFFICIAL = {
  I: toYDown(OFFICIAL_I),
  J: toYDown(OFFICIAL_JLSTZ),
  L: toYDown(OFFICIAL_JLSTZ),
  S: toYDown(OFFICIAL_JLSTZ),
  T: toYDown(OFFICIAL_JLSTZ),
  Z: toYDown(OFFICIAL_JLSTZ),
};

const TRANSITIONS = ['0>1', '1>0', '1>2', '2>1', '2>3', '3>2', '3>0', '0>3'];

// The O piece never changes shape, so it has a single no-kick (covered by its
// own test below); the five-kick SRS table applies to the other six.
const SRS_PIECES = PIECE_TYPES.filter((t) => t !== 'O');

test('every kick value matches the official SRS table (all pieces, all transitions)', () => {
  let checked = 0;
  for (const type of SRS_PIECES) {
    for (const key of TRANSITIONS) {
      const from = Number(key[0]);
      const to = Number(key[2]);
      const repo = getKicks(type, from, to);
      const official = OFFICIAL[type][key];
      assert.equal(repo.length, 5, `${type} ${key}: expected 5 kick tests`);
      for (let i = 0; i < 5; i++) {
        assert.deepEqual(
          repo[i],
          official[i],
          `${type} ${key} test ${i + 1}: got [${repo[i]}], official SRS is [${official[i]}]`,
        );
        checked++;
      }
    }
  }
  // 6 pieces x 8 transitions x 5 tests.
  assert.equal(checked, 6 * 8 * 5);
});

test('kick test 1 is always the no-kick (0,0)', () => {
  for (const type of PIECE_TYPES) {
    for (const key of TRANSITIONS) {
      const from = Number(key[0]);
      const to = Number(key[2]);
      assert.deepEqual(getKicks(type, from, to)[0], [0, 0], `${type} ${key} test 1`);
    }
  }
});

test('kick table is antisymmetric: kick(A->B) is the negation of kick(B->A)', () => {
  // SRS kicks derive from per-state offsets, so rotating A->B and B->A must
  // be exact mirror images. A single hand-edited value breaks this.
  const pairs = [
    ['0>1', '1>0'],
    ['1>2', '2>1'],
    ['2>3', '3>2'],
    ['0>3', '3>0'],
  ];
  // Negating 0 yields -0, which deepStrictEqual treats as distinct from 0;
  // normalize with +0.
  const neg = (v) => -v + 0;
  for (const type of SRS_PIECES) {
    for (const [ab, ba] of pairs) {
      const kAb = getKicks(type, Number(ab[0]), Number(ab[2]));
      const kBa = getKicks(type, Number(ba[0]), Number(ba[2]));
      for (let i = 0; i < 5; i++) {
        assert.deepEqual(
          kBa[i],
          [neg(kAb[i][0]), neg(kAb[i][1])],
          `${type}: ${ba} test ${i + 1} is not the negation of ${ab} test ${i + 1}`,
        );
      }
    }
  }
});

test('J/L/S/T/Z all share the identical kick table (SRS uses one table for the five)', () => {
  const jlstz = ['J', 'L', 'S', 'T', 'Z'];
  for (const key of TRANSITIONS) {
    const from = Number(key[0]);
    const to = Number(key[2]);
    for (const type of jlstz.slice(1)) {
      assert.deepEqual(
        getKicks(type, from, to),
        getKicks('J', from, to),
        `${type} ${key} diverges from the shared JLSTZ table`,
      );
    }
  }
});

test('O piece has only the no-kick (it never changes shape)', () => {
  for (const key of TRANSITIONS) {
    const from = Number(key[0]);
    const to = Number(key[2]);
    assert.deepEqual(getKicks('O', from, to), [[0, 0]], `O ${key}`);
  }
});

test('each rotation state is a pure CW rotation of the previous about the box center', () => {
  // Guards the shape data itself: state r+1 must be state r rotated 90deg CW
  // within the bounding box. (Kept here with the kick tests because together
  // they define the full SRS rotation behaviour.)
  const norm = (cells) => cells.map(([r, c]) => `${r},${c}`).sort().join('|');
  for (const type of PIECE_TYPES) {
    const n = PIECES[type].size;
    for (let r = 0; r < 4; r++) {
      const expected = norm(getCells(type, r).map(([rr, cc]) => [cc, n - 1 - rr]));
      const actual = norm(getCells(type, (r + 1) % 4));
      assert.equal(actual, expected, `${type} rot ${r} -> ${(r + 1) % 4}`);
    }
  }
});
