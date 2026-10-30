import * as THREE from 'three';
import { getBuffer, decodeModel, decodeTexture } from './api.js';

export const FLAG_DRAW_LAST = 0x4, FLAG_ADDITIVE = 0x8, FLAG_NO_ZWRITE = 0x40, FLAG_NO_CULL = 0x200000;

export const PRELIT = { ambient: { value: 0.25 }, night: { value: 0 } };

function prelitShader(mat, hasNight) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uPrelitAmbient = PRELIT.ambient;
    sh.uniforms.uNightMix = PRELIT.night;
    if (hasNight) {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 night;\nvarying vec4 vNight;')
        .replace('#include <color_vertex>', '#include <color_vertex>\n\tvNight = night;');
    }
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uPrelitAmbient;\nuniform float uNightMix;\n${hasNight ? 'varying vec4 vNight;' : ''}`)
      .replace('#include <color_fragment>', `vec4 prelit = vec4(vColor);\n${hasNight ? '\tprelit = mix(prelit, vNight, uNightMix);\n' : ''}\tdiffuseColor.rgb *= min(prelit.rgb + vec3(uPrelitAmbient), vec3(1.0));\n\tdiffuseColor.a *= prelit.a;`);
  };
  mat.customProgramCacheKey = () => (hasNight ? 'rw-prelit-night' : 'rw-prelit');
}

export function cloneMaterial(m) {
  const c = m.clone();
  c.onBeforeCompile = m.onBeforeCompile;
  c.customProgramCacheKey = m.customProgramCacheKey;
  c.userData = { ...m.userData, clone: true };
  return c;
}

export function rwMatrix(m) {
  return new THREE.Matrix4().set(m[0], m[3], m[6], m[9], m[1], m[4], m[7], m[10], m[2], m[5], m[8], m[11], 0, 0, 0, 1);
}

class Queue {
  constructor(limit) { this.limit = limit; this.items = []; this.active = 0; }
  push(job) { this.items.push(job); this.pump(); }
  pump() {
    while (this.active < this.limit && this.items.length) {
      let best = 0;
      for (let i = 1; i < this.items.length; i++) if (this.items[i].priority() < this.items[best].priority()) best = i;
      const job = this.items.splice(best, 1)[0];
      if (job.cancelled()) continue;
      this.active++;
      job.run().finally(() => { this.active--; this.pump(); });
    }
  }
  get pending() { return this.items.length; }
}

export class Assets {
  constructor(renderer) {
    this.renderer = renderer;
    this.s3tc = !!renderer.extensions.get('WEBGL_compressed_texture_s3tc');
    this.models = new Map();
    this.textures = new Map();
    this.geomQueue = new Queue(6);
    this.texQueue = new Queue(8);
    this.budget = { geometry: 512 * 1024 * 1024, texture: 1024 * 1024 * 1024 };
    this.idleLimit = 120000;
    this.lastIdleSweep = 0;
    this.bytes = { geometry: 0, texture: 0 };
    this.errors = [];
    this.evicted = { models: 0, textures: 0 };
    this.lighting = 'prelight';
    this.genMips = true;
  }

  model(key, url, ctx, priority = () => 0) {
    let a = this.models.get(key);
    if (a) { a.lastUsed = performance.now(); return a; }
    a = { key, url, ctx, state: 'queued', header: null, parts: [], refs: 0, lastUsed: performance.now(), bytes: 0, error: null, waiters: [], textures: new Set(), priority };
    this.models.set(key, a);
    this.geomQueue.push({
      priority: () => a.priority(),
      cancelled: () => a.state === 'disposed',
      run: async () => {
        a.state = 'loading';
        try {
          const buf = await getBuffer(url);
          if (a.state === 'disposed') return;
          a.header = decodeModel(buf);
          this.buildParts(a);
          a.state = 'ready';
        } catch (e) {
          a.state = 'error';
          a.error = e.message;
          this.errors.push({ key, url, error: e.message, at: Date.now() });
          if (this.errors.length > 300) this.errors.shift();
        }
        for (const w of a.waiters.splice(0)) w(a);
      },
    });
    return a;
  }

  whenReady(a) {
    if (a.state === 'ready' || a.state === 'error') return Promise.resolve(a);
    return new Promise((res) => a.waiters.push(res));
  }

  buildParts(a) {
    const h = a.header;
    const ctx = a.ctx;
    const flags = ctx.flags || 0;
    const materialsByGeo = new Map();
    for (const at of h.atomics) {
      const g = h.geometries[at.geometry];
      if (!g || !g.arrays.position || !g.arrays.index) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(g.arrays.position.slice(), 3));
      if (g.arrays.normal) geo.setAttribute('normal', new THREE.BufferAttribute(g.arrays.normal.slice(), 3));
      if (g.arrays.uv0) geo.setAttribute('uv', new THREE.BufferAttribute(g.arrays.uv0, 2));
      if (g.arrays.uv1) geo.setAttribute('uv1', new THREE.BufferAttribute(g.arrays.uv1, 2));
      const usePrelit = g.arrays.color && this.lighting === 'prelight';
      const hasNight = !!(usePrelit && g.arrays.night);
      if (usePrelit) geo.setAttribute('color', new THREE.BufferAttribute(g.arrays.color, 4, true));
      if (hasNight) geo.setAttribute('night', new THREE.BufferAttribute(g.arrays.night, 4, true));
      geo.setIndex(new THREE.BufferAttribute(g.arrays.index, 1));
      for (const gr of g.groups) geo.addGroup(gr.start, gr.count, gr.material >= 0 ? gr.material : g.materials.length);
      if (!g.arrays.normal) geo.computeVertexNormals();
      if (ctx.clump) geo.applyMatrix4(rwMatrix(at.ltm));
      geo.computeBoundingSphere();
      geo.computeBoundingBox();
      let mats = materialsByGeo.get(at.geometry + (ctx.clump ? `|${at.frame}` : ''));
      if (!mats) {
        mats = g.materials.map((m) => this.material(a, g, m, flags, !!usePrelit, hasNight));
        mats.push(new THREE.MeshBasicMaterial({ color: 0xff00ff }));
        materialsByGeo.set(at.geometry + (ctx.clump ? `|${at.frame}` : ''), mats);
      }
      const bytes = (geo.attributes.position.array.byteLength + (geo.attributes.normal ? geo.attributes.normal.array.byteLength : 0) + (geo.attributes.uv ? geo.attributes.uv.array.byteLength : 0) + (geo.attributes.color ? geo.attributes.color.array.byteLength : 0) + geo.index.array.byteLength);
      a.bytes += bytes;
      a.parts.push({ atomic: at, geometryIndex: at.geometry, name: at.name, visible: at.visible, geometry: geo, materials: mats, triangles: g.arrays.index.length / 3, sourceTriangles: g.triangles, vertices: g.vertices });
    }
    this.bytes.geometry += a.bytes;
    const visible = a.parts.filter((p) => p.visible);
    const box = new THREE.Box3();
    for (const p of visible) box.union(p.geometry.boundingBox);
    a.box = box.isEmpty() ? new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)) : box;
    a.sphere = a.box.getBoundingSphere(new THREE.Sphere());
  }

  material(a, g, m, flags, prelit, hasNight = false) {
    const modulate = g.format.includes('modulateMaterialColor');
    const color = modulate ? new THREE.Color(m.color[0] / 255, m.color[1] / 255, m.color[2] / 255) : new THREE.Color(1, 1, 1);
    const opacity = modulate ? m.color[3] / 255 : 1;
    const lit = !prelit;
    const params = { color, vertexColors: prelit, side: flags & FLAG_NO_CULL ? THREE.DoubleSide : THREE.FrontSide };
    const mat = lit ? new THREE.MeshLambertMaterial(params) : new THREE.MeshBasicMaterial(params);
    mat.wireframe = !!this.wireframe;
    if (!lit) prelitShader(mat, hasNight);
    mat.userData = { source: m, texture: null, modelKey: a.key, prelit, hasNight };
    if (opacity < 1) { mat.transparent = true; mat.opacity = opacity; mat.depthWrite = false; }
    if (flags & FLAG_ADDITIVE) { mat.transparent = true; mat.blending = THREE.AdditiveBlending; mat.depthWrite = false; }
    else if (flags & FLAG_DRAW_LAST) { mat.transparent = true; mat.depthWrite = !(flags & FLAG_NO_ZWRITE); }
    if (m.textured && m.texture) {
      const info = a.header.textures[m.texture.toLowerCase()];
      mat.userData.texture = info || { missing: true, name: m.texture };
      if (info && info.supported !== false) this.bindTexture(a, mat, info, m);
      else if (!info) mat.color.multiplyScalar(0.85);
    }
    return mat;
  }

  bindTexture(a, mat, info, m) {
    const key = `${info.rid}/${info.name.toLowerCase()}`;
    const firstUse = !a.textures.has(key);
    a.textures.add(key);
    let t = this.textures.get(key);
    if (!t) {
      t = { key, info, state: 'queued', tex: null, bytes: 0, refs: 0, lastUsed: performance.now(), waiting: [] };
      this.textures.set(key, t);
      this.texQueue.push({
        priority: () => a.priority(),
        cancelled: () => t.state === 'disposed',
        run: async () => {
          t.state = 'loading';
          try {
            const q = [this.s3tc ? '' : 'rgba=1', this.genMips ? 'mips=1' : ''].filter(Boolean).join('&');
            const buf = await getBuffer(`/api/tex/${info.rid}/${encodeURIComponent(info.name)}${q ? '?' + q : ''}`);
            if (t.state === 'disposed') return;
            t.tex = this.makeTexture(decodeTexture(buf));
            t.bytes = t.tex.userData.bytes;
            this.bytes.texture += t.bytes;
            t.state = 'ready';
            for (const fn of t.waiting.splice(0)) fn(t.tex);
          } catch (e) {
            t.state = 'error';
            this.errors.push({ key, error: e.message, at: Date.now() });
          }
        },
      });
    }
    if (firstUse) t.refs++;
    const apply = (tex) => {
      const clone = tex;
      mat.map = clone;
      const wrap = (v) => (v === 2 ? THREE.MirroredRepeatWrapping : v === 3 || v === 4 ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping);
      if (m.addressU !== null && (clone.wrapS !== wrap(m.addressU) || clone.wrapT !== wrap(m.addressV))) {
        clone.wrapS = wrap(m.addressU); clone.wrapT = wrap(m.addressV); clone.needsUpdate = true;
      }
      if (tex.userData.alpha && !mat.transparent) mat.alphaTest = 0.5;
      else if (tex.userData.alpha && mat.transparent) mat.alphaTest = 0.02;
      mat.needsUpdate = true;
    };
    if (t.state === 'ready') apply(t.tex); else t.waiting.push(apply);
  }

  makeTexture(d) {
    let tex;
    const mips = d.mips.filter((m) => m.width > 0 && m.height > 0);
    let bytes = 0;
    for (const m of mips) bytes += m.data.byteLength;
    if (d.encoding === 'rgba8') {
      tex = new THREE.DataTexture(mips[0].data, mips[0].width, mips[0].height, THREE.RGBAFormat);
      if (mips.length > 1) { tex.mipmaps = mips.map((m) => ({ data: m.data, width: m.width, height: m.height })); tex.minFilter = THREE.LinearMipmapLinearFilter; }
      else { tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter; }
    } else {
      const fmt = d.encoding === 'dxt1' ? (d.alpha ? THREE.RGBA_S3TC_DXT1_Format : THREE.RGB_S3TC_DXT1_Format) : d.encoding === 'dxt3' ? THREE.RGBA_S3TC_DXT3_Format : THREE.RGBA_S3TC_DXT5_Format;
      tex = new THREE.CompressedTexture(mips.map((m) => ({ data: m.data, width: m.width, height: m.height })), d.width, d.height, fmt);
      tex.minFilter = mips.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    }
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.NoColorSpace;
    tex.anisotropy = 4;
    tex.flipY = false;
    tex.needsUpdate = true;
    tex.userData = { ...tex.userData, alpha: d.alpha || d.encoding === 'dxt3' || d.encoding === 'dxt5', bytes, name: d.name, encoding: d.encoding, width: d.width, height: d.height, levels: mips.length, fileLevels: d.fileLevels, generatedMips: d.generatedMips || 0 };
    return tex;
  }

  retain(a) { a.refs++; a.lastUsed = performance.now(); }
  release(a) { a.refs = Math.max(0, a.refs - 1); a.lastUsed = performance.now(); }

  collect(force = false) {
    const now = performance.now();
    const over = this.bytes.geometry >= this.budget.geometry || this.bytes.texture >= this.budget.texture;
    const sweep = now - this.lastIdleSweep > 10000;
    if (!force && !over && !sweep) return 0;
    if (sweep) this.lastIdleSweep = now;
    const idle = [...this.models.values()].filter((a) => a.refs === 0 && (a.state === 'ready' || a.state === 'error') && now - a.lastUsed > 5000).sort((x, y) => x.lastUsed - y.lastUsed);
    let freed = 0;
    for (const a of idle) {
      const stale = now - a.lastUsed > this.idleLimit;
      const needRoom = this.bytes.geometry >= this.budget.geometry * 0.8 || this.bytes.texture >= this.budget.texture * 0.8;
      if (!force && !stale && !(over && needRoom)) break;
      this.disposeModel(a);
      freed++;
    }
    return freed;
  }

  disposeModel(a) {
    for (const p of a.parts) {
      p.geometry.dispose();
      for (const m of p.materials) m.dispose();
    }
    this.bytes.geometry -= a.bytes;
    for (const k of a.textures) {
      const t = this.textures.get(k);
      if (!t) continue;
      t.refs--;
      if (t.refs <= 0) {
        if (t.tex) { t.tex.dispose(); this.bytes.texture -= t.bytes; }
        t.state = 'disposed';
        this.textures.delete(k);
        this.evicted.textures++;
      }
    }
    a.state = 'disposed';
    this.models.delete(a.key);
    this.evicted.models++;
  }

  stats() {
    let ready = 0, loading = 0, failed = 0;
    for (const a of this.models.values()) { if (a.state === 'ready') ready++; else if (a.state === 'error') failed++; else loading++; }
    let texReady = 0;
    for (const t of this.textures.values()) if (t.state === 'ready') texReady++;
    return { models: this.models.size, ready, loading, failed, textures: this.textures.size, texReady, geomQueue: this.geomQueue.pending + this.geomQueue.active, texQueue: this.texQueue.pending + this.texQueue.active, bytes: this.bytes, evicted: this.evicted };
  }
}
