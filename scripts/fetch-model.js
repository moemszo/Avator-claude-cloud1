// MediaPipe の顔ランドマークモデルを models/ にダウンロードする（npm install 時に自動実行）。
// 失敗してもアプリはネット上のモデルを直接読み込むので、インストール自体は止めない。
import { createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'models', 'face_landmarker.task');

if (existsSync(dest)) {
  console.log('[fetch-model] モデルは既にあります:', dest);
  process.exit(0);
}
mkdirSync(dirname(dest), { recursive: true });
const tmp = dest + '.part';

https
  .get(MODEL_URL, (res) => {
    if (res.statusCode !== 200) {
      console.warn(`[fetch-model] ダウンロード失敗 (HTTP ${res.statusCode})。実行時にネットから読み込みます。`);
      res.resume();
      return;
    }
    const file = createWriteStream(tmp);
    res.pipe(file);
    file.on('finish', () => {
      file.close();
      renameSync(tmp, dest);
      console.log('[fetch-model] モデルを保存しました:', dest);
    });
  })
  .on('error', (err) => {
    if (existsSync(tmp)) unlinkSync(tmp);
    console.warn('[fetch-model] ダウンロード失敗:', err.message, '— 実行時にネットから読み込みます。');
  });
