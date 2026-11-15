const matchThreshold = 0.8;
// 与 game.js 的 T 及 draw() 里的推荐框 strokeRect 保持一致。
const tileSize = 60;
const frameInset = 4;

function grayscale(image, x, y) {
  const i = (y * image.width + x) * 4;
  return 0.299 * image.data[i] + 0.587 * image.data[i + 1] + 0.114 * image.data[i + 2];
}

export function findButton(image, template) {
  // 比对按钮内的字样，避开边框和鼠标悬停时变化的描边。
  const inset = 4;
  const width = template.width - 2 * inset;
  const height = template.height - 2 * inset;
  const count = width * height;
  const reference = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    reference[i] = grayscale(template, inset + i % width, inset + Math.floor(i / width));
  }
  const mean = reference.reduce((sum, value) => sum + value, 0) / count;
  // 归一化相关会去掉两个窗口各自的平均亮度，减小背景明暗变化对得分的影响。
  let referenceEnergy = 0;
  for (let i = 0; i < count; i++) {
    reference[i] -= mean;
    referenceEnergy += reference[i] ** 2;
  }

  const scan = new Float64Array(image.width * image.height);
  for (let i = 0; i < scan.length; i++) {
    scan[i] = grayscale(image, i % image.width, Math.floor(i / image.width));
  }

  let best = null;
  let bestScore = matchThreshold;
  for (let y = 0; y <= image.height - height; y++) {
    for (let x = 0; x <= image.width - width; x++) {
      let sum = 0;
      let squares = 0;
      let dot = 0;
      for (let row = 0; row < height; row++) {
        const offset = (y + row) * image.width + x;
        for (let col = 0; col < width; col++) {
          const value = scan[offset + col];
          sum += value;
          squares += value * value;
          dot += value * reference[row * width + col];
        }
      }
      // 模板已去均值，因此点积中的扫描窗口可以直接使用原灰度值。
      const energy = squares - sum * sum / count;
      if (energy <= 0 || referenceEnergy <= 0) continue;
      const score = dot / Math.sqrt(energy * referenceEnergy);
      if (score > bestScore) {
        bestScore = score;
        best = { x: x + width / 2, y: y + height / 2 };
      }
    }
  }
  return best;
}

function isFramePixel(image, x, y) {
  const i = (y * image.width + x) * 4;
  const [r, g, b] = [image.data[i], image.data[i + 1], image.data[i + 2]];
  // 橙黄色段的红通道最大、蓝通道最小。r 是明度，spread / r 是饱和度。
  if (r < 140 || r <= g || g <= b) return false;
  const spread = r - b;
  const hue = 60 * (g - b) / spread;
  return hue >= 22 && hue <= 44 && spread / r >= 0.5;
}

function edgeCoverage(test) {
  const length = tileSize - 2 * frameInset;
  let hits = 0;
  for (let i = 0; i < length; i++) {
    // 在边线垂直方向取相邻像素，允许线宽和抗锯齿造成的小幅偏差。
    if (test(i, 0) || test(i, -1) || test(i, 1)) hits++;
  }
  return hits / length;
}

export function findHighlightedCell(image) {
  if (image.width !== 16 * tileSize || image.height !== 9 * tileSize) return null;
  let found = null;
  for (let y = 0; y < image.height; y += tileSize) {
    for (let x = 0; x < image.width; x += tileSize) {
      const left = x + frameInset;
      const right = x + tileSize - frameInset;
      const top = y + frameInset;
      const bottom = y + tileSize - frameInset;
      // 虚线的实线段应覆盖每条边的至少 40%。四条边都满足才算一个框。
      if (edgeCoverage((i, d) => isFramePixel(image, left + i, top + d)) < 0.4 ||
          edgeCoverage((i, d) => isFramePixel(image, left + i, bottom + d)) < 0.4 ||
          edgeCoverage((i, d) => isFramePixel(image, left + d, top + i)) < 0.4 ||
          edgeCoverage((i, d) => isFramePixel(image, right + d, top + i)) < 0.4) continue;
      // 多个候选意味着图像不足以确定唯一推荐格，交给玩家确认。
      if (found) return null;
      found = { x: x + tileSize / 2, y: y + tileSize / 2 };
    }
  }
  return found;
}
