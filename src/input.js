// Horizontal key tracking.
//
// Players roll fingers between Left and Right, so both keys are frequently
// down at once. Tracking a single `dir` breaks in two ways:
//   - press Left, press Right, release Right => movement stops although
//     Left is still held (and no further keydown arrives to restart it);
//   - press Left, press Right, release Left => the old code kept moving
//     left because it only compared the released key to the active dir.
// This module keeps a press-ordered stack: the newest held direction wins,
// and releasing it falls back to whatever is still down.

export function createDirInput() {
  return { held: [], dir: 0 };
}

// Returns true when the active direction changed (caller should perform an
// immediate move and restart the DAS charge).
export function pressDir(input, dir) {
  if (dir !== -1 && dir !== 1) return false;
  const i = input.held.indexOf(dir);
  if (i >= 0) input.held.splice(i, 1);
  input.held.push(dir);
  return sync(input);
}

export function releaseDir(input, dir) {
  const i = input.held.indexOf(dir);
  if (i >= 0) input.held.splice(i, 1);
  return sync(input);
}

export function clearDirs(input) {
  input.held.length = 0;
  return sync(input);
}

function sync(input) {
  const next = input.held.length ? input.held[input.held.length - 1] : 0;
  const changed = next !== input.dir;
  input.dir = next;
  return changed;
}
