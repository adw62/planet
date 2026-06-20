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
  updateAtmosphere();
  bar('st-mag',   sim.magneticField*100, '#a8f', Math.round(sim.magneticField*100)+'%');
  bar('st-hab',   sim.habitability*100, '#6e6', Math.round(sim.habitability*100)+'%');
  const bioTxt = sim.civilization > 0.05
    ? Math.round(sim.biosphere*100)+'% · civ '+Math.round(sim.civilization*100)+'%'
    : Math.round(sim.biosphere*100)+'%';
  bar('st-bio',   sim.biosphere*100, sim.civilization > 0.05 ? '#ffd27a' : '#5cbf5c', bioTxt);
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
  controls.update();
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
