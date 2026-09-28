// 顔トラッキング: MediaPipe Face Landmarker で Webカメラ映像から
// 目の開き・口の形・顔の向きを取り出し、アバター用の値に変換する。

const LOCAL_WASM = '/vendor/mediapipe/wasm';
const CDN_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1';
const LOCAL_MODEL = '/models/face_landmarker.task';
const REMOTE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

async function loadVision() {
  try {
    const mod = await import('/vendor/mediapipe/vision_bundle.mjs');
    return { mod, wasm: LOCAL_WASM };
  } catch {
    const mod = await import(`${CDN_BASE}/vision_bundle.mjs`);
    return { mod, wasm: `${CDN_BASE}/wasm` };
  }
}

async function exists(url) {
  try {
    const r = await fetch(url, { method: 'HEAD' });
    return r.ok;
  } catch {
    return false;
  }
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// 生の計測値（カメラ画像の座標系。x は右向き、y は下向き。左右反転なし）
export function measure(landmarks, blendshapes) {
  const L = landmarks;
  const bs = {};
  if (blendshapes) for (const c of blendshapes.categories) bs[c.categoryName] = c.score;

  // 画像の左側に写る目（本人の右目）= imgLeft
  const eyeImgLeft = dist(L[159], L[145]) / dist(L[33], L[133]);
  const eyeImgRight = dist(L[386], L[374]) / dist(L[362], L[263]);

  const faceW = dist(L[234], L[454]);
  const eyeMid = { x: (L[33].x + L[263].x) / 2, y: (L[33].y + L[263].y) / 2 };
  const chin = L[152];
  const nose = L[1];
  const cheekMid = { x: (L[234].x + L[454].x) / 2, y: (L[234].y + L[454].y) / 2 };

  const yaw = (nose.x - cheekMid.x) / faceW; // 鼻が画像の右に寄る → 正
  const pitch = (nose.y - eyeMid.y) / Math.max(1e-4, chin.y - eyeMid.y); // 上を向くと小さくなる
  const roll = Math.atan2(L[263].y - L[33].y, L[263].x - L[33].x); // 画像上で時計回り → 正

  const mouthOpen = dist(L[13], L[14]) / faceW;

  // 目線（左右）: 目頭と目尻の間のどこに黒目の中心があるか。-0.5〜0.5 程度、画像の右が正
  let gazeX = 0;
  if (L.length > 473) {
    const eyes = [
      [L[33], L[133]],
      [L[362], L[263]],
    ];
    const irises = [L[468], L[473]];
    let sum = 0;
    for (const [a, b] of eyes) {
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const iris = dist(irises[0], mid) < dist(irises[1], mid) ? irises[0] : irises[1];
      const x0 = Math.min(a.x, b.x);
      const x1 = Math.max(a.x, b.x);
      sum += (iris.x - x0) / Math.max(1e-4, x1 - x0) - 0.5;
    }
    gazeX = sum / 2;
  }
  // 目線（上下）: 下を見ると正
  const gazeY =
    ((bs.eyeLookDownLeft ?? 0) + (bs.eyeLookDownRight ?? 0)) / 2 -
    ((bs.eyeLookUpLeft ?? 0) + (bs.eyeLookUpRight ?? 0)) / 2;
  const mouthWidth = dist(L[61], L[291]) / faceW;

  return {
    eyeImgLeft,
    eyeImgRight,
    yaw,
    pitch,
    roll,
    mouthOpen,
    mouthWidth,
    gazeX,
    gazeY,
    jawOpen: bs.jawOpen ?? 0,
    funnel: Math.max(bs.mouthFunnel ?? 0, bs.mouthPucker ?? 0),
    smile: ((bs.mouthSmileLeft ?? 0) + (bs.mouthSmileRight ?? 0)) / 2,
    stretch: ((bs.mouthStretchLeft ?? 0) + (bs.mouthStretchRight ?? 0)) / 2,
    browUp: bs.browInnerUp ?? 0,
  };
}

export class FaceTracker {
  constructor(video) {
    this.video = video;
    this.landmarker = null;
    this.stream = null;
    this.lastVideoTime = -1;
    this.latest = null; // 最新の measure() 結果
    this.landmarks = null;
    this.detected = false;
    this.fps = 0;
    this._frames = 0;
    this._fpsT = performance.now();
    this.calib = null; // 正面・通常時の基準値
    // キャリブレーション前でも動くように、目の開きの最大値を自動で追う
    this.eyeBase = { imgLeft: 0.28, imgRight: 0.28 };
  }

  async init(onStatus = () => {}) {
    onStatus('顔トラッキングを読み込み中…');
    const { mod, wasm } = await loadVision();
    const fileset = await mod.FilesetResolver.forVisionTasks(wasm);
    const modelAssetPath = (await exists(LOCAL_MODEL)) ? LOCAL_MODEL : REMOTE_MODEL;
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath, delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: false,
    });
    try {
      this.landmarker = await mod.FaceLandmarker.createFromOptions(fileset, opts('GPU'));
    } catch {
      this.landmarker = await mod.FaceLandmarker.createFromOptions(fileset, opts('CPU'));
    }
  }

  async startCamera(deviceId) {
    this.stopCamera();
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30 },
        ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
      },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
  }

  stopCamera() {
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    this.video.srcObject = null;
    this.detected = false;
    this.latest = null;
    this.landmarks = null;
  }

  get running() {
    return !!this.stream;
  }

  // 毎フレーム呼ぶ。新しいカメラフレームがあれば解析する。
  update() {
    if (!this.landmarker || !this.stream || this.video.readyState < 2) return;
    if (this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime;

    const res = this.landmarker.detectForVideo(this.video, performance.now());
    this._frames++;
    const now = performance.now();
    if (now - this._fpsT > 1000) {
      this.fps = (this._frames * 1000) / (now - this._fpsT);
      this._frames = 0;
      this._fpsT = now;
    }
    if (!res.faceLandmarks || res.faceLandmarks.length === 0) {
      this.detected = false;
      return;
    }
    this.detected = true;
    this.landmarks = res.faceLandmarks[0];
    const m = measure(this.landmarks, res.faceBlendshapes?.[0]);
    this.latest = m;

    // 目の開きの基準（開いている時の値）を自動更新
    for (const [k, v] of [
      ['imgLeft', m.eyeImgLeft],
      ['imgRight', m.eyeImgRight],
    ]) {
      if (this.calib) continue;
      this.eyeBase[k] = v > this.eyeBase[k] ? v : this.eyeBase[k] - 0.0004;
      this.eyeBase[k] = Math.max(0.15, this.eyeBase[k]);
    }
  }

  calibrate() {
    if (!this.latest) return false;
    const m = this.latest;
    this.calib = { ...m };
    // 口は「閉じた状態」の基準。うっかり開けたまま押しても壊れないよう上限を付ける
    this.calib.mouthOpen = Math.min(m.mouthOpen, 0.03);
    this.calib.jawOpen = Math.min(m.jawOpen, 0.15);
    this.eyeBase = {
      imgLeft: Math.max(0.12, m.eyeImgLeft),
      imgRight: Math.max(0.12, m.eyeImgRight),
    };
    return true;
  }

  resetCalibration() {
    this.calib = null;
  }

  // アバター用の値（左右反転などの表示設定はここでは扱わない）
  // yaw/pitch/roll: 基準からの差、eyeOpen: 0〜1、mouth: 0〜1 の各値
  features() {
    const m = this.latest;
    if (!m) return null;
    const c = this.calib ?? { yaw: 0, pitch: 0.45, roll: 0, mouthWidth: 0.36, gazeX: 0, gazeY: 0, mouthOpen: 0, jawOpen: 0 };
    const openness = (v, base) => clamp01((v / base - 0.45) / (0.85 - 0.45));
    return {
      yaw: m.yaw - c.yaw,
      pitch: m.pitch - c.pitch,
      roll: m.roll - c.roll,
      eyeOpenImgLeft: openness(m.eyeImgLeft, this.eyeBase.imgLeft),
      eyeOpenImgRight: openness(m.eyeImgRight, this.eyeBase.imgRight),
      // 口の開き: 閉じている時の値を差し引いてから大きめに増幅（はっきり動かすため）
      mouthOpen: clamp01(Math.max((m.jawOpen - (c.jawOpen ?? 0)) * 1.8, (m.mouthOpen - (c.mouthOpen ?? 0) - 0.005) * 7)),
      funnel: m.funnel,
      wide: clamp01(m.stretch * 1.3 + (m.mouthWidth - c.mouthWidth) * 5),
      smile: clamp01((m.smile - (c.smile ?? 0) * 0.5) * 1.4),
      browUp: m.browUp,
      gazeX: m.gazeX - (c.gazeX ?? 0),
      gazeY: m.gazeY - (c.gazeY ?? 0),
    };
  }
}
