// パーツ調整モード: 目・口・表情・頭の範囲（楕円）をドラッグで合わせ、
// 差分画像の位置ずれを矢印で補正して avatar.json に保存する。

const REGION_STYLE = {
  eyeL: { color: '#2e86de', label: '目（画面左）' },
  eyeR: { color: '#2e86de', label: '目（画面右）' },
  mouth: { color: '#e74c3c', label: '口を描き直す範囲' },
  face: { color: '#8e44ad', label: '表情の範囲' },
  head: { color: '#27ae60', label: '頭（動く範囲）' },
};

export class Editor {
  constructor({ avatar, overlay, toast, onChange }) {
    this.avatar = avatar;
    this.overlay = overlay;
    this.toast = toast;
    this.onChange = onChange;
    this.active = false;
    this.drag = null;
    this.dirtyTexture = false;
    this.panel = document.getElementById('editPanel');
    this.btn = document.getElementById('editBtn');
    this.onion = document.getElementById('onionSelect');
    this.onionAlpha = document.getElementById('onionAlpha');
    this.alignInfo = document.getElementById('alignInfo');
    this.feather = document.getElementById('feather');

    this.btn.addEventListener('click', () => this.toggle());
    this.onion.addEventListener('change', () => this.updateAlignInfo());
    this.feather.addEventListener('input', () => {
      this.avatar.config.feather = +this.feather.value;
      this.changed();
    });
    for (const b of this.panel.querySelectorAll('[data-nudge]')) {
      b.addEventListener('click', () => {
        const [dx, dy] = b.dataset.nudge.split(',').map(Number);
        this.nudge(dx, dy);
      });
    }
    document.getElementById('saveBtn').addEventListener('click', () => this.save());
    document.getElementById('downloadBtn').addEventListener('click', () => this.download());

    overlay.addEventListener('pointerdown', (e) => this.pointerDown(e));
    overlay.addEventListener('pointermove', (e) => this.pointerMove(e));
    overlay.addEventListener('pointerup', () => (this.drag = null));
    overlay.addEventListener('pointercancel', () => (this.drag = null));
  }

  get config() {
    return this.avatar.config;
  }

  toggle() {
    this.active = !this.active;
    this.overlay.hidden = !this.active;
    this.panel.hidden = !this.active;
    this.btn.classList.toggle('active', this.active);
    if (this.active) {
      this.overlay.width = this.avatar.width;
      this.overlay.height = this.avatar.height;
      this.feather.value = this.config.feather ?? 12;
      this.onion.innerHTML = '';
      for (const key of Object.keys(this.avatar.images)) {
        const o = document.createElement('option');
        o.value = key;
        o.textContent = key;
        this.onion.appendChild(o);
      }
      this.onion.value = this.avatar.images.eyes_closed ? 'eyes_closed' : 'base';
      this.updateAlignInfo();
      this.toast('パーツ調整モード: 動きを止めています（E で戻る）');
    }
  }

  changed() {
    this.onChange();
    this.dirtyTexture = true;
  }

  // 選んだ差分画像が実際にどう合成されるかを見せる
  previewState(state) {
    const key = this.onion.value;
    const s = { expression: 0, eyeL: 'open', eyeR: 'open' };
    if (key === 'eyes_closed') s.eyeL = s.eyeR = 'closed';
    else if (key === 'eyes_half') s.eyeL = s.eyeR = 'half';
    else if (key.startsWith('exp_')) {
      const i = (this.config.expressions ?? []).findIndex((x) => x.image === key);
      if (i >= 0) s.expression = i;
    }
    return s;
  }

  updateAlignInfo() {
    const a = this.config.align?.[this.onion.value] ?? { dx: 0, dy: 0 };
    this.alignInfo.textContent = `x ${a.dx || 0}, y ${a.dy || 0}`;
  }

  nudge(dx, dy) {
    const key = this.onion.value;
    if (key === 'base') {
      this.toast('base は基準なので動かせません。ほかの画像を選んでください');
      return;
    }
    this.config.align ??= {};
    const a = (this.config.align[key] ??= { dx: 0, dy: 0 });
    a.dx = (a.dx || 0) + dx;
    a.dy = (a.dy || 0) + dy;
    this.updateAlignInfo();
    this.changed();
  }

  handleKey(e) {
    const map = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (map[e.key]) {
      const step = e.shiftKey ? 10 : 1;
      this.nudge(map[e.key][0] * step, map[e.key][1] * step);
      e.preventDefault();
      return true;
    }
    return false;
  }

  toImage(e) {
    const r = this.overlay.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * this.overlay.width,
      y: ((e.clientY - r.top) / r.height) * this.overlay.height,
      scale: this.overlay.width / r.width,
    };
  }

  pointerDown(e) {
    const p = this.toImage(e);
    const hit = 14 * p.scale;
    // 口の位置の点 → 小さい範囲 → 大きい範囲の順に当たり判定
    const mp = this.config.mouth;
    if (mp && Math.hypot(p.x - mp.cx, p.y - mp.cy) < hit * 0.6) this.drag = { name: 'mouthPos', mode: 'mouthPos' };
    const order = this.drag ? [] : ['eyeL', 'eyeR', 'mouth', 'face', 'head'];
    for (const name of order) {
      const r = this.config.regions[name];
      if (!r) continue;
      if (Math.hypot(p.x - (r.cx + r.rx), p.y - (r.cy + r.ry)) < hit) {
        this.drag = { name, mode: 'size' };
        break;
      }
      if (Math.hypot(p.x - r.cx, p.y - r.cy) < hit) {
        this.drag = { name, mode: 'move', ox: p.x - r.cx, oy: p.y - r.cy };
        break;
      }
    }
    if (!this.drag && Math.abs(p.y - this.config.neckY) < hit) this.drag = { name: 'neck', mode: 'neck' };
    if (this.drag) this.overlay.setPointerCapture(e.pointerId);
  }

  pointerMove(e) {
    if (!this.drag) return;
    const p = this.toImage(e);
    const round = Math.round;
    if (this.drag.mode === 'neck') {
      this.config.neckY = round(p.y);
    } else if (this.drag.mode === 'mouthPos') {
      this.config.mouth.cx = round(p.x);
      this.config.mouth.cy = round(p.y);
    } else {
      const r = this.config.regions[this.drag.name];
      if (this.drag.mode === 'move') {
        r.cx = round(p.x - this.drag.ox);
        r.cy = round(p.y - this.drag.oy);
      } else {
        r.rx = Math.max(8, round(p.x - r.cx));
        r.ry = Math.max(8, round(p.y - r.cy));
      }
    }
    this.changed();
  }

  drawOverlay() {
    if (!this.active) return;
    const ctx = this.overlay.getContext('2d');
    const W = this.overlay.width;
    ctx.clearRect(0, 0, W, this.overlay.height);

    const key = this.onion.value;
    const img = this.avatar.images[key];
    const alpha = +this.onionAlpha.value;
    if (img && key !== 'base' && alpha > 0) {
      const a = this.config.align?.[key] ?? { dx: 0, dy: 0 };
      ctx.globalAlpha = alpha;
      ctx.drawImage(img, a.dx || 0, a.dy || 0, this.avatar.width, this.avatar.height);
      ctx.globalAlpha = 1;
    }

    const lw = Math.max(2, W / 400);
    ctx.font = `${Math.round(W / 45)}px sans-serif`;
    for (const [name, st] of Object.entries(REGION_STYLE)) {
      const r = this.config.regions[name];
      if (!r) continue;
      ctx.strokeStyle = st.color;
      ctx.fillStyle = st.color;
      ctx.lineWidth = lw;
      ctx.setLineDash(name === 'head' || name === 'face' ? [10, 6] : []);
      ctx.beginPath();
      ctx.ellipse(r.cx, r.cy, r.rx, r.ry, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(r.cx, r.cy, lw * 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(r.cx + r.rx - lw * 3, r.cy + r.ry - lw * 3, lw * 6, lw * 6);
      ctx.fillText(st.label, r.cx - r.rx, r.cy - r.ry - lw * 2);
    }
    const mp = this.config.mouth;
    if (mp) {
      ctx.strokeStyle = '#e74c3c';
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(mp.cx - lw * 5, mp.cy);
      ctx.lineTo(mp.cx + lw * 5, mp.cy);
      ctx.moveTo(mp.cx, mp.cy - lw * 5);
      ctx.lineTo(mp.cx, mp.cy + lw * 5);
      ctx.stroke();
      ctx.fillStyle = '#e74c3c';
      ctx.fillText('口の位置', mp.cx + lw * 6, mp.cy + lw * 10);
    }
    ctx.strokeStyle = '#f39c12';
    ctx.fillStyle = '#f39c12';
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(0, this.config.neckY);
    ctx.lineTo(W, this.config.neckY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillText('首の付け根（ここより下は動かない）', 8, this.config.neckY - 6);
  }

  json() {
    return JSON.stringify(this.config, null, 2) + '\n';
  }

  async save() {
    try {
      const r = await fetch('/api/save-avatar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: this.json(),
      });
      if (!r.ok) throw new Error(r.status);
      this.toast('avatar/avatar.json に保存しました');
    } catch {
      this.toast('サーバーに保存できないので、ダウンロードします');
      this.download();
    }
  }

  download() {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([this.json()], { type: 'application/json' }));
    a.download = 'avatar.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}
