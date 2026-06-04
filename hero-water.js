// hero-water.js — Dusk Water hero background for Stratton Law
// Three.js TSL (Three Shading Language) scene, WebGPU with automatic WebGL2 fallback.
//
// Design intent: a near-still reflective water plane stretching to a warm Miami
// sunset horizon. Calm, premium, coastal — not a tech demo. Palette is locked to
// the site's brand tokens (burgundy / copper / gold / cream).
//
// Robustness contract:
//   - prefers-reduced-motion  -> do NOT init; the static .hero-fallback shows instead.
//   - no WebGPU AND no WebGL2  -> init throws -> canvas hidden -> fallback shows.
//   - tab hidden / hero off-screen -> animation loop paused (battery + GPU friendly).
//   - DPR capped at 1.5; resizes handled.
//
// Nothing here is required for the page to function — it is purely an enhancement
// layer over the existing static hero.

import * as THREE from 'three';
import {
  Fn, vec2, vec3, vec4, uniform,
  time, positionLocal, positionWorld, screenUV, uv, texture,
  mix, smoothstep, pow, abs, sin, clamp, dot, normalize, reflect,
  cameraPosition, length, oneMinus, mx_noise_float,
} from 'three/tsl';

const canvas = document.getElementById('hero-water');
const heroEl = document.querySelector('.hero');

// --- Brand palette as RGB (0..1) ------------------------------------------
const SKY_TOP       = vec3(0.118, 0.047, 0.051); // #1e0c0d deep burgundy night
const SKY_HORIZON   = vec3(0.851, 0.561, 0.302); // #d98f4d warm sunset gold
const SUN_CORE      = vec3(1.000, 0.910, 0.760); // #ffe8c2 near-white sun
const WATER_DEEP    = vec3(0.090, 0.043, 0.047); // #170b0c
const WATER_SHALLOW = vec3(0.541, 0.318, 0.251); // #8a5140 copper
const GOLD          = vec3(0.761, 0.541, 0.271); // #c28a45

function prefersReducedMotion() {
  return window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// If we can't / shouldn't run, make sure the static fallback is what shows.
function bailToFallback() {
  if (canvas) canvas.style.display = 'none';
  document.documentElement.classList.add('hero-3d-off');
}

async function init() {
  if (!canvas || !heroEl) return;
  if (prefersReducedMotion()) { bailToFallback(); return; }

  // WebGPURenderer auto-selects WebGL2 if WebGPU is unavailable.
  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  await renderer.init(); // throws if no usable backend -> caught below

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(54, 1, 0.1, 2000);
  camera.position.set(0, 12, 20); // elevated, looking down ~13° so the flat imprint reads

  // --- Sky / background: vertical sunset gradient + soft sun glow ----------
  scene.backgroundNode = Fn(() => {
    const y = screenUV.y; // 0 bottom .. 1 top
    // horizon sits ~46% up the frame
    let col = mix(SKY_HORIZON, SKY_TOP, smoothstep(0.44, 1.0, y));
    // warm bloom just above the waterline
    col = mix(col, GOLD, smoothstep(0.52, 0.40, y).mul(0.45));
    // sun disc + glow centered on the horizon — tight, so it reads as a sun,
    // not a hazy halo washing the whole scene
    const d = length(screenUV.sub(vec2(0.5, 0.47)));
    const glow = smoothstep(0.20, 0.0, d);
    col = mix(col, SUN_CORE, glow.mul(0.5));
    return vec4(col, 1.0);
  })();

  // --- Wordmark texture (sampled by the water shader, see below) -----------
  // Painted INTO the water surface rather than placed as a separate plane, so
  // it is perfectly coplanar with the water, rides every wave, and reads as an
  // imprint on the surface instead of a floating object.
  function makeWordmarkTexture() {
    const cw = 1800, ch = 1100;
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const x = c.getContext('2d');
    x.clearRect(0, 0, cw, ch);
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.lineJoin = 'round';
    // Light halo first, dark body on top: the dark letters read over the bright
    // sun-path, the warm halo reads over darker water. Visible on any backdrop.
    function tier(text, cy, fontPx, spacing) {
      try { x.letterSpacing = spacing + 'px'; } catch (_) { /* older browsers */ }
      x.font = '700 ' + fontPx + 'px Georgia, "Source Serif 4", serif';
      x.lineWidth = 12;
      x.strokeStyle = 'rgba(255, 248, 236, 0.8)'; // thin warm light halo
      x.strokeText(text, cw / 2, cy);
      x.fillStyle = 'rgba(24, 9, 7, 1.0)';        // dark engraved body (dominant)
      x.fillText(text, cw / 2, cy);
    }
    // Stacked lockup: STRATTON on top, LAW (letter-spaced wide) beneath.
    // Canvas top (small y) maps toward the horizon, so STRATTON reads as the
    // upper tier from the viewer's angle.
    tier('STRATTON', ch * 0.36, 235, 20);
    tier('LAW', ch * 0.73, 235, 150);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.anisotropy = 8;
    return t;
  }
  const wmTex = makeWordmarkTexture();
  // Placement on the water in world XZ, slightly left of centre, gentle diagonal.
  // NOTE: larger span = the texture covers more water = BIGGER wordmark.
  const WM = { cx: -8, cz: -72, angle: 0.14, spanX: 108, spanZ: 95 };
  const wmCos = Math.cos(WM.angle), wmSin = Math.sin(WM.angle);

  // --- Sailboat + wake -----------------------------------------------------
  // Boat position on the water (world XZ), updated each frame from createBoat().
  const boatU = uniform(new THREE.Vector2(6, -116));
  // Heading toward the horizon, tilted to echo the wordmark's diagonal.
  const BHEAD = (() => { const x = 0.24, z = -1.0, l = Math.hypot(x, z); return { x: x / l, z: z / l }; })();
  // Overall wake intensity — eased down as the boat sails far away so the water
  // (and the wordmark on it) calms and stays legible. Updated in createBoat().
  const wakeStr = uniform(1.0);
  // Stylized wake at a world XZ. Opens in a V *behind* the boat (toward the
  // viewer) and fades astern, so its travelling ripples wash back through the
  // wordmark. Returns the pieces both the position and colour nodes reuse.
  // Long narrow planing wake (cf. references): a bright turbulent prop-wash
  // streak straight astern, flanked by two thin dark divergent edge lines that
  // trail far into the distance.
  function wakeField(wx, wz) {
    const rx = wx.sub(boatU.x);
    const rz = wz.sub(boatU.y);
    const along = rx.mul(BHEAD.x).add(rz.mul(BHEAD.z));   // + ahead of boat, - astern
    const cross = rx.mul(-BHEAD.z).add(rz.mul(BHEAD.x));  // signed offset from the track
    const behind = clamp(along.negate(), 0.0, 240.0);     // 0 at boat -> long trail astern
    const ac = abs(cross);
    const fade = smoothstep(0.0, 4.0, behind).mul(smoothstep(240.0, 16.0, behind));
    const amp = smoothstep(0.0, 70.0, behind).mul(0.5).add(0.5).mul(wakeStr);

    // Bright turbulent centre streak, stays narrow the whole length.
    const centreW = behind.mul(0.025).add(1.2);
    const churn = mx_noise_float(vec3(cross.mul(1.2), behind.mul(0.4), time.mul(1.6)))
      .mul(0.5).add(0.55);
    const centre = smoothstep(centreW, 0.0, ac).mul(churn);

    // Two crisp divergent edge lines forming the V (~10 deg), lightly feathered.
    const armC = behind.mul(0.17).add(0.8);
    const armW = behind.mul(0.02).add(1.4);
    const feather = sin(behind.mul(0.6).sub(time.mul(1.8))).mul(0.2).add(0.8);
    const arms = smoothstep(armW, 0.0, abs(ac.sub(armC))).mul(feather);

    // Busy ripples BETWEEN the arms: choppy and dense right behind the boat,
    // calming as they trail out astern.
    const inside = smoothstep(armC, armC.mul(0.55), ac);        // 1 between the arms
    const near = smoothstep(170.0, 8.0, behind);                // strong near boat -> calm far
    const trans = sin(behind.mul(0.7).add(cross.mul(cross).mul(0.02)).sub(time.mul(2.0)))
      .mul(0.5).add(0.5);                                       // curved transverse crests
    const innerChurn = mx_noise_float(vec3(cross.mul(0.9), behind.mul(0.7), time.mul(1.9)))
      .mul(smoothstep(95.0, 0.0, behind));                      // chaos close astern
    const inner = trans.mul(0.6).add(innerChurn.mul(0.7)).mul(inside).mul(near);

    const height = centre.mul(0.7).add(arms.mul(1.2)).add(inner.mul(0.8)).sub(0.18).mul(fade).mul(amp);
    return { centre, arms, inner, height, fade, amp };
  }

  // --- Water plane ---------------------------------------------------------
  const geo = new THREE.PlaneGeometry(900, 900, 180, 180);
  const mat = new THREE.MeshBasicNodeMaterial();

  // Gentle layered swell. PlaneGeometry lies in local XY; the mesh is rotated
  // flat, so displacing local +Z lifts the surface in world +Y.
  const tSlow = time.mul(0.06);
  const baseUV = positionLocal.xy.mul(0.02);
  const swell = mx_noise_float(vec3(baseUV, tSlow)).mul(1.1)
    .add(mx_noise_float(vec3(baseUV.mul(3.1), tSlow.mul(1.7))).mul(0.4))
    .add(mx_noise_float(vec3(baseUV.mul(8.0), tSlow.mul(2.6))).mul(0.12));
  // Wake displacement (worldX = localX, worldZ = -localY for this flat plane).
  const wkPos = wakeField(positionLocal.x, positionLocal.y.negate());
  mat.positionNode = positionLocal.add(vec3(0, 0, swell.add(wkPos.height.mul(0.9))));

  // Stylized water shading — hand-rolled so it reads right without scene lights.
  mat.colorNode = Fn(() => {
    const viewDir = normalize(cameraPosition.sub(positionWorld));

    // Rippled surface normal from layered noise (higher frequency than the
    // swell, so the sun glitter is fine-grained and lively).
    const np = positionWorld.xz.mul(0.05);
    const nt = time.mul(0.3);
    const bumpX = mx_noise_float(vec3(np, nt))
      .add(mx_noise_float(vec3(np.mul(3.0).add(11.0), nt.mul(1.6))).mul(0.5));
    const bumpZ = mx_noise_float(vec3(np.add(53.0), nt))
      .add(mx_noise_float(vec3(np.mul(3.0).add(71.0), nt.mul(1.6))).mul(0.5));
    const N = normalize(vec3(bumpX.mul(0.35), 1.0, bumpZ.mul(0.35)));

    const fres = pow(oneMinus(clamp(dot(N, viewDir), 0.0, 1.0)), 3.0);

    // Depth ramp: dark water near the camera -> bright sunset horizon far away.
    const depth = smoothstep(-10.0, 200.0, positionWorld.z.negate());

    let col = mix(WATER_DEEP, WATER_SHALLOW, depth.mul(0.6));
    // sky reflection grows at grazing angles and toward the horizon
    col = mix(col, SKY_HORIZON, clamp(fres.add(depth.mul(0.3)), 0.0, 1.0).mul(0.95));

    // Sun-glitter: reflect the view about the rippled normal and test against a
    // low sun near the horizon. Sharp exponent -> thousands of moving sparkles.
    const sunDir = normalize(vec3(0.0, 0.16, -1.0));
    const refl = reflect(viewDir.negate(), N);
    const spec = pow(clamp(dot(refl, sunDir), 0.0, 1.0), 80.0);
    col = col.add(SUN_CORE.mul(spec.mul(2.2)));

    // Broad warm reflection column down the centre, beneath the sun.
    const lane = abs(positionWorld.x.div(positionWorld.z.abs().add(24.0)));
    const column = smoothstep(0.22, 0.0, lane).mul(depth);
    col = col.add(GOLD.mul(column.mul(0.5)));

    // Concentrate the sunset glare centre-right; calm + darken the left side.
    col = col.mul(smoothstep(-110.0, 90.0, positionWorld.x).mul(0.48).add(0.52));

    // --- Boat wake: foamy V that washes back toward the viewer ------------
    // Boat shadow: a soft dark smear cast away from the low sun (toward the
    // viewer), anchored to the boat so it travels with it.
    const shX = positionWorld.x.sub(boatU.x);
    const shZ = positionWorld.z.sub(boatU.y);          // >0 = toward the viewer (anti-sun)
    const tShade = clamp(shZ.div(24.0), 0.0, 1.0);
    const shadeWidth = tShade.mul(3.0).add(3.2);        // widens slightly with distance
    const shade = smoothstep(shadeWidth, 0.0, abs(shX))
      .mul(oneMinus(tShade))
      .mul(smoothstep(-2.0, 2.0, shZ));
    col = mix(col, WATER_DEEP, shade.mul(0.5));

    const wk = wakeField(positionWorld.x, positionWorld.z);
    const wkVis = wk.fade.mul(wk.amp);
    // Carve the wake as DARK grooves so it reads on the bright sun-path (additive
    // foam washes out there). Strong dark V arms + darker churn, with a touch of
    // bright sparkle in the turbulent centre.
    col = mix(col, WATER_DEEP, clamp(wk.arms.mul(wkVis).mul(0.85), 0.0, 0.85));   // dark V arms
    col = mix(col, WATER_DEEP, clamp(wk.centre.mul(wkVis).mul(0.5), 0.0, 0.6));   // dark churn centre
    col = mix(col, WATER_DEEP, clamp(wk.inner.mul(wkVis).mul(0.4), 0.0, 0.5));    // ripples between the V
    col = col.add(SUN_CORE.mul(wk.centre.mul(wkVis).mul(0.22)));                  // foam sparkle
    col = col.add(SUN_CORE.mul(wk.inner.mul(wkVis).mul(0.14)));                   // glints between the V

    // --- "STRATTON LAW" imprinted into the surface ------------------------
    // Map this fragment's world XZ into the wordmark's diagonal UV box. Because
    // we key off XZ (not the displaced height), the letters stay fixed on the
    // water like paint and simply ride up/down with the swell.
    const dx = positionWorld.x.sub(WM.cx);
    const dz = positionWorld.z.sub(WM.cz);
    const wu = dx.mul(wmCos).add(dz.mul(wmSin)).div(WM.spanX).add(0.5);
    // letter-tops point toward the horizon (-Z) so the wordmark faces the viewer
    const wv = dx.mul(wmSin).sub(dz.mul(wmCos)).div(WM.spanZ).add(0.5);
    // wet shimmer wobble + the boat's wake ripples distorting the letters
    const wkWob = wk.height.mul(0.03);
    const wmWob = vec2(
      mx_noise_float(vec3(positionWorld.xz.mul(0.15), time.mul(0.3))).mul(0.012).add(wkWob),
      mx_noise_float(vec3(positionWorld.xz.mul(0.15).add(7.0), time.mul(0.3))).mul(0.012).add(wkWob),
    );
    const wmTexel = texture(wmTex, vec2(wu, wv).add(wmWob));
    // mask to the placement box so nothing smears outside it
    const wmMask = smoothstep(0.0, 0.03, wu).mul(smoothstep(1.0, 0.97, wu))
      .mul(smoothstep(0.0, 0.05, wv)).mul(smoothstep(1.0, 0.95, wv));
    const wmA = wmTexel.a.mul(wmMask);
    // Texture's own colour (dark engraved body + warm light halo) so the letters
    // read whether they sit over the bright sun-path or darker water.
    col = mix(col, wmTexel.rgb, wmA);

    return vec4(col, 1.0);
  })();

  const water = new THREE.Mesh(geo, mat);
  water.rotation.x = -Math.PI / 2;
  water.position.y = 0;
  scene.add(water);

  // --- Drifting birds (distant dusk silhouettes) ---------------------------
  // Few but lifelike: each bird has its own cruise speed, swooping flight path,
  // flap rhythm + depth, and glides (wings held) while climbing — then flaps
  // harder on the descents, banking into its turns.
  function createBirds() {
    const COUNT = 5;
    const RANGE = 360; // x-wrap width
    // Gull-ish wing: a shallow swept curve rather than a flat triangle.
    const wingR = new THREE.BufferGeometry();
    wingR.setAttribute('position', new THREE.Float32BufferAttribute(
      [0, 0, 0, 0.62, 0.17, 0, 1.15, 0.02, 0, 0.62, 0.05, 0], 3));
    wingR.setIndex([0, 1, 3, 1, 2, 3]);
    const wingL = new THREE.BufferGeometry();
    wingL.setAttribute('position', new THREE.Float32BufferAttribute(
      [0, 0, 0, -0.62, 0.17, 0, -1.15, 0.02, 0, -0.62, 0.05, 0], 3));
    wingL.setIndex([0, 3, 1, 1, 3, 2]);

    const birds = [];
    for (let i = 0; i < COUNT; i++) {
      const group = new THREE.Group();
      const z = -64 - Math.random() * 150;
      // farther birds are fainter and smaller (atmospheric depth)
      const closeness = 1 - (-z - 64) / 150; // 1 near .. 0 far
      const m = new THREE.MeshBasicNodeMaterial();
      m.colorNode = vec3(0.12, 0.08, 0.08);
      m.transparent = true;
      m.opacity = 0.4 + closeness * 0.32;
      m.depthWrite = false;
      m.side = THREE.DoubleSide;
      const r = new THREE.Mesh(wingR, m);
      const l = new THREE.Mesh(wingL, m);
      group.add(r, l);
      group.scale.setScalar(3.2 + closeness * 4.0 + Math.random() * 1.2);
      const b = {
        group, r, l,
        startX: Math.random() * RANGE,
        dir: Math.random() < 0.5 ? 1 : -1,
        speed: 7 + Math.random() * 12,
        baseY: 32 + Math.random() * 44,
        z,
        // swoop (slow vertical wander)
        swoopAmp: 4 + Math.random() * 9,
        swoopSpeed: 0.12 + Math.random() * 0.22,
        swoopPhase: Math.random() * Math.PI * 2,
        // flap
        flapBase: 0.10 + Math.random() * 0.12,
        flapAmp: 0.38 + Math.random() * 0.5,
        flapSpeed: 4 + Math.random() * 6,
        phase: Math.random() * Math.PI * 2,
      };
      group.position.set(0, b.baseY, b.z);
      scene.add(group);
      birds.push(b);
    }
    return {
      update(t) {
        for (const b of birds) {
          const vx = b.speed * b.dir;
          b.group.position.x = ((b.startX + t * vx) % RANGE + RANGE) % RANGE - RANGE / 2;

          // swooping vertical path + a small secondary bob
          const sw = Math.sin(t * b.swoopSpeed + b.swoopPhase);
          const swVel = Math.cos(t * b.swoopSpeed + b.swoopPhase); // +climbing
          b.group.position.y = b.baseY + sw * b.swoopAmp
            + Math.sin(t * b.swoopSpeed * 2.4 + b.phase) * 1.2;

          // glide while climbing (less flap), flap harder on descents
          const glide = Math.max(0.12, 1 - Math.max(0, swVel) * 1.3);
          const flap = b.flapBase + Math.sin(t * b.flapSpeed + b.phase) * b.flapAmp * glide;
          b.r.rotation.z = flap;
          b.l.rotation.z = -flap;

          // bank into the swoop, and lean with travel direction
          b.group.rotation.z = -swVel * 0.22 * b.dir;
          b.group.rotation.y = b.dir < 0 ? Math.PI : 0; // face direction of travel
        }
      },
    };
  }

  const birds = createBirds();

  // --- Sailboat (dark silhouette sailing toward the horizon) ---------------
  function createBoat() {
    const dark = new THREE.MeshBasicNodeMaterial();
    dark.colorNode = vec3(0.10, 0.07, 0.07);
    dark.transparent = true;
    dark.opacity = 0.96;
    dark.depthWrite = false;
    dark.side = THREE.DoubleSide;

    const grp = new THREE.Group();
    const add = (verts, idx) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      g.setIndex(idx);
      const m = new THREE.Mesh(g, dark);
      grp.add(m);
      return m;
    };
    add([-2.0, 0, 0, 2.0, 0, 0, 1.2, -1.0, 0, -1.2, -1.0, 0], [0, 1, 2, 0, 2, 3]); // transom hull
    const mainsail = add([-1.5, 0.35, 0, 0, 7.4, 0, 1.5, 0.35, 0], [0, 1, 2]);   // mainsail (stern view)
    const jib = add([0.1, 0.35, 0, 0.25, 5.4, 0, 1.8, 0.35, 0], [0, 1, 2]);      // jib set to one side
    grp.scale.setScalar(1.25);
    grp.rotation.y = -0.1; // nearly stern-on: sailing away toward the horizon
    scene.add(grp);

    const start = { x: 6, z: -116 };
    const RUN = 104;     // how far it sails toward the horizon
    const TRAVEL = 30;   // seconds to get there, then it just lingers (no loop)
    return {
      update(t) {
        const p = Math.min(t / TRAVEL, 1);
        wakeStr.value = 0.35 + 0.65 * (1 - p); // calm the wake as the boat sails far off
        const d = RUN * (1 - Math.pow(1 - p, 2)); // ease-out, then holds at RUN
        const x = start.x + BHEAD.x * d;
        const z = start.z + BHEAD.z * d;
        boatU.value.set(x, z);
        grp.position.set(x, 0.7 + Math.sin(t * 1.1) * 0.42, z); // bob more
        grp.rotation.z = -0.06 + Math.sin(t * 0.7) * 0.06;      // heel
        // sails luff a little with the wind
        const luff = Math.sin(t * 1.6) * 0.07 + Math.sin(t * 0.9) * 0.035;
        mainsail.rotation.y = luff;
        jib.rotation.y = luff * 1.4 + 0.06;
      },
    };
  }
  const boat = createBoat();

  // --- Sizing --------------------------------------------------------------
  function resize() {
    const w = canvas.clientWidth || heroEl.clientWidth;
    const h = canvas.clientHeight || heroEl.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener('resize', resize);

  // --- Mouse parallax (subtle) --------------------------------------------
  const target = { x: 0, y: 0 };
  const current = { x: 0, y: 0 };
  window.addEventListener('pointermove', (e) => {
    target.x = (e.clientX / window.innerWidth - 0.5);
    target.y = (e.clientY / window.innerHeight - 0.5);
  }, { passive: true });

  // --- Pause when off-screen or tab hidden ---------------------------------
  let visible = true;
  function applyLoop() {
    renderer.setAnimationLoop(visible && !document.hidden ? frame : null);
  }
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      visible = entries[0].isIntersecting;
      applyLoop();
    }, { threshold: 0.01 }).observe(heroEl);
  }
  document.addEventListener('visibilitychange', applyLoop);

  const startMs = performance.now();
  function frame() {
    const t = (performance.now() - startMs) * 0.001;
    current.x += (target.x - current.x) * 0.04;
    current.y += (target.y - current.y) * 0.04;
    camera.position.x = current.x * 2.6;
    camera.position.y = 12 - current.y * 0.8;
    camera.lookAt(0, 0, -52); // look down onto the surface so the imprint reads
    birds.update(t);
    boat.update(t);
    renderer.render(scene, camera);
  }

  renderer.setAnimationLoop(frame);
  document.documentElement.classList.add('hero-3d-on');
}

init().catch((err) => {
  console.warn('[hero-water] disabled:', err);
  bailToFallback();
});
