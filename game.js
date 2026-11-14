/* ============================================================
 * game.js — 塔防 · 敌情雷达（v2）
 * ------------------------------------------------------------
 * 在「塔防 × AI」初版基础上扩展：
 *   1. 五种炮塔（昵称/定位/造价/对空属性来自设计稿）
 *   2. 五类敌人（护甲 / 飞行 / BOSS 机制）
 *   3. 暂停、快捷键、部署简报、敌情雷达实时列表
 *   4. 视觉与文案对齐设计稿的深蓝霓虹风格
 * ============================================================ */
(() => {
  'use strict';

  const {
    PALETTE, ATTACK_STYLES, BOSS_BASE,
    ENEMY_TYPES, ENEMY_TRAITS, ENEMY_WEIGHT,
    TOWER_TYPES, COUNTER, SLOW_MUL, ECON,
    WAVE_THEMES, UI_TEXT, ICONS,
  } = window.TD;

  /* ============================================================
   * 零、常量与 DOM
   * ============================================================ */
  const COLS = 16;
  const ROWS = 9;
  const T = 60;
  const SPAWN = { c: 0, r: 4 };
  const BASE = { c: COLS - 1, r: 4 };
  const START_MONEY = 120;
  const START_LIVES = 20;
  const STEP = 1000 / 60;
  const MAX_STEPS = 6;

  const headless = typeof document === 'undefined';
  const $ = id => headless ? null : document.getElementById(id);
  const canvas = $('game');
  const ctx = canvas?.getContext('2d');
  const adviceModel = window.TDDeployment;
  const $money = $('hud-money');
  const $lives = $('hud-lives');
  const $wave = $('hud-wave');
  const $pause = $('btn-pause');
  const $start = $('btn-start');
  const $restart = $('btn-restart');
  const $msg = $('msg');
  const $deck = $('deck');
  const $radar = $('radar-list');
  const $waveTitle = $('wave-title');
  const $onField = $('on-field');
  const $spawned = $('spawned');
  const $spawnBar = $('spawn-bar');
  const $waveTip = $('wave-tip');
  const $deployed = $('deployed');
  const $briefName = $('brief-name');
  const $briefIcon = $('brief-icon');
  const $briefTag = $('brief-tag');
  const $briefDesc = $('brief-desc');
  const $briefCost = $('brief-cost');
  const $briefRange = $('brief-range');
  const $briefAir = $('brief-air');
  const $briefCounter = $('brief-counter');
  const $tip = $('tip');
  const $forecast = $('btn-forecast');
  const $advise = $('btn-advise');
  const $advice = $('deployment-result');

  /* ============================================================
   * 一、状态
   * ============================================================ */
  let grid;              // grid[r][c] = 0 空地 / 1 塔
  let towers = [];
  let enemies = [];
  let bullets = [];
  let zaps;              // 雷霆线圈的闪电特效
  let beams;             // 狙击塔的光束特效
  let particles;         // 命中/爆炸粒子
  let marks;             // 攻击留下的爪痕/火花/冲击环（纯表现）
  let shake;             // 镜头震动强度
  let seenBossAttack;    // boss 攻击方式的首次提示已播过
  let money;
  let lives;
  let wave;
  let running;
  let over;
  let paused;
  let selectedType;
  let selectedTower;     // 画布上选中的已放置塔（用于出售）
  let hoverCell;
  let pathDirty;
  let spawnQueue;        // 待出场的敌人 id 列表
  let spawnTimer;
  let waveCfg;
  let appeared;          // 本波已出现数量
  let totalThisWave;     // 本波总数
  let leaked;
  let bossLeaked;
  let nextWaveSeed;
  let forecastForWave;
  let recommended;

  /* ============================================================
   * 二、小工具
   * ============================================================ */
  const cx = c => c * T + T / 2;
  const cy = r => r * T + T / 2;
  const inBounds = (c, r) => c >= 0 && c < COLS && r >= 0 && r < ROWS;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const msg = t => { if ($msg) $msg.textContent = t; };
  const rand = (a, b) => a + Math.random() * (b - a);

  const DIRS8 = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, Math.SQRT2], [1, -1, Math.SQRT2],
    [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
  ];

  /* ============================================================
   * 三、A* 寻路（沿用初版核心，适配 16×9）
   * ============================================================ */
  function heuristic(c, r) {
    const dx = Math.abs(c - BASE.c);
    const dy = Math.abs(r - BASE.r);
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
  }

  function findPath(sc, sr, board = grid) {
    if (!inBounds(sc, sr)) return null;
    if (sc === BASE.c && sr === BASE.r) return [{ c: sc, r: sr }];

    const open = [{ c: sc, r: sr, g: 0, f: heuristic(sc, sr) }];
    const bestG = new Map([[sc + ',' + sr, 0]]);
    const cameFrom = new Map();
    const closed = new Set();

    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
      const cur = open.splice(bi, 1)[0];
      const curKey = cur.c + ',' + cur.r;
      if (closed.has(curKey)) continue;
      closed.add(curKey);

      if (cur.c === BASE.c && cur.r === BASE.r) {
        const path = [];
        let k = curKey;
        while (k) {
          const p = k.split(',');
          path.push({ c: +p[0], r: +p[1] });
          k = cameFrom.get(k);
        }
        return path.reverse();
      }

      for (const [dc, dr, cost] of DIRS8) {
        const nc = cur.c + dc;
        const nr = cur.r + dr;
        if (!inBounds(nc, nr)) continue;
        if (board[nr][nc] === 1) continue;
        if (dc !== 0 && dr !== 0 && (board[cur.r][nc] === 1 || board[nr][cur.c] === 1)) continue;
        const nKey = nc + ',' + nr;
        if (closed.has(nKey)) continue;
        const ng = cur.g + cost;
        if (bestG.has(nKey) && ng >= bestG.get(nKey)) continue;
        bestG.set(nKey, ng);
        cameFrom.set(nKey, curKey);
        open.push({ c: nc, r: nr, g: ng, f: ng + heuristic(nc, nr) });
      }
    }
    return null;
  }

  /* ============================================================
   * 四、敌人
   * ============================================================ */
  // 普通敌人：三围写死在 ENEMY_TYPES，攻击力统一 7；
  // Boss：三围 = BOSS_BASE × ratios，按 boss 种类给不同的速度/攻击/防御占比。
  function enemyStats(type, hpMul, speedMul) {
    if (type.boss) {
      const r = type.ratios || { speed: 1, attack: 1, defense: 1 };
      return {
        hp: Math.round(BOSS_BASE.hp * hpMul),
        speed: BOSS_BASE.speed * r.speed * speedMul,
        attack: Math.max(1, Math.round(BOSS_BASE.attack * r.attack)),
        armor: Math.max(0, Math.round(BOSS_BASE.armor * r.defense)),
      };
    }
    return {
      hp: Math.round(type.hp * hpMul),
      speed: type.speed * speedMul,
      attack: 7,
      armor: type.armor,
    };
  }

  function spawnEnemy(typeId) {
    const type = ENEMY_TYPES[typeId];
    const st = enemyStats(type, waveCfg ? waveCfg.hpMul : 1, waveCfg ? waveCfg.speedMul : 1);
    const e = {
      type, x: cx(SPAWN.c), y: cy(SPAWN.r),
      hp: st.hp, maxHp: st.hp,
      speed: st.speed,
      attack: st.attack,
      armor: st.armor,
      flying: type.flying,
      r: type.radius,
      state: 'march',
      path: null, pi: 0,
      slowT: 0,
      target: null,
      atkCd: 0,
      hitFlash: 0,
      swing: 0,
      angle: 0,
      dead: false,
    };
    if (!type.flying) rePath(e);
    enemies.push(e);
    appeared++;
  }

  function nearestTower(e) {
    let best = null;
    let bestD = Infinity;
    for (const t of towers) {
      if (t.dead) continue;
      const d = (t.x - e.x) ** 2 + (t.y - e.y) ** 2;
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  }

  function rePath(e) {
    if (e.flying) return;
    const c = clamp(Math.floor(e.x / T), 0, COLS - 1);
    const r = clamp(Math.floor(e.y / T), 0, ROWS - 1);
    const path = findPath(c, r);
    if (path) {
      e.path = path;
      e.pi = Math.min(1, path.length - 1);
      e.state = 'march';
      e.target = null;
    } else {
      e.path = null;
      e.pi = 0;
      e.state = 'attack';
      e.target = nearestTower(e);
    }
  }

  function damageEnemy(e, rawDmg, opts = {}) {
    if (e.dead) return;

    // —— 特攻耦合：同一发攻击打不同敌人，伤害倍率不同 ——
    const tower = opts.tower;
    if (tower === 'cannon' && e.flying) return;        // 震荡炮塔打不到空中
    const mul = tower && COUNTER[tower] ? (COUNTER[tower][e.id] ?? 1) : 1;
    if (mul <= 0) return;

    const armor = opts.pierceArmor ? 0 : e.armor;
    const dmg = Math.max(1, Math.round(rawDmg * mul) - armor);
    e.hp -= dmg;
    e.hitFlash = 6;
    if (mul >= 1.3) addParticles(e.x, e.y, PALETTE.warn, 3); // 克制命中：橙色火花
    if (dmg > 0) addParticles(e.x, e.y, e.type.color, 2);
    if (e.hp <= 0) {
      e.dead = true;
      money += e.type.reward;
      addParticles(e.x, e.y, e.type.color, e.type.boss ? 26 : 8);
      if (e.type.boss) msg(`☠ ${e.type.name}倒下了！+${e.type.reward}`);
    }
  }

  function updateEnemyAttack(e) {
    if (!e.target || e.target.dead) {
      e.target = nearestTower(e);
      if (!e.target) { rePath(e); return; }
    }
    const t = e.target;
    const dx = t.x - e.x;
    const dy = t.y - e.y;
    const d = Math.hypot(dx, dy) || 1;
    const reach = T * 0.92;

    if (d > reach) {
      const move = Math.min(e.speed / 60 * 0.9, d - reach);
      e.x += (dx / d) * move;
      e.y += (dy / d) * move;
    } else {
      e.atkCd--;
      if (e.atkCd <= 0) {
        e.atkCd = 38;
        t.hp -= e.attack;
        playAttack(e, t);
        if (t.hp <= 0) destroyTower(t);
      }
    }
  }

  /* ---- 攻击表现：只改观感，不改伤害与间隔 ---- */
  function playAttack(e, t) {
    if (headless) return;
    const st = ATTACK_STYLES[e.type.attack] || ATTACK_STYLES.claw;
    e.swing = 1;
    addParticles(t.x, t.y, st.color, st.puffs);
    if (st.shake > 0) shake = Math.max(shake, st.shake);
    marks.push({
      x: t.x, y: t.y, life: 18, max: 18,
      style: st.mark, color: st.color, r: T * 0.55,
    });
    // 首次见到某种 boss 的攻击方式时，报一次文案
    if (e.type.boss && !seenBossAttack[e.type.id]) {
      seenBossAttack[e.type.id] = true;
      msg(`${e.type.name} · ${st.label}：${st.desc}`);
    }
  }

  function updateEnemies() {
    for (const e of enemies) {
      if (e.dead) continue;
      if (e.hitFlash > 0) e.hitFlash--;
      if (e.swing > 0) e.swing = Math.max(0, e.swing - 0.1);
      if (e.slowT > 0) e.slowT--;

      if (e.state === 'attack') { updateEnemyAttack(e); continue; }

      // 飞行单位：无视地形，直线扑向基地
      if (e.flying) {
        const bx = cx(BASE.c);
        const by = cy(BASE.r);
        const dx = bx - e.x;
        const dy = by - e.y;
        const d = Math.hypot(dx, dy);
        const step = e.speed / 60 * (e.slowT > 0 ? 0.55 : 1);
        e.angle = Math.atan2(dy, dx);
        if (d <= step + 6) { arriveBase(e); continue; }
        e.x += (dx / d) * step;
        e.y += (dy / d) * step;
        continue;
      }

      if (!e.path || e.pi >= e.path.length) { arriveBase(e); continue; }

      const node = e.path[e.pi];
      const tx = cx(node.c);
      const ty = cy(node.r);
      const dx = tx - e.x;
      const dy = ty - e.y;
      const d = Math.hypot(dx, dy);
      const step = e.speed / 60 * (e.slowT > 0 ? 0.45 : 1);
      e.angle = Math.atan2(dy, dx);

      if (d <= step) {
        e.x = tx; e.y = ty;
        e.pi++;
        if (e.pi >= e.path.length) arriveBase(e);
      } else {
        e.x += (dx / d) * step;
        e.y += (dy / d) * step;
      }
    }
  }

  function arriveBase(e) {
    if (e.dead) return;
    e.dead = true;
    leaked++;
    if (e.type.boss) bossLeaked++;
    lives -= e.type.boss ? 3 : 1;
    addParticles(cx(BASE.c), cy(BASE.r), PALETTE.danger, 10);
    msg(e.type.boss ? '💥 巨像撞穿基地！生命 -3' : '⚠ 敌人突破防线！');
  }

  /* ============================================================
   * 五、炮塔
   * ============================================================ */
  function pickTarget(t) {
    let best = null;
    let bestScore = -Infinity;
    for (const e of enemies) {
      if (e.dead) continue;
      if (e.flying && !t.type.air) continue;
      const d = Math.hypot(e.x - t.x, e.y - t.y);
      if (d > t.type.range * T) continue;
      // 优先打离基地最近的
      const score = -Math.hypot(e.x - cx(BASE.c), e.y - cy(BASE.r));
      if (score > bestScore) { bestScore = score; best = e; }
    }
    return best;
  }

  function towerFire(t, target) {
    const ty = t.type;

    if (ty.id === 'sniper') {
      damageEnemy(target, ty.dmg, { pierceArmor: true });
      beams.push({ x1: t.x, y1: t.y, x2: target.x, y2: target.y, life: 8, max: 8 });
      t.angle = Math.atan2(target.y - t.y, target.x - t.x);
      return;
    }

    if (ty.id === 'tesla') {
      const visited = new Set([target]);
      let cur = target;
      let dmg = ty.dmg;
      let px = t.x;
      let py = t.y;
      for (let i = 0; i < ty.chain; i++) {
        damageEnemy(cur, dmg);
        zaps.push({ x1: px, y1: py, x2: cur.x, y2: cur.y, life: 6, max: 6 });
        px = cur.x; py = cur.y;
        dmg *= ty.chainFalloff[i] || 0.4;
        let next = null;
        let bestD = Infinity;
        for (const e of enemies) {
          if (e.dead || visited.has(e)) continue;
          if (e.flying && !ty.air) continue;
          const d = Math.hypot(e.x - cur.x, e.y - cur.y);
          if (d < T * 1.8 && d < bestD) { bestD = d; next = e; }
        }
        if (!next) break;
        visited.add(next);
        cur = next;
      }
      return;
    }

    const b = {
      x: t.x, y: t.y,
      target,
      dmg: ty.dmg,
      speed: 6,
      color: ty.color,
      splash: ty.splash ? ty.splash * T : 0,
      slow: ty.slow || 0,
      slowDur: ty.slowDur || 0,
      pierceArmor: ty.pierceArmor || false,
      kind: ty.id,
      angle: 0,
      done: false,
    };
    bullets.push(b);
    t.angle = Math.atan2(target.y - t.y, target.x - t.x);
  }

  function updateTowers() {
    for (const t of towers) {
      if (t.dead) continue;
      const ty = t.type;

      if (t.cd > 0) { t.cd--; continue; }
      const target = pickTarget(t);
      if (!target) continue;
      t.cd = ty.rate;
      towerFire(t, target);
    }
  }

  /* ============================================================
   * 三·五、经济：出售回收 + 金币利息
   * ============================================================ */

  /* 回收比例：基础 + 波次增长 + 强度加成，封顶 sellMax（永远小于 1） */
  function sellRate(w, pressure) {
    return Math.min(
      ECON.sellMax,
      ECON.sellBase + w * ECON.sellPerWave + (pressure || 0) * ECON.sellPressure,
    );
  }

  /* 一座塔现在能卖多少（残血折价） */
  function sellValue(t) {
    const rate = sellRate(wave, waveCfg ? waveCfg.pressure : 0);
    const wear = 1 - ECON.sellWear * (1 - clamp(t.hp / t.maxHp, 0, 1));
    return Math.max(1, Math.round(t.type.cost * rate * wear));
  }

  function sellTower(t) {
    if (!t || t.dead) return;
    if (running) { msg(UI_TEXT.sellLocked); return; }
    const value = sellValue(t);
    money += value;
    t.dead = true;
    grid[t.r][t.c] = 0;
    pathDirty = true;
    addParticles(t.x, t.y, PALETTE.heal, 10);
    msg(UI_TEXT.sellDone.replace('{name}', t.type.name).replace('{v}', value));
    selectedTower = null;
    clearDeployment();
    refreshDeck();
    refreshBrief();
    updateTip();
    updateHud();
  }

  /* 利息：金币越多、波次越高、强度越大拿得越多，但有封顶，避免滚雪球 */
  function interestFor(w, pressure) {
    const rate = Math.min(
      ECON.interestRateMax,
      ECON.interestBase + w * ECON.interestPerWave + (pressure || 0) * ECON.interestPressure,
    );
    const cap = ECON.interestCapBase + w * ECON.interestCapPerWave;
    return Math.min(Math.floor(money * rate), cap);
  }

  /* 点画布命中已放置的塔时，选中它（再点一次取消），而不是继续建塔 */
  function selectPlacedTower(t) {
    if (recommended) clearRecommendation();
    selectedType = null;
    selectedTower = selectedTower === t ? null : t;
    refreshDeck();
    refreshBrief();
    updateTip();
  }

  function buildTower(c, r) {
    if (!selectedType) { msg('先在右侧选择一种炮塔'); return; }
    if (!inBounds(c, r)) return;
    if (c === SPAWN.c && r === SPAWN.r) { msg('不能建在出生点上'); return; }
    if (c === BASE.c && r === BASE.r) { msg('不能建在基地上'); return; }
    if (grid[r][c] !== 0) { msg('这里已经有一座塔了'); return; }

    for (const e of enemies) {
      if (!e.dead && !e.flying &&
        Math.floor(e.y / T) === r && Math.floor(e.x / T) === c) {
        msg('敌人正在这格，等它走开'); return;
      }
    }

    const type = TOWER_TYPES[selectedType];
    if (money < type.cost) { msg(`金币不够，需要 ${type.cost}`); return; }

    money -= type.cost;
    grid[r][c] = 1;
    pathDirty = true;

    towers.push({
      c, r,
      x: cx(c), y: cy(r),
      type,
      hp: type.hp, maxHp: type.hp,
      cd: 0,
      angle: -Math.PI / 2,
      dead: false,
    });

    if (headless) return;
    if (findPath(SPAWN.c, SPAWN.r)) {
      msg(`部署完成：${type.name}（${type.tag}）`);
    } else {
      msg('🚫 所有通路被封死 —— 敌人开始拆塔');
    }
    const accepted = recommended?.c === c && recommended?.r === r && recommended?.type === type
      ? recommended : null;
    clearDeployment();
    if (accepted) {
      const estimate = recordForecast(accepted.prediction);
      syncDeploymentControls(`已部署${type.name} · ${accepted.config.summary} · ${estimate}`);
    }
    refreshDeck();
  }

  function destroyTower(t) {
    t.dead = true;
    grid[t.r][t.c] = 0;
    pathDirty = true;
    addParticles(t.x, t.y, PALETTE.danger, 12);
    msg('💥 一座炮塔被摧毁');
    refreshDeck();
  }

  /* ============================================================
   * 六、子弹与特效
   * ============================================================ */
  function updateBullets() {
    for (const b of bullets) {
      if (b.done) continue;
      if (!b.target || b.target.dead) { b.done = true; continue; }

      const dx = b.target.x - b.x;
      const dy = b.target.y - b.y;
      const d = Math.hypot(dx, dy) || 1;
      b.angle = Math.atan2(dy, dx);

      if (d < 9) {
        damageEnemy(b.target, b.dmg, { pierceArmor: b.pierceArmor, tower: b.kind });
        // 减速时长也吃特攻：对高速单位效果更久
        if (b.slow) {
          const slowMul = SLOW_MUL[b.target.type.id] ?? 1;
          b.target.slowT = Math.round(b.slowDur * slowMul);
        }
        if (b.splash > 0) {
          for (const o of enemies) {
            if (o === b.target || o.dead || o.flying) continue;
            if (Math.hypot(o.x - b.target.x, o.y - b.target.y) <= b.splash) {
              damageEnemy(o, b.dmg * 0.5, { tower: b.kind });
            }
          }
          addParticles(b.x, b.y, b.color, 6);
        }
        b.done = true;
      } else {
        b.x += (dx / d) * b.speed;
        b.y += (dy / d) * b.speed;
      }
    }
  }

  function addParticles(x, y, color, n) {
    if (headless) return;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rand(0.6, 3.4);
      particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: rand(18, 34), max: 34, color, r: rand(1, 2.4),
      });
    }
  }

  function updateEffects() {
    for (const p of particles) {
      p.x += p.vx; p.y += p.vy;
      p.vx *= 0.94; p.vy *= 0.94;
      p.life--;
    }
    particles = particles.filter(p => p.life > 0);
    for (const z of zaps) z.life--;
    zaps = zaps.filter(z => z.life > 0);
    for (const b of beams) b.life--;
    beams = beams.filter(b => b.life > 0);
    for (const m of marks) m.life--;
    marks = marks.filter(m => m.life > 0);
    shake *= 0.86;
    if (shake < 0.06) shake = 0;
  }

  /* ============================================================
   * 七、波次
   * ============================================================ */
  function currentPower(activeTowers, cash, health) {
    let dps = 0;
    for (const t of activeTowers) {
      dps += t.type.dmg / t.type.rate;
    }
    return activeTowers.length * 6 + dps * 60 * 1.1 + cash * 0.06 + health * 0.35;
  }

  /* 玩家当前的塔配置：{ dart: 2, sniper: 1 } */
  function towerProfile(activeTowers) {
    const p = {};
    for (const t of activeTowers) {
      p[t.type.id] = (p[t.type.id] || 0) + 1;
    }
    return p;
  }

  /* 玩家对某种敌人的反制力（越大越不怕它） */
  function counterAgainst(profile, enemyId) {
    let s = 0;
    for (const id in profile) {
      const ty = TOWER_TYPES[id];
      if (!ty) continue;
      const dps = ty.dmg / ty.rate;
      s += profile[id] * dps * (COUNTER[id]?.[enemyId] ?? 1);
    }
    return s;
  }

  function buildWave(w, activeTowers, cash, health, random) {
    const theme = w <= WAVE_THEMES.length
      ? WAVE_THEMES[w - 1]
      : {
          ...WAVE_THEMES[(w - 1) % WAVE_THEMES.length],
          title: `${WAVE_THEMES[(w - 1) % WAVE_THEMES.length].title} · 强化`,
          tip: '强度提升，注意补防空。',
        };

    const power = currentPower(activeTowers, cash, health);
    const pressure = clamp((power - 40) / 220, 0, 1);
    const hpMul = (1 + (w - 1) * 0.1) * (1 + pressure * 0.5);
    const speedMul = 1 + (w - 1) * 0.012 + pressure * 0.1;

    /* —— 智能配比 ——
     * 1) 算玩家对池内每种敌人的反制力，取均值做基准
     * 2) 反制力低于均值的敌人 = 玩家软肋 → 提高它的权重
     * 3) 用「威胁预算」而不是固定只数，钱多则预算高
     */
    const profile = towerProfile(activeTowers);
    const pool = theme.pool;
    const raw = pool.map(id => counterAgainst(profile, id));
    const avg = raw.reduce((a, b) => a + b, 0) / (raw.length || 1);
    const weights = pool.map((id, i) => {
      const ratio = avg > 0 ? raw[i] / avg : 1;
      const softness = clamp(1.55 - ratio * 0.42, 0.45, 1.7);
      return ENEMY_WEIGHT[id] * softness;
    });

    const budget = Math.round((7 + w * 1.5) * (1 + pressure * 0.25) + cash * 0.015);
    const wsum = weights.reduce((a, b) => a + b, 0) || 1;

    const units = [];
    for (let i = 0; i < pool.length; i++) {
      const share = weights[i] / wsum;
      const n = Math.max(1, Math.round((budget * share) / ENEMY_WEIGHT[pool[i]]));
      for (let k = 0; k < n; k++) units.push(pool[i]);
    }

    // Boss 固定 1 只，不参与预算分配，避免被压力系数放大成两三只
    if (theme.boss) units.push(theme.boss);

    // 洗牌，让出怪顺序有变化
    for (let i = units.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [units[i], units[j]] = [units[j], units[i]];
    }

    // 给玩家看这一波到底派了什么
    const tally = {};
    for (const id of units) tally[id] = (tally[id] || 0) + 1;
    const summary = Object.entries(tally)
      .sort((a, b) => b[1] - a[1])
      .map(([id, n]) => `${ENEMY_TYPES[id].name}×${n}`)
      .join(' ');

    return { title: theme.title, tip: theme.tip, units, hpMul, speedMul, pressure, summary };
  }

  function seedForNextWave() {
    nextWaveSeed ??= Math.floor(Math.random() * 0x100000000);
    return nextWaveSeed;
  }

  function configFor(number, activeTowers, cash, seed) {
    return buildWave(number, activeTowers, cash, lives, adviceModel.seededRandom(seed));
  }

  function deploymentScenario(number, seed) {
    const activeTowers = towers.filter(t => !t.dead);
    const airPath = [SPAWN, BASE];
    const extract = (placements, path, cash) => {
      const config = configFor(number, placements, cash, seed);
      const features = path && adviceModel.features({
        number, placements, path, airPath, cash, lives, config, enemyStats, tileSize: T,
      });
      return { config, features };
    };
    return {
      current: () => extract(activeTowers, findPath(SPAWN.c, SPAWN.r), money),
      routeWith: (c, r) => {
        if (!inBounds(c, r) || grid[r][c] || (r === SPAWN.r && c === SPAWN.c) ||
            (r === BASE.r && c === BASE.c)) return null;
        const board = grid.slice();
        board[r] = grid[r].slice();
        board[r][c] = 1;
        return findPath(SPAWN.c, SPAWN.r, board);
      },
      candidate: (c, r, type, route) => extract([...activeTowers, { c, r, type }], route, money - type.cost),
    };
  }

  function syncDeploymentControls(note) {
    $forecast.disabled = over || running || paused;
    $advise.disabled = over || running || paused;
    if (note !== undefined) $advice.textContent = note;
  }

  function clearDeployment() {
    forecastForWave = null;
    clearRecommendation();
  }

  function clearRecommendation() {
    recommended = null;
    if (!headless && !running && !over) {
      syncDeploymentControls('开波前可预览敌人，或让 MLP 建议加一座塔。');
    }
  }

  function reportDeployment(fell) {
    const prediction = forecastForWave === null ? '' : `MLP 预估漏怪 ${forecastForWave.toFixed(1)} 只 · `;
    const result = fell ? `基地陷落前漏怪 ${leaked} 只` : `实际漏怪 ${leaked} 只`;
    const bosses = bossLeaked ? `（含 Boss ${bossLeaked} 只）` : '';
    syncDeploymentControls(`第 ${wave} 波 · ${prediction}${result}${bosses}`);
    forecastForWave = null;
  }

  function recordForecast(prediction) {
    forecastForWave = prediction;
    return prediction === null ? '当前布局或波次超出模型范围' : `MLP 预计漏怪 ${prediction.toFixed(1)} 只`;
  }

  function predictDeployment(number, { config, features }) {
    return adviceModel.predict(features, number, config.units.length);
  }

  function forecastWave() {
    if (over || running || paused) return;
    recommended = null;
    const number = wave + 1;
    const current = deploymentScenario(number, seedForNextWave()).current();
    const estimate = recordForecast(predictDeployment(number, current));
    syncDeploymentControls(`第 ${number} 波 · ${current.config.summary}（共 ${current.config.units.length} 只） · ${estimate}`);
  }

  function rankDeployments(number, seed) {
    const scenario = deploymentScenario(number, seed);
    const baseline = predictDeployment(number, scenario.current());
    if (baseline === null) return { baseline, best: null };
    const affordable = Object.values(TOWER_TYPES).filter(type => type.cost <= money);
    let best = null;
    if (!affordable.length) return { baseline, best: null };
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const route = scenario.routeWith(c, r);
        if (!route) continue;
        for (const type of affordable) {
          const candidate = scenario.candidate(c, r, type, route);
          const prediction = predictDeployment(number, candidate);
          if (prediction !== null && (!best || prediction < best.prediction)) {
            best = { c, r, type, prediction, config: candidate.config };
          }
        }
      }
    }
    return { baseline, best };
  }

  function adviseDeployment() {
    if (over || running || paused) return;
    recommended = null;
    const number = wave + 1;
    const { baseline, best } = rankDeployments(number, seedForNextWave());
    const estimate = recordForecast(baseline);
    if (baseline === null) {
      syncDeploymentControls('当前布局或波次超出模型范围，可点「预测下一波」查看阵容。');
    } else if (money < Math.min(...Object.values(TOWER_TYPES).map(type => type.cost))) {
      syncDeploymentControls(`${estimate}。金币不足，暂时无法部署新塔。`);
    } else if (!best || best.prediction + 0.25 >= baseline) {
      syncDeploymentControls(`${estimate}。补一座塔的预估改善不足。`);
    } else {
      recommended = best;
      selectedTower = null;
      selectedType = best.type.id;
      refreshDeck();
      refreshBrief();
      updateTip();
      syncDeploymentControls(
        `第 ${number} 波 · ${best.type.name}（${best.type.cost} 金）· 第 ${best.r + 1} 行第 ${best.c + 1} 列\n` +
        `MLP 预计漏怪 ${baseline.toFixed(1)} → ${best.prediction.toFixed(1)} 只。点击黄色格子部署。`,
      );
    }
  }

  function beginWave(number, config) {
    wave = number;
    waveCfg = config;
    spawnQueue = waveCfg.units.slice();
    totalThisWave = spawnQueue.length;
    appeared = 0;
    leaked = 0;
    bossLeaked = 0;
    spawnTimer = 24;
    running = true;
    paused = false;
    if (headless) return;
    $pause.classList.remove('is-on');
    $pause.textContent = '暂停';
    $start.disabled = true;
    msg(`第 ${wave} 波 · ${waveCfg.title}：${waveCfg.summary}（强度 ${Math.round(waveCfg.pressure * 100)}%）`);
    refreshWavePanel();
  }

  function startWave() {
    if (over || running) return;
    const number = wave + 1;
    const config = configFor(number, towers.filter(t => !t.dead), money, seedForNextWave());
    nextWaveSeed = null;
    recommended = null;
    beginWave(number, config);
    syncDeploymentControls('本波进行中。');
  }

  /* ============================================================
   * 八、主循环
   * ============================================================ */
  function update() {
    if (pathDirty) {
      pathDirty = false;
      for (const e of enemies) if (!e.dead && e.state === 'march') rePath(e);
    }

    if (spawnQueue.length) {
      spawnTimer--;
      if (spawnTimer <= 0) {
        spawnTimer = Math.max(16, 34 - wave * 2);
        spawnEnemy(spawnQueue.shift());
      }
    }

    updateEnemies();
    updateTowers();
    updateBullets();
    updateEffects();

    enemies = enemies.filter(e => !e.dead);
    bullets = bullets.filter(b => !b.done);
    towers = towers.filter(t => !t.dead);
    if (selectedTower && selectedTower.dead) selectedTower = null;

    // Offline labels count every breach, even if the base would fall mid-wave.
    if (!headless && lives <= 0 && !over) {
      over = true;
      running = false;
      $start.disabled = true;
      msg('💥 基地陷落，游戏结束');
      reportDeployment(true);
    }

    if (running && !over && !spawnQueue.length && !enemies.length) {
      running = false;
      if (!headless) $start.disabled = false;
      const bonus = 12 + wave * 4;
      const interest = interestFor(wave, waveCfg ? waveCfg.pressure : 0);
      money += bonus + interest;
      if (headless) return;
      msg(`✅ 第 ${wave} 波清除 · 奖励 +${bonus} · 利息 +${interest}`);
      refreshWavePanel();
      refreshDeck();
      refreshBrief();
      reportDeployment(false);
    }
  }

  /* ============================================================
   * 九、渲染
   * ============================================================ */
  function drawGrid() {
    ctx.strokeStyle = PALETTE.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= COLS; i++) {
      ctx.moveTo(i * T + 0.5, 0);
      ctx.lineTo(i * T + 0.5, ROWS * T);
    }
    for (let j = 0; j <= ROWS; j++) {
      ctx.moveTo(0, j * T + 0.5);
      ctx.lineTo(COLS * T, j * T + 0.5);
    }
    ctx.stroke();
  }

  function drawPaths() {
    ctx.setLineDash([4, 8]);
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = PALETTE.path;
    for (const e of enemies) {
      if (e.dead || e.state !== 'march' || e.flying || !e.path) continue;
      ctx.beginPath();
      ctx.moveTo(e.x, e.y);
      for (let i = e.pi; i < e.path.length; i++) ctx.lineTo(cx(e.path[i].c), cy(e.path[i].r));
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  function drawSpawnAndBase() {
    // 出生点
    const sx = cx(SPAWN.c);
    const sy = cy(SPAWN.r);
    ctx.save();
    ctx.shadowBlur = 14;
    ctx.shadowColor = PALETTE.danger;
    ctx.strokeStyle = 'rgba(255,94,126,0.72)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(sx, sy, T * 0.3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // 基地
    const bx = cx(BASE.c);
    const by = cy(BASE.r);
    const pulse = 1 + Math.sin(performance.now() / 380) * 0.07;
    ctx.save();
    ctx.shadowBlur = 20;
    ctx.shadowColor = PALETTE.heal;
    ctx.fillStyle = PALETTE.heal;
    ctx.beginPath();
    ctx.arc(bx, by, T * 0.34 * pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#06101f';
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('B', bx, by);
  }

  function drawHover() {
    if (!hoverCell || over || !selectedType) return;
    const { c, r } = hoverCell;
    const type = TOWER_TYPES[selectedType];
    const canBuild = grid[r][c] === 0
      && !(c === SPAWN.c && r === SPAWN.r)
      && !(c === BASE.c && r === BASE.r)
      && money >= type.cost;

    ctx.fillStyle = canBuild ? 'rgba(63,224,255,0.12)' : 'rgba(255,94,126,0.12)';
    ctx.fillRect(c * T, r * T, T, T);

    if (canBuild) {
      ctx.strokeStyle = 'rgba(63,224,255,0.38)';
      ctx.lineWidth = 1.4;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.arc(cx(c), cy(r), type.range * T, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function towerGlyph(type, x, y, angle) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle || 0);
    ctx.strokeStyle = type.color;
    ctx.fillStyle = type.color;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';

    switch (type.icon) {
      case 'dart': {
        ctx.beginPath();
        ctx.moveTo(-7, 0); ctx.lineTo(7, 0);
        ctx.moveTo(2, -5); ctx.lineTo(7, 0); ctx.lineTo(2, 5);
        ctx.stroke();
        break;
      }
      case 'cannon': {
        ctx.beginPath();
        ctx.arc(0, 0, 6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, 0); ctx.lineTo(11, 0);
        ctx.lineWidth = 3.4;
        ctx.stroke();
        break;
      }
      case 'frost': {
        for (let i = 0; i < 3; i++) {
          const a = (Math.PI / 3) * i;
          ctx.beginPath();
          ctx.moveTo(Math.cos(a) * -7, Math.sin(a) * -7);
          ctx.lineTo(Math.cos(a) * 7, Math.sin(a) * 7);
          ctx.stroke();
        }
        break;
      }
      case 'tesla': {
        ctx.beginPath();
        ctx.moveTo(-4, 6); ctx.lineTo(0, -2); ctx.lineTo(4, 6);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, -3, 2.4, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'sniper': {
        ctx.beginPath();
        ctx.arc(0, 0, 7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, -7); ctx.lineTo(0, 7);
        ctx.moveTo(-7, 0); ctx.lineTo(7, 0);
        ctx.lineWidth = 1.2;
        ctx.stroke();
        break;
      }
      default: {
        ctx.beginPath();
        ctx.arc(0, 0, 6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawTower(t) {
    const ty = t.type;

    ctx.save();
    ctx.shadowBlur = 14;
    ctx.shadowColor = ty.color;
    ctx.fillStyle = 'rgba(6,16,31,0.9)';
    ctx.strokeStyle = ty.color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(t.x, t.y, T * 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    towerGlyph(ty, t.x, t.y, t.angle);

    if (t.hp < t.maxHp) {
      const w = T * 0.62;
      const bx = t.x - w / 2;
      const by = t.y + T * 0.36;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(bx, by, w, 4);
      ctx.fillStyle = PALETTE.danger;
      ctx.fillRect(bx, by, w * Math.max(0, t.hp / t.maxHp), 4);
    }
  }

  function enemyShape(e) {
    const type = e.type;
    const x = e.x;
    const y = e.y;
    const r = e.r;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = e.hitFlash > 0 ? '#ffffff' : type.color;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1.2;

    switch (type.icon) {
      case 'skull': {
        ctx.beginPath();
        ctx.arc(0, 0, r, Math.PI, 0);
        ctx.lineTo(r * 0.7, r * 0.85);
        ctx.lineTo(-r * 0.7, r * 0.85);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#06101f';
        ctx.beginPath();
        ctx.arc(-r * 0.35, -r * 0.1, r * 0.22, 0, Math.PI * 2);
        ctx.arc(r * 0.35, -r * 0.1, r * 0.22, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'shield': {
        ctx.beginPath();
        ctx.moveTo(0, -r);
        ctx.lineTo(r * 0.85, -r * 0.4);
        ctx.lineTo(r * 0.85, r * 0.3);
        ctx.quadraticCurveTo(r * 0.5, r * 0.95, 0, r);
        ctx.quadraticCurveTo(-r * 0.5, r * 0.95, -r * 0.85, r * 0.3);
        ctx.lineTo(-r * 0.85, -r * 0.4);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'bolt': {
        ctx.beginPath();
        ctx.moveTo(r * 0.35, -r);
        ctx.lineTo(-r * 0.55, r * 0.1);
        ctx.lineTo(0, r * 0.1);
        ctx.lineTo(-r * 0.3, r);
        ctx.lineTo(r * 0.6, -r * 0.15);
        ctx.lineTo(r * 0.05, -r * 0.15);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'wing': {
        ctx.beginPath();
        ctx.ellipse(-r * 0.55, 0, r * 0.6, r * 0.34, -0.3, 0, Math.PI * 2);
        ctx.ellipse(r * 0.55, 0, r * 0.6, r * 0.34, 0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.42, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      default: {
        ctx.beginPath();
        ctx.moveTo(0, -r);
        ctx.quadraticCurveTo(r, -r * 0.2, r * 0.7, r * 0.7);
        ctx.lineTo(r * 0.25, r * 0.35);
        ctx.lineTo(0, r * 0.8);
        ctx.lineTo(-r * 0.25, r * 0.35);
        ctx.lineTo(-r * 0.7, r * 0.7);
        ctx.quadraticCurveTo(-r, -r * 0.2, 0, -r);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawEnemy(e) {
    // 落地阴影（飞行单位更高）
    ctx.save();
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(e.x, e.y + (e.flying ? 14 : e.r * 0.9), e.r * 0.8, e.r * 0.28, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    if (e.swing > 0) {
      const sc = 1 + e.swing * 0.18;
      ctx.translate(e.x, e.y);
      ctx.scale(sc, sc);
      ctx.translate(-e.x, -e.y);
    }
    ctx.shadowBlur = e.type.boss ? 24 : 10;
    ctx.shadowColor = e.type.color;
    enemyShape(e);
    ctx.restore();

    // 血条
    const w = e.type.boss ? 44 : 24;
    const bx = e.x - w / 2;
    const by = e.y - e.r - (e.flying ? 10 : 8);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(bx, by, w, 3);
    ctx.fillStyle = e.slowT > 0 ? PALETTE.accent : PALETTE.heal;
    ctx.fillRect(bx, by, w * Math.max(0, e.hp / e.maxHp), 3);

    // 拆塔标记
    if (e.state === 'attack') {
      ctx.fillStyle = PALETTE.warn;
      ctx.font = 'bold 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText('⚔', e.x, by - 3);
    }
  }

  function drawBullet(b) {
    const len = 8;
    ctx.save();
    ctx.strokeStyle = b.color;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.shadowBlur = 8;
    ctx.shadowColor = b.color;
    ctx.beginPath();
    ctx.moveTo(b.x - Math.cos(b.angle) * len, b.y - Math.sin(b.angle) * len);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }

  function drawEffects() {
    for (const z of zaps) {
      ctx.save();
      ctx.globalAlpha = z.life / z.max;
      ctx.strokeStyle = '#a8c6ff';
      ctx.lineWidth = 1.8;
      ctx.shadowBlur = 10;
      ctx.shadowColor = '#8fb0ff';
      ctx.beginPath();
      ctx.moveTo(z.x1, z.y1);
      const seg = 4;
      for (let i = 1; i < seg; i++) {
        const t2 = i / seg;
        ctx.lineTo(
          z.x1 + (z.x2 - z.x1) * t2 + rand(-5, 5),
          z.y1 + (z.y2 - z.y1) * t2 + rand(-5, 5),
        );
      }
      ctx.lineTo(z.x2, z.y2);
      ctx.stroke();
      ctx.restore();
    }

    for (const b of beams) {
      ctx.save();
      ctx.globalAlpha = b.life / b.max;
      ctx.strokeStyle = '#ff8fa0';
      ctx.lineWidth = 2;
      ctx.shadowBlur = 14;
      ctx.shadowColor = '#ff6b81';
      ctx.beginPath();
      ctx.moveTo(b.x1, b.y1);
      ctx.lineTo(b.x2, b.y2);
      ctx.stroke();
      ctx.restore();
    }

    for (const m of marks) {
      const k = m.life / m.max;
      ctx.save();
      ctx.globalAlpha = k * k;
      ctx.strokeStyle = m.color;
      ctx.lineWidth = 2;
      ctx.shadowBlur = 12;
      ctx.shadowColor = m.color;
      const r = m.r * (1 + (1 - k) * 0.5);
      if (m.style === 'ring') {
        ctx.beginPath();
        ctx.arc(m.x, m.y, r * (2 - k), 0, Math.PI * 2);
        ctx.stroke();
      } else if (m.style === 'spark') {
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2 + 0.4;
          ctx.beginPath();
          ctx.moveTo(m.x + Math.cos(a) * r * 0.3, m.y + Math.sin(a) * r * 0.3);
          ctx.lineTo(m.x + Math.cos(a) * r * 0.9, m.y + Math.sin(a) * r * 0.9);
          ctx.stroke();
        }
      } else if (m.style === 'dash') {
        for (let i = -1; i <= 1; i++) {
          ctx.beginPath();
          ctx.moveTo(m.x - r, m.y + i * r * 0.28);
          ctx.lineTo(m.x + r, m.y + i * r * 0.28);
          ctx.stroke();
        }
      } else if (m.style === 'feather') {
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          ctx.arc(m.x, m.y + i * 6, r * 0.55, Math.PI * 1.15, Math.PI * 1.85);
          ctx.stroke();
        }
      } else {
        for (let i = 0; i < 3; i++) {
          const a = -0.7 + i * 0.32;
          ctx.beginPath();
          ctx.moveTo(m.x - Math.cos(a) * r, m.y - Math.sin(a) * r);
          ctx.lineTo(m.x + Math.cos(a) * r, m.y + Math.sin(a) * r);
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    for (const p of particles) {
      ctx.globalAlpha = p.life / p.max;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /* 选中已放置的塔：脚下画一圈虚线，标出卖价 */
  function drawSelectedTower() {
    const t = selectedTower;
    if (!t || t.dead) return;
    ctx.save();
    ctx.strokeStyle = PALETTE.warn;
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.arc(t.x, t.y, T * 0.46, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = PALETTE.warn;
    ctx.font = '600 12px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`+${sellValue(t)}`, t.x, t.y - T * 0.52);
    ctx.restore();
  }

  function draw() {
    const g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    g.addColorStop(0, '#0a1524');
    g.addColorStop(1, '#060e1a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    if (shake > 0) ctx.translate(rand(-shake, shake), rand(-shake, shake));

    drawGrid();
    drawPaths();
    drawSpawnAndBase();
    drawHover();
    if (recommended) {
      ctx.save();
      ctx.strokeStyle = PALETTE.warn;
      ctx.lineWidth = 3;
      ctx.setLineDash([7, 4]);
      ctx.strokeRect(recommended.c * T + 4, recommended.r * T + 4, T - 8, T - 8);
      ctx.restore();
    }
    for (const t of towers) drawTower(t);
    drawSelectedTower();
    for (const e of enemies) drawEnemy(e);
    for (const b of bullets) drawBullet(b);
    drawEffects();
    ctx.restore();
  }

  /* ============================================================
   * 十、UI
   * ============================================================ */
  function iconSvg(name) { return ICONS[name] || ICONS.dart; }

  function buildDeck() {
    $deck.innerHTML = '';
    const order = Object.values(TOWER_TYPES).sort((a, b) => a.slot - b.slot);
    for (const ty of order) {
      const btn = document.createElement('button');
      btn.className = 'tower';
      btn.type = 'button';
      btn.dataset.type = ty.id;
      btn.innerHTML = `
        <span class="tower-slot">${ty.slot}</span>
        <span class="tower-ico" style="color:${ty.color}">${iconSvg(ty.icon)}</span>
        <span class="tower-copy">
          <span class="tower-name">${ty.name}</span>
          <span class="tower-tag">${ty.slot}·${ty.tag}</span>
        </span>
        <span class="tower-cost">${ty.cost}</span>`;
      btn.addEventListener('click', () => selectTower(ty.id));
      $deck.appendChild(btn);
    }
    refreshDeck();
  }

  function selectTower(id) {
    if (recommended) clearRecommendation();
    if (selectedType === id) { selectedType = null; } else { selectedType = id; }
    refreshDeck();
    refreshBrief();
    updateTip();
  }

  function refreshDeck() {
    if (headless) return;
    let deployed = 0;
    for (const t of towers) if (!t.dead) deployed++;
    $deployed.textContent = UI_TEXT.deckMeta.replace('{n}', deployed);

    for (const btn of $deck.querySelectorAll('.tower')) {
      const ty = TOWER_TYPES[btn.dataset.type];
      btn.classList.toggle('is-active', btn.dataset.type === selectedType);
      btn.classList.toggle('is-broke', money < ty.cost);
    }
  }

  function refreshBrief() {
    /* 选中了已放置的塔 → 显示出售信息 */
    if (selectedTower && !selectedTower.dead) {
      const t = selectedTower;
      const ty = t.type;
      $briefName.textContent = ty.name;
      $briefIcon.style.color = ty.color;
      $briefIcon.innerHTML = iconSvg(ty.icon);
      $briefTag.textContent = UI_TEXT.sellTag;
      $briefDesc.textContent = running
        ? UI_TEXT.sellLocked
        : UI_TEXT.sellBody.replace('{v}', sellValue(t));
      $briefCost.textContent = String(ty.cost);
      $briefRange.textContent = `${ty.range.toFixed(1)} 格`;
      $briefAir.textContent = ty.air ? UI_TEXT.airYes : UI_TEXT.airNo;
      const strongT = Object.entries(COUNTER[ty.id] || {})
        .filter(([, mul]) => mul >= 1.25)
        .map(([id]) => ENEMY_TYPES[id].name);
      $briefCounter.textContent = strongT.length ? strongT.join(' · ') : '无特别克制';
      return;
    }
    if (!selectedType) {
      $briefName.textContent = '选择炮塔';
      $briefIcon.innerHTML = '';
      $briefTag.textContent = '—';
      $briefDesc.textContent = '点击任意炮塔，查看它的定位与参数。';
      $briefCost.textContent = '—';
      $briefRange.textContent = '—';
      $briefAir.textContent = '—';
      $briefCounter.textContent = '—';
      return;
    }
    const ty = TOWER_TYPES[selectedType];
    $briefName.textContent = ty.name;
    $briefIcon.style.color = ty.color;
    $briefIcon.innerHTML = iconSvg(ty.icon);
    $briefTag.textContent = ty.tag;
    $briefDesc.textContent = ty.brief;
    $briefCost.textContent = String(ty.cost);
    $briefRange.textContent = `${ty.range.toFixed(1)} 格`;
    $briefAir.textContent = ty.air ? UI_TEXT.airYes : UI_TEXT.airNo;

    // 特攻：这条塔把哪些敌人打得更疼
    const strong = Object.entries(COUNTER[ty.id] || {})
      .filter(([, mul]) => mul >= 1.25)
      .map(([id]) => ENEMY_TYPES[id].name);
    $briefCounter.textContent = strong.length ? strong.join(' · ') : '无特别克制';
  }

  function updateTip() {
    if (over) { $tip.textContent = '游戏结束，点「重开」再来一局'; return; }
    if (paused) { $tip.textContent = '已暂停 — 按 P 继续'; return; }
    if (selectedTower && !selectedTower.dead) {
      $tip.textContent = running
        ? `「${selectedTower.type.name}」战斗中不能出售，等这一波结束`
        : `已选中「${selectedTower.type.name}」· 按 X 出售，可得 ${sellValue(selectedTower)} 金币`;
      return;
    }
    if (!selectedType) { $tip.textContent = '先在右侧选择一种炮塔'; return; }
    const ty = TOWER_TYPES[selectedType];
    $tip.textContent = `点击空地部署「${ty.name}」· 造价 ${ty.cost}`;
  }

  let radarSig = null;

  function refreshWavePanel() {
    const list = new Map();
    // 场上
    for (const e of enemies) {
      if (e.dead) continue;
      list.set(e.type.id, (list.get(e.type.id) || 0) + 1);
    }
    // 待出场
    for (const id of spawnQueue) {
      list.set(id, (list.get(id) || 0) + 1);
    }

    // 仅在敌情构成变化时重建列表，否则每帧重建会让 CSS 动画反复归零
    const sig = [...list].map(([id, n]) => id + ':' + n).join('|');
    if (sig !== radarSig) {
      radarSig = sig;
      $radar.innerHTML = '';
      if (!list.size) {
        $radar.innerHTML = '<div class="radar-row"><span class="radar-ico" style="color:#69829d">' + ICONS.skull + '</span><span class="radar-name">暂无敌人</span></div>';
      }
      for (const [id, n] of list) {
        const ty = ENEMY_TYPES[id];
        const row = document.createElement('div');
        row.className = 'radar-row';
        row.innerHTML = `
        <span class="radar-ico" style="color:${ty.color}">${iconSvg(ty.icon)}</span>
        <span class="radar-name">${ty.name}</span>
        <span class="radar-count">×${n}</span>`;
        $radar.appendChild(row);
      }
    }

    const onField = enemies.filter(e => !e.dead).length;
    $onField.textContent = `场上 ${onField} · 待出场 ${spawnQueue.length}`;
    $spawned.textContent = `${Math.min(appeared, totalThisWave)}/${totalThisWave} 已出现`;
    const pct = totalThisWave ? Math.min(100, (appeared / totalThisWave) * 100) : 0;
    $spawnBar.style.width = pct + '%';
    $waveTitle.textContent = wave === 0 ? '待命' : (running ? UI_TEXT.running : UI_TEXT.standby);
    $waveTip.textContent = waveCfg ? `第 ${wave} 波 · ${waveCfg.title}：${waveCfg.tip}` : '点击「开始波次」，让敌人进来。';
  }

  let hudMoney = -1;
  let hudLives = -1;
  let hudWave = -1;

  function updateHud() {
    const moneyChanged = money !== hudMoney;
    if (moneyChanged) { hudMoney = money; $money.textContent = String(Math.floor(money)); }
    if (lives !== hudLives) { hudLives = lives; $lives.textContent = String(lives); }
    if (wave !== hudWave) { hudWave = wave; $wave.textContent = String(wave); }
    updateTip();
    refreshWavePanel();
    if (moneyChanged) refreshDeck();
  }

  /* ============================================================
   * 十一、交互
   * ============================================================ */
  function cellFromEvent(evt) {
    const rect = canvas.getBoundingClientRect();
    const c = Math.floor(((evt.clientX - rect.left) / rect.width) * COLS);
    const r = Math.floor(((evt.clientY - rect.top) / rect.height) * ROWS);
    return { c, r };
  }

  function bindControls() {
    canvas.addEventListener('mousemove', evt => {
      const { c, r } = cellFromEvent(evt);
      hoverCell = inBounds(c, r) ? { c, r } : null;
    });
    canvas.addEventListener('mouseleave', () => { hoverCell = null; });
    canvas.addEventListener('click', evt => {
      if (over || paused) return;
      const { c, r } = cellFromEvent(evt);
      if (!inBounds(c, r)) return;
      /* 点在有塔的格子上 → 选中它准备出售，而不是继续建塔 */
      const hit = towers.find(t => !t.dead && t.c === c && t.r === r);
      if (hit) { selectPlacedTower(hit); return; }
      buildTower(c, r);
    });
    canvas.addEventListener('contextmenu', evt => {
      evt.preventDefault();
      if (recommended) clearRecommendation();
      selectedType = null;
      selectedTower = null;
      refreshDeck();
      refreshBrief();
      updateTip();
    });

    $pause.addEventListener('click', togglePause);
    $start.addEventListener('click', startWave);
    $restart.addEventListener('click', newGame);
    $forecast.addEventListener('click', forecastWave);
    $advise.addEventListener('click', adviseDeployment);

    document.addEventListener('keydown', evt => {
      if (evt.key === 'p' || evt.key === 'P') { togglePause(); return; }
      if (evt.key === 'Escape') {
        if (recommended) clearRecommendation();
        selectedType = null;
        selectedTower = null;
        refreshDeck();
        refreshBrief();
        updateTip();
        return;
      }
      if (evt.key === 'x' || evt.key === 'X') { if (selectedTower) sellTower(selectedTower); return; }
      const n = Number(evt.key);
      if (n >= 1 && n <= 6) {
        const ty = Object.values(TOWER_TYPES).find(t => t.slot === n);
        if (ty) selectTower(ty.id);
      }
    });
  }

  function togglePause() {
    if (over) return;
    paused = !paused;
    $pause.classList.toggle('is-on', paused);
    $pause.textContent = paused ? '继续' : '暂停';
    updateTip();
    syncDeploymentControls();
  }

  /* ============================================================
   * 十二、启动
   * ============================================================ */
  function newGame() {
    grid = Array.from({ length: ROWS }, () => new Array(COLS).fill(0));
    towers = [];
    enemies = [];
    bullets = [];
    zaps = [];
    beams = [];
    particles = [];
    marks = [];
    shake = 0;
    seenBossAttack = {};
    money = START_MONEY;
    lives = START_LIVES;
    wave = 0;
    running = false;
    over = false;
    paused = false;
    selectedType = 'dart';
    selectedTower = null;
    hoverCell = null;
    pathDirty = false;
    spawnQueue = [];
    spawnTimer = 0;
    waveCfg = null;
    appeared = 0;
    totalThisWave = 0;
    leaked = 0;
    bossLeaked = 0;
    nextWaveSeed = null;
    clearDeployment();

    if (headless) return;
    $pause.classList.remove('is-on');
    $pause.textContent = '暂停';
    $start.disabled = false;
    msg('选一座塔，点空地建造。把路封死，它们会开始拆塔。');

    hudMoney = -1; hudLives = -1; hudWave = -1;
    refreshDeck();
    refreshBrief();
    refreshWavePanel();
    updateTip();
    updateHud();
  }

  let lastTime = 0;
  let acc = 0;
  let frame = 0;

  function loop(now) {
    if (!lastTime) lastTime = now;
    const delta = Math.min(now - lastTime, 250);
    lastTime = now;
    acc += delta;

    let steps = 0;
    while (acc >= STEP && steps < MAX_STEPS) {
      frame++;
      if (running && !over && !paused) update();
      acc -= STEP;
      steps++;
    }
    if (steps >= MAX_STEPS) acc = Math.min(acc, STEP);

    draw();
    if (frame % 5 === 0) updateHud();
    requestAnimationFrame(loop);
  }
  if (headless) {
    window.TDSimulation = {
      board: { cols: COLS, rows: ROWS, spawn: SPAWN, base: BASE },
      setup: ({ placements, cash, health }) => {
        newGame();
        lives = health;
        money = cash + placements.reduce((sum, tile) => sum + TOWER_TYPES[tile.id].cost, 0);
        for (const { c, r, id } of placements) {
          selectedType = id;
          const before = towers.length;
          buildTower(c, r);
          if (towers.length === before) throw new Error('模拟布局有非法部署');
        }
      },
      scenario: deploymentScenario,
      recommend: rankDeployments,
      run: (number, config) => {
        const initialLives = lives;
        beginWave(number, config);
        for (let i = 0; running && i < 16000; i++) update();
        if (running) throw new Error('模拟波次超时');
        return { leaked, bossLeaked, baseDamage: initialLives - lives, total: config.units.length };
      },
    };
    return;
  }

  // 先初始化状态，再构建炮塔面板：refreshDeck() 需要 towers 已是数组
  newGame();
  buildDeck();
  bindControls();
  requestAnimationFrame(loop);

  // 调试钩子：?debug=1 时暴露内部状态，便于逐个验证 boss 表现
  if (location.search.indexOf('debug=1') >= 0) {
    window.__td = {
      spawnEnemy,
      stats: id => enemyStats(ENEMY_TYPES[id] || {}, 1, 1),
      state: () => ({ wave, money, lives, towers: towers.length, enemies: enemies.length, marks, shake }),
      setWave: w => { wave = w; },
      // 把刚生成的敌人瞬移到第一座塔旁边并强制进入拆塔状态，用来快速验证攻击表现
      poke: id => {
        spawnEnemy(id);
        const e = enemies[enemies.length - 1];
        const t = towers[0];
        if (!t) return 'no tower';
        e.x = t.x + T * 0.9;
        e.y = t.y;
        e.state = 'attack';
        e.target = t;
        return { id, attack: e.attack, towerHp: t.hp, marks: marks.length, shake };
      },
    };
  }
})();
