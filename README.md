# Tetris 3D

Browser-based Tetris rendered in 3D with three.js: crystal blocks (glowing
core + fresnel rim + a baked studio environment (IBL) + a key-light facet
sparkle, so every block reads as a light-catching gemstone), neon board
frame, bloom post-processing,
starfield + animated aurora sky + ambient light-dust (a field of fine
particles drifting up through the stage air, each twinkling on its own
phase with a few hot sparkles that bloom as air-glints — the field re-inks
with the level palette, doubles in the mirror glass and dims with the
game-over lights-out, keeping the stage alive between FX moments),
frosted glass board, mirror stage floor (a real planar mirror re-renders the
scene below the floor — stack, trails and clear FX are all doubled in the
glass, under a neon grid), smooth piece slide/spin animation, hard-drop
light trails (one streak of light per occupied column, from release to
landing), lock-impact splashes (every lock sends a piece-colored pool of
light + a sonic ring spreading across the mirror floor, with a spark puff at
the base of the piece — hard drops splash harder), and a dramatic line-clear
FX suite (a light sweep that rips across the full board width over the
cleared run — hot edge + palette-tinted glow trail, alternating direction
per clear, hotter and longer on TETRIS — plus a hot core flash bar,
expanding elliptical shockwave ripples, rising energy shards, spark bursts,
row-count-scaled camera shake + aurora pulse, and a radial TETRIS screen
flash), a row-collapse settle (the rows above a clear slide down from
their source rows with a soft bounce while the stage camera dips with the
weight of the fall), 3D popup banners (glowing "TETRIS!" / "LEVEL N" / "COMBO ×N" /
"TRIPLE" / "DOUBLE" type that pops in front of the board on major events,
with a cinematic dolly-in camera punch on TETRIS, and — on TETRIS and the
streak ignition — an anamorphic lens flare: a wide cool-blue streak that
rips across the whole frame (a bloom-carrying 3D streak quad in front of
the banner, doubled in the mirror glass, plus a full-width screen-space
streak with a vertical ghost and an offset echo in the cinematic grade
pass), both fading on the same fast-attack/slow-decay envelope), a level palette that
re-inks the whole stage as you level up (aurora sky, neon frame, glow bar,
stage grids and sky all ease over to the level's hue, while the level-up
moment flares the aurora, sends a wide sonic ring across the mirror glass
and fires a gold spark fountain off the glow bar), a game-over cinematic
that powers the whole stage down (a persistent glowing GAME OVER banner, the
settled stack dissolving top-down into slow colored embers while the
aurora/stars/neon frame/bloom dim and the camera pushes back off stage), holographic
hold + next-queue displays (the held piece and the 3-deep next queue are
projected as mini holo pieces in cradle rings flanking the board, lit by
light pillars from the mirror floor and emitter pools on the glass — all
doubled by the mirror — and a hold swap flares the hold-side emitter with
a small floor ripple in the piece's color), theatrical rafter
spotlights (three volumetric light shafts rake down from just above the
frame into the top of the well — a central beam and two raked side beams,
each with a hot lamp cap at its source and a pool of light landing on the
well's top edge — the beams sit behind the frosted panel so they live in
the sky band and side gaps, they flare on clears and level-ups, re-ink
with the level palette and dim with the game-over lights-out), sky meteors
(rare shooting stars streak across the aurora band — a hot round head
leading a trailing light tail with a slow spark drizzle shedding off the
head; they wait for the stage to settle, re-arm after a restart, pause
under the game-over lights-out while in-flight ones dim with the stage, and
re-ink with the level palette), streak mode
(from level 10 the settled stack ignites into a living rainbow — every
block's hue drifts as a wave travelling across the board, ramping from a
faint tint to a full rainbow by level 20, while the active piece stays
pure; the ignition moment fires a full-board rainbow light sweep, a stage
surge, a sonic ring across the mirror glass and a STREAK banner), the
perfect-clear celebration (when a line clear empties the well to ZERO
blocks — the pure, unit- + mutation-tested boardEmpty signal — the stage
throws the whole show: a gold-white PERFECT CLEAR! banner floating above
the TETRIS banner a 4-line perfect carries, with its warm anamorphic
flare and dolly punch, the full-screen bloom flash, a full-board rainbow
light sweep, a double sonic ring across the mirror glass, a gold spark
fountain off the well center and the stage surge), the holographic
rotation echo (every successful rotation flashes the piece's PRE-rotation
footprint as a holo afterimage — the same shared shader as the ghost
faces, per-slot fade so concurrent echoes dissolve independently — that
swells slightly and fades out in ~0.34 s; a tick-time throttle keeps
rotation flicker from stacking a wall of afterimages, pieces in the
hidden spawn field cast no echo (it would poke above the frame, like the
ghost), the game-over lights out kills in-flight echoes and restart
re-arms the pool), the stardust wake
(as the active piece descends it sheds piece-colored stardust off its
rendered base — fine motes drifting up off the body in zero gravity plus
occasional hot glints that bloom as air-glints; pieces in the hidden
spawn field bank their descent and shed it as a burst the moment they
materialize into the visible field, hard drops shed nothing because the
fresh spawn that follows drains the bank, and the game-over lights out
kills in-flight motes; the pure accumulator is unit- + mutation-guarded
in src/fall-dust.js), the redline alarm
(as the settled stack climbs toward the top of the well the whole stage
turns crimson and pulses like a heartbeat — the neon frame, side rails,
glow bar (heartbeat-bright so its bloom thumps) and mirror/panel grids
re-ink toward the alarm red, the aurora sky washes crimson, and the
cinematic grade adds a pulsing red edge-glow; the level ramps linearly
from a stack top 5 visible rows under the well top to full alarm, the
pure math is unit- + mutation-guarded in src/danger.js, the alarm hands
off to the game-over lights out and restart restores the neutral stage),
and
a final cinematic
grade on the presented frame (film vignette
with a cool shadow lift, lens chromatic aberration, 24fps film grain).
Vanilla ES modules, no build step.

## Play

```sh
npm start          # serves on http://localhost:8901
```

Open http://localhost:8901.

## Controls

- ← / → — move (with DAS/ARR auto-repeat)
- ↓ — soft drop
- ↑ / X — rotate clockwise, Z — rotate counter-clockwise (SRS wall kicks)
- Space — hard drop
- C / Shift — hold
- P — pause (auto-pauses when the tab is hidden)
- R — restart

## Mechanics

- 10×20 field with 2 hidden spawn rows
- 7-bag randomizer (seeded, deterministic)
- SRS rotation with full wall-kick tables (JLSTZ + I)
- Ghost piece, hold (once per drop), 5-piece next queue (3 shown)
- Lock delay (500 ms, up to 15 move/rotate resets)
- Scoring: 100/300/500/800 × level per 1/2/3/4 lines, +1/row soft drop, +2/row hard drop
- Level up every 10 lines; classic gravity curve (1000 ms at level 1, floor 30 ms)
- High score persisted in localStorage
- Game over on spawn collision or lock-out above the visible field
- Piece and ghost are hidden while any cell is in the hidden spawn rows (the
  board frame only covers the visible field); they appear exactly on their
  cells the moment they cross the top edge

## Tests

```sh
npm test           # unit tests for the pure game/timing modules (node:test, no deps)
npm run test:mutation   # reintroduces known bugs and proves the tests catch them
npm run test:browser    # gameplay regressions in a real browser (needs npm start)
```

- `test/engine.test.js` — unit tests: bag randomizer, movement, SRS kicks,
  scoring, line clears, levels, hold, game-over conditions, gravity curve,
  per-lock clear state (a lock-out lock replays no clear).
- `test/loop.test.js` — frame-timing tests driven by a synthetic clock: lock
  delay (real time, level-independent, reset budget), sliding under an
  overhang, gravity rate, long-frame clamping, no banked gravity/ARR, soft-drop
  rate and scoring (soft drop owns the fall: no unscored shadow-gravity rows
  while holding Down, accumulator frozen), DAS/ARR, the line-clear freeze
  (a lock/hold ends the previous dash via clearFreeze), pause/game-over.
- `test/input.test.js` — horizontal key tracking, including an exhaustive walk
  over all 6-event press/release sequences on both arrow keys.
- `test/predict.test.js`, `test/stack-diff.test.js` — landing/clear prediction
  and renderer stack reconciliation (property + fuzz tests).
- `test/pieces.test.js` — SRS compliance: pins all 240 wall-kick values to the
  official Guideline table (a single flipped kick only changes behaviour in
  specific wall/floor situations, so behavioural tests alone can't catch it),
  plus the antisymmetry invariant, the shared JLSTZ table, the O no-kick, and
  the pure-rotation shape invariant.
- `test/coords.test.js` — board<->world coordinate invariant: anchor + block
  offset lands every block of every piece exactly on its board cell (the anchor
  y term must subtract the half-box, since world +y is up but board +y is down;
  a sign error makes pieces float (n-1) cells high and the ghost miss its
  landing position). Also pins anyHiddenCell: the piece/ghost hidden-row
  visibility boundary for every piece/rotation (exhaustive row sweep + exact
  flip row + concrete spawn boundaries).
- `test/mutate.mjs` — mutation harness: each entry reintroduces a bug that
  actually shipped and asserts the suite goes red, then restores the file.
  Fails if any mutant survives (currently 15 mutations, all killed).
- `test/lock-delay.mjs` — browser regression for lock delay, sliding under an
  overhang, held-key fallback and soft-drop speed in the running game.
- `test/post-clear.mjs`, `test/stack-colors.mjs` — browser regressions for
  gameplay and materials after real line clears; post-clear.mjs also covers
  locking mid-dash (the new piece must not inherit the dash's freeze) and the
  game-over screen (the final piece must not render twice).
- `test/piece-position.mjs` — browser regression that the live 3D piece and
  ghost render at their true board positions (expected anchor computed
  independently of the renderer, so a wrong anchor can't match itself); also
  checks a piece rests flush on the stack with no floating gap.
- `test/hidden-rows.mjs` — browser regression that the piece and ghost are
  hidden while any cell is in the hidden spawn rows and appear exactly on
  their cells at the boundary (live spawn, exact boundary row for every
  piece/rotation, ghost hidden when its landing is partly hidden, no position
  jump across the boundary); expected visibility computed independently of the
  renderer, mutation-verified.
- `test/harddrop-trail.mjs` — browser regression for the hard-drop light
  trails: one streak per occupied column with the exact swept span (start row
  -> landing row) computed independently from piece state + ghostY, trails
  fade out and hide, and neither a natural lock nor a grounded hard drop
  (d = 0) spawns a trail.
- `test/mirror-floor.mjs` — browser regression for the mirror stage floor:
  the Reflector is live, the bottom glow bar's reflection is bright cyan at
  its exact projected virtual-image point, and placed blocks' reflections are
  found by scanning a vertical window in the block's column (the Reflector's
  mirror camera shifts the z=0 mapping ~20-30px vs a naive virtual-image
  projection), diffed against the same window in an empty column so only the
  block's own reflection counts; also pins the stage framing (board base in
  the lower screen wedge) and that gameplay still locks with the mirror pass
  active.
- `test/lock-impact.mjs` — browser regression for the lock-impact splash:
  every lock spawns one pooled splash (soft radial light disc + thin ring on
  the mirror floor, tinted by the piece) at the lock centroid computed
  independently from the engine's post-lock board state, with a spark puff at
  the base of the locked piece; the splash is proven at pixel level with a
  TEMPORAL diff (luminance grid on the floor captured pre-drop and again
  mid-expansion — the floor's bright aurora reflection makes spatial controls
  unreliable, and the hard-drop trail reflection owns the center column, so
  the diff excludes it); a natural lock splashes softer, a partial-clear lock
  anchors on POST-CLEAR cells (the pre-clear centroid is 0.5 world units off),
  and a full-clear lock (all locked cells destroyed) spawns no splash.
- `test/ghost-holo.mjs` — browser regression for the holographic ghost
  projector: the ghost face is the holo shader (fresnel silhouette +
  world-space scanlines), a light pillar runs from the mirror floor to the
  ghost's lowest cell in the ghost's anchor column, and an emitter pool of
  light sits on the mirror glass under it; all three follow the ghost's
  visibility exactly (no-fall, hidden-row landing, game over, restart). The
  emitter pool is proven with a TEMPORAL floor diff (baseline piece parked in
  a far column so its own reflections can't mask the pool); the tall
  in-field pillar is proven SPATIALLY against the same heights in a
  neighbor column with no pillar (immune to capture-interval camera drift);
  the scanline shimmer is proven as inter-frame pixel variance in the ghost
  window vs a static panel control window; a T landing on a stack via one
  occupied column (the other two float) pins the pillar through an open
  column, and a taper pin catches a pillar that would fill its whole column.
- `test/crystal-ibl.mjs` — browser regression for the crystal gem lighting:
  the PMREM studio environment is baked into `scene.environment` and the
  per-material key-light sparkle uniform is installed on both the hero piece
  (sparkles harder) and the settled stack; the sparkle is proven by an A/B
  toggle (the test zeros `material.userData.specUniform`, renders, and
  compares), showing a lone stack block gains a localized bright glint (peak
  Δ + a handful of hot pixels) while empty space (piece hidden in the hidden
  rows, no blocks on screen) gains ~none — so the sparkle lights blocks, not
  the sky — and a dense realistic stack keeps the added lighting under the
  3% white grade.
- `test/cinematic-grade.mjs` — browser regression for the final cinematic
  grade pass (vignette + lens chromatic aberration + 24fps film grain, all
  A/B-isolated by zeroing each uniform on `gradePass.uniforms`): the four
  screen corners measure ~25% darker with the grade than without while the
  center is untouched; the CA fringe is proven by GATED |ΔL| (only pixels
  locally sharp in the no-CA frame count) on the board frame's top neon line
  (~10x larger than on the cleanest star-free sky window — star positions
  come from the renderer's own Points attributes since per-load star
  placement is unseeded; the sky window is chosen from candidates that
  reject windows overlapping the projected rafter-spot beams first, since
  the beams' bright caps/bloom rims are locally sharp and fringe under CA
  like a real feature — the beam-free sky lives in the narrow side slivers
  outside the outer beams); grain is proven as per-pixel neighbor roughness in
  smooth sky rising above the no-grain baseline AND animating between frames
  200ms apart; a dense stack keeps the white-clip grade under 3%.
- `test/popup-banner.mjs` — browser regression for the 3D popup banners +
  the TETRIS camera dolly punch: a 4-line clear (vertical I into a
  single-column gap across four rows) spawns the rainbow TETRIS! banner —
  proven at pixel level by an A/B capture that hides the live banner meshes,
  renders, restores them, renders again, and diffs the banner's projected
  region (the diff is the banner's own pixels + bloom halo) against a far
  sky control; double/triple/level-up (with the concurrent COMBO priority
  pinned)/combo banners spawn the right text + tier, banners fade out and
  hide, a lone single clear after a restart (combo reset) spawns nothing,
  and the TETRIS banner fires the dolly (renderer.camPunch > 0).
- `test/gameover-cinematic.mjs` — browser regression for the game-over
  "lights out" cinematic: a lock-out on a dense 7-hue tower enters the
  cinematic (persistent GAME OVER banner + top-down dissolve schedule +
  star dim on the first tick); mid-ramp the banner is proven at pixel level
  by an A/B that hides its mesh between two synchronous renders and takes
  the MAX per-pixel |ΔL| over the banner's full projected band (a mean diff
  washes out where the curtain behind it is bright) against a far-corner
  control, while slow embers (dissolve gravity < the line-clear 16) are
  live, the camera pushes back and bloom dims below base; at full ramp the
  tower is fully dissolved, per-frame setStack never resurrects dissolved
  cells, the aurora curtains measure dimmed at the same projected sky
  points as the lit baseline, and frame/stars/glow-bar are at ember level;
  restart restores full lights and the stack rebuilds, and a second game
  over re-arms the whole sequence.
- `test/level-palette.mjs` — browser regression for the level palette: a
  1->2 level-up (a 1-line clear crossing the line threshold) fires the
  aurora surge + gold spark fountain and the level ring, proven at pixel
  level by a synchronous A/B that hides ONLY the k=2.2 splash-pool entry
  between two renders and diffs (floor 133 vs sky 1.0 max |ΔL|); the stage
  hue then eases to levelHue(2) (uHue uniform, neon frame, glow bar, grid
  vertex colors, sky background all re-inked — the glow bar's re-ink proven
  by a pixel band A/B after every transient expires), a 2->3 level-up shifts
  it further, and restart restores the exact neutral level-1 stage.
- `test/row-collapse.mjs` — browser regression for the row-collapse settle:
  a single clear registers exactly one slide per shifted visible cell
  (3 markers + 2 surviving O cells; a double clear with the O destroyed
  whole registers only the 3 markers), each slide's fromY/toY match
  independent toWorldY math, an in-page rAF loop catches the block
  strictly in transit between source and target row (a teleport would
  never be observed), settle ends with the meshes exactly on their
  resting rows and the engine board matching, pixels prove the move with
  same-frame SPATIAL pairs in the marker column (the block cell vs the
  empty neighbor cell cancels the aurora showing through the frosted
  back panel — absolute empty-cell levels are aurora-dependent), and a
  no-clear lock settles nothing while restart clears all collapse state.
- `test/holo-queue.mjs` — browser regression for the holographic hold +
  next-queue stage displays: the next slots mirror the engine queue
  (3-deep), the hold starts as a bare cradle, and both display columns
  render on screen (synchronous A/B — hide the display groups between two
  composer.render() calls in ONE in-page evaluate, so grain/aurora/camera
  cancel exactly and the diff is purely the feature; a far-sky control
  stays flat). A hold swap runs through the real `doHold` entry point
  inside one synchronous evaluate (no tick can fire between the state
  capture and the action): the swapped piece pops into the hold display,
  the queue shifts, the hold side pings (emitter flare + a floor ripple
  recorded as renderer state), and a second hold on the same drop is a
  no-op; the hold display's pixels are isolated by A/B with the next
  column as a same-frame spatial control; the emitter pool lights the
  mirror floor (A/B with the aurora dimmed so the additive pool can't
  clip); a hard drop's spawn follows the next display; game over powers
  the displays down with the stage and restart re-arms them.
- `test/light-sweep.mjs` — browser regression for the line-clear light
  sweep, proven from ONE in-page rAF probe per clear (started before the
  drop so the short mid-flight window can't be missed; the probe promise
  is pinned on window so slow SwiftShader frames can't GC it): one sweep
  fires per contiguous run (`swept` counter), the wipe direction
  alternates between back-to-back clears (renderer parity, not test
  re-arming), in-transit samples (t, x read atomically in the same frame)
  sit strictly inside the sweep span on the constant-velocity line
  x = lerp(xA, xB, t) and advance monotonically with dir, and a
  synchronous A/B inside the same frame that catches the wipe mid-flight
  (hide the sweep groups between two composer.render() calls) shows the
  row band differing strongly while a control band well above the run's
  TOP edge stays flat — a center-relative control band sits inside the
  bloom halo of a tall hot sweep; a TETRIS run carries the tall (h=4) hot
  (gain 1.75) longer (dur > 0.42s) signature, a no-clear lock spawns
  nothing, and restart resets the pool.
- `test/ambient-dust.mjs` — browser regression for the ambient light-dust
  field: the additive soft-sprite `Points` layer is live in the scene with
  the full stage volume populated (plus a minority of bright "hot" sparkles)
  and the neutral cool tint at level 1; one GC-pinned in-page rAF probe
  waits for tick time to advance 1.0 s and proves every mote drifted
  (x/y moved, volume respected after wraps) and the twinkle buffer changed;
  a synchronous A/B in ONE evaluate hides the dust between two
  composer.render() calls (no tick between renders, so grain/aurora/camera
  cancel exactly) and the top-brightest motes' projected windows differ
  strongly while a mote-free control window stays flat (the camera tilts
  ~9deg down so high sky projects off-canvas — the control is found by
  scanning a coarse canvas grid for a window with no projected mote center
  inside); `_applyStageHue(0.37)` re-inks the dust material color to the
  offset-HSL reference and `0` restores it exactly (the real level-up path
  is covered by level-palette.mjs); a real lock-out dims the field
  (brightness sum over all motes drops) and restart restores full lights +
  the neutral tint.
- `test/rafter-spots.mjs` — browser regression for the theatrical rafter
  spotlights: three volumetric shafts (central + two raked) with lamp caps
  and landing pools are installed behind the board (all z<0, landing on the
  well top edge y≈20.2, lamps in the sky band) sharing one set of
  uTime/uPulse/uDim/uHue uniform objects and one live inked cap-color
  object; a synchronous hide/show A/B in ONE evaluate grabs both frames and
  proves the beam/cap/pool bands carry light (the cap is the hottest
  point), a board-row probe shows only the decaying bloom halo (ratio vs
  the sky band + depthTest/z state pin the panel occlusion) and a coarse
  grid scan finds a flat feature-free control window; a line clear flares
  uPulse (a TETRIS flares hotter) and decays back; `onLevelUp(2)` re-inks
  the shafts (uHue = levelHue·2π) and caps/pools off the neutral base
  (state), while the pixel proof of the re-ink re-inks to level 8 (a 138°
  hue turn — a level-2 20° turn on the near-white caps is below the pixel
  threshold) via a spot-only un-ink A/B (zero the spot uHue + base colors
  between two renders, stage untouched) that shifts the cap/pool band
  channel mix while a scanned control window holds; restart
  restores the exact neutral spotlights, and a game-over lights-out dims
  the beam band's luminance (uDim ramp, caps to 25%) until restart.
- `test/streak-mode.mjs` — browser regression for streak mode: the board
  is rigged as a MONOCHROME all-T slab (any spatial hue variation on screen
  is the wave's, not piece-type diversity); level 1 is neutral (shared live
  uStreak object wired into the stack materials via the onBeforeCompile
  userData stash, pinned-zero on the hero piece — a temp block forces the
  stack material to compile); `onLevelUp(10)` eases the wave in (target
  1/11); a synchronous A/B in ONE evaluate (crank the shared uniform to
  full rainbow, render; zero it, render) re-hues the slab (max|ΔL| ~160)
  while a coarse-grid control window stays flat (~1) and on/off/on is
  symmetric; the per-column mean hue spread across the 10 slab columns is
  ~318° with the wave on vs ~0° with it off; one GC-pinned rAF probe
  proves the wave DRIFTS (the same column's hue rotates as tick time
  advances); `onStreakIgnite()` fires the rainbow-trail sweep (caught
  mid-flight by an in-page rAF probe that A/B-hides the sweep group:
  edge band ~183 vs a coarse-scan control >240px from the edge column,
  whose bloom halo is the only hazard) plus the k=2.2 floor ring; the
  STREAK banner (gradient tier) pops and carries light; restart re-arms
  the exact neutral level-1 state.
- `test/sky-meteors.mjs` — browser regression for the sky meteors: the
  pooled head/tail rig (three entries, shared live inked color objects,
  depth-tested so the panel occludes the exit) is installed at the exact
  neutral palette on a fresh game with auto-spawn held by the suite; one
  deterministic flight is sampled per frame by a GC-pinned in-page rAF
  probe and checked in Node against the spec's own linear kinematics
  (head on the flight line, tail half its length behind along the
  velocity, tail rotated to the velocity angle, hot head / soft tail
  opacities, fade-in ramp); a synchronous hide-the-rig A/B in ONE evaluate
  shows the in-flight head band as the hottest part (max|ΔL| ~160) over
  the tail band, with a coarse-grid control window (excluding the bloom
  halos of EVERY co-flying meteor) flat at ~0; the shed spark drizzle is
  caught by its cool B-base signature (≥1.7, which no other spawner
  writes) all on the mid gravity 13 (above the dissolve-ember <10 probe,
  below the line-clear 16); `onLevelUp(8)` re-inks head/tail/sparks off
  the neutral base (state), and the pixel proof un-inks only the meteor
  palette between two renders (stage untouched) to shift the head band's
  channel mix (~12) while a scanned control holds; a game-over lights-out
  dims the in-flight meteor (tail opacity + head-band luminance) while it
  keeps flying, and no new spawn fires while the stage is dark even
  though the auto-spawn was due; restart clears the pool, restores the
  exact neutral palette, re-arms the schedule and the scheduler fires a
  meteor on its own.
- `test/anamorphic-flare.mjs` — browser regression for the anamorphic
  TETRIS lens flare: the grade pass is last with live uFlare/uFlareY
  uniforms (0 at rest) and every popup pool slot owns a pooled flare quad
  (renderOrder 19, depthTest off, hidden), with the resting frame
  bit-identical under a feature toggle; a rigged TETRIS (vertical I into a
  one-column gap across four rows) fires the dolly punch, the banner owns
  the flare, and uFlareY matches an independent projection of the banner
  height; one combined in-page async evaluate waits mid-flight via rAF
  polling then runs a SYNCHRONOUS 3-way A/B in the same task (A: 3D quad
  hidden + uFlare 0; C: quad visible + uFlare 0; B: both live) — A vs B
  shows the full-width streak band carrying the flare light over a
  coarse-grid control window (streak band + bloom, the vertical-ghost
  column, the offset echo and the mirror-floor reflection wedge all
  rejected; re-captured a couple of frames later if the white-peak bloom
  outruns the rejections), and B vs C isolates the grade pass's echo row
  where the 3D core cancels and the anamorphic blue tint (Δb > 1.5·Δr) is
  clean even at the white-clipped peak; the flare decays back to rest;
  a DOUBLE clear shows its banner with no flare attached (uFlare 0, quads
  hidden); the level 9→10 crossing fires the violet-tinted streak flare
  (quad b-channel HDR gain > 1.2); a lock-out game over lets the
  lights-out cinematic kill the flare instantly (the slow overDim ramp is
  for the ambient stage, not the punch), and restart re-arms everything.
- `test/perfect-clear.mjs` — browser regression for the perfect-clear
  celebration: rest state (grade pass last, popup slots own yOff 0, pools
  idle); a 1-line perfect (flat I into a 4-gap bottom row) empties the
  board and the single in-page evaluate that triggers the real hard drop
  reads every event synchronously — flash + dolly punch, the elevated
  PERFECT CLEAR! banner (yOff 3.1) with its warm gold flare quad (r > g >
  b, HDR) and uFlareY aimed at its projected height, the full-board
  rainbow sweep (h=20, hot) beside the line-clear white sweep, a DOUBLE
  sonic ring armed (one live at t=0, one staggered at t=−0.18) and the
  54-spark gold fountain (R ≥ 1.4 signature); a GC-pinned rAF probe then
  catches the rainbow sweep mid-flight and runs a SYNCHRONOUS A/B that
  toggles only the perfect features (banner mesh + flare quad + uFlare —
  the concurrent TETRIS banner/sweeps/flash are static between the two
  renders and cancel exactly) over a coarse-grid control window (streak
  band, vertical-ghost column, echo, mirror wedge and the perfect banner's
  halo rejected; re-captured if the white-peak bloom outruns the
  rejections); a TETRIS-perfect (4 lines) stacks TETRIS! (yOff 0) under
  PERFECT CLEAR! (yOff 3.1) with the grade streak aimed at the perfect
  banner; a near-perfect (surviving filler) fires no flash/punch/flare/
  rainbow/ring; the celebration decays to rest and restart re-arms.
- `test/rotation-echo.mjs` — browser regression for the holographic
  rotation echo: rest state (pool installed, every slot dark, uFade=1 the
  exact shader identity — a sync A/B that toggles the (dark) echo group
  is bit-identical over the whole frame); a rotation via the real key-
  handler entry point (O-skip hard drops first, O can't rotate) spawns
  exactly one echo anchored on the pre-rotation piece anchor in the
  pre-rotation orientation at full uFade, proven at pixel level by a
  sync A/B after the piece-mesh angle settles (footprint max|ΔL| ~70-85
  over a coarse-grid control window that rejects the echo's bloom halo);
  a GC-pinned rAF probe catches the ease-out dissolve (uFade monotonic to
  hidden while the scale swells); a mid-fade sync A/B (caught in-page
  below uFade 0.4) shows the pixel signal attenuating (59 vs 84 at full
  strength); a CW+CCW flicker in one task rotates twice but the
  tick-time throttle flashes only ONE echo; a hidden-row rotation spawns
  none; the game-over lights out kills an in-flight echo; restart
  re-arms the pool.
- `test/fall-dust.mjs` — browser regression for the stardust wake:
  state installation; a grounded piece sheds nothing (bank idle); hidden
  pieces bank descent WITHOUT shedding (visibility gate) and shed the
  whole banked burst the frame they cross into the visible field; a
  falling piece sheds motes in the piece's crystal hue (pool signature
  audit: gravity-0 base — a signature no other spawner writes — with R <
  1.4 and B < 1.7 so it can't fake the level-palette gold-fountain or
  the meteor-spark probes), proven at pixel level by a synchronous A/B
  that hides ONLY the dust slots between two composer renders (band over
  the live motes' projected bounding box vs a coarse-grid clean-window
  control, feature-free); a grounded (paused) piece sheds nothing and
  the last motes expire; a hard drop sheds no dust (the fresh spawn
  jumps the target up, draining the bank) while the next piece is still
  hidden; the lights out kills in-flight motes synchronously and blocks
  new ones through the ramp; restart re-arms the bank (shed counter
  back to 0).
- `test/danger-alarm.mjs` — browser regression for the redline alarm:
  rest + low-stack gate (the alarm is the exact identity — off uniforms,
  white grid multipliers, neutral frame, off/off re-render bit-identical);
  the canonical dense stack (top row 12) engages the alarm at the pure
  dangerOf(board) level through main.js's per-frame setDanger and keeps
  the <3% white grade; a full-alarm tower (top row 7) drives the level
  to 1, and the heartbeat-modulated level reaches the grade + aurora
  uniforms at the pure 0.62 beat floor; at the heartbeat thump (caught
  by an in-page rAF poll on the frame color) the frame/grids read
  crimson; the alarm adds no white of its own (on <= true-off + 0.15% on
  the identical rig, proven on a true off that re-inks the stage
  neutral); a GC-pinned rAF probe measures the heartbeat swing over a
  full DANGER_PERIOD; a synchronous on/off A/B in ONE evaluate proves
  the red edge-glow in the frame corners, the crimson frame + glow bar
  and the crimson-washed aurora sky at pixel level over a coarse-grid
  feature-free control; the alarm composes AFTER the level-palette
  re-ink (a level-8 inked frame still reads red under full alarm); the
  game-over lights out hands off from the alarm (the level eases out
  while overDim ramps) and restart restores the exact neutral stage.
- `test/browser-smoke.html` — in-browser gameplay smoke test (needs a running
  server). Drive it with the local Playwright helper:

```sh
npm start &
node test/run-smoke.mjs      # prints PASS/FAIL lines
```

- `test/verify-3d.mjs` — headless WebGL check: boots the scene, samples
  canvas pixels, plays to game over and restarts, reports console errors.

```sh
npm start &
node test/verify-3d.mjs
```

- `test/lineclear-capture.mjs` — end-to-end line-clear FX capture: rigs the
  live game so a hard drop clears 4 lines (TETRIS), drops it through the
  real input path, and captures the presented frame at two FX phases
  (mid-expansion and late). It polls the renderer's ring animation phase
  instead of using wall-time waits, because headless SwiftShader renders
  slowly and FX time advances much slower than real time.

```sh
npm start &
node test/lineclear-capture.mjs http://localhost:8901/index.html /tmp/clear-A.png /tmp/clear-B.png
```

### Visual verification (no image viewing needed)

The 3D look is judged headlessly by reading the *presented* frame and
reducing it to numbers / ASCII, since screenshots of a WebGL canvas under
headless SwiftShader don't match the real frame.

- `test/frame-stats.mjs` — loads the page, optionally hard-drops N pieces to
  build a stack, forces a synchronous `composer.render()`, reads the real
  backbuffer, and prints avg color + % bright/white/cyan/magenta. Optionally
  saves the frame to a PNG.

```sh
npm start &
node test/frame-stats.mjs http://localhost:8901/index.html 14 /tmp/board.png
```

- `test/pnganalyze.mjs` — zero-dependency PNG decoder that turns a saved frame
  into stats, an ASCII rendering (luminance ramp + color-class markers
  `C`=cyan `M`=magenta `Y`=yellow `R`=red `G`=green `B`=blue; lowercase = dim),
or a per-region grid of avg luminance + color class (`regions`) for spotting
  hot spots and dead zones.

```sh
node test/pnganalyze.mjs stats /tmp/board.png
node test/pnganalyze.mjs ascii /tmp/board.png 60
node test/pnganalyze.mjs regions /tmp/board.png 10 16
```

A healthy grade is roughly: avg ~[80,115,130], bright ~30%, white <3%, with
nonzero cyan/magenta (aurora) and clearly distinct block colors in the ASCII.

## Layout

```
src/pieces.js      piece shapes, colors, SRS kick tables
src/engine.js      pure game engine (no DOM/timers) — fully unit-tested
src/loop.js        pure frame timing: gravity, lock delay, DAS/ARR, soft drop
src/input.js       horizontal key tracking (press-ordered, both keys held)
src/predict.js     landing cells + predicted line clears (for FX)
src/coords.js      board<->world transforms, piece anchor, hidden-row
                   visibility (pure, unit-tested)
src/stack-diff.js  minimal add/remove/retype diff for the renderer's stack
src/renderer3d.js  three.js scene: bloom, aurora sky, starfield, neon frame, FX
main.js            browser shell: DOM, key events, rendering; delegates timing
                   to src/loop.js and input state to src/input.js
index.html         page (import map maps `three` -> node_modules, no bundler)
style.css          styling
```

## 3D rendering notes

- `index.html` uses an import map so bare `three` / `three/addons/*`
  specifiers resolve from `node_modules` with no bundler.
- The board canvas is a WebGL canvas; CSS sizes it (1:2 aspect, capped to
  viewport height) and a `ResizeObserver` keeps the renderer in sync.
- Piece motion is smoothed in the renderer: the piece group lerps its anchor
  and unwraps its rotation angle so 3->0 spins -90deg, not +270deg.
- Hold/next previews live in the 2D canvas panels AND as in-stage
  holographic displays (mini holo pieces in cradle rings flanking the
  board, see the rendering note below).
- The look is graded with ACES tone mapping (exposure 1.15) + a conservative
  UnrealBloomPass (strength 0.8, radius 0.55, threshold 0.75). A low bloom
  threshold + wide radius floods the whole canvas with the frame's cyan glow
  (whiteout); a high threshold keeps the glow concentrated on hot pixels.
  Stack emissive is 0.5 so a full board keeps per-block color instead of
  clipping to a white blob; the active piece breathes ~1.05.
- Blocks are crystal gems, not flat boxes: each block material carries a
  radial core-glow emissiveMap (hot center -> dark edges, so the face reads
  as a glowing core in a dark body) plus a fresnel rim injected via
  onBeforeCompile (`pow(1 - saturate(dot(view, normal)), 2.5)` added to
  totalEmissiveRadiance with an HDR rim color = piece color lerped 35% to
  white x1.3, so bloom catches the silhouette edge). All block materials
  share one onBeforeCompile body, so three.js compiles a single program for
  every block (per-material rim color/strength are uniforms). Tuning
  history: stack emissive 0.62 + wide core clipped cores to white blobs on a
  full board (white 5.5%); the shipped grade is stack 0.50 / rim 0.35,
  piece 1.05 / rim 0.70, core stops (0,1)(0.22,0.8)(0.55,0.25)(1,0) ->
  white ~1.7% with all 7 hues distinct in the ASCII grade.
- On top of the self-emission the crystals are lit like real gems by two
  things. (a) Image-based lighting: a procedural studio environment (a deep
  sky/ground gradient + asymmetric warm/cool softboxes) is drawn to a canvas,
  run through PMREMGenerator, and set as `scene.environment` — every
  MeshStandard/PhysicalMaterial (crystal blocks + frosted panel) reflects it,
  with per-material `envMapIntensity` (stack 0.25, piece 0.65, panel 0.5) so
  the reflections add a soft sheen without clipping the grade. (b) A key-light
  facet sparkle, injected into the same onBeforeCompile as the fresnel rim: a
  near-white Blinn-Phong term (`pow(dot(normal, normalize(view + lightView)),
  24) * uSpecStrength`, lightView a fixed camera-space front studio light)
  adds a crisp highlight where each gem facet faces the light. It sweeps the
  facets as a piece rotates, and a full stack of blocks reads as light-
  catching gemstones. `uSpecStrength` is stashed on `material.userData
  .specUniform` so a test can A/B the sparkle by zeroing it (piece 0.6 / stack
  0.22). Tuning: the sparkle is the dominant new light, so a *fully-packed*
  200-cell board clips to ~12% white — but real Tetris clears lines, so the
  grade is pinned on a realistic dense stack (bottom ~10 rows, ~2/3 fill),
  which sits at ~2.1% white.
- The aurora sky is a custom ShaderMaterial on a big plane at z=-45, rendered
  additively (depthWrite off) so stars behind it stay visible. It uses
  domain-warped value-noise fbm in *world space* (object-space plane coords,
  not uv) so the curtain scale is fixed regardless of plane size; a 5-octave
  value-noise fbm peaks near f~0.7, so the curtain threshold sits at
  0.40-0.66 and the glow multiplier at ~2.6 to get peaks ~220 over a dark
  sky. Curtains are steep-thresholded for dark gaps, ray-striated vertically,
  hue-ramped deep-blue->cyan->violet->magenta with sequential (non-additive)
  mixes to stay saturated, and breathe slowly. `uPulse` flares the whole sky
  on line clears / game over. The frosted back panel (opacity 0.62) lets a
  faint aurora tint through the board glass while keeping it dark enough for
  pieces to pop.
- The level palette re-inks the whole stage as you level up. The pure
  mapping lives in `src/fx-labels.js` (`levelHue(level)`: level 1 is the
  neutral palette, each level steps the hue 0.055 in three's offsetHSL hue
  units — ~20 deg — wrapping into [0,1) so a full 360 cycle lands every
  ~18 levels). The renderer eases `levelHue` toward `levelHue(level)` over
  ~1 s and, per frame, applies it to: the aurora (a `uHue` uniform that
  Rodrigues-rotates the whole color ramp + horizon glow about the grey axis
  in-shader — a true hue rotation that preserves R+G+B, so only the hue
  shifts, never the brightness), the neon frame edges/rails, the glow bar,
  the sky background/fog, and the mirror/panel grid helpers (their baked
  vertex colors are re-inked from per-vertex base copies recorded at build
  time; repaints are gated on the hue actually moving so static levels
  upload no buffers). The level-up moment adds a one-shot celebration on
  top: an aurora surge (pulse to 2.4), a wide sonic ring across the mirror
  glass from the board center (a splash-pool entry with k 2.2 / s 1.8 vs a
  hard drop's 1.35/1.6, HDR white-cyan so bloom catches the rim), and a
  gold-white HDR spark fountain off the glow bar — the one warm chroma
  accent, raining back onto the glass whose mirror pass doubles it. `R`
  resets the stage to the exact neutral palette.
- Shader compile failures are console *errors*, not pageerrors — verify with
  console capture (frame-stats/verify-3d both report them), and port shader
  math to JS to predict brightness before tuning in-browser.
- Headless gotcha: Playwright compositor screenshots of the WebGL canvas
  (full-page or clip) don't match the presented frame under SwiftShader.
  Read the real frame in-page instead: `composer.render()` then
  `drawImage`/`getImageData` (see `test/frame-stats.mjs`).
- The floor is a mirror stage: a `Reflector` (three.js planar mirror) at
  y=-0.53 re-renders the whole scene from a virtual camera mirrored below
  the plane, so stack, neon frame, hard-drop trails, clear bursts and aurora
  are all doubled in the glass. 512px RT, no MSAA (the visible reflection
  wedge is small; keeps the extra pass cheap). A custom shader (the stock
  ReflectorShader plus a world-space distance fade) tints the reflection
  (0x93a8c8) and dissolves it into the fog color by ~45 units so the floor
  edge is invisible; a faint glass base lifts the black areas. The mirror
  pass tone-maps its render target (the renderer's ACES applies during the
  pass), so the shader's uReflect (1.25) compensates the second ACES — at
  1.8 a full stack clipped to 5.1% white; at 1.25 it is 1.7%. A neon
  GridHelper floats 5cm above the mirror (grid on glass).
- Camera framing: the camera sits high and looks down (~9 deg below
  horizontal) so the mirror floor fills the lower screen wedge — the board's
  reflection (bottom rows, glow bar, trails) reads as a stage below the
  field. Vertical margins: frame top ~2.5 deg inside the 20 deg half-FOV,
  board base ~14 deg below the view axis; the visible reflection covers the
  stack's bottom ~5 rows.
- The ghost is a hologram projected from the mirror floor: each ghost face
  is a shared holo ShaderMaterial (7 per-type tints, one compiled program)
  with a fresnel silhouette (`pow(1 - saturate(dot(worldN, worldView)), 2.2)`,
  so the shell's rim clears the bloom threshold and glows while the face
  fill stays faint), world-space horizontal scanlines (`sin(vWorldY*16 -
  t*7)`, drifting upward — world horizontal reads as screen horizontal at
  the ~9 deg camera tilt), and a slow pulse; all animated through ONE shared
  `uTime` uniform object referenced by every face material. A faint additive
  light pillar (the hard-drop trail texture: bright at the emitter end,
  tapering toward the ghost — a gradient, so the pillar dies out before it
  meets the shell) runs from the mirror floor to the ghost's lowest cell,
  tracked every frame to the ghost's anchor column; it is occluded by stack
  blocks (depthTest on, z=0.25), so a pillar in a filled column is hidden
  behind the stack. A small emitter pool of light (lock-splash texture,
  HDR x1.1) sits on the glass under the ghost column; the Reflector doubles
  pillar and pool in the reflection. All three follow the ghost's visibility
  exactly (no-fall `gy == piece.y`, hidden-row landing, game over, restart).
  Tuning: the projector is always on screen, so it must read as atmosphere —
  pillar opacity ~0.11, pool ~0.32 (a brighter pool white-clips on the
  bright aurora-reflection floor regions; the lock-splash pool can run hot
  because it is transient).
- Hard-drop trails: on a hard drop, each occupied column gets ONE pooled
  additive streak (gradient texture: bright at the landing end, fading up to
  where the piece was released) spanning the column's swept span, [min start
  row, max landing row] — a vertical I leaves one long streak, not four
  overlapping ones (stacked additive streaks clip to a white column). The
  streak is HDR (color lerped 45% to white x1.25) so bloom catches it, fades
  in ~0.3s while narrowing (0.6 -> 0.22), and is clamped to the visible field
  so a drop from the hidden spawn rows can't poke above the board frame. A
  grounded drop (d = 0) spawns nothing; the pre-drop position is captured in
  main.js before the engine mutates state.
- Lock-impact splashes: every lock spawns ONE pooled splash on the mirror
  floor (y -0.505, 2.5cm above the Reflector plane so it reads as light on
  the glass; the mirror pass re-renders it, so the splash is doubled in the
  reflection) under the lock point: a soft radial disc (256px canvas radial
  gradient, bright center -> zero at the edge) plus a thin RingGeometry rim
  (the sonic ripple), both flat on the floor, additive, piece-color lerped
  toward white and x1.35 (hard) / x1.1 (soft) so hard-drop splashes clear the
  bloom threshold and glow while natural locks stay a subtle shimmer. The
  splash expands (0.5 -> 2.6*k world units over 0.5s, k = 1.35 hard / 1.0
  soft) and fades; a small spark puff (shared particle pool: 26 hard / 10
  soft) kicks up at the base of the locked piece, clamped to the visible
  field. The anchor comes from the pure, unit-tested impactAnchor() in
  src/coords.js (centroid x of the POST-clear locked cells + lowest row):
  main.js passes the post-clear cells + { hard, color } on every lock, so a
  partial-clear lock splashes where the surviving cells now sit, and a
  full-clear lock (no surviving cells) splashes nothing — the clear FX owns
  that moment. Hard drops also nudge the aurora pulse. The floor is in the
  camera's near field (~2x the board's px/unit) and already bright from the
  reflected aurora, so the pixel test verifies the splash with a temporal
  diff (pre-drop baseline grid), not a spatial empty-column control.
- Line-clear FX: contiguous cleared rows are grouped into runs, and each
  run gets ONE hot core bar (sized to the run) + ONE shockwave ring. Four
  overlapping per-row bars clip to a solid white mass; a single run-height
  bar reads as a hot core. FX sources use HDR colors (material color > 1.0)
  because additive composites at ~1.0 sit below the bloom threshold (0.75)
  and render dim instead of glowing. Additive HDR layers stack
  superlinearly: four ~3%-white layers combine into a 25% whiteout, so
  shard/particle/bar HDR multipliers are kept near 1.0-1.4 and shards are
  sparse (every other cell). The TETRIS flash is a radial-falloff quad
  (sized so the gradient hits zero before the canvas edges — a bigger quad
  washes the floor/sky margins) plus a brief bloom-strength pop that decays
  in ~0.2s; a flat full-screen wash buries the rings/shards.
- Line-clear light sweep: the star of the clear. Each contiguous run gets
  a pooled entry (pool of 4, one per run) with a bright thin edge quad
  (0.16 wide, HDR white-cyan x1.4, x1.75 for a TETRIS run) that wipes the
  full board width (x -5.9 -> +5.9, just outside the neon frame) at
  constant velocity over 0.30 + 0.02·(h-1) (+0.09 TETRIS) seconds, with a
  2.6-unit soft trail quad behind it (a horizontal gradient texture,
  bright at the edge end, tinted with the run's average row palette;
  mirrored via negative scale.x — DoubleSide material — for right-to-left
  wipes). The edge's gain clears the bloom threshold so the wipe reads as
  a wall of light, and the Reflector's mirror pass doubles both quads in
  the stage glass. The wipe direction alternates per clear (a parity flip
  in onLineClear) so back-to-back clears rip different ways; multi-run
  clears stagger their sweeps (t starts at -i·0.055) so the wipes cascade
  instead of clumping. The edge ramps in over the first 10% of its travel
  and fades over the last ~18% so it enters and exits the frame cleanly.
  Both quads are additive, depthTest-off, renderOrder above the stack.
  Pixel-testing caveat: a control band must sit well above the run's TOP
  edge (sw.y + h/2 + 3.6), not its center — the bloom halo of a tall hot
  sweep reaches a couple of world units beyond its edge and would
  otherwise register in a center-relative control (measured: 88 vs 10).
  And in-page rAF probe promises must be pinned on window: under slow
  SwiftShader frames the page GC can collect an unpinned evaluate promise
  ("Resulting promise was garbage collected").
- Ambient light dust: the always-on layer that keeps the stage alive between
  FX moments. A 150-mote `THREE.Points` field of soft additive sprites
  (shared glow texture, size 0.18, depthWrite off) drifts slowly up through
  the stage air — the volume x ±8.2 (beyond the holo displays), y -0.3..24.5,
  z -0.4..3.2 (camera side of the glow bar) — wrapping at the edges, with a
  gentle per-mote sideways sway. Each mote twinkles on its own phase/frequency
  (brightness written to the per-vertex color attribute every tick; grayscale,
  so the stage-hue tint rides the single material color, re-inked by
  _applyStageHue like the frame/grids/sky). ~18% of the motes are "hot"
  sparkles (HDR base 1.0-2.1) that clear the bloom threshold and read as
  air-glints; the fine dust (base 0.16-0.46) stays below it and reads as soft
  texture. The field dims with the game-over lights-out (same 1-0.55·overDim
  factor as the stars), doubles in the mirror glass via the Reflector pass,
  and keeps drifting during the lights-out (dust in a dark room). Positions
  persist across restarts — ambient continuity, nothing to re-arm. Tuning
  history: the first cut (fine base 0.14-0.40, 14% hot at 0.9-1.9, size
  0.17) measured only ~0.14% of the frame's pixels carrying the additive
  glow — below human perception in a still frame; boosting the hot ratio to
  18% (base up to 2.1) and the sprite size to 0.18 lifted the bright-mote A/B
  band max|ΔL| to ~127 while the white grade held (frame-stats white 0.94%).
- Theatrical rafter spotlights: three volumetric light shafts (SPOT_BEAMS:
  one central vertical beam at z -2.5, two side beams raked ~27° inward at
  z -5) rake down from lamps just above the frame (y 22.6-23.2, inside the
  visible sky band) into the top of the well (y 20.2). Each shaft is a tall
  plane with a custom shader — a hot lamp-cap gaussian at the source end
  (vUv.y=1) fading down the beam body (exp(-d·2.6)), soft horizontal edges
  (smoothstep over uv.x), and a faint slow shimmer (±3%, ~1.7 s period) so
  the volume reads as light in air. The beams sit BEHIND the board, so the
  frosted panel's depth test occludes everything below the frame top: the
  shafts live in the sky band and the side gaps, and each lands in a pool
  of light (HDR splash-texture quad, plus a faint full-width wash) on the
  well's top edge in front of the frame. Shared uniform objects drive all
  three shaft shaders at once: uHue re-inks in-shader with the level
  palette (same Rodrigues rotation as the aurora), uPulse flares the beams
  on line clears (+0.45 + 0.22·n, extra on TETRIS) and level-ups (+1.0)
  and decays at 1.3/s, uDim pulls them to 25% with the game-over lights
  out (caps/pools/wash via shared materials whose color objects are the
  live inked instances — three's material constructor would COPY a passed
  Color, so the shared materials are built color-less and the live objects
  are assigned directly after construction). Grade
  tuning: the first cut (cap×1.6 white-lerped 0.5, center i≈2.15) clipped
  the lamps and beam centers to white blobs (4.2% white on an empty
  board); the shipped cut keeps the cool tint's red channel below the
  white-clip threshold at steady state (center i≈1.10 → red lands ~186/255,
  cap lerp-white 0.25 ×1.2 @ opacity 0.55, pools 0.18, wash 0.06) while
  blue still clears the bloom threshold, and flares stay transient (pulse
  gain capped, ×(1+pulse·0.35)). The beams' BLOOM halo decays smoothly
  below the beam's landing end (measured ~37 → ~16 lum from 1 → 3 world
  units down), so a board-region pixel probe of "is the beam here" reads
  the decaying halo, not zero — pair it with the depthTest/z state and a
  falloff-vs-sky-band ratio. The spotlights cost the dense-stack white pin
  ~0.6% (2.1% → 2.6-2.8%, still under the 3% ceiling).
- Sky meteors: rare shooting stars streak across the aurora band, in front
  of the sky plane (z -30) and behind the board, so the frosted panel's
  depth test occludes the exit naturally. Each meteor is a pooled pair (3
  entries): a hot round head (the shared splash texture on a 0.62-unit
  quad, base color 0xbfe3ff ×1.9 — cool enough that ACES keeps red below
  the white-clip line while blue clears the bloom threshold) and a trailing
  tail (the sweep trail texture — bright at its head end — scaled to the
  meteor's tail length and rotated by `meteorTailAngle()`, so the bright
  end leads at the head on either entry side without mirroring). The
  flight math is pure (src/meteor.js: linear position, `meteorFade` smooth
  fade-in over the first 15% / fade-out over the last 30% of the life) and
  mutation-guarded; the auto-spawn schedule waits 8-14 s after load (a
  calm sky for the stage to settle, and for early test phases to run),
  then fires every 3.5-8 s with a random side entry through the sky band.
  Each tick sheds one spark from the shared particle pool: mid gravity 13
  (above the game-over suite's dissolve-ember <10 probe, below the
  line-clear 16) and a cool HDR base (0xbfe3ff ×1.8, B ≈ 1.8) that no
  other spawner writes — the sky-meteors suite attributes its drizzle by
  that B-base signature, and its R base stays < 1.4 so it can't fake the
  level-palette gold-fountain check. Head/tail/spark colors are three live
  objects re-inked by _applyStageHue with the level palette (assigned
  after construction, since three copies a passed-in Color); the
  game-over lights out suppresses new spawns (`!this.over` gate) while
  in-flight meteors keep flying at 25% of their brightness; reset() clears
  the pool and re-arms the schedule 2-5 s out. The meteor's reflection
  lands far below the floor's visible wedge (virtual image y ≈ -1.06 - y),
  so the mirror shows none of it — no Reflector compensation needed. The
  first-meteor delay keeps the cinematic-grade suite's CA sky-window
  selection (which now also rejects windows crossing any in-flight
  meteor's projected remaining path) on quiet sky, and the frame-stats
  pin's 400 ms window on a fresh load never catches one.
- Stardust wake: the active piece sheds piece-colored stardust as it
  descends. The pure accumulator (src/fall-dust.js, unit- + mutation-
  guarded) banks the piece's target downward motion between ticks
  (WAKE_STEP 0.3 world units per mote; upward motion — a wall kick —
  drains the bank 2x faster than it fills, so kicks can't bank dust
  they never earned). The renderer SPENDS the bank only while the piece
  is visible and the stage is lit: hidden-row descent and the game-over
  cinematic bank silently (wakeBank) and the whole bank sheds as a burst
  the frame the piece materializes into the field. Each mote is one
  slot of the shared 900-particle pool: zero gravity (it drifts UP off
  the piece's rendered base — the lowest point of the rotation-0 layout
  rotated by the piece group's live angle — so the wake trails the
  falling body like a comet tail), 0.5-0.8 s life, tinted by the piece's
  crystal color at factor 0.5-0.9 (fine dust) or 1.2-1.5 (a hot glint,
  ~1 in 5, that clears the bloom threshold and sparks as an air-glint).
  The pool signature is probe-safe by construction: gravity 0 is written
  by no other spawner (embers 2.1, meteor sparks 13, bursts 16), and
  the 1.5 factor cap keeps a red Z's base under the level-palette
  fountain's R >= 1.4 probe and blue/cyan bases under the meteor spark's
  B >= 1.7 probe. A hard drop sheds no dust: the fresh spawn that
  follows always jumps the target back UP, which drains the bank (no
  special-casing needed); onHardDrop's trail owns that moment. The
  game-over lights out kills in-flight motes (gravity < 1 scan) and the
  `!this.over` gate blocks new ones; reset() re-arms the bank and the
  shed counter. Colored (never white) bases keep the <3% white grade
  untouched; frame-stats' dense-stack pin never sheds dust (a static
  stack), so the feature costs it nothing.
- Redline alarm: the stage turns crimson as the settled stack nears the
  top of the well. main.js feeds the pure dangerOf(board) level
  (src/danger.js: 0 while the stack top is at/below row 13, 1 at row 7
  or in a hidden row, linear between; empty well 0) to setDanger every
  frame; the renderer eases it (fast attack 6/s, slow release 1.4/s) and
  _applyDanger() — called every tick AFTER _applyStageHue and the
  frameBar copy, so the crimson tint composes on top of the level
  palette — pushes it to the pixels: a pre-multiplied level*pulse value
  (the pure dangerBeat heartbeat, 1.1 s period, modulating 62%..full)
  drives the grade pass's red edge-glow (a screen-space smoothstep
  corner term) and the aurora shader's crimson wash (col mixed toward
  col·(1.0, 0.42, 0.40) — the red term is NOT boosted above source
  brightness, so it may kill white pixels but never create them), while
  the frame edges / side rails / glow bar (heartbeat-bright, x1.35 at
  the thump) and the mirror/panel grid MULTIPLIERS (GridHelper vertex
  colors, so one material color re-tints the whole grid) lerp toward
  0xd4243d — deliberately below the 0.75 bloom threshold in R so the
  red lines' bloom halos can't push near-white sky pixels over the
  white line; the grade's red edge-glow is likewise gated off where G or
  B is already near the white threshold (smoothstep(0.60, 0.78,
  max(g,b))), making the screen-space term provably white-neutral. A
  full-alarm capture on the canonical dense stack measures white BELOW
  the alarm-off baseline (the G/B suppression kills more white than the
  tint creates). onGameOver re-targets the level to 0 (the crimson stage
  hands off to the lights-out cinematic; main.js stops feeding it
  because the board is still full at that point) and reset() zeroes it
  and re-whites the grid multipliers.
- Streak mode (level 10+): the settled stack becomes a living rainbow via
  a hue wave injected into the SHARED crystal program (one compiled shader
  for all 14 block materials, as before). The vertex stage writes a
  `vStreakPos` world-position varying (after `#include <begin_vertex>`,
  where `transformed` is defined); the fragment computes
  `streakAngle() = uStreak · (x·0.34 + y·0.17 − t·0.5)` — a wave that
  grows across the board (adjacent blocks carry different hues) and drifts
  with a shared `uStreakTime` clock (0.5 rad/s) — and Rodrigues-rotates
  about the grey axis the albedo (after `color_fragment`) and the whole
  emissive stack core+rim+spark (after the injected rim/specular terms),
  so each block stays one coherent hue. The rotation preserves R+G+B,
  so the wave re-hues without brightening: the <3% white grade is exactly
  what it was at level 1, and below level 10 the uniform is 0 and the
  shader term is the exact identity. `uStreak` is a SHARED {value} object
  referenced by every stack material (tick() eases it toward
  `streakIntensity(level)`: 0 below level 10, 1/11 at 10, 1 at level 20+)
  while the active piece's materials reference a pinned-zero object — the
  hero stays pure while the stack ripples. The 9→10 lock crossing fires
  `onStreakIgnite()` (main.js, beside the existing onLevelUp call): a
  full-board rainbow light sweep (the pooled sweep entry's trail material
  swaps to a rainbow-ramp canvas texture — the same tail→edge alpha ramp
  as the white sweep, mirrored for right-to-left wipes — under a
  white-hot edge at ×1.55), plus the level-up surge, sonic ring and
  shake; the STREAK banner (gradient face + soft white core, like the
  TETRIS tier) comes from popupFor's new tier, which sits under TETRIS and
  above LEVEL in the priority table and fires only on the ignition
  crossing (later level-ups are plain LEVEL banners). reset() restores
  the neutral state and the normal white sweep texture on the pool.
- Anamorphic TETRIS lens flare: the TETRIS dolly punch (and the streak
  ignition) fire a cinema-lens event in two layers that read ONE shared
  envelope. The 3D layer: each popup pool slot owns a flare quad (shared
  512×160 canvas texture: thin bright core line hot at center, tight glow,
  wide soft halo, faint vertical ghost; renderOrder 19, just under the
  banner, depthTest off, additive) tinted per tier (TETRIS 0xbfe8ff ×1.6,
  streak 0xcdb4ff ×1.4 — HDR so bloom catches the streak, and the
  Reflector doubles it in the stage glass). The screen layer: the
  cinematic grade pass (after OutputPass, so it grades sRGB and is never
  re-tonemapped) gains uFlare (0..1) + uFlareY (the banner's screen
  height, projected at spawn) and draws the anamorphic signature across
  the whole frame — a thin cool-blue streak through the full width
  (exp(−dy²·5e5) core + exp(−dy²·7e3) halo, fading to the corners), a
  faint vertical ghost through the same point, and one offset echo a
  third of the frame above the streak. Both layers run the pure
  `flareEnv()` (src/fx-labels.js, unit- + mutation-guarded): a fast
  smoothstep attack over the first 10% of the 0.8 s life, a short hold,
  then a slow filmic decay — the punch-in, then the tail. The quad tracks
  the banner's rise and widens with the punch (first 0.22 s), so the
  streak and the dolly land together; tick() feeds the strongest live
  envelope to uFlare (0 = the term vanishes from the shader), and
  reset() re-arms everything. The game-over lights out kills the flare
  instantly (`this.over` gate — the 2.2 s overDim ramp dims the ambient
  stage, not a punch event). Grade cost: the flare is tinted so red stays
  below the white-clip line, and it only lives during the TETRIS/streak
  moment, so the dense-stack white pin is untouched. Pixel verification
  (test/anamorphic-flare.mjs) uses a synchronous 3-way A/B in one task:
  A (both off) vs B (both on) proves the band over a feature-rejected
  control window, and B vs C (quad on, uFlare 0) isolates the grade
  echo row — the white-hot 3D core clips to white at peak and would
  wash the b > r signature, so the tint is measured where only the grade
  layer draws.
- Row-collapse settle: a clear used to make the rows above it teleport
  (re-tinted in place — the stack-diff only reports adds/removes/type
  changes at RESTING keys). Now `onLineClear` records the cleared rows and
  main.js calls it BEFORE the post-collapse `setStack`, whose diff pairs
  every shifted cell with its SOURCE row via `sourceRow()` (src/stack-diff
  .js, pure + fuzz-tested as the exact inverse of the engine's
  applyClearsToCells compaction: post = pre + #{cleared rows below pre},
  solved in one descending pass). The cell's mesh starts at the source row
  (clamped to the top of the visible field for sources in the hidden rows)
  and tick() slides it to its resting row over 0.13 + 0.055·rows seconds
  with a mild easeOutBack (~4% overshoot — a sub-centimeter dip into the
  gap, invisible at the 0.06-unit block spacing), while the camera dips
  (dip²·2.6 units, dip = 0.12 + 0.09·rows capped at 0.6) and eases back.
  A cell whose resting and source colors are identical (e.g. a Z shifted
  onto a Z) reports no diff and gets no slide — nothing visibly moves,
  so animating it would be noise. Slides whose mesh is removed mid-flight
  (game-over dissolve, restart) are dropped by a mesh-identity guard.
- FX timing under headless SwiftShader: rAF frames take ~200-250ms wall
  time, so renderer FX time advances at ~0.4-0.5x wall rate. Test captures
  must poll the FX state (e.g. ring `t`) rather than sleep for wall time.
- Cinematic grade: the composer's LAST pass (after OutputPass, so it grades
  the tone-mapped sRGB image and is never double tone-mapped) is a
  full-screen ShaderPass with three filmic touches. (a) Vignette: corner
  falloff `1 - 0.30 * smoothstep(0.55, 1.0, length(uv-0.5)*sqrt(2))` plus a
  faint cool lift in the corners — the stage reads as a framed shot, and the
  multiplicative term can only *reduce* white-clip. (b) Lens chromatic
  aberration: R/B sampled at a radial offset from G, `off = c * r² * uChroma
  * 4` with uChroma 0.0034 — sub-pixel at center, ~1.5px x / ~3px y at the
  corners; strong enough to be visible on neon edges, too weak to smear.
  (c) 24fps film grain: a per-pixel hash noise (±5 levels in sRGB space)
  held for 2-3 frames via `floor(uTime*24)` — static regions breathe like
  film. Caveats: the grain animates EVERY frame, so any test using a
  "static panel" inter-frame control must zero the grade uniforms first
  (ghost-holo does); and raw |ΔL| between CA-on/off frames is contaminated
  by offset-sampling on the sky's own gradients — measure it GATED on
  locally sharp pixels (the neon line is the only sharp feature in its band).
- Popup banners: major events fire pooled 3D type — "TETRIS!" (rainbow
  face + white-hot core), "LEVEL N" (cyan), "COMBO ×N" (magenta, streaks of
  3+), "TRIPLE" (violet), "DOUBLE" (pale cyan) — that pop in front of the
  board, rise, and fade. The label/tier/priority logic (TETRIS > level-up
  > combo > triple > double; singles and no-clear locks stay silent) is
  pure and unit-tested in src/fx-labels.js (two mutation-guarded
  thresholds); main.js keeps the combo streak and passes { clears, combo,
  level, prevLevel }. Each spawn redraws a 1024x256 canvas (bold type in
  three passes: wide glow / tight glow / sharp face; TETRIS gets a rainbow
  linear-gradient face plus a white core at alpha 0.22 — at 0.5 the whole
  banner washed to a white blob on the TETRIS frame) and uploads it as a
  CanvasTexture on a pooled quad (depthTest off, renderOrder 20, so it reads
  over the board and its clear FX; HDR material color 1.15-1.2 so the bright
  tiers clear the bloom threshold and glow). tick() animates each banner
  (easeOutBack pop over the first 16%, a 1.3-unit rise across its life, a
  30% fade-out), and the Reflector's mirror pass re-renders it, so the
  banner is doubled on the stage glass. The TETRIS banner additionally fires
  a cinematic camera dolly punch: camPunch 1 -> 0 (dt*2.1), z term
  camPunch² * 2.6 toward the board — squared for the ease-out.
- Perfect clear: when a lock's line clear empties the board to zero
  (boardEmpty(game.board) in src/fx-labels.js — pure, unit- and
  mutation-guarded; hidden-row residue still counts as non-empty),
  main.js calls renderer.onPerfect(), which stacks on the line-clear FX
  (and, on a 4-line perfect, on the TETRIS banner): the TETRIS full-screen
  bloom flash + a fresh dolly punch, the aurora/spot surge and shake, ONE
  full-board rainbow light sweep (the pooled rainbow texture from the
  streak ignition, white-hot edge), a DOUBLE sonic ring across the mirror
  glass — level-up ring factors (k 2.2 / s 1.8) in gold-white, the second
  armed at t = −0.18 (the impact loop hides entries while t < 0 and arms
  them live at the t ≥ 0 crossing, which is also what makes the stagger
  safe), and a 54-particle gold-white spark
  fountain off the well center (R base 1.5 — the same gold signature as
  the level-up fountain; line-clear palette sparks top out at sRGB 1.0, so
  probes attribute the fountain cleanly). The PERFECT CLEAR! banner is a
  dedicated popup tier (symmetric gold-white face flanked by
  magenta/cyan edges + white core, like TETRIS) with yOffset 3.1 so it
  floats above a concurrent TETRIS banner instead of overlapping its
  glyphs — showPopup/tick() carry the per-slot yOff through the spawn
  position, the rise and the flare quad, and aim uFlareY at the elevated
  banner height; the flare quad takes the warm gold tint (0xfff2cc ×1.5)
  while TETRIS/streak keep theirs. onPerfect is gated by this.over like
  every other stage event (a lock-out can't be a perfect clear —
  clearRows is empty then), and reset() re-arms it with the other pools.
  Grade cost: the only always-bright addition is the banner itself during
  its 1.7 s life, and it is tinted like the other hot banners (red below
  the white-clip line), so the dense-stack white pin is untouched.
  Pixel verification (test/perfect-clear.mjs) toggles ONLY the perfect
  features between two synchronous renders: everything else (the
  concurrent TETRIS banner, both sweeps, flashes, grain, aurora, camera
  punch) is static across the pair and cancels exactly, so the control
  window needs no static-feature rejections — only the streak band,
  vertical ghost, echo, mirror wedge and the perfect banner's own halo.
- The holographic rotation echo re-uses the holo-ghost shader: the
  shared _holoMat() gained a per-material uFade uniform (uFade=1 is the
  exact identity, so the ghost and the hold/next display faces are
  untouched), and an 8-slot pool (echoGroup) holds the afterimage
  groups. main.js captures the PRE-rotation piece state (a wall kick can
  move x/y) and calls renderer.onRotate() only on a successful rotation;
  the slot rebuilds its footprint on type change (rotation-0 layout +
  group rotation, the same convention as the ghost group and the piece
  mesh — so the echo shows exactly the silhouette the piece just left)
  with its own per-slot material set, because concurrent echoes of one
  type must fade independently (one shared material can't carry two
  fades). tick() swells each live slot (echoScale, +14% over the life) and
  eases its uFade + edge-line opacity down on the pure echoFade envelope
  (src/echo.js, unit- + mutation-guarded: pow-0.6 ease-out so the
  afterimage holds its shape a beat before dissolving), hiding the slot
  at ECHO_LIFE. Gates: this.over (the lights out kills in-flight echoes
  instantly), anyHiddenCell (an echo of a hidden-row piece would poke
  above the frame, exactly like the ghost), and a 0.1 s tick-time
  throttle (r.time - lastEchoT) so a rotation flicker stacks one echo,
  not a wall; the round-robin cursor keeps the seven most recent echoes
  alive. Grade cost is nil: the echo is faint holo (below the bloom
  threshold except for a thin rim shimmer), lasts 0.34 s, and the
  dense-stack white pin is untouched (rest frames are bit-identical with
  the pool toggled).
- The game over is a full lights-out, not a DOM overlay on a frozen scene.
  onGameOver() (guarded against re-trigger — a hold after a lock-out also
  reports game over) freezes the per-frame stack diff (setStack early-
  returns while over, so dissolved cells are never re-added), schedules the
  settled stack to dissolve top-down over ~3.2 s (rows sorted high-to-low,
  stagger = 3.2 / (n-1)), and shows a persistent "gameover" popup-tier
  banner: a cold ice-white -> blue -> violet gradient face that pops in over
  0.16 s and then breathes (opacity 0.82 ± 0.13) until reset() hides it.
  Each dissolved cell leaves a puff of 4 embers in the block's color using
  a per-particle gravity array (pGrav: line-clear sparks keep 16, dissolve
  embers use 2.1 so they float, then sink dreamily; every spawn writes its
  own gravity because pool slots keep the previous value) — the Reflector
  doubles them in the stage glass. Meanwhile overDim ramps 0 -> 1 over
  ~2.2 s and pulls the aurora's glow + horizon terms to 30% (uDim uniform
  in the sky shader), stars to 45%, the neon frame/rails to 35% and the
  glow bar to 45%, bloom strength to 65% of base, and pushes the camera
  back 7 units off stage (z term overDim * 7 in tick()). reset() snaps
  everything back to full lights and re-arms the state for the next game.
- The hold and next queue are projected onto the stage as holograms:
  the held piece (left of the board, x -6.0) and the 3-deep next queue
  (right, x +6.0, slots at y 14.4/12.0/9.6) are mini pieces built from
  the same holo ShaderMaterial as the ghost faces (per-type tints in a
  separate cache so the display's edge lines aren't driven by the ghost
  projector's tick block), scaled 0.42 (hold) / 0.34 (next) and seated in
  faint cradle rings. Each display column is lit by a light pillar from
  the mirror floor (reusing the hard-drop trail texture) and an emitter
  pool on the glass (lock-splash texture) — the Reflector doubles both in
  the reflection, and small canvas-texture captions ("HOLD" / "NEXT")
  float above. Everything lives in two groups (holoHoldGroup /
  holoNextGroup) so the game-over cinematic hides both displays with the
  rest of the stage. main.js calls setHold(game.held) / setNext(queue)
  every frame; the renderer diffs against its previous state, so the
  work happens only when the hold/queue actually changes: a hold swap
  pops the held piece in (easeOutBack over 0.22 s), flares the hold-side
  emitter (holoPulse decays 1.6/s) and sends a small floor ripple in the
  piece's color through the shared lock-splash pool (size factor 0.9 vs
  a hard drop's 1.35 — a projector chirp, not a lock splash); a queue
  shift pops the changed slots and gives the next side a softer ping.
  The displays flank the frame (±5.5) inside the ~±6.8 horizontal
  frustum edge at the board plane — the 1:2 portrait canvas leaves ~1.3
  world units per side, which the compact scales fill. The <3% white
  grade is unaffected (dense rigged stack measured 0.00% with the
  displays on stage).
- The renderer animates the piece between locks; when the same piece type
  spawns back-to-back it does NOT snap (type unchanged) — it slides from
  the old lock position to the new spawn position. That's intended motion,
  but it means a just-cleared board can briefly show the previous piece
  sliding upward (don't mistake it for a stuck mesh).
