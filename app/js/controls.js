import * as THREE from 'three';
import { gtaToThree, threeToGta } from './scene.js';

export class Controls {
  constructor(camera, dom, hooks = {}) {
    this.camera = camera;
    this.dom = dom;
    this.hooks = hooks;
    this.mode = 'fly';
    this.yaw = 0; this.pitch = -0.3;
    this.keys = new Set();
    this.speed = 40;
    this.velocity = new THREE.Vector3();
    this.orbit = { target: new THREE.Vector3(), dist: 30, yaw: 0, pitch: 0.5 };
    this.top = { height: 400 };
    this.looking = false;
    this.locked = false;
    this.enabled = true;
    this.currentSpeed = 0;
    this.bindEvents();
  }

  bindEvents() {
    const d = this.dom;
    d.addEventListener('contextmenu', (e) => e.preventDefault());
    d.addEventListener('mousedown', (e) => {
      if (e.button === 2 || (e.button === 1)) { this.looking = true; this.lastX = e.clientX; this.lastY = e.clientY; e.preventDefault(); }
    });
    window.addEventListener('mouseup', (e) => { if (e.button === 2 || e.button === 1) this.looking = false; });
    window.addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      let dx = 0, dy = 0;
      if (this.locked) { dx = e.movementX; dy = e.movementY; }
      else if (this.looking) { dx = e.clientX - this.lastX; dy = e.clientY - this.lastY; this.lastX = e.clientX; this.lastY = e.clientY; }
      else return;
      if (this.mode === 'orbit') { this.orbit.yaw -= dx * 0.005; this.orbit.pitch = Math.max(-1.45, Math.min(1.45, this.orbit.pitch + dy * 0.005)); }
      else if (this.mode === 'fly') { this.yaw -= dx * 0.0025; this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch - dy * 0.0025)); }
      else if (this.mode === 'top') { const k = this.top.height / 600; this.camera.position.x -= dx * k; this.camera.position.z -= dy * k; }
    });
    d.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      if (this.mode === 'orbit') this.orbit.dist = Math.max(0.5, Math.min(5000, this.orbit.dist * Math.exp(e.deltaY * 0.001)));
      else if (this.mode === 'top') this.top.height = Math.max(20, Math.min(9000, this.top.height * Math.exp(e.deltaY * 0.001)));
      else this.setSpeed(this.speed * Math.exp(-e.deltaY * 0.0012));
    }, { passive: false });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.dom;
      if (this.hooks.lockChange) this.hooks.lockChange(this.locked);
    });
    window.addEventListener('keydown', (e) => {
      if (!this.enabled || isTyping(e)) return;
      this.keys.add(e.code);
      if (!['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyC'].includes(e.code) || e.ctrlKey || e.metaKey) return;
      const a = document.activeElement;
      if (a && a !== document.body && (a.tagName === 'BUTTON' || a.tagName === 'SUMMARY' || (a.tagName === 'INPUT' && /checkbox|radio|button/.test(a.type)))) a.blur();
      e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  setSpeed(v) {
    this.speed = Math.max(0.5, Math.min(3000, v));
    if (this.hooks.speedChange) this.hooks.speedChange(this.speed);
  }

  lock() { if (this.dom.requestPointerLock) this.dom.requestPointerLock(); }
  unlock() { if (document.exitPointerLock) document.exitPointerLock(); }

  gtaPosition() { return threeToGta(this.camera.position); }
  heading() {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    const g = { x: dir.x, y: -dir.z };
    return ((Math.atan2(g.x, g.y) * 180) / Math.PI + 360) % 360;
  }

  setPose(x, y, z, yawDeg = null, pitchDeg = null) {
    this.mode = this.mode === 'orbit' ? 'fly' : this.mode;
    this.camera.position.copy(gtaToThree(x, y, z));
    if (yawDeg !== null) this.yaw = (-yawDeg * Math.PI) / 180;
    if (pitchDeg !== null) this.pitch = (pitchDeg * Math.PI) / 180;
    this.velocity.set(0, 0, 0);
    this.applyRotation();
  }

  lookAtGta(x, y, z) {
    const t = gtaToThree(x, y, z);
    const d = t.clone().sub(this.camera.position);
    this.yaw = Math.atan2(-d.x, -d.z);
    this.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
    this.applyRotation();
  }

  applyRotation() {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    this.camera.quaternion.copy(q);
  }

  startOrbit(targetGta, radius) {
    this.mode = 'orbit';
    this.orbit.target.copy(gtaToThree(targetGta.x, targetGta.y, targetGta.z));
    const off = this.camera.position.clone().sub(this.orbit.target);
    this.orbit.dist = Math.max(radius * 2.5, Math.min(off.length() || radius * 3, 400));
    this.orbit.yaw = Math.atan2(off.x, off.z);
    this.orbit.pitch = Math.max(-1.4, Math.min(1.4, Math.asin(off.length() ? off.y / off.length() : 0.5) || 0.5));
  }

  setMode(mode) {
    if (mode === 'top') {
      this.prevPose = { pos: this.camera.position.clone(), yaw: this.yaw, pitch: this.pitch };
      this.top.height = Math.max(150, this.camera.position.y + 200);
      this.camera.position.y = this.top.height;
    } else if (this.mode === 'top' && this.prevPose) {
      this.camera.position.x = this.camera.position.x;
      this.camera.position.y = Math.min(this.camera.position.y, this.prevPose.pos.y);
      this.yaw = this.prevPose.yaw; this.pitch = this.prevPose.pitch;
    } else if (this.mode === 'orbit' && mode === 'fly') {
      const dir = new THREE.Vector3();
      this.camera.getWorldDirection(dir);
      this.yaw = Math.atan2(-dir.x, -dir.z);
      this.pitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
    }
    this.mode = mode;
    if (this.hooks.modeChange) this.hooks.modeChange(mode);
  }

  update(dt) {
    dt = Math.min(dt, 0.1);
    const k = this.keys;
    const fast = k.has('ShiftLeft') || k.has('ShiftRight');
    const slow = k.has('AltLeft') || k.has('AltRight') || k.has('ControlLeft');
    const mult = fast ? 4 : slow ? 0.15 : 1;
    if (this.mode === 'orbit') {
      const o = this.orbit;
      if (k.has('KeyA')) o.yaw -= dt * 1.2;
      if (k.has('KeyD')) o.yaw += dt * 1.2;
      if (k.has('KeyW')) o.dist = Math.max(0.5, o.dist * (1 - dt * 1.5));
      if (k.has('KeyS')) o.dist = Math.min(5000, o.dist * (1 + dt * 1.5));
      const x = o.target.x + o.dist * Math.cos(o.pitch) * Math.sin(o.yaw);
      const y = o.target.y + o.dist * Math.sin(o.pitch);
      const z = o.target.z + o.dist * Math.cos(o.pitch) * Math.cos(o.yaw);
      this.camera.position.set(x, y, z);
      this.camera.lookAt(o.target);
      this.currentSpeed = 0;
      return;
    }
    if (this.mode === 'top') {
      const v = this.top.height * 0.9 * mult * dt;
      if (k.has('KeyW')) this.camera.position.z -= v;
      if (k.has('KeyS')) this.camera.position.z += v;
      if (k.has('KeyA')) this.camera.position.x -= v;
      if (k.has('KeyD')) this.camera.position.x += v;
      if (k.has('KeyE') || k.has('Space')) this.top.height = Math.max(20, this.top.height * (1 - dt));
      if (k.has('KeyQ') || k.has('KeyC')) this.top.height = Math.min(9000, this.top.height * (1 + dt));
      this.camera.position.y = this.top.height;
      this.camera.quaternion.setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0, 'YXZ'));
      this.currentSpeed = 0;
      return;
    }
    this.applyRotation();
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const want = new THREE.Vector3();
    if (k.has('KeyW')) want.add(fwd);
    if (k.has('KeyS')) want.sub(fwd);
    if (k.has('KeyD')) want.add(right);
    if (k.has('KeyA')) want.sub(right);
    if (k.has('Space') || k.has('KeyE')) want.y += 1;
    if (k.has('KeyQ') || k.has('KeyC')) want.y -= 1;
    if (want.lengthSq() > 0) want.normalize().multiplyScalar(this.speed * mult);
    const accel = want.lengthSq() > 0 ? 6 : 10;
    this.velocity.lerp(want, 1 - Math.exp(-accel * dt));
    this.camera.position.addScaledVector(this.velocity, dt);
    this.currentSpeed = this.velocity.length();
  }

  bookmark(name) {
    const p = this.gtaPosition();
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    const pitch = (Math.asin(Math.max(-1, Math.min(1, dir.y))) * 180) / Math.PI;
    return { name, x: round(p.x), y: round(p.y), z: round(p.z), yaw: round(this.heading()), pitch: round(Math.max(-89, Math.min(89, pitch))), mode: this.mode };
  }
}

const round = (v) => Math.round(v * 100) / 100;
export function isTyping(e) {
  const t = e.target;
  if (!t) return false;
  if (t.tagName === 'INPUT') return !/^(checkbox|radio|button|submit|reset|range|color|file)$/i.test(t.type);
  return t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
}
