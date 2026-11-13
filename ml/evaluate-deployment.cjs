const assert = require('node:assert/strict');
const { loadGame, layouts, simulate } = require('./simulate-deployment.cjs');

const window = loadGame(true);
const game = window.TDSimulation;
const random = window.TDDeployment.seededRandom(17);
const examples = [];
for (const layout of layouts(window, 96, 261115)) {
  const { number, waveSeed, placements, cash, health, options } = layout;
  if (!options.length) continue;
  game.setup({ placements, cash, health });
  const { baseline, best } = game.recommend(number, waveSeed);
  const keep = simulate(window, layout, null).leaked;
  const randomChoice = options[Math.floor(random() * options.length)];
  const randomResult = simulate(window, layout, randomChoice).leaked;
  let advised = keep;
  if (best && best.prediction + 0.25 < baseline) {
    const { c, r, type } = best;
    const cost = type.cost;
    assert.ok(cost <= cash);
    assert.ok(placements.every(tile => tile.c !== c || tile.r !== r));
    game.setup({ placements: [...placements, { c, r, id: type.id }], cash: cash - cost, health });
    const { config, features } = game.scenario(number, waveSeed).current();
    assert.deepEqual(config, best.config);
    assert.equal(window.TDDeployment.predict(features, number, config.units.length), best.prediction);
    advised = game.run(number, config).leaked;
  }
  examples.push({ keep, advised, randomResult });
}

const mean = key => (examples.reduce((sum, row) => sum + row[key], 0) / examples.length).toFixed(2);
const improved = examples.filter(row => row.advised < row.keep).length;
const worse = examples.filter(row => row.advised > row.keep).length;
console.log(`${examples.length} 个额外布局 · 平均漏怪：保持原样 ${mean('keep')} · ` +
  `MLP 建议 ${mean('advised')} · 随机买塔 ${mean('randomResult')}`);
console.log(`相对保持原样，${improved} 局改善，${worse} 局变差，${examples.length - improved - worse} 局持平`);
