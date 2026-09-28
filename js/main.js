import { Avatar } from './avatar.js';
import { WarpRenderer } from './renderer.js';
import { FaceTracker } from './tracker.js';
import { Editor } from './editor.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;

const els = {
  stage: $('stage'),
  canvas: $('avatar'),
  overlay: $('editOverlay'),
  panel: $('panel'),
  camBtn: $('camBtn'),
  camSelect: $('camSelect'),
  calibBtn: $('calibBtn'),
  status: $('status'),
  expButtons: $('expButtons'),
  expBadge: $('expBadge'),
  bgSelect: $('bgSelect'),
  mirror: $('mirror'),
  debug: $('debug'),
  idle: $('idle'),
  debugView: $('debugView'),
  debugCanvas: $('debugCanvas'),
  debugText: $('debugText'),
  video: $('video'),
  toast: $('toast'),
};

const sliders = ['sYaw', 'sPitch', 'sRoll', 'sMouth', 'sEye', 'sGaze', 'sSmooth'];
const SETTINGS_KEY = 'vtuber-avatar-settings';

function toast(msg, ms = 2200) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (els.toast.hidden = true), ms);
}

function setStatus(msg, kind = '') {
  els.status.textContent = msg;
  els.status.className = 'status ' + kind;
}

// ---- 設定の保存（このブラウザだけ） ----
function saveSettings() {
  const s = { bg: els.bgSelect.value, mirror: els.mirror.checked, idle: els.idle.checked };
  for (const id of sliders) s[id] = $(id).value;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {}
}
function loadSettings() {
  let s = null;
  try {
    s = JSON.parse(localStorage.getItem(SETTINGS_KEY));
  } catch {}
  if (!s) return;
  if (s.bg) els.bgSelect.value = s.bg;
  if (typeof s.mirror === 'boolean') els.mirror.checked = s.mirror;
  if (typeof s.idle === 'boolean') els.idle.checked = s.idle;
  for (const id of sliders) if (s[id] != null) $(id).value = s[id];
}

function applyBackground() {
  const v = els.bgSelect.value;
  els.stage.className = 'bg-' + v;
}

// ---- 起動 ----
const avatar = new Avatar();
const tracker = new FaceTracker(els.video);
let renderer;
let editor;

const state = {
  expression: 0,
  eyeL: 'open',
  eyeR: 'open',
};
// 口の形（連続値）。js/mouth.js で描く
const mouth = { open: 0, wide: 0, round: 0, smile: 0 };
let lastMouthKey = '';
const motion = { yaw: 0, pitch: 0, roll: 0 };
const gaze = { x: 0, y: 0 };
const hair = { yaw: 0, pitch: 0, roll: 0, vy: 0, vp: 0, vr: 0 };
let nextIdleBlink = performance.now() + 3000;
let idleBlinkUntil = 0;
let override = null; // テスト用 (window.__avatar.setFeatures)

async function boot() {
  loadSettings();
  applyBackground();
  try {
    await avatar.load();
  } catch (e) {
    setStatus(String(e.message || e), 'err');
    throw e;
  }
  renderer = new WarpRenderer(els.canvas);
  renderer.setSize(avatar.width, avatar.height);
  renderer.setGazeImages(avatar.images.iris, avatar.images.eye_mask);
  $('avatarWrap').style.aspectRatio = `${avatar.width} / ${avatar.height}`;
  buildExpressionButtons();
  editor = new Editor({ avatar, overlay: els.overlay, toast, onChange: () => avatar.rebake() });

  const missing = avatar.missingParts();
  if (missing.length) toast('見つからないパーツ: ' + missing.join(', ') + '（代わりの画像で動きます）', 5000);

  requestAnimationFrame(loop);
}

function buildExpressionButtons() {
  els.expButtons.innerHTML = '';
  (avatar.config.expressions ?? []).forEach((exp, i) => {
    const b = document.createElement('button');
    b.textContent = `${exp.key ?? i + 1}: ${exp.name}`;
    b.addEventListener('click', () => setExpression(i));
    els.expButtons.appendChild(b);
  });
  setExpression(state.expression);
}

function setExpression(i) {
  const list = avatar.config.expressions ?? [];
  if (i < 0 || i >= Math.max(1, list.length)) return;
  state.expression = i;
  [...els.expButtons.children].forEach((b, j) => b.classList.toggle('active', j === i));
  const exp = avatar.expression(i);
  els.expBadge.textContent = exp.name;
  els.expBadge.hidden = i === 0;
}

// ---- カメラ ----
async function startCamera() {
  els.camBtn.disabled = true;
  try {
    if (!tracker.landmarker) await tracker.init((m) => setStatus(m));
    setStatus('カメラを起動中…');
    await tracker.startCamera(els.camSelect.value || undefined);
    await listCameras();
    els.camBtn.textContent = 'カメラ停止';
    els.calibBtn.disabled = false;
    setStatus('カメラ動作中', 'ok');
  } catch (e) {
    console.error(e);
    const msg =
      e && e.name === 'NotAllowedError'
        ? 'カメラの使用が許可されませんでした。ブラウザのアドレスバーから許可してください。'
        : e && e.name === 'NotFoundError'
          ? 'カメラが見つかりません。'
          : 'エラー: ' + (e.message || e);
    setStatus(msg, 'err');
  } finally {
    els.camBtn.disabled = false;
  }
}

function stopCamera() {
  tracker.stopCamera();
  els.camBtn.textContent = 'カメラ開始';
  els.calibBtn.disabled = true;
  setStatus('カメラは止まっています');
}

async function listCameras() {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  const current = tracker.stream?.getVideoTracks()[0]?.getSettings().deviceId;
  els.camSelect.innerHTML = '';
  devices.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || `カメラ ${i + 1}`;
    if (d.deviceId === current) o.selected = true;
    els.camSelect.appendChild(o);
  });
  els.camSelect.hidden = devices.length < 2;
}

function calibrate() {
  if (tracker.calibrate()) toast('今の顔を「正面・通常」の基準にしました');
  else toast('顔が見つかりません。カメラに顔を映してください');
}

// ---- トラッキング値 → アバターの状態 ----
function eyeStateFrom(open, prev) {
  // ヒステリシス付きで open / half / closed を決める
  const th = { toClosed: 0.22, fromClosed: 0.32, toHalf: 0.55, fromHalf: 0.65 };
  if (prev === 'closed') return open > th.fromClosed ? (open > th.toHalf ? 'open' : 'half') : 'closed';
  if (prev === 'half') return open < th.toClosed ? 'closed' : open > th.fromHalf ? 'open' : 'half';
  return open < th.toClosed ? 'closed' : open < th.toHalf ? 'half' : 'open';
}

function update(now, dt) {
  tracker.update();
  const mirror = els.mirror.checked;
  const sYaw = +$('sYaw').value;
  const sPitch = +$('sPitch').value;
  const sRoll = +$('sRoll').value;
  const sMouth = +$('sMouth').value;
  const sEye = +$('sEye').value;
  const sGaze = +$('sGaze').value;
  const smooth = +$('sSmooth').value;

  const f = override ?? (tracker.detected ? tracker.features() : null);
  let target = { yaw: 0, pitch: 0, roll: 0 };
  let gazeTarget = { x: gaze.x, y: gaze.y };
  let eyeL = 'open';
  let eyeR = 'open';
  let mouthTarget = { open: 0, wide: 0, round: 0, smile: 0 };

  if (f) {
    const sign = mirror ? -1 : 1;
    target = {
      yaw: clamp((f.yaw / 0.22) * sYaw * sign, -1.3, 1.3),
      pitch: clamp((f.pitch / 0.12) * sPitch, -1.3, 1.3),
      roll: clamp(f.roll * sRoll * sign, -0.6, 0.6),
    };
    // 目: 鏡モードなら、カメラ画像の左側に写る目（本人の右目）が画面右の目になる
    const adj = (v) => clamp(1 - (1 - v) * sEye, 0, 1);
    let oL = adj(mirror ? f.eyeOpenImgRight : f.eyeOpenImgLeft);
    let oR = adj(mirror ? f.eyeOpenImgLeft : f.eyeOpenImgRight);
    if (Math.abs(oL - oR) < 0.25) oL = oR = (oL + oR) / 2; // 両目はそろえてチラつきを抑える
    eyeL = eyeStateFrom(oL, state.eyeL);
    eyeR = eyeStateFrom(oR, state.eyeR);
    const open = clamp(f.mouthOpen * sMouth, 0, 1);
    mouthTarget = {
      open: open < 0.05 ? 0 : (open - 0.05) / 0.95, // ごく小さな開きは閉じとみなす
      wide: f.wide ?? 0,
      round: clamp((f.funnel ?? 0) * 1.4, 0, 1),
      smile: f.smile ?? 0,
    };
    // 目線: まばたき中は黒目の位置が乱れるので動かさない
    if (Math.min(oL, oR) > 0.5) {
      const dz = (v) => (Math.abs(v) < 0.08 ? 0 : v - Math.sign(v) * 0.08); // 小さなブレは無視
      gazeTarget = {
        x: clamp(dz((f.gazeX ?? 0) / 0.1) * sGaze * sign, -1, 1),
        y: clamp(dz((f.gazeY ?? 0) / 0.4) * sGaze, -1, 1),
      };
    }
  } else {
    // 顔が映っていない時: ゆっくり揺れて、時々まばたき
    if (els.idle.checked) {
      target.yaw = Math.sin(now / 2300) * 0.15;
      target.pitch = Math.sin(now / 3100) * 0.08;
      target.roll = Math.sin(now / 2700) * 0.03;
      if (now > nextIdleBlink) {
        idleBlinkUntil = now + 140;
        nextIdleBlink = now + 2500 + Math.random() * 3500;
      }
      if (now < idleBlinkUntil) eyeL = eyeR = 'closed';
      gazeTarget = { x: Math.sin(now / 3700) * 0.35, y: 0 };
    } else {
      gazeTarget = { x: 0, y: 0 };
    }
  }

  // 頭: なめらかに追従
  const a = 1 - Math.pow(smooth, dt / 16.7);
  motion.yaw = lerp(motion.yaw, target.yaw, a);
  motion.pitch = lerp(motion.pitch, target.pitch, a);
  motion.roll = lerp(motion.roll, target.roll, a);

  // 目線は速めに追従（目の動きはすばやいので）
  const ag = 1 - Math.pow(Math.min(smooth, 0.6) * 0.6, dt / 16.7);
  gaze.x = lerp(gaze.x, gazeTarget.x, ag);
  gaze.y = lerp(gaze.y, gazeTarget.y, ag);

  // 髪: 頭より少し遅れてばねのように揺れる
  const lag = avatar.config.motion?.hairLag ?? 0.12;
  const stiff = clamp(0.25 - lag, 0.04, 0.3) * (dt / 16.7);
  const damp = Math.pow(0.78, dt / 16.7);
  for (const [k, v] of [
    ['yaw', 'vy'],
    ['pitch', 'vp'],
    ['roll', 'vr'],
  ]) {
    hair[v] = (hair[v] + (motion[k] - hair[k]) * stiff) * damp;
    hair[k] += hair[v];
  }

  // 口: 話す速さについていけるよう速めに追従（開く時はさらに速く）
  for (const k of ['open', 'wide', 'round', 'smile']) {
    const t = mouthTarget[k];
    const speed = k === 'open' && t > mouth[k] ? 0.6 : 0.4;
    mouth[k] = lerp(mouth[k], t, 1 - Math.pow(1 - speed, dt / 16.7));
  }
  state.eyeL = eyeL;
  state.eyeR = eyeR;

  return f;
}

// ---- デバッグ表示 ----
function drawDebug(f) {
  const show = els.debug.checked;
  els.debugView.hidden = !show;
  if (!show) return;
  const v = els.video;
  const c = els.debugCanvas;
  if (v.videoWidth && (c.width !== v.videoWidth || c.height !== v.videoHeight)) {
    c.width = v.videoWidth;
    c.height = v.videoHeight;
  }
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  if (tracker.landmarks && tracker.detected) {
    ctx.fillStyle = '#7fffb0';
    for (const p of tracker.landmarks) ctx.fillRect(p.x * c.width - 1, p.y * c.height - 1, 2, 2);
  }
  const fmt = (n) => (n >= 0 ? ' ' : '') + n.toFixed(2);
  els.debugText.textContent = [
    `トラッキング: ${tracker.running ? `${tracker.fps.toFixed(0)} fps` : '停止中'} / 顔: ${tracker.detected ? 'あり' : 'なし'}`,
    `基準: ${tracker.calib ? '設定済み' : '未設定（C キー）'}`,
    `向き  左右${fmt(motion.yaw)} 上下${fmt(motion.pitch)} 傾き${fmt(motion.roll)}`,
    `目線  左右${fmt(gaze.x)} 上下${fmt(gaze.y)}`,
    f ? `目  左 ${state.eyeL} / 右 ${state.eyeR}` : '',
    `口  開き${fmt(mouth.open)} 横${fmt(mouth.wide)} すぼめ${fmt(mouth.round)} 笑み${fmt(mouth.smile)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

// 口の部分だけを描き直してテクスチャに送る（形が変わった時だけ）
function uploadMouth(p, force) {
  const key = [p.open, p.wide, p.round, p.smile].map((v) => v.toFixed(3)).join(',');
  if (!force && key === lastMouthKey) return;
  lastMouthKey = key;
  const m = avatar.drawMouth(p);
  renderer.uploadSubTexture(m.canvas, m.x, m.y);
}

// ---- メインループ ----
let last = performance.now();
function loop(now) {
  const dt = clamp(now - last, 1, 100);
  last = now;
  const f = update(now, dt);

  if (editor.active) {
    // 調整モードでは動きを止めて正面のまま表示
    const preview = editor.previewState(state);
    const changed = avatar.compose(preview);
    if (changed || editor.dirtyTexture) {
      renderer.uploadTexture(avatar.comp);
      uploadMouth(avatar.mouthParams(preview.expression, { open: 0, wide: 0, round: 0, smile: 0 }), true);
    }
    editor.dirtyTexture = false;
    renderer.gaze = { x: 0, y: 0, ...avatar.gazeEyes(editor.previewState(state)) };
    renderer.deform({ yaw: 0, pitch: 0, roll: 0, hairYaw: 0, hairPitch: 0, hairRoll: 0, breath: 0 }, avatar.config);
  } else {
    const changed = avatar.compose(state);
    if (changed) renderer.uploadTexture(avatar.comp);
    uploadMouth(avatar.mouthParams(state.expression, mouth), changed);
    const mm = avatar.config.motion ?? {};
    renderer.gaze = {
      x: gaze.x * (mm.gazePxX ?? 8),
      y: gaze.y * (mm.gazePxY ?? 4),
      ...avatar.gazeEyes(state),
    };
    const breath = (avatar.config.motion?.breath ?? 0.006) * Math.sin((now / 3600) * Math.PI * 2);
    renderer.deform(
      {
        yaw: motion.yaw,
        pitch: motion.pitch,
        roll: motion.roll,
        hairYaw: hair.yaw,
        hairPitch: hair.pitch,
        hairRoll: hair.roll,
        breath,
      },
      avatar.config
    );
  }
  renderer.draw();
  editor.drawOverlay();
  drawDebug(f);
  requestAnimationFrame(loop);
}

// ---- UI ----
els.camBtn.addEventListener('click', () => (tracker.running ? stopCamera() : startCamera()));
els.camSelect.addEventListener('change', () => tracker.running && startCamera());
els.calibBtn.addEventListener('click', calibrate);
els.bgSelect.addEventListener('change', () => {
  applyBackground();
  saveSettings();
});
for (const el of [els.mirror, els.idle, ...sliders.map($)]) el.addEventListener('change', saveSettings);
$('hidePanel').addEventListener('click', () => els.panel.classList.add('hidden'));

window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea') && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (editor?.active && editor.handleKey(e)) return;
  const k = e.key.toLowerCase();
  const exps = avatar.config?.expressions ?? [];
  const idx = exps.findIndex((x) => String(x.key) === e.key);
  if (idx >= 0) setExpression(idx);
  else if (k === '0') setExpression(0);
  else if (k === 'c') calibrate();
  else if (k === 'h') els.panel.classList.toggle('hidden');
  else if (k === 'd') els.debug.checked = !els.debug.checked;
  else if (k === 'e') editor.toggle();
  else if (k === 'b') {
    const opts = [...els.bgSelect.options];
    els.bgSelect.value = opts[(els.bgSelect.selectedIndex + 1) % opts.length].value;
    applyBackground();
    saveSettings();
  } else return;
  e.preventDefault();
});

// テストや他ツールから操作するための入口
window.__avatar = {
  state,
  motion,
  mouth,
  gaze,
  setExpression,
  setFeatures: (f) => (override = f),
  get editor() {
    return editor;
  },
};

boot();
