// アバターの合成: 基本画像（base）の上に、目・口・表情の差分画像を
// 楕円の範囲（ふちをぼかしたマスク）だけ切り抜いて重ねる。

export const EYE_STATES = ['open', 'half', 'closed'];
export const MOUTH_STATES = ['closed', 'a', 'i', 'u', 'e', 'o'];

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null); // 無い画像は代替で済ませる
    img.src = src;
  });
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

export class Avatar {
  constructor() {
    this.config = null;
    this.images = {};
    this.cutouts = new Map();
    this.comp = null;
    this.baseUrl = 'avatar/';
  }

  async load(configUrl = 'avatar/avatar.json') {
    const res = await fetch(configUrl, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${configUrl} を読み込めません (${res.status})`);
    this.config = await res.json();
    this.baseUrl = configUrl.replace(/[^/]*$/, '');
    const entries = Object.entries(this.config.parts);
    const loaded = await Promise.all(
      entries.map(([, file]) => loadImage(this.baseUrl + file + `?v=${Date.now()}`))
    );
    this.images = {};
    entries.forEach(([key], i) => {
      if (loaded[i]) this.images[key] = loaded[i];
    });
    if (!this.images.base) throw new Error('基本画像 (base) が読み込めません: ' + this.config.parts.base);

    const { width, height } = this.config.canvas;
    this.comp = makeCanvas(width, height);
    this.rebake();
    return this;
  }

  get width() {
    return this.config.canvas.width;
  }
  get height() {
    return this.config.canvas.height;
  }

  missingParts() {
    return Object.keys(this.config.parts).filter((k) => !this.images[k]);
  }

  // 楕円範囲の切り抜きを作り直す（範囲や位置合わせを変えたら呼ぶ）
  rebake() {
    this.cutouts.clear();
    this._lastKey = null;
  }

  _cutout(imageKey, regionName) {
    const id = imageKey + '@' + regionName;
    if (this.cutouts.has(id)) return this.cutouts.get(id);
    const img = this.images[imageKey];
    const r = this.config.regions[regionName];
    if (!img || !r) {
      this.cutouts.set(id, null);
      return null;
    }
    const feather = Math.max(1, this.config.feather ?? 12);
    const x0 = Math.floor(r.cx - r.rx);
    const y0 = Math.floor(r.cy - r.ry);
    const c = makeCanvas(r.rx * 2 + 2, r.ry * 2 + 2);
    const ctx = c.getContext('2d');
    const a = this.config.align?.[imageKey] ?? { dx: 0, dy: 0 };
    ctx.drawImage(img, -x0 + (a.dx || 0), -y0 + (a.dy || 0), this.width, this.height);

    // ふちをぼかした楕円マスク
    ctx.globalCompositeOperation = 'destination-in';
    ctx.save();
    ctx.translate(r.cx - x0, r.cy - y0);
    ctx.scale(r.rx, r.ry);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    const inner = Math.max(0, 1 - feather / Math.min(r.rx, r.ry));
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(inner, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const out = { canvas: c, x: x0, y: y0 };
    this.cutouts.set(id, out);
    return out;
  }

  _draw(ctx, imageKey, regionName, alpha = 1) {
    const cut = this._cutout(imageKey, regionName);
    if (!cut || alpha <= 0) return;
    ctx.globalAlpha = alpha;
    ctx.drawImage(cut.canvas, cut.x, cut.y);
    ctx.globalAlpha = 1;
  }

  expression(index) {
    return this.config.expressions?.[index] ?? { name: '通常', image: null, eyeTracking: true };
  }

  // 目線（黒目を動かす）が使えるか。黒目の画像があり、今の表情が基本の目を使う時だけ
  gazeAvailable(expressionIndex) {
    if (!(this.images.eye_socket && this.images.iris && this.images.eye_mask)) return false;
    const exp = this.expression(expressionIndex);
    return exp.gaze ?? !exp.image;
  }

  // 目線を使う目 { left, right }（0 or 1）
  gazeEyes(state) {
    if (!this.gazeAvailable(state.expression)) return { left: 0, right: 0 };
    return { left: state.eyeL === 'open' ? 1 : 0, right: state.eyeR === 'open' ? 1 : 0 };
  }

  // 目の状態に対応する画像（無ければ近いもので代用）
  eyeImage(state, gaze = false) {
    if (state === 'open') return gaze ? 'eye_socket' : null;
    if (state === 'half') return this.images.eyes_half ? 'eyes_half' : null;
    return this.images.eyes_closed ? 'eyes_closed' : this.images.eyes_half ? 'eyes_half' : null;
  }

  // 口の状態に対応する画像。closed は基本画像の口（表情に ownMouth: true があればその表情の口）
  mouthImage(state, expImage, ownMouth) {
    if (state === 'closed') return ownMouth && expImage ? expImage : 'base';
    const want = 'mouth_' + state;
    if (this.images[want]) return want;
    const alt = { i: ['mouth_e'], e: ['mouth_i'], u: ['mouth_o'], o: ['mouth_u', 'mouth_a'] }[state] ?? [];
    for (const key of [...alt, 'mouth_a', 'mouth_e', 'mouth_i', 'mouth_o', 'mouth_u']) {
      if (this.images[key]) return key;
    }
    return null;
  }

  // state: { expression, eyeL, eyeR, mouth, prevMouth, mouthFade }
  // eyeL / eyeR は画面上の左 / 右の目
  compose(state) {
    const key = JSON.stringify(state);
    if (key === this._lastKey) return false;
    this._lastKey = key;

    const ctx = this.comp.getContext('2d');
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.drawImage(this.images.base, 0, 0, this.width, this.height);

    const exp = this.expression(state.expression);
    const expImage = exp.image && this.images[exp.image] ? exp.image : null;
    if (expImage) this._draw(ctx, expImage, 'face');

    if (exp.eyeTracking !== false) {
      const gaze = this.gazeAvailable(state.expression);
      for (const [side, region] of [
        [state.eyeL, 'eyeL'],
        [state.eyeR, 'eyeR'],
      ]) {
        const img = this.eyeImage(side, gaze);
        if (img) this._draw(ctx, img, region);
      }
    }

    const own = !!exp.ownMouth;
    const cur = this.mouthImage(state.mouth, expImage, own);
    const prev = this.mouthImage(state.prevMouth ?? state.mouth, expImage, own);
    if (state.mouthFade < 1 && prev && prev !== cur) this._draw(ctx, prev, 'mouth', 1);
    if (cur) this._draw(ctx, cur, 'mouth', prev && prev !== cur ? state.mouthFade : 1);
    return true;
  }
}
