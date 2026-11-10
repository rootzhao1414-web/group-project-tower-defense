/* ============================================================
 * 塔防 × AI — 初版
 * ------------------------------------------------------------
 * 框架来源：html5-game-tower-defense（Canvas + 原生 JS，零依赖）
 *
 * 相比原框架新增的「AI」部分：
 *   1. A* 实时寻路 —— 敌人不再是固定路径，每次都重新算到基地的路
 *   2. 拆塔模式   —— 通路被完全封死时，敌人切换状态去拆掉挡路的塔
 *   3. 自适应波次 —— 根据玩家当前战力动态调整数量/血量/速度
 * ============================================================ */

(() => {
  'use strict';

  // ---------- DOM ----------
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const $money = document.getElementById('money');
  const $lives = document.getElementById('lives');
  const $wave = document.getElementById('wave');
  const $ai = document.getElementById('ai-status');
  const $msg = document.getElementById('message');
  const $start = document.getElementById('start');
  const $restart = document.getElementById('restart');
  const $towerBtns = Array.from(document.querySelectorAll('[data-tower]'));

  // ---------- 常量 ----------
  const N = 13;                       // 13 x 13 网格
  const T = canvas.width / N;         // 每格 40px
  const SPAWN = { c: 0, r: 6 };       // 左侧出生点
  const BASE = { c: 12, r: 6 };       // 右侧基地
  const START_MONEY = 120;
  const START_LIVES = 20;

  const TOWER_TYPES = {
    gun: {
      name: '机枪塔', cost: 30,
      range: T * 2.6, rate: 16, dmg: 7,
      hp: 90, speed: 11, color: '#4cc9f0',
    },
    cannon: {
      name: '炮台', cost: 60,
      range: T * 3.4, rate: 60, dmg: 26, splash: T * 1.0,
      hp: 150, speed: 7, color: '#ffe66d',
    },
    frost: {
      name: '冰塔', cost: 50,
      range: T * 2.4, rate: 32, dmg: 4,
      slow: 0.45, slowDur: 110,
      hp: 80, speed: 9, color: '#80ed99',
    },
  };

  // 八方向：dc, dr, 代价
  const DIRS8 = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, Math.SQRT2], [1, -1, Math.SQRT2],
    [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
  ];

  // ---------- 状态 ----------
  let grid;
  let towers;
  let enemies;
  let bullets;
  let money;
  let lives;
  let wave;
  let running;
  let over;
  let selectedType;
  let hoverCell;
  let gridVersion;
  let pathDirty;
  let spawnQueue;
  let spawnTimer;
  let waveCfg;

  // ---------- 小工具 ----------
  const cx = c => c * T + T / 2;
  const cy = r => r * T + T / 2;
  const inBounds = (c, r) => c >= 0 && c < N && r >= 0 && r < N;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const msg = t => { $msg.textContent = t; };

  /* ============================================================
   * 一、A* 寻路（AI 核心）
   * ============================================================ */

  // 对角距离启发函数（octile distance）
  function heuristic(c, r) {
    const dx = Math.abs(c - BASE.c);
    const dy = Math.abs(r - BASE.r);
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
  }

  // 返回从 (sc,sr) 到基地的格子路径；无路可走返回 null
  function findPath(sc, sr) {
    if (!inBounds(sc, sr)) return null;
    if (sc === BASE.c && sr === BASE.r) return [{ c: sc, r: sr }];

    const startKey = sc + ',' + sr;
    const open = [{ c: sc, r: sr, g: 0, f: heuristic(sc, sr) }];
    const bestG = new Map([[startKey, 0]]);
    const cameFrom = new Map();
    const closed = new Set();

    while (open.length) {
      // 取 f 最小的节点（13x13 规模小，线性扫描足够）
      let bi = 0;
      for (let i = 1; i < open.length; i++) {
        if (open[i].f < open[bi].f) bi = i;
      }
      const cur = open.splice(bi, 1)[0];
      const curKey = cur.c + ',' + cur.r;
      if (closed.has(curKey)) continue;
      closed.add(curKey);

      if (cur.c === BASE.c && cur.r === BASE.r) {
        const path = [];
        let k = curKey;
        while (k) {
          const parts = k.split(',');
          path.push({ c: +parts[0], r: +parts[1] });
          k = cameFrom.get(k);
        }
        return path.reverse();
      }

      for (let i = 0; i < DIRS8.length; i++) {
        const dc = DIRS8[i][0];
        const dr = DIRS8[i][1];
        const stepCost = DIRS8[i][2];
        const nc = cur.c + dc;
        const nr = cur.r + dr;
        if (!inBounds(nc, nr)) continue;
        if (grid[nr][nc] === 1) continue;                 // 塔 = 障碍
        if (dc !== 0 && dr !== 0) {
          // 对角移动不能穿过两个塔之间的墙角
          if (grid[cur.r][nc] === 1 || grid[nr][cur.c] === 1) continue;
        }
        const nKey = nc + ',' + nr;
        if (closed.has(nKey)) continue;
        const ng = cur.g + stepCost;
        if (bestG.has(nKey) && ng >= bestG.get(nKey)) continue;
        bestG.set(nKey, ng);
        cameFrom.set(nKey, curKey);
        open.push({ c: nc, r: nr, g: ng, f: ng + heuristic(nc, nr) });
      }
    }
    return null;
  }

  /* ============================================================
   * 二、敌人 AI
   * ============================================================ */

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

  // 重新规划：有路就继续走，没路就进入「拆塔」状态
  function rePath(e) {
    const c = clamp(Math.floor(e.x / T), 0, N - 1);
    const r = clamp(Math.floor(e.y / T), 0, N - 1);
    const path = findPath(c, r);

    if (path) {
      e.path = path;
      e.pi = 1;
      e.state = 'march';
      e.target = null;
    } else {
      e.path = null;
      e.pi = 0;
      e.state = 'attack';
      e.target = nearestTower(e);
    }
  }

  function spawnEnemy(cfg) {
    const enemy = {
      x: cx(SPAWN.c),
      y: cy(SPAWN.r),
      hp: cfg.hp,
      maxHp: cfg.hp,
      speed: cfg.speed,
      r: 9 + Math.min(3, wave * 0.15),
      state: 'march',
      path: null,
      pi: 0,
      slowT: 0,
      target: null,
      atkCd: 0,
      dead: false,
    };
    rePath(enemy);
    enemies.push(enemy);
  }

  function arriveBase(e) {
    if (e.dead) return;
    e.dead = true;
    lives--;
    msg('⚠ 敌人突破防线！');
  }

  function updateEnemyAttack(e) {
    if (!e.target || e.target.dead) {
      e.target = nearestTower(e);
      if (!e.target) {
        rePath(e);
        return;
      }
    }

    const t = e.target;
    const dx = t.x - e.x;
    const dy = t.y - e.y;
    const d = Math.hypot(dx, dy) || 1;
    const reach = T * 0.95;

    if (d > reach) {
      const step = e.speed * 0.8 * (e.slowT > 0 ? 0.5 : 1);
      const move = Math.min(step, d - reach);
      e.x += (dx / d) * move;
      e.y += (dy / d) * move;
    } else {
      e.atkCd--;
      if (e.atkCd <= 0) {
        e.atkCd = 38;
        t.hp -= 7;
        if (t.hp <= 0) destroyTower(t);
      }
    }
  }

  function updateEnemies() {
    for (const e of enemies) {
      if (e.dead) continue;
      if (e.slowT > 0) e.slowT--;

      if (e.state === 'attack') {
        updateEnemyAttack(e);
        continue;
      }

      if (!e.path || e.pi >= e.path.length) {
        arriveBase(e);
        continue;
      }

      const node = e.path[e.pi];
      const tx = cx(node.c);
      const ty = cy(node.r);
      const dx = tx - e.x;
      const dy = ty - e.y;
      const d = Math.hypot(dx, dy);
      const step = e.speed * (e.slowT > 0 ? 0.5 : 1);

      if (d <= step) {
        e.x = tx;
        e.y = ty;
        e.pi++;
        if (e.pi >= e.path.length) arriveBase(e);
      } else {
        e.x += (dx / d) * step;
        e.y += (dy / d) * step;
      }
    }
  }

  /* ============================================================
   * 三、塔与子弹
   * ============================================================ */

  function pickTarget(t) {
    let best = null;
    let bestScore = -Infinity;
    for (const e of enemies) {
      if (e.dead) continue;
      const d = Math.hypot(e.x - t.x, e.y - t.y);
      if (d > t.type.range) continue;
      // 打分：离基地越近的敌人越优先
      const score = -Math.hypot(e.x - cx(BASE.c), e.y - cy(BASE.r));
      if (score > bestScore) { bestScore = score; best = e; }
    }
    return best;
  }

  function fire(t, target) {
    bullets.push({
      x: t.x,
      y: t.y,
      target,
      dmg: t.type.dmg,
      speed: t.type.speed,
      color: t.type.color,
      splash: t.type.splash || 0,
      slow: t.type.slow || 0,
      slowDur: t.type.slowDur || 0,
      done: false,
    });
  }

  function updateTowers() {
    for (const t of towers) {
      if (t.dead) continue;
      if (t.cd > 0) { t.cd--; continue; }
      const target = pickTarget(t);
      if (target) {
        t.cd = t.type.rate;
        fire(t, target);
      }
    }
  }

  function hitEnemy(e, dmg, b) {
    if (e.dead) return;
    e.hp -= dmg;
    if (b.slow) e.slowT = b.slowDur;

    if (b.splash > 0) {
      for (const o of enemies) {
        if (o === e || o.dead) continue;
        if (Math.hypot(o.x - e.x, o.y - e.y) <= b.splash) o.hp -= dmg * 0.5;
      }
    }

    if (e.hp <= 0) {
      e.dead = true;
      money += 6 + Math.floor(wave * 1.5);
    }
  }

  function updateBullets() {
    for (const b of bullets) {
      if (b.done) continue;
      if (!b.target || b.target.dead) { b.done = true; continue; }

      const dx = b.target.x - b.x;
      const dy = b.target.y - b.y;
      const d = Math.hypot(dx, dy) || 1;

      if (d < 8) {
        hitEnemy(b.target, b.dmg, b);
        b.done = true;
      } else {
        b.x += (dx / d) * b.speed;
        b.y += (dy / d) * b.speed;
      }
    }
  }

  function buildTower(c, r) {
    if (!inBounds(c, r)) return;
    if (c === SPAWN.c && r === SPAWN.r) { msg('不能建在出生点上'); return; }
    if (c === BASE.c && r === BASE.r) { msg('不能建在基地上'); return; }
    if (grid[r][c] !== 0) { msg('这里已经有一座塔了'); return; }

    for (const e of enemies) {
      if (e.dead) continue;
      if (Math.floor(e.x / T) === c && Math.floor(e.y / T) === r) {
        msg('敌人正在这格，等它走开');
        return;
      }
    }

    const type = TOWER_TYPES[selectedType];
    if (money < type.cost) { msg(`金币不够，需要 ${type.cost}`); return; }

    money -= type.cost;
    grid[r][c] = 1;
    gridVersion++;
    pathDirty = true;

    towers.push({
      c, r,
      x: cx(c),
      y: cy(r),
      type,
      hp: type.hp,
      maxHp: type.hp,
      cd: 0,
      dead: false,
    });

    if (!findPath(SPAWN.c, SPAWN.r)) {
      msg('🚫 所有通路被封死 —— 敌人开始拆塔');
    } else {
      msg(`建好 ${type.name}`);
    }
  }

  function destroyTower(t) {
    t.dead = true;
    grid[t.r][t.c] = 0;
    gridVersion++;
    pathDirty = true;
    msg('💥 一座塔被摧毁');
  }

  /* ============================================================
   * 四、波次（自适应）
   * ============================================================ */

  function makeWaveConfig(w) {
    // 战力评估：塔数量 + 总输出 + 存款 + 剩余生命
    let dps = 0;
    for (const t of towers) {
      if (t.dead) continue;
      dps += t.type.dmg / t.type.rate;
    }
    // dps 是「每帧伤害」，先换算成「每秒伤害」，数值才符合直觉
    const power = towers.length * 6 + dps * 60 * 1.2 + money * 0.08 + lives * 0.4;

    // 0 ~ 1 的压力系数：玩家越强，波次越凶
    const pressure = clamp((power - 40) / 220, 0, 1);

    return {
      count: Math.round(5 + w * 1.7 + pressure * 5),
      hp: Math.round(16 + w * 6 + pressure * 34),
      speed: 0.9 + w * 0.025 + pressure * 0.18,
      pressure,
    };
  }

  function startWave() {
    if (over || running) return;
    wave++;
    waveCfg = makeWaveConfig(wave);
    spawnQueue = waveCfg.count;
    spawnTimer = 20;
    running = true;
    $start.disabled = true;
    msg(`第 ${wave} 波来袭 · 敌方强度 ${Math.round(waveCfg.pressure * 100)}%`);
  }

  /* ============================================================
   * 五、主循环
   * ============================================================ */

  function update() {
    // 地形变化（建塔/拆塔）→ 所有行进中的敌人重新寻路
    if (pathDirty) {
      pathDirty = false;
      for (const e of enemies) {
        if (!e.dead && e.state === 'march') rePath(e);
      }
    }

    // 出怪
    if (spawnQueue > 0) {
      spawnTimer--;
      if (spawnTimer <= 0) {
        spawnTimer = 34;
        spawnQueue--;
        spawnEnemy(waveCfg);
      }
    }

    updateEnemies();
    updateTowers();
    updateBullets();

    enemies = enemies.filter(e => !e.dead);
    bullets = bullets.filter(b => !b.done);
    towers = towers.filter(t => !t.dead);

    if (lives <= 0 && !over) {
      over = true;
      running = false;
      $start.disabled = true;
      msg('💥 基地陷落，游戏结束');
    }

    if (running && !over && spawnQueue === 0 && enemies.length === 0) {
      running = false;
      $start.disabled = false;
      const bonus = 10 + wave * 4;
      money += bonus;
      msg(`✅ 第 ${wave} 波清除，奖励 +${bonus}`);
    }
  }

  /* ============================================================
   * 六、渲染
   * ============================================================ */

  function drawGrid() {
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= N; i++) {
      ctx.beginPath();
      ctx.moveTo(i * T, 0);
      ctx.lineTo(i * T, canvas.height);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i * T);
      ctx.lineTo(canvas.width, i * T);
      ctx.stroke();
    }
  }

  // 把每个敌人当前的 A* 路径画出来 —— 让「AI 在想什么」变得可见
  function drawPaths() {
    ctx.setLineDash([4, 7]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255,94,126,0.16)';
    for (const e of enemies) {
      if (e.dead || e.state !== 'march' || !e.path) continue;
      ctx.beginPath();
      ctx.moveTo(e.x, e.y);
      for (let i = e.pi; i < e.path.length; i++) {
        ctx.lineTo(cx(e.path[i].c), cy(e.path[i].r));
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  function drawSpawn() {
    const x = cx(SPAWN.c);
    const y = cy(SPAWN.r);
    ctx.save();
    ctx.shadowBlur = 12;
    ctx.shadowColor = '#ff5e7e';
    ctx.strokeStyle = 'rgba(255,94,126,0.7)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, T * 0.3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawBase() {
    const x = cx(BASE.c);
    const y = cy(BASE.r);
    const pulse = 1 + Math.sin(performance.now() / 380) * 0.07;

    ctx.save();
    ctx.shadowBlur = 18;
    ctx.shadowColor = '#80ed99';
    ctx.fillStyle = '#80ed99';
    ctx.beginPath();
    ctx.arc(x, y, T * 0.36 * pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = '#0d1530';
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('B', x, y);
  }

  function drawHover() {
    if (!hoverCell || over) return;
    const { c, r } = hoverCell;
    const type = TOWER_TYPES[selectedType];
    const canBuild = grid[r][c] === 0
      && !(c === SPAWN.c && r === SPAWN.r)
      && !(c === BASE.c && r === BASE.r)
      && money >= type.cost;

    ctx.fillStyle = canBuild ? 'rgba(76,201,240,0.14)' : 'rgba(255,94,126,0.12)';
    ctx.fillRect(c * T, r * T, T, T);

    if (canBuild) {
      ctx.strokeStyle = 'rgba(76,201,240,0.35)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.arc(cx(c), cy(r), type.range, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function drawTower(t) {
    ctx.save();
    ctx.shadowBlur = 12;
    ctx.shadowColor = t.type.color;
    ctx.fillStyle = t.type.color;
    ctx.beginPath();
    ctx.arc(t.x, t.y, T * 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = '#0d1530';
    ctx.beginPath();
    ctx.arc(t.x, t.y, T * 0.13, 0, Math.PI * 2);
    ctx.fill();

    if (t.hp < t.maxHp) {
      const w = T * 0.62;
      const bx = t.x - w / 2;
      const by = t.y + T * 0.36;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(bx, by, w, 4);
      ctx.fillStyle = '#ff5e7e';
      ctx.fillRect(bx, by, w * Math.max(0, t.hp / t.maxHp), 4);
    }
  }

  function drawEnemy(e) {
    const slowed = e.slowT > 0;

    ctx.save();
    ctx.shadowBlur = 8;
    ctx.shadowColor = slowed ? '#80ed99' : '#ff5e7e';
    ctx.fillStyle = slowed ? '#8fe3a5' : '#ff5e7e';
    ctx.beginPath();
    ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const w = 22;
    const bx = e.x - w / 2;
    const by = e.y - e.r - 8;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(bx, by, w, 3);
    ctx.fillStyle = '#80ed99';
    ctx.fillRect(bx, by, w * Math.max(0, e.hp / e.maxHp), 3);

    if (e.state === 'attack') {
      ctx.fillStyle = '#ffe66d';
      ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText('⚔', e.x, by - 3);
    }
  }

  function drawBullet(b) {
    ctx.fillStyle = b.color;
    ctx.beginPath();
    ctx.arc(b.x, b.y, 2.6, 0, Math.PI * 2);
    ctx.fill();
  }

  function draw() {
    const g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    g.addColorStop(0, '#13243a');
    g.addColorStop(1, '#0d1530');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    drawGrid();
    drawPaths();
    drawSpawn();
    drawBase();
    drawHover();
    for (const t of towers) drawTower(t);
    for (const e of enemies) drawEnemy(e);
    for (const b of bullets) drawBullet(b);
  }

  /* ============================================================
   * 七、HUD 与交互
   * ============================================================ */

  let hudMoney = -1;
  let hudLives = -1;
  let hudWave = -1;
  let hudAi = '';

  function updateHud() {
    if (money !== hudMoney) { hudMoney = money; $money.textContent = String(Math.floor(money)); }
    if (lives !== hudLives) { hudLives = lives; $lives.textContent = String(lives); }
    if (wave !== hudWave) { hudWave = wave; $wave.textContent = String(wave); }

    let ai;
    if (over) {
      ai = '基地陷落';
    } else if (!running) {
      ai = '待命';
    } else {
      let attacking = 0;
      let marching = 0;
      for (const e of enemies) {
        if (e.dead) continue;
        if (e.state === 'attack') attacking++;
        else marching++;
      }
      if (attacking > 0) ai = `⛏ ${attacking} 个拆塔中`;
      else if (marching > 0) ai = `➡ ${marching} 个行进中`;
      else ai = '生成中…';
    }

    if (ai !== hudAi) { hudAi = ai; $ai.textContent = ai; }
  }

  function cellFromEvent(evt) {
    const rect = canvas.getBoundingClientRect();
    const c = Math.floor(((evt.clientX - rect.left) / rect.width) * N);
    const r = Math.floor(((evt.clientY - rect.top) / rect.height) * N);
    return { c, r };
  }

  canvas.addEventListener('mousemove', evt => {
    const { c, r } = cellFromEvent(evt);
    hoverCell = inBounds(c, r) ? { c, r } : null;
  });

  canvas.addEventListener('mouseleave', () => { hoverCell = null; });

  canvas.addEventListener('click', evt => {
    if (over) return;
    const { c, r } = cellFromEvent(evt);
    if (inBounds(c, r)) buildTower(c, r);
  });

  $towerBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      selectedType = btn.dataset.tower;
      $towerBtns.forEach(b => b.classList.toggle('is-active', b === btn));
    });
  });

  $start.addEventListener('click', startWave);
  $restart.addEventListener('click', newGame);

  function newGame() {
    grid = Array.from({ length: N }, () => new Array(N).fill(0));
    towers = [];
    enemies = [];
    bullets = [];
    money = START_MONEY;
    lives = START_LIVES;
    wave = 0;
    running = false;
    over = false;
    selectedType = 'gun';
    hoverCell = null;
    gridVersion = 0;
    pathDirty = false;
    spawnQueue = 0;
    spawnTimer = 0;
    waveCfg = null;

    $towerBtns.forEach(b => b.classList.toggle('is-active', b.dataset.tower === 'gun'));
    $start.disabled = false;
    msg('选一座塔，点空地建造。把路封死，敌人就会改拆塔。');

    hudMoney = -1;
    hudLives = -1;
    hudWave = -1;
    hudAi = '';
    updateHud();
  }

  /* ============================================================
   * 八、启动
   * ============================================================ */

  // 固定步长：逻辑恒定 60 次/秒，和屏幕刷新率（60Hz / 144Hz / 240Hz）无关
  const STEP = 1000 / 60;
  const MAX_STEPS = 6;      // 单帧最多补算 6 步，防止切回标签页后一次性雪崩

  let frame = 0;
  let lastTime = 0;
  let acc = 0;

  function loop(now) {
    if (!lastTime) lastTime = now;
    // 单帧最多认 250ms，长时间挂起（切标签页）不会瞬间吞掉几十秒
    const delta = Math.min(now - lastTime, 250);
    lastTime = now;
    acc += delta;

    let steps = 0;
    while (acc >= STEP && steps < MAX_STEPS) {
      frame++;
      if (running && !over) update();
      acc -= STEP;
      steps++;
    }
    // 追不上就丢弃积压，宁可慢一点也不要卡死
    if (steps >= MAX_STEPS) acc = Math.min(acc, STEP);

    draw();
    if (frame % 5 === 0) updateHud();
    requestAnimationFrame(loop);
  }

  newGame();
  requestAnimationFrame(loop);
})();
