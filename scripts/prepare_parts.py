"""差分画像の下ごしらえ: avatar/source/ の元画像 → avatar/parts/ のパーツ画像

画像生成 AI で作った差分画像は、同じ絵を編集しても髪の毛の線が少しずつ描き直されている。
そのまま目や口の範囲を差し替えると、まばたきや表情の切り替えで前髪がピクッと動いたり、
境目で髪の線が二重に見えたりする。そこで各差分画像について

  1. 基本画像との位置ずれ（数 px）を自動で見つけて合わせる
  2. 「どちらかの画像で髪の毛の色をしている所」は基本画像の髪で上書きする
     （目の中心部 eyeCores・口 mouthCores・表情画像の眉 browCores だけは差分画像をそのまま使う）

を行い、髪が基本画像と完全に同じになったパーツ画像を書き出す。

使い方:
    pip install pillow numpy
    python scripts/prepare_parts.py

avatar/source/ に置くファイル名 = パーツ名（base.png, eyes_closed.png, exp_smile.png …）。
1 枚の元画像を複数のパーツに使う場合は avatar.json の cleanup.reuse に書く。
設定は avatar/avatar.json の "cleanup" を使う。
"""

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "avatar" / "source"
OUT = ROOT / "avatar" / "parts"
CONFIG = ROOT / "avatar" / "avatar.json"


def load_rgba(path):
    a = np.asarray(Image.open(path).convert("RGBA")).astype(np.float32) / 255.0
    # 画像生成 AI の透過 PNG/WebP は不透明部分が alpha 0.99 程度のことがあるので整える
    al = a[..., 3]
    al[al > 0.94] = 1.0
    al[al < 0.03] = 0.0
    return a


def on_white(a):
    return a[..., :3] * a[..., 3:4] + (1 - a[..., 3:4])


def hair_mask(a, hue_max=10.0, hue_min_wrap=335.0, s_min=0.2, v_min=0.35):
    """ピンクの髪（と髪の線）らしい画素。肌・頬の赤み・唇は色相 15° 以上なので外れる"""
    rgb = a[..., :3]
    mx = rgb.max(-1)
    mn = rgb.min(-1)
    d = mx - mn + 1e-6
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    h = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) * 60.0
    s = np.where(mx > 0, d / (mx + 1e-6), 0)
    hue_ok = (h <= hue_max) | (h >= hue_min_wrap)
    return hue_ok & (s >= s_min) & (mx >= v_min) & (a[..., 3] > 0.5)


def ellipse_mask(shape, e, scale=1.0):
    h, w = shape
    yy, xx = np.mgrid[0:h, 0:w]
    return ((xx - e["cx"]) / (e["rx"] * scale)) ** 2 + ((yy - e["cy"]) / (e["ry"] * scale)) ** 2 <= 1.0


def soften(mask, grow, blur):
    im = Image.fromarray((mask * 255).astype(np.uint8))
    if grow > 0:
        im = im.filter(ImageFilter.MaxFilter(grow * 2 + 1))
    if blur > 0:
        im = im.filter(ImageFilter.GaussianBlur(blur))
    return np.asarray(im).astype(np.float32) / 255.0


def find_shift(base, var, box, radius=5):
    """体と髪の範囲で差が最小になるずらし量 (dx, dy)。var を (-dx, -dy) 動かすと base に重なる"""
    y0, y1, x0, x1 = box
    bg = on_white(base).mean(-1)
    vg = on_white(var).mean(-1)
    best = (1e9, 0, 0)
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            d = np.abs(bg[y0:y1, x0:x1] - vg[y0 + dy : y1 + dy, x0 + dx : x1 + dx]).mean()
            if d < best[0]:
                best = (d, dx, dy)
    return best[1], best[2]


def shift(a, dx, dy):
    """画像を (-dx, -dy) ずらす（はみ出た所は透明）"""
    out = np.zeros_like(a)
    h, w = a.shape[:2]
    ys = slice(max(0, -dy), min(h, h - dy))
    xs = slice(max(0, -dx), min(w, w - dx))
    yd = slice(max(0, dy), min(h, h + dy))
    xd = slice(max(0, dx), min(w, w + dx))
    out[ys, xs] = a[yd, xd]
    return out


def connected_to(mask, seed):
    """mask のうち seed とつながっている部分だけ残す（4 近傍の塗りつぶし）"""
    from collections import deque

    out = np.zeros_like(mask)
    ys, xs = np.nonzero(seed & mask)
    q = deque(zip(ys.tolist(), xs.tolist()))
    for y, x in q:
        out[y, x] = True
    h, w = mask.shape
    while q:
        y, x = q.popleft()
        for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
            if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not out[ny, nx]:
                out[ny, nx] = True
                q.append((ny, nx))
    return out


def fill_from_surroundings(rgb, hole, known, iterations=40):
    """hole の中を、周り（known）の色から少しずつにじませて埋める（白目の塗りつぶし用）"""

    def blur(x):
        im = Image.fromarray((np.clip(x, 0, 1) * 255).astype(np.uint8))
        return np.asarray(im.filter(ImageFilter.BoxBlur(2))).astype(np.float32) / 255.0

    val = np.where(known[..., None], rgb, 0.0)
    done = known.copy()
    for _ in range(iterations):
        w = blur(done.astype(np.float32))
        est = np.stack([blur(val[..., c] * done) for c in range(3)], -1) / np.maximum(w[..., None], 1e-3)
        reach = hole & ~done & (w > 0.05)
        if not reach.any():
            break
        val = np.where(reach[..., None], est, val)
        done |= reach
    return np.where(hole[..., None], val, rgb)


def make_gaze_parts(base, cl):
    """目線用のパーツを基本画像から作る
    eye_socket.png: 黒目を消して白目で埋めた目（開いた目の土台）
    iris.png:       黒目だけ（アプリがずらして描く）
    eye_mask.png:   黒目が見えてよい範囲（R=画面左の目、G=画面右の目）"""
    irises = cl.get("irises", [])
    cores = cl.get("eyeCores", [])
    if len(irises) != 2 or len(cores) != 2:
        print("目線パーツ: cleanup.irises と cleanup.eyeCores が 2 つずつ無いのでスキップ")
        return
    H, W = base.shape[:2]
    rgb = base[..., :3]
    mx = rgb.max(-1)
    mn = rgb.min(-1)
    sat = (mx - mn) / (mx + 1e-6)
    dark = mx < 0.38  # まつ毛・目の輪郭
    white = (sat < 0.16) & (mx > 0.78)  # 白目

    socket = base.copy()
    iris_img = np.zeros_like(base)
    mask = np.zeros((H, W, 4), np.float32)
    mask[..., 3] = 1.0
    for i, (ir, co) in enumerate(zip(irises, cores)):
        core = ellipse_mask((H, W), co)
        inner = ellipse_mask((H, W), ir, 0.7)  # 瞳孔の周りは暗くてもまつ毛ではない
        ell = ellipse_mask((H, W), ir) & core
        # 各列を黒目の上端から下へ見て、まつ毛（暗い画素）が続く所までをまぶたとする
        lid = np.zeros((H, W), bool)
        for x in range(max(0, int(ir["cx"] - ir["rx"])), min(W, int(ir["cx"] + ir["rx"]) + 1)):
            ys = np.nonzero(ell[:, x])[0]
            for y in ys:
                if dark[y, x] and not inner[y, x]:
                    lid[y, x] = True
                else:
                    break
        iris = ell
        opening = (white & core) | (ell & ~lid)
        opening = soften(opening, 1, 0) > 0.5
        opening = np.asarray(Image.fromarray((opening * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(3))) > 127
        opening = connected_to(opening & ~lid & ~(dark & ~ell), ell & ~lid)

        # 黒目の色: まぶたに隠れた上の部分は、見えている一番上の色を上へ伸ばして補う
        iris_rgb = rgb.copy()
        for x in range(max(0, int(ir["cx"] - ir["rx"])), min(W, int(ir["cx"] + ir["rx"]) + 1)):
            ys = np.nonzero(ell[:, x] & ~lid[:, x])[0]
            if len(ys):
                top = ys[0]
                iris_rgb[: top, x] = rgb[top, x]

        # 白目で黒目の場所を埋める（黒目が動いたときに反対側に見える部分）
        hole = (soften(ell, 1, 0) > 0.5) & opening
        filled = fill_from_surroundings(rgb, hole, opening & ~hole)
        smooth = np.stack([np.asarray(Image.fromarray((filled[..., c] * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(2))) / 255.0 for c in range(3)], -1)
        filled = np.where(hole[..., None], smooth, filled)
        socket[..., :3] = np.where(hole[..., None], filled, socket[..., :3])

        soft_iris = soften(ell, 0, 1.0)
        iris_img[..., :3] = np.where(ell[..., None] | (soft_iris[..., None] > 0), iris_rgb, iris_img[..., :3])
        iris_img[..., 3] = np.maximum(iris_img[..., 3], soft_iris)
        mask[..., i] = soften(opening, 0, 0.8)
        print(f"目線パーツ: 目{i + 1} 黒目 {int(iris.sum())} px / 見える範囲 {int(opening.sum())} px")
    save(socket, OUT / "eye_socket.png")
    save(iris_img, OUT / "iris.png")
    save(mask, OUT / "eye_mask.png")


def save(a, path):
    Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8), "RGBA").save(path, optimize=True)


def main():
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    cl = cfg.get("cleanup", {})
    eye_cores = cl.get("eyeCores", [])
    brow_cores = cl.get("browCores", [])
    mouth_cores = cl.get("mouthCores", [])
    reuse = cl.get("reuse", {})  # {"パーツ名": "元画像のパーツ名"}
    grow = int(cl.get("hairGrow", 3))
    blur = float(cl.get("edgeBlur", 1.5))

    sources = {p.stem: p for p in sorted(SRC.iterdir()) if p.suffix.lower() in (".png", ".webp", ".jpg", ".jpeg")}
    if "base" not in sources:
        sys.exit(f"{SRC} に base.png がありません")

    base = load_rgba(sources["base"])
    H, W = base.shape[:2]
    if (W, H) != (cfg["canvas"]["width"], cfg["canvas"]["height"]):
        print(f"注意: base の大きさ {W}x{H} が avatar.json の canvas と違います")
    OUT.mkdir(parents=True, exist_ok=True)
    save(base, OUT / "base.png")
    print("base: そのまま")

    base_hair = hair_mask(base)
    eyes = np.zeros((H, W), bool)
    for e in eye_cores:
        eyes |= ellipse_mask((H, W), e)
    for e in mouth_cores:  # 口の中は髪と同じ赤みの色なので、色では見分けず保護する
        eyes |= ellipse_mask((H, W), e)
    brows = np.zeros((H, W), bool)
    for e in brow_cores:
        brows |= ellipse_mask((H, W), e)

    jobs = [(name, name) for name in sources if name != "base"]
    jobs += [(part, src) for part, src in reuse.items() if src in sources and part not in sources]

    body_box = (int(H * 0.45), int(H * 0.9), int(W * 0.1), int(W * 0.9))
    for part, src in jobs:
        var = load_rgba(sources[src])
        if var.shape != base.shape:
            print(f"{part}: 大きさが base と違うのでスキップ ({var.shape[1]}x{var.shape[0]})")
            continue
        dx, dy = find_shift(base, var, body_box)
        var = shift(var, dx, dy)

        keep_var = eyes | (brows if part.startswith("exp_") else np.zeros_like(eyes))
        either_hair = (base_hair | hair_mask(var)) & ~keep_var
        use_base = soften(either_hair, grow, blur)
        # 目・眉の保護範囲のふちもなめらかに
        use_base = np.minimum(use_base, 1 - soften(keep_var, 0, 2.0))

        out = var * (1 - use_base[..., None]) + base * use_base[..., None]
        save(out, OUT / f"{part}.png")
        print(f"{part}: 元画像 {src}、位置補正 ({-dx:+d}, {-dy:+d}) px、髪を base に統一")

    make_gaze_parts(base, cl)

    # 位置は画像側で合わせたので、アプリ側の補正は 0 に戻す
    cfg["align"] = {}
    CONFIG.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("完了: avatar/parts/ を更新しました")


if __name__ == "__main__":
    main()
