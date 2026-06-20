// ─────────────────────────────────────────────────────────────
// PLANET SIMULATION ENGINE  (pure logic — no THREE, no DOM)
//
// A planet is a small state vector that evolves over a simulation
// clock (time in Myr). The player perturbs a handful of MACRO inputs
// (solar flux, gravity, core heat, tectonic drive, comet water); the
// engine integrates physics-lite feedback loops and produces the
// DERIVED properties the renderer turns into a living surface.
//
// The feedback loops are what make a planet feel alive:
//   • greenhouse      CO2 ↑ → temp ↑                       (forcing)
//   • ice–albedo      temp ↓ → ice ↑ → brighter → temp ↓   (+, runaway → snowball)
//   • weathering      warm + liquid water → CO2 drawdown    (−, stabilizing → habitable)
//   • atmos. escape   weak field + low gravity + hot → air bleeds to space (Mars)
//   • water runaway   hot + water → vapor (a greenhouse gas) → hotter → boil-off (Venus)
//   • core cooling    small/old core → no dynamo → no field → escape
//
// Tuned "balanced": real shapes, but fast — outcomes diverge in seconds.
// ─────────────────────────────────────────────────────────────

// Tunable constants. Time unit is Myr. These are picked so that at the
// default sim speed (~40 Myr/s) Earth/Venus/Mars/Snowball attractors
// separate within a few seconds of real time.
export const K = {
  coreInject:  0.046,   // core heat added per Myr per unit of player "core heat"
  coreCool:    0.060,   // Newtonian core cooling (faster for low-mass planets)
  tectRelax:   0.30,    // how fast tectonics tracks its driver
  outgas:      0.046,   // CO2 outgassed per unit volcanism per Myr (tectonics → air)
  weather:     0.0042,  // CO2 drawn down per °C-above-freezing per Myr, ×ocean coverage
  escape:      0.105,   // atmospheric escape rate when the magnetic shield is down
  iceRelax:    0.18,    // how fast ice caps grow/shrink toward target
  oceanRelax:  0.16,    // how fast shorelines track the liquid-water target
  waterBoil:   0.055,   // water lost to space per Myr when boiling
  cometWater:  0.16,    // ocean inventory added per comet impact
};

// ── small math helpers ───────────────────────────────────────
export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
// smoothstep ramp from edge0→edge1
function smooth(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}
// time-correct exponential relax of `cur` toward `target`
function relax(cur, target, rate, dt) {
  return cur + (target - cur) * clamp01(rate * dt);
}

// ── physical sub-models ──────────────────────────────────────
// Bare-rock equilibrium temperature (K) from stellar flux + albedo.
// Calibrated so S=1, albedo=0.3 → ~255 K (Earth's no-greenhouse temp).
function equilTemp(S, albedo) {
  return 278.3 * Math.pow(Math.max(1e-3, S * (1 - albedo)), 0.25);
}
// Greenhouse warming (K) — saturating in CO2 (log), plus a strong,
// near-linear water-vapor term that enables the Venusian runaway.
function greenhouse(co2, waterVapor) {
  return 40 * Math.log(1 + co2 / 0.4) + 180 * waterVapor;
}

// ── factory ──────────────────────────────────────────────────
// Returns a fresh planet. `inputs` are the live player knobs and are
// mutated directly by the UI between steps.
export function createSim() {
  return {
    age: 0,                 // Myr elapsed

    // ── player inputs (set live by UI) ──
    solarFlux:     1.0,     // stellar flux, ×Earth
    gravity:       1.0,     // surface gravity / planet mass proxy, ×Earth
    coreHeat:      0.8,     // 0..1 how hard the player drives the core
    tectonicInput: 0.5,     // 0..1 tectonic/volcanic drive

    // ── integrated state ──
    coreTemp:   0.85,       // 0..1 internal heat
    tectonics:  0.40,       // 0..1 effective tectonic activity
    waterMass:  0.0,        // ocean inventory (0..~2), grown by comets
    co2:        0.55,       // greenhouse-gas inventory (relative)
    n2:         1.0,        // inert atmosphere mass (relative)

    // ── derived (filled each step) ──
    surfaceTemp:   288,     // K
    waterVapor:    0.0,     // 0..1 vapor fraction (greenhouse feedback)
    albedo:        0.30,
    iceCoverage:   0.05,    // 0..1 fraction of surface under ice (poles-in)
    oceanCoverage: 0.0,     // 0..1 fraction of surface under liquid water
    atmosphere:    1.55,    // total atmospheric mass (relative)
    magneticField: 0.8,     // 0..1 dynamo strength (escape shield)
    volcanism:     0.4,     // 0..1 instantaneous eruptive activity
    molten:        0.0,     // 0..1 glowing-magma surface fraction
    habitability:  0.0,     // 0..1 life-supporting score
    biosphere:     0.0,     // 0..1 how alive/green the surface is (lags climate)
    civilization:  0.0,     // 0..1 technological life → night-side city lights
    archetype:     'Temperate',
  };
}

// ── one integration step. dt in Myr. ─────────────────────────
// Feedback terms use last tick's derived values (explicit Euler);
// this is stable and lets runaways build over successive ticks.
export function stepSim(s, dt) {
  const mass = s.gravity;                       // gravity stands in for mass
  const Tprev = s.surfaceTemp;

  // 1. Core temperature — driven up by the player, cooled Newtonianly
  //    (faster for low-mass worlds → small planets die young, like Mars).
  const dCore = K.coreInject * s.coreHeat - K.coreCool / (0.3 + mass) * s.coreTemp;
  s.coreTemp = clamp01(s.coreTemp + dCore * dt);

  // 2. Magnetic dynamo — needs a hot, convecting core AND enough mass.
  s.magneticField = smooth(0.32, 0.58, s.coreTemp) * smooth(0.25, 0.9, mass);

  // 3. Tectonics / volcanism — the player asks, but a cold core can't deliver.
  const tectTarget = s.tectonicInput * smooth(0.2, 0.5, s.coreTemp);
  s.tectonics = relax(s.tectonics, tectTarget, K.tectRelax, dt);
  // episodic eruptions ride on top for visual life
  const pulse = 0.5 + 0.5 * Math.sin(s.age * 0.7 + 1.3) * Math.sin(s.age * 0.17);
  s.volcanism = clamp01(s.tectonics * (0.7 + 0.3 * pulse));

  // 4. Atmospheric escape — the magnetic field is a SHIELD. Squaring
  //    (1−field) means a partial field still protects well, but a dead
  //    core (drop the "core heat" slider) throws the gates open and the
  //    atmosphere bleeds to space within tens of Myr. Low gravity, a
  //    strong sun and high heat all make it worse.
  const shieldGap = (1 - s.magneticField) * (1 - s.magneticField);
  const escapeFactor =
    s.solarFlux * shieldGap * (1 / Math.max(0.2, mass)) *
    (0.4 + smooth(250, 600, Tprev));

  // 5. Carbon cycle: volcanic outgassing vs. weathering drawdown vs. escape.
  //    Weathering scales with ocean coverage, so as a warming world loses its
  //    oceans the thermostat fails — opening the door to a runaway greenhouse.
  const outgas   = K.outgas * s.volcanism;
  const weather  = K.weather * Math.max(0, Tprev - 273) * s.oceanCoverage;   // stabilizing
  const co2Esc   = K.escape * escapeFactor * s.co2 * 0.5;
  s.co2 = Math.max(0, s.co2 + (outgas - weather - co2Esc) * dt);

  // 6. Inert gas (N2): a mostly-primordial reservoir with only a trickle
  //    of volcanic resupply — so it stays ~stable and only escape thins it.
  //    (This keeps it from swamping CO2, the real dynamic greenhouse gas:
  //    Earth ends N2-dominated, a runaway Venus ends CO2-dominated.)
  const n2Esc = K.escape * escapeFactor * s.n2 * 0.25;
  s.n2 = Math.max(0.02, s.n2 + (0.04 * outgas - n2Esc) * dt);

  // 7. Water vapor — rises sharply once a wet planet warms past ~300 K.
  //    This is the engine of the runaway greenhouse.
  s.waterVapor = clamp01(smooth(290, 370, Tprev)) * clamp01(s.waterMass) * 0.9;

  // 8. Total air + albedo. Ice brightens, ocean darkens, clouds brighten.
  s.atmosphere = s.n2 + s.co2 + s.waterVapor;
  const cloud = clamp01(0.25 * s.waterVapor + 0.12 * smooth(0.2, 2.5, s.atmosphere));
  s.albedo = clamp(
    0.30 + 0.36 * s.iceCoverage - 0.10 * s.oceanCoverage + 0.22 * cloud,
    0.07, 0.85,
  );

  // 9. NEW surface temperature.
  const T = equilTemp(s.solarFlux, s.albedo) + greenhouse(s.co2, s.waterVapor);
  s.surfaceTemp = T;

  // 10. Ice & ocean coverage relax toward temperature-set targets. Oceans
  //     start receding well before the boiling point and are gone by ~375 K —
  //     so a warming world loses its oceans fast, which shuts off weathering
  //     (CO2 then builds) and tips it into a true runaway rather than parking
  //     at the boil edge with oceans intact.
  // Boiling point falls with atmospheric pressure: thin air can't hold liquid
  // water, so a low-pressure or stripped world boils its oceans off even when
  // only mildly warm (a near-vacuum is dry like Mars). Drops the thresholds by
  // up to ~95 K as the atmosphere thins toward vacuum.
  const pDrop = (1 - smooth(0.3, 1.5, s.atmosphere)) * 95;
  const waterFrac  = clamp01(s.waterMass);
  const liquidWin  = smooth(263, 283, T) * (1 - smooth(318 - pDrop, 375 - pDrop, T)); // frozen↔boiled
  const iceTarget  = clamp01((286 - T) / 58) * (0.4 + 0.6 * waterFrac);
  const oceanTarget = Math.min(0.92, waterFrac * liquidWin);
  s.iceCoverage   = relax(s.iceCoverage, iceTarget, K.iceRelax, dt);
  s.oceanCoverage = relax(s.oceanCoverage, oceanTarget, K.oceanRelax, dt);

  // 11. Water is permanently lost to space while boiling (→ a dry Venus, or a
  //     dried-out airless world). Starts below the (pressure-adjusted) boiling
  //     point and ramps hard so it doesn't self-limit at a stable warm-wet state.
  const boil = smooth(330 - pDrop, 400 - pDrop, T);
  if (boil > 0) {
    s.waterMass = Math.max(0, s.waterMass - K.waterBoil * boil / Math.max(0.3, mass) * dt);
  }

  // 12. Molten surface when truly infernal, or from an over-stoked young core.
  s.molten = clamp01(Math.max(smooth(1100, 1500, T), smooth(0.96, 1.0, s.coreTemp) * 0.5));

  // 13. Habitability — temperate, wet, and breathable-pressured.
  const tempScore  = smooth(268, 283, T) * (1 - smooth(305, 330, T));
  const waterScore = smooth(0.08, 0.25, s.oceanCoverage) * (1 - smooth(0.9, 0.98, s.oceanCoverage));
  const atmScore   = smooth(0.3, 0.8, s.atmosphere) * (1 - smooth(8, 14, s.atmosphere));
  s.habitability = clamp01(tempScore * waterScore * atmScore) * (1 - smooth(0.15, 0.4, s.molten));

  // 14. Life — a biosphere spreads toward what the climate can support, but
  //     slowly (greening takes time) and dies back faster when you wreck it.
  //     A civilization only emerges after a long, rich, stable biosphere.
  const lifeRate = s.habitability > s.biosphere ? 0.014 : 0.06;   // grow slow, die fast
  s.biosphere = clamp01(s.biosphere + (s.habitability - s.biosphere) * clamp01(lifeRate * dt));
  const civTarget = smooth(0.55, 0.85, s.biosphere);
  const civRate = civTarget > s.civilization ? 0.006 : 0.05;
  s.civilization = clamp01(s.civilization + (civTarget - s.civilization) * clamp01(civRate * dt));

  s.archetype = classify(s);
  s.age += dt;
  return s;
}

// Human-readable "what kind of world is this right now".
export function classify(s) {
  const T = s.surfaceTemp;
  if (s.molten > 0.3 || T > 1000)                          return 'Molten';
  if (T > 330 && s.oceanCoverage < 0.05 && s.co2 > 3)      return 'Venusian — runaway greenhouse';
  if (s.iceCoverage > 0.75)                                return 'Snowball';
  if (s.atmosphere < 0.7 && T < 265)                       return 'Martian — frozen & airless';
  if (s.civilization > 0.35)                               return 'Inhabited — technological';
  if (s.biosphere > 0.4)                                   return 'Living world';
  if (s.habitability > 0.45)                               return 'Temperate — habitable';
  if (s.oceanCoverage > 0.6)                               return 'Ocean world';
  if (T > 330)                                             return 'Hot desert';
  if (T < 250)                                             return 'Frozen';
  return 'Barren';
}

// Break the atmosphere into its constituent gases for display + for
// tinting the visual haze/glow. Returns fractions that sum to 1, the
// total surface pressure (relative bar), and whether it's effectively
// a vacuum. Colors are the "look" of each gas in the sky.
export function atmosphereInfo(s) {
  const gases = [
    { key: 'N₂',  mass: s.n2,         colorHex: '#6f8cc0' },  // inert — Rayleigh blue
    { key: 'CO₂', mass: s.co2,        colorHex: '#cda257' },  // greenhouse — tan/ochre
    { key: 'H₂O', mass: s.waterVapor, colorHex: '#cfe6f2' },  // vapor — pale white
  ];
  const total = gases.reduce((a, g) => a + g.mass, 0);
  const denom = total || 1;
  for (const g of gases) g.frac = g.mass / denom;
  return { total, gases, airless: total < 0.12 };
}

// Impactor catalog — comets/asteroids carry different volatiles, so the
// player can build a specific kind of world by choosing what to throw at
// it. `color` tints the comet + trail; `apply` deposits its payload.
export const COMET_TYPES = [
  { id: 'ice',     label: '❄ Icy — water',      color: 0xbfe6ff,
    apply: (s) => { s.waterMass += 0.18; s.co2 += 0.02; } },
  { id: 'carbon',  label: '⬤ Carbonaceous — CO₂', color: 0x7a6450,
    apply: (s) => { s.co2 += 0.22; s.n2 += 0.03; s.waterMass += 0.03; } },
  { id: 'ammonia', label: '◇ Ammonia — N₂',      color: 0x8fe6d6,
    apply: (s) => { s.n2 += 0.20; s.waterMass += 0.04; s.co2 += 0.02; } },
];

// Deposit the chosen impactor's payload into the planet.
export function cometImpact(s, typeId = 'ice') {
  (COMET_TYPES.find((c) => c.id === typeId) ?? COMET_TYPES[0]).apply(s);
}
