// ─────────────────────────────────────────────────────────────
// Comet — a player "macro event". Flies in from a point chosen to
// actually be on-screen, streaks a trail, impacts the planet, and
// fires an onImpact() callback (which deposits volatiles into the sim).
// First of several planned events (volcanic pulse, solar flare…).
// ─────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { getImpactTex } from './surface.js';

// soft round particle for the dust trail (so points aren't hard squares)
let _dotTex = null;
function softDotTex() {
  if (_dotTex) return _dotTex;
  const S = 64, c = document.createElement('canvas'); c.width = c.height = S;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(S/2, S/2, 0, S/2, S/2, S/2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.85)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
  return _dotTex = new THREE.CanvasTexture(c);
}

export class CometController {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.comet = null;
    this.fx = [];
  }

  get busy() { return !!this.comet; }

  // Impact on the camera-facing hemisphere; the comet ORIGINATES off to the side
  // of (and just behind) the camera, then flies INWARD toward the impact — so it
  // travels in the viewing direction but enters the frame from the side, with a
  // random up/down angle. (Not a lateral slide across the screen.)
  _pickPath(radius) {
    const cam = this.camera;
    const camDir = cam.position.clone().normalize();       // planet → camera
    const camFwd = camDir.clone().negate();                // camera → planet (view dir)
    let right = new THREE.Vector3().crossVectors(camFwd, new THREE.Vector3(0,1,0));
    if (right.lengthSq() < 1e-6) right.set(1,0,0);
    right.normalize();
    const up = new THREE.Vector3().crossVectors(right, camFwd).normalize();

    // impact point on the visible hemisphere
    let axis = new THREE.Vector3(Math.random()-0.5, Math.random()-0.5, Math.random()-0.5);
    axis = axis.sub(camDir.clone().multiplyScalar(axis.dot(camDir)));
    if (axis.lengthSq() < 1e-6) axis.set(1,0,0);
    axis.normalize();
    const dir = camDir.clone().applyAxisAngle(axis, Math.random()*THREE.MathUtils.degToRad(24)).normalize();
    const impactPoint = dir.clone().multiplyScalar(radius);

    // start beside-and-slightly-behind the camera, random side + up/down tilt
    const side = Math.random() < 0.5 ? -1 : 1;
    const lateral = right.clone().multiplyScalar(side)
      .addScaledVector(up, (Math.random()-0.5) * 0.8)
      .normalize();
    const camDist = cam.position.length();
    const startPoint = cam.position.clone()
      .addScaledVector(camDir, 4 + Math.random()*6)                    // a touch further out than the camera
      .addScaledVector(lateral, camDist * (0.4 + Math.random()*0.2));  // off to the side
    return { impactPoint, startPoint };
  }

  fire(radius, onImpact, color = 0x8a6a44) {
    if (this.comet) return;
    const { impactPoint, startPoint } = this._pickPath(radius);
    const payload = new THREE.Color(color);
    // a dusty brown nucleus with a faint hint of its payload colour
    const headCol = new THREE.Color(0x6e4d33).lerp(payload, 0.28);
    const head = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.45, 1),
      new THREE.MeshPhongMaterial({
        color: headCol, emissive: new THREE.Color(0x2c1c10), emissiveIntensity: 0.5,
        shininess: 4, flatShading: true,                 // faceted dusty rock
      }),
    );
    head.position.copy(startPoint);
    this.scene.add(head);

    // bright warm trail (hot near the head, fades out) — values >1 so it blooms
    const tint = new THREE.Color(1.7, 1.15, 0.6).lerp(payload, 0.12);
    // trail = a lagging pool of soft round SPRITES (reliable; depthTest off so
    // the planet never clips them)
    const N = 28;
    const trail = [];
    const pos = new Float32Array(N*3);
    for (let i=0;i<N;i++){ pos[i*3]=startPoint.x; pos[i*3+1]=startPoint.y; pos[i*3+2]=startPoint.z;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: softDotTex(), transparent:true, depthTest:false, depthWrite:false,
        blending:THREE.AdditiveBlending, opacity:0,
      }));
      sp.material.color.copy(tint);
      sp.position.copy(startPoint); sp.scale.setScalar(0.001);
      this.scene.add(sp); trail.push(sp);
    }
    this.comet = { head, trail, pos, N, start:startPoint, end:impactPoint, t:0, dur:1.2+Math.random()*0.4, onImpact, tint };
  }

  _spawnFlash(point) {
    const lifted = point.clone().multiplyScalar(1.04);   // just above the surface
    const add = (color, s0, s1, dur) => {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map:getImpactTex(), color, transparent:true, depthTest:false, depthWrite:false,
        blending:THREE.AdditiveBlending, opacity:1,
      }));
      sp.position.copy(lifted); sp.scale.setScalar(s0);
      this.scene.add(sp);
      this.fx.push({ sprite: sp, age:0, dur, s0, s1 });
    };
    add(0xfff4e0, 0.6, 4.5, 0.30);   // hot bright core pop
    add(0xff9a40, 1.4, 12.0, 0.85);  // expanding warm glow
  }

  _disposeComet(c) {
    this.scene.remove(c.head); c.head.geometry.dispose(); c.head.material.dispose();
    for (const sp of c.trail) { this.scene.remove(sp); sp.material.dispose(); }
  }

  _endComet() {
    const c = this.comet;
    this._disposeComet(c);
    this._spawnFlash(c.end);
    this.comet = null;
    c.onImpact?.();
  }

  update(dt) {
    const c = this.comet;
    if (c) {
      c.t += dt;
      const u = Math.min(1, c.t/c.dur);
      const p = c.start.clone().lerp(c.end, u);
      c.head.position.copy(p);
      c.head.rotation.x += dt*5; c.head.rotation.y += dt*4;
      // shift the position history back one and drop the head in at the front
      for (let i=c.N-1;i>0;i--){
        c.pos[i*3]=c.pos[(i-1)*3]; c.pos[i*3+1]=c.pos[(i-1)*3+1]; c.pos[i*3+2]=c.pos[(i-1)*3+2];
      }
      c.pos[0]=p.x; c.pos[1]=p.y; c.pos[2]=p.z;
      // place + fade + taper each trail sprite (bright at the head)
      for (let i=0;i<c.N;i++){
        const sp=c.trail[i], frac=1 - i/c.N;
        sp.position.set(c.pos[i*3], c.pos[i*3+1], c.pos[i*3+2]);
        sp.material.opacity = frac*frac;
        sp.scale.setScalar(0.25 + frac*1.7);
      }
      if (u >= 1) this._endComet();
    }
    for (let i=this.fx.length-1;i>=0;i--){
      const f=this.fx[i]; f.age+=dt; const t=f.age/f.dur;
      f.sprite.scale.setScalar(f.s0 + (f.s1 - f.s0) * t);
      f.sprite.material.opacity = Math.max(0, 1 - t*t);   // hold bright, then fade
      if (t>=1){ this.scene.remove(f.sprite); f.sprite.material.dispose(); this.fx.splice(i,1); }
    }
  }

  cancel() {
    if (this.comet){
      this._disposeComet(this.comet);
      this.comet = null;
    }
    for (const f of this.fx){ this.scene.remove(f.sprite); f.sprite.material.dispose(); }
    this.fx = [];
  }
}
