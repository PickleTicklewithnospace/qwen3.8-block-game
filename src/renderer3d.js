// Three.js renderer for the Tetris game. Owns the entire WebGL scene:
// starfield, aurora sky, sky meteors (rare shooting stars streaking the
// aurora band: hot head + trailing tail + shed spark drizzle), ambient
// light-dust motes, theatrical rafter spotlights (volumetric beams from
// above the frame into the well), the redline alarm (the whole stage turns
// crimson and pulses like a heartbeat as the stack climbs toward the top
// of the well), floor grid, neon board frame, glowing
// blocks, the holographic ghost (animated holo shell + light pillar +
// emitter pool on the mirror floor), hard-drop light trails, line-clear
// particles/flashes and the row-collapse settle (shifted blocks slide down
// from their source rows), the anamorphic lens flare that streaks across
// the frame on TETRIS / streak ignition (bloom-carrying 3D streak quad +
// full-width screen-space streak in the cinematic grade), camera motion and
// bloom.
//
// The game loop drives it:
//   renderer.setStack(board)          - diff stack meshes (call each frame)
//   renderer.setPiece(type, rot, x, y)- animate current piece
//   renderer.setGhost(type, rot, x, y, visible)
//   renderer.onLock(cells)            - pop FX for locked cells
//   renderer.onHardDrop(piece, cells) - light trails for a hard drop
//   renderer.onLineClear(rows, colors)- light sweep + flash + shockwave +
//                                        particle burst + shake; records
//                                        cleared rows so the NEXT setStack
//                                        settles the shift (main.js calls
//                                        it before setStack)
//   renderer.onLevelUp(level)         - stage re-inks to the level palette (surge + ring + sparks)
//   renderer.onPerfect()              - the perfect-clear celebration (flash, rainbow sweep,
//                                       double ring, gold fountain, banner + flare)
//   renderer.onGameOver()             - the lights out: banner, stack dissolve, dim
//   renderer.setDanger(level)         - redline alarm level (0..1) from the settled
//                                        stack: the stage turns crimson with a
//                                        heartbeat pulse (pure math in src/danger.js)
//   renderer.tick(dt)                 - advance animations + render
//
// The TETRIS / streak-ignition dolly punch (showPopup tier 'tetris' or
// 'streak') also fires the anamorphic lens flare: a wide thin HDR streak
// quad in front of the banner (blooms, doubles in the mirror glass) and a
// full-width cool-blue streak through the frame in the cinematic grade
// pass — both driven by the pure flareEnv envelope over FLARE_LIFE.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { COLS, ROWS, TOTAL_ROWS, HIDDEN_ROWS } from './engine.js';
import { PIECES, getCells } from './pieces.js';
import { diffStack, sourceRow } from './stack-diff.js';
import { toWorldX, toWorldY, pieceAnchor, anyHiddenCell, impactAnchor } from './coords.js';
import { levelHue, streakIntensity, STREAK_LEVEL, flareEnv } from './fx-labels.js';
import { meteorState, meteorTailAngle, meteorSpawnSpec } from './meteor.js';
import { dangerBeat } from './danger.js';
import { ECHO_LIFE, ECHO_THROTTLE, ECHO_GROWTH, echoFade, echoScale } from './echo.js';
import { wakeStep, wakeBank } from './fall-dust.js';

const BOARD_W = COLS;
const BOARD_H = ROWS;
const BOARD_CY = BOARD_H / 2; // world Y of board center (bottom row center at 0.5)
// Lock-impact ripples sit on the mirror floor: just above the Reflector
// plane (-0.53) and below the neon grid (-0.48) so the grid lines still
// read on top of the splash.
const IMPACT_FLOOR_Y = -0.505;

// Line-clear light sweep: the bright edge wipes the full board width
// (world x +-5 at the frame edges) starting/ending just outside the frame
// so the wipe visibly exits the stage. The soft glow trails SWEEP_TRAIL_W
// units behind the edge (a texture gradient, bright at the edge end).
const SWEEP_X0 = -5.9;
const SWEEP_X1 = 5.9;
const SWEEP_TRAIL_W = 2.6;

// Holographic hold/next displays: the stage projects the held piece
// (left of the board) and the 3-deep next queue (right) as mini holo
// pieces in cradle rings. HOLO_X flanks the board frame (±5.5) inside the
// ~±6.8 horizontal frustum edge at the board plane; the hold piece sits
// at the board's mid height, the queue runs down the right side.
const HOLO_X = 6.0;
const NEXT_SLOT_Y = [14.4, 12.0, 9.6];
const HOLD_Y = 10.4;
const NEXT_SCALE = 0.34;
const HOLD_SCALE = 0.42;

const easeOutBack = (t) => {
  const c = 1.70158;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
};
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, v) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// Popup banner tiers: world width of the quad, on-screen lifetime (s) and
// the HDR gain on the texture (bright tiers clear the bloom threshold and
// glow). TETRIS is the biggest, hottest and longest-lived.
const POPUP_STYLE = {
  tetris: { w: 9.6, life: 1.4, gain: 1.2, glow: 'rgba(255,255,255,0.95)' },
  streak: { w: 8.8, life: 1.3, gain: 1.25, glow: 'rgba(255,209,102,0.95)' },
  level: { w: 8.0, life: 1.15, gain: 1.3, glow: 'rgba(47,212,255,0.9)', color: '#8ff6ff' },
  combo: { w: 8.4, life: 1.05, gain: 1.3, glow: 'rgba(255,90,213,0.9)', color: '#ff6fe0' },
  triple: { w: 7.6, life: 0.95, gain: 1.2, glow: 'rgba(176,125,255,0.9)', color: '#c09bff' },
  double: { w: 6.6, life: 0.9, gain: 1.15, glow: 'rgba(159,232,255,0.85)', color: '#a9ecff' },
  // The perfect-clear banner: the rarest and warmest moment — a gold-white
  // trophy that floats ABOVE the other banners (yOffset) so a 4-line
  // perfect shows TETRIS! and PERFECT CLEAR! stacked without glyph overlap.
  // It owns the anamorphic flare (like TETRIS/streak) with a warm gold
  // tint, and showPopup gives it the dolly punch.
  perfect: { w: 8.8, life: 1.7, gain: 1.3, glow: 'rgba(255,225,140,0.95)', yOffset: 3.1 },
  // The game-over banner: the biggest quad, and it never fades — showPopup
  // gives it life 1e9 and tick() special-cases the tier (pop in once, then
  // hold full size with a breathing opacity until reset()).
  gameover: { w: 9.4, life: 1e9, gain: 1.1, glow: 'rgba(140,180,255,0.95)' },
};

// Anamorphic flare life (s): the TETRIS / streak-ignition lens event. The
// pure envelope (flareEnv in fx-labels.js) runs over this window; both the
// grade pass's full-width screen streak (uFlare) and the 3D bloom-carrying
// streak quad read it, so they attack and fade in perfect sync.
const FLARE_LIFE = 0.8;

function glowTexture(inner = 'rgba(255,255,255,1)', mid = 'rgba(255,255,255,0.25)') {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, inner);
  g.addColorStop(0.35, mid);
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Radial core-glow map for the crystal blocks: a hot white center fading to
// black at the face edges. Used as emissiveMap, so each block face glows
// from its center while its edges stay dark (the fresnel rim, added in
// makeCrystalMat, then draws the glowing silhouette).
function coreGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.22, 'rgba(255,255,255,0.80)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.25)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Crystal block material: PBR base + core-glow emissive map + a fresnel rim
// + a crisp key-light specular, all injected into the standard shader. The
// rim (grazing-angle) draws the glowing silhouette edge; the specular is a
// near-white sparkle where a facet normal aligns with the half-vector to a
// camera-space front studio light, so the blocks read as light-catching
// gemstone facets and the sparkle sweeps across them as a piece rotates.
// All block materials share this onBeforeCompile body, so three.js compiles
// ONE program for every block; per-material rim/specular color and strength
// live in uniforms set at compile time (uSpecStrength is also stashed on
// userData so a test can A/B the sparkle by zeroing it).
//
// Streak mode: uStreak (a SHARED {value} object: live for the settled
// stack, pinned 0 for the active piece so the hero stays pure) scales a
// hue wave travelling across the board. The per-block angle comes from the
// block's world position (vStreakPos, a varying written in the vertex
// stage) plus a time drift, so adjacent blocks carry different hues and
// the whole stack drifts through a living rainbow. Rodrigues rotation
// about the grey axis preserves R+G+B, so the wave re-hues without
// brightening (the <3% white grade is untouched).
function makeCrystalMat(color, emissiveIntensity, rimStrength, specStrength, roughness, metalness, coreTex, white, streak, time) {
  const mat = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity,
    emissiveMap: coreTex,
    roughness,
    metalness,
  });
  const rimColor = color.clone().lerp(white, 0.35).multiplyScalar(1.3);
  const specColor = color.clone().lerp(white, 0.72).multiplyScalar(1.15);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = { value: rimColor };
    shader.uniforms.uRimStrength = { value: rimStrength };
    shader.uniforms.uSpecColor = { value: specColor };
    shader.uniforms.uSpecStrength = { value: specStrength };
    shader.uniforms.uStreak = streak; // shared {value}: live for stack, pinned 0 for piece
    shader.uniforms.uStreakTime = time; // shared {value}
    mat.userData.specUniform = shader.uniforms.uSpecStrength;
    mat.userData.streakUniform = shader.uniforms.uStreak;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vStreakPos;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  vStreakPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        [
          '#include <common>',
          'uniform vec3 uRimColor;',
          'uniform float uRimStrength;',
          'uniform vec3 uSpecColor;',
          'uniform float uSpecStrength;',
          'uniform float uStreak;',
          'uniform float uStreakTime;',
          'varying vec3 vStreakPos;',
          'const vec3 uLightView = normalize(vec3(-0.6, 0.35, 0.72));',
          '// Rodrigues rotation about the grey axis: a true hue rotation',
          '// that preserves R+G+B (brightness untouched, hue only).',
          'vec3 hueShiftS(vec3 c, float a) {',
          '  const vec3 k = vec3(0.57735, 0.57735, 0.57735);',
          '  float s = sin(a);',
          '  float co = cos(a);',
          '  return c * co + cross(k, c) * s + k * dot(k, c) * (1.0 - co);',
          '}',
          '// Streak-mode hue wave: grows with board x/y (per-block variation),',
          '// drifts with time. uStreak 0 -> exact identity (no re-hue).',
          'float streakAngle() {',
          '  return uStreak * (vStreakPos.x * 0.34 + vStreakPos.y * 0.17 - uStreakTime * 0.5);',
          '}',
        ].join('\n'),
      )
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n  diffuseColor.rgb = hueShiftS(diffuseColor.rgb, streakAngle());',
      )
      .replace(
        '#include <emissivemap_fragment>',
        [
          '#include <emissivemap_fragment>',
          '// fresnel rim: glowing silhouette edge on the rounded block',
          'float rimFres = pow(1.0 - saturate(dot(normalize(vViewPosition), normal)), 2.5);',
          'totalEmissiveRadiance += uRimColor * rimFres * uRimStrength;',
          '// crisp key-light specular: near-white sparkle on facets facing',
          '// the (camera-space) front studio light; reads as gem facets.',
          'vec3 Vsp = normalize(vViewPosition);',
          'vec3 Hsp = normalize(Vsp + uLightView);',
          'float spec = pow(max(dot(normal, Hsp), 0.0), 24.0);',
          'totalEmissiveRadiance += uSpecColor * spec * uSpecStrength;',
          '// streak hue wave: rotate the whole emissive stack (core glow +',
          '// rim + spark) with the albedo so the block stays one hue.',
          'totalEmissiveRadiance = hueShiftS(totalEmissiveRadiance, streakAngle());',
        ].join('\n'),
      );
  };
  return mat;
}

// Equirectangular HDR studio environment for image-based lighting (IBL). A
// few bright, asymmetric softboxes over a dark sky/ground gradient, baked
// into a PMREM texture and set as scene.environment so the crystal blocks
// (MeshStandardMaterial) pick up real, orientation-dependent specular
// reflections instead of reading as flat self-lit glow blobs. The layout is
// deliberately asymmetric — a warm key softbox upper-left and a cool fill
// softbox upper-right — so a block face shows a measurable left/right color
// bias (the left side catches the warm key, the right the cool fill). That
// bias is the regression test's proof that the environment is actually doing
// directional work on the facets.
function envEquirectTexture() {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const ctx = c.getContext('2d');
  // Vertical base gradient: deep-blue zenith (top) -> black nadir (bottom).
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0.0, '#101a3c');
  g.addColorStop(0.4, '#060b1e');
  g.addColorStop(0.72, '#02040c');
  g.addColorStop(1.0, '#000102');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 256);
  // Soft radial light blobs (studio softboxes).
  const blob = (cx, cy, rad, color) => {
    const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
    rg.addColorStop(0, color);
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - rad, cy - rad, rad * 2, rad * 2);
    ctx.clip();
    ctx.fillStyle = rg;
    ctx.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
    ctx.restore();
  };
  // Warm key, upper-left (dominant); cool fill, upper-right; faint back rim.
  blob(110, 62, 92, 'rgba(255,214,172,1.0)');
  blob(404, 84, 84, 'rgba(150,222,255,0.9)');
  blob(256, 150, 130, 'rgba(120,150,255,0.28)');
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Vertical light streak for hard-drop trails: bright at the landing end
// (canvas bottom = plane v=0 after flipY) fading to transparent where the
// piece was released. Tinted per spawn via the material color.
function trailTexture() {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0.0, 'rgba(255,255,255,0)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.28)');
  g.addColorStop(0.85, 'rgba(255,255,255,0.7)');
  g.addColorStop(1.0, 'rgba(255,255,255,1)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Soft radial splash for lock impacts: a pool of light on the mirror floor
// (bright center fading to the edge). Used as a white texture; the pooled
// disc material's color tints it per piece.
function splashTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.7)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.28)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Horizontal light-streak trail for the line-clear light sweep: transparent
// at the tail end (canvas left) ramping to full white at the edge end
// (canvas right). The pooled trail quad keeps this fixed and mirrors itself
// (negative scale.x) for right-to-left wipes, so the bright end always sits
// against the moving edge.
function sweepTrailTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 256, 0);
  g.addColorStop(0.0, 'rgba(255,255,255,0)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.22)');
  g.addColorStop(0.8, 'rgba(255,255,255,0.55)');
  g.addColorStop(1.0, 'rgba(255,255,255,0.9)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Trail for the streak-ignition sweep: the same tail->edge alpha ramp as
// the normal sweep trail, but the visible band runs a full rainbow ramp
// across the board width, so the wave that ignites the stack leaves a
// rainbow sheet behind it. Mirrored (negative scale.x) for right-to-left
// wipes, which reads as the rainbow running the other way.
function rainbowTrailTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 256, 0);
  g.addColorStop(0.0, '#ff4d6d');
  g.addColorStop(0.18, '#ffd166');
  g.addColorStop(0.36, '#6dff8f');
  g.addColorStop(0.54, '#4dc9ff');
  g.addColorStop(0.72, '#7d7dff');
  g.addColorStop(0.88, '#ff5ad5');
  g.addColorStop(1.0, '#ff4d6d');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 64);
  ctx.globalCompositeOperation = 'destination-in';
  const a = ctx.createLinearGradient(0, 0, 256, 0);
  a.addColorStop(0.0, 'rgba(255,255,255,0)');
  a.addColorStop(0.45, 'rgba(255,255,255,0.22)');
  a.addColorStop(0.8, 'rgba(255,255,255,0.55)');
  a.addColorStop(1.0, 'rgba(255,255,255,0.9)');
  ctx.fillStyle = a;
  ctx.fillRect(0, 0, 256, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Anamorphic flare streak for the TETRIS / streak-ignition lens event:
// a thin bright horizontal core line (hot at center, fading to the ends),
// a tight glow above and below it, a wide soft halo band, and a faint
// vertical ghost through the center — the cinema-lens signature. White
// texture; the pooled quad's material color tints it per tier (cool
// blue-cyan for TETRIS, violet-tinted for the streak ignition).
function flareTexture() {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 160;
  const ctx = c.getContext('2d');
  // Wide soft halo band across the full width.
  let g = ctx.createLinearGradient(0, 0, 0, 160);
  g.addColorStop(0.0, 'rgba(255,255,255,0)');
  g.addColorStop(0.32, 'rgba(255,255,255,0.07)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.22)');
  g.addColorStop(0.68, 'rgba(255,255,255,0.07)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 160);
  // Tight glow around the core line.
  g = ctx.createLinearGradient(0, 56, 0, 104);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 56, 512, 48);
  // The bright 4px core line, hot at center and fading toward the ends.
  const h = ctx.createLinearGradient(0, 0, 512, 0);
  h.addColorStop(0.0, 'rgba(255,255,255,0)');
  h.addColorStop(0.16, 'rgba(255,255,255,0.5)');
  h.addColorStop(0.5, 'rgba(255,255,255,1)');
  h.addColorStop(0.84, 'rgba(255,255,255,0.5)');
  h.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = h;
  ctx.fillRect(0, 78, 512, 4);
  // Faint vertical ghost through the center of the streak.
  const v = ctx.createLinearGradient(244, 0, 268, 0);
  v.addColorStop(0, 'rgba(255,255,255,0)');
  v.addColorStop(0.5, 'rgba(255,255,255,0.28)');
  v.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = v;
  ctx.fillRect(244, 8, 24, 144);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

  // Rafter spotlight shafts: soft volumetric beam in object space. The quad
  // is scaled to the beam's width/length and rotated so local +Y (vUv.y=1)
  // points at the lamp end; the gradient there is a hot lamp cap fading
  // down the shaft toward the landing end (vUv.y=0). The level palette
  // re-inks the shaft in-shader (same Rodrigues hue rotation as the
  // aurora), uPulse flares it on clears/level-ups and uDim pulls it down
  // with the game-over lights out.
const SPOT_SHAFT_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWPos;
  void main() {
    vUv = uv;
    vWPos = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SPOT_SHAFT_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uHue;
  uniform float uPulse;
  uniform float uDim;
  uniform float uTime;
  uniform float uGain;
  varying vec2 vUv;
  varying vec3 vWPos;

  vec3 hueShift(vec3 c, float a) {
    const vec3 k = vec3(0.57735, 0.57735, 0.57735);
    float s = sin(a);
    float co = cos(a);
    return c * co + cross(k, c) * s + k * dot(k, c) * (1.0 - co);
  }

  void main() {
    // vUv.y: 1 at the lamp (top of the quad), 0 at the landing end.
    float d = 1.0 - vUv.y;
    float cap = exp(-d * d * 42.0);   // hot lamp cap at the source
    float shaft = exp(-d * 2.6);      // beam body fading toward the well
    float w = smoothstep(0.0, 0.3, vUv.x) * (1.0 - smoothstep(0.7, 1.0, vUv.x));
    // Faint slow shimmer keeps the volume reading as light in air, not
    // painted glass (kept small so temporal pixel diffs stay quiet).
    float shimmer = 0.94 + 0.06 * sin(uTime * 0.6 + vUv.x * 4.0 + vWPos.x * 0.7);
    // Tuned so the beam center peaks just under white-clip (the cool tint
    // keeps red below the grade threshold while blue clears the bloom
    // threshold), and flares stay transient instead of a white wash.
    float i = (cap * 0.75 + shaft * 0.35) * w * shimmer;
    i *= uGain * (1.0 + uPulse * 0.35) * mix(1.0, 0.25, uDim);
    gl_FragColor = vec4(hueShift(uColor, uHue) * i, 1.0);
  }
`;

// Theatrical rafter spotlights: three volumetric light shafts rake down
// from just above the frame into the top of the well (one central vertical
// beam, two raked side beams). The beams sit BEHIND the board (z<0), so the
// frosted panel's depth test occludes everything below the frame top and
// the shafts live in the sky band and the side gaps; each beam has a hot
// lamp cap at its source and lands in a pool of light on the well's top
// edge (camera-facing quads in front of the frame). SPOT_BEAMS lists the
// lamp (top) and landing points per beam plus its width/gain.
const SPOT_BEAMS = [
  { top: [0, 22.6, -2.5], land: [0, 20.2, -2.5], w: 3.6, gain: 1.0 },
  { top: [-3.6, 23.2, -5.0], land: [-2.07, 20.2, -5.0], w: 2.5, gain: 0.8 },
  { top: [3.6, 23.2, -5.0], land: [2.07, 20.2, -5.0], w: 2.5, gain: 0.8 },
];
const SPOT_POOL_Y = 20.32; // on the well's top edge, in front of the frame

// Mirror stage floor shader: the Reflector's stock shader plus a
// world-space distance fade. The reflection dies out with distance so the
// far floor dissolves into the fog-colored background instead of mirroring
// the sky forever, and a faint glass base lifts the black areas so the
// floor reads as dark glossy glass rather than a void. Note the reflector's
// render target is tone-mapped (the mirror pass renders with the renderer's
// ACES), so the uReflect gain compensates the second ACES application below.
const MIRROR_SHADER = {
  name: 'MirrorFloorShader',
  uniforms: {
    color: { value: null },
    tDiffuse: { value: null },
    textureMatrix: { value: null },
    uReflect: { value: 1.25 },
    uFadeInner: { value: 14.0 },
    uFadeOuter: { value: 45.0 },
  },
  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    varying vec3 vWorldPos;
    #include <common>
    #include <logdepthbuf_pars_vertex>
    void main() {
      vUv = textureMatrix * vec4( position, 1.0 );
      vWorldPos = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
      #include <logdepthbuf_vertex>
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 color;
    uniform sampler2D tDiffuse;
    uniform float uReflect;
    uniform float uFadeInner;
    uniform float uFadeOuter;
    varying vec4 vUv;
    varying vec3 vWorldPos;
    #include <logdepthbuf_pars_fragment>
    void main() {
      #include <logdepthbuf_fragment>
      vec4 base = texture2DProj( tDiffuse, vUv );
      float dist = length( vWorldPos.xz );
      float fade = 1.0 - smoothstep( uFadeInner, uFadeOuter, dist );
      vec3 refl = base.rgb * color * uReflect + vec3( 0.015, 0.022, 0.04 );
      // Outside the fade, hold the fog/background color so the plane edge
      // is invisible.
      gl_FragColor = vec4( mix( vec3( 0.027, 0.043, 0.102 ), refl, fade ), 1.0 );
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `,
};

// Cinematic grade: the final screen-space pass, applied to the tone-mapped
// sRGB image (runs AFTER OutputPass, so it grades the finished frame and is
// never double tone-mapped). Three filmic touches, all deliberately subtle:
//   - vignette: corner falloff with a faint cool lift in the shadows, so the
//     stage reads as a framed shot instead of an infinite void,
//   - lens chromatic aberration: R/B channels sampled at a radial offset
//     from G, growing quadratically toward the corners (sub-pixel at center,
//     ~1-3px at the frame edges) — a glassy, photographic feel,
//   - 24fps film grain: uncorrelated per-pixel noise held 2-3 frames,
//     so static regions breathe like film instead of holding dead still.
// All three strengths are A/B-toggleable from the test via the pass's
// uniforms (zero each to isolate its pixel effect).
//
// A fourth term is the anamorphic lens flare (uFlare 0..1 envelope +
// uFlareY the banner's screen height): fired by the TETRIS / streak
// ignition dolly punch, it draws the cinema-lens streaks across the whole
// frame — the 3D flare quad (with its bloom + mirror doubling) carries the
// in-world light, this pass extends the streak edge to edge.
const GRADE_SHADER = {
  name: 'CinematicGradeShader',
  uniforms: {
    tDiffuse: { value: null },
    uVignette: { value: 0.30 },
    uChroma: { value: 0.0034 },
    uGrain: { value: 0.04 },
    uTime: { value: 0 },
    uFlare: { value: 0 },
    uFlareY: { value: 0.52 },
    uDanger: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uVignette;
    uniform float uChroma;
    uniform float uGrain;
    uniform float uTime;
    uniform float uFlare;
    uniform float uFlareY;
    uniform float uDanger;
    varying vec2 vUv;

    float hash21(vec2 p) {
      p = fract(p * vec2(234.34, 435.345));
      p += dot(p, p + 34.23);
      return fract(p.x * p.y);
    }

    void main() {
      vec2 c = vUv - 0.5;
      // Lens-like chromatic aberration: R/B sampled at a radial offset from
      // G; the offset scales with r^3 of the corner distance.
      vec2 off = c * dot(c, c) * uChroma * 4.0;
      vec3 col;
      col.g = texture2D(tDiffuse, vUv).g;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.b = texture2D(tDiffuse, vUv - off).b;
      // Film vignette + faint cool shadow lift at the corners.
      float d = length(c) * 1.4142; // 1.0 at the corners
      float vig = 1.0 - uVignette * smoothstep(0.55, 1.0, d);
      col = col * vig + vec3(0.004, 0.008, 0.018) * (1.0 - vig);
      // Redline alarm: a pulsing crimson edge-glow while the stack climbs
      // toward the top of the well (uDanger is the pre-multiplied
      // level*pulse value; 0 = the exact identity). The red add is gated
      // off where G or B is already near the white threshold (sRGB 200),
      // so it can brighten dark/medium pixels but can NEVER create a
      // new all-white pixel — the <3% white grade is untouched.
      if (uDanger > 0.0) {
        float gate = 1.0 - smoothstep(0.60, 0.78, max(col.g, col.b));
        col += vec3(0.45, 0.03, 0.04) * uDanger * smoothstep(0.45, 1.0, d) * gate;
      }
      // Anamorphic lens flare (the TETRIS / streak dolly-punch event):
      // a thin cool-blue streak through the full frame width at the banner's
      // height (tight core + wide halo), a faint vertical ghost through the
      // same point, and one offset echo lower in the frame — the anamorphic
      // cinema-lens signature. Screen-space, so it spans edge to edge.
      if (uFlare > 0.0) {
        vec2 f = vUv - vec2(0.5, uFlareY);
        float band = 1.0 - smoothstep(0.30, 0.5, abs(f.x));
        float streak = exp(-f.y * f.y * 500000.0) * band;
        float halo = exp(-f.y * f.y * 7000.0) * 0.30 * band;
        float vghost = exp(-f.x * f.x * 500000.0)
                     * (1.0 - smoothstep(0.16, 0.30, abs(f.y))) * 0.45;
        vec2 e = vUv - vec2(0.5, uFlareY + 0.30);
        float echo = exp(-e.y * e.y * 500000.0)
                   * (1.0 - smoothstep(0.10, 0.22, abs(e.x))) * 0.30;
        col += (vec3(0.42, 0.62, 1.0) * (streak * 0.85 + halo)
             + vec3(0.50, 0.70, 1.0) * vghost
             + vec3(0.36, 0.55, 0.95) * echo) * uFlare;
      }
      // 24fps film grain: fresh noise pattern every 1/24s.
      if (uGrain > 0.0) {
        float n = hash21(floor(vUv * 1024.0) + vec2(floor(uTime * 24.0)));
        col += (n - 0.5) * uGrain;
      }
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

// Animated aurora sky: domain-warped fbm curtains in world space, so the
// band scale is independent of plane size. Vertical ray striations,
// cyan->violet->magenta ramp, horizon glow. Rendered additively on a big
// plane behind the board. uPulse flares it on clears.
const AURORA_VERT = /* glsl */ `
  varying vec3 vPos;
  void main() {
    vPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const AURORA_FRAG = /* glsl */ `
  varying vec3 vPos;
  uniform float uTime;
  uniform float uPulse;
  uniform float uDim;
  uniform float uHue;
  uniform float uDanger;

  // Rodrigues rotation about the grey axis (1,1,1)/sqrt(3): a true hue
  // rotation that preserves R+G+B (brightness untouched, only the hue
  // re-inks). uHue is in radians; level 1 is 0 (the neutral palette).
  vec3 hueShift(vec3 c, float a) {
    const vec3 k = vec3(0.57735, 0.57735, 0.57735);
    float s = sin(a);
    float co = cos(a);
    return c * co + cross(k, c) * s + k * dot(k, c) * (1.0 - co);
  }

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }

  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) {
      v += a * vnoise(p);
      p = p * 2.03 + vec2(11.7, 5.1);
      a *= 0.5;
    }
    return v;
  }

  void main() {
    float t = uTime;

    // Object-space plane coords. Visible band: x in [-16,16], y in [-27,27]
    // (plane is 170x105 centered at the board's mid-height).
    vec2 p = vPos.xy * vec2(0.20, 0.085);

    // Two fbm fields steer a third: organic, slowly drifting flow.
    vec2 q = vec2(
      fbm(p * vec2(1.3, 0.8) + vec2(0.0, t * 0.030)),
      fbm(p * vec2(1.3, 0.8) + vec2(t * 0.022, 4.7))
    );
    float f = fbm(p + q * 1.8 + vec2(t * 0.050, -t * 0.015));
    float f2 = fbm(p * vec2(1.6, 2.2) - q * 1.2 + vec2(-t * 0.030, t * 0.020));

    // 0 at the floor horizon (y ~ -10.5), 1 at the top of the visible band.
    float above = clamp((vPos.y + 10.5) / 38.0, 0.0, 1.0);

    // Curtain threshold: bright bands with dark gaps between them.
    // (fbm here peaks near f~0.7, so 0.40-0.66 lights only the top ~15%).
    float curtain = smoothstep(0.40, 0.66, f);
    // Vertical ray striations ~5.7 units wide, bent by the flow field.
    float rays = 0.45 + 0.55 * pow(0.5 + 0.5 * sin(vPos.x * 1.1 + f * 7.0), 2.0);
    float streaks = 0.55 + 0.45 * smoothstep(0.30, 0.80, f2);
    // Rise from the horizon, peak mid-sky, fade toward the zenith.
    float heightFade = smoothstep(0.00, 0.28, above) * (1.0 - 0.45 * smoothstep(0.55, 1.00, above));
    // Slow breathing, phase-shifted by f so bands shimmer independently.
    float breathe = 0.72 + 0.28 * sin(t * 0.18 + f * 5.0);
    float glow = curtain * heightFade * streaks * rays * breathe;

    // Sequential (non-additive) hue ramp keeps colors saturated:
    // deep blue -> teal/cyan -> violet -> magenta crowns.
    vec3 deep    = vec3(0.015, 0.040, 0.140);
    vec3 cyan    = vec3(0.040, 0.520, 0.720);
    vec3 violet  = vec3(0.420, 0.160, 0.850);
    vec3 magenta = vec3(0.720, 0.120, 0.620);

    vec3 col = mix(deep, cyan, smoothstep(0.30, 0.65, f));
    col = mix(col, violet, smoothstep(0.58, 0.92, f) * smoothstep(0.15, 0.85, above));
    col = mix(col, magenta, smoothstep(0.78, 1.00, f) * smoothstep(0.45, 1.00, above) * 0.60);
    // Level palette: the whole ramp re-inks with the stage hue.
    col = hueShift(col, uHue);

    vec3 sky = mix(vec3(0.010, 0.020, 0.070), vec3(0.030, 0.060, 0.140), above);
    float boost = 1.0 + uPulse * 0.9;
    // Game-over "lights out": uDim pulls the curtains down to 30% of their
    // brightness while the sky base (near-black) stays up.
    float dim = mix(1.0, 0.30, uDim);
    col = sky + col * glow * 2.6 * boost * dim;

    // Soft horizon glow hugging the floor line.
    col += hueShift(vec3(0.080, 0.300, 0.480), uHue) * exp(-abs(above - 0.03) * 14.0) * (0.5 + 0.5 * uPulse) * dim;

    // Redline alarm: the curtains wash crimson as the stack nears the top
    // (uDanger is the pre-multiplied level*pulse value; 0 = off). The red
    // term is NOT boosted above the source brightness (R scale 1.0): it may
    // kill white pixels (G/B suppression) but never create them, so the
    // <3% white grade can only improve under the alarm.
    col = mix(col, col * vec3(1.0, 0.42, 0.40) + vec3(0.02, 0.008, 0.008), uDanger * 0.8);

    gl_FragColor = vec4(col, 1.0);
  }
`;

function makeStars(count, rMin, rMax, size, opacity, color = 0xd4e2ff) {
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    // Uniform point in spherical shell.
    const u = Math.random() * 2 - 1;
    const th = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const r = rMin + Math.random() * (rMax - rMin);
    pos[i * 3] = s * Math.cos(th) * r;
    pos[i * 3 + 1] = u * r;
    pos[i * 3 + 2] = s * Math.sin(th) * r;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const m = new THREE.PointsMaterial({
    color,
    size,
    sizeAttenuation: true,
    transparent: true,
    opacity,
    map: glowTexture(), // round soft dots instead of square points
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  return new THREE.Points(g, m);
}

export class TetrisRenderer3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x070b1a);
    this.scene.fog = new THREE.Fog(0x070b1a, 80, 220);

    const w = canvas.clientWidth || 420;
    const h = canvas.clientHeight || 840;
    this.camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 400);
    // Stage framing: elevated camera looking down enough that the mirror
    // floor fills the lower screen wedge — the board's reflection (bottom
    // rows, glow bar, trails, clear FX) reads as a stage below the field.
    // Vertical margins: frame top ~2.5 deg inside the 20 deg half-FOV,
    // board base ~14 deg below the view axis.
    this.cameraBase = new THREE.Vector3(0, 15.2, 37);
    this.cameraLook = new THREE.Vector3(0, 9.6, 0);
    this.camera.position.copy(this.cameraBase);
    this.camera.lookAt(this.cameraLook);

    this.mouse = { x: 0, y: 0 };
    this.time = 0;
    this.shake = 0;
    this.camPunch = 0; // TETRIS dolly-in: 1 -> 0, decays in tick()
    this.flare = 0; // anamorphic flare envelope this tick (0..1): grade uFlare
    this.over = false; // game-over "lights out" state
    this.overDim = 0; // 0 -> 1 ramp (~2.2 s) that dims the stage
    this.overT = 0; // seconds since game over (drives the stack dissolve)
    this.dissolves = []; // [{x,y,key,type,at}] top-down cascade schedule

    // Level palette: the stage hue offset eases toward the level's target
    // (levelHue(level), pure logic in src/fx-labels.js). Level 1 is 0 —
    // the neutral palette. On a level-up the whole stage re-inks: aurora
    // sky (uHue in its shader), neon frame, glow bar, mirror/panel grids
    // and sky background (see _applyStageHue).
    this.levelHue = 0;
    this.levelHueTarget = 0;
    this.gridHue = -1; // last hue the grid vertex colors were repainted at
    this.frameEdgeBase = new THREE.Color(0x5ff0ff);
    this.frameRailBase = new THREE.Color(0x53e0f7);
    this.stageBgBase = new THREE.Color(0x070b1a);

    // Redline alarm: the stage turns crimson as the stack climbs toward
    // the top of the well (main.js feeds the pure dangerOf(board) level
    // via setDanger every frame). The eased `danger` is pushed to the
    // pixels by _applyDanger() each tick: crimson tint on the neon frame,
    // side rails, glow bar (heartbeat-bright) and the mirror/panel grids,
    // a crimson wash over the aurora sky, and a pulsing red edge-glow in
    // the cinematic grade. The heartbeat (pure dangerBeat) modulates the
    // tint strength between ~62% and full so the alarm pulses like a
    // thumping pulse. danger 0 is the exact identity everywhere.
    this.danger = 0;
    this.dangerTarget = 0;
    this.dangerTint = new THREE.Color(0xd4243d);

    this._buildEnvironment();
    this._buildBoardFrame();
    this._buildLights();
    this._buildEnvironmentMap();

    // Shared geometry + materials.
    this.blockGeo = new RoundedBoxGeometry(0.94, 0.94, 0.94, 2, 0.09);
    this.ghostGeo = new RoundedBoxGeometry(0.9, 0.9, 0.9, 1, 0.06);
    this.ghostEdgeGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(0.92, 0.92, 0.92));
    // Crystal blocks: core-glow emissive map + fresnel rim (see
    // makeCrystalMat). The core map darkens block edges, so the stack
    // emissive is nudged up from 0.5 to keep per-block color on a full
    // board without clipping to a white blob.
    this.coreTex = coreGlowTexture();
    const white = new THREE.Color(0xffffff);
    // Streak-mode uniform objects: ONE live {value} drives the settled
    // stack's hue wave (tick() eases it from streakIntensity(level)); the
    // active piece gets a PINNED-zero object so the hero stays pure while
    // the stack ripples. crystalTime is the shared wave clock.
    this.streak = { value: 0 };
    this.streakOff = { value: 0 };
    this.crystalTime = { value: 0 };
    this.streakVal = 0;
    this.streakTarget = 0;
    this.stackMats = {};
    this.pieceMats = {};
    for (const [type, def] of Object.entries(PIECES)) {
      const color = new THREE.Color(def.color);
      this.stackMats[type] = makeCrystalMat(color, 0.50, 0.35, 0.22, 0.28, 0.15, this.coreTex, white, this.streak, this.crystalTime);
      this.pieceMats[type] = makeCrystalMat(color, 1.05, 0.70, 0.60, 0.2, 0.1, this.coreTex, white, this.streakOff, this.crystalTime);
      // Image-based lighting strength per role: the active piece is the hero
      // (bright, sharp reflections), the settled stack reads as a softer
      // sheen. Kept modest so a full board's reflections can't clip to a
      // white blob (the direct lights + emissive core already carry the hue).
      this.stackMats[type].envMapIntensity = 0.25;
      this.pieceMats[type].envMapIntensity = 0.65;
    }

    // Stack mesh pool: key "x,y" -> mesh, plus the piece type each mesh
    // currently shows (the "prev" state for diffStack).
    this.stackMeshes = new Map();
    this.stackTypes = new Map();
    this.pops = []; // { mesh, t } lock pop animations

    // Row-collapse settle: on a line clear the rows above it shift down;
    // the renderer slides every shifted block from its source row (the pure
    // sourceRow() in stack-diff.js inverts the engine's compaction) to its
    // resting row with a soft bounce. onLineClear records the cleared rows
    // and the NEXT setStack consumes them (main.js calls onLineClear before
    // setStack for exactly this reason). Blocks whose visible cell is
    // unchanged (same type shifted onto the same type) get no slide —
    // nothing visibly moves, so animating them would be noise.
    this.slides = []; // { key, mesh, fromY, toY, t, dur }
    this.pendingClearRows = null;
    this.collapseCount = 0; // total settle slides ever registered (test probe)
    this.settleDip = 0; // the camera dips with the weight of the collapse

    // Current piece group.
    this.pieceGroup = new THREE.Group();
    this.scene.add(this.pieceGroup);
    this.pieceType = null;
    this.pieceAngle = 0;
    this.pieceAngleTarget = 0;
    this.pieceLastRot = 0;
    this.piecePos = new THREE.Vector3();
    this.piecePosTarget = new THREE.Vector3();
    this.pieceSpawnT = 1; // 0..1 spawn scale-in

    // Stardust wake: the active piece sheds piece-colored stardust as it
    // descends (see _spawnWakeMote + tick). The wake accumulator banks the
    // piece's rendered downward motion (world units) between frames; every
    // WAKE_STEP of it sheds one mote at the piece's rendered base, drifting
    // up off it in zero gravity so the wake trails the body like a comet
    // tail. Gated on the piece's visibility (hidden-row pieces shed none)
    // and the game-over cinematic; a hard drop sheds nothing because the
    // fresh spawn that follows always jumps the target back UP, which
    // drains the bank (the pure accumulator lives in src/fall-dust.js).
    this.wake = { acc: 0, lastY: null };
    this.wakeMotes = 0; // total motes shed (test probe; reset() re-arms)

    // Ghost group. Materials are cached per type: the group is rebuilt on
    // every type change, and allocating fresh materials each time would
    // leak GPU memory over a long game.
    this.ghostGroup = new THREE.Group();
    this.scene.add(this.ghostGroup);
    this.ghostType = null;
    this.ghostMats = {};
    // Shared time uniform for the holo ghost face shaders: one object is
    // referenced by every per-type face material, so a single update in
    // tick() advances the scanline shimmer on all of them.
    this.ghostTime = { value: 0 };

    // Holographic rotation echo: a pool of afterimage groups. On every
    // successful rotation the PRE-rotation footprint flashes as a holo
    // piece (the same shader as the ghost faces) that swells slightly and
    // fades over ECHO_LIFE s (the pure envelope lives in src/echo.js).
    // One material set per slot (never shared across slots) so concurrent
    // echoes fade independently; per-slot materials are cached by type so
    // a long game doesn't leak GPU memory. All identical shader code
    // compiles to one program; only the uniforms differ per material.
    this.echoGroup = new THREE.Group();
    this.scene.add(this.echoGroup);
    this.echoes = [];
    for (let i = 0; i < 8; i++) {
      const group = new THREE.Group();
      group.visible = false;
      this.echoGroup.add(group);
      this.echoes.push({ group, type: null, mats: {}, t: 0 });
    }
    this.echoCursor = 0;
    this.lastEchoT = -10;

    // FX.
    this.flashes = []; // { mesh, t }
    this.flashGeo = new THREE.PlaneGeometry(1, 1);
    this._buildParticles();
    this.dust = this._buildDust();
    this._buildClearFX();
    this._buildSweeps();
    this._buildTrails();
    this._buildImpacts();
    this._buildGhostProjector();
    this._buildPopups();
    this._buildHoloDisplays();
    this._buildRafterSpots();
    this._buildMeteors();

    // Post-processing: bloom is what makes it glow.
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.8, 0.55, 0.75);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    // Final pass: the cinematic grade, on the tone-mapped image. It is the
    // last enabled pass, so EffectComposer renders it straight to screen.
    this.gradePass = new ShaderPass(GRADE_SHADER);
    this.composer.addPass(this.gradePass);

    this.resize(w, h);
  }

  _buildEnvironment() {
    // Starfield (three layers for depth; soft round sprites).
    this.starsFar = makeStars(1500, 50, 140, 0.6, 0.7);
    this.starsMid = makeStars(500, 40, 100, 0.9, 0.7, 0xbcd0ff);
    this.starsNear = makeStars(320, 35, 90, 1.4, 0.85, 0xeaf2ff);
    this.scene.add(this.starsFar, this.starsMid, this.starsNear);

    // Aurora sky: animated fbm light curtains on a big plane behind the
    // board. Additive over the dark background; uPulse flares it on clears.
    this.auroraPulse = 0;
    this.auroraUniforms = {
      uTime: { value: 0 },
      uPulse: { value: 0 },
      uDim: { value: 0 },
      uHue: { value: 0 },
      uDanger: { value: 0 },
    };
    const aurora = new THREE.Mesh(
      new THREE.PlaneGeometry(170, 105),
      new THREE.ShaderMaterial({
        uniforms: this.auroraUniforms,
        vertexShader: AURORA_VERT,
        fragmentShader: AURORA_FRAG,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    aurora.position.set(0, BOARD_CY, -45);
    this.scene.add(aurora);

    // Mirror stage floor: a real planar mirror (Reflector) re-renders the
    // whole scene from a virtual camera mirrored below the floor plane, so
    // everything on stage — stack, neon frame, hard-drop trails, clear
    // bursts, aurora — is doubled in the glass. 512px target + no MSAA
    // keeps the extra pass cheap (the visible reflection wedge is small);
    // the custom shader tints the reflection and fades it with distance.
    this.mirror = new Reflector(
      new THREE.PlaneGeometry(300, 300),
      {
        clipBias: 0.003,
        textureWidth: 512,
        textureHeight: 512,
        multisample: 0,
        color: 0x93a8c8,
        shader: MIRROR_SHADER,
      },
    );
    this.mirror.rotation.x = -Math.PI / 2;
    this.mirror.position.y = -0.53;
    this.scene.add(this.mirror);

    // Grid floating just above the mirror: neon grid lines on dark glass.
    // Kept on the renderer: the level palette re-inks its baked vertex
    // colors (the per-vertex base copy is the repaint source of truth).
    this.floorGrid = new THREE.GridHelper(300, 75, 0x3a63c4, 0x14224a);
    this.floorGridBase = this.floorGrid.geometry.getAttribute('color').array.slice();
    this.floorGrid.position.y = -0.48;
    this.floorGrid.material.transparent = true;
    this.floorGrid.material.opacity = 0.5;
    this.floorGrid.material.fog = true;
    this.scene.add(this.floorGrid);
  }

  _buildBoardFrame() {
    const frame = new THREE.Group();
    this.frame = frame;
    this.scene.add(frame);

    // Frosted back panel.
    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(BOARD_W + 0.7, BOARD_H + 0.7, 0.5),
      new THREE.MeshPhysicalMaterial({
        color: 0x0e1a38,
        metalness: 0.6,
        roughness: 0.3,
        transparent: true,
        opacity: 0.62,
        envMapIntensity: 0.5,
      }),
    );
    panel.position.set(0, BOARD_CY, -0.55);
    frame.add(panel);

    // Faint cell grid on the panel (kept on the renderer: the level
    // palette re-inks its vertex colors with the neon frame).
    this.panelGrid = new THREE.GridHelper(BOARD_W, COLS, 0x24407c, 0x152449);
    this.panelGridBase = this.panelGrid.geometry.getAttribute('color').array.slice();
    this.panelGrid.rotation.x = Math.PI / 2;
    this.panelGrid.position.set(0, BOARD_CY, -0.26);
    this.panelGrid.material.transparent = true;
    this.panelGrid.material.opacity = 0.55;
    frame.add(this.panelGrid);

    // Neon outline (material kept on the renderer: the game-over dim and
    // reset restore both the edges and the side rails).
    this.frameEdgesMat = new THREE.LineBasicMaterial({
      color: 0x5ff0ff,
      transparent: true,
      opacity: 1.0,
      blending: THREE.AdditiveBlending,
    });
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(BOARD_W + 0.95, BOARD_H + 0.95, 0.62)),
      this.frameEdgesMat,
    );
    edges.position.set(0, BOARD_CY, -0.3);
    frame.add(edges);

    // Bottom glow bar (bloom picks it up). frameBarBase is the neutral
    // level-1 color; frameBarColor is the hue-shifted current value that
    // tick() dims with the game-over lights out.
    this.frameBarMat = new THREE.MeshBasicMaterial({ color: 0xa5f3fc });
    this.frameBarBase = new THREE.Color(0xa5f3fc);
    this.frameBarColor = new THREE.Color(0xa5f3fc);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(BOARD_W + 0.95, 0.16, 0.16), this.frameBarMat);
    bar.position.set(0, 0.12, 0.32);
    frame.add(bar);

    // Side rails.
    const railGeo = new THREE.BoxGeometry(0.14, BOARD_H + 0.95, 0.14);
    const railMat = new THREE.MeshBasicMaterial({ color: 0x53e0f7, transparent: true, opacity: 1.0 });
    this.frameRailMat = railMat; // dimmed on game over, restored on reset
    for (const sx of [-1, 1]) {
      const rail = new THREE.Mesh(railGeo, railMat);
      rail.position.set(sx * (BOARD_W / 2 + 0.42), BOARD_CY, 0.28);
      frame.add(rail);
    }
  }

  _buildLights() {
    this.scene.add(new THREE.AmbientLight(0x9fb4dd, 0.95));
    const key = new THREE.DirectionalLight(0xcfe4ff, 2.4);
    key.position.set(7, 20, 16);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x4d8bff, 1.5);
    rim.position.set(-4, 10, -10);
    this.scene.add(rim);
    // Backlight behind the frosted panel: makes the board interior glow.
    const back = new THREE.PointLight(0x2fd4ff, 60, 30, 1.8);
    back.position.set(0, BOARD_CY, -2.5);
    this.scene.add(back);
  }

  // Bake the procedural studio environment into a PMREM texture and apply it
  // as the scene's image-based lighting. Every MeshStandard/PhysicalMaterial
  // in the scene (crystal blocks, frosted panel) now reflects the softboxes,
  // so the blocks read as real, light-catching gems. PMREM is a one-time
  // cost; the per-frame cost is just a mipmap texture lookup in the standard
  // material's specular term. (The Reflector's mirror pass re-applies the
  // same environment, so the reflection shows the same gem sheen.)
  _buildEnvironmentMap() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();
    const eq = envEquirectTexture();
    this.envRT = pmrem.fromEquirectangular(eq);
    this.envMap = this.envRT.texture;
    this.scene.environment = this.envMap;
    eq.dispose();
    pmrem.dispose();
  }

  _buildParticles() {
    const N = 900;
    this.pCount = N;
    this.pPos = new Float32Array(N * 3);
    this.pCol = new Float32Array(N * 3);
    this.pBase = new Float32Array(N * 3);
    this.pVel = new Float32Array(N * 3);
    this.pLife = new Float32Array(N);
    this.pMax = new Float32Array(N);
    // Per-particle gravity: line-clear sparks use 16 (snappy burst), the
    // game-over dissolve embers use ~2 (dreamy slow sink). Set explicitly at
    // every spawn because pool slots keep their previous value.
    this.pGrav = new Float32Array(N).fill(16);
    this.pCursor = 0;
    for (let i = 0; i < N; i++) this.pPos[i * 3 + 1] = -9999;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    const m = new THREE.PointsMaterial({
      size: 0.22,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.particles = new THREE.Points(g, m);
    this.particles.frustumCulled = false;
    this.scene.add(this.particles);
  }

  // Ambient light dust: a field of fine motes drifting slowly up through
  // the stage air (camera side of the glow bar, z >= -0.4) catching the
  // aurora light. Each mote twinkles on its own phase/frequency (a few
  // "hot" sparkles run much brighter than the fine dust), the whole field
  // is stage-hue tinted via the material color (re-inked by _applyStageHue)
  // and dims with the game-over lights-out. The Reflector doubles the field
  // in the mirror glass. Positions persist across restarts (ambient
  // continuity); brightness lives in the per-vertex color attribute
  // (grayscale), updated every tick.
  _buildDust() {
    const N = 150;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    this.dustPos = pos;
    this.dustCol = col;
    this.dustData = [];
    for (let i = 0; i < N; i++) {
      pos[i * 3] = -8.2 + Math.random() * 16.4;
      pos[i * 3 + 1] = -0.3 + Math.random() * 24.8;
      pos[i * 3 + 2] = -0.4 + Math.random() * 3.6;
      this.dustData.push({
        vy: 0.05 + Math.random() * 0.17, // slow up-drift (world units/s)
        swayAmp: 0.2 + Math.random() * 0.6, // horizontal sway amplitude
        swayW: 0.12 + Math.random() * 0.3, // sway frequency (rad/s)
        phase: Math.random() * Math.PI * 2,
        twW: 0.5 + Math.random() * 1.6, // twinkle frequency (rad/s)
        // A few hot sparkles run much brighter; the fine dust stays faint.
        base: Math.random() < 0.18 ? 1.0 + Math.random() * 1.1 : 0.16 + Math.random() * 0.3,
      });
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const m = new THREE.PointsMaterial({
      size: 0.18,
      map: glowTexture(), // round soft sprites
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.dustTintBase = new THREE.Color(0xeef4ff);
    this.dustTint = this.dustTintBase.clone();
    m.color.copy(this.dustTint);
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    this.scene.add(pts);
    return pts;
  }

  // Pooled line-clear FX: expanding shockwave rings (one per cleared row)
  // and energy shards (one per cell) that fly outward and up. Pools avoid
  // per-clear allocation; both render additively on top of the stack.
  _buildClearFX() {
    this.rings = [];
    const ringGeo = new THREE.RingGeometry(0.9, 1.0, 72);
    for (let i = 0; i < 4; i++) {
      const mesh = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          depthTest: false,
          side: THREE.DoubleSide,
        }),
      );
      mesh.visible = false;
      mesh.renderOrder = 10;
      this.scene.add(mesh);
      this.rings.push({ mesh, t: 1, h: 1 });
    }
    this.ringCursor = 0;

    this.shards = [];
    const shardGeo = new THREE.PlaneGeometry(0.55, 0.55);
    for (let i = 0; i < 48; i++) {
      const mesh = new THREE.Mesh(
        shardGeo,
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          depthTest: false,
          side: THREE.DoubleSide,
        }),
      );
      mesh.visible = false;
      mesh.renderOrder = 11;
      this.scene.add(mesh);
      this.shards.push({ mesh, t: 1, max: 1, vx: 0, vy: 0, vz: 0, spin: 0 });
    }
    this.shardCursor = 0;

    this.flash = 0; // TETRIS screen flash: transient bloom-strength spike
    this.bloomBase = 0.8;

    // TETRIS full-board flash quad (HDR additive, in front of the board).
    // Radial falloff so the flash reads as a burst from the board center
    // instead of a flat whiteout that buries the rings/shards.
    this.tetrisFlashMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        color: 0xbfe8ff,
        map: glowTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0.45)'),
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
      }),
    );
    this.tetrisFlashMesh.material.color.multiplyScalar(1.3); // HDR
    this.tetrisFlashMesh.position.set(0, BOARD_CY, 1.5);
    // Sized so the radial falloff reaches zero before the canvas edges;
    // a bigger quad leaves the margins (floor/sky) washed too.
    this.tetrisFlashMesh.scale.set(22, 34, 1);
    this.tetrisFlashMesh.visible = false;
    this.tetrisFlashMesh.renderOrder = 12;
    this.scene.add(this.tetrisFlashMesh);
  }

  // Pooled line-clear light sweeps: per entry a bright thin edge quad (the
  // wipe's leading line, HDR white-cyan so it clears the bloom threshold)
  // plus a wider trail quad (the sweepTrailTexture gradient, tinted with
  // the run's row palette, mirrored for right-to-left wipes via a negative
  // scale.x — the trail material is DoubleSide so the flip still draws).
  // Both quads are additive, depthTest-off and render above the stack, and
  // the Reflector's mirror pass doubles the whole wipe in the stage glass.
  _buildSweeps() {
    this.sweeps = [];
    // Shared trail textures: the normal white ramp, and the full-rainbow
    // ramp used by the streak-ignition sweep (a pooled entry's trail
    // material swaps between them per spawn).
    this.sweepTrailTex = sweepTrailTexture();
    this.rainbowTex = rainbowTrailTexture();
    for (let i = 0; i < 4; i++) {
      const edge = new THREE.Mesh(
        this.flashGeo,
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          depthTest: false,
        }),
      );
      edge.renderOrder = 12;
      const trail = new THREE.Mesh(
        this.flashGeo,
        new THREE.MeshBasicMaterial({
          map: this.sweepTrailTex,
          color: 0xffffff,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          depthTest: false,
          side: THREE.DoubleSide,
        }),
      );
      trail.renderOrder = 11;
      const group = new THREE.Group();
      group.add(trail);
      group.add(edge);
      group.visible = false;
      this.scene.add(group);
      this.sweeps.push({
        group,
        edge,
        trail,
        t: 1, // negative t = staggered start (multi-run cascades)
        dur: 0.3,
        dir: 1,
        h: 1,
        y: 0,
        xA: SWEEP_X0,
        xB: SWEEP_X1,
        gain: 1,
      });
    }
    this.sweepCursor = 0;
    this.sweepParity = 0; // alternates the wipe direction per clear
    this.sweepDir = 1;
    this.swept = 0; // total sweeps ever fired (test probe)
  }

  // Pooled hard-drop light trails: one streak per occupied column, from
  // where the piece was released to where it landed. Each trail has its own
  // material (independent fade); the pool avoids per-drop allocation.
  _buildTrails() {
    this.trailTex = trailTexture(); // shared by every pooled streak
    this.trails = [];
    for (let i = 0; i < 12; i++) {
      const mesh = new THREE.Mesh(
        this.flashGeo,
        new THREE.MeshBasicMaterial({
          map: this.trailTex,
          color: 0xffffff,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          depthTest: false,
        }),
      );
      mesh.visible = false;
      mesh.renderOrder = 10;
      this.scene.add(mesh);
      this.trails.push({ mesh, t: 1 });
    }
    this.trailCursor = 0;
  }

  // Pooled lock-impact FX: a soft radial splash disc (a pool of light
  // spreading across the mirror floor) plus a thin ring rim (the sonic
  // ripple). Shared geometries/textures, per-entry materials for independent
  // color/opacity. The Reflector's mirror pass re-renders the scene from
  // below the floor, so the splash is automatically doubled in the glass.
  _buildImpacts() {
    const discGeo = new THREE.PlaneGeometry(1, 1);
    discGeo.rotateX(-Math.PI / 2); // lie flat on the floor (normal +Y)
    const ringGeo = new THREE.RingGeometry(0.78, 1.0, 48);
    ringGeo.rotateX(-Math.PI / 2);
    this.splashTex = splashTexture(); // shared by every pooled disc
    this.impactFloorY = IMPACT_FLOOR_Y;
    this.impacts = [];
    for (let i = 0; i < 8; i++) {
      const mk = (geo, map) => {
        const mesh = new THREE.Mesh(
          geo,
          new THREE.MeshBasicMaterial({
            color: 0xffffff,
            map,
            transparent: true,
            opacity: 0,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            side: THREE.DoubleSide, // visible from the mirror pass too
          }),
        );
        mesh.visible = false;
        mesh.renderOrder = 5;
        this.scene.add(mesh);
        return mesh;
      };
      this.impacts.push({
        disc: mk(discGeo, this.splashTex),
        ring: mk(ringGeo, null),
        t: 1,
        s: 1,
        k: 1,
      });
    }
    this.impactCursor = 0;
  }

  // Holographic landing projector for the ghost: a faint light pillar from
  // the mirror floor up to the ghost's base, plus a small emitter pool of
  // light on the glass. The pillar reuses the hard-drop trail texture
  // (bright at the emitter end, tapering toward the ghost) and the pool
  // reuses the lock-splash texture; the Reflector's mirror pass re-renders
  // both, so the projector reads as a projection rising out of the stage.
  // Both are additive and deliberately faint: the ghost is on screen every
  // frame, so the projector must read as atmosphere, not as FX.
  _buildGhostProjector() {
    const emitterGeo = new THREE.PlaneGeometry(1, 1);
    emitterGeo.rotateX(-Math.PI / 2); // lie flat on the floor (normal +Y)
    this.ghostBeam = new THREE.Mesh(
      this.flashGeo,
      new THREE.MeshBasicMaterial({
        map: this.trailTex,
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.ghostBeam.visible = false;
    this.scene.add(this.ghostBeam);
    this.ghostEmitter = new THREE.Mesh(
      emitterGeo,
      new THREE.MeshBasicMaterial({
        map: this.splashTex,
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide, // visible from the mirror pass too
      }),
    );
    this.ghostEmitter.visible = false;
    this.scene.add(this.ghostEmitter);
  }

  // Ghost face: an animated holo shell (custom shader, shared across all 7
  // per-type materials — same code, so three.js compiles ONE program and
  // only the tint uniform differs). Fresnel silhouette (the shell reads
  // strongest at grazing angles, so its edge glows through bloom) plus
  // world-space horizontal scanlines drifting upward, plus a slow pulse.
  // Additive with alpha 1: the brightness IS the opacity.
  // Holographic hold + next-queue displays: mini holo pieces in cradle
  // rings flanking the board (hold left, next right), each display lit by
  // a faint light pillar from the mirror floor and an emitter pool on the
  // glass (both doubled by the Reflector), with a small caption. A hold
  // swap pings the hold side (emitter flare + a small floor ripple in the
  // piece's color); a queue shift pings the next side. Everything lives in
  // two groups (holoHoldGroup / holoNextGroup) so the game-over cinematic
  // can hide both displays with the rest of the stage.
  _buildHoloDisplays() {
    this.holoMats = {}; // per-type { box, edge } for the display pieces
    this.holoPulse = { hold: 0, next: 0 }; // swap/shift pings, decay in tick
    this.holoHoldGroup = new THREE.Group();
    this.holoNextGroup = new THREE.Group();
    this.scene.add(this.holoHoldGroup, this.holoNextGroup);

    // Small glowing caption above each display column.
    const labelTex = (text) => {
      const c = document.createElement('canvas');
      c.width = 256;
      c.height = 64;
      const ctx = c.getContext('2d');
      ctx.font = '700 34px "Arial Black", "Helvetica Neue", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(140,235,255,0.9)';
      ctx.shadowBlur = 14;
      ctx.fillStyle = '#bfeaff';
      ctx.fillText(text, 128, 32);
      ctx.shadowBlur = 0;
      ctx.fillText(text, 128, 32);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    };
    const label = (text, x, y, group) => {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(1.7, 1.7 * (64 / 256)),
        new THREE.MeshBasicMaterial({
          map: labelTex(text),
          transparent: true,
          opacity: 0.55,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          depthTest: false,
          side: THREE.DoubleSide,
        }),
      );
      mesh.position.set(x, y, 0.4);
      mesh.renderOrder = 15;
      group.add(mesh);
    };
    label('NEXT', HOLO_X, NEXT_SLOT_Y[0] + 1.5, this.holoNextGroup);
    label('HOLD', -HOLO_X, HOLD_Y + 1.6, this.holoHoldGroup);

    const cradleGeo = new THREE.RingGeometry(0.5, 0.62, 40);
    cradleGeo.rotateX(-Math.PI / 2); // flat ring under the piece

    const mkSlot = (group, x, y, scale) => {
      const slotGroup = new THREE.Group();
      slotGroup.position.set(x, y, 0.4);
      const piece = new THREE.Group();
      slotGroup.add(piece);
      const cradle = new THREE.Mesh(
        cradleGeo,
        new THREE.MeshBasicMaterial({
          color: 0x9fe8ff,
          transparent: true,
          opacity: 0.2,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide, // the mirror pass sees the cradle too
        }),
      );
      cradle.position.y = -0.95;
      slotGroup.add(cradle);
      slotGroup.scale.setScalar(scale);
      group.add(slotGroup);
      return { group: slotGroup, piece, cradle, x, y, scale, type: null, pop: 1 };
    };
    this.holoHold = mkSlot(this.holoHoldGroup, -HOLO_X, HOLD_Y, HOLD_SCALE);
    this.holoNext = [
      mkSlot(this.holoNextGroup, HOLO_X, NEXT_SLOT_Y[0], NEXT_SCALE),
      mkSlot(this.holoNextGroup, HOLO_X, NEXT_SLOT_Y[1], NEXT_SCALE),
      mkSlot(this.holoNextGroup, HOLO_X, NEXT_SLOT_Y[2], NEXT_SCALE),
    ];

    // Light pillar: mirror floor up to the display's base, reusing the
    // hard-drop trail texture (bright at the emitter end, tapering up).
    const pillar = (x, topY, group) => {
      const h = topY + 0.5; // the floor is at y -0.5
      const mesh = new THREE.Mesh(
        this.flashGeo,
        new THREE.MeshBasicMaterial({
          map: this.trailTex,
          color: 0xffffff,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      mesh.position.set(x, -0.5 + h / 2, 0.25);
      mesh.scale.set(0.26, h, 1);
      group.add(mesh);
      return mesh;
    };
    this.holoHoldBeam = pillar(-HOLO_X, HOLD_Y - 1.15 * HOLD_SCALE, this.holoHoldGroup);
    this.holoNextBeam = pillar(HOLO_X, NEXT_SLOT_Y[2] - 1.15 * NEXT_SCALE, this.holoNextGroup);

    // Emitter pools of light on the mirror glass under each display column
    // (the Reflector doubles them in the reflection).
    const emitterGeo = new THREE.PlaneGeometry(1, 1);
    emitterGeo.rotateX(-Math.PI / 2); // lie flat on the floor (normal +Y)
    const emitter = (x, group) => {
      const mesh = new THREE.Mesh(
        emitterGeo,
        new THREE.MeshBasicMaterial({
          map: this.splashTex,
          color: 0xffffff,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide, // visible from the mirror pass too
        }),
      );
      mesh.position.set(x, IMPACT_FLOOR_Y, 0.15);
      mesh.scale.set(1.15, 1, 1.15);
      group.add(mesh);
      return mesh;
    };
    this.holoHoldEmitter = emitter(-HOLO_X, this.holoHoldGroup);
    this.holoNextEmitter = emitter(HOLO_X, this.holoNextGroup);
  }

  // Per-type holo material for the display pieces (the same shared shader
  // as the ghost faces; a separate cache from ghostMats so the display's
  // edge lines aren't animated by the ghost projector's tick block).
  _holoDisplayMat(type) {
    return (this.holoMats[type] ??= (() => {
      const color = new THREE.Color(PIECES[type].color);
      return {
        box: this._holoMat(color),
        edge: new THREE.LineBasicMaterial({
          color,
          transparent: true,
          opacity: 0.5,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      };
    })());
  }

  // Theatrical rafter spotlights: three volumetric beams (see SPOT_BEAMS)
  // from just above the frame into the top of the well. Shared uniform
  // objects drive all three shaft shaders at once (one update in tick()
  // advances uTime/uPulse/uDim/uHue on every beam). Caps and pools are
  // MeshBasicMaterials whose color objects are SHARED instances inked in
  // _applyStageHue (same pattern as the glow bar), so a per-frame tick is
  // never needed to re-ink them.
  _buildRafterSpots() {
    this.spotUniforms = {
      uTime: { value: 0 },
      uPulse: { value: 0 },
      uDim: { value: 0 },
      uHue: { value: 0 },
    };
    this.spotPulse = 0; // flare level, decays in tick()
    this.spots = new THREE.Group();
    this.scene.add(this.spots);

    const base = new THREE.Color(0x9fd8ff);
    // HDR bases: caps run a touch hotter than pools (but tinted cool enough
    // that ACES keeps them cyan, not a white blob — see the grade note on
    // the shaft coefficients); _applyStageHue's ink() copies these and
    // hue-shifts the live color objects in place.
    this.spotCapBase = base.clone().lerp(new THREE.Color(0xffffff), 0.25).multiplyScalar(1.2);
    this.spotPoolBase = base.clone().multiplyScalar(1.1);
    this.spotWashBase = base.clone().multiplyScalar(0.9);
    this.spotCapColor = this.spotCapBase.clone();
    this.spotPoolColor = this.spotPoolBase.clone();
    this.spotWashColor = this.spotWashBase.clone();

    const shaftGeo = new THREE.PlaneGeometry(1, 1);
    // ONE shared material per role (all lamps read the same light, all pools
    // the same): three.js' constructor would COPY a passed-in Color, so the
    // live inked color objects are assigned DIRECTLY after construction —
    // _applyStageHue then mutates them in place and every cap/pool sees it.
    this.spotCapMat = new THREE.MeshBasicMaterial({
      map: this.splashTex,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.spotCapMat.color = this.spotCapColor;
    this.spotPoolMat = new THREE.MeshBasicMaterial({
      map: this.splashTex,
      transparent: true,
      opacity: 0.18,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.spotPoolMat.color = this.spotPoolColor;
    this.spotWashMat = new THREE.MeshBasicMaterial({
      map: this.splashTex,
      transparent: true,
      opacity: 0.06,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.spotWashMat.color = this.spotWashColor;
    this.spotShafts = [];
    this.spotCaps = [];
    this.spotPools = [];
    for (const b of SPOT_BEAMS) {
      const dx = b.land[0] - b.top[0];
      const dy = b.land[1] - b.top[1];
      const L = Math.hypot(dx, dy);
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: this.spotUniforms.uTime,
          uPulse: this.spotUniforms.uPulse,
          uDim: this.spotUniforms.uDim,
          uHue: this.spotUniforms.uHue,
          uColor: { value: base.clone() },
          uGain: { value: b.gain },
        },
        vertexShader: SPOT_SHAFT_VERT,
        fragmentShader: SPOT_SHAFT_FRAG,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true, // the frosted panel occludes the beam below the frame top
        side: THREE.DoubleSide, // the mirror pass sees the back faces
      });
      const mesh = new THREE.Mesh(shaftGeo, mat);
      mesh.position.set((b.top[0] + b.land[0]) / 2, (b.top[1] + b.land[1]) / 2, b.top[2]);
      mesh.scale.set(b.w, L, 1);
      // Local +Y must point from the landing end up to the lamp end.
      mesh.rotation.z = Math.atan2(dx, -dy);
      this.spots.add(mesh);
      this.spotShafts.push({ mesh, top: b.top, land: b.land, w: b.w, gain: b.gain });

      // Hot lamp cap at the beam's source end (blooms into the sky band).
      const cap = new THREE.Mesh(this.flashGeo, this.spotCapMat);
      cap.position.set(b.top[0], b.top[1], b.top[2]);
      cap.scale.set(b.w * 0.9, b.w * 0.5, 1);
      this.spots.add(cap);
      this.spotCaps.push(cap);

      // Landing pool of light on the well's top edge under the beam.
      const pool = new THREE.Mesh(this.flashGeo, this.spotPoolMat);
      pool.position.set(b.land[0], SPOT_POOL_Y, 0.3);
      pool.scale.set(b.w * 0.85, 1.15, 1);
      this.spots.add(pool);
      this.spotPools.push(pool);
    }
    // Faint wide wash across the top rows: the well reads as lit from above.
    this.spotWash = new THREE.Mesh(this.flashGeo, this.spotWashMat);
    this.spotWash.position.set(0, 20.35, 0.3);
    this.spotWash.scale.set(BOARD_W + 0.9, 2.3, 1);
    this.spots.add(this.spotWash);
  }

  // Sky meteors: rare shooting stars streaking the aurora band — a hot
  // round head (splash texture) leading a trailing light tail (the sweep
  // trail texture, bright at its head end, rotated along the velocity) with
  // a slow spark drizzle shedding off the head. In front of the aurora
  // plane (z -45) and behind the board, so the frosted panel occludes the
  // exit. Pooled 3 entries; auto-spawn waits 8-14 s after load (a calm
  // sky for the stage to settle, and for early test phases) then fires
  // every 3.5-8 s. The game-over lights out suppresses new spawns while
  // in-flight meteors dim with the stage. The head runs just under the
  // white-clip line (cool tint keeps red below grade while blue clears
  // bloom); _applyStageHue re-inks the three live color objects in place
  // (assigned after construction: three would copy a passed-in Color).
  _buildMeteors() {
    this.meteorGroup = new THREE.Group();
    this.scene.add(this.meteorGroup);
    this.meteorHeadBase = new THREE.Color(0xbfe3ff).multiplyScalar(1.9);
    this.meteorTailBase = new THREE.Color(0x9fd8ff).multiplyScalar(1.05);
    this.meteorSparkBase = new THREE.Color(0xbfe3ff).multiplyScalar(1.8);
    this.meteorHeadColor = this.meteorHeadBase.clone();
    this.meteorTailColor = this.meteorTailBase.clone();
    this.meteorSparkColor = this.meteorSparkBase.clone();
    const geo = new THREE.PlaneGeometry(1, 1);
    this.meteors = [];
    for (let i = 0; i < 3; i++) {
      const headMat = new THREE.MeshBasicMaterial({
        map: this.splashTex,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
      });
      headMat.color = this.meteorHeadColor;
      const tailMat = new THREE.MeshBasicMaterial({
        map: this.sweepTrailTex,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide, // the mirror pass sees the back faces
      });
      tailMat.color = this.meteorTailColor;
      const head = new THREE.Mesh(geo, headMat);
      const tail = new THREE.Mesh(geo, tailMat);
      head.visible = false;
      tail.visible = false;
      this.meteorGroup.add(head, tail);
      this.meteors.push({ head, tail, headMat, tailMat, m: null, tailLen: 5 });
    }
    this.meteorCursor = 0;
    this.meteorCount = 0; // total meteors ever spawned (test probe)
    this.meteorNext = this.time + 8 + Math.random() * 6;
  }

  // Fire a shooting star. `spec` (null = a random auto-spawn spec from
  // meteorSpawnSpec) is {x0,y0,vx,vy,z,t0?,life,tail?}: tests pass an
  // exact spec (possibly with a FUTURE t0, so the flight starts on a
  // known schedule); production passes null. No-op while the game-over
  // lights out owns the stage (the dark sky stays quiet).
  spawnMeteor(spec = null) {
    if (this.over) return false;
    const m = spec || meteorSpawnSpec(this.time);
    const slot = this.meteors[this.meteorCursor];
    this.meteorCursor = (this.meteorCursor + 1) % this.meteors.length;
    slot.m = { ...m, t0: m.t0 ?? this.time };
    slot.tailLen = m.tail || 5;
    this.meteorCount++;
    return true;
  }

  // Rebuild a slot's mini piece (rotation-0 layout) from its type. An empty
  // type (fresh game, no held piece yet) leaves the cradle ring bare.
  _fillSlot(slot) {
    const g = slot.piece;
    while (g.children.length) g.remove(g.children.pop());
    if (!slot.type) return;
    const gm = this._holoDisplayMat(slot.type);
    const n = PIECES[slot.type].size;
    const half = (n - 1) / 2;
    for (const [r, c] of getCells(slot.type, 0)) {
      const box = new THREE.Mesh(this.ghostGeo, gm.box);
      box.position.set(c - half, -(r - half), 0);
      box.add(new THREE.LineSegments(this.ghostEdgeGeo, gm.edge));
      g.add(box);
    }
  }

  // Pooled 3D popup banners: big glowing type ("TETRIS!", "LEVEL 5", ...)
  // that pops in front of the board on major events, rises, and fades. The
  // label logic is pure and unit-tested (src/fx-labels.js); this class only
  // owns the pixels. Each entry owns a CanvasTexture redrawn per spawn (the
  // pool is tiny and banners are rare, so per-spawn texture upload is
  // fine). depthTest false + the scene's top renderOrder: the banner always
  // reads on top of the board, its clear FX and the TETRIS flash. The
  // Reflector's mirror pass re-renders it, so the banner is doubled on the
  // stage glass.
  //
  // TETRIS and the streak ignition additionally own an anamorphic flare
  // quad (just under the banner's renderOrder): a wide thin HDR streak that
  // widens with the dolly punch, blooms, and is doubled in the mirror
  // glass — the in-world half of the lens event (the grade pass adds the
  // full-width screen streak on top, driven by the same flareEnv).
  _buildPopups() {
    this.popupY = BOARD_CY + 1.6; // slightly above board center
    this.popupZ = 2.6; // well in front of the board plane
    this.popups = [];
    const geo = new THREE.PlaneGeometry(1, 1);
    this.flareTex = flareTexture(); // shared by every pooled flare quad
    for (let i = 0; i < 3; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.renderOrder = 20;
      this.scene.add(mesh);
      const flareMat = new THREE.MeshBasicMaterial({
        map: this.flareTex,
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
      });
      const flareMesh = new THREE.Mesh(geo, flareMat);
      flareMesh.visible = false;
      flareMesh.renderOrder = 19; // under the banner, above the TETRIS flash (12)
      this.scene.add(flareMesh);
      this.popups.push({
        mesh, mat, tex: null, aspect: 0.25,
        t: 1, life: 1, w: 6, gain: 1, text: '', tier: 'double', yOff: 0,
        flareMesh, flareMat, flareOn: false,
      });
    }
  }

  // Draw the banner type onto a fresh canvas texture. The font is shrunk
  // until the line fits 86% of the canvas width. Two glow passes (wide soft
  // + tight hot) then the sharp face; TETRIS gets a rainbow face + a
  // white-hot core so bloom catches it hardest.
  _popupTexture(text, tier) {
    const spec = POPUP_STYLE[tier] || POPUP_STYLE.double;
    const W = 1024;
    const H = 256;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');
    const font = (s) => `900 ${s}px "Arial Black", "Helvetica Neue", system-ui, sans-serif`;
    let fs = Math.floor(H * 0.68);
    ctx.font = font(fs);
    while (ctx.measureText(text).width > W * 0.86 && fs > 24) {
      fs -= 4;
      ctx.font = font(fs);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cy = H / 2;
    const face = () => {
      if (tier === 'tetris') {
        const g = ctx.createLinearGradient(0, 0, W, 0);
        g.addColorStop(0.0, '#5ff0ff');
        g.addColorStop(0.3, '#8f7dff');
        g.addColorStop(0.55, '#ff5ad5');
        g.addColorStop(0.8, '#ffb35a');
        g.addColorStop(1.0, '#fff3c4');
        ctx.fillStyle = g;
      } else if (tier === 'streak') {
        // The stack just ignited into a living rainbow: the banner wears
        // the same spectrum, gold-first so it reads as 'something just
        // came alive' rather than a cold reset.
        const g = ctx.createLinearGradient(0, 0, W, 0);
        g.addColorStop(0.0, '#ffe9a8');
        g.addColorStop(0.28, '#6dff8f');
        g.addColorStop(0.55, '#57d6ff');
        g.addColorStop(0.8, '#c58bff');
        g.addColorStop(1.0, '#ff5ad5');
        ctx.fillStyle = g;
      } else if (tier === 'gameover') {
        // Cold "lights out" gradient: ice white through blue to violet —
        // the banner reads as the last light in the room.
        const g = ctx.createLinearGradient(0, 0, W, 0);
        g.addColorStop(0.0, '#f4f8ff');
        g.addColorStop(0.5, '#a8c6ff');
        g.addColorStop(1.0, '#8a7bff');
        ctx.fillStyle = g;
      } else if (tier === 'perfect') {
        // Gold-white trophy: a symmetric warm core (white-gold center)
        // flanked by magenta/cyan edges so it reads as a rare event
        // against the cool stage, distinct from the TETRIS rainbow and
        // the streak spectrum (both run left-to-right, asymmetric).
        const g = ctx.createLinearGradient(0, 0, W, 0);
        g.addColorStop(0.0, '#ff5ad5');
        g.addColorStop(0.25, '#ffd75e');
        g.addColorStop(0.5, '#fffbe8');
        g.addColorStop(0.75, '#ffd75e');
        g.addColorStop(1.0, '#5ff0ff');
        ctx.fillStyle = g;
      } else {
        ctx.fillStyle = spec.color;
      }
    };
    ctx.shadowColor = spec.glow;
    ctx.shadowBlur = 48;
    face();
    ctx.fillText(text, W / 2, cy);
    ctx.shadowBlur = 14;
    face();
    ctx.fillText(text, W / 2, cy);
    ctx.shadowBlur = 0;
    face();
    ctx.fillText(text, W / 2, cy);
    if (tier === 'tetris' || tier === 'streak' || tier === 'perfect') {
      // Hot-core pass: a WHITE hint at the glyph centers, kept faint enough
      // (0.22) that the rainbow face still reads through ACES + bloom — at
      // 0.5 the whole banner washed to a white blob on the TETRIS frame.
      ctx.shadowColor = 'rgba(255,255,255,0.9)';
      ctx.shadowBlur = 4;
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.fillText(text, W / 2, cy);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return { tex, aspect: H / W };
  }

  // Spawn a banner: { text, tier } (from popupFor). Steals the next free
  // pool slot, or the furthest-along entry if all are busy. A TETRIS banner
  // also fires the cinematic camera dolly-in.
  showPopup({ text, tier = 'double' }) {
    const spec = POPUP_STYLE[tier] || POPUP_STYLE.double;
    let p = this.popups.find((q) => q.t >= 1);
    if (!p) p = this.popups.reduce((a, b) => (a.t > b.t ? a : b));
    if (p.tex) {
      p.tex.dispose();
      p.tex = null;
    }
    const built = this._popupTexture(text, tier);
    p.tex = built.tex;
    p.aspect = built.aspect;
    p.mat.map = built.tex;
    p.mat.needsUpdate = true;
    p.mat.color.setScalar(spec.gain); // HDR: bright tiers clear bloom
    p.text = text;
    p.tier = tier;
    p.w = spec.w;
    p.life = spec.life;
    p.yOff = spec.yOffset || 0; // perfect floats above a concurrent TETRIS banner
    p.t = 0;
    p.mesh.visible = true;
    p.mesh.position.set(0, this.popupY + p.yOff, this.popupZ);
    p.mesh.scale.set(p.w, p.w * p.aspect, 1);
    p.mat.opacity = 0;
    if (tier === 'tetris' || tier === 'perfect') this.camPunch = 1;
    // Anamorphic flare: TETRIS, the streak ignition and a perfect clear
    // fire the lens event (the dolly punch above sells the rest). The 3D
    // streak quad takes a per-tier HDR tint (cool blue-cyan for TETRIS,
    // violet for the streak, warm gold for a perfect) so its bloom reads
    // as the lens, and the grade pass's streak is aimed at the banner's
    // current screen height (its vertical ghost and offset echo hang off
    // the same point).
    p.flareOn = tier === 'tetris' || tier === 'streak' || tier === 'perfect';
    if (p.flareOn) {
      const tint = tier === 'streak' ? 0xcdb4ff : tier === 'perfect' ? 0xfff2cc : 0xbfe8ff;
      const gain = tier === 'tetris' ? 1.6 : tier === 'perfect' ? 1.5 : 1.4;
      p.flareMat.color.set(tint);
      p.flareMat.color.multiplyScalar(gain);
      const v = new THREE.Vector3(0, this.popupY + p.yOff, this.popupZ).project(this.camera);
      this.gradePass.uniforms.uFlareY.value = (v.y + 1) / 2;
      p.flareMesh.visible = true;
    } else {
      p.flareMesh.visible = false;
    }
    p.flareMat.opacity = 0;
  }

  _holoMat(color) {
    const tint = color.clone().lerp(new THREE.Color(0x9fe8ff), 0.5).multiplyScalar(1.2);
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.ghostTime,
        uColor: { value: tint },
        // Per-material fade (1 = full). The ghost/display materials pin it
        // at 1; rotation-echo slots animate it down in tick(), so several
        // echoes of one type can fade independently.
        uFade: { value: 1 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vN;
        varying vec3 vWPos;
        void main() {
          vN = normalize(mat3(modelMatrix) * normal);
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWPos = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        #include <common>
        uniform float uTime;
        uniform float uFade;
        uniform vec3 uColor;
        varying vec3 vN;
        varying vec3 vWPos;
        void main() {
          // Fresnel silhouette in world space (camera tilt is small, so it
          // reads as a screen-space rim too).
          vec3 v = normalize(cameraPosition - vWPos);
          float fres = pow(1.0 - saturate(dot(normalize(vN), v)), 2.2);
          // Horizontal scanlines in WORLD y (world horizontal reads as screen
          // horizontal at this camera tilt), drifting upward over time.
          float scan = mix(0.55, 1.0, 0.5 + 0.5 * sin(vWPos.y * 16.0 - uTime * 7.0));
          float pulse = 0.85 + 0.15 * sin(uTime * 2.4);
          vec3 col = uColor * (0.16 + 0.55 * fres) * scan * pulse;
          col *= uFade;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }

  // World y of the ghost's lowest point (bottom edge of its lowest occupied
  // cell) — the projector pillar ends here. maxR per rotation because
  // rotation layouts don't always fill the bounding box (e.g. I flat).
  _ghostBottomY(type, rotation, y) {
    let maxR = 0;
    for (const [r] of getCells(type, rotation)) if (r > maxR) maxR = r;
    return toWorldY(y + maxR) - 0.5;
  }

  // Project a world point to canvas device pixels. A planar mirror's
  // virtual image projects exactly like a real object at the point mirrored
  // across the mirror plane, so tests use this to sample where a known
  // object's REFLECTION must appear on screen.
  projectToPixel(x, y, z, out = {}) {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    out.x = ((v.x + 1) / 2) * this.canvas.width;
    out.y = ((1 - v.y) / 2) * this.canvas.height;
    return out;
  }

  // ---- Public API ----

  resize(w, h) {
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setPointer(x, y) {
    this.mouse.x = x; // -1..1
    this.mouse.y = y;
  }

  setStack(board) {
    // During the game-over dissolve the board is frozen: dissolved cells
    // must not be re-added by the per-frame diff.
    if (this.over) return;
    // diffStack also reports TYPE changes at existing keys: a line clear
    // shifts rows down, so a mesh's cell can change piece type in place.
    // Without applying those, shifted blocks keep their old material
    // (wrong-color glitch after every clear).
    const d = diffStack(this.stackTypes, board, {
      cols: COLS,
      totalRows: TOTAL_ROWS,
      hiddenRows: HIDDEN_ROWS,
    });
    for (const a of d.adds) {
      const mesh = new THREE.Mesh(this.blockGeo, this.stackMats[a.type]);
      mesh.position.set(toWorldX(a.x), toWorldY(a.y), 0);
      this.scene.add(mesh);
      this.stackMeshes.set(a.key, mesh);
      this.stackTypes.set(a.key, a.type);
    }
    for (const c of d.typeChanges) {
      const mesh = this.stackMeshes.get(c.key);
      if (mesh) mesh.material = this.stackMats[c.to];
      this.stackTypes.set(c.key, c.to);
    }
    for (const r of d.removes) {
      const mesh = this.stackMeshes.get(r.key);
      if (mesh) this.scene.remove(mesh);
      this.stackMeshes.delete(r.key);
      this.stackTypes.delete(r.key);
    }
    // Row-collapse settle: a line clear shifted the rows above it down. For
    // every added/retyped cell whose source row (sourceRow, the inverse of
    // the engine's compaction) differs from its resting row, start the mesh
    // at the source row and let tick() slide it down with a soft bounce.
    // A source in the hidden rows clamps to the top of the visible field so
    // the slide can never poke above the board frame.
    if (this.pendingClearRows) {
      const clears = this.pendingClearRows;
      this.pendingClearRows = null;
      const fieldTop = toWorldY(HIDDEN_ROWS - 1) + 0.5;
      for (const e of [...d.adds, ...d.typeChanges]) {
        const src = sourceRow(clears, e.y);
        if (src === e.y) continue;
        const mesh = this.stackMeshes.get(e.key);
        if (!mesh) continue;
        let fromY = toWorldY(src);
        if (fromY > fieldTop) fromY = fieldTop;
        const toY = toWorldY(e.y);
        if (fromY <= toY) continue;
        mesh.position.y = fromY;
        this.collapseCount++;
        this.slides.push({
          key: e.key,
          mesh,
          fromY,
          toY,
          t: 0,
          dur: Math.min(0.45, 0.13 + (e.y - src) * 0.055),
        });
      }
    }
  }

  // Piece anchor: center of the piece's bounding box in world coords. The
  // math lives in the pure, unit-tested src/coords.js (a sign error in the y
  // term made every piece float (n-1) cells above its true position).
  _pieceAnchor(type, rotation, x, y) {
    const a = pieceAnchor(type, x, y);
    return new THREE.Vector3(a.x, a.y, 0);
  }

  _buildPieceBlocks(group, type, matOrFactory) {
    while (group.children.length) {
      const c = group.children.pop();
      if (c.geometry !== this.blockGeo) c.geometry.dispose?.();
      group.remove(c);
    }
    const n = PIECES[type].size;
    const half = (n - 1) / 2;
    for (const [r, c] of getCells(type, 0)) {
      const mesh = new THREE.Mesh(this.blockGeo, matOrFactory());
      mesh.position.set(c - half, -(r - half), 0);
      group.add(mesh);
    }
  }

  setPiece(type, rotation, x, y, isNew = false) {
    // The board frame only covers the visible field: while any cell is in a
    // hidden spawn row the piece would render floating above the frame (or
    // clipped at the top of the screen), so hide the group until it is fully
    // inside the visible field. Position/angle keep tracking while hidden
    // (tick() runs regardless of visible), so it appears exactly on its cell
    // the moment it crosses the top edge — no pop, no jump.
    this.pieceGroup.visible = !anyHiddenCell(type, rotation, y);
    if (type !== this.pieceType) {
      this.pieceType = type;
      this.pieceLastRot = rotation;
      this._buildPieceBlocks(this.pieceGroup, type, () => this.pieceMats[type]);
      this.pieceSpawnT = 0;
      // New piece: snap to its anchor.
      this.piecePosTarget.copy(this._pieceAnchor(type, rotation, x, y));
      this.piecePos.copy(this.piecePosTarget);
      this.pieceAngle = this.pieceAngleTarget = -rotation * (Math.PI / 2);
      return;
    }
    if (isNew) {
      // Same type as the previous piece (back-to-back from the bag): snap
      // to the spawn anchor and replay the spawn pop instead of sliding
      // the old piece up from its lock position.
      this.pieceLastRot = rotation;
      this.piecePosTarget.copy(this._pieceAnchor(type, rotation, x, y));
      this.piecePos.copy(this.piecePosTarget);
      this.pieceAngle = this.pieceAngleTarget = -rotation * (Math.PI / 2);
      this.pieceSpawnT = 0;
      return;
    }
    // Continuous angle: unwrap so 3 -> 0 rotates -90deg, not +270deg.
    let d = (rotation - this.pieceLastRot + 4) % 4;
    if (d > 2) d -= 4;
    this.pieceAngleTarget += d * (-Math.PI / 2);
    this.pieceLastRot = rotation;
    this.piecePosTarget.copy(this._pieceAnchor(type, rotation, x, y));
  }

  // One stardust mote shed by the falling piece (the wake accumulator in
  // tick() decides WHEN; this decides WHERE and how it looks): zero-
  // gravity drift up off the piece's rendered base, tinted by the piece's
  // crystal color, so the wake trails the body. ~1 in 5 motes is a hot
  // glint that clears the bloom threshold and sparks as an air-glint. The
  // pool signature is probe-safe against every other spawner: gravity 0 is
  // written by no one else (embers 2.1, meteor sparks 13, bursts 16), and
  // the HDR factor caps at 1.5 so a red Z's base stays under the level-up
  // fountain's R >= 1.4 probe and blue/cyan bases stay under the meteor
  // spark's B >= 1.7 probe.
  _spawnWakeMote() {
    const type = this.pieceType;
    if (!type || this.over) return;
    const col = this.pieceMats[type].color;
    // Rendered base of the piece: the lowest point of the rotation-0
    // layout rotated by the piece group's live angle (same convention as
    // _buildPieceBlocks / the group's rotation.z), a touch below the face
    // so the mote starts beneath the body and rises past it.
    const h = (PIECES[type].size - 1) / 2;
    let minX = Infinity, maxX = -Infinity, minY = Infinity;
    const a = this.pieceAngle;
    const ca = Math.cos(a), sa = Math.sin(a);
    for (const [r, c] of getCells(type, 0)) {
      const lx = c - h;
      const ly = -(r - h);
      const rx = lx * ca - ly * sa;
      const ry = lx * sa + ly * ca;
      if (rx < minX) minX = rx;
      if (rx > maxX) maxX = rx;
      if (ry < minY) minY = ry;
    }
    const hot = Math.random() < 0.2;
    const f = hot ? 1.2 + Math.random() * 0.3 : 0.5 + Math.random() * 0.4;
    const idx = this.pCursor;
    this.pCursor = (idx + 1) % this.pCount;
    this.pPos[idx * 3] = this.piecePos.x + minX + Math.random() * (maxX - minX);
    this.pPos[idx * 3 + 1] = this.piecePos.y + minY - 0.2 - Math.random() * 0.3;
    this.pPos[idx * 3 + 2] = 0.2;
    this.pVel[idx * 3] = (Math.random() - 0.5) * 0.6;
    this.pVel[idx * 3 + 1] = 0.45 + Math.random() * 0.85;
    this.pVel[idx * 3 + 2] = (Math.random() - 0.5) * 0.5;
    this.pGrav[idx] = 0;
    this.pLife[idx] = this.pMax[idx] = (hot ? 0.35 : 0.5) + Math.random() * 0.3;
    this.pBase[idx * 3] = col.r * f;
    this.pBase[idx * 3 + 1] = col.g * f;
    this.pBase[idx * 3 + 2] = col.b * f;
    this.wakeMotes++;
  }

  reset() {
    for (const mesh of this.stackMeshes.values()) this.scene.remove(mesh);
    this.stackMeshes.clear();
    this.stackTypes.clear();
    this.pops = [];
    for (const f of this.flashes) {
      this.scene.remove(f.mesh);
      f.mesh.material.dispose();
    }
    this.flashes = [];
    this.pLife.fill(0);
    for (let i = 0; i < this.pCount; i++) this.pPos[i * 3 + 1] = -9999;
    for (const r of this.rings) {
      r.t = 1;
      r.mesh.visible = false;
    }
    for (const s of this.shards) {
      s.t = 1;
      s.mesh.visible = false;
    }
    this.flash = 0;
    this.bloom.strength = this.bloomBase;
    this.tetrisFlashMesh.visible = false;
    for (const tr of this.trails) {
      tr.t = 1;
      tr.mesh.visible = false;
    }
    for (const im of this.impacts) {
      im.t = 1;
      im.disc.visible = false;
      im.ring.visible = false;
    }
    for (const sw of this.sweeps) {
      sw.t = 1;
      sw.group.visible = false;
      sw.edge.material.opacity = 0;
      sw.trail.material.opacity = 0;
      sw.trail.material.map = this.sweepTrailTex;
    }
    this.pieceType = null;
    this.pieceLastRot = 0;
    this.pieceAngle = 0;
    this.pieceAngleTarget = 0;
    this.pieceSpawnT = 1;
    this.pieceGroup.visible = true;
    // Stardust wake: re-arm the bank for the fresh game (live motes were
    // already killed by the pLife/pPos sweep above).
    this.wake = { acc: 0, lastY: null };
    this.wakeMotes = 0;
    this.ghostGroup.visible = true;
    this.ghostType = null;
    this.ghostBeam.visible = false;
    this.ghostEmitter.visible = false;
    this.ghostTime.value = 0;
    // Holographic rotation echo: the afterimages die with the stage and
    // the throttle re-arms for the fresh game.
    for (const slot of this.echoes) slot.group.visible = false;
    this.echoCursor = 0;
    this.lastEchoT = -10;
    for (const p of this.popups) {
      p.t = 1;
      p.mesh.visible = false;
      p.mat.opacity = 0;
      p.flareOn = false;
      p.flareMesh.visible = false;
      p.flareMat.opacity = 0;
    }
    this.flare = 0;
    this.gradePass.uniforms.uFlare.value = 0;
    this.camPunch = 0;
    this.shake = 0;
    this.auroraPulse = 0;
    // Rafter spotlights: full neutral lights again.
    this.spotPulse = 0;
    this.spotUniforms.uDim.value = 0;
    this.spotCapMat.opacity = 0.55;
    this.spotPoolMat.opacity = 0.18;
    this.spotWashMat.opacity = 0.06;
    // Holo displays: back on stage, holding nothing (a fresh game's
    // setHold(null)/setNext call on the next frame re-pops the queue).
    this.holoHoldGroup.visible = true;
    this.holoNextGroup.visible = true;
    this.holoHold.type = null;
    this._fillSlot(this.holoHold);
    this.holoHold.pop = 1;
    for (const s of this.holoNext) {
      s.type = null;
      this._fillSlot(s);
      s.pop = 1;
    }
    this.holoPulse.hold = 0;
    this.holoPulse.next = 0;
    this.slides.length = 0;
    this.pendingClearRows = null;
    this.settleDip = 0;
    // Level palette: back to the neutral stage (level 1).
    this.levelHue = 0;
    this.levelHueTarget = 0;
    this._applyStageHue(0);
    // Sky meteors: clear the pool and re-arm the auto-spawn schedule (the
    // sky comes alive again a couple of seconds after a restart).
    for (const slot of this.meteors) {
      slot.m = null;
      slot.head.visible = false;
      slot.tail.visible = false;
      slot.headMat.opacity = 0;
      slot.tailMat.opacity = 0;
    }
    this.meteorNext = this.time + 2 + Math.random() * 3;
    // Streak mode: the stack is gone and the fresh game starts at level 1
    // (neutral, no shimmer). crystalTime resets with the other FX clocks.
    this.streakTarget = 0;
    this.streakVal = 0;
    this.streak.value = 0;
    this.crystalTime.value = 0;
    // Redline alarm: the fresh well starts empty — full neutral stage.
    this.danger = 0;
    this.dangerTarget = 0;
    this.gradePass.uniforms.uDanger.value = 0;
    this.auroraUniforms.uDanger.value = 0;
    this.floorGrid.material.color.setRGB(1, 1, 1);
    this.panelGrid.material.color.setRGB(1, 1, 1);
    // Game-over state: back to full lights.
    this.over = false;
    this.overDim = 0;
    this.overT = 0;
    this.dissolves = [];
    this.auroraUniforms.uDim.value = 0;
    this.starsFar.material.opacity = 0.7;
    this.starsMid.material.opacity = 0.7;
    this.starsNear.material.opacity = 0.85;
    this.frameEdgesMat.opacity = 1;
    this.frameRailMat.opacity = 1;
    this.frameBarMat.color.copy(this.frameBarColor);
    this.pGrav.fill(16);
  }

  setGhost(type, rotation, x, y, visible) {
    // Same hidden-row rule as the piece: a ghost whose landing has cells in
    // hidden rows would render above the board frame. The landing projector
    // (pillar + emitter pool) follows the ghost's visibility exactly.
    const show = visible && !anyHiddenCell(type, rotation, y);
    this.ghostGroup.visible = show;
    if (!show) {
      this.ghostBeam.visible = false;
      this.ghostEmitter.visible = false;
      return;
    }
    if (type !== this.ghostType) {
      this.ghostType = type;
      const color = new THREE.Color(PIECES[type].color);
      const gm = (this.ghostMats[type] ??= {
        box: this._holoMat(color),
        edge: new THREE.LineBasicMaterial({
          color,
          transparent: true,
          opacity: 0.5,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      });
      while (this.ghostGroup.children.length) this.ghostGroup.remove(this.ghostGroup.children.pop());
      const n = PIECES[type].size;
      const half = (n - 1) / 2;
      for (const [r, c] of getCells(type, 0)) {
        const box = new THREE.Mesh(this.ghostGeo, gm.box);
        box.position.set(c - half, -(r - half), 0);
        box.add(new THREE.LineSegments(this.ghostEdgeGeo, gm.edge));
        this.ghostGroup.add(box);
      }
      // Projector tint: the piece color pulled toward holo cyan.
      const tint = color.lerp(new THREE.Color(0x9fe8ff), 0.55);
      this.ghostBeam.material.color.copy(tint).multiplyScalar(1.05);
      this.ghostEmitter.material.color.copy(tint).multiplyScalar(1.1);
    }
    this.ghostGroup.position.copy(this._pieceAnchor(type, rotation, x, y));
    this.ghostGroup.rotation.z = -rotation * (Math.PI / 2);
    // Light pillar: mirror floor up to the ghost's lowest cell (a small
    // overlap so the pillar blends into the shell). Guarded so a ghost
    // resting on the floor leaves no stub above the board base.
    const a = this.ghostGroup.position;
    const floorY = -0.5;
    const bottomY = this._ghostBottomY(type, rotation, y) + 0.05;
    if (bottomY > floorY + 0.08) {
      const h = bottomY - floorY;
      this.ghostBeam.visible = true;
      this.ghostBeam.position.set(a.x, floorY + h / 2, 0.25);
      this.ghostBeam.scale.set(0.34, h, 1);
    } else {
      this.ghostBeam.visible = false;
    }
    // Emitter pool of light on the mirror glass, under the ghost column.
    this.ghostEmitter.visible = true;
    this.ghostEmitter.position.set(a.x, IMPACT_FLOOR_Y, 0.15);
    this.ghostEmitter.scale.set(1.1, 1, 1.1);
  }

  // Holographic rotation echo: main.js calls this on every successful
  // rotation with the PRE-rotation piece state (type/rotation/x/y captured
  // before the engine mutates it). The slot flashes that footprint in the
  // holo shader, then tick() swells + fades it over ECHO_LIFE s. Gated on
  // the game-over cinematic, the hidden-row rule (an echo of a piece in
  // the hidden spawn rows would poke above the frame, like the ghost)
  // and a tick-time throttle (rotation flicker must not stack a wall of
  // afterimages). The pool round-robins, so a 7-way flicker keeps the
  // seven most recent echoes alive at once.
  onRotate(type, rotation, x, y) {
    if (this.over) return;
    if (anyHiddenCell(type, rotation, y)) return;
    if (this.time - this.lastEchoT < ECHO_THROTTLE) return;
    this.lastEchoT = this.time;
    const slot = this.echoes[this.echoCursor];
    this.echoCursor = (this.echoCursor + 1) % this.echoes.length;
    if (slot.type !== type) {
      slot.type = type;
      this._fillEcho(slot);
    }
    slot.group.position.copy(this._pieceAnchor(type, rotation, x, y));
    slot.group.rotation.z = -rotation * (Math.PI / 2);
    slot.group.scale.setScalar(1);
    slot.t = 0;
    const mats = slot.mats[type];
    mats.box.uniforms.uFade.value = 1; // tick() rewrites it each frame
    mats.edge.opacity = 0.5;
    slot.group.visible = true;
  }

  // Rebuild an echo slot's footprint for its current type (rotation-0
  // layout + group rotation, the same convention as the ghost group and
  // the piece mesh). Materials are cached per slot+type so concurrent
  // echoes of the same type fade independently (own uFade).
  _fillEcho(slot) {
    const group = slot.group;
    while (group.children.length) group.remove(group.children.pop());
    const type = slot.type;
    const mats = (slot.mats[type] ??= (() => {
      const color = new THREE.Color(PIECES[type].color);
      return {
        box: this._holoMat(color),
        edge: new THREE.LineBasicMaterial({
          color,
          transparent: true,
          opacity: 0.5,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      };
    })());
    const n = PIECES[type].size;
    const half = (n - 1) / 2;
    for (const [r, c] of getCells(type, 0)) {
      const box = new THREE.Mesh(this.ghostGeo, mats.box);
      box.position.set(c - half, -(r - half), 0);
      box.add(new THREE.LineSegments(this.ghostEdgeGeo, mats.edge));
      group.add(box);
    }
  }

  // Hold display: shows the held piece (or a bare cradle when none yet).
  // A new type pops the piece in and pings the hold side (emitter flare +
  // a small floor ripple in the piece's color). main.js calls this every
  // frame; the diff against the previous type is what triggers the FX.
  setHold(type) {
    if (this.over) return;
    const slot = this.holoHold;
    if (type === slot.type) return;
    slot.type = type || null;
    this._fillSlot(slot);
    slot.pop = 0;
    if (slot.type) {
      this.holoPulse.hold = 1;
      this._holoPing(-HOLO_X, slot.type);
    }
  }

  // Next-queue display: three slots. On a queue shift (a new piece spawned
  // or a hold swap) the changed slots pop in and the next side gets a soft
  // ping (the hold swap is the bigger one, pinging both sides).
  setNext(types) {
    if (this.over) return;
    let changed = false;
    for (let i = 0; i < 3; i++) {
      const slot = this.holoNext[i];
      const t = types && types[i] ? types[i] : null;
      if (t === slot.type) continue;
      changed = true;
      slot.type = t;
      this._fillSlot(slot);
      slot.pop = 0;
    }
    if (changed) this.holoPulse.next = Math.max(this.holoPulse.next, 0.6);
  }

  // Small floor ripple on a display column (shares the lock-splash pool):
  // a hold swap pings the hold side in the swapped piece's color, clamped
  // to a gentle size factor so it reads as a projector chirp, not a lock
  // splash. lastHoloPing records the most recent ping (state probe).
  _holoPing(wx, type) {
    const im = this.impacts[this.impactCursor];
    this.impactCursor = (this.impactCursor + 1) % this.impacts.length;
    im.t = 0;
    im.s = 0.7;
    im.k = 0.9;
    im.disc.visible = true;
    im.ring.visible = true;
    im.disc.position.set(wx, IMPACT_FLOOR_Y, 0.15);
    im.ring.position.copy(im.disc.position);
    const c = new THREE.Color(PIECES[type].color)
      .lerp(new THREE.Color(0x9fe8ff), 0.5)
      .multiplyScalar(1.15);
    im.disc.material.color.copy(c);
    im.ring.material.color.copy(c);
    this.lastHoloPing = { wx, type };
  }

  onLock(cells, opts = {}) {
    for (const [x, y] of cells) {
      const mesh = this.stackMeshes.get(`${x},${y}`);
      if (mesh) {
        mesh.scale.setScalar(0.4);
        this.pops.push({ mesh, t: 0 });
      }
    }
    this._impact(cells, opts);
  }

  // Lock-impact splash: a ring of light expanding on the mirror floor under
  // the lock point, tinted by the piece (HDR so hard drops clear the bloom
  // threshold and glow), plus a small spark puff at the base of the locked
  // piece. `opts` = { hard, color }: hard drops splash stronger and wider.
  // `cells` are POST-clear (a clear can destroy some of the locked cells;
  // impactAnchor returns null if none survive, so a full-board clear lock
  // ripples nothing — the clear FX owns that moment).
  _impact(cells, { hard = false, color } = {}) {
    const a = impactAnchor(cells);
    if (!a) return;
    const im = this.impacts[this.impactCursor];
    this.impactCursor = (this.impactCursor + 1) % this.impacts.length;
    im.t = 0;
    im.s = hard ? 1.6 : 1.0; // opacity factor
    im.k = hard ? 1.35 : 1.0; // size factor
    im.disc.visible = true;
    im.ring.visible = true;
    im.disc.position.set(a.wx, IMPACT_FLOOR_Y, 0.15);
    im.ring.position.copy(im.disc.position);
    const c = new THREE.Color(color || 0xffffff)
      .lerp(new THREE.Color(0xffffff), hard ? 0.45 : 0.3)
      .multiplyScalar(hard ? 1.35 : 1.1);
    im.disc.material.color.copy(c);
    im.ring.material.color.copy(c);
    // Spark puff at the base of the locked piece. Clamped to the visible
    // field: a lock-out lock has all its cells in hidden rows.
    const wy = toWorldY(Math.min(Math.max(a.row, HIDDEN_ROWS), TOTAL_ROWS - 1));
    const n = hard ? 26 : 10;
    for (let i = 0; i < n; i++) {
      const idx = this.pCursor;
      this.pCursor = (this.pCursor + 1) % this.pCount;
      this.pPos[idx * 3] = a.wx + (Math.random() - 0.5) * 2.4;
      this.pPos[idx * 3 + 1] = wy + (Math.random() - 0.5) * 0.4;
      this.pPos[idx * 3 + 2] = 0.15;
      this.pVel[idx * 3] = (Math.random() - 0.5) * 3.5;
      this.pVel[idx * 3 + 1] = 1.2 + Math.random() * (hard ? 3.5 : 2.0);
      this.pVel[idx * 3 + 2] = (Math.random() - 0.5) * 2.0;
      this.pLife[idx] = this.pMax[idx] = 0.35 + Math.random() * 0.35;
      this.pBase[idx * 3] = c.r;
      this.pBase[idx * 3 + 1] = c.g;
      this.pBase[idx * 3 + 2] = c.b;
    }
    if (hard) this.auroraPulse = Math.min(1.8, this.auroraPulse + 0.25);
  }

  // Level palette: when a lock crosses a level threshold the whole stage
  // re-inks to the new level's hue (aurora sky via uHue in its shader,
  // neon frame, glow bar, mirror/panel grids, sky background — see
  // _applyStageHue). The shift eases in over ~1 s (levelHue eases toward
  // levelHueTarget in tick()). On top, the level-up moment gets a one-shot
  // celebration: an aurora surge, a wide sonic ring across the mirror glass
  // from the board center, and a gold spark fountain off the glow bar. The
  // LEVEL N banner (popupFor) is spawned separately by main.js.
  onLevelUp(level) {
    this.levelHueTarget = levelHue(level);
    // Streak mode: the stack's hue-wave amplitude targets the level's
    // streakIntensity (0 below level 10, full rainbow at level 20+).
    this.streakTarget = streakIntensity(level);
    if (this.over) return; // the lights-out cinematic owns the stage
    this.auroraPulse = Math.min(2.4, this.auroraPulse + 1.8);
    this.shake = Math.max(this.shake, 0.55);
    this.spotPulse = Math.min(1.6, this.spotPulse + 1.0); // the spotlights surge with the stage
    this._levelUpImpact();
    // Gold-white HDR spark fountain off the glow bar: the one warm chroma
    // accent of the celebration, raining back onto the mirror glass (whose
    // mirror pass doubles the fountain in the reflection).
    for (let i = 0; i < 42; i++) {
      const idx = this.pCursor;
      this.pCursor = (this.pCursor + 1) % this.pCount;
      this.pPos[idx * 3] = (Math.random() - 0.5) * (BOARD_W + 0.9);
      this.pPos[idx * 3 + 1] = 0.12;
      this.pPos[idx * 3 + 2] = 0.3;
      this.pVel[idx * 3] = (Math.random() - 0.5) * 3;
      this.pVel[idx * 3 + 1] = 3 + Math.random() * 6;
      this.pVel[idx * 3 + 2] = (Math.random() - 0.5) * 2;
      this.pGrav[idx] = 16; // slot may hold a slow dissolve gravity
      this.pLife[idx] = this.pMax[idx] = 0.6 + Math.random() * 0.5;
      this.pBase[idx * 3] = 1.5;
      this.pBase[idx * 3 + 1] = 1.35;
      this.pBase[idx * 3 + 2] = 1.05;
    }
  }

  // The level-up sonic ring: a lock-splash pool entry at the board center
  // with a bigger size/opacity factor than a hard-drop splash (k 2.2 vs
  // 1.35, s 1.8 vs 1.6) so it reads as a stage-wide announcement rather
  // than a lock ripple. HDR white-cyan so bloom catches the rim.
  _levelUpImpact() {
    const im = this.impacts[this.impactCursor];
    this.impactCursor = (this.impactCursor + 1) % this.impacts.length;
    im.t = 0;
    im.s = 1.8;
    im.k = 2.2;
    im.disc.visible = true;
    im.ring.visible = true;
    im.disc.position.set(0, IMPACT_FLOOR_Y, 0.15);
    im.ring.position.copy(im.disc.position);
    const c = new THREE.Color(0xffffff).lerp(new THREE.Color(0x9ff6ff), 0.55).multiplyScalar(1.4);
    im.disc.material.color.copy(c);
    im.ring.material.color.copy(c);
  }

  // Streak-mode ignition (the level 9 -> 10 crossing): the settled stack
  // ignites into a living rainbow. One full-board rainbow light sweep rips
  // across the well (the wave that is about to take over the stack's hue),
  // the stage surges like a level-up, and a wide sonic ring crosses the
  // mirror glass. main.js calls this when a lock crosses STREAK_LEVEL;
  // the STREAK banner itself comes from popupFor.
  onStreakIgnite() {
    if (this.over) return; // the lights-out cinematic owns the stage
    this.streakTarget = Math.max(this.streakTarget, streakIntensity(STREAK_LEVEL));
    this.auroraPulse = Math.min(2.4, this.auroraPulse + 1.2);
    this.spotPulse = Math.min(1.6, this.spotPulse + 1.0);
    this.shake = Math.max(this.shake, 0.7);
    this._levelUpImpact(); // wide sonic ring across the mirror glass
    this._sweep(BOARD_CY, BOARD_H, [0xffffff], true, 0, true);
  }

  // Perfect clear: the board just emptied to ZERO blocks. The stage-wide
  // celebration: the full-screen bloom flash + dolly punch (the PERFECT
  // CLEAR! banner carries both), a full-board rainbow light sweep (the
  // same pooled rainbow texture as the streak ignition), a DOUBLE sonic
  // ring across the mirror glass (staggered 0.18 s via a negative start
  // time), a gold-white spark fountain off the well center, and the
  // aurora/spot surge. main.js calls it when the post-clear board is
  // empty (the pure boardEmpty in fx-labels.js); it stacks with the
  // line-clear FX (sweeps, rings, flashes) and, on a 4-line perfect,
  // with the TETRIS banner (PERFECT CLEAR! floats above it via yOff).
  onPerfect() {
    if (this.over) return; // the lights-out cinematic owns the stage
    this.flash = 1; // the TETRIS full-screen bloom flash
    this.camPunch = 1; // dolly punch in with the banner
    this.shake = Math.max(this.shake, 0.9);
    this.auroraPulse = Math.min(2.4, this.auroraPulse + 1.6);
    this.spotPulse = Math.min(1.8, this.spotPulse + 1.2);
    // Full-board rainbow sweep across the (now empty) well.
    this._sweep(BOARD_CY, BOARD_H, [0xffffff], true, 0, true);
    // Double sonic ring across the mirror glass (gold-white, level-up
    // ring size; the second fires 0.18 s later).
    this._perfectRing(0);
    this._perfectRing(-0.18);
    // Gold-white spark fountain erupting off the well center: the warm
    // chroma accent of the celebration. The R base 1.5 is the same gold
    // signature as the level-up fountain — line-clear palette sparks top
    // out at sRGB 1.0, so probes attribute the fountain cleanly.
    for (let i = 0; i < 54; i++) {
      const idx = this.pCursor;
      this.pCursor = (this.pCursor + 1) % this.pCount;
      this.pPos[idx * 3] = (Math.random() - 0.5) * 3.2;
      this.pPos[idx * 3 + 1] = BOARD_CY + (Math.random() - 0.5) * 2.4;
      this.pPos[idx * 3 + 2] = 0.3;
      this.pVel[idx * 3] = (Math.random() - 0.5) * 6;
      this.pVel[idx * 3 + 1] = 3 + Math.random() * 8;
      this.pVel[idx * 3 + 2] = (Math.random() - 0.5) * 3;
      this.pGrav[idx] = 16; // slot may hold a slow dissolve gravity
      this.pLife[idx] = this.pMax[idx] = 0.7 + Math.random() * 0.7;
      this.pBase[idx * 3] = 1.5;
      this.pBase[idx * 3 + 1] = 1.35;
      this.pBase[idx * 3 + 2] = 1.05;
    }
    this.showPopup({ text: 'PERFECT CLEAR!', tier: 'perfect' });
  }

  // One pooled gold-white sonic ring across the mirror glass for the
  // perfect clear: the level-up's wide ring factors (k 2.2 / s 1.8) in a
  // warm gold tint. Negative start times stagger a double ring (the
  // impact loop hides entries while t < 0).
  _perfectRing(startT) {
    const im = this.impacts[this.impactCursor];
    this.impactCursor = (this.impactCursor + 1) % this.impacts.length;
    im.t = startT;
    im.s = 1.8;
    im.k = 2.2;
    im.disc.position.set(0, IMPACT_FLOOR_Y, 0.15);
    im.ring.position.copy(im.disc.position);
    const c = new THREE.Color(0xffffff).lerp(new THREE.Color(0xffd75e), 0.5).multiplyScalar(1.4);
    im.disc.material.color.copy(c);
    im.ring.material.color.copy(c);
    if (startT < 0) {
      im.disc.visible = false;
      im.ring.visible = false;
    } else {
      im.disc.visible = true;
      im.ring.visible = true;
    }
  }

  // Re-ink the grid helpers' baked vertex colors by the stage hue. Grid
  // colors are vertex attributes, so the per-vertex base copies recorded
  // at build time are the source of truth (offsetHSL on each base color).
  // Repaints are gated on the hue actually moving: between level-ups the
  // grids are static and per-frame buffer uploads would be pure waste.
  _repaintGrids(h) {
    if (Math.abs(h - this.gridHue) < 1e-4) return;
    this.gridHue = h;
    const c = new THREE.Color();
    const grids = [
      [this.floorGrid, this.floorGridBase],
      [this.panelGrid, this.panelGridBase],
    ];
    for (const [grid, base] of grids) {
      const attr = grid.geometry.getAttribute('color');
      for (let i = 0; i < attr.count; i++) {
        c.setRGB(base[i * 3], base[i * 3 + 1], base[i * 3 + 2]);
        if (h !== 0) c.offsetHSL(h, 0, 0);
        attr.setXYZ(i, c.r, c.g, c.b);
      }
      attr.needsUpdate = true;
    }
  }

  // Apply the current stage hue to every tintable stage element. Called
  // from tick() with the animated hue and once from reset() with 0 (which
  // restores the exact neutral colors — offsetHSL is skipped so repeated
  // no-op calls can't drift the HSL round-trip).
  _applyStageHue(h) {
    this.auroraUniforms.uHue.value = h * Math.PI * 2;
    const ink = (c, base) => {
      c.copy(base);
      if (h !== 0) c.offsetHSL(h, 0, 0);
    };
    ink(this.frameEdgesMat.color, this.frameEdgeBase);
    ink(this.frameRailMat.color, this.frameRailBase);
    ink(this.frameBarColor, this.frameBarBase);
    ink(this.scene.background, this.stageBgBase);
    ink(this.scene.fog.color, this.stageBgBase);
    ink(this.dustTint, this.dustTintBase);
    this.dust.material.color.copy(this.dustTint);
    // Rafter spotlights: the shafts re-ink in-shader (uHue, same Rodrigues
    // rotation as the aurora); caps/pools/wash share live color objects inked here.
    this.spotUniforms.uHue.value = h * Math.PI * 2;
    ink(this.spotCapColor, this.spotCapBase);
    ink(this.spotPoolColor, this.spotPoolBase);
    ink(this.spotWashColor, this.spotWashBase);
    // Sky meteors: head/tail/spark share live color objects inked here.
    ink(this.meteorHeadColor, this.meteorHeadBase);
    ink(this.meteorTailColor, this.meteorTailBase);
    ink(this.meteorSparkColor, this.meteorSparkBase);
    this._repaintGrids(h);
  }

  // Redline alarm level (0..1) computed by main.js from the settled board
  // every frame (the pure dangerOf in src/danger.js). Only the target is
  // written here: tick() eases this.danger toward it (fast attack so the
  // alarm snaps on, slow release so it lingers a beat) and pushes it to
  // the pixels via _applyDanger().
  setDanger(level) {
    this.dangerTarget = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0));
  }

  // Push the current alarm level to the pixels. The pre-multiplied
  // level*pulse value (heartbeat modulating ~62%..full) drives the grade
  // pass's red edge-glow and the aurora sky's crimson wash; the frame
  // edges, side rails, glow bar (heartbeat-bright, so its bloom thumps) and
  // the mirror/panel grid multipliers lerp toward the alarm red. MUST run
  // after _applyStageHue (which re-inks the live colors from the palette
  // bases) and after the frameBarMat copy in tick(). danger 0 restores the
  // white grid multipliers and leaves every uniform at the identity 0.
  _applyDanger() {
    const beat = dangerBeat(this.time);
    const dval = this.danger * (0.62 + 0.38 * beat);
    this.gradePass.uniforms.uDanger.value = dval;
    this.auroraUniforms.uDanger.value = dval;
    if (this.danger > 0.002) {
      const k = this.danger * (0.5 + 0.5 * beat);
      this.frameEdgesMat.color.lerp(this.dangerTint, k * 0.85);
      this.frameRailMat.color.lerp(this.dangerTint, k * 0.85);
      this.frameBarMat.color.lerp(this.dangerTint, k * 0.95);
      this.frameBarMat.color.multiplyScalar(1 + 0.35 * beat * this.danger);
      const gk = k * 0.7;
      this.floorGrid.material.color.lerp(this.dangerTint, gk);
      this.panelGrid.material.color.lerp(this.dangerTint, gk);
    } else {
      this.floorGrid.material.color.setRGB(1, 1, 1);
      this.panelGrid.material.color.setRGB(1, 1, 1);
    }
  }

  // Hard-drop light trails: one streak per occupied column, from the piece's
  // start position to its landing. `piece` is the PRE-drop
  // { type, rotation, x, y }; `landingCells` are the [x, y] cells it locks
  // into (a hard drop never moves x, so columns pair up 1:1). The swept
  // span per column is [min start row, max landing row], so a vertical I
  // leaves ONE long streak instead of four overlapping ones (overlapping
  // additive streaks clip to a white column).
  onHardDrop(piece, landingCells) {
    const range = (map, x, y) => {
      const e = map.get(x) ?? [Infinity, -Infinity];
      e[0] = Math.min(e[0], y);
      e[1] = Math.max(e[1], y);
      map.set(x, e);
    };
    const fromX = new Map();
    for (const [r, c] of getCells(piece.type, piece.rotation)) {
      range(fromX, piece.x + c, piece.y + r);
    }
    const toX = new Map();
    for (const [x, y] of landingCells) range(toX, x, y);
    for (const [x, f] of fromX) {
      const t = toX.get(x);
      if (!t) continue;
      const d = t[0] - f[0]; // rigid-body fall distance, uniform per piece
      if (d <= 0) continue; // already grounded: no streak
      this._spawnTrail(x, f[0], t[1], piece.type);
    }
  }

  // One pooled streak in column x covering board rows topRow..bottomRow
  // (inclusive swept span). Clamped to the visible field: while any cell is
  // in a hidden row the piece is invisible, so the streak must not poke
  // above the board frame either.
  _spawnTrail(x, topRow, bottomRow, type) {
    const tr = this.trails[this.trailCursor];
    this.trailCursor = (this.trailCursor + 1) % this.trails.length;
    let wyTop = toWorldY(topRow) + 0.5; // top edge of the start cell
    const wyBottom = toWorldY(bottomRow) - 0.5; // bottom edge of landing cell
    wyTop = Math.min(wyTop, toWorldY(0) + 0.5); // top of the visible field
    if (wyTop <= wyBottom) return;
    tr.t = 0;
    tr.mesh.visible = true;
    tr.mesh.position.set(toWorldX(x), (wyTop + wyBottom) / 2, 0.25);
    tr.mesh.scale.set(0.6, wyTop - wyBottom, 1);
    tr.mesh.material.opacity = 0.9;
    const c = new THREE.Color(PIECES[type].color);
    c.lerp(new THREE.Color(0xffffff), 0.45);
    c.multiplyScalar(1.25); // HDR: bloom catches the streak
    tr.mesh.material.color.copy(c);
  }

  onLineClear(rows, colors) {
    const n = rows.length;
    this.shake = Math.min(1.9, 0.7 + n * 0.3);
    this.auroraPulse = Math.min(1.8, this.auroraPulse + 0.55 + n * 0.3);
    // The rafter spotlights flare with the clear (hotter on a TETRIS).
    this.spotPulse = Math.min(1.8, this.spotPulse + 0.45 + n * 0.22);
    if (n >= 4) this.spotPulse = Math.min(1.6, this.spotPulse + 0.6);
    if (n >= 4) this.flash = 1; // TETRIS: full-screen bloom flash
    // Row-collapse settle: record the cleared rows; the next setStack (the
    // post-collapse board diff, main.js calls it right after this) slides
    // every shifted block down from its source row. The board also dips
    // with the weight of the fall (decays in tick()).
    this.pendingClearRows = rows.slice().sort((a, b) => a - b);
    this.settleDip = Math.min(0.6, 0.12 + n * 0.09);

    // Per-row palettes (colors[i] corresponds to rows[i]).
    const rowPalette = new Map();
    for (let i = 0; i < rows.length; i++) {
      rowPalette.set(
        rows[i],
        (colors[i] && colors[i].length ? colors[i] : [0xffffff]).map((c) => new THREE.Color(c)),
      );
    }

    // Group contiguous rows into runs (rows arrive sorted ascending). One
    // bar + one shockwave + one light sweep per run: overlapping per-row
    // bars clip to a solid white mass, while a single run-height bar reads
    // as a hot core.
    const runs = [];
    for (const y of rows) {
      const last = runs[runs.length - 1];
      if (last && y === last.end + 1) last.end = y;
      else runs.push({ start: y, end: y });
    }

    // The wipe direction alternates per clear (back-to-back clears rip
    // different ways); every run in one clear sweeps the same direction.
    this.sweepDir = (this.sweepParity ^= 1) ? -1 : 1;
    let sweepIdx = 0;

    for (const run of runs) {
      const wy0 = toWorldY(run.end); // bottom of run (world y)
      const wy1 = toWorldY(run.start); // top of run
      if (wy0 < 0 || wy1 > BOARD_H) continue;
      const wyMid = (wy0 + wy1) / 2;
      const h = wy1 - wy0 + 1;
      // Union of the run's row palettes (capped for diversity).
      const palette = [];
      for (let y = run.start; y <= run.end && palette.length < 12; y++) {
        palette.push(...rowPalette.get(y));
      }
      // Hot white core bar spanning the run (the bloom source). HDR color so
      // it clears the bloom threshold and glows instead of compositing dim.
      const mat = new THREE.MeshBasicMaterial({
        color: 0xbff3ff,
        transparent: true,
        opacity: 0.7,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      mat.color.multiplyScalar(1.2);
      const mesh = new THREE.Mesh(this.flashGeo, mat);
      mesh.position.set(0, wyMid, 0.1);
      mesh.scale.set(0.2, h * 0.95, 1);
      this.scene.add(mesh);
      this.flashes.push({ mesh, t: 0 });
      this._ring(wyMid, palette, h);
      this._sweep(wyMid, h, palette, n >= 4, sweepIdx++);
      for (let y = run.start; y <= run.end; y++) {
        this._shards(toWorldY(y), rowPalette.get(y));
        this._burst(toWorldY(y), rowPalette.get(y));
      }
    }
  }

  // Line-clear light sweep: one pooled entry per cleared run. The bright
  // edge wipes the full board width at constant velocity (see tick()); the
  // soft glow trails behind it, tinted with the run's average row palette.
  // HDR gains: 1.4 normal, 1.75 for a TETRIS (the wipe is the spectacle,
  // so it gets the hottest bloom in the clear). Multi-run clears stagger
  // their sweeps (t starts negative) so the wipes cascade, not clump.
  // rainbow=true (streak ignition) runs the full-board sweep with the
  // rainbow ramp texture and a white-hot edge instead.
  _sweep(wy, h, palette, hot, stagger, rainbow = false) {
    const sw = this.sweeps[this.sweepCursor];
    this.sweepCursor = (this.sweepCursor + 1) % this.sweeps.length;
    sw.t = -stagger * 0.055;
    sw.dur = 0.30 + 0.02 * (h - 1) + (hot ? 0.09 : 0);
    sw.dir = this.sweepDir;
    sw.h = h;
    sw.y = wy;
    sw.xA = sw.dir === 1 ? SWEEP_X0 : SWEEP_X1;
    sw.xB = sw.dir === 1 ? SWEEP_X1 : SWEEP_X0;
    sw.gain = hot ? 1.75 : 1.4;
    if (rainbow) {
      sw.trail.material.map = this.rainbowTex;
      sw.trail.material.color.setRGB(1, 1, 1);
      sw.edge.material.color.setRGB(1, 1, 1).multiplyScalar(1.55);
    } else {
      sw.trail.material.map = this.sweepTrailTex;
      sw.edge.material.color.setRGB(0.82, 0.96, 1.0).multiplyScalar(sw.gain);
      const tint = new THREE.Color(0, 0, 0);
      for (const c of palette) tint.add(c);
      tint.multiplyScalar(1 / palette.length);
      tint.lerp(new THREE.Color(0xffffff), 0.25);
      tint.multiplyScalar(1.15); // keep the trail head just under bloom
      sw.trail.material.color.copy(tint);
    }
    sw.group.visible = true;
    this.swept++;
  }

  // Expanding elliptical shockwave ripple centered on the cleared run.
  _ring(wy, palette, h = 1) {
    const r = this.rings[this.ringCursor];
    this.ringCursor = (this.ringCursor + 1) % this.rings.length;
    r.t = 0;
    r.h = h;
    r.mesh.visible = true;
    r.mesh.position.set(0, wy, 0.3);
    r.mesh.scale.set(1, 1, 1);
    const c = palette[(Math.random() * palette.length) | 0].clone();
    c.lerp(new THREE.Color(0xffffff), 0.4);
    c.multiplyScalar(1.4); // HDR: bloom catches the ripple
    r.mesh.material.color.copy(c);
  }

  // Glowing energy shards flying outward + up. Every other cell: a dense
  // full-row of shards clips to a white cloud; sparse sparks keep color.
  _shards(wy, palette) {
    const halfW = (COLS - 1) / 2;
    for (let x = 0; x < COLS; x += 2) {
      const s = this.shards[this.shardCursor];
      this.shardCursor = (this.shardCursor + 1) % this.shards.length;
      s.t = 0;
      s.max = 0.5 + Math.random() * 0.35;
      s.mesh.visible = true;
      s.mesh.position.set(toWorldX(x), wy, 0.2);
      const dir = halfW > 0 ? (x - halfW) / halfW : 0;
      s.vx = dir * (4 + Math.random() * 5) + (Math.random() - 0.5) * 2;
      s.vy = 3.5 + Math.random() * 6;
      s.vz = 1 + Math.random() * 3;
      s.spin = (Math.random() - 0.5) * 14;
      s.mesh.rotation.z = Math.random() * Math.PI;
      s.mesh.scale.setScalar(0.8 + Math.random() * 0.5);
      s.mesh.material.color.copy(palette[(Math.random() * palette.length) | 0]);
      s.mesh.material.opacity = 0.8;
    }
  }

  _burst(wy, colors) {
    const palette = (colors && colors.length ? colors : [0xffffff]).map((c) =>
      typeof c === 'number' ? new THREE.Color(c) : new THREE.Color(c),
    );
    for (let i = 0; i < 40; i++) {
      const idx = this.pCursor;
      this.pCursor = (this.pCursor + 1) % this.pCount;
      this.pPos[idx * 3] = (Math.random() - 0.5) * BOARD_W;
      this.pPos[idx * 3 + 1] = wy + (Math.random() - 0.5) * 0.6;
      this.pPos[idx * 3 + 2] = 0.15;
      this.pVel[idx * 3] = (Math.random() - 0.5) * 11;
      this.pVel[idx * 3 + 1] = 2 + Math.random() * 7;
      this.pVel[idx * 3 + 2] = (Math.random() - 0.5) * 4;
      this.pGrav[idx] = 16; // slot may hold a slow dissolve gravity
      this.pLife[idx] = this.pMax[idx] = 0.45 + Math.random() * 0.5;
      const c = palette[(Math.random() * palette.length) | 0];
      // HDR base color: the brightest sparks clear the bloom threshold.
      this.pBase[idx * 3] = c.r;
      this.pBase[idx * 3 + 1] = c.g;
      this.pBase[idx * 3 + 2] = c.b;
    }
  }

  // One dissolve puff: four slow-sinking embers in the block's color. Low
  // per-particle gravity (2.1 vs the line-clear 16) so they float, then sink
  // dreamily; the Reflector doubles them in the stage glass.
  _spawnDissolve(x, y, color) {
    const wx = toWorldX(x);
    const wy = toWorldY(y);
    for (let i = 0; i < 4; i++) {
      const idx = this.pCursor;
      this.pCursor = (this.pCursor + 1) % this.pCount;
      this.pPos[idx * 3] = wx + (Math.random() - 0.5) * 0.7;
      this.pPos[idx * 3 + 1] = wy + (Math.random() - 0.5) * 0.7;
      this.pPos[idx * 3 + 2] = 0.1;
      this.pVel[idx * 3] = (Math.random() - 0.5) * 1.1;
      this.pVel[idx * 3 + 1] = 0.2 + Math.random() * 0.9;
      this.pVel[idx * 3 + 2] = (Math.random() - 0.5) * 0.6;
      this.pGrav[idx] = 2.1;
      this.pLife[idx] = this.pMax[idx] = 1.5 + Math.random() * 1.3;
      // HDR-ish base: the embers stay bright long enough to catch a hint of
      // bloom while drifting.
      this.pBase[idx * 3] = color.r * 1.5;
      this.pBase[idx * 3 + 1] = color.g * 1.5;
      this.pBase[idx * 3 + 2] = color.b * 1.5;
    }
  }

  onGameOver() {
    // Guard against a second trigger on the same game (a hold after a
    // lock-out calls this again via afterHold): re-scheduling would
    // re-pop the banner and re-roll the dissolve.
    if (this.over) return;
    this.shake = 1.6;
    this.auroraPulse = 1.6;
    this.over = true;
    this.overT = 0;
    // The redline alarm dies with the lights out (the crimson stage hands
    // off to the game-over cinematic).
    this.dangerTarget = 0;
    // The final piece is already part of the stack (its visible cells were
    // written on lock); leaving the piece/ghost groups up would render the
    // piece a second time, glowing, on the game-over screen.
    this.pieceGroup.visible = false;
    this.ghostGroup.visible = false;
    this.ghostBeam.visible = false;
    this.ghostEmitter.visible = false;
    // In-flight rotation echoes die with the lights out (they would
    // otherwise shimmer over the dissolving stage).
    for (const slot of this.echoes) slot.group.visible = false;
    // Stardust wake: the piece's trail dies with the piece (motes carry
    // the unique gravity-0 signature), and the bank re-arms only on
    // restart — no dust may shed during the lights out.
    for (let i = 0; i < this.pCount; i++)
      if (this.pLife[i] > 0 && this.pGrav[i] < 1) {
        this.pLife[i] = 0;
        this.pPos[i * 3 + 1] = -9999;
      }
    this.wake = { acc: 0, lastY: null };
    // The holographic hold/next displays power down with the stage.
    this.holoHoldGroup.visible = false;
    this.holoNextGroup.visible = false;
    // The lights out: the settled stack dissolves top-down into slow
    // colored embers over ~3.2 s while the stage dims (aurora, stars,
    // neon frame, bloom) and the camera pushes back off stage. The
    // schedule is sorted so the tallest rows go first (a toppling tower).
    const cells = [];
    for (const [key, type] of this.stackTypes) {
      const [x, y] = key.split(',').map(Number);
      cells.push({ x, y, type, key });
    }
    cells.sort((a, b) => b.y - a.y || a.x - b.x);
    const n = cells.length;
    const stagger = n > 1 ? 3.2 / (n - 1) : 0;
    this.dissolves = cells.map((c, i) => ({ ...c, at: i * stagger }));
    this.showPopup({ text: 'GAME OVER', tier: 'gameover' });
  }

  tick(dt) {
    dt = Math.min(dt, 0.05);
    this.time += dt;
    const t = this.time;

    // Starfield drift + aurora animation.
    this.starsFar.rotation.y += dt * 0.006;
    this.starsMid.rotation.y += dt * 0.011;
    this.starsNear.rotation.y -= dt * 0.01;
    this.auroraPulse = Math.max(0, this.auroraPulse - dt * 1.1);
    this.auroraUniforms.uTime.value = t;
    this.auroraUniforms.uPulse.value = this.auroraPulse;
    // Sky meteors: rare shooting stars streaking the aurora band (in front
    // of the sky plane, behind the board). The auto-spawn schedule pauses
    // while the lights out owns the stage (the dark sky stays quiet);
    // in-flight meteors keep flying but dim with the rest of the sky. The
    // shed sparks use mid gravity (13: above the dissolve-ember <10 probe,
    // below the line-clear 16) and a cool HDR base (B ~1.8) that no other
    // spawner writes, so the suites attribute them unambiguously.
    {
      const mDim = 1 - 0.75 * this.overDim;
      if (!this.over && t >= this.meteorNext) {
        this.spawnMeteor();
        this.meteorNext = t + 3.5 + Math.random() * 4.5;
      }
      for (const slot of this.meteors) {
        if (!slot.m) continue;
        const st = meteorState(slot.m, t);
        if (!st) {
          if (t < slot.m.t0) continue; // not launched yet (tests use a future t0)
          slot.m = null;
          slot.head.visible = false;
          slot.tail.visible = false;
          slot.headMat.opacity = 0;
          slot.tailMat.opacity = 0;
          continue;
        }
        const { vx, vy, z } = slot.m;
        const vlen = Math.hypot(vx, vy);
        const ux = vx / vlen;
        const uy = vy / vlen;
        const a = st.alpha * mDim;
        slot.head.visible = true;
        slot.tail.visible = true;
        slot.head.position.set(st.x, st.y, z);
        slot.head.scale.setScalar(0.62);
        slot.tail.position.set(
          st.x - ux * (slot.tailLen / 2),
          st.y - uy * (slot.tailLen / 2),
          z,
        );
        slot.tail.rotation.z = meteorTailAngle(vx, vy);
        slot.tail.scale.set(slot.tailLen, 0.5, 1);
        slot.headMat.opacity = Math.min(1, a * 1.55);
        slot.tailMat.opacity = 0.62 * a;
        // One shed spark per tick per meteor: drifts back off the head and
        // dissolves, leaving a glittering drag behind the bright streak.
        const idx = this.pCursor;
        this.pCursor = (this.pCursor + 1) % this.pCount;
        this.pPos[idx * 3] = st.x + (Math.random() - 0.5) * 0.5;
        this.pPos[idx * 3 + 1] = st.y + (Math.random() - 0.5) * 0.5;
        this.pPos[idx * 3 + 2] = z;
        this.pVel[idx * 3] = -ux * (1.5 + Math.random() * 3) + (Math.random() - 0.5) * 1.2;
        this.pVel[idx * 3 + 1] = -uy * (1.5 + Math.random() * 3) + (Math.random() - 0.5) * 1.2;
        this.pVel[idx * 3 + 2] = 0;
        this.pGrav[idx] = 13;
        this.pLife[idx] = this.pMax[idx] = 0.4 + Math.random() * 0.35;
        this.pBase[idx * 3] = this.meteorSparkColor.r;
        this.pBase[idx * 3 + 1] = this.meteorSparkColor.g;
        this.pBase[idx * 3 + 2] = this.meteorSparkColor.b;
      }
    }
    // Game-over "lights out": overDim ramps 0 -> 1 over ~2.2 s and pulls
    // the aurora, stars, neon frame, glow bar and bloom down to an ember
    // level; the camera pushes back off stage as the lights die.
    this.overDim = this.over ? Math.min(1, this.overDim + dt / 2.2) : 0;
    if (this.over) this.overT += dt;
    this.auroraUniforms.uDim.value = this.overDim;
    // Rafter spotlights: advance the shared shaft uniforms (one update
    // drives all three beams) and dim the caps/pools/wash with the
    // game-over lights out (the shafts read uDim in their shader).
    this.spotPulse = Math.max(0, this.spotPulse - dt * 1.3);
    this.spotUniforms.uTime.value = t;
    this.spotUniforms.uPulse.value = this.spotPulse;
    this.spotUniforms.uDim.value = this.overDim;
    const spotDim = 1 - 0.75 * this.overDim;
    this.spotCapMat.opacity = 0.55 * spotDim;
    this.spotPoolMat.opacity = 0.18 * spotDim;
    this.spotWashMat.opacity = 0.06 * spotDim;
    const starOp = 1 - 0.55 * this.overDim;
    this.starsFar.material.opacity = 0.7 * starOp;
    this.starsMid.material.opacity = 0.7 * starOp;
    this.starsNear.material.opacity = 0.85 * starOp;
    // Ambient dust: slow up-drift with a gentle sideways sway (wrap at the
    // volume edges); per-mote twinkle written to the color attribute; the
    // whole field dims with the lights-out (the stage-hue tint is carried
    // by the material color, set in _applyStageHue).
    {
      const p = this.dustPos;
      const c = this.dustCol;
      const dd = this.dustData;
      const dim = 1 - 0.55 * this.overDim;
      for (let i = 0; i < dd.length; i++) {
        const d = dd[i];
        let y = p[i * 3 + 1] + d.vy * dt;
        if (y > 24.5) y = -0.3;
        let x = p[i * 3] + Math.sin(t * d.swayW + d.phase) * d.swayAmp * dt;
        if (x > 8.2) x = -8.2;
        else if (x < -8.2) x = 8.2;
        p[i * 3] = x;
        p[i * 3 + 1] = y;
        const tw = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * d.twW + d.phase * 1.7));
        const b = d.base * tw * dim;
        c[i * 3] = b;
        c[i * 3 + 1] = b;
        c[i * 3 + 2] = b;
      }
      this.dust.geometry.attributes.position.needsUpdate = true;
      this.dust.geometry.attributes.color.needsUpdate = true;
    }
    this.frameEdgesMat.opacity = 1 - 0.65 * this.overDim;
    this.frameRailMat.opacity = 1 - 0.65 * this.overDim;
    // Level palette: ease the stage hue toward the level's target and
    // re-ink the frame, glow bar, sky and grids (the aurora reads uHue
    // directly in its shader).
    if (this.levelHue !== this.levelHueTarget) {
      this.levelHue += (this.levelHueTarget - this.levelHue) * (1 - Math.exp(-dt * 2.2));
      if (Math.abs(this.levelHueTarget - this.levelHue) < 0.0005) this.levelHue = this.levelHueTarget;
    }
    this._applyStageHue(this.levelHue);
    // Streak mode: advance the shared crystal wave clock and ease the
    // stack's hue-wave amplitude toward the level's streakIntensity. A
    // manual overwrite of this.streak.value (tests) is left alone between
    // eases, since the write only happens while still converging.
    this.crystalTime.value = t;
    if (this.streakVal !== this.streakTarget) {
      this.streakVal += (this.streakTarget - this.streakVal) * (1 - Math.exp(-dt * 2.2));
      if (Math.abs(this.streakTarget - this.streakVal) < 0.001) this.streakVal = this.streakTarget;
      this.streak.value = this.streakVal;
    }
    this.frameBarMat.color.copy(this.frameBarColor).multiplyScalar(1 - 0.55 * this.overDim);

    // Redline alarm: ease the danger level toward the target set by
    // main.js (fast attack, slow release) and push the crimson stage tint
    // to the pixels (frame, glow bar, grids, aurora sky, grade edge-glow,
    // pulsing with the heartbeat — the pure math lives in src/danger.js).
    if (this.danger !== this.dangerTarget) {
      const k = this.dangerTarget > this.danger ? 1 - Math.exp(-dt * 6) : 1 - Math.exp(-dt * 1.4);
      this.danger += (this.dangerTarget - this.danger) * k;
      if (Math.abs(this.dangerTarget - this.danger) < 0.001) this.danger = this.dangerTarget;
    }
    this._applyDanger();

    // Camera: idle sway + mouse parallax + shake.
    const swayX = Math.sin(t * 0.21) * 0.55;
    const swayY = Math.cos(t * 0.16) * 0.35;
    const px = this.mouse.x * 1.7;
    const py = this.mouse.y * 1.0;
    let sx = 0, sy = 0;
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt * 3.2);
      const a = this.shake * this.shake * 0.3;
      sx = (Math.random() - 0.5) * 2 * a;
      sy = (Math.random() - 0.5) * 2 * a;
    }
    // TETRIS dolly punch: a short ease-out push of the camera toward the
    // board (camPunch decays; the z term is squared for the ease-out).
    if (this.camPunch > 0) this.camPunch = Math.max(0, this.camPunch - dt * 2.1);
    const punch = this.camPunch * this.camPunch * 2.6;
    this.camera.position.set(
      this.cameraBase.x + swayX + px + sx,
      this.cameraBase.y + swayY + py + sy - this.settleDip * this.settleDip * 2.6,
      this.cameraBase.z - punch + this.overDim * 7,
    );
    this.camera.lookAt(this.cameraLook.x + sx, this.cameraLook.y + sy, 0);

    // Piece: exponential smoothing toward target (slide + spin).
    if (this.pieceType) {
      const kPos = 1 - Math.exp(-dt * 26);
      const kAng = 1 - Math.exp(-dt * 20);
      this.piecePos.lerp(this.piecePosTarget, kPos);
      this.pieceAngle = lerp(this.pieceAngle, this.pieceAngleTarget, kAng);
      this.pieceGroup.position.copy(this.piecePos);
      this.pieceGroup.rotation.z = this.pieceAngle;
      if (this.pieceSpawnT < 1) {
        this.pieceSpawnT = Math.min(1, this.pieceSpawnT + dt / 0.16);
        this.pieceGroup.scale.setScalar(Math.max(0.01, easeOutBack(this.pieceSpawnT)));
      }
      // Breathing glow on the active piece.
      const mat = this.pieceMats[this.pieceType];
      if (mat) mat.emissiveIntensity = 1.05 + Math.sin(t * 5) * 0.2;
      // Stardust wake: the engine's downward motion (the target delta
      // between ticks) banks into the accumulator. While the piece is
      // visible (and the stage is lit) the bank is spent: every WAKE_STEP
      // of it sheds a mote. Hidden rows (and the game-over lights out)
      // bank silently, so the whole descent sheds as a burst the moment
      // the piece materializes into the field. Hard drops shed no dust:
      // the fresh spawn that follows jumps the target back UP, which
      // drains the bank (the pure math lives in src/fall-dust.js).
      const ty = this.piecePosTarget.y;
      if (this.wake.lastY !== null) {
        const dy = this.wake.lastY - ty; // > 0 = the piece moved down
        if (!this.over && this.pieceGroup.visible) {
          const w = wakeStep(this.wake.acc, dy);
          this.wake.acc = w.acc;
          for (let i = 0; i < w.n; i++) this._spawnWakeMote();
        } else {
          this.wake.acc = wakeBank(this.wake.acc, dy);
        }
      }
      this.wake.lastY = ty;
    }

    // Holo ghost: advance the shared scanline time and pulse the projector
    // (pillar + emitter + ghost edge lines breathe together).
    this.ghostTime.value = t;
    // Film grain advances on the same clock (the pass holds each pattern for
    // 2-3 frames via floor(uTime*24)).
    this.gradePass.uniforms.uTime.value = t;
    const gp = 0.85 + 0.15 * Math.sin(t * 2.4);
    if (this.ghostBeam.visible) this.ghostBeam.material.opacity = 0.115 * gp;
    if (this.ghostEmitter.visible) this.ghostEmitter.material.opacity = 0.32 * gp;
    for (const gm of Object.values(this.ghostMats)) gm.edge.opacity = 0.42 + 0.1 * gp;

    // Holographic rotation echo: each live afterimage swells slightly and
    // fades (the pure envelope in src/echo.js) until it hides itself at
    // ECHO_LIFE. The slot's own uFade/edge/scale are written here, so a
    // manual uniform overwrite (tests) is honored for exactly one frame.
    for (const slot of this.echoes) {
      if (!slot.group.visible) continue;
      slot.t += dt;
      const k = slot.t / ECHO_LIFE;
      if (k >= 1) {
        slot.group.visible = false;
        continue;
      }
      const mats = slot.mats[slot.type];
      const f = echoFade(k);
      mats.box.uniforms.uFade.value = f;
      mats.edge.opacity = 0.5 * f;
      slot.group.scale.setScalar(echoScale(k));
    }

    // Holo hold/next displays: pop-in ease, ping decay, breathing.
    this.holoPulse.hold = Math.max(0, this.holoPulse.hold - dt * 1.6);
    this.holoPulse.next = Math.max(0, this.holoPulse.next - dt * 1.6);
    for (const slot of [this.holoHold, this.holoNext[0], this.holoNext[1], this.holoNext[2]]) {
      if (slot.pop < 1) {
        slot.pop = Math.min(1, slot.pop + dt / 0.22);
        slot.group.scale.setScalar(slot.scale * Math.max(0.01, easeOutBack(slot.pop)));
      }
      slot.cradle.material.opacity = 0.14 + 0.08 * gp;
    }
    this.holoHoldBeam.material.opacity = 0.05 * gp;
    this.holoNextBeam.material.opacity = 0.05 * gp;
    this.holoHoldEmitter.material.opacity = (0.3 + 0.55 * this.holoPulse.hold) * gp;
    this.holoNextEmitter.material.opacity = (0.24 + 0.45 * this.holoPulse.next) * gp;

    // Popup banners: pop-in (easeOutBack on the first 16%), a slow rise
    // across the banner's life, fade-out over the last 30%.
    this.flare = 0; // per tick: the strongest active anamorphic flare
    for (const p of this.popups) {
      if (p.tier === 'gameover' && p.mesh.visible) {
        // Persistent banner: pop in once over the first 0.16 s, then hold
        // full size with a slow breathing opacity (it stays up until
        // reset(), which hides it and clears the tier state).
        if (p.t < 0.2) {
          p.t = Math.min(0.2, p.t + dt);
          const pop = Math.max(0.01, easeOutBack(p.t / 0.16));
          p.mesh.scale.set(p.w * pop, p.w * p.aspect * pop, 1);
          p.mat.opacity = Math.min(1, p.t / 0.06);
        } else {
          p.mesh.scale.set(p.w, p.w * p.aspect, 1);
          p.mat.opacity = 0.82 + 0.13 * Math.sin(t * 2.1);
        }
        continue;
      }
      if (p.t >= 1) continue;
      p.t = Math.min(1, p.t + dt / p.life);
      const e = p.t;
      const pop = Math.max(0.01, easeOutBack(Math.min(1, e / 0.16)));
      p.mesh.scale.set(p.w * pop, p.w * p.aspect * pop, 1);
      p.mesh.position.y = this.popupY + p.yOff + e * 1.3;
      p.mat.opacity = Math.min(1, e / 0.06) * (1 - smoothstep(0.7, 1, e));
      // Anamorphic flare (TETRIS / streak / perfect tiers only): tracks the
      // banner's rise, widens with the dolly punch over the first 0.22 s,
      // and follows the pure flareEnv over its own FLARE_LIFE. The grade
      // pass's full-width screen streak reads the same envelope via
      // this.flare.
      if (p.flareOn) {
        const el = e * p.life; // elapsed seconds of this banner's life
        // The game-over lights out kills the lens event instantly (the slow
        // overDim ramp is for the ambient stage, not for a punch event).
        const fe = this.over ? 0 : flareEnv(el / FLARE_LIFE) * (1 - this.overDim);
        if (fe > 0.01) {
          p.flareMesh.visible = true;
          p.flareMesh.position.set(0, this.popupY + p.yOff + e * 1.3, this.popupZ + 0.2);
          const s = p.w * 1.85 * (0.45 + 0.55 * Math.min(1, el / 0.22));
          p.flareMesh.scale.set(s, s / 3.2, 1);
          p.flareMat.opacity = fe;
          if (!this.over) {
            this.flare = Math.max(this.flare, fe * (p.tier === 'tetris' ? 1 : 0.85));
          }
        } else {
          p.flareMesh.visible = false;
          p.flareMat.opacity = 0;
        }
      }
      if (e >= 1) {
        p.mesh.visible = false;
        p.mat.opacity = 0;
      }
    }
    // The grade pass's anamorphic streak (full-width line + vertical ghost
    // + offset echo) follows the strongest live flare; 0 = invisible.
    this.gradePass.uniforms.uFlare.value = this.flare;

    // Lock pops.
    for (let i = this.pops.length - 1; i >= 0; i--) {
      const p = this.pops[i];
      p.t += dt / 0.2;
      if (p.t >= 1) {
        p.mesh.scale.setScalar(1);
        this.pops.splice(i, 1);
      } else {
        p.mesh.scale.setScalar(Math.max(0.01, easeOutBack(p.t)));
      }
    }

    // Row-collapse settle: shifted stack blocks fall from their source row
    // to their resting row with a soft bounce (easeOutBack, ~4% overshoot —
    // a sub-centimeter dip into the gap, invisible against the 0.06-unit
    // block spacing). A slide whose mesh was removed in the meantime
    // (game-over dissolve, restart) is dropped.
    for (let i = this.slides.length - 1; i >= 0; i--) {
      const s = this.slides[i];
      if (this.stackMeshes.get(s.key) !== s.mesh) {
        this.slides.splice(i, 1);
        continue;
      }
      s.t = Math.min(1, s.t + dt / s.dur);
      const e = 1 + 2 * Math.pow(s.t - 1, 3) + Math.pow(s.t - 1, 2);
      s.mesh.position.y = s.toY + (s.fromY - s.toY) * (1 - e);
      if (s.t >= 1) {
        s.mesh.position.y = s.toY;
        this.slides.splice(i, 1);
      }
    }
    // The board dips with the weight of the collapse, then eases back up.
    if (this.settleDip > 0) this.settleDip = Math.max(0, this.settleDip - dt * 1.1);

    // Hard-drop trails: fade + narrow out.
    for (const tr of this.trails) {
      if (tr.t >= 1) continue;
      tr.t = Math.min(1, tr.t + dt / 0.3);
      tr.mesh.material.opacity = 0.9 * Math.pow(1 - tr.t, 1.7);
      tr.mesh.scale.x = lerp(0.6, 0.22, 1 - Math.pow(1 - tr.t, 2));
      if (tr.t >= 1) tr.mesh.visible = false;
    }

    // Lock-impact splash + ring: expand + fade on the mirror floor.
    for (const im of this.impacts) {
      if (im.t >= 1) continue;
      im.t = Math.min(1, im.t + dt / 0.5);
      if (im.t < 0) {
        // Staggered start still waiting (the perfect-clear double ring
        // arms its second ring at t = -0.18).
        im.disc.visible = false;
        im.ring.visible = false;
        continue;
      }
      // Arming at the stagger crossing (spawn already set visible for
      // t >= 0 entries; this flips the staggered ones live).
      im.disc.visible = true;
      im.ring.visible = true;
      const e = 1 - Math.pow(1 - im.t, 3);
      const rad = lerp(0.5, 2.6 * im.k, e);
      im.disc.scale.set(rad, 1, rad);
      im.ring.scale.set(rad, 1, rad);
      im.disc.material.opacity = 0.5 * im.s * Math.pow(1 - im.t, 1.5);
      im.ring.material.opacity = 0.5 * im.s * Math.pow(1 - im.t, 1.6);
      if (im.t >= 1) {
        im.disc.visible = false;
        im.ring.visible = false;
      }
    }

    // Stack dissolve: as overT passes each cell's scheduled time the block
    // leaves the scene and a puff of slow-sinking embers takes its place.
    while (this.dissolves.length && this.dissolves[0].at <= this.overT) {
      const d = this.dissolves.shift();
      const mesh = this.stackMeshes.get(d.key);
      if (mesh) this.scene.remove(mesh);
      this.stackMeshes.delete(d.key);
      this.stackTypes.delete(d.key);
      this._spawnDissolve(d.x, d.y, this.stackMats[d.type].color);
    }

    // Clear flashes.
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.t += dt / 0.34;
      if (f.t >= 1) {
        this.scene.remove(f.mesh);
        f.mesh.material.dispose();
        this.flashes.splice(i, 1);
      } else {
        f.mesh.scale.x = lerp(0.2, BOARD_W * 1.25, 1 - Math.pow(1 - f.t, 3));
        f.mesh.material.opacity = 0.7 * (1 - f.t);
      }
    }

    // Line-clear light sweeps: constant-velocity wipe across the run. The
    // trail quad is pinned behind the edge (mirrored for right-to-left via
    // negative scale.x) so its bright texture end always meets the edge.
    for (const sw of this.sweeps) {
      if (sw.t >= 1) continue;
      sw.t = Math.min(1, sw.t + dt / sw.dur);
      if (sw.t < 0) {
        sw.group.visible = false; // staggered start still waiting
        continue;
      }
      const x = lerp(sw.xA, sw.xB, sw.t);
      const ramp = Math.min(1, sw.t / 0.1) * (1 - smoothstep(0.82, 1, sw.t));
      sw.edge.position.set(x, sw.y, 0.24);
      sw.edge.scale.set(0.16, sw.h * 1.06, 1);
      sw.edge.material.opacity = 0.9 * ramp;
      sw.trail.position.set(x - sw.dir * (SWEEP_TRAIL_W / 2), sw.y, 0.22);
      sw.trail.scale.set(-sw.dir * SWEEP_TRAIL_W, sw.h * 1.0, 1);
      sw.trail.material.opacity = 0.42 * ramp;
      if (sw.t >= 1) {
        sw.group.visible = false;
        sw.edge.material.opacity = 0;
        sw.trail.material.opacity = 0;
      }
    }

    // Shockwave rings: ease-out expansion into a wide ellipse, fading.
    for (const r of this.rings) {
      if (r.t >= 1) continue;
      r.t = Math.min(1, r.t + dt / 0.55);
      const e = 1 - Math.pow(1 - r.t, 3);
      // Vertical scale grows with the run height; kept thin enough that the
      // ripple reads as an elliptical wave, not a filled white mass.
      r.mesh.scale.set(1 + e * 15, 1 + e * (2.0 + r.h * 1.0), 1);
      r.mesh.material.opacity = 0.4 * Math.pow(1 - r.t, 1.8);
      if (r.t >= 1) r.mesh.visible = false;
    }

    // Energy shards: ballistic drift with spin, fading out.
    for (const s of this.shards) {
      if (s.t >= 1) continue;
      s.t = Math.min(1, s.t + dt / s.max);
      s.mesh.position.x += s.vx * dt;
      s.mesh.position.y += s.vy * dt;
      s.mesh.position.z += s.vz * dt;
      s.vy -= 7 * dt;
      s.mesh.rotation.z += s.spin * dt;
      s.mesh.material.opacity = 0.8 * Math.pow(1 - s.t, 1.8);
      if (s.t >= 1) s.mesh.visible = false;
    }

    // TETRIS screen flash: bloom-strength spike + full-board flash quad,
    // both decaying back to base (base itself dims with the game-over
    // lights-out).
    const bloomBase = this.bloomBase * (1 - 0.35 * this.overDim);
    if (this.flash > 0) {
      // Fast pop (~0.2s): a quick bright burst, not a sustained wash.
      this.flash = Math.max(0, this.flash - dt * 5.0);
      this.bloom.strength = bloomBase + this.flash * 0.4;
      this.tetrisFlashMesh.visible = true;
      this.tetrisFlashMesh.material.opacity = this.flash * 0.3;
    } else {
      if (this.bloom.strength !== bloomBase) this.bloom.strength = bloomBase;
      this.tetrisFlashMesh.visible = false;
    }

    // Particles.
    let anyAlive = false;
    for (let i = 0; i < this.pCount; i++) {
      if (this.pLife[i] <= 0) continue;
      anyAlive = true;
      this.pLife[i] -= dt;
      const fade = clamp01(this.pLife[i] / this.pMax[i]);
      this.pPos[i * 3] += this.pVel[i * 3] * dt;
      this.pPos[i * 3 + 1] += this.pVel[i * 3 + 1] * dt;
      this.pPos[i * 3 + 2] += this.pVel[i * 3 + 2] * dt;
      this.pVel[i * 3 + 1] -= this.pGrav[i] * dt;
      if (this.pLife[i] <= 0) this.pPos[i * 3 + 1] = -9999;
      this.pCol[i * 3] = this.pBase[i * 3] * fade;
      this.pCol[i * 3 + 1] = this.pBase[i * 3 + 1] * fade;
      this.pCol[i * 3 + 2] = this.pBase[i * 3 + 2] * fade;
    }
    if (anyAlive) {
      this.particles.geometry.attributes.position.needsUpdate = true;
      this.particles.geometry.attributes.color.needsUpdate = true;
    }

    this.composer.render();
  }
}
