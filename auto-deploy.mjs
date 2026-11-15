import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findButton, findHighlightedCell } from './vision.mjs';

const localRequire = createRequire(import.meta.url);
// 优先使用 npm ci 安装的依赖。本机已有 Codex 运行库时，也可用其中的依赖启动。
const bundledRequire = createRequire(join(homedir(), '.cache', 'codex-runtimes',
  'codex-primary-runtime', 'dependencies', 'node', 'package.json'));
const gameUrl = new URL('./index.html', import.meta.url).href;
const templateFile = fileURLToPath(new URL('./suggest_btn.png', import.meta.url));
const timeout = 5000;

function loadDependency(name) {
  for (const require of [localRequire, bundledRequire]) {
    try {
      return require(name);
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  throw new Error('缺少视觉部署依赖。请在游戏目录运行 npm ci。');
}

async function clickPixel(page, target, image, pixel) {
  const bounds = await target.boundingBox();
  if (!bounds) return false;
  // 图像坐标以截图或画布左上角为原点。缩放并平移到当前浏览器视口的 CSS 坐标。
  const x = bounds.x + pixel.x * bounds.width / image.width;
  const y = bounds.y + pixel.y * bounds.height / image.height;
  // 页面滚动或元素遮挡时，命中检查可以避免误点其他控件。
  const hitsTarget = await page.evaluate(({ x, y, id }) => {
    const hit = document.elementFromPoint(x, y);
    return hit?.id === id && !hit.disabled;
  }, { x, y, id: pixel.id });
  if (!hitsTarget) return false;
  await page.mouse.click(x, y);
  return true;
}

async function deployOnce(page, PNG, template) {
  const advice = page.locator('#btn-advise');
  const result = page.locator('#deployment-result');
  if (await advice.isDisabled()) return '开波前可使用自动部署。';

  // 模板只在雷达按钮区搜索，点击位置来自像素匹配结果。
  const controls = page.locator('.deployment-controls');
  const controlsImage = PNG.sync.read(await controls.screenshot({ scale: 'css', timeout }));
  const button = findButton(controlsImage, template);
  if (!button || !await clickPixel(page, controls, controlsImage, { ...button, id: 'btn-advise' })) {
    return '未能从雷达图像识别「部署建议」按钮，请重试。';
  }

  // 用原有雷达文案确认模型给出了建议，目标格的坐标由下方图像识别提供。
  const recommendation = await result.innerText({ timeout });
  if (!recommendation.includes('点击黄色格子部署')) return '';

  // 等待游戏绘制建议框，再读取棋盘画布的原始像素。
  const board = page.locator('#game');
  await board.scrollIntoViewIfNeeded({ timeout });
  const dataUrl = await board.evaluate(async canvas => {
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
    return canvas.toDataURL('image/png');
  }, undefined, { timeout });
  const boardImage = PNG.sync.read(Buffer.from(dataUrl.split(',')[1], 'base64'));
  const cell = findHighlightedCell(boardImage);
  // 识别期间开波、暂停或取消建议时，旧截图里的格子可能已失效。
  if (await advice.isDisabled() || await result.innerText({ timeout }) !== recommendation) {
    return '游戏状态已变化，请重新点击「自动部署」。';
  }
  if (!cell || !await clickPixel(page, board, boardImage, { ...cell, id: 'game' })) {
    return '未能从棋盘图像定位唯一的推荐格，可手动点击黄框。';
  }
  return (await result.innerText({ timeout })).startsWith('已部署')
    ? '' : '未收到部署确认，请检查棋盘后重试。';
}

async function connectControls(page, PNG, template) {
  let busy = false;
  await page.exposeBinding('requestVisionDeployment', async ({ frame }) => {
    // 只响应本地游戏主页面。一次请求完成后才接受下一次部署。
    if (frame !== page.mainFrame() || frame.url() !== gameUrl || busy) return '';
    busy = true;
    try {
      return await deployOnce(page, PNG, template);
    } catch (error) {
      console.error(error.message);
      return '自动部署未完成，请确认游戏窗口可见后重试。';
    } finally {
      busy = false;
    }
  });

  // 页面刷新后仍会接入本地视觉助手。
  await page.addInitScript(url => {
    if (location.href !== url) return;
    window.addEventListener('DOMContentLoaded', () => {
      const auto = document.getElementById('btn-auto-deploy');
      const advice = document.getElementById('btn-advise');
      const result = document.getElementById('deployment-result');
      const status = document.getElementById('vision-status');
      let pending = false;
      const sync = () => { auto.disabled = advice.disabled || pending; };
      const show = text => { status.textContent = text; status.hidden = !text; };
      new MutationObserver(sync).observe(advice, { attributeFilter: ['disabled'] });
      new MutationObserver(() => { if (!pending) show(''); }).observe(result, { childList: true });
      auto.addEventListener('click', async () => {
        if (pending || advice.disabled) return;
        pending = true;
        sync();
        show('正在识别部署建议和棋盘…');
        try {
          show(await window.requestVisionDeployment());
        } catch {
          show('本地视觉助手已断开，请重新启动游戏。');
        } finally {
          pending = false;
          sync();
        }
      });
      sync();
      auto.hidden = false;
    }, { once: true });
  }, gameUrl);
}

export async function openGame({ headless = false, viewport = null, captureTemplate = false } = {}) {
  const { chromium } = loadDependency('playwright');
  const { PNG } = loadDependency('pngjs');
  const browser = await chromium.launch({ channel: 'msedge', headless, args: ['--start-maximized'] });
  try {
    const page = await browser.newPage({ viewport });
    if (!captureTemplate) await connectControls(page, PNG, PNG.sync.read(await readFile(templateFile)));
    await page.goto(gameUrl, { waitUntil: 'domcontentloaded' });
    if (captureTemplate) {
      await page.evaluate(() => document.fonts.ready);
      await page.locator('#btn-advise').screenshot({ path: templateFile, scale: 'css', timeout });
    }
    return { browser, page };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const captureTemplate = process.argv.includes('--capture-template');
    const { browser } = await openGame({ headless: captureTemplate, captureTemplate });
    if (captureTemplate) await browser.close();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
