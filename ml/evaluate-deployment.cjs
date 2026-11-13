const assert = require('node:assert/strict');
const { loadGame, layouts, simulate } = require('./simulate-deployment.cjs');

const window = loadGame(true);
const game = window.TDSimulation;
const random = window.TDDeployment.seededRandom(17);
const examples = [];
const bossExamples = [];
const count = Number(process.argv[2] || 96);
const fastBossOnly = process.argv.includes('--fast-boss');
const { ENEMY_TYPES, WAVE_THEMES } = window.TD;
for (const layout of layouts(window, count, 261115)) {
  const { number, waveSeed, placements, cash, health, options } = layout;
  const boss = ENEMY_TYPES[WAVE_THEMES[(number - 1) % WAVE_THEMES.length].boss];
  if (fastBossOnly && !window.TDDeployment.isFastBoss(boss)) continue;
  if (!options.length) continue;
  game.setup({ placements, cash, health });
  const { baseline, best, original, mlpBest } = game.recommend(number, waveSeed);
  const { features: _features, ...keep } = simulate(window, layout, null);
  const randomChoice = options[Math.floor(random() * options.length)];
  const randomResult = simulate(window, layout, randomChoice).leaked;
  let advised = keep;
  if (best && (original || best.prediction + 0.25 < baseline)) {
    const { c, r, type } = best;
    const cost = type.cost;
    assert.ok(cost <= cash);
    assert.ok(placements.every(tile => tile.c !== c || tile.r !== r));
    game.setup({ placements: [...placements, { c, r, id: type.id }], cash: cash - cost, health });
    const { config, features } = game.scenario(number, waveSeed).current();
    assert.deepEqual(config, best.config);
    assert.equal(window.TDDeployment.predict(features, number, config.units.length), best.prediction);
    advised = game.run(number, config);
    if (original) assert.deepEqual(advised, best.result);
  }
  if (original) {
    assert.deepEqual(keep, { ...original });
    assert.ok(advised.baseDamage < keep.baseDamage ||
      (advised.baseDamage === keep.baseDamage && advised.bossLeaked <= keep.bossLeaked));
    const mlp = mlpBest.prediction + 0.25 < baseline
      ? simulate(window, layout, { c: mlpBest.c, r: mlpBest.r, id: mlpBest.type.id })
      : keep;
    bossExamples.push({ mlp, advised, frost: best?.type.id === 'frost' });
  }
  examples.push({ keep: keep.leaked, advised: advised.leaked, randomResult });
}

const mean = key => (examples.reduce((sum, row) => sum + row[key], 0) / examples.length).toFixed(2);
const improved = examples.filter(row => row.advised < row.keep).length;
const worse = examples.filter(row => row.advised > row.keep).length;
console.log(`${examples.length} 个额外布局 · 平均漏怪：保持原样 ${mean('keep')} · ` +
  `MLP 建议 ${mean('advised')} · 随机买塔 ${mean('randomResult')}`);
console.log(`相对保持原样，${improved} 局改善，${worse} 局变差，${examples.length - improved - worse} 局持平`);
if (bossExamples.length) {
  const damage = key => bossExamples.reduce((sum, row) => sum + row[key].baseDamage, 0);
  const bosses = key => bossExamples.reduce((sum, row) => sum + row[key].bossLeaked, 0);
  console.log(`${bossExamples.length} 个高速 Boss 布局 · 仅 MLP / 模拟复核`);
  console.log(`基地累计掉血 ${damage('mlp')} / ${damage('advised')} 点 · Boss 漏怪 ${bosses('mlp')} / ${bosses('advised')} 只 · ` +
    `推荐霜冻棱镜 ${bossExamples.filter(row => row.frost).length} 局`);
}
