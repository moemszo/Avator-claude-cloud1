// 描画: 合成済みのアバター画像を WebGL のメッシュ（格子）に貼り、
// 頂点をずらして顔の向き・傾き・髪の揺れ・呼吸を表現する。

const VS = `
attribute vec2 aPos;
attribute vec2 aUV;
uniform vec2 uSize;
varying vec2 vUV;
void main() {
  vec2 clip = aPos / uSize * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vUV = aUV;
}`;

const FS = `
precision mediump float;
uniform sampler2D uTex;
varying vec2 vUV;
void main() {
  gl_FragColor = texture2D(uTex, vUV);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class WarpRenderer {
  constructor(canvas, cols = 48, rows = 72) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL が使えません');
    this.gl = gl;
    this.cols = cols;
    this.rows = rows;

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    this.prog = prog;
    this.aPos = gl.getAttribLocation(prog, 'aPos');
    this.aUV = gl.getAttribLocation(prog, 'aUV');
    this.uSize = gl.getUniformLocation(prog, 'uSize');

    this.posBuf = gl.createBuffer();
    this.uvBuf = gl.createBuffer();
    this.idxBuf = gl.createBuffer();
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.clearColor = [0, 0, 0, 0];
  }

  setSize(w, h) {
    this.w = w;
    this.h = h;
    this.canvas.width = w;
    this.canvas.height = h;
    const { gl, cols, rows } = this;
    const n = (cols + 1) * (rows + 1);
    this.rest = new Float32Array(n * 2);
    this.pos = new Float32Array(n * 2);
    const uv = new Float32Array(n * 2);
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= cols; i++) {
        const k = (j * (cols + 1) + i) * 2;
        uv[k] = i / cols;
        uv[k + 1] = j / rows;
        this.rest[k] = uv[k] * w;
        this.rest[k + 1] = uv[k + 1] * h;
      }
    }
    const idx = new Uint16Array(cols * rows * 6);
    let p = 0;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const a = j * (cols + 1) + i;
        const b = a + 1;
        const c = a + cols + 1;
        const d = c + 1;
        idx.set([a, b, c, b, d, c], p);
        p += 6;
      }
    }
    this.indexCount = idx.length;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  }

  uploadTexture(source) {
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  // p: { yaw, pitch, roll, hairYaw, hairPitch, hairRoll, breath }（yaw/pitch は -1〜1 程度、roll はラジアン）
  // cfg: avatar.json（regions.head, neckY, motion）
  deform(p, cfg) {
    const head = cfg.regions.head;
    const neckY = cfg.neckY ?? head.cy + head.ry * 0.9;
    const m = cfg.motion ?? {};
    const yawPx = m.yawPx ?? 60;
    const pitchPx = m.pitchPx ?? 40;
    const rollScale = m.rollScale ?? 1;
    const bodyFollow = m.bodyFollow ?? 0.2;
    const W = this.w;
    const H = this.h;
    const px = head.cx;
    const py = neckY;
    const bodyRot = p.roll * rollScale * bodyFollow * 0.35;
    const bodyDx = p.yaw * yawPx * bodyFollow;
    const bcos = Math.cos(bodyRot);
    const bsin = Math.sin(bodyRot);
    const breath = p.breath ?? 0;

    const { rest, pos } = this;
    for (let k = 0; k < rest.length; k += 2) {
      const x = rest[k];
      const y = rest[k + 1];
      const nx = (x - head.cx) / head.rx;
      const ny = (y - head.cy) / head.ry;
      const d = Math.sqrt(nx * nx + ny * ny);
      let w = 1 - smoothstep(0.9, 1.4, d);
      if (y > neckY) w *= 1 - smoothstep(neckY, neckY + head.ry * 0.35, y);

      let ox = x;
      let oy = y;
      if (w > 0) {
        const hair = smoothstep(0.55, 1.1, d);
        const yaw = p.yaw + (p.hairYaw - p.yaw) * hair;
        const pitch = p.pitch + (p.hairPitch - p.pitch) * hair;
        const roll = (p.roll + (p.hairRoll - p.roll) * hair) * rollScale;
        const front = Math.max(0, 1 - d * d);
        const k3d = 0.35 + 0.65 * front; // 顔の中心ほど大きく動かして立体感を出す
        const dx = yaw * yawPx * k3d;
        const dy = pitch * pitchPx * k3d;
        const c = Math.cos(roll);
        const s = Math.sin(roll);
        const rx = px + (x - px) * c - (y - py) * s + dx;
        const ry = py + (x - px) * s + (y - py) * c + dy;
        ox = x + (rx - x) * w;
        oy = y + (ry - y) * w;
      }
      // 体: 呼吸（下端を基準に少し伸び縮み）と、頭につられた小さな傾き・移動
      oy = H - (H - oy) * (1 + breath);
      const bx = ox - W / 2;
      const by = oy - H;
      pos[k] = W / 2 + bx * bcos - by * bsin + bodyDx;
      pos[k + 1] = H + bx * bsin + by * bcos;
    }
  }

  draw() {
    const { gl } = this;
    gl.viewport(0, 0, this.w, this.h);
    gl.clearColor(...this.clearColor);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.prog);
    gl.uniform2f(this.uSize, this.w, this.h);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.pos, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf);
    gl.enableVertexAttribArray(this.aUV);
    gl.vertexAttribPointer(this.aUV, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
  }
}
