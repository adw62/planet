// ─────────────────────────────────────────────────────────────
// RNG + procedural heightmap generation.
//
// The heightmap is the planet's permanent terrain. It's expensive
// (3D value-noise FBM) so it's computed ONCE per seed and cached;
// the renderer then re-colors it cheaply every time the simulation
// state changes (sea level, ice, molten, …). Keep this module free
// of THREE / DOM so it stays trivially testable.
// ─────────────────────────────────────────────────────────────

export function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Returns { hmap, himap, S } — base + high-frequency height fields,
// sampled on an SxS grid wrapped cylindrically so longitude tiles.
export function genHeightMaps(seed, S = 512) {
  let _s = seed | 0;
  function rng() { _s = (_s * 1664525 + 1013904223) & 0xffffffff; return (_s >>> 0) / 0xffffffff; }
  function hash3(ix, iy, iz) {
    let h = (ix * 374761393 ^ iy * 668265263 ^ iz * 1013904223) + ((_s * 982451653) | 0);
    h = ((h ^ (h >>> 13)) * 1274126177) | 0;
    return ((h >>> 0) & 0x7fffffff) / 0x7fffffff;
  }
  function noise3(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const fx = x-xi, fy = y-yi, fz = z-zi;
    const ux = fx*fx*(3-2*fx), uy = fy*fy*(3-2*fy), uz = fz*fz*(3-2*fz);
    const v000=hash3(xi,yi,zi), v100=hash3(xi+1,yi,zi), v010=hash3(xi,yi+1,zi), v110=hash3(xi+1,yi+1,zi);
    const v001=hash3(xi,yi,zi+1), v101=hash3(xi+1,yi,zi+1), v011=hash3(xi,yi+1,zi+1), v111=hash3(xi+1,yi+1,zi+1);
    return v000*(1-ux)*(1-uy)*(1-uz)+v100*ux*(1-uy)*(1-uz)+v010*(1-ux)*uy*(1-uz)+v110*ux*uy*(1-uz)
          +v001*(1-ux)*(1-uy)*uz+v101*ux*(1-uy)*uz+v011*(1-ux)*uy*uz+v111*ux*uy*uz;
  }
  function makeFbm(scale, octaves) {
    const r = scale / (Math.PI * 2);
    const sz = scale * 0.8;
    return (px, py) => {
      const cx = Math.cos(px * Math.PI * 2) * r;
      const cy = Math.sin(px * Math.PI * 2) * r;
      const cz = py * sz;
      let v = 0, amp = 0.5, freq = 1, max = 0;
      for (let o = 0; o < octaves; o++) {
        v += noise3(cx*freq, cy*freq, cz*freq) * amp;
        max += amp; amp *= 0.5; freq *= 2.1;
      }
      return v / max;
    };
  }
  const scale = 8 + rng() * 5;
  // extra octaves add finer terrain detail for the higher-res grid to resolve
  const fbm   = makeFbm(scale, 7);
  const fbmHi = makeFbm(scale * 0.35, 4);
  const hmap  = new Float32Array(S * S);
  const himap = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    hmap[y * S + x]  = fbm(x / S, y / S);
    himap[y * S + x] = fbmHi(x / S, y / S);
  }
  return { hmap, himap, S };
}
