// ─────────────────────────────────────────────────────────────
// main.js — wires the simulation engine, the planet view, the comet
// event, and the DOM controls into a single live loop.
//
//   UI sliders ──▶ sim.inputs ──▶ stepSim() ──▶ PlanetView.applyState()
//                                          └──▶ dashboard readout
// ─────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createSim, stepSim, cometImpact, atmosphereInfo, COMET_TYPES } from './sim.js';
import { SURFACE_TYPES } from './surface.js';
import { PlanetView } from './planet.js';
import { CometController } from './comet.js';
import { SpaceAudio } from './audio.js';

// ── scene ────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;   // filmic dynamic range
renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const clock = new THREE.Clock();
const camera = new THREE.PerspectiveCamera(50, window.innerWidth/window.innerHeight, 0.1, 6000);
camera.position.set(0, 4, 26);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.dampingFactor = 0.07;
controls.minDistance = 13; controls.maxDistance = 200;
controls.autoRotate = false;

const TRACK_AXIS = new THREE.Vector3(0, 1, 0);   // world up — planetMesh only ever spins about this

// The sun: a directional light for the terminator + a visible glowing star
// that bloom turns into a real light source on screen.
const SUN_DIR = new THREE.Vector3(8, 5, 10).normalize();
scene.add(new THREE.AmbientLight(0x35506a, 0.35));
const sun = new THREE.DirectionalLight(0xfff4e0, 2.6);
sun.position.copy(SUN_DIR).multiplyScalar(50); scene.add(sun);
scene.background = buildNebula();
scene.add(buildSun());
scene.add(buildStarfield());

function buildSun() {
  const g = new THREE.Group();
  const pos = SUN_DIR.clone().multiplyScalar(700);
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(26, 32, 32),
    new THREE.MeshBasicMaterial({ color: 0xfff0d0 }),   // unlit → blooms hot white
  );
  core.position.copy(pos); g.add(core);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: radialSprite('#fff2cc'), color: 0xffd9a0, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  halo.position.copy(pos); halo.scale.setScalar(360); g.add(halo);
  return g;
}

function radialSprite(inner) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const grd = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, inner); grd.addColorStop(0.25, 'rgba(255,225,170,0.6)');
  grd.addColorStop(1, 'rgba(255,200,120,0)');
  ctx.fillStyle = grd; ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

// Faint procedural nebula wrapped around the sky as an equirectangular
// backdrop — gives deep space some color and depth behind the stars.
function buildNebula() {
  const W = 1024, H = 512, c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#02030a'; ctx.fillRect(0, 0, W, H);
  const tints = ['#2a1a4a', '#15324f', '#3a1838', '#102a3a'];
  for (let i = 0; i < 26; i++) {
    const x = Math.random()*W, y = Math.random()*H, r = 80 + Math.random()*260;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const t = tints[Math.floor(Math.random()*tints.length)];
    g.addColorStop(0, t + '55'); g.addColorStop(1, t + '00');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2); ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildStarfield() {
  const n = 9000, pos = new Float32Array(n*3), col = new Float32Array(n*3), siz = new Float32Array(n);
  const C = [[1,1,1],[1,0.95,0.8],[0.78,0.88,1],[1,0.7,0.55],[0.92,0.92,1]];
  for (let i=0;i<n;i++){
    const th=Math.random()*Math.PI*2, ph=Math.acos(2*Math.random()-1), r=1500+Math.random()*900;
    pos[i*3]=r*Math.sin(ph)*Math.cos(th); pos[i*3+1]=r*Math.sin(ph)*Math.sin(th); pos[i*3+2]=r*Math.cos(ph);
    const b=0.5+Math.pow(Math.random(),3)*0.5;                 // a few bright, many dim
    const c=C[Math.floor(Math.random()*C.length)];
    col[i*3]=c[0]*b; col[i*3+1]=c[1]*b; col[i*3+2]=c[2]*b;
    siz[i]=(0.6+Math.pow(Math.random(),6)*4)*b;
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos,3));
  g.setAttribute('color', new THREE.BufferAttribute(col,3));
  return new THREE.Points(g, new THREE.PointsMaterial({ size:2.4, vertexColors:true, sizeAttenuation:false, transparent:true }));
}

// ── post-processing: filmic bloom makes the sun, lava, atmosphere and
//    (later) city lights glow like real emitters ──
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
// bloom is a blur, so run it at HALF resolution — visually ~identical, ~4× cheaper
const bloom = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth/2, window.innerHeight/2), 0.32, 0.5, 0.9,   // strength, radius, threshold
);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ── world state ──────────────────────────────────────────────
const planet = new PlanetView(scene);
const comets = new CometController(scene, camera);
let sim = createSim();
let simSpeed = 4;   // Myr per real second (0 = paused)

function newWorld() {
  const seed = parseInt(document.getElementById('inp-seed').value) || 42;
  const typeDef = SURFACE_TYPES.find(t => t.id === typeSel.value) ?? SURFACE_TYPES[0];
  comets.cancel();
  // keep the player's current macro settings, reset the evolving state
  const inputs = { solarFlux: sim.solarFlux, gravity: sim.gravity, coreHeat: sim.coreHeat, tectonicInput: sim.tectonicInput };
  sim = Object.assign(createSim(), inputs);
  planet.build(seed, typeDef);
  stepSim(sim, 0);
  planet.applyState(sim);
  updateDash();
}

// ── save / share — encode the whole world into a shareable URL ──
const SAVE_KEYS = ['solarFlux','gravity','coreHeat','tectonicInput',
  'coreTemp','tectonics','waterMass','co2','n2','biosphere','civilization','age'];
function shareWorld() {
  const data = { s: parseInt(document.getElementById('inp-seed').value) || 42, t: typeSel.value };
  for (const k of SAVE_KEYS) data[k] = +sim[k].toFixed(4);
  const url = location.origin + location.pathname + '#w=' + btoa(JSON.stringify(data));
  navigator.clipboard?.writeText(url).then(
    () => flashShare('✓ link copied'),
    () => flashShare('copy failed'),
  );
  history.replaceState(null, '', url);
}
function flashShare(msg) {
  const b = document.getElementById('btn-share');
  if (b) { const o = b.textContent; b.textContent = msg; setTimeout(() => b.textContent = o, 1400); }
}
function loadFromHash() {
  const m = location.hash.match(/w=([^&]+)/);
  if (!m) return false;
  try {
    const d = JSON.parse(atob(m[1]));
    const typeDef = SURFACE_TYPES.find(t => t.id === d.t) ?? SURFACE_TYPES[0];
    document.getElementById('inp-seed').value = d.s;
    typeSel.value = typeDef.id;
    sim = createSim();
    for (const k of SAVE_KEYS) if (typeof d[k] === 'number') sim[k] = d[k];
    planet.build(d.s, typeDef);
    syncSlidersFromSim();
    stepSim(sim, 0);
    planet.applyState(sim);
    updateDash();
    return true;
  } catch (e) { console.warn('bad share link', e); return false; }
}
function syncSlidersFromSim() {
  document.querySelectorAll('.slider').forEach(el => {
    const input = el.querySelector('input');
    input.value = sim[el.dataset.key];
    input.dispatchEvent(new Event('input'));
  });
}

// ── DOM wiring ───────────────────────────────────────────────
const typeSel = document.getElementById('inp-type');
typeSel.innerHTML = SURFACE_TYPES.map(t => `<option value="${t.id}">${t.label}</option>`).join('');

document.getElementById('btn-rng').addEventListener('click', () => {
  document.getElementById('inp-seed').value = (Math.random()*0xffffff|0).toString();
  newWorld();
});
document.getElementById('btn-gen').addEventListener('click', newWorld);
typeSel.addEventListener('change', newWorld);
document.getElementById('btn-share').addEventListener('click', shareWorld);

// macro sliders → live sim inputs
document.querySelectorAll('.slider').forEach(el => {
  const key = el.dataset.key;
  const input = el.querySelector('input');
  const val = el.querySelector('.val');
  const fmt = () => { val.textContent = key === 'solarFlux' || key === 'gravity'
    ? (+input.value).toFixed(2) + '×' : Math.round(input.value*100) + '%'; };
  input.addEventListener('input', () => { sim[key] = +input.value; fmt(); });
  fmt();
});

// time transport
document.querySelectorAll('#time button').forEach(b => {
  b.addEventListener('click', () => {
    simSpeed = +b.dataset.speed;
    document.querySelectorAll('#time button').forEach(x => x.classList.toggle('on', x === b));
  });
});

// audio — procedural space ambience + impact sounds (Web Audio)
const audio = new SpaceAudio();
audio.setBackgroundFolder('./sound/');   // every .mp3 in /sound is cycled, fading over the drone
const btnSound = document.getElementById('btn-sound');
let soundUnlocked = false, soundOn = true;
function applySound() {
  audio.resume(); audio.setEnabled(soundOn);
  btnSound.classList.toggle('on', soundOn);
  btnSound.textContent = soundOn ? '🔊 SOUND ON' : '🔇 SOUND OFF';
}
// unlock audio on the first gesture anywhere EXCEPT the sound button (which
// handles its own gesture, so it doesn't get double-processed and muted).
const unlock = (e) => {
  if (e.target && e.target.closest && e.target.closest('#btn-sound')) return;
  soundUnlocked = true; applySound();
  ['pointerdown','keydown','touchstart'].forEach(ev => window.removeEventListener(ev, unlock));
};
['pointerdown','keydown','touchstart'].forEach(ev => window.addEventListener(ev, unlock));
btnSound.addEventListener('click', () => {
  if (!soundUnlocked) { soundUnlocked = true; soundOn = true; }  // first press: enable
  else soundOn = !soundOn;                                       // after that: toggle
  applySound();
});

// comet event — payload type chosen by the player
const cometSel = document.getElementById('comet-type');
cometSel.innerHTML = COMET_TYPES.map(c => `<option value="${c.id}">${c.label}</option>`).join('');
const btnComet = document.getElementById('btn-comet');
btnComet.addEventListener('click', () => {
  if (comets.busy) return;
  const typeId = cometSel.value;
  const def = COMET_TYPES.find(c => c.id === typeId) ?? COMET_TYPES[0];
  btnComet.disabled = true;
  audio.playWhoosh();                      // whoosh as it flies in
  comets.fire(planet.radius, () => {
    cometImpact(sim, typeId);
    audio.playImpact();                    // boom + rumble on impact
    btnComet.disabled = false;
  }, def.color);
});

// ── dashboard readout ────────────────────────────────────────
const tempColor = t => t<240 ? '#7cf' : t<290 ? '#6c9' : t<340 ? '#dd6' : '#f74';
function bar(id, pct, color, text) {
  const el = document.getElementById(id);
  el.querySelector('b').textContent = text;
  const d = el.querySelector('.bar > div');
  d.style.width = Math.max(0, Math.min(100, pct)) + '%';
  d.style.background = color;
}
// Atmosphere readout: total pressure + composition stacked bar + legend.
const atmEl = document.getElementById('st-atm');
const compSegs = atmEl.querySelectorAll('.comp-bar > div');
const compLegend = atmEl.querySelector('.comp-legend');
function updateAtmosphere() {
  const comp = atmosphereInfo(sim);
  atmEl.classList.toggle('airless', comp.airless);
  atmEl.querySelector('b').textContent = comp.airless ? 'trace — airless' : comp.total.toFixed(2) + ' bar';
  let legend = '';
  comp.gases.forEach((g, i) => {
    compSegs[i].style.width = (g.frac * 100) + '%';
    compSegs[i].style.background = g.colorHex;
    legend += `<span style="color:${g.colorHex}">${g.key} <b>${Math.round(g.frac*100)}%</b></span>`;
  });
  compLegend.innerHTML = legend;
}

function updateDash() {
  document.getElementById('age').textContent = sim.age >= 1000
    ? (sim.age/1000).toFixed(2) + ' Gyr' : Math.round(sim.age) + ' Myr';
  document.getElementById('archetype').textContent = sim.archetype;
  bar('st-temp',  (sim.surfaceTemp-180)/(520-180)*100, tempColor(sim.surfaceTemp), Math.round(sim.surfaceTemp)+' K');
  bar('st-ocean', sim.oceanCoverage*100, '#3a86c8', Math.round(sim.oceanCoverage*100)+'%');
  bar('st-ice',   sim.iceCoverage*100, '#bfe0ff', Math.round(sim.iceCoverage*100)+'%');
  bar('st-dust',  sim.dust*100, '#948b7a', Math.round(sim.dust*100)+'%');
  updateAtmosphere();
  bar('st-mag',   sim.magneticField*100, '#a8f', Math.round(sim.magneticField*100)+'%');
  bar('st-hab',   sim.habitability*100, '#6e6', Math.round(sim.habitability*100)+'%');
  const bioTxt = sim.civilization > 0.05
    ? Math.round(sim.biosphere*100)+'% · civ '+Math.round(sim.civilization*100)+'%'
    : Math.round(sim.biosphere*100)+'%';
  bar('st-bio',   sim.biosphere*100, sim.civilization > 0.05 ? '#ffd27a' : '#5cbf5c', bioTxt);
}

// In-world hover UI: shield/tech-rush buttons float over a city's current
// (spinning) screen position when the mouse gets close, instead of living in
// the dashboard list — clicking a city directly reads better for a "god
// power" than a sidebar button.
const HOVER_RADIUS = 60;       // px — how close the mouse must be to reveal the buttons
const cityHoverLayer = document.createElement('div');
cityHoverLayer.id = 'city-hover-layer';
document.body.appendChild(cityHoverLayer);
let cityBtnEls = null;

// health bars float under each city, always visible once war starts —
// unlike the power buttons, not gated on mouse proximity. A defeated
// faction's whole UI (bar + buttons) disappears for good, same tick.
const cityHpLayer = document.createElement('div');
cityHpLayer.id = 'city-hp-layer';
document.body.appendChild(cityHpLayer);
let cityHpEls = null;

// a small white dot marks each city's center, always visible (no hover
// needed) — click it to have the camera track that city as the planet
// spins; any manual orbit/drag of the camera drops back to free-cam.
const cityDotLayer = document.createElement('div');
cityDotLayer.id = 'city-dot-layer';
document.body.appendChild(cityDotLayer);
let cityDotEls = null;
let trackedCityId = null;
let lastPlanetRotY = null;

let mouseX = -9999, mouseY = -9999;
window.addEventListener('mousemove', (e) => { mouseX = e.clientX; mouseY = e.clientY; });

cityHoverLayer.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = +btn.dataset.id;
  if (btn.dataset.act === 'shield') planet.shieldFaction(id);
  else if (btn.dataset.act === 'rush') planet.rushTech(id);
});

cityDotLayer.addEventListener('click', (e) => {
  const dot = e.target.closest('.city-dot');
  if (!dot) return;
  const id = +dot.dataset.id;
  trackedCityId = id;
  // snap the camera to look straight at the city (keeping the current zoom
  // distance) so tracking starts centered instead of wherever it was clicked
  const { pos } = planet.getCityWorldPositions()[id];
  const dist = camera.position.length();
  camera.position.copy(pos).normalize().multiplyScalar(dist);
});

// dragging to rotate/pan/zoom no longer drops tracking — the camera keeps
// following the city through all of that. Tracking only ends when the user
// plainly clicks (no drag) on empty space: a pointerdown/up pair on the
// canvas itself with barely any movement between them. UI elements (the dot,
// power buttons, health bars) sit on top of the canvas and consume their own
// clicks, so they never reach this listener — no extra filtering needed.
let canvasDownPos = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  canvasDownPos = { x: e.clientX, y: e.clientY };
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!canvasDownPos) return;
  const moved = Math.hypot(e.clientX - canvasDownPos.x, e.clientY - canvasDownPos.y);
  canvasDownPos = null;
  if (moved < 4) trackedCityId = null;
});

function ensureCityHoverEls(count) {
  if (cityBtnEls && cityBtnEls.length === count) return;
  cityHoverLayer.innerHTML = '';
  cityBtnEls = Array.from({ length: count }, (_, id) => {
    const el = document.createElement('div');
    el.className = 'city-powers';
    el.innerHTML = `<button class="fbtn" data-act="shield" data-id="${id}" title="Shield">🛡</button><button class="fbtn" data-act="rush" data-id="${id}" title="Tech Rush">⚡</button>`;
    cityHoverLayer.appendChild(el);
    return el;
  });
  cityHpLayer.innerHTML = '';
  cityHpEls = Array.from({ length: count }, () => {
    const el = document.createElement('div');
    el.className = 'city-hp';
    el.innerHTML = `<div class="city-hp-fill"></div>`;
    cityHpLayer.appendChild(el);
    return el;
  });
  cityDotLayer.innerHTML = '';
  cityDotEls = Array.from({ length: count }, (_, id) => {
    const el = document.createElement('div');
    el.className = 'city-dot';
    el.dataset.id = id;
    el.title = 'Track this city';
    cityDotLayer.appendChild(el);
    return el;
  });
}

function updateCityHoverUI() {
  const positions = planet.getCityWorldPositions();
  if (!positions.length) {
    if (cityBtnEls) cityBtnEls.forEach(el => el.style.display = 'none');
    if (cityHpEls) cityHpEls.forEach(el => el.style.display = 'none');
    if (cityDotEls) cityDotEls.forEach(el => el.style.display = 'none');
    trackedCityId = null;   // civilization wiped — nothing left to track
    return;
  }
  ensureCityHoverEls(positions.length);
  const w = window.innerWidth, h = window.innerHeight;
  positions.forEach(({ pos, normal }, id) => {
    const btnEl = cityBtnEls[id], hpEl = cityHpEls[id], dotEl = cityDotEls[id];
    const f = planet.factions[id];
    // a defeated faction loses its whole in-world UI — bar, buttons and dot alike
    if (f.defeated) {
      btnEl.style.display = 'none'; hpEl.style.display = 'none'; dotEl.style.display = 'none';
      if (trackedCityId === id) trackedCityId = null;
      return;
    }
    const toCam = camera.position.clone().sub(pos).normalize();
    const ndc = pos.clone().project(camera);
    const hidden = normal.dot(toCam) < 0.05    // far side of the globe
      || ndc.z > 1;                             // behind the camera
    if (hidden) { btnEl.style.display = 'none'; hpEl.style.display = 'none'; dotEl.style.display = 'none'; return; }
    const sx = (ndc.x * 0.5 + 0.5) * w, sy = (-ndc.y * 0.5 + 0.5) * h;

    dotEl.style.display = 'block';
    dotEl.style.left = `${sx}px`;
    dotEl.style.top = `${sy}px`;
    dotEl.classList.toggle('active', trackedCityId === id);

    // health bar: always shown once war has started, sitting under the city
    const atWar = f.targetId != null;
    if (atWar) {
      hpEl.style.display = 'block';
      hpEl.style.left = `${sx}px`;
      hpEl.style.top = `${sy}px`;
      const fill = hpEl.firstChild;
      fill.style.width = `${Math.max(0, f.health)}%`;
      fill.style.background = f.health < 35 ? '#e75555' : f.health < 70 ? '#e7b855' : '#' + f.color.getHexString();
    } else {
      hpEl.style.display = 'none';
    }

    // power buttons: only when the mouse is right over the city
    if (Math.hypot(sx - mouseX, sy - mouseY) > HOVER_RADIUS) { btnEl.style.display = 'none'; return; }
    btnEl.style.display = 'flex';
    btnEl.style.left = `${sx}px`;
    btnEl.style.top = `${sy}px`;
    const shieldBtn = btnEl.children[0], rushBtn = btnEl.children[1];
    const shieldOn = f.shieldMyr > 0;
    shieldBtn.disabled = f.shieldCooldown > 0;
    shieldBtn.classList.toggle('active', shieldOn);
    shieldBtn.title = shieldOn ? `Shielded — ${Math.ceil(f.shieldMyr)} Myr left`
      : f.shieldCooldown > 0 ? `Cooldown — ${Math.ceil(f.shieldCooldown)} Myr` : 'Grant temporary damage immunity';
    const maxedTech = f.warStage >= 3;
    rushBtn.disabled = f.techCooldown > 0 || maxedTech;
    rushBtn.title = maxedTech ? 'Already at max weapon tech'
      : f.techCooldown > 0 ? `Cooldown — ${Math.ceil(f.techCooldown)} Myr` : 'Instantly advance to the next weapon stage';
  });
}

// ── main loop ────────────────────────────────────────────────
let _frame = 0;
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  if (planet.group) {
    if (simSpeed > 0) {
      let rem = simSpeed * dt;
      while (rem > 0) { const h = Math.min(2, rem); stepSim(sim, h); rem -= h; }
    } else {
      stepSim(sim, 0);   // keep instantaneous derived (temp, glow) live while paused
    }
    planet.applyState(sim);
    if ((++_frame & 7) === 0) updateDash();   // dashboard at ~8fps — no per-frame DOM thrash
  }
  planet.spin(dt);
  comets.update(dt);

  // camera tracking: mirror the planet's spin onto the camera's orbit
  // position so a tracked city stays centered on screen — independent of
  // any drag/zoom the user does meanwhile (see the pointerdown/up listener
  // above for how tracking actually ends).
  const rotY = planet.planetMesh ? planet.planetMesh.rotation.y : 0;
  if (lastPlanetRotY != null && trackedCityId != null) {
    camera.position.applyAxisAngle(TRACK_AXIS, rotY - lastPlanetRotY);
  }
  lastPlanetRotY = rotY;

  controls.update();
  updateCityHoverUI();
  composer.render();
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth/window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  bloom.setSize(window.innerWidth/2, window.innerHeight/2);   // keep bloom at half res
});

// ── boot ─────────────────────────────────────────────────────
if (!loadFromHash()) newWorld();
