// 描画: 合成済みのアバター画像を WebGL のメッシュ（格子）に貼り、
// 頂点をずらして顔の向き・体の傾き・髪の揺れ・呼吸を表現する。
// 目線は、黒目の画像（iris）をずらして「黒目が見えてよい範囲」（eye_mask）の中だけに描く。

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
uniform sampler2D uIris;
uniform sampler2D uMask;
uniform vec2 uGaze;   // 黒目のずれ（テクスチャ座標）
uniform vec2 uEyeOn;  // 画面左 / 右の目で目線を使うか (0 or 1)
varying vec2 vUV;
void main() {
  vec4 c = texture2D(uTex, vUV);
  vec4 m = texture2D(uMask, vUV);
  float k = m.r * uEyeOn.x + m.g * uEyeOn.y;
  if (k > 0.0) {
    vec4 ir = texture2D(uIris, vUV - uGaze) * k;
    c = ir + c * (1.0 - ir.a);
  }
  gl_FragColor = c;
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
    this.uTex = gl.getUniformLocation(prog, 'uTex');
    this.uIris = gl.getUniformLocation(prog, 'uIris');
    this.uMask = gl.getUniformLocation(prog, 'uMask');
    this.uGaze = gl.getUniformLocation(prog, 'uGaze');
    this.uEyeOn = gl.getUniformLocation(prog, 'uEyeOn');

    this.posBuf = gl.createBuffer();
    this.uvBuf = gl.createBuffer();
    this.idxBuf = gl.createBuffer();
    this.tex = this._makeTexture();
    this.irisTex = this._makeTexture();
    this.maskTex = this._makeTexture();
    this.gaze = { x: 0, y: 0, left: 0, right: 0 }; // x, y は px
    this.hasGaze = false;
    this.clearColor = [0, 0, 0, 0];
  }

  _makeTexture() {
    const { gl } = this;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // 何も読み込まれていない間は透明 1px
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    return t;
  }

  // 目線用の画像（黒目・見えてよい範囲）。無ければ目線は使わない
  setGazeImages(iris, mask) {
    const { gl } = this;
    this.hasGaze = !!(iris && mask);
    if (!this.hasGaze) return;
    gl.bindTexture(gl.TEXTURE_2D, this.irisTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, iris);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mask);
  }

  setSize(w, h) {
    this.w = w;
    this.h = h;
    this.canvas.width = w;
    this.canvas.height = h;
    const { gl, cols, rows } = this;
    // 体を傾けても下の端にすき間ができないよう、格子は画像の下へ少しはみ出させる
    // （はみ出た所は画像の一番下の行が伸びて見える）
    const extra = 0.12;
    const n = (cols + 1) * (rows + 1);
    this.rest = new Float32Array(n * 2);
    this.pos = new Float32Array(n * 2);
    const uv = new Float32Array(n * 2);
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= cols; i++) {
        const k = (j * (cols + 1) + i) * 2;
        const yy = (j / rows) * (1 + extra);
        uv[k] = i / cols;
        uv[k + 1] = Math.min(1, yy);
        this.rest[k] = uv[k] * w;
        this.rest[k + 1] = yy * h;
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
  //
  // 動きは 2 段階:
  //  1. 体ごと（首と胴体を一体で）: 腰を支点に、向いた方向・かしげた方向へ体を傾ける
  //  2. 頭だけ: 顔のパーツを向きに合わせて少しずらす（立体感）。首から胸にかけてなだらかに弱める
  deform(p, cfg) {
    const head = cfg.regions.head;
    const neckY = cfg.neckY ?? head.cy + head.ry * 0.9;
    const m = cfg.motion ?? {};
    const yawPx = m.yawPx ?? 45;
    const pitchPx = m.pitchPx ?? 35;
    const rollScale = m.rollScale ?? 1;
    const leanPerYaw = m.leanPerYaw ?? 0.06; // 顔を左右に向けたときの体の傾き（ラジアン）
    const leanRollShare = m.leanRollShare ?? 0.5; // 首のかしげのうち、体全体の傾きで表す割合
    const bodyShiftPx = m.bodyShiftPx ?? 18; // 向いた方向への体の横移動
    const W = this.w;
    const H = this.h;

    const maxLean = m.maxLean ?? 0.1; // 傾きすぎないよう上限（約 6°）
    const lean = Math.max(-maxLean, Math.min(maxLean, p.yaw * leanPerYaw + p.roll * rollScale * leanRollShare));
    const lcos = Math.cos(lean);
    const lsin = Math.sin(lean);
    const pivotX = W / 2;
    const pivotY = H * (m.leanPivot ?? 1.1); // 腰のあたり（画面の少し下）
    const bodyDx = p.yaw * bodyShiftPx;
    const breath = p.breath ?? 0;
    const headRollShare = 1 - leanRollShare;

    // 頭だけの動きの効き具合: 頭の楕円の中は 1、首〜胸の上でなだらかに 0 へ
    const fadeTop = neckY - head.ry * 0.15;
    const fadeBottom = neckY + head.ry * 0.6;

    const { rest, pos } = this;
    for (let k = 0; k < rest.length; k += 2) {
      const x = rest[k];
      const y = rest[k + 1];
      const nx = (x - head.cx) / head.rx;
      const ny = (y - head.cy) / head.ry;
      const d = Math.sqrt(nx * nx + ny * ny);
      let w = 1 - smoothstep(0.95, 1.7, d);
      w *= 1 - smoothstep(fadeTop, fadeBottom, y);

      let ox = x;
      let oy = y;
      if (w > 0) {
        const hair = smoothstep(0.55, 1.1, d);
        const yaw = p.yaw + (p.hairYaw - p.yaw) * hair;
        const pitch = p.pitch + (p.hairPitch - p.pitch) * hair;
        const roll = (p.roll + (p.hairRoll - p.roll) * hair) * rollScale * headRollShare;
        const front = Math.max(0, 1 - d * d);
        const k3d = 0.3 + 0.7 * front; // 顔の中心ほど大きく動かして立体感を出す
        const dx = yaw * yawPx * k3d;
        const dy = pitch * pitchPx * k3d;
        const c = Math.cos(roll);
        const s = Math.sin(roll);
        const hx = head.cx;
        const hy = neckY;
        const rx = hx + (x - hx) * c - (y - hy) * s + dx;
        const ry = hy + (x - hx) * s + (y - hy) * c + dy;
        ox = x + (rx - x) * w;
        oy = y + (ry - y) * w;
      }
      // 呼吸（下を基準に少し伸び縮み）
      oy = H - (H - oy) * (1 + breath);
      // 体ごと傾ける
      const bx = ox - pivotX;
      const by = oy - pivotY;
      pos[k] = pivotX + bx * lcos - by * lsin + bodyDx;
      pos[k + 1] = pivotY + bx * lsin + by * lcos;
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
    const g = this.gaze;
    const on = this.hasGaze;
    gl.uniform2f(this.uGaze, g.x / this.w, g.y / this.h);
    gl.uniform2f(this.uEyeOn, on ? g.left : 0, on ? g.right : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.uTex, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.irisTex);
    gl.uniform1i(this.uIris, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.uniform1i(this.uMask, 2);
    gl.activeTexture(gl.TEXTURE0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.pos, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf);
    gl.enableVertexAttribArray(this.aUV);
    gl.vertexAttribPointer(this.aUV, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
  }
}
