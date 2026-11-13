/* Shared feature extraction and MLP inference for the game and offline training. */
window.TDDeployment = (() => {
  'use strict';

  const { TOWER_TYPES, ENEMY_TYPES } = window.TD;
  const towerIds = Object.keys(TOWER_TYPES);
  const enemyIds = Object.keys(ENEMY_TYPES);
  const MAX_WAVE = 24;

  function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  function segments(path) {
    let distance = 0;
    const pieces = path.slice(1).map((end, i) => {
      const start = path[i];
      const dc = end.c - start.c;
      const dr = end.r - start.r;
      const length = Math.hypot(dc, dr);
      const piece = { start, uc: dc / length, ur: dr / length, distance, length };
      distance += length;
      return piece;
    });
    return { pieces, distance };
  }

  // Length inside this tower's attack circle, split into the first and last half of the route.
  function coverage(tower, route) {
    let nearSpawn = 0;
    let nearBase = 0;
    const halfway = route.distance / 2;
    const radiusSquared = tower.type.range ** 2;
    for (const { start, uc, ur, distance, length } of route.pieces) {
      const dc = tower.c - start.c;
      const dr = tower.r - start.r;
      const projection = dc * uc + dr * ur;
      const inside = radiusSquared - dc * dc - dr * dr + projection * projection;
      if (inside <= 0) continue;
      const halfChord = Math.sqrt(inside);
      const entry = Math.max(0, projection - halfChord);
      const exit = Math.min(length, projection + halfChord);
      if (exit <= entry) continue;
      const early = Math.max(0, Math.min(exit, halfway - distance) - entry);
      nearSpawn += early;
      nearBase += exit - entry - early;
    }
    return [nearSpawn, nearBase];
  }

  function features({ number, placements, path, airPath, cash, lives, config, enemyStats, tileSize }) {
    const ground = segments(path);
    const air = segments(airPath);
    const towers = placements.map(tower => ({
      type: tower.type,
      groundCoverage: coverage(tower, ground),
      airCoverage: tower.type.air ? coverage(tower, air) : [0, 0],
    }));
    const counts = {};
    for (const id of config.units) counts[id] = (counts[id] || 0) + 1;

    const input = [number, cash, lives, config.hpMul, config.speedMul, ground.distance, config.units.length];
    for (const id of towerIds) {
      const typed = towers.filter(tower => tower.type.id === id);
      input.push(typed.length);
      for (const route of ['groundCoverage', 'airCoverage']) {
        input.push(typed.reduce((sum, tower) => sum + tower[route][0], 0));
        input.push(typed.reduce((sum, tower) => sum + tower[route][1], 0));
      }
    }

    for (const id of enemyIds) {
      const type = ENEMY_TYPES[id];
      const count = counts[id] || 0;
      const stats = enemyStats(type, config.hpMul, config.speedMul);
      let earlyDamage = 0;
      let lateDamage = 0;
      let slow = 0;
      for (const tower of towers) {
        const [early, late] = type.flying ? tower.airCoverage : tower.groundCoverage;
        const damage = Math.max(1, tower.type.dmg - (tower.type.pierceArmor ? 0 : stats.armor));
        const damagePerTile = damage * 60 * tileSize / ((tower.type.rate + 1) * stats.speed);
        earlyDamage += early * damagePerTile;
        lateDamage += late * damagePerTile;
        slow += (early + late) * (tower.type.slow || 0);
      }
      const hp = Math.max(1, count) * stats.hp;
      input.push(count, count ? stats.hp : 0, count ? earlyDamage / hp : 0,
        count ? lateDamage / hp : 0, count ? slow : 0);
    }
    return input;
  }

  function predict(input, wave, total) {
    const model = window.TDDeploymentModel;
    if (!input || !model || wave < 1 || wave > model.maxWave || input.length !== model.mean.length) return null;
    let activations = input.map((value, i) => (value - model.mean[i]) / model.scale[i]);
    for (const [layerIndex, layer] of model.layers.entries()) {
      const last = layerIndex === model.layers.length - 1;
      activations = layer.weights.map((weights, output) => {
        let value = layer.bias[output];
        for (let i = 0; i < weights.length; i++) value += weights[i] * activations[i];
        return last ? value : Math.max(0, value);
      });
    }
    return Math.max(0, Math.min(1, activations[0])) * total;
  }

  return { seededRandom, features, predict, maxWave: MAX_WAVE };
})();
