// ─────────────────────────────────────────────────────────────
// FLUID CLOUDS — a 2D semi-Lagrangian "stable fluids" solver (after
// Jos Stam) running on an equirectangular grid wrapped around the
// planet. Banded zonal winds shear the cloud density into bands while
// the incompressible projection step spins up cyclones and swirls.
//
// The solver MATH is pure (plain typed arrays, no THREE) so it can be
// stability-tested headlessly; the FluidClouds class wraps it with a
// DataTexture + sphere shell for rendering.
//
//   longitude → x (periodic)      latitude → y (walls at the poles)
// ─────────────────────────────────────────────────────────────
import * as THREE from 'three';

export const GX = 96, GY = 48;   // low-res sim; a shader adds the fine detail
const N = GX * GY;
const PLANET_SPIN = 0.05;   // keep in lock-step with planet.js
const CLOUD_SPEED = 3.0;    // advance the cloud sim faster than realtime (more motion)
const CORIOLIS = 1.7;       // hemisphere-opposite swirl (sign flips N↔S handedness)
const GUST = 2.0;           // gentle meridional meander so the jets wave (not ebb)

// wrap x (single step), clamp y → a single index. Callers only ever step one
// cell except advect, which pre-wraps its sample coord — so this stays cheap
// (a branch, not a modulo) in the hot linSolve loops.
function IX(i, j) {
  if (i < 0) i += GX; else if (i >= GX) i -= GX;
  if (j < 0) j = 0; else if (j >= GY) j = GY - 1;
  return i + j * GX;
}

// Gauss-Seidel relaxation for the implicit diffuse / pressure solves.
// HOT PATH: neighbor indices are inlined (no IX() calls) — row offsets are
// precomputed and only the longitude edges branch — and 6 iterations is
// plenty for smooth clouds. This is the single biggest per-frame cost.
const LIN_ITERS = 6;
function linSolve(x, x0, a, c, b) {
  const inv = 1 / c;
  for (let k = 0; k < LIN_ITERS; k++) {
    for (let j = 0; j < GY; j++) {
      const row = j * GX;
      const up = (j > 0 ? j - 1 : 0) * GX;
      const dn = (j < GY - 1 ? j + 1 : GY - 1) * GX;
      for (let i = 0; i < GX; i++) {
        const id = row + i;
        const l = i > 0 ? id - 1 : row + GX - 1;
        const r = i < GX - 1 ? id + 1 : row;
        x[id] = (x0[id] + a * (x[l] + x[r] + x[up + i] + x[dn + i])) * inv;
      }
    }
    poles(x, b);
  }
}
// no flow through the poles
function poles(x, b) { if (b === 2) for (let i = 0; i < GX; i++) { x[i] = 0; x[i + (GY-1)*GX] = 0; } }

// smoothstep
function ss(e0, e1, x) { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }
function smoothField(a, iters) {
  const tmp = new Float32Array(N);
  for (let k = 0; k < iters; k++) {
    for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++)
      tmp[i+j*GX] = (a[IX(i-1,j)]+a[IX(i+1,j)]+a[IX(i,j-1)]+a[IX(i,j+1)]+a[i+j*GX]) / 5;
    a.set(tmp);
  }
}

function diffuse(x, x0, diff, dt, b) { const a = dt * diff * N * 1e-4; linSolve(x, x0, a, 1 + 4*a, b); }

function advect(d, d0, u, v, dt, b) {
  for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) {
    const id = i + j * GX;
    let x = i - dt * u[id], y = j - dt * v[id];
    x = x % GX; if (x < 0) x += GX;                              // pre-wrap longitude into range
    if (y < 0.5) y = 0.5; else if (y > GY - 1.5) y = GY - 1.5;   // keep off the poles
    const i0 = Math.floor(x), j0 = Math.floor(y);
    const s1 = x - i0, s0 = 1 - s1, t1 = y - j0, t0 = 1 - t1;
    d[id] = s0 * (t0 * d0[IX(i0,j0)] + t1 * d0[IX(i0,j0+1)])
          + s1 * (t0 * d0[IX(i0+1,j0)] + t1 * d0[IX(i0+1,j0+1)]);
  }
  poles(d, b);
}

function project(u, v, p, div) {
  for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) {
    div[i+j*GX] = -0.5 * (u[IX(i+1,j)] - u[IX(i-1,j)] + v[IX(i,j+1)] - v[IX(i,j-1)]) / GX;
    p[i+j*GX] = 0;
  }
  linSolve(p, div, 1, 4, 0);
  for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) {
    u[i+j*GX] -= 0.5 * GX * (p[IX(i+1,j)] - p[IX(i-1,j)]);
    v[i+j*GX] -= 0.5 * GX * (p[IX(i,j+1)] - p[IX(i,j-1)]);
  }
  poles(v, 2);
}

// ── pure state factory + step (testable) ─────────────────────
// mode 'cloud'  → density biased to the equator (weather)
// mode 'aurora' → density confined to two polar ovals (curtains)
export function createFluid(mode = 'cloud', solid = null) {
  const aurora = mode === 'aurora';
  const f = {
    u: new Float32Array(N), v: new Float32Array(N),
    u0: new Float32Array(N), v0: new Float32Array(N),
    d: new Float32Array(N), d0: new Float32Array(N),
    p: new Float32Array(N), div: new Float32Array(N),
    wind: new Float32Array(GY), src: new Float32Array(N),
    bu: new Float32Array(N), bv: new Float32Array(N),       // divergence-free base swirl
    latBias: new Float32Array(GY),                          // where density is injected
    coriolis: new Float32Array(GY),                         // per-latitude Coriolis parameter
    solid,                                                  // obstacle mask (tall mountains)
    target: 0, windScale: 1, t: 0,
    injGain: aurora ? 3.4 : 2.0,
    dissip:  aurora ? 0.9 : 0.46,                           // aurora fades fast between bursts
  };
  // banded zonal jets (alternating east/west by latitude)
  const bands = 5, windAmp = aurora ? 4 : 8;
  for (let j = 0; j < GY; j++) {
    const lat = (j + 0.5) / GY;
    // latitude wind profile: alternating banded jets + a fast prograde equatorial
    // jet, the whole thing tapering to near-calm at the poles (speeds clearly
    // differ equator→pole).
    const env = 0.18 + 0.82 * Math.sin(lat * Math.PI);                 // 0.18 poles → 1 equator
    const eqJet = Math.exp(-Math.pow((lat - 0.5) / 0.16, 2));          // fast equatorial jet
    f.wind[j] = (Math.sin(lat * Math.PI * bands) * 0.7 + eqJet * 0.9) * windAmp * env;
    // Coriolis parameter: 0 at the equator, opposite sign in each hemisphere
    f.coriolis[j] = CORIOLIS * (lat - 0.5) * 2;
    // injection profile: equatorial for cloud, twin polar ovals for aurora
    if (aurora) {
      const a = Math.exp(-(((lat - 0.13) / 0.07) ** 2)), b = Math.exp(-(((lat - 0.87) / 0.07) ** 2));
      f.latBias[j] = Math.max(a, b);
    } else {
      f.latBias[j] = 0.35 + 0.65 * Math.sin(lat * Math.PI);
    }
  }
  // patchy source field (smoothed white noise)
  for (let i = 0; i < N; i++) f.src[i] = Math.random();
  smoothField(f.src, 2);
  // standing vortices: velocity = curl of a smoothed potential → swirls that
  // stretch density into filaments/curtains instead of smearing into bands.
  const psi = new Float32Array(N);
  for (let i = 0; i < N; i++) psi[i] = Math.random();
  smoothField(psi, aurora ? 6 : 9);
  const VORT = aurora ? 80 : 55;
  for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) {
    const id = i + j * GX;
    f.bu[id] =  (psi[IX(i,j+1)] - psi[IX(i,j-1)]) * 0.5 * VORT;
    f.bv[id] = -(psi[IX(i+1,j)] - psi[IX(i-1,j)]) * 0.5 * VORT;
  }
  for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) {
    f.u[i+j*GX] = f.wind[j] * 0.6 + f.bu[i+j*GX];
    f.v[i+j*GX] = f.bv[i+j*GX];
  }
  return f;
}

export function stepFluid(f, dt) {
  if (dt > 0.05) dt = 0.05;                       // stability / over-advection guard
  // forces: relax toward (mild banded jets + standing vortices) so turbulence
  // persists, plus Coriolis deflection so storms swirl one way in the north and
  // the other in the south.
  f.t += dt;
  const relax = Math.min(1, dt * 0.4), ws = f.windScale, tt = f.t, TWO = Math.PI * 2;
  const gust = GUST * ws * dt;
  for (let j = 0; j < GY; j++) {
    const cor = f.coriolis[j] * dt, fy = (j + 0.5) / GY;
    const gj = gust * (0.25 + 0.75 * Math.sin(fy * Math.PI));   // gusts calmer toward the poles
    for (let i = 0; i < GX; i++) {
      const id = i + j * GX, fx = (i + 0.5) / GX;
      // relax toward banded jets + standing vortices, scaled with the climate's wind
      f.u[id] += (f.wind[j] * 0.6 * ws + f.bu[id] * ws - f.u[id]) * relax;
      f.v[id] += (f.bv[id] * ws - f.v[id]) * relax;
      // MERIDIONAL (north-south) meander only: makes the zonal jets wave like a
      // jet stream and drift slowly, so clouds ride coherent waves rather than
      // ebbing east-west. No zonal gust → the dominant flow stays coherent.
      f.v[id] += Math.sin(fx*TWO*3.0 + fy*4.0 + tt*0.25) * gj;
      const u = f.u[id], v = f.v[id];          // Coriolis: rotate the velocity
      f.u[id] += cor * v;
      f.v[id] -= cor * u;
    }
  }
  const solid = f.solid;
  // velocity solve
  f.u0.set(f.u); f.v0.set(f.v);
  diffuse(f.u, f.u0, 0.4, dt, 1); diffuse(f.v, f.v0, 0.4, dt, 2);
  project(f.u, f.v, f.p, f.div);
  f.u0.set(f.u); f.v0.set(f.v);
  advect(f.u, f.u0, f.u0, f.v0, dt, 1); advect(f.v, f.v0, f.u0, f.v0, dt, 2);
  // OBSTACLES: zero the flow inside mountain cells, then re-project — the
  // incompressibility solve then bends the streamlines AROUND the peaks.
  if (solid) maskVel(f);
  project(f.u, f.v, f.p, f.div);
  if (solid) maskVel(f);

  // density: seed clouds only in patchy spots (so the field is lumpy, not a
  // uniform shell), scaled by humidity; then advect through the vortices and
  // dissipate fairly hard so clear sky opens up between cloud masses.
  for (let j = 0; j < GY; j++) {
    const bias = f.latBias[j];
    for (let i = 0; i < GX; i++) {
      const id = i + j * GX;
      if (solid && solid[id]) continue;                      // no cloud seeds on peaks
      const patch = ss(0.40, 0.82, f.src[id]);               // the patchy spots seed
      f.d[id] += f.target * f.injGain * patch * bias * Math.min(1, dt * 1.6);
    }
  }
  f.d0.set(f.d);
  diffuse(f.d, f.d0, 0.022, dt, 0);
  f.d0.set(f.d);
  advect(f.d, f.d0, f.u, f.v, dt, 0);
  const keep = Math.max(0, 1 - dt * f.dissip);               // dissipation → clear gaps
  for (let i = 0; i < N; i++) {
    f.d[i] = Math.max(0, f.d[i] * keep);
    if (solid && solid[i]) f.d[i] = 0;                       // mountains punch holes in the deck
  }
}
function maskVel(f) { const s = f.solid; for (let i = 0; i < N; i++) if (s[i]) { f.u[i] = 0; f.v[i] = 0; } }

// ── fractal-upscale cloud shader ─────────────────────────────
// Samples the LOW-res density texture but domain-warps the lookup with
// animated FBM and carves in high-frequency detail per pixel — so a coarse
// 64×32 sim renders as a richly detailed, flowing cloud deck. Includes a
// cheap sun-diffuse term so clouds darken on the night side.
const CLOUD_VERT = `
  varying vec2 vUv; varying vec3 vN; varying vec3 vLocal;
  void main(){
    vUv = uv;
    vLocal = normalize(normal);                 // object space → detail locked to the deck
    vN = normalize(mat3(modelMatrix) * normal); // world space → for sun lighting
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const CLOUD_FRAG = `
  precision highp float;
  uniform sampler2D densityTex; uniform vec3 cloudColor; uniform vec3 sunDir; uniform float uTime;
  varying vec2 vUv; varying vec3 vN; varying vec3 vLocal;
  // 3D value-noise FBM — isotropic on the sphere, so NO pole stripes or seams
  float hash(vec3 p){ p = fract(p*0.3183099 + 0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
  float vnoise(vec3 x){
    vec3 i = floor(x), f = fract(x); f = f*f*(3.0-2.0*f);
    return mix(mix(mix(hash(i+vec3(0,0,0)),hash(i+vec3(1,0,0)),f.x),
                   mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
               mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),
                   mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);
  }
  float fbm(vec3 p){ float s=0.0,a=0.5; for(int k=0;k<5;k++){ s+=a*vnoise(p); p*=2.02; a*=0.5; } return s; }
  void main(){
    vec3 p = vLocal; float t = uTime*0.04;
    // warp the density lookup with isotropic 3D noise values (no stripe pattern)
    float w1 = fbm(p*2.5 + vec3(0.0,0.0,t));
    float w2 = fbm(p*2.5 + vec3(4.7,2.3,-t));
    float base = texture2D(densityTex, vUv + (vec2(w1,w2)-0.5)*0.045).a;
    float fine = fbm(p*7.0 + vec3(w1,w2,0.5)*1.5 + t);    // carved-in 3D detail
    float a = smoothstep(0.30, 0.74, base * (0.4 + 1.1*fine));
    if (a < 0.01) discard;
    // night side stays dark (tiny ambient only), so clouds aren't lit in shadow
    float lit = 0.04 + 0.96*smoothstep(-0.05, 0.25, dot(vN, sunDir));
    gl_FragColor = vec4(cloudColor*lit, a);
  }`;

// ── render wrapper ───────────────────────────────────────────
export class FluidClouds {
  constructor(parent, radius, solid = null) {
    this.f = createFluid('cloud', solid);
    this.tex = new THREE.DataTexture(new Uint8Array(N * 4), GX, GY, THREE.RGBAFormat);
    this.tex.wrapS = THREE.RepeatWrapping;
    this.tex.flipY = true;   // match the terrain CanvasTextures so the obstacle mask aligns
    this.tex.minFilter = THREE.LinearFilter; this.tex.magFilter = THREE.LinearFilter;
    this.tex.needsUpdate = true;
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        densityTex: { value: this.tex },
        cloudColor: { value: new THREE.Color(1, 1, 1) },
        sunDir:     { value: new THREE.Vector3(8, 5, 10).normalize() },
        uTime:      { value: 0 },
      },
      vertexShader: CLOUD_VERT, fragmentShader: CLOUD_FRAG,
      transparent: true, depthWrite: false,
    });
    this.root = new THREE.Group();
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.07, 96, 48), this.mat);
    this.root.add(this.mesh);
    parent.add(this.root);
    this._t = 0; this._acc = 0;
  }
  setTarget(cover, color, windScale = 1) {
    this.f.target = cover; this.f.windScale = windScale;
    this.mat.uniforms.cloudColor.value.copy(color);
  }
  update(dt) {
    // shader detail + rotation run every frame (smooth); the SOLVER runs at
    // ~30 Hz with a proportionally larger dt — same motion & coverage, ~half
    // the CPU (solver cost is fixed per step, independent of dt).
    this._t += dt * CLOUD_SPEED;
    this.mat.uniforms.uTime.value = this._t;
    this.root.rotation.y += dt * PLANET_SPIN;
    this._acc += dt;
    if (this._acc >= 1/30) {
      stepFluid(this.f, Math.min(0.1, this._acc * CLOUD_SPEED));
      this._acc = 0;
      const data = this.tex.image.data, d = this.f.d;
      for (let i = 0; i < N; i++) {
        data[i*4] = 255; data[i*4+1] = 255; data[i*4+2] = 255;
        data[i*4+3] = Math.min(1, d[i]) * 255;
      }
      this.tex.needsUpdate = true;
    }
  }
}

// ── Aurora ───────────────────────────────────────────────────
// The same fluid tech, confined to the polar ovals and rendered as an
// additive green glow. Real aurorae aren't constant — they flare in
// "substorms". So density is only injected during brief, periodic bursts
// (a few seconds on, then ~10-25s off); between bursts it fades to nothing.
// The solver only runs during a burst + a short fade tail, so it's cheap
// when the sky is quiet. A burst can only fire when the planet actually has
// the means (magnetic field × solar wind × air) → set via setActivity().
export class Aurora {
  constructor(parent, radius) {
    this.f = createFluid('aurora');
    this.potential = 0;                 // 0..1 capacity (mag × wind × air)
    this.burst = 0;                     // current burst envelope 0..1
    this.burstT = 0; this.burstDur = 0;
    this.next = 4 + Math.random() * 6;  // countdown to first possible burst
    this.activeT = 0;                   // run the solver while > 0
    this._dirty = false;
    this.tex = new THREE.DataTexture(new Uint8Array(N * 4), GX, GY, THREE.RGBAFormat);
    this.tex.wrapS = THREE.RepeatWrapping; this.tex.flipY = true;
    this.tex.minFilter = THREE.LinearFilter; this.tex.magFilter = THREE.LinearFilter;
    this.root = new THREE.Group();
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 1.08, 96, 48),
      new THREE.MeshBasicMaterial({
        map: this.tex, color: 0x4dffb0, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    this.root.add(this.mesh);
    parent.add(this.root);
  }
  setActivity(potential, color) {
    this.potential = potential;
    if (color) this.mesh.material.color.copy(color);
  }
  update(dt) {
    // substorm scheduler
    if (this.burstDur > 0) {
      this.burstT += dt;
      const u = this.burstT / this.burstDur;
      this.burst = u < 0.18 ? u / 0.18 : Math.max(0, 1 - (u - 0.18) / 0.82); // fast rise, slow fall
      if (u >= 1) { this.burstDur = 0; this.burst = 0; }
    } else {
      this.next -= dt;
      if (this.next <= 0 && this.potential > 0.06) {
        this.burstDur = 3 + Math.random() * 4;          // 3-7s flare
        this.burstT = 0;
        this.next = 9 + Math.random() * 16;             // quiet for 9-25s
      } else if (this.next <= 0) {
        this.next = 3;                                   // keep checking if too weak to fire
      }
    }
    this.f.target = this.potential * this.burst * 1.3;
    if (this.burst > 0.001) this.activeT = 4;            // keep simulating through the fade

    this.root.rotation.y += dt * PLANET_SPIN;
    if (this.activeT > 0) {
      this.activeT -= dt;
      this._acc = (this._acc || 0) + dt;
      if (this._acc >= 1/30) {                           // solver at ~30 Hz like the clouds
        stepFluid(this.f, Math.min(0.1, this._acc));
        this._acc = 0;
        const data = this.tex.image.data, d = this.f.d;
        for (let i = 0; i < N; i++) {
          data[i*4] = 255; data[i*4+1] = 255; data[i*4+2] = 255;
          data[i*4+3] = ss(0.12, 0.55, d[i]) * 255;      // wispy, additive curtains
        }
        this.tex.needsUpdate = true;
      }
      this._dirty = true;
    } else if (this._dirty) {
      this.tex.image.data.fill(0);                       // clear once when quiet
      this.tex.needsUpdate = true;
      this._dirty = false;
    }
  }
}
