"""截取按钮样本：把「部署建议」按钮存成模板，供 screen-autoclicker.py 匹配。

用法::

    python tools/capture-button.py

运行后把鼠标移到「部署建议」按钮的中心，按 Enter，脚本会以鼠标为中心
截取一块区域存成 `tools/suggest_btn.png`。默认 160×48，可用 --width /
--height 调整。截完打开图片看一眼：只留按钮，不要带进旁边的内容。
"""

import argparse
import ctypes
import time
from pathlib import Path

import mss
import numpy as np
from PIL import Image
import pyautogui

HERE = Path(__file__).resolve().parent


def enable_dpi_awareness():
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


def main():
    parser = argparse.ArgumentParser(description="截取鼠标周围的区域作为模板")
    parser.add_argument("--width", type=int, default=160, help="截取宽度，默认 160")
    parser.add_argument("--height", type=int, default=48, help="截取高度，默认 48")
    parser.add_argument("--out", default=str(HERE / "suggest_btn.png"), help="输出路径")
    args = parser.parse_args()

    enable_dpi_awareness()
    print("5 秒后开始倒计时……把「部署建议」按钮留在地图上。")
    time.sleep(5)

    while True:
        command = input("把鼠标放到按钮中心，按 Enter 截取（输入 q 退出）：").strip()
        if command.lower() == "q":
            return
        x, y = pyautogui.position()
        left, top = x - args.width // 2, y - args.height // 2
        with mss.mss() as sct:
            shot = np.array(
                sct.grab({"left": left, "top": top, "width": args.width, "height": args.height})
            )
        # BGRA -> RGB
        image = Image.fromarray(shot[:, :, [2, 1, 0]])
        image.save(args.out)
        print(f"已保存 {args.out}（{args.width}×{args.height}，中心 {x}, {y}）")


if __name__ == "__main__":
    main()
