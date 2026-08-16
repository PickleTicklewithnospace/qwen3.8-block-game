// Mutation harness: reintroduce a known bug, confirm the suite catches it,
// then restore the file. Every mutation below is a bug that actually shipped
// (or a rule that would silently rot without a test guarding it).
//
// Usage: node test/mutate.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const MUTATIONS = [
  {
    name: 'lock delay advances by the gravity interval instead of real time',
    file: 'src/loop.js',
    from: '    t.lockTimer += dt;',
    to: '    t.lockTimer += gravityIntervalMs(game.level);',
  },
  {
    name: 'natural gravity ticks on top of the soft-drop repeat (unscored rows while holding Down)',
    file: 'src/loop.js',
    from: '  if (!input.soft) {\n    const interval = gravityIntervalMs(game.level);',
    to: '  if (true) {\n    const interval = gravityIntervalMs(game.level);',
  },
  {
    name: 'banked gravity is kept while blocked (teleport when sliding off a ledge)',
    file: 'src/loop.js',
    from: '        t.gravityAccum = 0;\n        break;',
    to: '        break;',
  },
  {
    name: 'a lock does not end the previous line-clear dash (new piece stays frozen)',
    file: 'src/loop.js',
    from: 'export function clearFreeze(t) {\n  t.freeze = 0;\n}',
    to: 'export function clearFreeze(t) {\n  // no-op\n}',
  },
  {
    name: 'lockPiece keeps the previous piece\'s clear state (stale clear FX on lock-out)',
    file: 'src/engine.js',
    from: '  game.lastClear = 0;\n  game.clearRows = [];\n',
    to: '',
  },
  {
    name: 'long frames are simulated in full (teleport after a stall)',
    file: 'src/loop.js',
    from: '  const dt = Math.min(Math.max(dtRaw, 0), MAX_FRAME_MS);',
    to: '  const dt = dtRaw;',
  },
  {
    name: 'auto-repeat banks while blocked by a wall',
    file: 'src/loop.js',
    from: "          t.arr = 0; // resting against a wall: don't bank repeats\n          break;",
    to: '          break;',
  },
  {
    name: 'lock timer is not cleared when the piece becomes airborne',
    file: 'src/loop.js',
    from: '  } else {\n    t.lockTimer = null;\n  }',
    to: '  } else {\n  }',
  },
  {
    name: 'the line-clear freeze does not block gravity',
    file: 'src/loop.js',
    from: '    t.freeze = Math.max(0, t.freeze - dt);\n    return;',
    to: '    t.freeze = Math.max(0, t.freeze - dt);',
  },
  {
    name: 'releasing one direction key drops the other still-held key',
    file: 'src/input.js',
    from: '  const i = input.held.indexOf(dir);\n  if (i >= 0) input.held.splice(i, 1);\n  return sync(input);\n}\n\nexport function clearDirs',
    to: '  if (input.dir === dir) input.held.length = 0;\n  return sync(input);\n}\n\nexport function clearDirs',
  },
  {
    name: 'a second direction press does not take over',
    file: 'src/input.js',
    from: '  const i = input.held.indexOf(dir);\n  if (i >= 0) input.held.splice(i, 1);\n  input.held.push(dir);',
    to: '  if (!input.held.includes(dir)) input.held.unshift(dir);',
  },
  {
    name: 'JLSTZ 2->L kick test 5 has the wrong vertical offset (T-spin/wall-kick drift)',
    file: 'src/pieces.js',
    from: "  '2>3': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],",
    to: "  '2>3': [[0, 0], [1, 0], [1, -1], [0, 2], [1, -2]],",
  },
  {
    name: 'I piece L->0 kick test 2 has the wrong horizontal offset',
    file: 'src/pieces.js',
    from: "  '3>0': [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],",
    to: "  '3>0': [[0, 0], [-1, 0], [-2, 0], [1, 2], [-2, -1]],",
  },
  {
    name: 'piece anchor y has the wrong sign (piece floats (n-1) cells high, ghost misses landing)',
    file: 'src/coords.js',
    from: '  return { x: toWorldX(x) + h, y: toWorldY(y) - h };',
    to: '  return { x: toWorldX(x) + h, y: toWorldY(y) + h };',
  },
  {
    name: 'hidden-row boundary off by one (piece/ghost visible one row too early, floating over the frame)',
    file: 'src/coords.js',
    from: '  return getCells(type, rotation).some(([r]) => y + r < hiddenRows);',
    to: '  return getCells(type, rotation).some(([r]) => y + r <= hiddenRows);',
  },
  {
    name: 'impact anchor uses the topmost locked cell instead of the lowest (spark fires from the top of the piece)',
    file: 'src/coords.js',
    from: '  let sx = 0;\n  let row = -Infinity;\n  for (const [x, y] of cells) {\n    sx += x;\n    if (y > row) row = y;\n  }',
    to: '  let sx = 0;\n  let row = Infinity;\n  for (const [x, y] of cells) {\n    sx += x;\n    if (y < row) row = y;\n  }',
  },
  {
    name: 'TETRIS banner threshold off by one (a 4-line clear no longer banners)',
    file: 'src/fx-labels.js',
    from: '  if (clears >= 4) return { text: \'TETRIS!\', tier: \'tetris\' };',
    to: '  if (clears >= 5) return { text: \'TETRIS!\', tier: \'tetris\' };',
  },
  {
    name: 'combo banner fires one streak too late (a 3-combo goes unannounced)',
    file: 'src/fx-labels.js',
    from: '  if (combo >= COMBO_BANNER_MIN) return { text: `COMBO \\u00d7${combo}`, tier: \'combo\' };',
    to: '  if (combo >= COMBO_BANNER_MIN + 1) return { text: `COMBO \\u00d7${combo}`, tier: \'combo\' };',
  },
  {
    name: 'stage palette drifts twice as fast per level (level colors collide early)',
    file: 'src/fx-labels.js',
    from: 'export const LEVEL_HUE_STEP = 0.055;',
    to: 'export const LEVEL_HUE_STEP = 0.11;',
  },
  {
    name: 'level 1 is not the neutral stage (off-by-one hue offset)',
    file: 'src/fx-labels.js',
    from: '  const h = (Math.max(1, level) - 1) * LEVEL_HUE_STEP;',
    to: '  const h = Math.max(1, level) * LEVEL_HUE_STEP;',
  },
  {
    name: 'streak banner ignition off by one (fires on level 11, misses level 10)',
    file: 'src/fx-labels.js',
    from: '  if (level >= STREAK_LEVEL && prevLevel < STREAK_LEVEL) {',
    to: '  if (level >= STREAK_LEVEL + 1 && prevLevel < STREAK_LEVEL + 1) {',
  },
  {
    name: 'streak wave ramp stretched twice as long (full rainbow delayed to level 40)',
    file: 'src/fx-labels.js',
    from: '  return Math.min(1, (level - STREAK_LEVEL + 1) / (STREAK_RAMP_LEVELS + 1));',
    to: '  return Math.min(1, (level - STREAK_LEVEL + 1) / (STREAK_RAMP_LEVELS + 1) / 2);',
  },
  {
    name: 'sourceRow off-by-one in the compaction inverse (shifted blocks settle from the wrong source row)',
    file: 'src/stack-diff.js',
    from: '    if (r >= s) s--;',
    to: '    if (r > s) s--;',
  },
  {
    name: 'sourceRow ignores how far below the cleared rows the source sits (rows settle one short)',
    file: 'src/stack-diff.js',
    from: '  let s = y;\n  for (const r of [...clearedRows].sort((a, b) => b - a)) {',
    to: '  let s = y - clearedRows.length + (clearedRows.length > 0 ? 1 : 0);\n  for (const r of [...clearedRows].sort((a, b) => b - a)) {',
  },
  {
    name: 'meteor fades out over the whole flight (no full-brightness middle)',
    file: 'src/meteor.js',
    from: '  return smooth(0, FADE_IN, u) * (1 - smooth(FADE_OUT_START, 1, u));',
    to: '  return smooth(0, FADE_IN, u) * (1 - smooth(0, 1, u));',
  },
  {
    name: 'meteor outlives its lifetime by 2x (keeps streaking long after it should be gone)',
    file: 'src/meteor.js',
    from: '  if (dt < 0 || dt > m.life) return null;',
    to: '  if (dt < 0 || dt > m.life * 2) return null;',
  },
  {
    name: 'perfect clear inverts the empty test (a full board counts as perfect, an empty one never does)',
    file: 'src/fx-labels.js',
    from: '  for (const row of board) {\n    for (const cell of row) if (cell !== null) return false;\n  }\n  return true;',
    to: '  for (const row of board) {\n    for (const cell of row) if (cell === null) return false;\n  }\n  return true;',
  },
  {
    name: 'perfect clear only inspects the bottom row (hidden/upper residue goes unnoticed)',
    file: 'src/fx-labels.js',
    from: '  for (const row of board) {\n    for (const cell of row) if (cell !== null) return false;\n  }\n  return true;',
    to: '  for (const cell of board[board.length - 1]) if (cell !== null) return false;\n  return true;',
  },
  {
    name: 'anamorphic flare attack stretched 4x (no bright punch-in on TETRIS)',
    file: 'src/fx-labels.js',
    from: '  const u = t < 0.1 ? t / 0.1 : 1;',
    to: '  const u = t < 0.4 ? t / 0.4 : 1;',
  },
  {
    name: 'anamorphic flare never decays (the streak lingers across the frame)',
    file: 'src/fx-labels.js',
    from: '  const dec = 1 - (d * d * (3 - 2 * d));',
    to: '  const dec = 1;',
  },
  {
    name: 'rotation echo fades linearly instead of the eased dissolve (no shape hold before it vanishes)',
    file: 'src/echo.js',
    from: '  return Math.pow(1 - k, 0.6);',
    to: '  return 1 - k;',
  },
  {
    name: 'rotation echo outlives its lifetime by 2x (afterimage lingers twice as long)',
    file: 'src/echo.js',
    from: 'export const ECHO_LIFE = 0.34;',
    to: 'export const ECHO_LIFE = 0.68;',
  },
  {
    name: 'stardust wake shedding threshold doubled (half the dust per fall, the trail thins out)',
    file: 'src/fall-dust.js',
    from: 'export const WAKE_STEP = 0.3;',
    to: 'export const WAKE_STEP = 0.6;',
  },
  {
    name: 'stardust wake drains on kicks at 1x instead of 2x (kicks bank dust the piece never earned)',
    file: 'src/fall-dust.js',
    from: 'export const WAKE_DRAIN = 2;',
    to: 'export const WAKE_DRAIN = 1;',
  },
  {
    name: 'stardust wake runaway guard removed (a huge frame jump sheds an unbounded burst)',
    file: 'src/fall-dust.js',
    from: '  while (acc >= WAKE_STEP && n < WAKE_CAP) {',
    to: '  while (acc >= WAKE_STEP) {',
  },
  {
    name: 'redline alarm saturates one row too low (well full before the alarm peaks)',
    file: 'src/danger.js',
    from: 'export const DANGER_FULL_ROW = 7;',
    to: 'export const DANGER_FULL_ROW = 6;',
  },
  {
    name: 'redline alarm ramps with depth instead of height (low stacks alarm, towers stay dark)',
    file: 'src/danger.js',
    from: '    return clamp01((DANGER_SAFE_ROW - top) / (DANGER_SAFE_ROW - DANGER_FULL_ROW));',
    to: '    return clamp01((top - DANGER_FULL_ROW) / (DANGER_SAFE_ROW - DANGER_FULL_ROW));',
  },
];

function runSuite() {
  try {
    execFileSync(
      'node',
      [
        '--test',
        'test/engine.test.js',
        'test/loop.test.js',
        'test/input.test.js',
        'test/predict.test.js',
        'test/stack-diff.test.js',
        'test/pieces.test.js',
        'test/coords.test.js',
        'test/fx-labels.test.js',
        'test/meteor.test.js',
        'test/echo.test.js',
        'test/fall-dust.test.js',
        'test/danger.test.js',
      ],
      {
        stdio: 'pipe',
        env: { ...process.env, OPENSSL_CONF: '/dev/null' },
      },
    );
    return { failed: 0, names: [] };
  } catch (e) {
    const out = String(e.stdout || '') + String(e.stderr || '');
    const names = [...out.matchAll(/^✖ (.+?) \(/gm)].map((m) => m[1]);
    return { failed: names.length, names };
  }
}

const baseline = runSuite();
if (baseline.failed !== 0) {
  console.log('BASELINE ALREADY FAILING:', baseline.names.join(', '));
  process.exit(1);
}
console.log('baseline: all green\n');

let survivors = 0;
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, 'utf8');
  if (!original.includes(m.from)) {
    console.log(`SKIP (pattern not found) ${m.name}`);
    survivors++;
    continue;
  }
  writeFileSync(m.file, original.replace(m.from, m.to));
  const r = runSuite();
  writeFileSync(m.file, original);
  if (r.failed === 0) {
    survivors++;
    console.log(`SURVIVED (not caught!) ${m.name}`);
  } else {
    console.log(`KILLED  (${r.failed} test${r.failed === 1 ? '' : 's'}) ${m.name}`);
    console.log(`        caught by: ${r.names.slice(0, 3).join(' | ')}`);
  }
}

// Restoring must leave the suite green (guards against a botched restore).
const after = runSuite();
console.log(`\nmutations: ${MUTATIONS.length}, survivors: ${survivors}`);
console.log(`post-restore suite: ${after.failed === 0 ? 'green' : 'RED'}`);
process.exit(survivors === 0 && after.failed === 0 ? 0 : 1);
