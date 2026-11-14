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
  const { baseline, best } = game.recommend(number, waveSeed);
  const keep = simulate(window, layout, null);
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
    advised = game.run(number, config);
  }
  if (window.TDDeployment.isFastBoss(boss)) {
    bossExamples.push({ keep, advised, frost: advised !== keep && best.type.id === 'frost' });
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
  const leaked = key => bossExamples.reduce((sum, row) => sum + row[key].leaked, 0);
  console.log(`${bossExamples.length} 个高速 Boss 布局 · 保持原样 / 按 MLP 建议`);
  console.log(`累计漏怪 ${leaked('keep')} / ${leaked('advised')} 只 · 基地累计掉血 ${damage('keep')} / ${damage('advised')} 点 · ` +
    `Boss 漏怪 ${bosses('keep')} / ${bosses('advised')} 只 · ` +
    `推荐霜冻棱镜 ${bossExamples.filter(row => row.frost).length} 局`);
}
