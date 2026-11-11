/* ============================================================
 * design-assets.js — 从设计稿「塔防 · 敌情雷达」中抠出的
 * 策划 / 美术资产（纯数据层，不依赖任何渲染代码）
 * ------------------------------------------------------------
 * 来源标注：
 *   source: 'design'    → 设计稿上可见，原样保留
 *   source: 'extended'  → 设计稿未展示，按同一世界观补全
 *   source: 'balance'   → 为实现可玩性补的数值
 * ============================================================ */
window.TD = (() => {
  'use strict';

  /* ----------------------------------------------------------
   * A. 色板（设计稿取色，CSS 与 Canvas 共用）
   * ---------------------------------------------------------- */
  const PALETTE = {
    bg0: '#050b16',          // 页面底
    bg1: '#081221',          // 舞台底
    panel: 'rgba(12, 23, 40, 0.86)',
    panelLine: 'rgba(91, 225, 255, 0.14)',
    text: '#dbe9f7',
    textDim: '#69829d',
    accent: '#3fe0ff',       // 青：主强调
    accentSoft: 'rgba(63, 224, 255, 0.12)',
    warn: '#ff9f43',         // 橙：选中 / 高价值
    danger: '#ff4d5e',       // 红：敌方 / 危险
    heal: '#3ddc97',         // 绿：基地 / 恢复
    gold: '#ffd166',
    violet: '#9b8cff',
    // 敌方单位
    enemy: '#ff5e7e',
    enemyArmor: '#9aa7bd',
    enemyFast: '#ffd166',
    enemyAir: '#7fd6ff',
    enemyBoss: '#ff3d6e',
    // 地面与网格
    ground: '#0b1626',
    grid: 'rgba(160, 200, 240, 0.055)',
    path: 'rgba(255, 94, 126, 0.16)',
  };

  /* ----------------------------------------------------------
   * B. 敌人类型
   *    hp / speed(px/s) / armor(每发减伤) / flying / reward
   * ---------------------------------------------------------- */
  const ENEMY_TYPES = {
    wraith: {
      id: 'wraith', name: '裂魂者', short: 'WRAITH', icon: 'ghost',
      hp: 34, speed: 52, armor: 0, flying: false, reward: 6,
      color: PALETTE.enemy, radius: 8,
      desc: '深渊裂缝里爬出的杂兵，数量多、胆子小，一碰就碎。',
      source: 'extended',
    },
    armored: {
      id: 'armored', name: '重甲兵', short: 'HEAVY', icon: 'shield',
      hp: 118, speed: 36, armor: 5, flying: false, reward: 12,
      color: PALETTE.enemyArmor, radius: 10,
      desc: '顶着三层装甲板推进。单发伤害会被削掉 5 点，需要高伤或穿甲。',
      source: 'design',
    },
    runner: {
      id: 'runner', name: '疾影', short: 'RUNNER', icon: 'bolt',
      hp: 22, speed: 86, armor: 0, flying: false, reward: 5,
      color: PALETTE.enemyFast, radius: 6.5,
      desc: '速度是常规单位的两倍，专挑防线薄弱处冲刺。',
      source: 'extended',
    },
    flyer: {
      id: 'flyer', name: '虚空蝠', short: 'FLYER', icon: 'wing',
      hp: 44, speed: 68, armor: 0, flying: true, reward: 9,
      color: PALETTE.enemyAir, radius: 8,
      desc: '贴地飞行的空中单位，只吃得到「对空」炮塔的伤害。',
      source: 'extended',
    },
    colossus: {
      id: 'colossus', name: '深渊巨像', short: 'COLOSSUS', icon: 'skull',
      hp: 820, speed: 24, armor: 8, flying: false, reward: 80,
      color: PALETTE.enemyBoss, radius: 16, boss: true,
      desc: '第 6 波降临的巨型敌人。血厚、甲厚、走得慢，是整场战斗的节拍器。',
      source: 'design',
    },
  };

  /* ----------------------------------------------------------
   * C. 炮塔（昵称 / 造价 / 定位 / 快捷键 = 设计稿原文）
   *    dmg 与 rate 为「每发伤害」「发射间隔(帧@60fps)」
   * ---------------------------------------------------------- */
  const TOWER_TYPES = {
    dart: {
      id: 'dart', slot: 1, name: '疾风弩塔', tag: '单体速射',
      icon: 'dart', color: '#4cc9f0',
      cost: 30, dmg: 5, rate: 8, range: 2.6,
      air: true, pierceArmor: false,
      hp: 90,
      brief: '连发弩机，每 8 帧射出一支利箭。造价最低，用来铺满整条路。',
      source: 'design',
    },
    cannon: {
      id: 'cannon', slot: 2, name: '震荡炮塔', tag: '范围爆破',
      icon: 'cannon', color: '#ff9f43',
      cost: 55, dmg: 22, rate: 50, range: 2.4,
      splash: 1.0, air: false, pierceArmor: false,
      hp: 150,
      brief: '炮弹命中后造成范围伤害，适合清理密集地面敌人。',
      source: 'design',
    },
    frost: {
      id: 'frost', slot: 3, name: '霜冻棱镜', tag: '减速控制',
      icon: 'frost', color: '#80ed99',
      cost: 45, dmg: 3, rate: 26, range: 2.6,
      slow: 0.45, slowDur: 70, air: true, pierceArmor: false,
      hp: 80,
      brief: '伤害不高，但命中后减速 45%。放在拐角，让敌人多挨几轮齐射。',
      source: 'design',
    },
    tesla: {
      id: 'tesla', slot: 4, name: '雷霆线圈', tag: '连锁闪电',
      icon: 'tesla', color: '#8fb0ff',
      cost: 70, dmg: 14, rate: 40, range: 2.3,
      chain: 3, chainFalloff: [1, 0.7, 0.45], air: true, pierceArmor: false,
      hp: 120,
      brief: '闪电会在相邻敌人之间跳跃，最多再弹 2 次，越密越强。',
      source: 'design',
    },
    sniper: {
      id: 'sniper', slot: 5, name: '苍穹狙击塔', tag: '远程重击',
      icon: 'sniper', color: '#ff6b81',
      cost: 65, dmg: 46, rate: 76, range: 5.0,
      air: true, pierceArmor: true,
      hp: 70,
      brief: '射程覆盖半个战场，单发重击并且无视护甲，专治重甲兵与巨像。',
      source: 'design',
    },
    mine: {
      id: 'mine', slot: 6, name: '磁暴地雷', tag: '持续伤害',
      icon: 'mine', color: '#b48cff',
      cost: 50, dmg: 8, rate: 180, range: 0.9,
      aura: { radius: 1.35, tick: 30, duration: 150 },
      air: false, pierceArmor: false,
      hp: 60,
      brief: '敌人靠近时引爆，在 1.35 格内持续放电 2.5 秒，适合卡在隘口。',
      source: 'design',
    },
  };

  /* ----------------------------------------------------------
   * D. 波次编队（design 稿的「第 6 波 · 巨像降临」为蓝本）
   * ---------------------------------------------------------- */
  const WAVE_BLUEPRINTS = [
    { wave: 1, title: '试探', units: [['wraith', 8]], tip: '先铺两座弩塔，看清它们的路线。' },
    { wave: 2, title: '疾行', units: [['wraith', 10], ['runner', 2]], tip: '疾影会贴着边线冲刺。' },
    { wave: 3, title: '重装', units: [['armored', 3], ['wraith', 8]], tip: '重甲兵怕炮塔的溅射，别用弩塔硬啃。' },
    { wave: 4, title: '空袭', units: [['flyer', 3], ['runner', 4], ['wraith', 6]], tip: '飞行单位只能被对空炮塔命中。' },
    { wave: 5, title: '铁墙', units: [['armored', 5], ['flyer', 3]], tip: '狙击塔穿甲，配一座。' },
    { wave: 6, title: '巨像降临', units: [['colossus', 1], ['wraith', 8]], tip: '深渊巨像的护甲是 8，只有狙击塔能完整打穿。' },
  ];

  // w > 6 之后循环使用，强度递增
  const WAVE_TEMPLATES = WAVE_BLUEPRINTS.map(w => w.units);

  /* ----------------------------------------------------------
   * E. UI 文案（设计稿原文）
   * ---------------------------------------------------------- */
  const UI_TEXT = {
    radarTitle: 'ENEMY RADAR',
    radarName: '敌情雷达',
    deckTitle: 'BUILD DECK',
    deckName: '炮塔部署',
    deckMeta: '已部署 {n} 座 · 快捷键 1-6',
    briefTitle: 'DEPLOYMENT BRIEF',
    paused: '已暂停',
    running: '作战中',
    standby: '待命',
    field: '场上 {n} · 待出场 {m}',
    spawned: '{a}/{b} 已出现',
    cost: '造价',
    range: '攻击范围',
    airYes: '可以攻击飞行单位',
    airNo: '无法攻击飞行单位',
    foot: 'P 暂停 · Esc 取消选择 · 右键取消',
    fieldNow: '场上',
    deployed: '已部署',
  };

  /* ----------------------------------------------------------
   * F. 图标（24×24 线性 SVG，currentColor 上色）
   * ---------------------------------------------------------- */
  const S = (d, extra = '') =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}${extra}</svg>`;

  const ICONS = {
    // —— 炮塔 ——
    dart: S('<path d="M4 20 18 6"/><path d="M13 6h5v5"/><path d="M4 14l6 6"/><path d="M7 17l-3 3"/>'),
    cannon: S('<circle cx="9" cy="15" r="4"/><path d="M12 12l7-7"/><path d="M17 3h4v4"/><path d="M3 20c2-1 3-3 2-5"/>'),
    frost: S('<path d="M12 3v18"/><path d="M4.2 7.5l15.6 9"/><path d="M19.8 7.5l-15.6 9"/><path d="M12 7l-2-2M12 7l2-2M12 17l-2 2M12 17l2 2"/>'),
    tesla: S('<path d="M7 4h10l-2 6h4L9 20l2-7H7z"/>'),
    sniper: S('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>'),
    mine: S('<circle cx="12" cy="14" r="6"/><path d="M12 8V4"/><path d="M6 10l-2-2M18 10l2-2"/><path d="M9 14h6"/>'),
    // —— 敌人 ——
    skull: S('<path d="M12 3c-4.4 0-7 3-7 7 0 2.6 1.4 4.2 3 5.2V19a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-3.8c1.6-1 3-2.6 3-5.2 0-4-2.6-7-7-7z"/><circle cx="9.5" cy="11" r="1.2"/><circle cx="14.5" cy="11" r="1.2"/>'),
    shield: S('<path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M12 8v6"/>'),
    bolt: S('<path d="M13 2 4 14h6l-1 8 9-12h-6z"/>'),
    wing: S('<path d="M3 16c3-1 5-3 6-6 2 2 3 2 6 1 2-1 4-3 6-3-1 3-3 5-5 6-3 2-7 3-9 6z"/><path d="M9 10c1-2 2-4 3-5"/>'),
    ghost: S('<path d="M5 20V10a7 7 0 0 1 14 0v10l-2.3-2-2.4 2-2.3-2-2.4 2L7.3 18z"/><circle cx="9.5" cy="11" r="1"/><circle cx="14.5" cy="11" r="1"/>'),
  };

  return { PALETTE, ENEMY_TYPES, TOWER_TYPES, WAVE_BLUEPRINTS, WAVE_TEMPLATES, UI_TEXT, ICONS };
})();
