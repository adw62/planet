// ─────────────────────────────────────────────────────────────
// PlanetView — the visual body. Owns the THREE meshes (surface,
// clouds, atmosphere) and translates a simulation state vector into
// what you see: sea level, ice caps, molten glow, air haze, clouds.
//
// applyState() is called every frame but does the expensive texture
// recolor ONLY when a visible parameter actually crossed a threshold
// — the cheap per-frame work (haze opacity, cloud tint) always runs.
// ─────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { makeRng, genHeightMaps } from './noise.js';
import { renderSurfaceTextures, repaintScorch, buildNormalBase, paintNormalTexture, makeHeightTex } from './surface.js';
import { atmosphereInfo } from './sim.js';
import { FluidClouds, Aurora, GX as FGX, GY as FGY } from './fluidclouds.js';

const RADIUS = 10;
const PLANET_SPIN = 0.05;   // rad/s — shared by the surface and the cloud deck
// real geometry displacement: terrain height 0..1 → radial offset.
// peaks reach RADIUS + DISP_SCALE + DISP_BIAS; the cloud/atmosphere shells
// in fluidclouds.js sit above that so mountains don't poke through.
// Mountains are exaggerated so the tallest peaks reach the cloud shell
// (radius × CLOUD_SHELL). Cells whose terrain reaches that altitude become
// fluid obstacles, so clouds flow AROUND the peaks.
const DISP_SCALE = 1.7, DISP_BIAS = -0.5, SPHERE_SEGS = 256;
const CLOUD_SHELL = 1.07;
// fixed world-space sun direction — must match main.js's directional light
const SUN_DIR = new THREE.Vector3(8, 5, 10).normalize();
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
// war: each faction always fights its nearest living rival, fixed damage/heal
// rates (placeholders — tune freely), and a per-faction weapon stage that
// only ever advances with time (military tech, not tied to any one fight).
const WAR_CIV_THRESHOLD = 0.5;
const WAR_MAX_HEALTH = 100;
const WAR_HEAL_RATE = 1.5;          // HP / Myr, always-on regen
// stage durations are generous on purpose — tanks are meant to be the long,
// visible grind; missiles/nukes only take over once that's been watched out.
const WAR_STAGE_MYR = [0, 150, 60]; // Myr spent at stage N before advancing to N+1 (index 1,2; stage 3 is the ceiling)
// draft unit visuals: each faction dispatches ONE unit at a time toward its
// current target, travelling for `travel` Myr before delivering `dmg` on
// arrival, then sits on `cooldown` Myr before launching the next. Tanks are
// the odd one out — they're shot at en route (see TANK_HP/TANK_DEFENSE below)
// and can be destroyed before they arrive, dealing no damage, so the
// attacker has to send another. Missiles/nukes always get through.
const STAGE_KIND = [null, 'tank', 'missile', 'nuke'];
const UNIT_TRAVEL_MYR   = { missile: 5,   nuke: 6 };   // tanks travel at a constant speed instead — see TANK_SPEED
const UNIT_DAMAGE       = { tank: 10,  missile: 14,  nuke: 65 };
const UNIT_COOLDOWN_MYR = { tank: 3,   missile: 6,   nuke: 18 };
// A single warhead should read as "a real, brief cold snap" not "extinction
// event" — it's a sustained multi-nuke war that should be able to stack this
// into a true nuclear winter (see sim.js's K.dustDecay for how fast it clears
// between strikes).
const NUKE_DUST = 0.18;
const TANK_HP = 16;          // a tank destroyed mid-transit deals zero damage
const TANK_DEFENSE = 0.55;   // HP/Myr a *full-health* defender does to an inbound tank (scales down as it takes damage) — kept in proportion with TANK_SPEED below
const TANK_SPEED = 0.02;     // rad/Myr of great-circle travel — constant, so far trips take proportionally longer
const TANK_MIN_TRAVEL_MYR = 5;
// player powers: god-level intervention on a single faction, each on its own
// cooldown so they're a periodic nudge rather than a permanent win button.
const SHIELD_DURATION_MYR = 40;    // Myr of total damage immunity per activation
const SHIELD_COOLDOWN_MYR = 90;
const TECH_RUSH_COOLDOWN_MYR = 70;
const FOUND_CITIES = 9;        // cities present at founding
const RESEED_NEW_CITIES = 3;   // colonies founded once a war ends in a single survivor
const MAX_CITIES = FOUND_CITIES + RESEED_NEW_CITIES;   // hard ceiling once colonies are included
// extinction cycle: if the biosphere collapses (runaway heat/cold, a molten
// resurfacing, atmosphere stripped, etc.) and stays gone for a while, every
// city/faction is wiped — civilization can't outlive the life that built it.
// The existing founding check (civilization > 0.01 && !this._citySeeds)
// then refounds fresh cities/factions on its own once biosphere recovers
// enough for civilization to climb again, so the war cycle simply repeats.
const BIO_GONE_THRESHOLD = 0.02;   // biosphere below this counts as "no life at all"
const BIO_GONE_WIPE_MYR = 15;      // sustained Myr of bio-loss before ruins are wiped
const clamp = (x,a,b) => x<a?a:x>b?b:x;
function smooth(e0,e1,x){ const t=clamp((x-e0)/(e1-e0),0,1); return t*t*(3-2*t); }

// Damp terrain amplitude toward the poles (in place) so peaks fade to gentle
// rolling ground near the caps — avoids spiky pole mountains and the sphere's
// degenerate-pole pinch. Everything downstream reads the flattened heightmap.
function flattenPoles(hmap) {
  const S = Math.round(Math.sqrt(hmap.length));
  for (let y = 0; y < S; y++) {
    const poleD = Math.abs(y / (S - 1) - 0.5) * 2;     // 0 equator … 1 pole
    const flat = smooth(0.70, 1.0, poleD);
    if (flat <= 0) continue;
    const k = 1 - 0.985 * flat;                         // amplitude → ~1.5% at the pole
    for (let x = 0; x < S; x++) { const i = y*S + x; hmap[i] = 0.5 + (hmap[i] - 0.5) * k; }
  }
}

// Sky colors per gas (must match sim.atmosphereInfo keys) + accents.
const _GAS_COL = {
  'N₂':  new THREE.Color(0x6f8cc0),
  'CO₂': new THREE.Color(0xcda257),
  'H₂O': new THREE.Color(0xcfe6f2),
};
const _TOXIC = new THREE.Color(0x66cc22);
const _CLOUD_WHITE  = new THREE.Color(1, 1, 1);
const _CLOUD_SULFUR = new THREE.Color(0.90, 0.78, 0.52);
const _CLOUD_ASH    = new THREE.Color(0.20, 0.18, 0.17);   // nuclear-winter dust cloud tint

// Fresnel limb-glow shader for the atmosphere halo. Brightest where the
// view ray grazes the sphere's edge (the limb), brighter still on the
// day side. Thickness (power) and brightness (intensity) are driven by
// total air pressure; color by composition — so you can SEE the air.
const ATM_VERT = `
  varying vec3 vWorldNormal; varying vec3 vWorldPos;
  void main(){
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;
const ATM_FRAG = `
  uniform vec3 glowColor; uniform vec3 sunDir;
  uniform float intensity; uniform float power;
  varying vec3 vWorldNormal; varying vec3 vWorldPos;
  void main(){
    vec3 V = normalize(cameraPosition - vWorldPos);
    float rim = pow(1.0 - abs(dot(vWorldNormal, V)), power);
    float lit = 0.30 + 0.70 * clamp(dot(vWorldNormal, sunDir), 0.0, 1.0);
    gl_FragColor = vec4(glowColor, rim * intensity * lit);
  }`;

export class PlanetView {
  constructor(scene) {
    this.scene = scene;
    this.group = null;
    this.planetMesh = null;
    this.clouds = null;
    this.atmMesh = null;
    this._cache = null;          // { hmap, himap, sortedHmap }
    this._last = null;           // last-rendered visual params (throttle)
    this._lastScorch = null;
    this._diffuseCanvas = null; this._emissiveCanvas = null;
    this._baseDiffuseData = null; this._baseEmissiveData = null;
    this._type = 'rock';
    this._hue = 0.04;
    this.radius = RADIUS;
  }

  // Build a fresh terrain for `seed`, using `typeDef` as the base palette.
  build(seed, typeDef) {
    this.dispose();
    const rng = makeRng(seed);
    const { hmap, himap } = genHeightMaps(rng() * 99999);
    flattenPoles(hmap);   // damp relief toward the poles → no spiky pole mountains / pinch
    const sortedHmap = Float32Array.from(hmap).sort();
    this._cache = { hmap, himap, sortedHmap };
    this._type = typeDef.id;
    this._hue = typeDef.hue;
    this._baseShininess = typeDef.shininess;
    this._seed = seed;
    this._citySeeds = null;     // founding-city sites, picked lazily when life industrializes
    this._roadMask = null;      // road network mask, built alongside the city seeds
    this._buildingSeeds = null; // per-seed skyline, built alongside the seeds
    this._shieldMeshes = null;  // per-seed shield dome, built alongside the seeds (see shieldFaction())
    this.factions = null;       // one faction per city seed — public, read by main.js's in-world city UI
    this._lastWarAge = null;    // sim.age last seen by _updateWars, for Myr-based damage/heal
    this._reseeded = false;     // whether the post-war victor colony expansion has already run
    this._lastBioAge = null;    // sim.age last seen by _maybeWipeCivilization
    this._bioGoneMyr = 0;       // running Myr of sustained biosphere absence, while cities exist
    this._last = null;
    this._lastScorch = null;
    this._diffuseCanvas = null; this._emissiveCanvas = null;   // cached for the scorch-only fast path
    this._baseDiffuseData = null; this._baseEmissiveData = null;

    // shared draft geometry for war units + impact flashes (real meshes, not
    // instanced — at most one in-flight unit per faction, so ≤9 at a time).
    // A "tank" is a small formation of cubes (see _buildTankFormation) rather
    // than one big box — reads as a convoy instead of a single blob.
    this._tankGeo = new THREE.BoxGeometry(0.07, 0.05, 0.08);
    // cones default to apex-along-+Y; rotate -90° about X so the apex faces
    // local -Z, matching Object3D.lookAt's "-Z points at target" convention
    // (tip leads the way instead of flying tail-first).
    this._missileGeo = new THREE.ConeGeometry(0.06, 0.45, 6); this._missileGeo.rotateX(-Math.PI / 2);
    this._nukeGeo = new THREE.ConeGeometry(0.1, 0.65, 6); this._nukeGeo.rotateX(-Math.PI / 2);
    this._unitLookMat = new THREE.Matrix4();   // scratch — see _positionUnit
    this._flashGeo = new THREE.SphereGeometry(0.08, 8, 6);
    // flat ring for the shockwave part of an impact explosion — lies in its
    // local XY plane (normal = local +Z) by default, see _spawnFx's `normal` opt
    this._ringGeo = new THREE.RingGeometry(0.6, 1, 20);
    this._fx = [];   // transient impact-fx meshes, faded in real time by spin()
    this._cloudBursts = [];   // sustained nuke-cloud trickle-injections, see _updateCloudBursts

    this.group = new THREE.Group();
    this.scene.add(this.group);

    const { map } = renderSurfaceTextures(hmap, himap, {
      type: typeDef.id, hue: typeDef.hue, seaLevel: 0, surfaceTemp: 288, waterMass: 0, molten: 0,
    });
    // High-res detailed normal: computed ONCE as a static base; the ocean is
    // flattened per sea-level change by a cheap repaint (no gradient redo).
    // Displacement likewise clamps the seabed flat so the water reads smooth.
    this._dispSea = 0;
    this._normalBase = buildNormalBase(hmap, himap, typeDef.id);
    this._normalCanvas = document.createElement('canvas');
    this._normalCanvas.width = this._normalCanvas.height = this._normalBase.R;
    this._normalCtx = this._normalCanvas.getContext('2d');
    this._normalTex = new THREE.CanvasTexture(this._normalCanvas);
    paintNormalTexture(this._normalCtx, this._normalBase, 0);
    this._normalTex.needsUpdate = true;
    this._dispTex = makeHeightTex(hmap, 0);
    this.planetMesh = new THREE.Mesh(
      new THREE.SphereGeometry(RADIUS, SPHERE_SEGS, SPHERE_SEGS),
      new THREE.MeshPhongMaterial({
        map, normalMap: this._normalTex, shininess: typeDef.shininess,
        displacementMap: this._dispTex, displacementScale: DISP_SCALE, displacementBias: DISP_BIAS,
        // emissive carries BOTH lava glow and night-side city lights — keep the
        // tint white and let the emissive map supply the colour per pixel.
        emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 0,
        // ocean sun-glint: bright specular gated to water by the specular map
        specular: new THREE.Color(0x223344),
      }),
    );
    this.group.add(this.planetMesh);

    // ── atmosphere (all sim-driven) ──
    // 1. clouds — a fluid sim whose density flows AROUND the tall mountains
    this.clouds = new FluidClouds(this.group, RADIUS, this._buildCloudSolid());

    // Two shader injections into the standard Phong material:
    //  • clouds cast soft shadows (sample cloud density overhead, darken ground)
    //  • POLE DETAIL: add isotropic 3D-noise normal bumps near the poles, on land
    //    only. 3D noise is uniform over the real sphere, so it fills the washed-
    //    out caps with crisp relief that DOESN'T streak at the equirect pole.
    const cloudTex = this.clouds.tex;
    const self = this;
    const NOISE = `
      float dHash(vec3 p){ p=fract(p*0.3183099+0.1); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
      float dNoise(vec3 x){ vec3 i=floor(x),f=fract(x); f=f*f*(3.0-2.0*f);
        return mix(mix(mix(dHash(i+vec3(0,0,0)),dHash(i+vec3(1,0,0)),f.x),mix(dHash(i+vec3(0,1,0)),dHash(i+vec3(1,1,0)),f.x),f.y),
                   mix(mix(dHash(i+vec3(0,0,1)),dHash(i+vec3(1,0,1)),f.x),mix(dHash(i+vec3(0,1,1)),dHash(i+vec3(1,1,1)),f.x),f.y),f.z); }
      float dFbm(vec3 p){ float s=0.0,a=0.5; for(int k=0;k<3;k++){s+=a*dNoise(p);p*=2.03;a*=0.5;} return s; }`;
    this.planetMesh.material.onBeforeCompile = (shader) => {
      shader.uniforms.cloudTex   = { value: cloudTex };
      shader.uniforms.cloudShadow= { value: 0.78 };
      shader.uniforms.heightTex  = { value: self._dispTex };
      shader.uniforms.uSeaLevel  = { value: self._dispSea };
      shader.uniforms.uDetailFreq= { value: 2.2 };
      shader.uniforms.uDetailStr = { value: 0.9 };
      shader.uniforms.sunDirWorld= { value: SUN_DIR.clone() };
      shader.uniforms.uCityGate  = { value: 1.0 };   // 1 = gate emissive to night side (city lights), 0 = always-on (lava)
      self._planetUniforms = shader.uniforms;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vCloudUv;\nvarying vec3 vObjPos;\nvarying mat3 vObjToView;\nvarying vec3 vWorldNormal;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvCloudUv = uv;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvObjPos = position;\n\tvObjToView = mat3(modelViewMatrix);\n\tvWorldNormal = normalize(mat3(modelMatrix) * normal);');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>',
          '#include <common>\nuniform sampler2D cloudTex;uniform float cloudShadow;uniform sampler2D heightTex;uniform float uSeaLevel;uniform float uDetailFreq;uniform float uDetailStr;uniform vec3 sunDirWorld;uniform float uCityGate;\nvarying vec2 vCloudUv;varying vec3 vObjPos;varying mat3 vObjToView;varying vec3 vWorldNormal;\n' + NOISE)
        .replace('#include <map_fragment>',
          '#include <map_fragment>\n\tdiffuseColor.rgb *= 1.0 - smoothstep(0.28, 0.7, texture2D(cloudTex, vCloudUv).a) * cloudShadow;')
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          float poleD = abs(normalize(vObjPos).y);
          float mask = smoothstep(0.62, 0.88, poleD);
          float land = step(uSeaLevel + 0.012, texture2D(heightTex, vCloudUv).x);
          if (mask * land > 0.01) {
            vec3 bp = vObjPos * uDetailFreq; float e = 0.6;
            float n0 = dFbm(bp);
            vec3 g = vec3(dFbm(bp+vec3(e,0.0,0.0))-n0, dFbm(bp+vec3(0.0,e,0.0))-n0, dFbm(bp+vec3(0.0,0.0,e))-n0);
            normal = normalize(normal + vObjToView * g * (uDetailStr * mask * land));
          }
        }`)
        // city lights only glow on the night side: fade out across the
        // terminator as the geometric (world-space) normal turns toward the
        // sun. Lava glow (uCityGate = 0) is left untouched — it's hot, not lit.
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          float sunFacing = dot(normalize(vWorldNormal), sunDirWorld);
          float night = 1.0 - smoothstep(-0.05, 0.15, sunFacing);
          totalEmissiveRadiance *= mix(1.0, night, uCityGate);
        }`);
    };
    this.planetMesh.material.needsUpdate = true;

    // 2. glow — Fresnel limb halo (the unmistakable "this planet has air" cue)
    this.atmMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide,
      uniforms: {
        glowColor: { value: new THREE.Color(0x66aaff) },
        sunDir:    { value: SUN_DIR.clone() },
        intensity: { value: 0 },
        power:     { value: 4 },
      },
      vertexShader: ATM_VERT, fragmentShader: ATM_FRAG,
    });
    this.atmMesh = new THREE.Mesh(new THREE.SphereGeometry(RADIUS * 1.13, 48, 48), this.atmMat);
    this.group.add(this.atmMesh);

    // 3. aurorae — fluid curtains over the poles that flare in brief, periodic
    //    substorms when a strong dynamo meets the solar wind.
    this.aurora = new Aurora(this.group, RADIUS);
  }

  // Pick a handful of "founding city" sites on temperate lowland coasts.
  // Deterministic (from the world seed) so they're stable + reproducible from
  // a share link. Cities then nucleate and grow outward from these in the bake.
  // `avoid` (optional) steers new sites clear of every existing — living or
  // ruined — city, so a post-war reseed lands on fresh ground instead of an
  // old battlefield; `maxCount` caps how many sites this call contributes.
  _pickCitySeeds(seaLevel, avoid = null, maxCount = FOUND_CITIES) {
    const { hmap } = this._cache, S = Math.round(Math.sqrt(hmap.length));
    const rng = makeRng((this._seed | 0) ^ 0x5eed ^ (avoid ? avoid.length * 0x9e3779b1 : 0));
    const halfS = S / 2;
    const minSep = 0.2 * S, minSep2 = minSep * minSep;   // clear of any old city's urban/scorch footprint
    const avoidList = avoid ? avoid.slice() : null;
    const seeds = [];
    for (let tries = 0; tries < 6000 && seeds.length < maxCount; tries++) {
      const x = (rng() * S) | 0, y = (rng() * S) | 0;
      const h = hmap[y * S + x], lat = y / (S - 1), poleD = Math.abs(lat - 0.5) * 2;
      // habitable lowland just above the shoreline, away from the poles
      // found cities on coastal lowland (just above the shoreline), off the poles
      if (!(h > seaLevel + 0.008 && h < seaLevel + 0.09 && poleD < 0.72)) continue;
      if (avoidList && avoidList.some(s => {
        let dx = Math.abs(x - s.x); if (dx > halfS) dx = S - dx;
        const dy = y - s.y; return dx*dx + dy*dy < minSep2;
      })) continue;
      seeds.push({ x, y });
      if (avoidList) avoidList.push({ x, y });   // also keep this batch spread out from itself
    }
    return seeds;
  }

  // One faction per founding city — distinct hue (spread evenly around the
  // wheel) and a generated name, so each settlement is trackable as a
  // separate entity. Strength is filled in later by _updateBuildings, as
  // settlements grow. War state (health/target/weapon stage) starts idle
  // here and is driven each tick by _updateWars once tech allows it.
  _makeFactions(seeds) {
    const rng = makeRng((this._seed | 0) ^ 0xfac710);
    const A = ['Val','Kor','Mira','Sol','Ar','Bel','Dun','Esh','Fen','Gor','Hal','Iri','Jor','Kael','Lor','Mor','Nyx','Pyr','Rho','Sav','Tor','Ul','Vex','Wyn','Xan','Yor','Zeph'];
    const B = ['dor','ath','en','ica','heim','grad','port','wick','helm','mar','via','stan','thorpe','burg','ford','holm','ren','tu','sk','nor'];
    return seeds.map((seed, i) => {
      const hue = ((i / Math.max(1, seeds.length)) + rng() * 0.09) % 1;
      return {
        id: i,
        name: A[(rng() * A.length) | 0] + B[(rng() * B.length) | 0],
        color: new THREE.Color().setHSL(hue, 0.55, 0.56),
        strength: 0,    // 0..1, set each frame from revealed building count
        health: WAR_MAX_HEALTH,
        defeated: false,
        targetId: null, // index into this.factions of the nearest living rival
        warStage: 1,    // 1=tanks, 2=missiles, 3=nukes — only ever advances
        warTicksAtStage: 0,
        unit: null,     // in-flight tank/missile/nuke mesh + travel state, or null between launches
        cooldown: 0,    // Myr remaining before the next unit launches
        shieldMyr: 0,        // Myr of remaining damage immunity (player-triggered)
        shieldCooldown: 0,   // Myr before shield can be activated again
        techCooldown: 0,     // Myr before tech-rush can be used again
      };
    });
  }

  // Lay a road network once founding settlements exist: a minimum-spanning
  // tree of trunk roads links every city (so they're all connected without
  // redundant criss-crossing edges), plus a couple of rural spurs running
  // out from each settlement into open countryside. Every path is pulled
  // toward local low ground as it's drawn, so roads read as following
  // valleys rather than rulers. Returns a Float32Array coverage mask
  // (0..1), painted once and reused by the diffuse recolor in surface.js.
  _buildRoads(seeds, seaLevel) {
    const { hmap } = this._cache, S = Math.round(Math.sqrt(hmap.length));
    const mask = new Float32Array(S * S);
    if (!seeds.length) return mask;
    const halfS = S / 2;
    const wrapDx = (ax, bx) => { let dx = bx - ax; if (dx > halfS) dx -= S; else if (dx < -halfS) dx += S; return dx; };
    const hAt = (x, y) => {
      const xi = (((Math.round(x) % S) + S) % S), yi = Math.max(0, Math.min(S - 1, Math.round(y)));
      return hmap[yi * S + xi];
    };
    // pull a point toward the lowest ground nearby — approximates a
    // valley-seeking path without a full per-pixel pathfind
    const snapLow = (x, y, r) => {
      let bx = x, by = y, bh = hAt(x, y);
      const step = Math.max(1, r / 2);
      for (let dy = -r; dy <= r; dy += step) for (let dx = -r; dx <= r; dx += step) {
        const h = hAt(x + dx, y + dy);
        if (h < bh) { bh = h; bx = x + dx; by = y + dy; }
      }
      return { x: bx, y: by };
    };
    // thin antialiased line, wrapping in x
    const drawLine = (ax, ay, bx, by, width = 1.1) => {
      const dx = wrapDx(ax, bx), dy = by - ay;
      const steps = Math.max(1, Math.round(Math.hypot(dx, dy)));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const px = (((ax + dx * t) % S) + S) % S, py = ay + dy * t;
        const pxi = Math.round(px), pyi = Math.round(py);
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          const yy = pyi + oy; if (yy < 0 || yy >= S) continue;
          const xx = ((pxi + ox) % S + S) % S;
          const cov = Math.max(0, 1 - Math.hypot(ox, oy) / width);
          if (cov <= 0) continue;
          const idx = yy * S + xx;
          if (cov > mask[idx]) mask[idx] = cov;
        }
      }
    };
    // a chain of control points along the straight line a→b, each snapped
    // toward nearby low ground, then connected segment by segment
    const drawPath = (a, b) => {
      const dx = wrapDx(a.x, b.x), dy = b.y - a.y;
      const segs = Math.max(2, Math.round(Math.hypot(dx, dy) / (S * 0.05)));
      const pts = [{ x: a.x, y: a.y }];
      for (let i = 1; i < segs; i++) {
        const t = i / segs;
        pts.push(snapLow(a.x + dx * t, a.y + dy * t, Math.max(2, S * 0.02)));
      }
      pts.push({ x: b.x, y: b.y });
      for (let i = 1; i < pts.length; i++) drawLine(pts[i-1].x, pts[i-1].y, pts[i].x, pts[i].y);
    };

    // trunk roads: MST over the settlements (Euclidean, wrap-aware)
    if (seeds.length > 1) {
      const inTree = [0], remaining = seeds.map((_, i) => i).filter(i => i !== 0);
      while (remaining.length) {
        let bi = -1, bj = -1, bd = Infinity;
        for (const i of inTree) for (const j of remaining) {
          const ddx = wrapDx(seeds[i].x, seeds[j].x), ddy = seeds[j].y - seeds[i].y;
          const d = ddx*ddx + ddy*ddy;
          if (d < bd) { bd = d; bi = i; bj = j; }
        }
        drawPath(seeds[bi], seeds[bj]);
        inTree.push(bj);
        remaining.splice(remaining.indexOf(bj), 1);
      }
    }

    // rural spurs: a couple of dead-end roads per settlement out into the
    // countryside, also valley-seeking
    const rng = makeRng((this._seed | 0) ^ 0xc0ffee);
    for (const seed of seeds) {
      const spurs = 1 + ((rng() * 2) | 0);
      for (let n = 0; n < spurs; n++) {
        const ang = rng() * Math.PI * 2;
        const len = (0.10 + rng() * 0.10) * S;
        const end = snapLow(seed.x + Math.cos(ang) * len, seed.y + Math.sin(ang) * len, Math.max(2, S * 0.02));
        drawPath(seed, end);
      }
    }
    return mask;
  }

  // Convert a heightmap pixel to its outward (local/object-space) direction
  // on the sphere — matches the lat/lon convention already used to pick city
  // seeds (y=0 north pole) and the actual SphereGeometry UV unwrap.
  _surfaceDir(x, y, S) {
    const u = x / S, v = y / (S - 1);
    const phi = u * Math.PI * 2, theta = v * Math.PI, sinT = Math.sin(theta);
    return new THREE.Vector3(-Math.cos(phi) * sinT, Math.cos(theta), Math.sin(phi) * sinT);
  }

  // Inverse of _surfaceDir + a heightmap lookup: given a unit direction,
  // return the actual terrain radius there. Used to make war units (esp.
  // tanks) ride the real ground instead of floating at a flat offset.
  _terrainRadiusAt(dir) {
    const { hmap } = this._cache, S = Math.round(Math.sqrt(hmap.length));
    const theta = Math.acos(clamp(dir.y, -1, 1));
    const sinT = Math.sin(theta);
    let phi = sinT > 1e-6 ? Math.atan2(dir.z, -dir.x) : 0;
    if (phi < 0) phi += Math.PI * 2;
    const xi = (((Math.round((phi / (Math.PI * 2)) * S)) % S) + S) % S;
    const yi = Math.min(S - 1, Math.max(0, Math.round((theta / Math.PI) * (S - 1))));
    const h = hmap[yi * S + xi];
    return RADIUS + h * DISP_SCALE + DISP_BIAS;
  }

  // Spawn a growing skyline once a settlement electrifies: small cuboid
  // buildings packed densely around each city seed. Buildings are sorted by
  // distance from the seed and revealed closest-first as civilization
  // climbs, so the skyline reads as nucleating outward from the seed
  // rather than popping in all at once. Meshes are parented to planetMesh
  // (not group) so they spin with the terrain — see spin().
  _buildBuildings(seeds, seaLevel) {
    const { hmap } = this._cache, S = Math.round(Math.sqrt(hmap.length));
    const baseGrey = new THREE.Color(0x8d8579);
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const out = [];

    seeds.forEach((seed, idx) => {
      const rng = makeRng(((this._seed | 0) ^ 0xb1d9 ^ (seed.x * 7349 + seed.y * 911)) >>> 0);
      // tight downtown core only — well inside the urban-sprawl texture's
      // reach (surface.js urbanReach tops out at 0.12*S), so the 3D
      // buildings read as the dense center of a much larger painted sprawl.
      // Smaller footprints + more tries packs the core noticeably denser.
      const reach = 0.03 * S, maxBuildings = 44;
      const cands = [];
      for (let tries = 0; tries < 1400 && cands.length < maxBuildings; tries++) {
        const ang = rng() * Math.PI * 2;
        const rad = reach * Math.pow(rng(), 2.4);
        const x = Math.round((((seed.x + Math.cos(ang) * rad) % S) + S) % S);
        const y = Math.round(seed.y + Math.sin(ang) * rad);
        if (y < 1 || y > S - 2) continue;
        const h = hmap[y * S + x];
        const above = h - seaLevel;
        if (above < 0.006 || above > 0.30) continue;
        cands.push({ x, y, h, dist: rad });
      }
      cands.sort((a, b) => a.dist - b.dist);
      const total = cands.length;
      if (!total) { out.push(null); return; }

      // tint toward the faction's colour so each settlement's skyline is
      // visually distinct, without losing the concrete/masonry base tone
      const faction = this.factions?.[idx];
      const tint = faction ? baseGrey.clone().lerp(faction.color, 0.45) : baseGrey;
      const buildingMat = new THREE.MeshPhongMaterial({ color: tint, specular: 0x222222, shininess: 8 });
      const buildings = new THREE.InstancedMesh(boxGeo, buildingMat, total);
      buildings.count = 0;
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), qYaw = new THREE.Quaternion(), s3 = new THREE.Vector3();
      cands.forEach((c) => {
        const dir = this._surfaceDir(c.x, c.y, S);
        const r = RADIUS + c.h * DISP_SCALE + DISP_BIAS;
        const w = 0.035 + rng() * 0.07, d = 0.035 + rng() * 0.07, hgt = 0.05 + Math.pow(rng(), 1.6) * 0.22;
        q.setFromUnitVectors(Y_AXIS, dir);
        qYaw.setFromAxisAngle(Y_AXIS, rng() * Math.PI * 2);
        q.multiply(qYaw);   // yaw the building around its own up-axis, then tilt onto the surface
        const pos = dir.clone().multiplyScalar(r + hgt / 2);
        m.compose(pos, q, s3.set(w, hgt, d));
        buildings.setMatrixAt(buildings.count++, m);
      });
      buildings.instanceMatrix.needsUpdate = true;
      this.planetMesh.add(buildings);
      out.push({ buildings, total });
    });
    return out;
  }

  // A translucent blue dome over each city, large enough to bound its
  // skyline — shown only while that faction's shield power is active (see
  // shieldFaction()/f.shieldMyr). Parented to planetMesh like the
  // buildings, so it spins with the terrain instead of needing per-frame
  // repositioning. Built once per city seed; visibility/opacity toggles
  // every frame in _updateShieldDomes.
  _buildShieldDomes(seeds) {
    const { hmap } = this._cache, S = Math.round(Math.sqrt(hmap.length));
    const geo = new THREE.SphereGeometry(1.6, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2);
    return seeds.map(seed => {
      const dir = this._surfaceDir(seed.x, seed.y, S);
      const r = this._terrainRadiusAt(dir);
      const mat = new THREE.MeshBasicMaterial({
        color: 0x3aa8ff, transparent: true, opacity: 0,
        side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(dir.clone().multiplyScalar(r));
      mesh.quaternion.setFromUnitVectors(Y_AXIS, dir);
      mesh.visible = false;
      this.planetMesh.add(mesh);
      return mesh;
    });
  }

  // Per-frame: show/hide each city's shield dome and give it a faint pulse,
  // fading out as the shield's remaining duration runs low. Independent of
  // war being underway — a shield banked before war starts should still be
  // visible the instant it's activated.
  _updateShieldDomes() {
    if (!this._shieldMeshes || !this.factions) return;
    const t = performance.now();
    for (let i = 0; i < this._shieldMeshes.length; i++) {
      const mesh = this._shieldMeshes[i], f = this.factions[i];
      const on = f && !f.defeated && f.shieldMyr > 0;
      mesh.visible = on;
      if (on) {
        const frac = Math.min(1, f.shieldMyr / SHIELD_DURATION_MYR);
        mesh.material.opacity = 0.14 + 0.10 * frac + 0.04 * Math.sin(t * 0.005);
      }
    }
  }

  // Per-frame: grow the visible building count outward from each seed as
  // civilization climbs (matches the urban-core reveal in surface.js),
  // refresh each faction's strength reading, and — once war is underway —
  // let war damage knock the skyline back down (the farthest-out, most
  // recently-built instances disappear first, since `cands` is sorted
  // nearest-first). Scorched ground is painted into the actual surface
  // texture instead (see applyState's scorchVec / surface.js's `scorch`
  // composite step) so war damage marks the terrain itself, not a decal.
  _updateBuildings(s) {
    if (!this._buildingSeeds) return;
    const stage = smooth(0.4, 0.9, s.civilization);
    this._buildingSeeds.forEach((e, idx) => {
      const faction = this.factions?.[idx];
      if (!e) { if (faction) faction.strength = 0; return; }
      const healthFrac = faction ? faction.health / WAR_MAX_HEALTH : 1;
      e.buildings.count = Math.round(e.total * stage * healthFrac);
      if (faction) faction.strength = e.total ? e.buildings.count / e.total : 0;
    });
  }

  // Per-frame: run the war between founding cities, once tech allows it.
  // Every living faction always targets its nearest living rival (recomputed
  // here every call — O(n²) over at most 9 factions, trivial). Each
  // attacker's weapon stage only ever advances with elapsed war-time
  // (military tech, independent of any one fight, so it never resets when a
  // target dies and a faction moves on to its next-nearest rival). Damage
  // is no longer an abstract rate: each faction dispatches one physical
  // unit at a time (see _launchUnit/_positionUnit below) that travels from
  // its city to the target's and delivers its damage on arrival. Healing
  // still applies continuously. All of it ticks on sim-time (s.age), not
  // wall-clock frames.
  _updateWars(s) {
    if (!this.factions || !this._citySeeds) return;
    const dtMyr = this._lastWarAge == null ? 0 : Math.max(0, s.age - this._lastWarAge);
    this._lastWarAge = s.age;
    // Below the threshold, no NEW fighting starts (weapon tech freezes, no
    // fresh launches) — but a unit already in flight from an earlier,
    // higher-civilization tick must keep flying rather than freezing
    // mid-air: a transient habitability/civilization dip (e.g. a nuke's own
    // dust knocking civilization down) shouldn't leave missiles paused.
    const warAllowed = s.civilization >= WAR_CIV_THRESHOLD;

    const { hmap } = this._cache, S = Math.round(Math.sqrt(hmap.length)), halfS = S / 2;
    const wrapDx = (ax, bx) => { let dx = bx - ax; if (dx > halfS) dx -= S; else if (dx < -halfS) dx += S; return dx; };
    const dist2 = (a, b) => { const dx = wrapDx(a.x, b.x), dy = b.y - a.y; return dx*dx + dy*dy; };
    const seeds = this._citySeeds, factions = this.factions;

    // retarget: nearest living rival, every tick (cheap, and instantly
    // reassigns anyone whose target was just defeated). If a faction's
    // target changes mid-flight (its old target died), abort the unit
    // already en route to it — it has nowhere left to go. `passive`
    // factions are colonies founded by an outright war victor (see
    // _maybeReseedVictor) — they belong to the same side as everyone else
    // still standing, so they never fight and are never targeted.
    factions.forEach((f, i) => {
      if (f.defeated || f.passive) { f.targetId = null; return; }
      let best = -1, bd = Infinity;
      factions.forEach((g, j) => {
        if (j === i || g.defeated || g.passive) return;
        const d = dist2(seeds[i], seeds[j]);
        if (d < bd) { bd = d; best = j; }
      });
      const newTarget = best === -1 ? null : best;
      if (f.unit && f.targetId !== newTarget) this._killUnit(f, false);
      f.targetId = newTarget;
    });

    if (dtMyr <= 0) return;

    // weapon tech only ever advances, independent of the current fight —
    // but only while war is actually allowed (see warAllowed above)
    if (warAllowed) {
      for (const f of factions) {
        if (f.defeated || f.passive || f.warStage >= 3) continue;
        f.warTicksAtStage += dtMyr;
        if (f.warTicksAtStage >= WAR_STAGE_MYR[f.warStage]) { f.warStage++; f.warTicksAtStage = 0; }
      }
    }

    // player powers: count down shield duration + both abilities' cooldowns
    for (const f of factions) {
      if (f.shieldMyr > 0) f.shieldMyr = Math.max(0, f.shieldMyr - dtMyr);
      if (f.shieldCooldown > 0) f.shieldCooldown = Math.max(0, f.shieldCooldown - dtMyr);
      if (f.techCooldown > 0) f.techCooldown = Math.max(0, f.techCooldown - dtMyr);
    }

    // passive heal first, so a kill landing this same tick can't be
    // undone by that tick's own regen
    for (const f of factions) {
      if (!f.defeated) f.health = Math.min(WAR_MAX_HEALTH, f.health + WAR_HEAL_RATE * dtMyr);
    }

    // dispatch / advance each faction's single outbound unit
    for (let i = 0; i < factions.length; i++) {
      const f = factions[i];
      if (f.defeated || f.targetId == null) { if (f.unit) this._killUnit(f, false); continue; }
      const target = factions[f.targetId];

      if (!f.unit) {
        f.cooldown = Math.max(0, f.cooldown - dtMyr);
        if (warAllowed && f.cooldown <= 0) this._launchUnit(f, i, f.targetId, seeds, S);
        continue;
      }

      const u = f.unit;
      u.traveled += dtMyr;
      if (u.kind === 'tank') {
        // the defender shoots back at inbound tanks; a weakened defender
        // puts up proportionally less flak, so tanks get through more
        // often the closer the target already is to falling
        u.hp -= TANK_DEFENSE * (target.health / WAR_MAX_HEALTH) * dtMyr;
        if (u.hp <= 0) { this._killUnit(f, true); f.cooldown = UNIT_COOLDOWN_MYR.tank; continue; }
      }
      if (u.traveled >= u.travelMyr) {
        if (target.shieldMyr <= 0) target.health = Math.max(0, target.health - UNIT_DAMAGE[u.kind]);
        const color = u.kind === 'nuke' ? 0xff5533 : f.color;
        this._spawnExplosion(u.mesh.position, u.kind, color);
        if (u.kind === 'nuke') {
          this._spawnMushroomCloud(seeds[u.toIdx], S);
          s.dust = clamp(s.dust + NUKE_DUST, 0, 1);
        }
        f.cooldown = UNIT_COOLDOWN_MYR[u.kind];
        this._removeUnitMesh(f);
        if (target.health <= 0) {
          target.health = 0; target.defeated = true; target.targetId = null;
          if (target.unit) this._killUnit(target, false);
        }
      } else {
        this._positionUnit(f, seeds, S);
      }
    }
  }

  // Once a war between MULTIPLE founding cities ends with exactly one
  // faction left standing, that victor expands: a few new colonies are
  // founded elsewhere on the planet (clear of every existing — living or
  // ruined — city site, see _pickCitySeeds' `avoid`), painted in the
  // victor's own colour. They're marked `passive` so _updateWars never lets
  // them fight or be targeted — there's no one left to start a new war with,
  // and reseeding shouldn't manufacture one. Runs at most once per world.
  _maybeReseedVictor(seaLevel) {
    if (this._reseeded || !this.factions || this.factions.length < 2) return;
    const living = this.factions.filter(f => f && !f.defeated && !f.passive);
    if (living.length !== 1) return;
    this._reseeded = true;

    const newCount = Math.min(RESEED_NEW_CITIES, MAX_CITIES - this._citySeeds.length);
    if (newCount <= 0) return;
    const newSeeds = this._pickCitySeeds(seaLevel, this._citySeeds, newCount);
    if (!newSeeds.length) return;

    const winner = living[0];
    this._citySeeds = this._citySeeds.concat(newSeeds);
    for (let k = 0; k < newSeeds.length; k++) {
      this.factions.push({
        id: this.factions.length,
        name: winner.name,
        color: winner.color.clone(),
        strength: 0,
        health: WAR_MAX_HEALTH,
        defeated: false,
        passive: true,      // belongs to the victor outright — see _updateWars
        targetId: null,
        warStage: winner.warStage,
        warTicksAtStage: 0,
        unit: null,
        cooldown: 0,
        shieldMyr: 0,
        shieldCooldown: 0,
        techCooldown: 0,
      });
    }

    // rebuild roads/buildings/domes over the full, now-larger city list —
    // a one-time cost paid once per world, same as the original founding
    this._roadMask = this._buildRoads(this._citySeeds, seaLevel);
    this._disposeCityProps();
    this._buildingSeeds = this._buildBuildings(this._citySeeds, seaLevel);
    this._shieldMeshes = this._buildShieldDomes(this._citySeeds);
    this._last = null;   // force a full recolor — new urban footprint to paint
  }

  // Remove + dispose the InstancedMesh buildings and shield-dome meshes
  // built by _buildBuildings/_buildShieldDomes, ahead of rebuilding them
  // (each call creates its own fresh shared geometry — see those methods).
  _disposeCityProps() {
    if (this._buildingSeeds) {
      let geo = null;
      for (const e of this._buildingSeeds) {
        if (!e) continue;
        this.planetMesh.remove(e.buildings);
        e.buildings.material.dispose();
        geo = e.buildings.geometry;
      }
      geo?.dispose();
    }
    if (this._shieldMeshes?.length) {
      for (const mesh of this._shieldMeshes) {
        this.planetMesh.remove(mesh);
        mesh.material.dispose();
      }
      this._shieldMeshes[0].geometry.dispose();
    }
  }

  // Tracks how long the biosphere has been completely gone while cities
  // still stand, and wipes them once that's gone on "for some time" (see
  // BIO_GONE_WIPE_MYR) rather than on a single bad tick — a transient dip
  // (e.g. a passing impact) shouldn't erase a civilization outright. Ticks
  // independently of _updateWars/_maybeReseedVictor so it still runs (and
  // can still wipe) even before war or post-war colonies ever come up.
  _maybeWipeCivilization(s) {
    if (!this._citySeeds) { this._lastBioAge = null; this._bioGoneMyr = 0; return; }
    const dtMyr = this._lastBioAge == null ? 0 : Math.max(0, s.age - this._lastBioAge);
    this._lastBioAge = s.age;
    if (s.biosphere >= BIO_GONE_THRESHOLD) { this._bioGoneMyr = 0; return; }
    this._bioGoneMyr += dtMyr;
    if (this._bioGoneMyr >= BIO_GONE_WIPE_MYR) this._wipeCivilization();
  }

  // Erase every city/faction/road/building/shield/unit — the planet reverts
  // to bare terrain, exactly as if civilization had never industrialized.
  // The founding check in applyState (civilization > 0.01 && !this._citySeeds)
  // then refounds a fresh set of cities/factions on its own once biosphere
  // recovers enough for civilization to climb again, so the war cycle repeats.
  _wipeCivilization() {
    if (this.factions) for (const f of this.factions) this._killUnit(f, false);
    this._disposeCityProps();
    this._citySeeds = null;
    this._roadMask = null;
    this._buildingSeeds = null;
    this._shieldMeshes = null;
    this.factions = null;
    this._reseeded = false;
    this._lastWarAge = null;
    this._bioGoneMyr = 0;
    this._last = null;   // force a full recolor — wipe the urban footprint off the surface
  }

  // Player powers, both triggered from the in-world hover UI over a city
  // (see main.js). Shield grants a living faction temporary full immunity to
  // incoming unit damage (see the `target.shieldMyr` check above); tech-rush
  // instantly advances its weapon stage instead of waiting out WAR_STAGE_MYR.
  // Each reports whether it actually fired, so the UI can tell a no-op click
  // from a real one.
  shieldFaction(id) {
    const f = this.factions?.[id];
    if (!f || f.defeated || f.shieldCooldown > 0) return false;
    f.shieldMyr = SHIELD_DURATION_MYR;
    f.shieldCooldown = SHIELD_COOLDOWN_MYR;
    return true;
  }

  rushTech(id) {
    const f = this.factions?.[id];
    if (!f || f.defeated || f.techCooldown > 0 || f.warStage >= 3) return false;
    f.warStage++;
    f.warTicksAtStage = 0;
    f.techCooldown = TECH_RUSH_COOLDOWN_MYR;
    return true;
  }

  // Each living city's current world-space position + outward normal
  // (accounting for the planet's ongoing spin), for main.js to project to
  // screen space and decide which city the mouse is hovering near. Normal
  // lets the caller cull cities currently spun around to the far side.
  getCityWorldPositions() {
    if (!this._citySeeds) return [];
    const S = Math.round(Math.sqrt(this._cache.hmap.length));
    this.planetMesh.updateMatrixWorld();
    return this._citySeeds.map(seed => {
      const dir = this._surfaceDir(seed.x, seed.y, S);
      const r = this._terrainRadiusAt(dir);
      const pos = dir.clone().multiplyScalar(r).applyMatrix4(this.planetMesh.matrixWorld);
      const normal = dir.clone().transformDirection(this.planetMesh.matrixWorld);
      return { pos, normal };
    });
  }

  // Launch a fresh unit (tank/missile/nuke per the attacker's current
  // warStage) from faction `f`'s city toward `toIdx`'s city. Tanks travel at
  // a constant speed, so their duration scales with the actual great-circle
  // distance; missiles/nukes keep a flat travel time (they're fast enough
  // that distance doesn't read as strongly either way).
  _launchUnit(f, fromIdx, toIdx, seeds, S) {
    const kind = STAGE_KIND[f.warStage];
    const mat = new THREE.MeshBasicMaterial({ color: kind === 'nuke' ? 0xff5533 : f.color });
    let mesh, travelMyr;
    if (kind === 'tank') {
      const a = this._surfaceDir(seeds[fromIdx].x, seeds[fromIdx].y, S);
      const b = this._surfaceDir(seeds[toIdx].x, seeds[toIdx].y, S);
      travelMyr = Math.max(TANK_MIN_TRAVEL_MYR, a.angleTo(b) / TANK_SPEED);
      mesh = this._buildTankFormation(mat);
    } else {
      travelMyr = UNIT_TRAVEL_MYR[kind];
      mesh = new THREE.Mesh(kind === 'missile' ? this._missileGeo : this._nukeGeo, mat);
    }
    this.planetMesh.add(mesh);
    f.unit = { kind, mesh, material: mat, traveled: 0, travelMyr, hp: kind === 'tank' ? TANK_HP : Infinity, fromIdx, toIdx };
    this._positionUnit(f, seeds, S);
  }

  // A tank "unit" is a loose, fanned-out cluster of small cubes (sharing one
  // geometry + one material) rather than a single box — reads as a scattered
  // formation, not a blob.
  _buildTankFormation(mat) {
    const group = new THREE.Group();
    const offsets = [
      [0, 0.015, 0.3], [-0.28, -0.01, 0.1], [0.3, 0.02, 0.04],
      [-0.2, 0, -0.26], [0.24, -0.015, -0.22], [0.02, 0.01, -0.4],
    ];
    offsets.forEach(([x, y, z]) => {
      const cube = new THREE.Mesh(this._tankGeo, mat);
      cube.position.set(x, y, z);
      group.add(cube);
    });
    return group;
  }

  // Place + orient an in-flight unit along the great-circle path between its
  // origin and target cities. The base radius follows the real terrain
  // height underneath (via _terrainRadiusAt) plus a small clearance, so
  // tanks actually climb and dip with the ground instead of floating at a
  // flat offset; missiles/nukes add a shallow arc on top of that same
  // ground-following base so they still clear hills along the way.
  _positionUnit(f, seeds, S) {
    const u = f.unit;
    const a = this._surfaceDir(seeds[u.fromIdx].x, seeds[u.fromIdx].y, S);
    const b = this._surfaceDir(seeds[u.toIdx].x, seeds[u.toIdx].y, S);
    const clearance = u.kind === 'tank' ? 0.03 : 0.05;
    const arcPeak = u.kind === 'tank' ? 0 : (u.kind === 'nuke' ? 1.5 : 1.0);
    const at = (t) => {
      const dir = a.clone().lerp(b, clamp(t, 0, 1)).normalize();
      const r = this._terrainRadiusAt(dir) + clearance + arcPeak * Math.sin(clamp(t, 0, 1) * Math.PI);
      return { dir, pos: dir.clone().multiplyScalar(r) };
    };
    const t = u.traveled / u.travelMyr;
    const here = at(t), ahead = at(t + 0.01);
    u.mesh.position.copy(here.pos);
    // Object3D.lookAt() treats its argument as a WORLD-space point on any
    // object with a parent (it reads the mesh's true world position
    // internally) — but here.pos/ahead.pos are in planetMesh's LOCAL space,
    // so calling u.mesh.lookAt(ahead.pos) mixed local and world frames and
    // the resulting heading drifted further off the real flight path the
    // more the planet had spun. Build the look rotation directly in local
    // space instead, so it tracks the actual ballistic arc tangent.
    this._unitLookMat.lookAt(here.pos, ahead.pos, here.dir);
    u.mesh.quaternion.setFromRotationMatrix(this._unitLookMat);
  }

  // Remove a unit, optionally with a small "destroyed in transit" puff
  // (tanks shot down by the defender before arriving — see _updateWars).
  _killUnit(f, destroyedInCombat) {
    if (!f.unit) return;
    if (destroyedInCombat) this._spawnFlash(f.unit.mesh.position, 0x888888, 0.22);
    this._removeUnitMesh(f);
  }

  _removeUnitMesh(f) {
    if (!f.unit) return;
    this.planetMesh.remove(f.unit.mesh);
    f.unit.material.dispose();   // single shared material — tank formations share one across all their cubes
    f.unit = null;
  }

  // Generic transient FX mesh: grows by `growth`x and fades to 0 opacity over
  // `life` seconds (real time, decoupled from sim-speed so it always reads as
  // a snappy burst). `normal`, if given, orients a flat geometry (e.g. the
  // shockwave ring, which lies in its local XY plane) so it hugs the surface
  // at `pos` instead of facing a fixed world direction.
  _spawnFx(geo, pos, color, { scale = 1, life = 0.45, growth = 2.2, opacity = 0.9, additive = true, normal = null } = {}) {
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pos);
    if (normal) mesh.quaternion.setFromUnitVectors(Z_AXIS, normal);
    mesh.scale.setScalar(scale);
    this.planetMesh.add(mesh);
    this._fx.push({ mesh, life, maxLife: life, baseScale: scale, growth, maxOpacity: opacity });
  }

  // Quick additive flash — kept as a thin wrapper since a couple of call
  // sites (e.g. a tank shot down in transit) just want a single small puff.
  _spawnFlash(pos, color, scale) {
    this._spawnFx(this._flashGeo, pos, color, { scale, life: 0.45, growth: 2.2, opacity: 0.9 });
  }

  // Fuller impact explosion: a white-hot core, a colored burst, and an
  // expanding shockwave ring hugging the terrain; nukes additionally get a
  // dark, slow-fading smoke puff (separate from the atmospheric mushroom
  // cloud spawned into the fluid sim — see _spawnMushroomCloud).
  _spawnExplosion(pos, kind, color) {
    const dir = pos.clone().normalize();
    const big = kind === 'nuke' ? 1.6 : kind === 'missile' ? 1.0 : 0.7;
    this._spawnFx(this._flashGeo, pos, 0xfff4d0, { scale: 0.4 * big, life: 0.22, growth: 1.6, opacity: 1 });
    this._spawnFx(this._flashGeo, pos, color, { scale: 0.55 * big, life: 0.5, growth: 2.4, opacity: 0.85 });
    this._spawnFx(this._ringGeo, pos, color, { scale: 0.3 * big, life: 0.6, growth: 5, opacity: 0.6, normal: dir });
    if (kind === 'nuke') {
      this._spawnFx(this._flashGeo, pos, 0x554a40, { scale: 0.5 * big, life: 1.6, growth: 3.2, opacity: 0.55, additive: false });
    }
  }

  // Inject density into the live cloud fluid sim at the impact site so a
  // nuke leaves a real, drifting cloud instead of just a local particle
  // effect. The sim's ambient dissipation decays density exponentially each
  // tick, so a single one-shot burst would flash and vanish almost
  // immediately regardless of how much mass we inject — instead we queue a
  // sustained trickle (see _updateCloudBursts) that keeps topping up the
  // same spot for several seconds, fading out as it goes.
  _spawnMushroomCloud(seed, S) {
    if (!this.clouds) return;
    this.clouds.spawnBurst(seed.x / S, seed.y / S, 2.2, 3);
    this._cloudBursts.push({ u: seed.x / S, v: seed.y / S, life: 7, maxLife: 7 });
  }

  // Real-time (not sim-speed-scaled) top-up of nuke clouds queued by
  // _spawnMushroomCloud — keeps re-injecting a shrinking trickle of density
  // at each burst site so the cloud lingers and fades gradually instead of
  // the ambient dissipation eating a single injection within a second.
  _updateCloudBursts(dt) {
    if (!this._cloudBursts.length || !this.clouds) return;
    const RATE = 0.85;
    for (let i = this._cloudBursts.length - 1; i >= 0; i--) {
      const b = this._cloudBursts[i];
      const amt = RATE * (b.life / b.maxLife) * dt;
      this.clouds.spawnBurst(b.u, b.v, amt, 3);
      b.life -= dt;
      if (b.life <= 0) this._cloudBursts.splice(i, 1);
    }
  }

  _updateWarFx(dt) {
    if (!this._fx.length) return;
    for (let i = this._fx.length - 1; i >= 0; i--) {
      const fx = this._fx[i];
      fx.life -= dt;
      const k = Math.max(0, fx.life / fx.maxLife);
      fx.mesh.scale.setScalar(fx.baseScale * (1 + (1 - k) * fx.growth));
      fx.mesh.material.opacity = k * fx.maxOpacity;
      if (fx.life <= 0) {
        this.planetMesh.remove(fx.mesh);
        fx.mesh.material.dispose();
        this._fx.splice(i, 1);
      }
    }
  }

  // Build the cloud obstacle mask: downsample the heightmap to the fluid grid
  // (taking the MAX height per cell so one peak blocks it), then mark the
  // tallest ~10% of cells (the mountain ranges) as solid so clouds divert
  // around them. A percentile keeps the effect visible on every world.
  _buildCloudSolid() {
    const { hmap } = this._cache, S = Math.round(Math.sqrt(hmap.length));
    const cell = new Float32Array(FGX * FGY);
    for (let j = 0; j < FGY; j++) {
      const poleD = Math.abs((j + 0.5) / FGY - 0.5) * 2;
      if (poleD > 0.82) continue;                          // never obstruct clouds at the poles
      const y0 = (j / FGY * S) | 0, y1 = Math.max(y0 + 1, ((j + 1) / FGY * S) | 0);
      for (let i = 0; i < FGX; i++) {
        const x0 = (i / FGX * S) | 0, x1 = Math.max(x0 + 1, ((i + 1) / FGX * S) | 0);
        let mx = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const h = hmap[y*S+x]; if (h > mx) mx = h; }
        cell[i + j * FGX] = mx;
      }
    }
    const thresh = Float32Array.from(cell).sort()[Math.floor(cell.length * 0.90)];
    const solid = new Float32Array(FGX * FGY);
    for (let i = 0; i < cell.length; i++) solid[i] = cell[i] >= thresh ? 1 : 0;
    return solid;
  }

  // Map an oceanCoverage fraction (0..1) to a height threshold on THIS
  // planet's own terrain, so "30% ocean" always floods 30% of the surface.
  _seaHeightForFraction(frac) {
    const a = this._cache.sortedHmap;
    if (!a || frac <= 0) return 0;
    return a[Math.min(a.length - 1, Math.floor(frac * a.length))];
  }

  // Update all visuals from the simulation state.
  applyState(s) {
    if (!this.group) return;

    // ── derive visual parameters from sim ──
    const seaLevel = this._seaHeightForFraction(s.oceanCoverage);
    const molten = s.molten;

    // extinction: wipe any standing cities/factions once the biosphere has
    // been gone long enough — runs before the founding check below so a
    // recovering planet can refound fresh civilizations in the same pass.
    this._maybeWipeCivilization(s);

    // war damage chars the ground around a city — tracked per faction/seed
    // (same index as this._citySeeds) and baked into the diffuse/emissive
    // textures by surface.js's scorch overlay, applied separately from the
    // structural recolor below (see the scorchChanged-only branch) so combat
    // hits don't force a full S×S recolor every time.
    const scorchVec = this.factions
      ? this.factions.map(f => f ? Math.min(1, Math.max(0, 1 - f.health / WAR_MAX_HEALTH)) : 0)
      : [];

    // ── throttle the expensive recolor ── (snow is now temperature-driven, so
    // track surfaceTemp instead of a snowline)
    const v = { seaLevel, surfaceTemp: s.surfaceTemp, waterMass: s.waterMass, molten,
                biosphere: s.biosphere, civilization: s.civilization };
    const L = this._last;
    const LS = this._lastScorch;
    const scorchChanged = !LS || LS.length !== scorchVec.length ||
      scorchVec.some((sv, i) => Math.abs(sv - LS[i]) > 0.05);
    const changed = !L ||
      Math.abs(L.seaLevel - seaLevel)            > 0.006 ||
      Math.abs(L.surfaceTemp - s.surfaceTemp)    > 1.5 ||
      Math.abs(L.waterMass - s.waterMass)        > 0.02 ||
      Math.abs(L.molten - molten)                > 0.02 ||
      Math.abs(L.biosphere - s.biosphere)        > 0.02 ||
      Math.abs(L.civilization - s.civilization)  > 0.02;

    // founding cities: pick stable seed sites the first time life industrializes,
    // and force an immediate recolor so the city emissive map exists before the
    // glow ramps up (otherwise the bare emissive colour flashes the whole globe).
    // Also gated on biosphere, not just civilization — civilization decays
    // slower than biosphere as a world dies off (see _maybeWipeCivilization),
    // so right after a wipe it can still be transiently > 0.01; without the
    // biosphere check that re-founds cities in the very same tick they were
    // wiped, undoing the wipe.
    if (s.civilization > 0.01 && s.biosphere >= BIO_GONE_THRESHOLD && !this._citySeeds) {
      this._citySeeds = this._pickCitySeeds(seaLevel);
      this.factions = this._makeFactions(this._citySeeds);
      this._roadMask = this._buildRoads(this._citySeeds, seaLevel);
      this._buildingSeeds = this._buildBuildings(this._citySeeds, seaLevel);
      this._shieldMeshes = this._buildShieldDomes(this._citySeeds);
      this._last = null;
    }

    // keep the displaced seabed AND its shading flat to the (moving) sea surface
    if (Math.abs(seaLevel - this._dispSea) > 0.012) {
      const oldDisp = this._dispTex;
      this._dispTex = makeHeightTex(this._cache.hmap, seaLevel);
      this.planetMesh.material.displacementMap = this._dispTex;
      oldDisp?.dispose();
      paintNormalTexture(this._normalCtx, this._normalBase, seaLevel);  // cheap ocean re-flatten
      this._normalTex.needsUpdate = true;
      this._dispSea = seaLevel;
      if (this._planetUniforms) {                       // keep the pole-detail land mask in sync
        this._planetUniforms.heightTex.value = this._dispTex;
        this._planetUniforms.uSeaLevel.value = seaLevel;
      }
    }

    if (changed || !this._diffuseCanvas) {
      // full recolor: structural state moved (sea level, climate, biosphere,
      // civilization) — redo all three S×S passes, and stash the pre-scorch
      // pixel data + live canvases so a later scorch-only change (below) can
      // skip straight to the cheap path.
      const m = this.planetMesh.material;
      const oldMap = m.map, oldEm = m.emissiveMap, oldSp = m.specularMap;
      const { map, emissiveMap, specularMap, diffuseCanvas, emissiveCanvas, baseDiffuseData, baseEmissiveData } =
        renderSurfaceTextures(this._cache.hmap, this._cache.himap, {
          type: this._type, hue: this._hue, seaLevel, surfaceTemp: s.surfaceTemp, waterMass: s.waterMass, molten,
          biosphere: s.biosphere, civilization: s.civilization, citySeeds: this._citySeeds,
          roadMask: this._roadMask, scorch: scorchVec,
        });
      m.map = map;   // normalMap is static (set once in build) — never re-touched here
      m.emissiveMap = emissiveMap || null;
      m.specularMap = specularMap || null;
      m.shininess = specularMap ? 60 : this._baseShininess;
      m.needsUpdate = true;
      oldMap?.dispose(); oldEm?.dispose(); oldSp?.dispose();
      this._diffuseCanvas = diffuseCanvas; this._emissiveCanvas = emissiveCanvas;
      this._baseDiffuseData = baseDiffuseData; this._baseEmissiveData = baseEmissiveData;
      this._last = v;
      this._lastScorch = scorchVec;
    } else if (scorchChanged) {
      // war damage only: repaint just the scorched cities' footprints from
      // the cached pre-scorch pixels — no S×S recompute, no per-pixel
      // nearest-city search. Same canvases/textures, just new pixels + a
      // GPU re-upload (needsUpdate), so this is cheap enough to run on
      // every combat tick during a sustained war.
      const m = this.planetMesh.material;
      repaintScorch(this._diffuseCanvas, this._emissiveCanvas, this._baseDiffuseData, this._baseEmissiveData,
        this._cache.hmap, { seaLevel, civilization: s.civilization, molten, citySeeds: this._citySeeds, scorch: scorchVec });
      m.map.needsUpdate = true;
      if (m.emissiveMap) m.emissiveMap.needsUpdate = true;
      this._lastScorch = scorchVec;
    }

    // ── cheap per-frame: glow + city lights ──
    // emissive drives lava glow (red, pulsing) OR city lights (gold). Gate on
    // the emissive MAP existing so the bare emissive colour never lights the
    // whole globe; city brightness fades in with civilization (no pop-in flash).
    const m = this.planetMesh.material;
    m.emissiveIntensity = !m.emissiveMap ? 0
      : molten > 0.01 ? 0.6 + molten * 1.2 + Math.sin(performance.now() * 0.002) * 0.2 * molten
      : smooth(0.4, 0.9, s.civilization) * (1.0 + Math.sin(performance.now() * 0.0017) * 0.12);
    if (this._planetUniforms) this._planetUniforms.uCityGate.value = molten > 0.01 ? 0.0 : 1.0;
    this._updateBuildings(s);
    this._updateWars(s);
    this._maybeReseedVictor(seaLevel);
    this._updateShieldDomes();

    // aurorae: capacity = dynamo strength × solar wind × enough air to glow;
    // the Aurora itself decides when to flare (substorms).
    const auroraI = clamp(s.magneticField * smooth(0.6, 2.2, s.solarFlux) * smooth(0.15, 1.0, s.atmosphere), 0, 1);
    this.aurora.setActivity(auroraI);

    this._applyAtmosphere(s);
  }

  // Render the air: a composition-tinted limb glow, a surface-obscuring
  // haze that scales with pressure, and clouds whose color/cover depend
  // on what the atmosphere is made of (water → white, CO2/sulfur → tan).
  _applyAtmosphere(s) {
    const comp = atmosphereInfo(s);

    // composition-weighted color (what the sky "is")
    const sky = new THREE.Color(0, 0, 0);
    for (const g of comp.gases) sky.add(_GAS_COL[g.key].clone().multiplyScalar(g.frac));
    if (this._type === 'toxic') sky.lerp(_TOXIC, 0.6);   // toxic biome bleeds into the air

    // 1. limb glow — EXAGGERATED so even a thin atmosphere reads clearly.
    //    Brightness ramps fast off zero; band stays wide (low power).
    this.atmMat.uniforms.glowColor.value.copy(sky);
    this.atmMat.uniforms.intensity.value = clamp(0.18 + 0.42 * Math.log(1 + comp.total), 0.0, 1.4)
      * smooth(0.12, 0.4, comp.total);   // fade to nothing when truly airless
    this.atmMat.uniforms.power.value = clamp(4.2 - comp.total * 0.7, 1.6, 4.2);

    // 2. clouds — coverage from humidity (ocean evaporation + vapor) and thick
    //    CO2, but GATED by how much atmosphere there is: clouds can't exist
    //    without air to hold them. Strip the atmosphere (kill the dynamo →
    //    escape) and the deck thins out and disappears; a near-vacuum is clear.
    const air = smooth(0.05, 0.9, comp.total);   // 0 at vacuum → 1 once there's real air
    const humidity = clamp(s.oceanCoverage * 0.95 + s.waterVapor * 1.3, 0, 1);
    const sulfur   = clamp(smooth(2.5, 8, s.co2), 0, 0.95);
    const cover    = clamp(Math.max(humidity * 0.95, sulfur, s.dust * 0.9) * air, 0, 0.95);
    const cloudColor = (this._type === 'toxic' ? _TOXIC
      : sulfur > humidity * 0.95 ? _CLOUD_SULFUR : _CLOUD_WHITE).clone();
    // nuclear winter: dust darkens the deck toward ash instead of brightening it
    if (s.dust > 0.01) cloudColor.lerp(_CLOUD_ASH, clamp(s.dust * 1.2, 0, 0.9));
    // hotter climates drive more energetic weather → faster winds
    const windScale = clamp(0.55 + smooth(230, 400, s.surfaceTemp) * 1.5, 0.55, 2.2);
    this.clouds.setTarget(cover, cloudColor, windScale);
  }

  // per-frame motion (called from the main loop)
  spin(dt) {
    if (!this.group) return;
    this.planetMesh.rotation.y += dt * PLANET_SPIN;
    this.clouds.update(dt);
    if (this.aurora) this.aurora.update(dt);
    this._updateWarFx(dt);
    this._updateCloudBursts(dt);
  }

  dispose() {
    if (!this.group) return;
    this.group.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
        m.map?.dispose(); m.normalMap?.dispose(); m.emissiveMap?.dispose();
        m.specularMap?.dispose(); m.displacementMap?.dispose(); m.dispose();
      });
    });
    this.scene.remove(this.group);
    this.group = this.planetMesh = this.clouds = this.atmMesh = null;
  }
}
