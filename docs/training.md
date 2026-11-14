# 训练与复现

## 环境

游戏本身只需浏览器。以下环境用于离线数据生成、模型训练和评估，本次整理时核对并使用：

| 依赖 | 版本 |
|---|---|
| Node.js | 24.16.0 |
| Python | 3.11.17 |
| NumPy | 2.4.6 |
| PyTorch | 2.14.1 |
| scikit-learn | 1.9.1 |

在项目根目录安装 Python 依赖：

```sh
python -m pip install -r requirements.txt
```

可以先创建独立 Python 环境，再安装依赖。Node.js 脚本只使用内置模块，无需 `npm install`。当前训练代码使用 CPU，默认 4 个线程。不同系统或依赖版本下重训的浮点结果可能不同。

## 快速检查流程

`ml/examples/sample.jsonl` 从第一批正式数据中选取前八个至少有两个候选的组，每组保留原布局与前两个候选方案，共 24 条记录，适合检查读取、训练、导出流程。它不足以训练有效模型，不能用于报告准确率。

```sh
python -c "from pathlib import Path; Path('ml/outputs').mkdir(exist_ok=True)"
python ml/train-deployment.py ml/examples/sample.jsonl --epochs 1 --output ml/outputs/smoke-model.js
```

输出目录已被 Git 忽略。以上命令保留网页正在使用的正式模型。

## 生成完整训练数据

以下命令均在项目根目录执行，四批使用不同的布局随机种子：

```sh
node ml/simulate-deployment.cjs 1000 260624
node ml/simulate-deployment.cjs 1000 270624
node ml/simulate-deployment.cjs 1000 280624
node ml/simulate-deployment.cjs 1000 290624
```

每批请求 1,000 个起始布局，并生成原布局和抽样单塔候选的战斗结果。非法或封路布局会被跳过，实际记录数量由布局及规则决定。生成文件为 `ml/cnn-<随机种子>.jsonl`；重复使用相同种子会覆盖同名文件。

原始数据的代码基准为 `691debf`。完整四批共 76,090 条记录，包含 52,508 条训练、8,763 条验证和 14,819 条测试记录。文件校验值见 [实验数据](results.json)，可以用于确认数据是否与已报告实验一致。

完整 JSONL 数据不提交到 Git；需要共享时，可附带校验值与代码版本单独打包。示例数据位于 `ml/examples/`。

### 数据字段

| 字段 | 含义 |
|---|---|
| `group` | 生成批次与起始布局标识，同组包括原布局及其候选 |
| `baseline` | 是否为原布局 |
| `features` | 67 项数值特征，顺序与 `deployment-advice.js` 保持一致 |
| `map` | 六个通道中占据的格子索引，格子索引为 `行 × 16 + 列`；第六通道按路径顺序排列 |
| `leaked` | 整波实际漏怪数，最终回归目标依据 |
| `total` | 该候选波次的敌人总数 |
| `bossLeaked` | 实际漏过的 Boss 数，用于评估 |
| `baseDamage` | 基地实际掉血量，用于评估 |

记录由离线游戏程序自动生成，无须人工标注。训练只把 `features` 和 `map` 作为网络输入，不把实际漏怪结果作为输入。

## 数据拆分与标准化

1. 同一起始塔阵与同一波次作为一组；即使生成种子或金币不同，也合并相同塔阵与波次，减少相似候选跨训练/测试集合的泄漏。
2. 用 `GroupShuffleSplit` 留出约 20% 的组用于测试，随机种子为 42。
3. 在其余组中再留出约 15% 用于验证，随机种子为 43。组大小不同，所以记录数量不严格符合比例。
4. `StandardScaler` 只在训练集拟合，对 67 项数值特征做 `(x - mean) / scale` 转换。
5. 地图前五通道为炮塔位置的 0/1 表示，第六通道沿路线用 1–2 表示进度；地图不使用上述数值标准化。

## 模型与训练目标

CNN 分支使用两层 `3 × 3` 卷积，通道数 `6 → 12 → 16`，步长 2、填充 1，每层后接 ReLU。自适应平均池化到 `2 × 2`，展开后得到 64 项空间特征。

将 64 项空间特征与 67 项数值特征拼接后，全连接网络结构为 `131 → 96 → 48 → 1`，两个隐藏层使用 ReLU。纯 MLP 对照去掉卷积分支，全连接结构为 `67 → 96 → 48 → 1`。

网络输出一个漏怪比例估计 `p`。训练时计算归一化的漏怪数残差：

```text
error = (p × total - leaked) / sqrt(total)
loss = SmoothL1(error, 0), beta = 0.45
```

因此最终回归模型使用 Smooth L1 损失；交叉熵对应历史逻辑回归的二分类任务。推理时将比例裁剪到 `[0, 1]`，乘以该波敌人总数，得到预计漏怪数。

训练参数：PyTorch 随机种子 42，批量大小 384，AdamW，初始学习率 0.0015，权重衰减 0.0005，余弦学习率调度到 0.00015，默认训练 60 轮。按验证集漏怪数 MAE 选择最佳轮次，再在测试集评估。

## 训练并导出

先把候选模型写到输出目录，方便与仓库中的正式模型比较：

```sh
python -c "from pathlib import Path; Path('ml/outputs').mkdir(exist_ok=True)"
python ml/train-deployment.py ml/cnn-260624.jsonl ml/cnn-270624.jsonl ml/cnn-280624.jsonl ml/cnn-290624.jsonl --output ml/outputs/cnn-candidate.js
```

训练脚本会打印数据量、验证 MAE、测试指标和四条 Python 推理结果 `parity`。导出的 JS 文件包含权重、偏置、标准化参数和支持的最大波次。

省略数据路径时，会读取根级 `ml/cnn-*.jsonl`。省略 `--output` 时会覆盖正式的 `deployment-model.js`，请仅在准备替换网页模型时使用。

## 纯 MLP 对照

```sh
python ml/train-deployment.py ml/cnn-260624.jsonl ml/cnn-270624.jsonl ml/cnn-280624.jsonl ml/cnn-290624.jsonl --mlp-only --output ml/outputs/mlp-comparison.js
```

两个模型使用相同数据拆分与数值标准化规则，主要差别是是否融合 CNN 地图分支。这里的纯 MLP 是在最终数据集上重训的对照，不是早期 64/32 隐藏层的历史模型。

## 评估部署建议

检验仓库中正式的 CNN + MLP：

```sh
node ml/evaluate-deployment.cjs 96
node ml/evaluate-deployment.cjs 384 --fast-boss
```

检验新训练的模型及纯 MLP 对照：

```sh
node ml/evaluate-deployment.cjs 96 --model ml/outputs/cnn-candidate.js
node ml/evaluate-deployment.cjs 96 --model ml/outputs/mlp-comparison.js
```

`96` 是尝试生成的起始布局数，当前规则下有效评估布局为 95 个。评估使用独立的布局种子 261115、随机买塔种子 17，不重训模型。脚本调用网页的候选评分逻辑，再离线运行真实游戏逻辑比较结果。

随机基准从生成器为各个买得起的塔种抽样的合法格子中选取一个方案，不是对全地图所有塔种与格子均匀抽样。模型建议则遍历全部合法单塔候选。未达到改善阈值时，模型策略保留原布局。

评估结束后，确认新模型表现再将候选 JS 文件复制为根目录的 `deployment-model.js`。改变游戏规则后，旧模型不一定继续适用，需要重新生成数据与验证。
