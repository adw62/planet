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
import { renderSurfaceTextures, buildNormalBase, paintNormalTexture, makeHeightTex } from './surface.js';
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
    this._last = null;

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
      self._planetUniforms = shader.uniforms;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vCloudUv;\nvarying vec3 vObjPos;\nvarying mat3 vObjToView;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvCloudUv = uv;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvObjPos = position;\n\tvObjToView = mat3(modelViewMatrix);');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>',
          '#include <common>\nuniform sampler2D cloudTex;uniform float cloudShadow;uniform sampler2D heightTex;uniform float uSeaLevel;uniform float uDetailFreq;uniform float uDetailStr;\nvarying vec2 vCloudUv;varying vec3 vObjPos;varying mat3 vObjToView;\n' + NOISE)
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
        }`);
    };
    this.planetMesh.material.needsUpdate = true;

    // 2. glow — Fresnel limb halo (the unmistakable "this planet has air" cue)
    this.atmMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide,
      uniforms: {
        glowColor: { value: new THREE.Color(0x66aaff) },
        sunDir:    { value: new THREE.Vector3(8, 5, 10).normalize() },
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
  _pickCitySeeds(seaLevel) {
    const { hmap } = this._cache, S = Math.round(Math.sqrt(hmap.length));
    const rng = makeRng((this._seed | 0) ^ 0x5eed);
    const seeds = [];
    for (let tries = 0; tries < 6000 && seeds.length < 9; tries++) {
      const x = (rng() * S) | 0, y = (rng() * S) | 0;
      const h = hmap[y * S + x], lat = y / (S - 1), poleD = Math.abs(lat - 0.5) * 2;
      // habitable lowland just above the shoreline, away from the poles
      // found cities on coastal lowland (just above the shoreline), off the poles
      if (h > seaLevel + 0.008 && h < seaLevel + 0.09 && poleD < 0.72) seeds.push({ x, y });
    }
    return seeds;
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

    // ── throttle the expensive recolor ── (snow is now temperature-driven, so
    // track surfaceTemp instead of a snowline)
    const v = { seaLevel, surfaceTemp: s.surfaceTemp, waterMass: s.waterMass, molten,
                biosphere: s.biosphere, civilization: s.civilization };
    const L = this._last;
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
    if (s.civilization > 0.01 && !this._citySeeds) {
      this._citySeeds = this._pickCitySeeds(seaLevel);
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

    if (changed) {
      const m = this.planetMesh.material;
      const oldMap = m.map, oldEm = m.emissiveMap, oldSp = m.specularMap;
      const { map, emissiveMap, specularMap } = renderSurfaceTextures(this._cache.hmap, this._cache.himap, {
        type: this._type, hue: this._hue, seaLevel, surfaceTemp: s.surfaceTemp, waterMass: s.waterMass, molten,
        biosphere: s.biosphere, civilization: s.civilization, citySeeds: this._citySeeds,
      });
      m.map = map;   // normalMap is static (set once in build) — never re-touched here
      m.emissiveMap = emissiveMap || null;
      m.specularMap = specularMap || null;
      m.shininess = specularMap ? 60 : this._baseShininess;
      m.needsUpdate = true;
      oldMap?.dispose(); oldEm?.dispose(); oldSp?.dispose();
      this._last = v;
    }

    // ── cheap per-frame: glow + city lights ──
    // emissive drives lava glow (red, pulsing) OR city lights (gold). Gate on
    // the emissive MAP existing so the bare emissive colour never lights the
    // whole globe; city brightness fades in with civilization (no pop-in flash).
    const m = this.planetMesh.material;
    m.emissiveIntensity = !m.emissiveMap ? 0
      : molten > 0.01 ? 0.6 + molten * 1.2 + Math.sin(performance.now() * 0.002) * 0.2 * molten
      : smooth(0.01, 0.3, s.civilization) * (1.0 + Math.sin(performance.now() * 0.0017) * 0.12);

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
    const cover    = clamp(Math.max(humidity * 0.95, sulfur) * air, 0, 0.95);
    const cloudColor = this._type === 'toxic' ? _TOXIC
      : sulfur > humidity * 0.95 ? _CLOUD_SULFUR : _CLOUD_WHITE;
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
