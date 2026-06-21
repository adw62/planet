# Planet Forge

A procedural **planet sandbox / god-game** in the browser. You tweak a handful of
macro inputs — solar radiation, gravity, core heat, tectonics, and comet
impacts — and watch a physics-lite climate **simulate and evolve in real time**:
oceans fill and boil off, ice caps and mountain snow form, atmospheres build and
strip away, life greens the continents and lights up the night, clouds flow as a
fluid, and storms swirl with Coriolis. Built with vanilla JavaScript + Three.js,
no build step.

## Running

It's a static site that uses ES modules, so it needs to be served over HTTP
(opening `index.html` from `file://` won't load the modules):

```bash
cd planets
python3 -m http.server 8777
# then open http://localhost:8777
```

Three.js loads from a CDN via the import map in `index.html`.

## Controls

- **Seed / Base surface / ⊕ NEW WORLD** — generate a fresh procedural world.
- **Time** — pause / ▶ / ▶▶ / ▶▶▶ (simulation speed in Myr per second).
- **Macro sliders** — ☀ solar radiation, ⬇ gravity/mass, 🜂 core heat, ⛰ tectonics.
- **☄ Crash impactor** — pick a payload (icy → water, carbonaceous → CO₂,
  ammonia → N₂) and crash it in to deposit volatiles.
- **Readout** — live temperature, oceans, ice, atmosphere composition, magnetic
  field, habitability, and biosphere, plus the planet's current archetype.
- **🔊 Sound** — procedural space ambience + comet SFX (see Audio below).
- **⧉ Copy share link** — encodes the whole world (seed + state) into a URL.
- Drag to orbit, scroll to zoom.

### Cities & factions

Once civilization rises far enough, founding cities appear and grow into
skylines; once it rises further, each city's faction can go to war with its
nearest living rival. All of this lives **in-world**, hovering over the
cities themselves rather than in the side dashboard:

- A small **white dot** sits on every city — click it to have the camera
  track that city as the planet spins (it snaps to center first). Drag,
  zoom, and orbit all keep tracking; only a plain click on empty space (not
  on any UI) drops back to free camera.
- A **health bar** appears under a city once it's at war.
- Hovering the mouse near a city reveals two god powers: **🛡 Shield**
  (temporary damage immunity) and **⚡ Tech Rush** (instantly advance to the
  next weapon stage), each on its own cooldown. A faction under an active
  shield shows a translucent dome over its city.
- A defeated faction's entire in-world UI — dot, bar, dome, buttons —
  disappears for good.
- Once a war ends in a single living faction, that victor expands: a few new
  colonies are founded elsewhere on the planet (clear of every old or ruined
  city site), painted in the victor's colour. They're permanently
  non-combatant, so the fighting is over for good — until the world's life
  itself dies off and starts the cycle over (see below).
- If the biosphere collapses entirely (runaway heat/cold, a molten
  resurfacing...) and stays gone for a while, every city and faction is wiped
  and the planet reverts to bare terrain. Once life recovers enough for
  civilization to re-industrialize, fresh founding cities and factions appear
  and the whole rise-war-victory cycle repeats.

## How it works

The core idea: a small **state vector** evolves on a clock under real feedback
loops (greenhouse, ice–albedo, carbonate–silicate weathering, atmospheric
escape, runaway water loss, core cooling), and the renderer turns the derived
state into the visuals. Tuning is "balanced" — real shapes, but fast enough that
Earth / Venus / Mars / Snowball outcomes diverge within seconds.

### Modules (`js/`)

| File | Responsibility |
|------|----------------|
| `sim.js` | The simulation engine — pure logic, no Three.js. State + feedback loops, atmosphere composition, comet payloads. Node-testable. |
| `noise.js` | RNG + the procedural FBM heightmap (computed once per seed, cached). |
| `surface.js` | Per-pixel surface textures: diffuse (ocean depth, vegetation, snow), the detailed normal map (with ocean-flattening + pole metric correction), displacement height map, emissive (lava + nucleating city lights), specular (ocean glint). |
| `planet.js` | `PlanetView` — owns the Three meshes; maps sim state → visuals (sea level, snow, molten, atmosphere glow, aurorae); injects cloud-shadow + 3D-noise pole detail into the planet shader; throttled recolor with a cheap scorch-only fast path for war damage. Also grows founding cities/skylines and runs the inter-faction war model (health, weapon-tech stages, shield/tech-rush powers) once civilization is advanced enough; reseeds a war victor's colonies once a fight ends in a single survivor; and wipes + later refounds civilization entirely if the biosphere dies off and recovers. |
| `fluidclouds.js` | 2D stable-fluids solver (banded zonal jets, Coriolis, drifting meridional gusts) driving a GPU fractal-upscaled cloud deck; clouds flow around tall mountains. Also powers the aurora curtains. |
| `comet.js` | Comet event — flies in from the side of the camera, soft sprite dust trail, boom-flash on impact. |
| `audio.js` | Web-Audio procedural space drone + comet whoosh/boom/rumble, and an optional background-music playlist. |
| `main.js` | Wires the scene, post-processing (ACES tone mapping + bloom), UI, save/share, and the main loop. |

## Audio

All SFX are synthesised at runtime (no asset files). Browsers block audio until
a user gesture, so it unlocks on your first click.

**Background music (optional):** drop `.mp3` files into the **`sound/`** folder
and list them in **`sound/tracks.json`** — the app cycles through every track,
fading them in as a quiet bed under the SFX. The manifest is required on static
hosts (e.g. GitHub Pages) that don't serve directory listings; locally it can
fall back to the directory listing. Regenerate it with:

```bash
cd sound && ls *.mp3 | python3 -c "import sys,json;print(json.dumps([l.strip() for l in sys.stdin]))" > tracks.json
```

If there are no tracks it falls back to the synth drone.

## Notes

- One planet is rendered at a time, so the heightmap, normal (1024²) and
  displacement are generated once per world; only the cheap recolor re-runs as
  the climate changes.
- The fluid sim runs at a low resolution (96×48) at ~30 Hz and is upscaled with
  fractal detail in the cloud shader.
