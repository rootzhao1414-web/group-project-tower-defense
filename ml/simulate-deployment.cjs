const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadGame(withModel = false) {
  const context = vm.createContext({ window: {}, Math });
  const files = ['design-assets.js', 'deployment-advice.js', 'game.js'];
  if (withModel) files.unshift('deployment-model.js');
  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    vm.runInContext(source, context, { filename: file });
  }
  return context.window;
}

function* layouts(window, count, seed) {
  const game = window.TDSimulation;
  const { cols, rows, spawn, base } = game.board;
  const towerTypes = Object.values(window.TD.TOWER_TYPES);
  const random = window.TDDeployment.seededRandom(seed);
  const pick = array => array[Math.floor(random() * array.length)];
  const integer = (min, max) => min + Math.floor(random() * (max - min + 1));
  const maxWave = window.TDDeployment.maxWave;
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if ((r === spawn.r && c === spawn.c) || (r === base.r && c === base.c)) continue;
      cells.push({ c, r });
    }
  }
  const near = cells.filter(({ r }) => Math.abs(r - spawn.r) <= 2);

  for (let i = 0; i < count; i++) {
    const number = i % maxWave + 1;
    const waveSeed = integer(0, 0xffffffff);
    const placements = [];
    const health = number === 1 ? 20 : integer(5, 20);
    let cash = number === 1 ? 120 : integer(40, 150 + number * 17);
    const desired = number === 1 ? integer(0, 3) :
      integer(Math.floor(number / 6), Math.min(36, Math.ceil(number * 1.4) + 3));
    const available = new Set(cells);
    const routeBias = random();
    const preferred = pick(towerTypes);
    for (let j = 0; j < desired; j++) {
      const cell = pick(random() < routeBias ? near : cells);
      if (!available.has(cell)) continue;
      const affordable = number === 1 ? towerTypes.filter(type => type.cost <= cash) : towerTypes;
      if (!affordable.length) break;
      const type = affordable.includes(preferred) && random() < 0.45 ? preferred : pick(affordable);
      placements.push({ ...cell, id: type.id });
      available.delete(cell);
      if (number === 1) cash -= type.cost;
    }

    game.setup({ placements, cash, health });
    const scenario = game.scenario(number, waveSeed);
    const current = scenario.current();
    if (!current.features) continue;

    const options = [];
    const legal = [...available].filter(cell => scenario.routeWith(cell.c, cell.r));
    const nearRoute = legal.filter(cell => Math.abs(cell.r - spawn.r) <= 2);
    for (const type of towerTypes) {
      if (type.cost > cash) continue;
      const sampled = new Set();
      for (const region of [nearRoute, nearRoute, nearRoute, legal]) {
        if (region.length) sampled.add(pick(region));
      }
      for (const cell of sampled) options.push({ ...cell, id: type.id });
    }
    yield { i, number, waveSeed, placements, health, cash, options };
  }
}

function simulate(window, layout, tile) {
  const { number, waveSeed, placements, cash, health } = layout;
  const game = window.TDSimulation;
  const cost = tile ? window.TD.TOWER_TYPES[tile.id].cost : 0;
  game.setup({
    placements: tile ? [...placements, tile] : placements,
    cash: cash - cost,
    health,
  });
  const { config, features } = game.scenario(number, waveSeed).current();
  const { leaked, total } = game.run(number, config);
  return { features, leaked, total };
}

if (require.main === module) {
  const output = path.join(__dirname, 'deployment.jsonl');
  const count = Number(process.argv[2] || 1700);
  if (!Number.isInteger(count) || count < 24) throw new Error('布局数须为至少 24 的整数');
  const window = loadGame();
  const fd = fs.openSync(output, 'w');
  let rows = 0;
  try {
    for (const layout of layouts(window, count, 260624)) {
      const examples = [null, ...layout.options].map(tile => JSON.stringify({
        group: layout.i, baseline: !tile, ...simulate(window, layout, tile),
      }));
      fs.writeSync(fd, examples.join('\n') + '\n');
      rows += examples.length;
      if (layout.i % 100 === 99) console.log(`${layout.i + 1}/${count} 个布局，${rows} 次模拟`);
    }
  } finally {
    fs.closeSync(fd);
  }
  console.log(`完成，共 ${rows} 次游戏模拟`);
}

module.exports = { loadGame, layouts, simulate };
