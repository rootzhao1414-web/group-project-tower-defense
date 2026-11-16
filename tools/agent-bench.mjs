#!/usr/bin/env node
/**
 * 部署策略闭环评测
 * ---------------------------------------------------------------
 * 在 Node 里把游戏跑到「基地陷落」为止，对比同一套随机种子下的不同策略：
 *
 *   none     不建塔，测基线
 *   random   每波随机补塔（同一预算上限）
 *   advisor  用 deployment-model.js 的建议逐座补塔（推荐策略）
 *
 * 与 ml/evaluate-deployment.cjs 的区别：那边评的是「单波漏怪预测误差」，
 * 这里评的是「整局能撑到第几波」——衡量的是策略，不是模型。
 *
 * 用法：
 *   node tools/agent-bench.mjs
 *   node tools/agent-bench.mjs --seed 20261116 --threshold 0 --max-buys 4
 *   node tools/agent-bench.mjs --policy advisor --json docs/bench-trace.json
 *
 * 说明：
 *   - 每波都用 TDSimulation.setup() 重建布局，塔血量不会跨波累积，
 *     因此结果偏乐观（真实对局里残血塔会被继承）。这是评测口径的一部分，
 *     在 docs/external-agent.md 里写明。
 *   - 每波结束后的余额与生命，通过模型输入的前两个数值特征反读
 *     （features = [波次, cash, lives, ...]），不需要改游戏代码。
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAME_FILES = ['deployment-model.js', 'design-assets.js', 'deployment-advice.js', 'game.js'];

/** 在 vm 里按顺序加载游戏与模型，返回挂好 TDSimulation 的 window */
function loadGame() {
  const context = vm.createContext({ window: {}, Math, console });
  for (const file of GAME_FILES) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    vm.runInContext(source, context, { filename: file });
  }
  return context.window;
}

function parseArgs(argv) {
  const args = { seed: 20261116, seeds: null, waves: 24, threshold: 0.25, maxBuys: 1, policy: 'all', json: null, out: null };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key.startsWith('--')) throw new Error(`无法识别的参数：${key}`);
    if (value === undefined) throw new Error(`参数 ${key} 缺少取值`);
    i++;
    const name = key.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    if (!(name in args)) throw new Error(`未知参数：${key}`);
    args[name] = ['policy', 'json', 'out', 'seeds'].includes(name) ? value : Number(value);
  }
  if (args.seeds) args.seeds = String(args.seeds).split(',').map(Number);
  if (args.seeds && (args.seeds.length === 0 || args.seeds.some(seed => !Number.isInteger(seed)))) {
    throw new Error('--seeds 须为逗号分隔的无符号 32 位整数');
  }
  if (!Number.isInteger(args.seed) || args.seed < 0 || args.seed > 0xffffffff) {
    throw new Error('--seed 须为无符号 32 位整数');
  }
  return args;
}

/** 棋盘上所有可作为塔位的格子（不含出生点与基地） */
function cellsOf(game) {
  const { cols, rows, spawn, base } = game.board;
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if ((r === spawn.r && c === spawn.c) || (r === base.r && c === base.c)) continue;
      cells.push({ c, r });
    }
  }
  return cells;
}

function play(window, options) {
  const { policy, waves, threshold, maxBuys, seed } = options;
  const game = window.TDSimulation;
  const types = Object.values(window.TD.TOWER_TYPES);
  const cheapest = Math.min(...types.map(type => type.cost));
  const cells = cellsOf(game);
  const seedFor = wave => (seed + wave * 7919) >>> 0;
  const random = window.TDDeployment.seededRandom(seed);

  const placements = [];
  const trace = [];
  let cash = 120;      // 与 START_MONEY 一致
  let lives = 20;      // 与 START_LIVES 一致
  let leaked = 0;
  const started = Date.now();

  const setup = () => game.setup({ placements, cash, health: lives });
  /** 每波结束后的真实余额与生命，取自模型的 cash / lives 特征 */
  const readState = wave => {
    const { features } = game.scenario(wave, seedFor(wave)).current();
    return features ? { cash: features[1], lives: features[2] } : null;
  };

  let wave = 0;
  for (wave = 1; wave <= waves; wave++) {
    setup();
    let bought = 0;

    if (policy === 'advisor') {
      while (bought < maxBuys) {
        const { baseline, best } = game.recommend(wave, seedFor(wave));
        if (baseline === null || !best) break;
        if (baseline - best.prediction < threshold) break;
        placements.push({ c: best.c, r: best.r, id: best.type.id });
        cash -= best.type.cost;
        bought++;
        setup();
      }
    } else if (policy === 'random') {
      while (bought < maxBuys && cash >= cheapest) {
        const affordable = types.filter(type => type.cost <= cash);
        const type = affordable[Math.floor(random() * affordable.length)];
        const legal = cells.filter(cell => game.scenario(wave, seedFor(wave)).routeWith(cell.c, cell.r));
        if (!legal.length) break;
        const cell = legal[Math.floor(random() * legal.length)];
        placements.push({ c: cell.c, r: cell.r, id: type.id });
        cash -= type.cost;
        bought++;
        setup();
      }
    }

    const { config } = game.scenario(wave, seedFor(wave)).current();
    const result = game.run(wave, config);
    leaked += result.leaked;
    const after = readState(wave);
    if (after) {
      cash = after.cash;
      lives = after.lives;
    }
    trace.push({
      wave, bought, leaked: result.leaked, lives,
      towers: placements.length, cash: Math.round(cash), units: result.total,
    });
    if (lives <= 0) break;
  }

  return {
    policy, seed, waves: Math.min(wave, waves), lives, leaked,
    towers: placements.length,
    spent: placements.reduce((sum, tile) => sum + window.TD.TOWER_TYPES[tile.id].cost, 0),
    cash: Math.round(cash),
    ms: Date.now() - started,
    trace,
  };
}

function main() {
  const options = parseArgs(process.argv);
  const window = loadGame();
  const policies = options.policy === 'all' ? ['none', 'random', 'advisor'] : [options.policy];

  const rows = [];
  const seeds = options.seeds || [options.seed];
  for (const seed of seeds) {
    for (const policy of policies) {
      const result = play(window, { ...options, policy, seed });
      rows.push(result);
      const status = result.lives > 0 ? '撑满' : `第 ${result.waves} 波陷落`;
      console.log(
        `seed ${seed}  ${policy.padEnd(8)} 波次 ${String(result.waves).padStart(2)}  ` +
        `漏怪 ${String(result.leaked).padStart(3)}  塔 ${String(result.towers).padStart(2)}  ` +
        `花费 ${String(result.spent).padStart(4)}  余 ${String(result.cash).padStart(4)}  ` +
        `${(result.ms / 1000).toFixed(1)}s  ${status}`,
      );
    }
  }

  if (options.json) {
    const dir = path.dirname(path.resolve(options.json));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(options.json, JSON.stringify({
      options, rows: rows.map(({ trace, ...rest }) => ({ ...rest, trace })),
    }, null, 2) + '\n');
    console.log(`已写入 ${options.json}`);
  }

  if (options.out) {
    const header = 'policy,seed,waves,leaked,towers,spent,cash,ms';
    const body = rows.map(row => [row.policy, row.seed, row.waves, row.leaked, row.towers, row.spent, row.cash, row.ms].join(','));
    fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
    fs.writeFileSync(options.out, [header, ...body].join('\n') + '\n');
    console.log(`已写入 ${options.out}`);
  }
}

main();
