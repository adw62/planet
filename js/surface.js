// ─────────────────────────────────────────────────────────────
// SURFACE RENDERING — turns a cached heightmap + simulation-derived
// "visual" parameters into color / normal / emissive textures.
//
// The expensive heightmap (noise.js) is computed once; everything
// here is a cheap per-pixel recolor, so it can re-run whenever the
// simulation crosses a visible threshold (sea level, ice, molten…).
//
// Composition order per pixel:  base lithology → ocean flood →
// ice caps & snowline → molten glow.  Each layer is the previous
// layer's output, so they stack naturally.
// ─────────────────────────────────────────────────────────────
import * as THREE from 'three';

// ── tiny color helpers ───────────────────────────────────────
const lerp3 = (a, b, t) => [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t];
function smooth(e0, e1, x) { const t = Math.min(1, Math.max(0, (x-e0)/(e1-e0))); return t*t*(3-2*t); }

// ── per-type dry-land color (height,hiFreq → rgb 0..255) ─────
function landColorFn(type, hue) {
  if (type === 'black') return (h) => {
    const t1=Math.min(1,Math.max(0,h/0.5)), t2=Math.min(1,Math.max(0,(h-0.5)/0.5));
    return [(0.04+t1*0.11+t2*0.14)*255,(0.04+t1*0.10+t2*0.13)*255,(0.05+t1*0.11+t2*0.15)*255];
  };
  if (type === 'desert') return (h, hi) => {
    const t1=Math.min(1,Math.max(0,h/0.38)),t2=Math.min(1,Math.max(0,(h-0.38)/0.37)),t3=Math.min(1,Math.max(0,(h-0.75)/0.25));
    let r=0.26+t1*0.44+t2*0.18+t3*0.06, g=0.12+t1*0.28+t2*0.20+t3*0.10, b=0.05+t1*0.07+t2*0.10+t3*0.14;
    const scour=Math.max(0,(hi-0.56)/0.34); r+=(0.90-r)*scour*0.5; g+=(0.78-g)*scour*0.5; b+=(0.54-b)*scour*0.4;
    return [Math.min(255,r*255),Math.min(255,g*255),Math.min(255,b*255)];
  };
  if (type === 'toxic') return (h, hi) => {
    const t1=Math.min(1,Math.max(0,h/0.36)),t2=Math.min(1,Math.max(0,(h-0.36)/0.40)),t3=Math.min(1,Math.max(0,(h-0.76)/0.24));
    let r=0.07+t1*0.22+t2*0.32+t3*0.14, g=0.10+t1*0.38+t2*0.26+t3*0.10, b=0.03+t1*0.04+t2*0.02+t3*0.10;
    const crystal=Math.max(0,(hi-0.58)/0.32); r+=(0.72-r)*crystal*0.45; g+=(0.92-g)*crystal*0.55; b+=(0.22-b)*crystal*0.35;
    return [Math.min(255,r*255),Math.min(255,g*255),Math.min(255,b*255)];
  };
  // generic rocky (hue biases red↔blue)
  const redBias=0.5+hue*0.5;
  const hiR=redBias*0.92+(1-redBias)*0.78, hiG=redBias*0.78+(1-redBias)*0.84, hiB=redBias*0.55+(1-redBias)*0.92;
  return (h, hi) => {
    const lo={r:0.18+redBias*0.10,g:0.08,b:0.06};
    const mid={r:0.55+redBias*0.12,g:0.22+(1-redBias)*0.10,b:0.18+(1-redBias)*0.10};
    const hih={r:0.70+(1-redBias)*0.08,g:0.65+(1-redBias)*0.08,b:0.65+(1-redBias)*0.08};
    const t1=Math.min(1,Math.max(0,h/0.45)), t2=Math.min(1,Math.max(0,(h-0.45)/0.55));
    let r=lo.r+(mid.r-lo.r)*t1+(hih.r-mid.r)*t2, g=lo.g+(mid.g-lo.g)*t1+(hih.g-mid.g)*t2, b=lo.b+(mid.b-lo.b)*t1+(hih.b-mid.b)*t2;
    const blend=Math.max(0,(hi-0.62)/0.28); r+=(hiR-r)*blend; g+=(hiG-g)*blend; b+=(hiB-b)*blend;
    return [Math.min(255,r*255),Math.min(255,g*255),Math.min(255,b*255)];
  };
}

// molten lava color (bright in low/hot terrain) — used by molten overlay
function lavaColor(h) {
  let r,g,b;
  if      (h<0.26){const t=h/0.26;            r=1.00-t*0.22; g=0.56-t*0.32; b=t*0.04;}
  else if (h<0.48){const t=(h-0.26)/0.22;     r=0.78-t*0.40; g=0.24-t*0.18; b=0.04-t*0.02;}
  else if (h<0.76){const t=(h-0.48)/0.28;     r=0.38-t*0.24; g=0.06-t*0.03; b=0.02;}
  else            {const t=Math.min(1,(h-0.76)/0.24); r=0.14+t*0.07; g=0.03+t*0.05; b=0.02+t*0.04;}
  return [r*255, g*255, b*255];
}

// ── ocean flood overlay ──────────────────────────────────────
// Depth-graded colour: bright tropical teal at the coast deepening through
// ocean blue to a rich deep blue in the abyss (the deepest water, generally
// farthest from any coast). `hi` adds patchy variation so the open ocean reads
// as living water rather than a flat slab — strongest in the deep.
function oceanColorAt(depth, waterLevel, hi) {
  const dn = Math.min(1, depth / Math.max(0.12, waterLevel));
  let c;
  if      (dn < 0.45) c = lerp3([48,140,158], [24,88,150],  dn / 0.45);
  else if (dn < 0.75) c = lerp3([24,88,150],  [8,38,104],  (dn - 0.45) / 0.30);
  else                c = lerp3([8,38,104],   [2,12,54],   (dn - 0.75) / 0.25);
  if (hi !== undefined && dn > 0.28) {
    const vr = (hi - 0.5) * smooth(0.28, 0.85, dn) * 34;   // patchy deep-water variation
    c = [c[0] + vr * 0.2, c[1] + vr * 0.5, c[2] + vr];
  }
  return c;
}

// ── master per-pixel composite ───────────────────────────────
// visual = { type, hue, seaLevel, surfaceTemp, waterMass, molten, biosphere }
const _VEG_LUSH   = [38, 104, 44];   // deep forest
const _VEG_SPARSE = [104, 128, 58];  // scrub / grassland
const ALT_LAPSE = 160;   // K of cooling per unit elevation above sea (mountain snow)
const LAT_SWING = 55;    // equator↔pole temperature swing (centred on the mean)
function makeComposite(visual, S) {
  const { type, hue, seaLevel, molten } = visual;
  const biosphere = visual.biosphere ?? 0;
  const surfaceTemp = visual.surfaceTemp ?? 288;
  const civ = visual.civilization ?? 0;
  const seeds = visual.citySeeds ?? [];
  const roadMask = visual.roadMask ?? null;
  const snowAmt = smooth(0.04, 0.3, visual.waterMass ?? 0);   // need water to make snow
  const land = landColorFn(type, hue);
  const shore = 0.045;
  const snow = [232, 240, 250];
  const halfS = S / 2;
  const URBAN_GREY  = [150, 142, 128];
  const URBAN_GREEN = [108, 138, 88];
  const ROAD  = [148, 126, 94];

  return (h, hi, lat, x, y) => {
    // 1. base + ocean flood
    let rgb;
    if (seaLevel > 0.001 && h < seaLevel + shore) {
      if (h >= seaLevel) rgb = lerp3(oceanColorAt(0, seaLevel, hi), land(h, hi), (h - seaLevel) / shore);
      else               rgb = oceanColorAt(seaLevel - h, seaLevel, hi);
    } else {
      rgb = land(h, hi);
    }

    // 2. vegetation — green spreads over land, thickest in lowlands near the
    //    sea and away from the poles; sparse-to-lush with the himap texture.
    if (biosphere > 0.01 && h > seaLevel) {
      const poleD = Math.abs(lat - 0.5) * 2;
      const lowland = 1 - smooth(0.0, 0.34, h - seaLevel);   // hugs the coasts
      const latMoist = 1 - smooth(0.35, 1.0, poleD);          // not at the poles
      const veg = biosphere * lowland * latMoist;
      if (veg > 0.01) {
        const flora = lerp3(_VEG_SPARSE, _VEG_LUSH, Math.min(1, hi * 1.1));
        rgb = lerp3(rgb, flora, Math.min(0.82, veg));
      }
    }

    // 2b. settlement footprint — pre-electric civilization shows up only as
    //     terrain deformation. Fields use the SAME placement rule as the
    //     night-side city lights (radial falloff² × coastal-lowland preference²
    //     × per-cell jitter from makeComposite/emissive below) — just with a
    //     wider reach, smaller patches, and varied size/colour instead of single
    //     lit pixels, so they read as a halo of farmland around each seed rather
    //     than a ring. A built-up grey core grows at the centre once electrified,
    //     swallowing the nearest fields.
    if (civ > 0.01 && seeds.length && h > seaLevel) {
      const above = h - seaLevel;
      if (above < 0.34) {
        let best = Infinity, bestK = -1;
        for (let k = 0; k < seeds.length; k++) {
          let dx = Math.abs(x - seeds[k].x); if (dx > halfS) dx = S - dx;   // wrap longitude
          const dy = y - seeds[k].y, d2 = dx*dx + dy*dy;
          if (d2 < best) { best = d2; bestK = k; }
        }
        const dist = Math.sqrt(best);
        const coastal = 1 - smooth(0.015, 0.22, above);    // same shape as the city-light coastal term

        // fields: wide radial+coastal halo gates WHERE farmland can grow;
        // within that halo, a region-varying cell grid picks patch size,
        // presence and crop colour — small fields near the seed centre,
        // a patchier/larger mix toward the frontier.
        const farmStage = smooth(0.01, 0.4, civ);
        const farmReach = (0.08 + 0.45 * farmStage) * S;
        if (farmStage > 0.01 && dist < farmReach) {
          const fall = 1 - dist / farmReach;
          // local field SIZE varies region to region (coarse super-cell)
          const superPx = Math.max(3, (S / 170) | 0);
          const sx = (x / superPx) | 0, sy = (y / superPx) | 0;
          let shsh = ((sx*668265263 + sy*374761393) ^ 0x9e3779b9) >>> 0;
          shsh ^= shsh >>> 13; shsh = (shsh * 1274126177) >>> 0;
          const cellPx = [2, 3, 5, 8][shsh & 3] * Math.max(1, S / 512);
          // per-field hash decides presence (gated by the same radial/coastal
          // rule as city lights) and a continuous crop colour + brightness
          const cx = (x / cellPx) | 0, cy = (y / cellPx) | 0;
          let chsh = ((cx*2654435761 + cy*40503) ^ 0x9e3779b9) >>> 0;
          chsh ^= chsh >>> 15; chsh = (chsh * 2246822519) >>> 0;
          const jitter = 0.6 + ((chsh>>>20)&0x3ff)/0x3ff * 0.8;
          const farmProb = fall*fall*0.85*coastal*coastal*jitter*farmStage;
          if (((chsh % 10000) / 10000) < farmProb) {
            const t = ((chsh>>>4)&0xff) / 255;
            const crop = t < 0.34 ? lerp3([205,176,70],[150,158,58], t/0.34)
                       : t < 0.67 ? lerp3([150,158,58],[120,92,56], (t-0.34)/0.33)
                       :            lerp3([120,92,56],[196,150,150],(t-0.67)/0.33);
            const shade = 0.85 + (((chsh>>>13)&0x3f)/0x3f) * 0.3;
            rgb = lerp3(rgb, crop.map(v => Math.min(255, v*shade)), 0.45 + 0.25*farmStage);
          }
        }

        // urban core: once electrified, a built-up footprint grows at the centre
        const urbanStage = smooth(0.4, 0.9, civ);
        if (urbanStage > 0.01) {
          const urbanReach = (0.02 + 0.10 * urbanStage) * S;
          if (dist < urbanReach) {
            const ufall = 1 - dist / urbanReach;
            // city block hash: grey concrete vs. green parkland/lots, patchy
            // rather than a single flat tone
            const ucell = Math.max(2, (S / 220) | 0);
            const ucx = (x / ucell) | 0, ucy = (y / ucell) | 0;
            let uhsh = ((ucx*2654435761 + ucy*40503) ^ 0x517cc1b7) >>> 0;
            uhsh ^= uhsh >>> 15; uhsh = (uhsh * 2246822519) >>> 0;
            const greenT = ((uhsh>>>4)&0xff) / 255;
            const urban = lerp3(URBAN_GREY, URBAN_GREEN, greenT*greenT);
            rgb = lerp3(rgb, urban, Math.min(0.75, ufall*ufall*urbanStage));
          }
        }
      }
    }

    // 2c. roads — a precomputed mask (planet.js: trunk roads MST-linking every
    //     settlement, plus rural spurs) painted wherever it has coverage. The
    //     mask itself already follows low ground (built by snapping toward
    //     local height minima), so no per-pixel elevation gating is needed here.
    if (roadMask && h > seaLevel) {
      const rc = roadMask[y * S + x];
      if (rc > 0.003) {
        const roadStage = smooth(0.01, 0.35, civ);
        rgb = lerp3(rgb, ROAD, Math.min(0.85, rc * roadStage));
      }
    }

    // 3. ice & snow — local temperature falls with ALTITUDE (mountain snow)
    //    and LATITUDE (polar caps); snow forms wherever it drops below freezing,
    //    scaled by how much water there is to freeze. This puts snowcaps on the
    //    high peaks even of a warm world, exactly like real mountains.
    if (snowAmt > 0.001) {
      const poleD = Math.abs(lat - 0.5) * 2;                  // 0 equator … 1 pole
      const alt = h > seaLevel ? h - seaLevel : 0;
      // warm equator, cold poles (swing centred on the mean) + altitude cooling.
      // The altitude term fades out near the poles so the cap edge follows pure
      // latitude (a clean circle) instead of streaking with the terrain there.
      const altW = 1 - smooth(0.78, 0.98, poleD);
      const localT = surfaceTemp + (0.5 - poleD * poleD) * LAT_SWING - alt * ALT_LAPSE * altW;
      const icy = smooth(273, 261, localT) * snowAmt;         // freezes below ~273 K
      // sea ice reads slightly bluer than land snow
      if (icy > 0.002) rgb = lerp3(rgb, h < seaLevel ? [205,224,238] : snow, Math.min(1, icy));
    }

    // 4. molten glow — overrides everything as the surface melts
    if (molten > 0.001) rgb = lerp3(rgb, lavaColor(h), molten);

    return rgb;
  };
}

const NORMAL_RES = 1024;   // normal map is rendered at 2× the heightmap for crisper relief

// Bilinear-upsample a wrapped (x) / clamped (y) field to R×R, optionally
// clamping values up to sea level (for the flat-ocean normal).
function _upsample(map, S, R, clampTo) {
  const out = new Float32Array(R * R);
  for (let Y = 0; Y < R; Y++) {
    const fy = Y / R * S; let y0 = Math.floor(fy); const ty = fy - y0;
    let y1 = y0 + 1; if (y0 < 0) y0 = 0; else if (y0 > S-1) y0 = S-1; if (y1 > S-1) y1 = S-1;
    for (let X = 0; X < R; X++) {
      const fx = X / R * S, x0 = Math.floor(fx), tx = fx - x0;
      const xa = ((x0 % S) + S) % S, xb = (x0 + 1) % S;
      let v = (map[y0*S+xa]*(1-tx) + map[y0*S+xb]*tx)*(1-ty) + (map[y1*S+xa]*(1-tx) + map[y1*S+xb]*tx)*ty;
      if (clampTo !== undefined && v < clampTo) v = clampTo;
      out[Y*R+X] = v;
    }
  }
  return out;
}

// Build the STATIC detailed normal at NORMAL_RES (computed once per world).
// Combines the macro terrain gradient (hmap) with the high-frequency detail
// field (himap) for crisp fine relief — extra detail at no noise-gen cost.
// Returns the raw normal bytes + the upsampled height (used to flatten the
// ocean cheaply per sea-level change in paintNormalTexture, without redoing
// this expensive gradient pass).
export function buildNormalBase(hmap, himap, type) {
  const S = Math.round(Math.sqrt(hmap.length)), R = NORMAL_RES;
  const strength = { black:30, ice:28, rock:32, desert:26, toxic:22 }[type] ?? 30;
  const detail = 11;                                  // himap fine-relief weight
  const H = _upsample(hmap, S, R);
  const D = _upsample(himap, S, R);
  const data = new Uint8ClampedArray(R * R * 4);
  for (let y=0;y<R;y++){
    // Spherical metric correction: the longitudinal (x) gradient is physically
    // squeezed toward the poles, so scale it by sin(latitude). This removes the
    // streaking WITHOUT flattening the relief (latitudinal detail is kept). A
    // tiny extra fade at the very tip tames the radial spike at the singularity.
    const lat = y / (R - 1);
    const poleD = Math.abs(lat - 0.5) * 2;
    const lonScale = Math.sin(Math.PI * lat);
    const tip = 1 - smooth(0.95, 0.998, poleD);
    for (let x=0;x<R;x++){
      const xl = x>0?x-1:R-1, xr = x<R-1?x+1:0, yu = y>0?y-1:0, yd = y<R-1?y+1:R-1;
      const dx = ((H[y*R+xr]-H[y*R+xl])*strength + (D[y*R+xr]-D[y*R+xl])*detail) * lonScale;
      const dy = ((H[yd*R+x]-H[yu*R+x])*strength + (D[yd*R+x]-D[yu*R+x])*detail) * tip;
      const len=Math.sqrt(dx*dx+dy*dy+1), o=(y*R+x)*4;
      data[o]=(-dx/len*0.5+0.5)*255; data[o+1]=(-dy/len*0.5+0.5)*255;
      data[o+2]=(1/len*0.5+0.5)*255; data[o+3]=255;
    }
  }
  return { data, heightUp: H, R };
}

// Paint the normal into `ctx`, flattening pixels below sea level (flat ocean).
// Cheap: a copy + a compare-and-overwrite, no gradient recompute.
export function paintNormalTexture(ctx, base, seaLevel) {
  const { data, heightUp, R } = base;
  const img = ctx.createImageData(R, R);
  img.data.set(data);
  if (seaLevel > 0.001) {
    for (let i = 0; i < R*R; i++) if (heightUp[i] < seaLevel) {
      const o = i*4; img.data[o]=128; img.data[o+1]=128; img.data[o+2]=255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// ── recolor: diffuse + emissive + specular (normal/displacement are static) ──
export function renderSurfaceTextures(hmap, himap, visual) {
  const S = Math.round(Math.sqrt(hmap.length));   // match the heightmap's own resolution
  const col = makeComposite(visual, S);
  const moltenGlow = visual.molten ?? 0;

  // diffuse
  const dc=document.createElement('canvas'); dc.width=dc.height=S;
  const dctx=dc.getContext('2d'), dimg=dctx.createImageData(S,S);
  for (let i=0;i<S*S;i++){
    const lat=(Math.floor(i/S))/(S-1);
    const x=i%S, y=(i/S)|0;
    const [r,g,b]=col(hmap[i], himap[i], lat, x, y);
    dimg.data[i*4]=r; dimg.data[i*4+1]=g; dimg.data[i*4+2]=b; dimg.data[i*4+3]=255;
  }

  // emissive — molten glow (lava biome / melting) AND night-side city lights.
  // City lights sit in the emissive channel so on the bright day side they're
  // washed out by sunlight, but on the dark side they're the only light → they
  // glow (and bloom makes them sparkle). Molten glow is red/orange, cities gold.
  const seaLevel = visual.seaLevel ?? 0, civ = visual.civilization ?? 0;
  const seeds = visual.citySeeds ?? [];
  // Lights only switch on once civilization crosses the electrification
  // threshold (0.4) — below that, settlements are visible only as the
  // farmland/urban footprint painted into the diffuse map (see makeComposite),
  // matching the pre-electric agrarian stage the player watches grow first.
  const electrify = smooth(0.4, 0.9, civ);
  let ec = null, ectx = null, eimg = null, emissiveMap = null;
  if (moltenGlow > 0.01 || (electrify > 0.01 && seeds.length)) {
    ec=document.createElement('canvas'); ec.width=ec.height=S;
    ectx=ec.getContext('2d'); eimg=ectx.createImageData(S,S);
    // Cities NUCLEATE: each founding seed grows a metro whose radius expands
    // with civilization. Lit pixels are densest at the centre and thin toward
    // the frontier, so you watch settlements spread outward over the land.
    const reach = (0.02 + electrify * 0.10) * S;           // metro radius in pixels — matches the urban diffuse footprint
    const reach2 = reach * reach, halfS = S / 2;
    const doCities = electrify > 0.01 && seeds.length;
    for (let i=0;i<S*S;i++){
      let r=0,g=0,b=0;
      if (moltenGlow>0){ const glow=moltenGlow*Math.max(0,1-hmap[i]/0.5); r=glow; g=glow*0.35; }
      if (doCities && hmap[i]>seaLevel){
        const x=i%S, y=(i/S)|0;
        let best=Infinity;
        for (let k=0;k<seeds.length;k++){
          let dx=Math.abs(x-seeds[k].x); if(dx>halfS) dx=S-dx;   // wrap longitude
          const dy=y-seeds[k].y, d2=dx*dx+dy*dy;
          if(d2<best) best=d2;
        }
        const above = hmap[i] - seaLevel;
        if (best<reach2 && above < 0.32){                        // never climb the mountains
          const fall=1-Math.sqrt(best)/reach;                    // 1 at centre → 0 at frontier
          const coastal=1-smooth(0.015,0.20,above);              // hug the coast / prefer water
          let hsh=(i*2654435761)>>>0; hsh^=hsh>>>13; hsh=(hsh*1274126177)>>>0;
          // density jitter so the lit fraction itself varies place to place
          const jitter = 0.6 + ((hsh>>>20)&0x3ff)/0x3ff * 0.8;
          const lightProb = fall*fall*0.8*coastal*coastal*jitter;
          if ((hsh%10000)/10000 < lightProb){
            // per-light variation → organic, not a uniform grid of dots:
            const rb=((hsh>>>3)&0x3ff)/0x3ff, rc=((hsh>>>13)&0x7f)/0x7f;
            const bright = 0.16 + Math.pow(rb, 2.6) * 1.25;       // power-law: many dim, few bright
            const w = rc * rc;                                   // warm-biased: mostly gold, some white
            const lr = 1.0,  lg = 0.58 + 0.34*w,  lb = 0.22 + 0.78*w;
            r=Math.max(r, lr*bright); g=Math.max(g, lg*bright); b=Math.max(b, lb*bright);
          }
        }
      }
      eimg.data[i*4]=Math.min(255,r*255); eimg.data[i*4+1]=Math.min(255,g*255);
      eimg.data[i*4+2]=Math.min(255,b*255); eimg.data[i*4+3]=255;
    }
    emissiveMap = new THREE.CanvasTexture(ec);
  }

  // snapshot the un-charred composite BEFORE baking in war damage, so a future
  // scorch-only update (combat tick, no climate/civ change) can repaint just the
  // affected city's footprint from these instead of redoing the full S×S passes
  // above (which include an O(seeds) nearest-city search per pixel).
  const baseDiffuseData = new Uint8ClampedArray(dimg.data);
  const baseEmissiveData = eimg ? new Uint8ClampedArray(eimg.data) : null;
  applyScorch(dimg, eimg, hmap, visual, S);

  dctx.putImageData(dimg,0,0);
  if (ectx) ectx.putImageData(eimg,0,0);

  // specular map — white over water so only oceans catch a sun-glint
  let specularMap = null;
  if (seaLevel > 0.001) {
    const sc=document.createElement('canvas'); sc.width=sc.height=S;
    const sctx=sc.getContext('2d'), simg=sctx.createImageData(S,S);
    for (let i=0;i<S*S;i++){
      const wet = hmap[i] < seaLevel ? 255 : 0;
      simg.data[i*4]=wet; simg.data[i*4+1]=wet; simg.data[i*4+2]=wet; simg.data[i*4+3]=255;
    }
    sctx.putImageData(simg,0,0);
    specularMap = new THREE.CanvasTexture(sc);
  }

  return {
    map: new THREE.CanvasTexture(dc), emissiveMap, specularMap,
    diffuseCanvas: dc, emissiveCanvas: ec, baseDiffuseData, baseEmissiveData,
  };
}

// ── war-damage scorch overlay ────────────────────────────────
// Chars the ground and dims/extinguishes city lights around each scorched
// seed. Mutates `dimg`/`eimg` (Canvas ImageData) in place, touching only a
// small bounding box per scorched city instead of the full S×S canvas — this
// is what lets repaintScorch() below update war damage on every combat hit
// without re-running the expensive composite passes. Assumes a scorched
// city's own seed is the nearest one within its burn/light radius, which
// holds for any reasonable city spacing (a cheaper trade for an exact
// nearest-seed search that's no longer worth doing per pixel).
function applyScorch(dimg, eimg, hmap, visual, S) {
  const seeds = visual.citySeeds ?? [];
  const scorch = visual.scorch ?? [];
  if (!scorch.length || !seeds.length) return;
  const seaLevel = visual.seaLevel ?? 0;
  const civ = visual.civilization ?? 0;
  const moltenGlow = visual.molten ?? 0;
  const urbanStage = smooth(0.4, 0.9, civ);
  const burnReach = (0.025 + 0.08 * urbanStage) * S;
  const electrify = smooth(0.4, 0.9, civ);
  const reach = (0.02 + electrify * 0.10) * S, reach2 = reach * reach;
  const R = Math.ceil(Math.max(burnReach, reach));
  const CHAR = [14, 11, 10];

  for (let k = 0; k < seeds.length; k++) {
    const scFrac = scorch[k] ?? 0;
    if (scFrac <= 0.01) continue;
    const seed = seeds[k];
    const y0 = Math.max(0, seed.y - R), y1 = Math.min(S - 1, seed.y + R);
    for (let y = y0; y <= y1; y++) {
      const dy = y - seed.y;
      for (let dx = -R; dx <= R; dx++) {
        const x = ((seed.x + dx) % S + S) % S;   // wrap longitude
        const i = y * S + x, h = hmap[i];
        if (h <= seaLevel) continue;
        const above = h - seaLevel, d2 = dx*dx + dy*dy;

        if (above < 0.34 && d2 < burnReach*burnReach) {
          const dist = Math.sqrt(d2), bfall = 1 - dist / burnReach;
          const t = Math.min(0.9, scFrac * bfall * bfall), o = i * 4;
          dimg.data[o]   += (CHAR[0] - dimg.data[o])   * t;
          dimg.data[o+1] += (CHAR[1] - dimg.data[o+1]) * t;
          dimg.data[o+2] += (CHAR[2] - dimg.data[o+2]) * t;
        }

        if (eimg && above < 0.32 && d2 < reach2) {
          const o = i * 4;
          const litFrac = Math.max(0, 1 - scFrac * 1.4);
          let r = 0, g = 0, b = 0;
          if (moltenGlow > 0) { const glow = moltenGlow * Math.max(0, 1 - h/0.5); r = glow; g = glow*0.35; }
          if (litFrac > 0.01) {
            const dist = Math.sqrt(d2);
            const fall = 1 - dist / reach;
            const coastal = 1 - smooth(0.015, 0.20, above);
            let hsh = (i*2654435761)>>>0; hsh ^= hsh>>>13; hsh = (hsh*1274126177)>>>0;
            const jitter = 0.6 + ((hsh>>>20)&0x3ff)/0x3ff * 0.8;
            const lightProb = fall*fall*0.8*coastal*coastal*jitter*litFrac;
            if ((hsh%10000)/10000 < lightProb) {
              const rb=((hsh>>>3)&0x3ff)/0x3ff, rc=((hsh>>>13)&0x7f)/0x7f;
              const bright = (0.16 + Math.pow(rb, 2.6) * 1.25) * litFrac;
              const w = rc * rc;
              const lr = 1.0, lg = 0.58 + 0.34*w, lb = 0.22 + 0.78*w;
              r = Math.max(r, lr*bright); g = Math.max(g, lg*bright); b = Math.max(b, lb*bright);
            }
          }
          eimg.data[o]=Math.min(255,r*255); eimg.data[o+1]=Math.min(255,g*255); eimg.data[o+2]=Math.min(255,b*255);
        }
      }
    }
  }
}

// Cheap war-damage-only update: repaints scorch directly from the cached
// pre-scorch base pixel data (captured by renderSurfaceTextures) instead of
// recomputing the full diffuse/emissive composite. Call this instead of
// renderSurfaceTextures when only `scorch` changed since the last recolor.
export function repaintScorch(diffuseCanvas, emissiveCanvas, baseDiffuseData, baseEmissiveData, hmap, visual) {
  const S = Math.round(Math.sqrt(hmap.length));
  const dctx = diffuseCanvas.getContext('2d');
  const dimg = dctx.createImageData(S, S);
  dimg.data.set(baseDiffuseData);

  let ectx = null, eimg = null;
  if (emissiveCanvas && baseEmissiveData) {
    ectx = emissiveCanvas.getContext('2d');
    eimg = ectx.createImageData(S, S);
    eimg.data.set(baseEmissiveData);
  }

  applyScorch(dimg, eimg, hmap, visual, S);

  dctx.putImageData(dimg, 0, 0);
  if (ectx) ectx.putImageData(eimg, 0, 0);
}

// Grayscale height texture for GPU vertex displacement. Terrain below sea
// level is clamped UP to the sea surface, so the seabed renders as a smooth
// flat ocean instead of bumpy bathymetry. Regenerated when sea level moves.
export function makeHeightTex(hmap, seaLevel = 0) {
  const S = Math.round(Math.sqrt(hmap.length));
  const c = document.createElement('canvas'); c.width = c.height = S;
  const ctx = c.getContext('2d'), img = ctx.createImageData(S, S);
  for (let i = 0; i < S*S; i++) {
    const h = hmap[i] < seaLevel ? seaLevel : hmap[i];   // flat ocean surface
    const v = Math.max(0, Math.min(255, h * 255));
    img.data[i*4] = v; img.data[i*4+1] = v; img.data[i*4+2] = v; img.data[i*4+3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}

// ── soft radial sprite for impact flashes ────────────────────
let _impactTex=null;
export function getImpactTex() {
  if (_impactTex) return _impactTex;
  const c=document.createElement('canvas'); c.width=c.height=64; const ctx=c.getContext('2d');
  const g=ctx.createRadialGradient(32,32,0,32,32,32);
  g.addColorStop(0,'rgba(255,255,255,0.95)'); g.addColorStop(0.25,'rgba(255,230,180,0.7)');
  g.addColorStop(0.6,'rgba(140,180,220,0.25)'); g.addColorStop(1,'rgba(0,0,0,0)');
  ctx.fillStyle=g; ctx.fillRect(0,0,64,64);
  return _impactTex=new THREE.CanvasTexture(c);
}

// ── base surface palettes the player picks as a starting point ──
export const SURFACE_TYPES = [
  { id:'rock',   label:'Rocky',     shininess:5,  hue:0.04 },
  { id:'black',  label:'Obsidian',  shininess:4,  hue:0    },
  { id:'desert', label:'Desert',    shininess:3,  hue:0.06 },
  { id:'toxic',  label:'Toxic',     shininess:14, hue:0.28 },
];
