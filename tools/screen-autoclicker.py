"""屏幕自动化：模板匹配点「部署建议」，再用 HSV 找黄色部署格点掉。

两段式流程
----------
1. **找按钮**：截取整屏，拿 `suggest_btn.png` 做模板匹配
   （`cv2.matchTemplate` + `TM_CCOEFF_NORMED`，默认阈值 0.8），
   相似度够就点「部署建议」按钮，让 AI 把推荐格标出来。
2. **找格子**：建议出现后地图上会画一个虚线高亮框。截屏后裁掉四周
   （默认 10%）缩小搜索区域，在 HSV 空间提取黄/橙色，用形态学闭运算把虚线
   连成整圈，再按外接框边长与长宽比筛出「方块」并点它的中心。

为什么用边长而不是面积：这个虚线框边长约 `T = 60`，二值化后是二十来段 7×3 的短线，
闭运算连成整圈后它的 `contourArea` 约等于 `T² ≈ 3600`，用「面积 20–1000」反而会
把它筛掉。边长窗口（默认 30–110 px）才是这套画面里稳的判据。

防干扰：裁掉外围、边长窗口挡图标与文字、长宽比 0.7–1.3 挡长方形。
`--dry-run` 可以先只看坐标不点鼠标。

本脚本不含任何模型，只是执行器，配合 `deployment-advice.js` 使用。

用法::

    python tools/screen-autoclicker.py                # 正常跑
    python tools/screen-autoclicker.py --dry-run      # 只打印坐标，不点
    python tools/screen-autoclicker.py --roi 0.2      # 裁掉四周 20%
    python tools/screen-autoclicker.py --threshold 0.75

按 Ctrl+C 停止；鼠标甩到屏幕左上角会触发 pyautogui 的 FAILSAFE，同样能停。
"""

import argparse
import ctypes
import time
from pathlib import Path

import cv2
import mss
import numpy as np
import pyautogui

HERE = Path(__file__).resolve().parent
DEFAULT_TEMPLATE = HERE / "suggest_btn.png"

# HSV 黄/橙区间（OpenCV 色相 0-179，对应 20°-100°）。
LO = np.array([10, 80, 80])
HI = np.array([50, 255, 255])

# 目标格子的外接框边长范围与长宽比：太小是噪点，太大是大色块，比例接近 1 才是方块。
RATIO_MIN, RATIO_MAX = 0.7, 1.3


def enable_dpi_awareness():
    """让进程感知 DPI，否则截图坐标与鼠标坐标在 125% / 150% 缩放下对不上。"""
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


def grab():
    """抓主显示器整屏，返回 BGR 图像。"""
    with mss.mss() as sct:
        shot = np.array(sct.grab(sct.monitors[1]))
    return cv2.cvtColor(shot, cv2.COLOR_BGRA2BGR)


def click_at(x, y, dry_run=False):
    if dry_run:
        print(f"[dry-run] 点击 ({x}, {y})")
        return
    pyautogui.moveTo(x, y)
    pyautogui.click()


def find_button(screen, template, threshold):
    """模板匹配找「部署建议」按钮，返回 ((cx, cy) 或 None, 相似度)。"""
    if template is None:
        return None, 0.0
    th, tw = template.shape[:2]
    sh, sw = screen.shape[:2]
    if th > sh or tw > sw:
        print("模板比屏幕还大，检查 suggest_btn.png 是否截对。")
        return None, 0.0

    screen_gray = cv2.cvtColor(screen, cv2.COLOR_BGR2GRAY)
    template_gray = cv2.cvtColor(template, cv2.COLOR_BGR2GRAY)
    result = cv2.matchTemplate(screen_gray, template_gray, cv2.TM_CCOEFF_NORMED)
    _, score, _, loc = cv2.minMaxLoc(result)
    if score < threshold:
        return None, score
    return (loc[0] + tw // 2, loc[1] + th // 2), score


def find_box(screen, roi, dilate, min_side, max_side):
    """在裁剪后的区域里找黄色方块，返回全屏坐标 (cx, cy) 或 None。"""
    h, w = screen.shape[:2]
    dx, dy = int(w * roi), int(h * roi)
    region = screen[dy:h - dy, dx:w - dx]
    if region.size == 0:
        region, dx, dy = screen, 0, 0

    hsv = cv2.cvtColor(region, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, LO, HI)

    # 虚线框会被切成一段段短线，闭运算把它们连成整圈。
    if dilate > 0:
        kernel = np.ones((dilate * 2 + 1, dilate * 2 + 1), np.uint8)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    best = None
    best_score = 9.9
    for contour in contours:
        if cv2.contourArea(contour) < 20:  # 噪点下限
            continue
        x, y, bw, bh = cv2.boundingRect(contour)
        if not (min_side <= bw <= max_side and min_side <= bh <= max_side):
            continue
        ratio = bw / float(bh)
        if not (RATIO_MIN < ratio < RATIO_MAX):
            continue
        score = abs(ratio - 1.0)  # 越接近正方形越可能是目标
        if score < best_score:
            best_score = score
            best = dx + x + bw // 2, dy + y + bh // 2
    return best


def main():
    parser = argparse.ArgumentParser(description="模板匹配点按钮 + HSV 找黄框点击")
    parser.add_argument("--template", default=str(DEFAULT_TEMPLATE), help="按钮模板图片路径")
    parser.add_argument("--threshold", type=float, default=0.8, help="模板匹配阈值，默认 0.8")
    parser.add_argument("--roi", type=float, default=0.1, help="裁掉四周的比例，默认 0.1")
    parser.add_argument("--dilate", type=int, default=2, help="闭运算核半径，0 表示不做，默认 2")
    parser.add_argument("--min-side", type=int, default=30, help="格子边长下限 px，默认 30")
    parser.add_argument("--max-side", type=int, default=110, help="格子边长上限 px，默认 110")
    parser.add_argument("--dry-run", action="store_true", help="只打印坐标，不点鼠标")
    parser.add_argument("--delay", type=float, default=1.0, help="每轮间隔秒数，默认 1.0")
    args = parser.parse_args()

    enable_dpi_awareness()
    pyautogui.PAUSE = 0.05

    template_path = Path(args.template)
    template = cv2.imread(str(template_path), cv2.IMREAD_COLOR)
    if template is None:
        print(f"没找到模板 {template_path}，退化为只做 HSV 找框。")
        print("可以先用 python tools/capture-button.py 截一张按钮样本。")

    print("程序已启动，3 秒后开始；Ctrl+C 停止。")
    time.sleep(3)

    last_score_log = 0.0
    while True:
        try:
            screen = grab()

            # 先看有没有黄框：有就直接部署，避免反复点「部署建议」。
            box = find_box(screen, args.roi, args.dilate, args.min_side, args.max_side)
            if box:
                print("找到部署格，点击", box)
                click_at(*box, dry_run=args.dry_run)
                time.sleep(1.5)
                continue

            if template is not None:
                center, score = find_button(screen, template, args.threshold)
                if center:
                    print(f"匹配到「部署建议」({score:.2f})，点击", center)
                    click_at(*center, dry_run=args.dry_run)
                    time.sleep(2.0)  # 等建议面板和虚线框画出来
                    screen = grab()
                    box = find_box(screen, args.roi, args.dilate, args.min_side, args.max_side)
                    if box:
                        print("找到部署格，点击", box)
                        click_at(*box, dry_run=args.dry_run)
                        time.sleep(1.5)
                elif time.time() - last_score_log > 10:
                    last_score_log = time.time()
                    print(f"模板最高相似度 {score:.2f}，低于阈值 {args.threshold}，先不点按钮。")

            time.sleep(args.delay)
        except KeyboardInterrupt:
            print("停止。")
            return
        except pyautogui.FailSafeException:
            print("触发 FAILSAFE（鼠标到左上角），停止。")
            return


if __name__ == "__main__":
    main()
