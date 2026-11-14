/* Shared feature extraction and neural network inference. */
window.TDDeployment = (() => {
  'use strict';

  const { TOWER_TYPES, ENEMY_TYPES, SLOW_MUL } = window.TD;
  const towerIds = Object.keys(TOWER_TYPES);
  const enemyIds = Object.keys(ENEMY_TYPES);
  const MAX_WAVE = 24;
  const GRID_ROWS = 9;
  const GRID_COLS = 16;

  const isFastBoss = type => type?.boss && type.ratios?.speed >= 1.5;

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
        if (tower.type.slow) {
          const slowFrames = tower.type.slowDur * (SLOW_MUL[id] ?? 1);
          const exposedFrames = (early + late) * 60 * tileSize / stats.speed;
          const shots = exposedFrames / (tower.type.rate + 1);
          slow += Math.min(exposedFrames, shots * slowFrames / Math.max(1, count)) * tower.type.slow;
        }
      }
      const hp = Math.max(1, count) * stats.hp;
      input.push(count, count ? stats.hp : 0, count ? earlyDamage / hp : 0,
        count ? lateDamage / hp : 0, count ? slow : 0);
    }
    return input;
  }

  // Five tower masks and a route channel ordered from spawn to base.
  function encodeGrid(placements, path) {
    const planes = towerIds.map(() => []);
    for (const { c, r, type } of placements) planes[towerIds.indexOf(type.id)].push(r * GRID_COLS + c);
    planes.push(path.map(({ c, r }) => r * GRID_COLS + c));
    return planes;
  }

  function convolve(input, rows, cols, layer) {
    const outRows = Math.ceil(rows / layer.stride);
    const outCols = Math.ceil(cols / layer.stride);
    const area = rows * cols;
    const outArea = outRows * outCols;
    const inChannels = input.length / area;
    const output = new Float32Array(layer.bias.length * outArea);
    for (let oc = 0; oc < layer.bias.length; oc++) {
      const kernel = layer.weights[oc];
      for (let r = 0; r < outRows; r++) {
        for (let c = 0; c < outCols; c++) {
          let value = layer.bias[oc];
          for (let ic = 0; ic < inChannels; ic++) {
            for (let dr = 0; dr < 3; dr++) {
              const sr = r * layer.stride + dr - 1;
              if (sr < 0 || sr >= rows) continue;
              for (let dc = 0; dc < 3; dc++) {
                const sc = c * layer.stride + dc - 1;
                if (sc >= 0 && sc < cols) {
                  value += input[ic * area + sr * cols + sc] * kernel[ic * 9 + dr * 3 + dc];
                }
              }
            }
          }
          output[oc * outArea + r * outCols + c] = Math.max(0, value);
        }
      }
    }
    return { output, rows: outRows, cols: outCols };
  }

  function gridEmbedding(planes, layers, pool) {
    const area = GRID_ROWS * GRID_COLS;
    let output = new Float32Array(planes.length * area);
    for (const [channel, cells] of planes.entries()) {
      for (const [index, cell] of cells.entries()) {
        output[channel * area + cell] = channel === planes.length - 1
          ? 1 + index / Math.max(1, cells.length - 1) : 1;
      }
    }
    let rows = GRID_ROWS;
    let cols = GRID_COLS;
    for (const layer of layers) {
      ({ output, rows, cols } = convolve(output, rows, cols, layer));
    }
    const result = [];
    for (let channel = 0; channel < output.length / (rows * cols); channel++) {
      for (let i = 0; i < pool[0]; i++) {
        const r0 = Math.floor(i * rows / pool[0]);
        const r1 = Math.ceil((i + 1) * rows / pool[0]);
        for (let j = 0; j < pool[1]; j++) {
          const c0 = Math.floor(j * cols / pool[1]);
          const c1 = Math.ceil((j + 1) * cols / pool[1]);
          let sum = 0;
          for (let r = r0; r < r1; r++) {
            for (let c = c0; c < c1; c++) sum += output[(channel * rows + r) * cols + c];
          }
          result.push(sum / ((r1 - r0) * (c1 - c0)));
        }
      }
    }
    return result;
  }

  function predict(input, wave, total, map) {
    const model = window.TDDeploymentModel;
    if (!input || !model || wave < 1 || wave > model.maxWave || input.length !== model.mean.length) return null;
    let activations = input.map((value, i) => (value - model.mean[i]) / model.scale[i]);
    if (model.conv) {
      if (map?.length !== model.channels) return null;
      activations.push(...gridEmbedding(map, model.conv, model.pool));
    }
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

  return { seededRandom, features, encodeGrid, predict, isFastBoss, maxWave: MAX_WAVE, GRID_ROWS, GRID_COLS };
})();
