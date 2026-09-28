// アニメ調の口を描く。形は 4 つの値で連続的に変わる:
//   open  0〜1  口の開き
//   wide  0〜1  横に引く（い・え）
//   round 0〜1  すぼめる（う・お）
//   smile 0〜1  口角を上げる
// 絵柄に合わせて、細い輪郭線・サーモンピンクの口の中・上の歯の白い線・ごく薄い下唇にしている。

const LINE = 'rgb(128, 60, 56)';
const INNER_TOP = 'rgb(178, 88, 84)';
const INNER = 'rgb(236, 150, 138)';
const TONGUE = 'rgba(246, 168, 160, 0.9)';
const TEETH = 'rgba(255, 252, 250, 0.95)';
const LIP = 'rgba(236, 160, 146, 0.45)';

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// 口の外形の点列（中心が原点、y は下向き）
function outline(hw, h, round, lift, steps = 24) {
  const topScale = lerp(0.22, 0.48, round) * h;
  const botScale = lerp(0.78, 0.52, round) * h;
  const topPow = lerp(1.0, 0.5, round);
  const botPow = lerp(0.62, 0.5, round);
  const top = [];
  const bot = [];
  for (let i = 0; i <= steps; i++) {
    const u = -1 + (2 * i) / steps;
    const x = u * hw;
    const base = 1 - u * u;
    const corner = -lift * u * u; // 口角を上げる
    top.push([x, -topScale * Math.pow(base, topPow) + corner]);
    bot.push([x, botScale * Math.pow(base, botPow) + corner]);
  }
  return { top, bot };
}

function trace(ctx, pts, move = true) {
  pts.forEach(([x, y], i) => (i === 0 && move ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
}

export function drawAnimeMouth(ctx, cx, cy, p, cfg = {}) {
  const s = cfg.scale ?? 1;
  const open = clamp01(p.open);
  const wide = clamp01(p.wide);
  const round = clamp01(p.round);
  const smile = clamp01(p.smile);

  const closedHW = (cfg.closedHalfWidth ?? 17) * s;
  const openHW = (cfg.openHalfWidth ?? 25) * s;
  const maxH = (cfg.maxHeight ?? 38) * s;

  // 開くほど少し幅も広がる。すぼめると幅が狭くなる
  let hw = lerp(closedHW, openHW, Math.min(1, open * 1.6));
  hw *= lerp(1, 1.25, wide) * lerp(1, 0.5, round);
  const h = open * maxH * lerp(1, 0.75, wide) * lerp(1, 1.1, round);
  const lift = smile * 4 * s * (1 - round);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (h < 1.6 * s) {
    // 閉じた口: 細い線と、その下のごく薄い唇
    const len = hw * lerp(1, 0.6, round);
    ctx.strokeStyle = LINE;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 2 * s;
    ctx.beginPath();
    ctx.moveTo(-len, -lift);
    ctx.quadraticCurveTo(0, (1.5 + smile * 3) * s, len, -lift);
    ctx.stroke();
    ctx.strokeStyle = LIP;
    ctx.globalAlpha = 1;
    ctx.lineWidth = 2.2 * s;
    ctx.beginPath();
    ctx.moveTo(-len * 0.45, 5 * s);
    ctx.quadraticCurveTo(0, 6.5 * s, len * 0.45, 5 * s);
    ctx.stroke();
    ctx.restore();
    return;
  }

  const { top, bot } = outline(hw, h, round, lift);
  const shape = new Path2D();
  top.forEach(([x, y], i) => (i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y)));
  for (let i = bot.length - 1; i >= 0; i--) shape.lineTo(bot[i][0], bot[i][1]);
  shape.closePath();

  // 口の中
  const yTop = top[Math.floor(top.length / 2)][1];
  const yBot = bot[Math.floor(bot.length / 2)][1];
  const g = ctx.createLinearGradient(0, yTop, 0, yBot);
  g.addColorStop(0, INNER_TOP);
  g.addColorStop(0.45, INNER);
  g.addColorStop(1, INNER);
  ctx.fillStyle = g;
  ctx.fill(shape);

  ctx.save();
  ctx.clip(shape);
  // 舌
  if (h > 8 * s) {
    ctx.fillStyle = TONGUE;
    ctx.beginPath();
    ctx.ellipse(0, yBot - h * 0.12, hw * 0.62, h * 0.32, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // 上の歯（白い細い線）。すぼめた口では見せない
  const teeth = (1 - round) * Math.min(1, (h - 4 * s) / (10 * s));
  if (teeth > 0) {
    ctx.strokeStyle = TEETH;
    ctx.globalAlpha = teeth;
    ctx.lineWidth = lerp(2.5, 4.5, wide) * s;
    ctx.beginPath();
    trace(ctx, top.slice(3, top.length - 3).map(([x, y]) => [x, y + 2.2 * s]));
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.restore();

  // 輪郭: 上は少し太く、下は細く薄く
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 2.1 * s;
  ctx.beginPath();
  trace(ctx, top);
  ctx.stroke();
  ctx.lineWidth = 1.3 * s;
  ctx.globalAlpha = 0.75;
  ctx.beginPath();
  trace(ctx, bot);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // ごく薄い下唇
  ctx.strokeStyle = LIP;
  ctx.lineWidth = 2 * s;
  ctx.beginPath();
  ctx.moveTo(-hw * 0.35, yBot + 4 * s);
  ctx.quadraticCurveTo(0, yBot + 5.5 * s, hw * 0.35, yBot + 4 * s);
  ctx.stroke();

  ctx.restore();
}
