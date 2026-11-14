# 来源与许可说明

## 原始游戏

本项目最初基于 [gamelabz/html5-game-tower-defense](https://github.com/gamelabz/html5-game-tower-defense) 改造。

上游版权声明为 `Copyright (c) 2026 gamelabz`，许可证为 MIT。仓库根目录的 [LICENSE](LICENSE) 保留此声明和许可正文，并注明本项目贡献者。

核对来源：[上游 LICENSE](https://github.com/gamelabz/html5-game-tower-defense/blob/main/LICENSE)，核对日期 2026-11-14。

## 当前界面与实验材料

- 当前游戏的图标由 `design-assets.js` 中的内联 SVG 描述，战斗图形由 Canvas 绘制。历史开发说明提到参考小组设计稿，本次整理没有新增外部图片或音频，也未附带原设计稿。
- `docs/figures/` 中的三张图片是项目历史实验图，数据来源与代码版本见 [历史实验说明](docs/history.md)。
- 游戏生成的训练示例和模型权重随项目提供，生成与训练方法见 [训练指南](docs/training.md)。
- 学校 PPT 模板、校徽原文件、微信聊天截图及个人课程作业不包含在本次项目提交中。

## 训练工具

训练依赖 NumPy、PyTorch 和 scikit-learn，数据生成与评估使用 Node.js。仓库只提供依赖清单，不打包这些工具的安装文件；各工具的许可信息以其官方发行包为准。
