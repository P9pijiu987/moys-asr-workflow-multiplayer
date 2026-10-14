// [multiplayer] 头像的 Canvas 即时预览：由 MaweAssCanvas.render 在绘制文字前后各调用一次，
// 分别绘制「文字后」与「文字前」两层头像，与烧录滤镜链的顺序（文字后头像 → 字幕 →
// 文字前头像）一致。坐标是 PlayRes 原生像素，来自共享排版计划。
(function initMaweMultiplayerAvatarCanvas(global) {
  'use strict';

  const images = new Map();
  let refreshScheduled = false;

  function scheduleRefresh() {
    if (refreshScheduled) return;
    refreshScheduled = true;
    requestAnimationFrame(() => {
      refreshScheduled = false;
      global.MawePlaybackLoop?.refreshSubtitlePreview?.();
    });
  }

  function imageFor(assetId) {
    const cached = images.get(assetId);
    if (cached) return cached.ready ? cached.image : null;
    const asset = global.MaweMultiplayer?.asset(assetId);
    if (!asset?.data) return null;
    const image = new Image();
    const entry = { image, ready: false };
    images.set(assetId, entry);
    image.onload = () => { entry.ready = true; scheduleRefresh(); };
    image.onerror = () => { images.delete(assetId); };
    image.src = `data:${asset.mime};base64,${asset.data}`;
    return null;
  }

  function hexToRgba(hex, opacityPercent) {
    const value = /^#[0-9a-f]{6}$/iu.test(String(hex || '')) ? hex : '#000000';
    const alpha = Math.min(100, Math.max(0, Number(opacityPercent) || 0)) / 100;
    return `rgba(${parseInt(value.slice(1, 3), 16)}, ${parseInt(value.slice(3, 5), 16)}, ${parseInt(value.slice(5, 7), 16)}, ${alpha})`;
  }

  // 形状路径：圆形 / 圆角（radius 为边长比例）/ 方形。
  function shapePath(g, x, y, size, shape, radius) {
    g.beginPath();
    if (shape === 'circle') g.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    else if (shape === 'rounded' && typeof g.roundRect === 'function') g.roundRect(x, y, size, size, Math.max(0, radius) * size);
    else g.rect(x, y, size, size);
    g.closePath();
  }

  // 居中裁切成正方形（cover），与烧录侧 Pillow 预处理的裁切规则一致。
  function coverSource(image) {
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    const side = Math.min(width, height);
    return { sx: (width - side) / 2, sy: (height - side) / 2, side };
  }

  // 裁切后的头像贴图（离屏画布，按资源 / 尺寸 / 形状缓存）；阴影随贴图的 alpha 生成，
  // 透明 PNG 不会出现方形黑底，与烧录侧用 alpha 生成阴影的规则一致。
  const tiles = new Map();
  function tileFor(assetId, image, size, shape, radius) {
    const pixel = Math.max(1, Math.round(size));
    const key = `${assetId}|${pixel}|${shape}|${radius}`;
    if (tiles.has(key)) return tiles.get(key);
    const canvas = document.createElement('canvas');
    canvas.width = pixel;
    canvas.height = pixel;
    const g = canvas.getContext('2d');
    const source = coverSource(image);
    shapePath(g, 0, 0, pixel, shape, radius);
    g.clip();
    g.drawImage(image, source.sx, source.sy, source.side, source.side, 0, 0, pixel, pixel);
    if (tiles.size > 64) tiles.delete(tiles.keys().next().value);
    tiles.set(key, canvas);
    return canvas;
  }

  function drawOne(g, avatar) {
    const image = imageFor(avatar.assetId);
    if (!image) return;
    const { x, y, size } = avatar;
    const alpha = Math.min(1, Math.max(0, (Number(avatar.opacity) / 100) * (avatar.fade ?? 1)));
    if (alpha <= 0 || size <= 0) return;
    const tile = tileFor(avatar.assetId, image, size, avatar.shape, avatar.radius);
    g.save();
    g.globalAlpha = alpha;
    if (avatar.shadow) {
      g.shadowColor = hexToRgba(avatar.shadow.color, avatar.shadow.opacity);
      g.shadowBlur = avatar.shadow.blur;
      g.shadowOffsetX = avatar.shadow.x;
      g.shadowOffsetY = avatar.shadow.y;
    }
    g.drawImage(tile, x, y, size, size);
    g.restore();
  }

  function draw(g, avatars, layer) {
    if (!g || !Array.isArray(avatars) || !avatars.length) return;
    avatars.forEach((avatar) => { if ((avatar.layer || 'above') === layer) drawOne(g, avatar); });
  }

  function clear() {
    images.clear();
    tiles.clear();
  }

  global.MaweMultiplayerAvatarCanvas = Object.freeze({ draw, clear });
})(typeof window !== 'undefined' ? window : globalThis);
