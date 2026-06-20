// ─────────────────────────────────────────────────────────────
// SpaceAudio — procedurally synthesised sound (Web Audio API), so there
// are no asset files to load. A low evolving drone for the "space mood"
// and a boom + noise burst for comet impacts. Everything is routed through
// a limiter so impacts can't clip over the ambience.
//
// Browsers block audio until a user gesture, so call resume() from a click.
// ─────────────────────────────────────────────────────────────
export class SpaceAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
  }

  // Lazily build the graph + start the ambience (safe to call repeatedly).
  _ensure() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain();
    this.master.gain.value = 0;                       // fade in on resume()
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8; limiter.ratio.value = 14; limiter.attack.value = 0.003;
    this.master.connect(limiter); limiter.connect(ctx.destination);
    this._startAmbience();
  }

  // Call on a user gesture (autoplay policy) to unlock + fade in.
  resume() {
    this._ensure();
    const ctx = this.ctx;
    // ctx.resume() is async — start the music once it's actually running (not now,
    // when it may still be suspended), and also try immediately if already running.
    if (ctx.state !== 'running') ctx.resume().then(() => this._maybeStartBg()).catch(() => {});
    this._maybeStartBg();
    this.master.gain.setTargetAtTime(this.enabled ? 0.55 : 0, ctx.currentTime, 0.3);
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.ctx) this.master.gain.setTargetAtTime(on ? 0.5 : 0, this.ctx.currentTime, 0.3);
  }

  // ── ambience: low drone WITH audible mid harmonics (so it's reproduced on
  //    laptop/phone speakers, not just sub-bass), swept filter + cosmic wind ──
  _startAmbience() {
    const ctx = this.ctx;
    const bus = ctx.createGain(); bus.gain.value = 0.32; bus.connect(this.master);
    this.ambBus = bus;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 700; lp.Q.value = 1.4; lp.connect(bus);
    // a low chord whose upper partials (165, 220 Hz) carry on small speakers
    for (const [f, g] of [[55, 0.30], [110, 0.22], [164.8, 0.15], [220, 0.11]]) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      const og = ctx.createGain(); og.gain.value = g;
      o.connect(og); og.connect(lp); o.start();
    }
    // slow filter sweep so the drone breathes
    const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.04;
    const lfoG = ctx.createGain(); lfoG.gain.value = 340;
    lfo.connect(lfoG); lfoG.connect(lp.frequency); lfo.start();

    // "cosmic wind" — band-passed noise that shimmers (audible mid band)
    const wind = ctx.createBiquadFilter(); wind.type = 'bandpass'; wind.frequency.value = 700; wind.Q.value = 0.5;
    const windG = ctx.createGain(); windG.gain.value = 0.06;
    this._loopNoise().connect(wind); wind.connect(windG); windG.connect(bus);
    const wlfo = ctx.createOscillator(); wlfo.frequency.value = 0.06;
    const wlfoG = ctx.createGain(); wlfoG.gain.value = 0.04;
    wlfo.connect(wlfoG); wlfoG.connect(windG.gain); wlfo.start();
  }

  // ── whoosh as the comet flies in (rising→falling band of noise) ──
  playWhoosh() {
    if (!this.ctx || !this.enabled) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const noise = this._noise(1.4);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.1;
    bp.frequency.setValueAtTime(280, t);
    bp.frequency.exponentialRampToValueAtTime(2000, t + 0.55);   // approaching
    bp.frequency.exponentialRampToValueAtTime(260, t + 1.3);     // receding
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.45, t + 0.55);         // swells as it passes
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
    noise.connect(bp); bp.connect(g); g.connect(this.master);
  }

  // ── comet impact: punchy boom + body thump + a long low rumble ──
  playImpact() {
    if (!this.ctx || !this.enabled) return;
    const ctx = this.ctx, t = ctx.currentTime;

    // deep boom — weighty low sine sweeping down with a real tail (not a pop)
    const boom = ctx.createOscillator(); boom.type = 'sine';
    boom.frequency.setValueAtTime(90 * (0.9 + Math.random()*0.2), t);
    boom.frequency.exponentialRampToValueAtTime(26, t + 0.5);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.0001, t);
    bg.gain.linearRampToValueAtTime(1.0, t + 0.02);
    bg.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    boom.connect(bg); bg.connect(this.master); boom.start(t); boom.stop(t + 1.15);

    // body thump — the "hit"
    const thump = ctx.createOscillator(); thump.type = 'triangle';
    thump.frequency.setValueAtTime(165, t);
    thump.frequency.exponentialRampToValueAtTime(52, t + 0.25);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.0001, t);
    tg.gain.linearRampToValueAtTime(0.5, t + 0.01);
    tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    thump.connect(tg); tg.connect(this.master); thump.start(t); thump.stop(t + 0.45);

    // RUMBLE — heavily low-passed noise, slow ~2.5s decay, tremolo for texture
    const rumble = this._noise(2.8);
    const rlp = ctx.createBiquadFilter(); rlp.type = 'lowpass';
    rlp.frequency.setValueAtTime(420, t);
    rlp.frequency.exponentialRampToValueAtTime(80, t + 1.6);
    const rg = ctx.createGain();
    rg.gain.setValueAtTime(0.0001, t);
    rg.gain.exponentialRampToValueAtTime(0.6, t + 0.06);
    rg.gain.exponentialRampToValueAtTime(0.0001, t + 2.6);
    const trem = ctx.createOscillator(); trem.frequency.value = 16;
    const tremG = ctx.createGain(); tremG.gain.value = 0.22;
    trem.connect(tremG); tremG.connect(rg.gain); trem.start(t); trem.stop(t + 2.7);
    rumble.connect(rlp); rlp.connect(rg); rg.connect(this.master);
  }

  // ── background playlist — loads EVERY .mp3 in a folder and cycles through
  //    them, fading over the procedural drone. Reads the server's directory
  //    listing, so just dropping files in the folder picks them up. ──
  setBackgroundFolder(url) {
    this._bgFolder = url;
    // Prefer a manifest (sound/tracks.json) — required on static hosts like
    // GitHub Pages that don't serve directory listings. Fall back to parsing a
    // directory listing (works with `python -m http.server` for local dev).
    fetch(url + 'tracks.json')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(names => {
        if (!Array.isArray(names) || !names.length) throw 0;
        this._playlist = names.map(n => url + encodeURIComponent(n));
        this._maybeStartBg();
      })
      .catch(() => this._loadFromListing(url));
  }
  _loadFromListing(url) {
    fetch(url).then(r => r.text()).then(html => {
      const re = /href="([^"?]+\.mp3)"/gi, list = []; let m;
      while ((m = re.exec(html))) list.push(url + m[1]);
      this._playlist = list;
      this._maybeStartBg();
    }).catch(() => { this._playlist = []; });   // nothing found → keep the drone
  }
  _maybeStartBg() {
    if (!this.ctx || this.ctx.state !== 'running' || !this._playlist || !this._playlist.length) return;
    if (!this._bgEl) {                                           // build the media node once
      const el = new Audio(); el.crossOrigin = 'anonymous'; this._bgEl = el;
      el.addEventListener('ended', () => this._playNext());      // advance when a track ends
      try {
        const g = this.ctx.createGain(); g.gain.value = 0;
        this.ctx.createMediaElementSource(el).connect(g); g.connect(this.master);
        this._bgGain = g;
      } catch (e) { /* ignore */ }
      this._bgIdx = -1;
    }
    if (!this._bgPlaying) this._playNext();                      // (re)try until it actually plays
  }
  _playNext() {
    if (!this._bgEl || !this._playlist.length) return;
    this._bgIdx = (this._bgIdx + 1) % this._playlist.length;     // cycle, wrapping round
    this._bgEl.src = this._playlist[this._bgIdx];
    this._bgEl.play().then(() => {
      this._bgPlaying = true;
      if (this._bgGain) this._bgGain.gain.setTargetAtTime(0.38, this.ctx.currentTime, 1.2); // quiet bed under the SFX
      if (this.ambBus) this.ambBus.gain.setTargetAtTime(0.04, this.ctx.currentTime, 1.5);   // duck drone
    }).catch(() => { this._bgPlaying = false; });                // blocked → retry next gesture
  }

  _noise(dur) {
    const ctx = this.ctx, len = (ctx.sampleRate * dur) | 0;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf; src.start();
    return src;
  }
  _loopNoise() {
    const ctx = this.ctx, len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true; src.start();
    return src;
  }
}
