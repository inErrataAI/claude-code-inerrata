// ============================================================================
// CTF Benchmark — Sprite Art & Animation Engine
// Retro arcade-style pixel art for Opus Wizard vs Haiku Rogue
// Canvas 2D only, zero dependencies, ES module compatible
// ============================================================================

// --- 1. Color Palette Constants -------------------------------------------

const P = {
  // Opus Wizard
  purple:     '#9b59b6',
  purpleDk:   '#7d3c98',
  purpleLt:   '#c39bd3',
  gold:       '#f1c40f',
  goldDk:     '#d4ac0d',
  red:        '#e94560',
  redDk:      '#c0392b',
  skin:       '#f5cba7',
  skinSh:     '#e0a97a',
  white:      '#ecf0f1',
  // Haiku Rogue
  emerald:    '#00ff88',
  emeraldDk:  '#00cc6a',
  cyan:       '#44ddff',
  cyanDk:     '#22aacc',
  gray:       '#333333',
  grayLt:     '#555555',
  grayDk:     '#1a1a1a',
  silver:     '#bdc3c7',
  // Shared
  black:      '#111111',
  eye:        '#ffffff',
  pupil:      '#111111',
  transparent: null,
};

const _ = null; // shorthand for transparent

// --- 2. Opus Wizard Sprite Frames (32x32) ---------------------------------
// Legend: each row is 32 pixels wide. Using palette shorthands.

function opusIdle0() {
  const c = P;
  // Wizard with staff, standing pose
  return [
    /*  0 */ [_,_,_,_,_,_,_,_,_,_,_,_,_,c.gold,c.gold,c.gold,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    /*  1 */ [_,_,_,_,_,_,_,_,_,_,_,_,c.gold,c.red,c.gold,c.gold,c.gold,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    /*  2 */ [_,_,_,_,_,_,_,_,_,_,_,c.purple,c.purple,c.purple,c.purple,c.purple,c.purple,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    /*  3 */ [_,_,_,_,_,_,_,_,_,_,c.purple,c.purpleDk,c.purple,c.purple,c.purple,c.purpleDk,c.purple,c.purple,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    /*  4 */ [_,_,_,_,_,_,_,_,_,c.purple,c.purpleDk,c.purple,c.purple,c.purple,c.purple,c.purple,c.purpleDk,c.purple,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    /*  5 */ [_,_,_,_,_,_,_,_,_,_,c.purple,c.purple,c.purple,c.purple,c.purple,c.purple,c.purple,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    /*  6 */ [_,_,_,_,_,_,_,_,_,_,_,c.skin,c.skin,c.skin,c.skin,c.skin,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    /*  7 */ [_,_,_,_,_,_,_,_,_,_,c.skin,c.eye,c.pupil,c.skin,c.pupil,c.eye,c.skin,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    /*  8 */ [_,_,_,_,_,_,_,_,_,_,c.skin,c.skin,c.skin,c.skinSh,c.skin,c.skin,c.skin,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    /*  9 */ [_,_,_,_,_,_,_,_,_,_,_,c.skin,c.skinSh,c.skinSh,c.skinSh,c.skin,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    /* 10 */ [_,_,_,_,_,_,_,_,_,_,_,_,c.skin,c.red,c.skin,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    /* 11 */ [_,_,_,_,_,_,_,_,_,c.purple,c.purple,c.purple,c.purple,c.purple,c.purple,c.purple,c.purple,c.purple,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    /* 12 */ [_,_,_,_,_,_,_,_,c.purple,c.purpleDk,c.gold,c.purple,c.purple,c.purple,c.purple,c.gold,c.purpleDk,c.purple,c.purple,_,_,_,_,_,_,_,_,_,_,_,_,_],
    /* 13 */ [_,_,_,_,_,_,_,c.purple,c.purpleDk,c.purple,c.gold,c.purple,c.purple,c.purple,c.purple,c.gold,c.purple,c.purpleDk,c.purple,_,_,_,_,_,_,_,_,_,_,_,_,_],
    /* 14 */ [_,_,_,_,_,_,_,c.purple,c.purple,c.purple,c.gold,c.purple,c.purpleDk,c.purpleDk,c.purple,c.gold,c.purple,c.purple,c.purple,_,_,_,_,_,_,_,c.goldDk,_,_,_,_,_],
    /* 15 */ [_,_,_,_,_,_,_,c.skin,c.purple,c.purple,c.gold,c.purple,c.purple,c.purple,c.purple,c.gold,c.purple,c.purple,c.skin,_,_,_,_,_,_,_,c.goldDk,_,_,_,_,_],
    /* 16 */ [_,_,_,_,_,_,_,c.skin,c.purple,c.purple,c.gold,c.gold,c.gold,c.gold,c.gold,c.gold,c.purple,c.purple,c.skin,_,_,_,_,_,_,_,c.goldDk,_,_,_,_,_],
    /* 17 */ [_,_,_,_,_,_,_,_,c.purple,c.purple,c.purple,c.purple,c.purple,c.purple,c.purple,c.purple,c.purple,c.purple,_,_,_,_,_,_,_,_,c.goldDk,_,_,_,_,_],
    /* 18 */ [_,_,_,_,_,_,_,_,c.purple,c.purpleDk,c.purple,c.purple,c.purple,c.purple,c.purple,c.purple,c.purpleDk,c.purple,_,_,_,_,_,_,_,_,c.goldDk,_,_,_,_,_],
    /* 19 */ [_,_,_,_,_,_,_,_,c.purple,c.purple,c.purpleDk,c.purple,c.purple,c.purple,c.purple,c.purpleDk,c.purple,c.purple,_,_,_,_,_,_,_,_,c.goldDk,_,_,_,_,_],
    /* 20 */ [_,_,_,_,_,_,_,_,c.purple,c.purple,c.purple,c.purpleDk,c.purple,c.purple,c.purpleDk,c.purple,c.purple,c.purple,_,_,_,_,_,_,_,_,c.goldDk,_,_,_,_,_],
    /* 21 */ [_,_,_,_,_,_,_,_,_,c.purpleLt,c.purple,c.purple,c.purple,c.purple,c.purple,c.purple,c.purpleLt,_,_,_,_,_,_,_,_,_,c.goldDk,_,_,_,_,_],
    /* 22 */ [_,_,_,_,_,_,_,_,_,c.purpleLt,c.purpleLt,c.purple,c.purple,c.purple,c.purple,c.purpleLt,c.purpleLt,_,_,_,_,_,_,_,_,_,c.goldDk,_,_,_,_,_],
    /* 23 */ [_,_,_,_,_,_,_,_,_,_,c.purpleLt,c.purple,c.purple,c.purple,c.purple,c.purpleLt,_,_,_,_,_,_,_,_,_,_,c.goldDk,_,_,_,_,_],
    /* 24 */ [_,_,_,_,_,_,_,_,_,_,_,c.purple,c.purpleDk,c.purpleDk,c.purple,_,_,_,_,_,_,_,_,_,_,_,c.goldDk,_,_,_,_,_],
    /* 25 */ [_,_,_,_,_,_,_,_,_,_,_,c.purple,c.purpleDk,c.purpleDk,c.purple,_,_,_,_,_,_,_,_,_,_,_,c.gold,_,_,_,_,_],
    /* 26 */ [_,_,_,_,_,_,_,_,_,_,c.black,c.black,_,_,c.black,c.black,_,_,_,_,_,_,_,_,_,c.gold,c.red,c.gold,_,_,_,_],
    /* 27 */ [_,_,_,_,_,_,_,_,_,c.black,c.black,c.black,_,_,c.black,c.black,c.black,_,_,_,_,_,_,_,_,c.gold,c.gold,_,_,_,_,_],
    /* 28 */ [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    /* 29 */ [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    /* 30 */ [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    /* 31 */ [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
  ];
}

function opusIdle1() {
  // Same sprite shifted up 1px (bob effect) — we reuse idle0 data
  // The renderer handles the 1px Y offset; frame data is identical
  return opusIdle0();
}

function opusAttack0() {
  // Windup — arm raised, staff pulled back
  const f = opusIdle0();
  // Shift staff column left by 2 to show pull-back
  // First save original staff pixels, then clear old column, then write new column
  for (let r = 14; r <= 27; r++) {
    const orig = f[r][26];
    f[r][26] = _;
    f[r][24] = orig !== _ ? orig : P.goldDk;
  }
  // Raise right arm
  f[14][24] = P.goldDk; f[13][24] = P.goldDk; f[12][24] = P.gold;
  f[15][7] = P.skin; f[14][6] = P.skin; f[13][5] = P.skin;
  return f;
}

function opusAttack1() {
  // Strike flash — bright burst at staff tip
  const f = opusIdle0();
  // Staff forward + flash
  const flash = P.gold;
  f[25][27] = flash; f[25][28] = flash; f[25][29] = flash;
  f[26][26] = P.red; f[26][27] = P.white; f[26][28] = P.white; f[26][29] = P.red;
  f[27][27] = flash; f[27][28] = flash; f[27][29] = flash;
  f[24][28] = flash; f[28][28] = flash;
  return f;
}

function opusAttack2() {
  return opusIdle0(); // return to idle
}

function opusVictory0() {
  // Jump — whole sprite shifted up 3 rows
  const base = opusIdle0();
  const f = base.map(r => [...r]);
  // Shift up by clearing bottom rows and moving data
  for (let r = 0; r < 29; r++) f[r] = r + 3 < 32 ? [...base[r + 3]] : new Array(32).fill(_);
  for (let r = 29; r < 32; r++) f[r] = new Array(32).fill(_);
  return f;
}

function opusVictory1() {
  // Arms up celebration
  const f = opusVictory0();
  f[9][6] = P.skin; f[8][5] = P.skin; f[7][4] = P.gold;
  f[9][19] = P.skin; f[8][20] = P.skin; f[7][21] = P.gold;
  return f;
}

function opusVictory2() {
  return opusIdle0(); // settle back
}

function opusDefeated0() {
  // Slump — sprite shifted down 2
  const base = opusIdle0();
  const f = [];
  for (let r = 0; r < 32; r++) {
    f[r] = r < 2 ? new Array(32).fill(_) : [...base[r - 2]];
  }
  // Tilt hat
  f[2][11] = P.purple; f[2][12] = _; f[2][16] = _;
  return f;
}

function opusDefeated1() {
  // Faded version — we'll handle alpha in renderer via globalAlpha
  return opusDefeated0();
}

function opusThinking0() {
  const f = opusIdle0();
  // Slight head tilt — shift head pixels right by 1
  const headRows = [6, 7, 8, 9, 10];
  for (const r of headRows) {
    for (let c = 17; c > 10; c--) f[r][c] = f[r][c - 1];
    f[r][10] = _;
  }
  return f;
}

function opusThinking1() {
  // Question mark particle above head
  const f = opusIdle0();
  f[0][19] = P.gold; f[0][20] = P.gold;
  f[1][21] = P.gold;
  f[2][20] = P.gold;
  f[3][20] = _;
  f[4][20] = P.gold;
  return f;
}

// --- 3. Haiku Rogue Sprite Frames (24x24) ---------------------------------

function haikuIdle0() {
  const c = P;
  return [
    /*  0 */ [_,_,_,_,_,_,_,_,_,c.gray,c.gray,c.gray,c.gray,c.gray,_,_,_,_,_,_,_,_,_,_],
    /*  1 */ [_,_,_,_,_,_,_,_,c.gray,c.grayDk,c.gray,c.gray,c.gray,c.grayDk,c.gray,_,_,_,_,_,_,_,_,_],
    /*  2 */ [_,_,_,_,_,_,_,c.gray,c.grayDk,c.gray,c.gray,c.gray,c.gray,c.gray,c.grayDk,c.gray,_,_,_,_,_,_,_,_],
    /*  3 */ [_,_,_,_,_,_,_,c.gray,c.gray,c.gray,c.gray,c.gray,c.gray,c.gray,c.gray,c.gray,_,_,_,_,_,_,_,_],
    /*  4 */ [_,_,_,_,_,_,_,_,c.skin,c.skin,c.skin,c.skin,c.skin,c.skin,c.skin,_,_,_,_,_,_,_,_,_],
    /*  5 */ [_,_,_,_,_,_,_,_,c.skin,c.emerald,c.pupil,c.skin,c.pupil,c.emerald,c.skin,_,_,_,_,_,_,_,_,_],
    /*  6 */ [_,_,_,_,_,_,_,_,_,c.skin,c.skin,c.skinSh,c.skin,c.skin,_,_,_,_,_,_,_,_,_,_],
    /*  7 */ [_,_,_,_,_,_,_,_,_,_,c.gray,c.gray,c.gray,_,_,_,_,_,_,_,_,_,_,_],
    /*  8 */ [_,_,_,_,_,_,_,c.gray,c.gray,c.emeraldDk,c.gray,c.gray,c.gray,c.emeraldDk,c.gray,c.gray,_,_,_,_,_,_,_,_],
    /*  9 */ [_,_,_,_,_,_,c.gray,c.grayDk,c.emeraldDk,c.emerald,c.gray,c.gray,c.gray,c.emerald,c.emeraldDk,c.grayDk,c.gray,_,_,_,_,_,_,_],
    /* 10 */ [_,_,_,_,_,c.skin,c.gray,c.gray,c.gray,c.emeraldDk,c.gray,c.gray,c.gray,c.emeraldDk,c.gray,c.gray,c.gray,c.skin,_,_,_,_,_,_],
    /* 11 */ [_,_,_,_,_,c.skin,_,c.gray,c.gray,c.gray,c.gray,c.grayDk,c.gray,c.gray,c.gray,c.gray,_,c.skin,_,_,_,_,_,_],
    /* 12 */ [_,_,_,_,_,_,_,c.gray,c.gray,c.gray,c.grayDk,c.grayDk,c.grayDk,c.gray,c.gray,c.gray,_,_,_,_,_,_,_,_],
    /* 13 */ [_,_,_,_,_,_,_,_,c.gray,c.gray,c.gray,c.gray,c.gray,c.gray,c.gray,_,_,_,_,_,_,_,_,_],
    /* 14 */ [_,_,_,_,_,_,_,_,c.gray,c.grayDk,c.gray,c.gray,c.gray,c.grayDk,c.gray,_,_,_,_,_,_,_,_,_],
    /* 15 */ [_,_,_,_,_,_,_,_,c.gray,c.gray,c.grayDk,_,c.grayDk,c.gray,c.gray,_,_,_,_,_,_,_,_,_],
    /* 16 */ [_,_,_,_,_,_,_,_,_,c.gray,c.gray,_,c.gray,c.gray,_,_,_,_,_,_,_,_,_,_],
    /* 17 */ [_,_,_,_,_,_,_,_,c.black,c.black,c.black,_,c.black,c.black,c.black,_,_,_,_,_,_,_,_,_],
    /* 18 */ [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    /* 19 */ [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    /* 20 */ [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    /* 21 */ [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    /* 22 */ [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    /* 23 */ [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
  ];
}

function haikuIdle1() {
  return haikuIdle0(); // bob handled by renderer Y offset
}

function haikuAttack0() {
  // Windup — arm with dagger drawn back
  const f = haikuIdle0();
  f[10][4] = P.skin; f[9][3] = P.silver; f[8][2] = P.silver; f[7][1] = P.silver;
  f[10][19] = P.skin; f[9][20] = P.silver;
  return f;
}

function haikuAttack1() {
  // Strike — daggers thrust forward + flash
  const f = haikuIdle0();
  f[10][3] = P.silver; f[10][2] = P.silver; f[10][1] = P.white;
  f[10][20] = P.silver; f[10][21] = P.silver; f[10][22] = P.white;
  f[9][1] = P.cyan; f[11][1] = P.cyan;
  f[9][22] = P.cyan; f[11][22] = P.cyan;
  return f;
}

function haikuAttack2() {
  return haikuIdle0();
}

function haikuVictory0() {
  // Jump up 2px
  const base = haikuIdle0();
  const f = [];
  for (let r = 0; r < 24; r++) {
    f[r] = r + 2 < 24 ? [...base[r + 2]] : new Array(24).fill(_);
  }
  return f;
}

function haikuVictory1() {
  const f = haikuVictory0();
  // Arms up
  f[6][4] = P.skin; f[5][3] = P.emerald;
  f[6][19] = P.skin; f[5][20] = P.emerald;
  return f;
}

function haikuVictory2() {
  return haikuIdle0();
}

function haikuDefeated0() {
  const base = haikuIdle0();
  const f = [];
  for (let r = 0; r < 24; r++) {
    f[r] = r < 2 ? new Array(24).fill(_) : [...base[r - 2]];
  }
  return f;
}

function haikuDefeated1() {
  return haikuDefeated0();
}

function haikuThinking0() {
  const f = haikuIdle0();
  // Head tilt left
  const headRows = [4, 5, 6];
  for (const r of headRows) {
    for (let c = 1; c < 16; c++) f[r][c - 1] = f[r][c];
    f[r][15] = _;
  }
  return f;
}

function haikuThinking1() {
  const f = haikuIdle0();
  // Question mark
  f[0][17] = P.cyan; f[0][18] = P.cyan;
  f[1][19] = P.cyan;
  f[2][18] = P.cyan;
  f[3][18] = _;
  f[4][18] = P.cyan;
  return f;
}

// --- 4. Sprite Registry ---------------------------------------------------

const SPRITES = {
  opus: {
    idle:     [opusIdle0, opusIdle1],
    attack:   [opusAttack0, opusAttack1, opusAttack2],
    victory:  [opusVictory0, opusVictory1, opusVictory2],
    defeated: [opusDefeated0, opusDefeated1],
    thinking: [opusThinking0, opusThinking1],
    size: 32,
  },
  haiku: {
    idle:     [haikuIdle0, haikuIdle1],
    attack:   [haikuAttack0, haikuAttack1, haikuAttack2],
    victory:  [haikuVictory0, haikuVictory1, haikuVictory2],
    defeated: [haikuDefeated0, haikuDefeated1],
    thinking: [haikuThinking0, haikuThinking1],
    size: 24,
  },
};

// Pre-render cache: keyed by "type:state:frame" -> ImageData
const _spriteCache = {};

function _getCacheKey(type, state, frame) {
  return `${type}:${state}:${frame}`;
}

function _buildSpriteImageData(ctx, type, state, frame) {
  const key = _getCacheKey(type, state, frame);
  if (_spriteCache[key]) return _spriteCache[key];

  const def = SPRITES[type];
  if (!def || !def[state] || !def[state][frame]) return null;

  const pixels = def[state][frame]();
  const size = def.size;
  const imageData = ctx.createImageData(size, size);
  const data = imageData.data;

  for (let y = 0; y < size; y++) {
    const row = pixels[y];
    if (!row) continue;
    for (let x = 0; x < size; x++) {
      const color = row[x];
      if (!color) continue;
      const idx = (y * size + x) * 4;
      const r = parseInt(color.slice(1, 3), 16);
      const g = parseInt(color.slice(3, 5), 16);
      const b = parseInt(color.slice(5, 7), 16);
      data[idx]     = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = 255;
    }
  }

  _spriteCache[key] = { imageData, size };
  return { imageData, size };
}

// --- 5. Sprite Renderer ---------------------------------------------------

function createSpriteRenderer(ctx) {
  // Offscreen canvas for scaling
  let _offscreen = null;
  let _offCtx = null;

  function _ensureOffscreen(w, h) {
    if (!_offscreen || _offscreen.width < w || _offscreen.height < h) {
      _offscreen = document.createElement('canvas');
      _offscreen.width = Math.max(w, 64);
      _offscreen.height = Math.max(h, 64);
      _offCtx = _offscreen.getContext('2d');
    }
    return _offCtx;
  }

  function draw(characterType, animationState, frameIndex, x, y, scale) {
    scale = scale || 3;
    const sprite = _buildSpriteImageData(ctx, characterType, animationState, frameIndex);
    if (!sprite) return;

    const { imageData, size } = sprite;

    // Apply idle bob: frame 1 gets -1px offset (in scaled coords)
    let yOffset = 0;
    if (animationState === 'idle' && frameIndex === 1) {
      yOffset = -scale;
    }

    // Defeated frame 1 draws at reduced opacity
    const prevAlpha = ctx.globalAlpha;
    if (animationState === 'defeated' && frameIndex === 1) {
      ctx.globalAlpha = 0.45;
    }

    // Put imageData onto offscreen, then drawImage scaled
    const oc = _ensureOffscreen(size, size);
    oc.clearRect(0, 0, size, size);
    oc.putImageData(imageData, 0, 0);

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(_offscreen, 0, 0, size, size, x, y + yOffset, size * scale, size * scale);
    ctx.globalAlpha = prevAlpha;
  }

  function drawWithParticles(characterType, animationState, frameIndex, x, y, scale, particles) {
    draw(characterType, animationState, frameIndex, x, y, scale);
    if (particles && typeof particles.draw === 'function') {
      particles.draw(ctx);
    }
  }

  return { draw, drawWithParticles };
}

// --- 6. Particle System ---------------------------------------------------

const PARTICLE_PRESETS = {
  spark: {
    colors: ['#f1c40f', '#f39c12', '#e94560', '#ff6b6b', '#ffffff'],
    sizeRange: [1.5, 4],
    speedRange: [40, 120],
    lifeRange: [0.4, 1.0],
  },
  data: {
    colors: ['#9b59b6', '#c39bd3', '#44ddff', '#22aacc', '#ffffff'],
    sizeRange: [1, 3],
    speedRange: [20, 70],
    lifeRange: [0.5, 1.2],
  },
  heal: {
    colors: ['#00ff88', '#00cc6a', '#44ddff', '#88ffbb', '#ffffff'],
    sizeRange: [1, 3.5],
    speedRange: [15, 50],
    lifeRange: [0.6, 1.4],
  },
};

function createParticleSystem() {
  let particles = [];

  function _rand(min, max) {
    return min + Math.random() * (max - min);
  }

  function emit(type, x, y, count) {
    const preset = PARTICLE_PRESETS[type];
    if (!preset) return;

    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = _rand(preset.speedRange[0], preset.speedRange[1]);
      const life = _rand(preset.lifeRange[0], preset.lifeRange[1]);

      particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - _rand(10, 40), // slight upward bias
        life,
        maxLife: life,
        color: preset.colors[Math.floor(Math.random() * preset.colors.length)],
        size: _rand(preset.sizeRange[0], preset.sizeRange[1]),
      });
    }
  }

  function update(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 60 * dt; // gravity
      p.life -= dt;
      if (p.life <= 0) {
        particles.splice(i, 1);
      }
    }
  }

  function draw(ctx) {
    for (const p of particles) {
      const alpha = Math.max(0, p.life / p.maxLife);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;

      // Draw as small square for pixel-art feel
      const s = p.size;
      ctx.fillRect(Math.round(p.x - s / 2), Math.round(p.y - s / 2), Math.ceil(s), Math.ceil(s));
    }
    ctx.globalAlpha = 1;
  }

  function clear() {
    particles = [];
  }

  function count() {
    return particles.length;
  }

  return { emit, update, draw, clear, count };
}

// --- 7. Animation Controller (bonus utility) ------------------------------

function createAnimationController() {
  const states = {};

  function set(id, animationState, options) {
    const opts = options || {};
    states[id] = {
      state: animationState,
      frame: 0,
      elapsed: 0,
      frameDuration: opts.frameDuration || 0.25, // seconds per frame
      loop: opts.loop !== undefined ? opts.loop : (animationState === 'idle' || animationState === 'thinking'),
      onComplete: opts.onComplete || null,
    };
  }

  function update(id, dt) {
    const s = states[id];
    if (!s) return;
    s.elapsed += dt;
    if (s.elapsed >= s.frameDuration) {
      s.elapsed -= s.frameDuration;
      const charType = id.startsWith('opus') ? 'opus' : 'haiku';
      const totalFrames = SPRITES[charType][s.state].length;
      s.frame++;
      if (s.frame >= totalFrames) {
        if (s.loop) {
          s.frame = 0;
        } else {
          s.frame = totalFrames - 1;
          if (s.onComplete) s.onComplete();
        }
      }
    }
  }

  function get(id) {
    return states[id] ? { state: states[id].state, frame: states[id].frame } : null;
  }

  return { set, update, get };
}

// --- 8. Exports (window global for inline script use) ---------------------

window.SpritesEngine = {
  createSpriteRenderer,
  createParticleSystem,
  createAnimationController,
  SPRITES,
  PARTICLE_PRESETS,
  PALETTE: P,
};
