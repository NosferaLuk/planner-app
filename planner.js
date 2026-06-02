// ============================================================
//  PLANEJADOR DE PRODUÇÃO MINECRAFT v2
//  Editor Visual de Fluxos com Contexto de Processo e Maquinário
// ============================================================

// ===== STATE =====
const state = {
  blocks: {},
  connections: [],
  groups: {},
  presets: JSON.parse(localStorage.getItem('planner_presets') || '{}'),
  constants: JSON.parse(localStorage.getItem('planner_constants') || '{"items":[]}'),
  selectedIds: [],
  highlightedIds: [],
  connectMode: false,
  connecting: null,
  reconnecting: null, // { connId, end: 'source'|'target' }
  dragging: null,
  panning: null,
  selectBox: null,
  view: { x: 0, y: 0, zoom: 1 },
  clipboard: null,
  filterText: '',
  showGrid: true,
  showMinimap: true,
  relayUrl: localStorage.getItem('planner_relay_url') || 'https://planner-relay.onrender.com',
};

// ===== UNDO/REDO =====
const history = { stack: [], index: -1, maxSize: 50 };
function pushHistory() {
  history.stack = history.stack.slice(0, history.index + 1);
  const snap = JSON.parse(JSON.stringify({
    blocks: state.blocks, connections: state.connections,
    groups: state.groups, _uid, _cid, _gid
  }));
  history.stack.push(snap);
  if (history.stack.length > history.maxSize) history.stack.shift();
  history.index = history.stack.length - 1;
}
function undo() {
  if (history.index > 0) {
    history.index--;
    applyHistory(history.stack[history.index]);
  }
}
function redo() {
  if (history.index < history.stack.length - 1) {
    history.index++;
    applyHistory(history.stack[history.index]);
  }
}
function applyHistory(snap) {
  state.blocks = snap.blocks;
  state.connections = snap.connections;
  state.groups = snap.groups;
  _uid = snap._uid || 1; _cid = snap._cid || 1; _gid = snap._gid || 1;
  state.selectedIds = [];
  render(); applyView();
}

// ===== CONSTANTS =====
const PROC_W = 120;
const PROC_H = 90;
const MACH_W = 180;
const MACH_H = 180;
const PORT_R = 8;
const GRID = 20;

const BLOCK_CONFIG = {
  input:  { bg: '#2ecc71', border: '#27ae60', dark: '#1a7a3a', icon: '⬇' },
  processing: { bg: '#3498db', border: '#2980b9', dark: '#1a5a8a', icon: '⚙' },
  output: { bg: '#e67e22', border: '#d35400', dark: '#8a4a00', icon: '⬆' },
  machinery: { bg: '#9b59b6', border: '#8e44ad', dark: '#5a2d7a', icon: '🏭' },
  note: { bg: '#fff3cd', border: '#ffc107', dark: '#856404', icon: '💬' },
};

const ITEM_TYPES = ['item', 'liquid', 'energy', 'other'];
const ITEM_TYPE_LABELS = { item: 'Item', liquid: 'Líquido', energy: 'Energia', other: 'Outro' };

// ===== DOM REFS =====
const $ = id => document.getElementById(id);
const canvas = $('canvas');
const connectionLayer = $('connection-layer');
const tempConnection = $('temp-connection');
const blockLayer = $('block-layer');
const groupLayer = $('group-layer');
const selectionBox = $('selection-box');
const statusText = $('status-text');
const statusCoords = $('status-coords');
const propsContent = $('props-popover-body');
const propsPopover = $('props-popover');
const canvasContainer = $('canvas-container');
const statsContent = $('stats-content');
const presetList = $('presetList');
const constantsList = $('constantsList');
const modal = $('modal');
const modalBody = $('modal-body');
const ctxMenu = $('context-menu');

// ===== UTILITY =====
let _uid = 1, _cid = 1, _gid = 1;
function uid() { return `b${_uid++}`; }
function cid() { return `c${_cid++}`; }
function gid() { return `g${_gid++}`; }

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function dist(x1, y1, x2, y2) { return Math.sqrt((x2-x1)**2 + (y2-y1)**2); }

function escHtml(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function makeItem(name, amount, itemType, category) {
  return { name: name || '?', amount: Math.max(1, amount || 1), itemType: itemType || 'item', category: category || 'primary' };
}

function snap(v) { return Math.round(v / GRID) * GRID; }

function normalizeItem(item) {
  if (typeof item === 'string') return makeItem(item, 1, 'item', 'primary');
  if (!item) return makeItem('?', 1, 'item', 'primary');
  return makeItem(item.name, item.amount || 1, item.itemType || 'item', item.category || 'primary');
}

function getCanvasPoint(e) {
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (canvas.viewBox.baseVal.width / rect.width);
  const y = (e.clientY - rect.top) * (canvas.viewBox.baseVal.height / rect.height);
  return { x: x - state.view.x, y: y - state.view.y };
}

const NOTE_W = 200;
const NOTE_H = 100;

function getBlockSize(b) {
  if (b.type === 'note') return { w: NOTE_W, h: NOTE_H };
  return b.type === 'machinery' ? { w: MACH_W, h: MACH_H } : { w: PROC_W, h: PROC_H };
}

function getPortPositions(b) {
  const size = getBlockSize(b);
  const w = size.w, h = size.h;
  const cx = b.x + w/2, cy = b.y + h/2;

  if (b.type === 'machinery') {
    // Machinery: dynamic ports per input/output item
    const ports = {};
    const inputs = b.consumes || [];
    const outputs = b.generates || [];
    const inCount = inputs.length;
    const outCount = outputs.length;
    const inSpacing = inCount > 0 ? (h - 50) / (inCount + 1) : 0;
    const outSpacing = outCount > 0 ? (h - 50) / (outCount + 1) : 0;

    inputs.forEach((item, i) => {
      const py = b.y + 40 + inSpacing * (i + 1);
      ports[`in-${i}`] = { x: b.x, y: py, item, type: 'input', index: i };
    });
    outputs.forEach((item, i) => {
      const py = b.y + 40 + outSpacing * (i + 1);
      ports[`out-${i}`] = { x: b.x + w, y: py, item, type: 'output', index: i };
    });
    // Also add top/bottom for general connections
    ports['top'] = { x: cx, y: b.y, item: null, type: 'general' };
    ports['bottom'] = { x: cx, y: b.y + h, item: null, type: 'general' };
    return ports;
  }

  // Process blocks: 4 edge ports
  return {
    top:    { x: cx, y: b.y, item: null },
    bottom: { x: cx, y: b.y + h, item: null },
    left:   { x: b.x, y: cy, item: null },
    right:  { x: b.x + w, y: cy, item: null },
  };
}

function getPortPosition(b, port) {
  const ports = getPortPositions(b);
  return ports[port] || { x: b.x + b.w/2, y: b.y + b.h/2 };
}

function getConnectionPath(sourcePos, targetPos, sourcePort, targetPort) {
  const OFFSET = 12;

  // Desloca ponto para FORA da borda do bloco (na direção que a porta aponta)
  function shift(port) {
    if (port === 'top') return { x: 0, y: -OFFSET };
    if (port === 'bottom') return { x: 0, y: OFFSET };
    if (/^(right|out-\d+)$/.test(port || '')) return { x: OFFSET, y: 0 };
    if (/^(left|in-\d+)$/.test(port || '')) return { x: -OFFSET, y: 0 };
    return { x: 0, y: 0 };
  }

  const so = shift(sourcePort);
  const to = shift(targetPort);
  const sx = sourcePos.x + so.x, sy = sourcePos.y + so.y;
  const tx = targetPos.x + to.x, ty = targetPos.y + to.y;
  const dx = tx - sx, dy = ty - sy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1) return `M ${sx} ${sy} L ${tx} ${ty}`;

  // Vetor direção de cada porta (para ONDE a porta aponta, saindo do bloco)
  function portDir(port) {
    if (port === 'bottom') return { x: 0, y: 1 };
    if (port === 'top') return { x: 0, y: -1 };
    if (/^(right|out-\d+)$/.test(port || '')) return { x: 1, y: 0 };
    if (/^(left|in-\d+)$/.test(port || '')) return { x: -1, y: 0 };
    return { x: 0, y: 0 };
  }

  const sd = portDir(sourcePort);
  const td = portDir(targetPort);

  // Distância que o controle se estende na direção da porta
  const ctrlLen = Math.max(40, dist * 0.45);

  // Control points:
  // CP1 vai na direção da porta de origem (tangente = portDir source)
  // CP2 vem da direção oposta à porta de destino (tangente = portDir target)
  const cx1 = sx + sd.x * ctrlLen;
  const cy1 = sy + sd.y * ctrlLen;
  const cx2 = tx + td.x * ctrlLen;
  const cy2 = ty + td.y * ctrlLen;

  return `M ${sx} ${sy} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${tx} ${ty}`;
}

function findPortAt(x, y, threshold) {
  threshold = threshold || 16;
  for (const b of Object.values(state.blocks)) {
    const ports = getPortPositions(b);
    for (const [name, pos] of Object.entries(ports)) {
      if (dist(x, y, pos.x, pos.y) <= threshold) return { block: b, port: name, pos };
    }
  }
  return null;
}

function isSelected(id) { return state.selectedIds.includes(id); }

// ===== SVG HELPERS =====
function createSVG(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  return el;
}

// ===== RENDER =====
function render() {
  renderBlocks();
  renderConnections();
  renderGroups();
  renderTemplates();
  renderPresets();
  renderConstants();
  renderStats();
  renderMinimap();
  scheduleCollabSync();
}

function renderBlocks() {
  blockLayer.replaceChildren();

  const frag = document.createDocumentFragment();
  const ft = state.filterText;
  for (const b of Object.values(state.blocks)) {
    const hidden = ft && !b.name.toLowerCase().includes(ft);
    const g = createSVG('g', {
      class: 'block-group' + (isSelected(b.id) ? ' selected' : '') + (state.highlightedIds.includes(b.id) ? ' highlighted' : ''),
      'data-id': b.id,
    });
    if (hidden) g.setAttribute('opacity', '0.2');
    g.style.cursor = 'grab';

    const size = getBlockSize(b);
    const w = size.w, h = size.h;
    const cfg = BLOCK_CONFIG[b.type] || BLOCK_CONFIG.processing;

    if (b.type === 'note') {
      renderNoteBlock(g, b, w, h, cfg);
    } else if (b.type === 'machinery') {
      renderMachineryBlock(g, b, w, h, cfg);
    } else {
      renderProcessBlock(g, b, w, h, cfg);
    }
    frag.appendChild(g);
  }
  blockLayer.appendChild(frag);
}

function renderProcessBlock(g, b, w, h, cfg) {
  const rect = createSVG('rect', {
    class: 'block-rect',
    x: b.x, y: b.y, width: w, height: h,
    fill: cfg.bg, stroke: cfg.border, rx: 4, ry: 4,
  });
  g.appendChild(rect);

  if (b.locked) {
    const lockIcon = createSVG('text', {
      x: b.x + w - 4, y: b.y + 5, 'font-size': '8',
      fill: 'rgba(255,255,255,0.7)', 'text-anchor': 'end',
    });
    lockIcon.textContent = '🔒';
    g.appendChild(lockIcon);
  }

  const title = createSVG('text', {
    class: 'block-text',
    x: b.x + w/2, y: b.y + 16, 'font-size': '11',
  });
  title.textContent = b.name || '?';
  g.appendChild(title);

  const typeLabel = createSVG('text', {
    x: b.x + w/2, y: b.y + h - 8, 'font-size': '8',
    fill: 'rgba(255,255,255,0.4)', 'text-anchor': 'middle', 'dominant-baseline': 'central',
  });
  typeLabel.textContent = cfg.icon + ' ' + (b.type === 'input' ? 'FONTE' : b.type === 'output' ? 'DESTINO' : 'MÁQUINA');
  g.appendChild(typeLabel);

  // Items inside (with colored dots)
  const typeColors = { item: '#2ecc71', liquid: '#3498db', energy: '#f39c12', other: '#95a5a6' };
  const allItems = [];
  for (const item of (b.consumes || [])) allItems.push({ ...item, dir: '↓' });
  for (const item of (b.generates || [])) allItems.push({ ...item, dir: '↑' });
  if (allItems.length > 0) {
    const maxShow = Math.min(allItems.length, 4);
    const startY = b.y + (h - (maxShow * 16)) / 2 + 12;
    for (let i = 0; i < maxShow; i++) {
      const item = allItems[i];
      const iy = startY + i * 16;
      // Type badge instead of colored dot
      const badge = createItemBadge(b, item, iy);
      g.appendChild(badge);
      const txt = createSVG('text', {
        x: b.x + 26, y: iy + 1, 'font-size': '9', fill: '#fff',
        'dominant-baseline': 'central',
      });
      txt.textContent = `${item.dir} ${item.name}${item.amount > 1 ? ' x'+item.amount : ''}`;
      g.appendChild(txt);
    }
    if (allItems.length > maxShow) {
      const more = createSVG('text', {
        'font-size': '7', fill: 'rgba(255,255,255,0.5)',
        x: b.x + w/2, y: b.y + h - 10, 'text-anchor': 'middle',
      });
      more.textContent = `+${allItems.length - maxShow} mais`;
      g.appendChild(more);
    }
  }

  // Ports for process blocks
  for (const port of ['top', 'bottom', 'left', 'right']) {
    const pp = getPortPosition(b, port);
    const circle = createSVG('circle', {
      class: 'block-port', cx: pp.x, cy: pp.y, r: PORT_R,
      'data-block-id': b.id, 'data-port': port,
    });
    g.appendChild(circle);
  }
}

function renderMachineryBlock(g, b, w, h, cfg) {
  const rect = createSVG('rect', {
    class: 'block-rect machinery',
    x: b.x, y: b.y, width: w, height: h,
    fill: cfg.bg, stroke: cfg.border, rx: 6, ry: 6, 'stroke-width': 2.5,
  });
  g.appendChild(rect);

  if (b.locked) {
    const lockI = createSVG('text', {
      x: b.x + w - 8, y: b.y + 10, 'font-size': '10',
      fill: 'rgba(255,255,255,0.7)', 'text-anchor': 'end',
    });
    lockI.textContent = '🔒';
    g.appendChild(lockI);
  }

  // Title
  const title = createSVG('text', {
    class: 'block-text', 'font-size': '13',
    x: b.x + w/2, y: b.y + 18,
  });
  title.textContent = '🏭 ' + (b.name || 'Fábrica');
  g.appendChild(title);

  // Inputs label
  const inLabel = createSVG('text', {
    x: b.x + 6, y: b.y + 35, 'font-size': '8',
    fill: 'rgba(255,255,255,0.5)', 'font-weight': '700',
  });
  inLabel.textContent = 'CONSOME';
  g.appendChild(inLabel);

  // Outputs label
  const outLabel = createSVG('text', {
    x: b.x + w - 6, y: b.y + 35, 'font-size': '8',
    fill: 'rgba(255,255,255,0.5)', 'font-weight': '700',
    'text-anchor': 'end',
  });
  outLabel.textContent = 'PRODUZ';
  g.appendChild(outLabel);

  const inputs = b.consumes || [];
  const outputs = b.generates || [];
  const inSpacing = inputs.length > 0 ? (h - 50) / (inputs.length + 1) : 0;
  const outSpacing = outputs.length > 0 ? (h - 50) / (outputs.length + 1) : 0;

  // Render input items on left
  inputs.forEach((item, i) => {
    const py = b.y + 40 + inSpacing * (i + 1);

    // Badge instead of dot
    const badgeG = createItemBadge(b, item, py);
    g.appendChild(badgeG);

    const txt = createSVG('text', {
      x: b.x + 28, y: py + 1, 'font-size': '9',
      fill: '#fff', 'dominant-baseline': 'central',
    });
    txt.textContent = item.name + (item.amount > 1 ? ' x' + item.amount : '');
    g.appendChild(txt);

    if (item.category === 'secondary') {
      const sec = createSVG('text', {
        x: b.x + 28, y: py + 11, 'font-size': '6',
        fill: 'rgba(255,255,255,0.4)', 'dominant-baseline': 'central',
      });
      sec.textContent = 'secundário';
      g.appendChild(sec);
    }

    // Port
    const circle = createSVG('circle', {
      class: 'block-port', cx: b.x, cy: py, r: PORT_R + 1,
      'data-block-id': b.id, 'data-port': `in-${i}`,
    });
    g.appendChild(circle);
  });

  // Render output items on right
  outputs.forEach((item, i) => {
    const py = b.y + 40 + outSpacing * (i + 1);

    // Badge on right side
    const badgeG = createItemBadge(b, item, py, b.x + w - 24);
    g.appendChild(badgeG);

    const txt = createSVG('text', {
      x: b.x + w - 8, y: py + 1, 'font-size': '9',
      fill: '#fff', 'text-anchor': 'end', 'dominant-baseline': 'central',
    });
    txt.textContent = item.name + (item.amount > 1 ? ' x' + item.amount : '');
    g.appendChild(txt);

    if (item.category === 'secondary') {
      const sec = createSVG('text', {
        x: b.x + w - 8, y: py + 11, 'font-size': '6',
        fill: 'rgba(255,255,255,0.4)', 'text-anchor': 'end', 'dominant-baseline': 'central',
      });
      sec.textContent = 'secundário';
      g.appendChild(sec);
    }

    const circle = createSVG('circle', {
      class: 'block-port', cx: b.x + w, cy: py, r: PORT_R + 1,
      'data-block-id': b.id, 'data-port': `out-${i}`,
    });
    g.appendChild(circle);
  });

  // Top/bottom ports for chaining
  const topPos = getPortPosition(b, 'top');
  const botPos = getPortPosition(b, 'bottom');
  for (const pp of [topPos, botPos]) {
    const circle = createSVG('circle', {
      class: 'block-port', cx: pp.x, cy: pp.y, r: PORT_R,
      'data-block-id': b.id, 'data-port': pp === topPos ? 'top' : 'bottom',
    });
    g.appendChild(circle);
  }
}

function renderNoteBlock(g, b, w, h, cfg) {
  // Shadow effect for sticky note
  const shadow = createSVG('rect', {
    x: b.x + 3, y: b.y + 3, width: w, height: h,
    fill: 'rgba(0,0,0,0.08)', rx: 2, ry: 2,
  });
  g.appendChild(shadow);

  const rect = createSVG('rect', {
    class: 'block-rect note-rect',
    x: b.x, y: b.y, width: w, height: h,
    fill: cfg.bg, stroke: cfg.border, rx: 2, ry: 2,
    'stroke-width': 1.5,
  });
  g.appendChild(rect);

  // Folded corner
  const fold = createSVG('path', {
    d: `M${b.x + w - 15} ${b.y}h15v15z`,
    fill: 'rgba(0,0,0,0.04)',
    stroke: cfg.border, 'stroke-width': 0.5,
  });
  g.appendChild(fold);

  const foldLine = createSVG('line', {
    x1: b.x + w - 15, y1: b.y, x2: b.x + w, y2: b.y + 15,
    stroke: cfg.border, 'stroke-width': 0.5, opacity: 0.4,
  });
  g.appendChild(foldLine);

  // Pin icon
  const pin = createSVG('text', {
    x: b.x + w - 12, y: b.y + 12, 'font-size': '10',
    fill: cfg.dark, 'text-anchor': 'middle', 'dominant-baseline': 'central',
  });
  pin.textContent = b.locked ? '🔒' : '📌';
  g.appendChild(pin);

  // Note text (truncate to fit)
  const maxChars = Math.floor(w / 7) * Math.floor((h - 20) / 13);
  const text = (b.name || 'Nova nota').length > maxChars
    ? (b.name || 'Nova nota').slice(0, maxChars - 3) + '...'
    : (b.name || 'Nova nota');
  const lines = wrapText(text, Math.floor(w / 7));

  lines.forEach((line, i) => {
    const t = createSVG('text', {
      x: b.x + 10, y: b.y + 18 + i * 14, 'font-size': '11',
      fill: cfg.dark, 'font-family': 'sans-serif',
      'dominant-baseline': 'central',
    });
    t.textContent = line;
    g.appendChild(t);
  });
}

function wrapText(str, maxLen) {
  if (!str) return [''];
  const words = str.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxLen) { lines.push(cur.trim()); cur = w; }
    else { cur += (cur ? ' ' : '') + w; }
  }
  if (cur.trim()) lines.push(cur.trim());
  if (lines.length === 0) lines.push('');
  return lines;
}

function renderConnections() {
  connectionLayer.replaceChildren();
  const frag = document.createDocumentFragment();
  const placedLabels = [];

  for (const conn of state.connections) {
    const sourceB = state.blocks[conn.sourceId];
    const targetB = state.blocks[conn.targetId];
    if (!sourceB || !targetB) continue;

    const sp = getPortPosition(sourceB, conn.sourcePort);
    const tp = getPortPosition(targetB, conn.targetPort);
    const pathD = getConnectionPath(sp, tp, conn.sourcePort, conn.targetPort);

    const g = createSVG('g', { 'data-conn-id': conn.id });

    const path = createSVG('path', {
      class: 'connection-path' + (isSelected(conn.id) ? ' selected' : ''),
      d: pathD, 'data-id': conn.id,
    });
    g.appendChild(path);

    // Invisible wider path for easier clicking
    const hit = createSVG('path', {
      class: 'connection-hit',
      d: pathD, 'data-id': conn.id,
    });
    g.appendChild(hit);

    // Draggable source handle
    const srcH = createSVG('circle', {
      class: 'conn-handle conn-handle-src',
      cx: sp.x, cy: sp.y, r: 8,
      'data-conn-id': conn.id, 'data-end': 'source',
    });
    g.appendChild(srcH);

    // Draggable target handle
    const tgtH = createSVG('circle', {
      class: 'conn-handle conn-handle-tgt',
      cx: tp.x, cy: tp.y, r: 8,
      'data-conn-id': conn.id, 'data-end': 'target',
    });
    g.appendChild(tgtH);

    if (conn.label) {
      let lx = (sp.x + tp.x) / 2, ly = (sp.y + tp.y) / 2 - 10;
      try {
        const len = path.getTotalLength();
        if (len > 0) {
          const mid = path.getPointAtLength(len / 2);
          lx = mid.x; ly = mid.y - 12;
        }
      } catch(e) { /* skip */ }
      const textW = conn.label.length * 7 + 12;
      const textH = 16;
      // Try positions in order: top, bottom, left, right, then diagonal shifts
      const offsets = [
        [0, -textH], [0, textH], [-textW/2 - 8, 0], [textW/2 + 8, 0],
        [-textW/2 - 8, -textH], [textW/2 + 8, -textH],
        [-textW/2 - 8, textH], [textW/2 + 8, textH],
        [0, -textH * 2], [0, textH * 2],
      ];
      let bestOff = offsets[0];
      let bestScore = Infinity;
      for (const off of offsets) {
        const cx = lx + off[0], cy = ly + off[1];
        let score = Math.abs(off[0]) + Math.abs(off[1]) * 2;
        for (const placed of placedLabels) {
          const dx = Math.abs(cx - placed.x);
          const dy = Math.abs(cy - placed.y);
          if (dx < (textW + placed.w) / 2 + 4 && dy < (textH + placed.h) / 2 + 4) {
            score += 1000;
          }
        }
        if (score < bestScore) { bestScore = score; bestOff = off; }
      }
      lx += bestOff[0]; ly += bestOff[1];
      placedLabels.push({ x: lx, y: ly, w: textW, h: textH });
      const label = createSVG('text', {
        class: 'connection-label', x: lx, y: ly,
        'data-id': conn.id,
        style: 'cursor:pointer',
      });
      label.textContent = conn.label;
      g.appendChild(label);
    }

    frag.appendChild(g);
  }

  connectionLayer.appendChild(frag);
}

// Item type badge SVG element
const TYPE_BADGES = {
  item:   { letter: 'I', bg: '#10b981', fg: '#d1fae5' },
  liquid: { letter: 'L', bg: '#3b82f6', fg: '#dbeafe' },
  energy: { letter: 'E', bg: '#f59e0b', fg: '#fef3c7' },
  other:  { letter: 'O', bg: '#8b5cf6', fg: '#ede9fe' },
};

function createItemBadge(b, item, y, x) {
  const cfg = TYPE_BADGES[item.itemType] || TYPE_BADGES.other;
  const bw = 16;
  const bx = x !== undefined ? x : b.x + 6;
  // Background rect
  const rect = createSVG('rect', {
    x: bx, y: y - 7, width: bw, height: 14, rx: 3, ry: 3,
    fill: cfg.bg,
  });
  const txt = createSVG('text', {
    x: bx + bw/2, y: y + 1,
    'font-size': '9', 'font-weight': '700',
    fill: cfg.fg, 'text-anchor': 'middle', 'dominant-baseline': 'central',
  });
  txt.textContent = cfg.letter;
  const g = document.createDocumentFragment();
  g.appendChild(rect);
  g.appendChild(txt);
  return g;
}

function renderGroups() {
  groupLayer.replaceChildren();

  for (const g of Object.values(state.groups)) {
    const blocks = g.blocks.map(id => state.blocks[id]).filter(Boolean);
    if (blocks.length === 0) continue;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of blocks) {
      const size = getBlockSize(b);
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + size.w);
      maxY = Math.max(maxY, b.y + size.h);
    }
    const pad = 16;
    const gg = createSVG('g', { 'data-group-id': g.id });
    const gr = createSVG('rect', {
      class: 'group-rect',
      x: minX - pad, y: minY - pad - 14,
      width: maxX - minX + pad * 2,
      height: maxY - minY + pad * 2 + 14,
    });
    gg.appendChild(gr);
    const gl = createSVG('text', {
      class: 'group-label',
      x: minX - pad + 6, y: minY - pad - 2,
      style: 'cursor:pointer',
    });
    gl.textContent = `🏭 ${g.name}`;
    gl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      showModal('Renomear Grupo', `
        <div class="form-group"><label>Nome</label><input type="text" id="dlg-rename" value="${escHtml(g.name)}"></div>
        <div class="form-actions">
          <button class="btn-secondary" onclick="hideModal()">Cancelar</button>
          <button class="btn-primary" id="dlg-rename-confirm">Renomear</button>
        </div>
      `);
      document.getElementById('dlg-rename-confirm').addEventListener('click', () => {
        const name = document.getElementById('dlg-rename').value.trim();
        if (name) { pushHistory(); g.name = name; render(); }
        hideModal();
      }, { once: true });
      setTimeout(() => document.getElementById('dlg-rename')?.focus(), 100);
    });
    gg.appendChild(gl);
    groupLayer.appendChild(gg);
  }
}

function renderPresets() {
  presetList.replaceChildren();

  const keys = Object.keys(state.presets);
  if (keys.length === 0) {
    const p = document.createElement('p'); p.className = 'hint';
    p.textContent = 'Nenhum preset salvo.';
    presetList.appendChild(p);
    return;
  }

  for (const id of keys) {
    const preset = state.presets[id];
    const card = document.createElement('div');
    card.className = 'preset-card';

    const nameDiv = document.createElement('div');
    nameDiv.className = 'preset-name';
    nameDiv.textContent = preset.name;
    card.appendChild(nameDiv);

    if (preset.description) {
      const infoDiv = document.createElement('div');
      infoDiv.className = 'preset-info';
      infoDiv.textContent = preset.description;
      card.appendChild(infoDiv);
    }

    const infoDiv = document.createElement('div');
    infoDiv.className = 'preset-info';
    infoDiv.textContent = `${Object.keys(preset.data.blocks || {}).length} bloco(s)`;
    card.appendChild(infoDiv);

    const actions = document.createElement('div');
    actions.className = 'preset-actions';

    const btnUse = document.createElement('button');
    btnUse.textContent = 'Usar';
    btnUse.addEventListener('click', (e) => { e.stopPropagation(); usePreset(id); });
    actions.appendChild(btnUse);

    const btnDel = document.createElement('button');
    btnDel.textContent = 'Excluir';
    btnDel.addEventListener('click', (e) => { e.stopPropagation(); deletePreset(id); });
    actions.appendChild(btnDel);

    card.appendChild(actions);
    card.addEventListener('dblclick', () => usePreset(id));
    presetList.appendChild(card);
  }
}

function renderConstants() {
  syncAutocompleteDatalist();
  constantsList.replaceChildren();

  const items = state.constants.items || [];
  if (items.length === 0) {
    const p = document.createElement('p'); p.className = 'hint';
    p.textContent = 'Nenhum item constante.';
    constantsList.appendChild(p);
    return;
  }

  const typeIcons = { item: '📦', liquid: '💧', energy: '⚡', other: '🔮' };

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const div = document.createElement('div');
    div.className = 'const-item';

    const icon = document.createElement('span');
    icon.className = 'const-icon';
    icon.textContent = typeIcons[item.itemType] || '📦';
    div.appendChild(icon);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'const-name';
    nameSpan.textContent = item.name;
    div.appendChild(nameSpan);

    const typeSpan = document.createElement('span');
    typeSpan.className = 'const-type';
    typeSpan.textContent = ITEM_TYPE_LABELS[item.itemType] || 'Item';
    div.appendChild(typeSpan);

    const delBtn = document.createElement('button');
    delBtn.className = 'const-del';
    delBtn.textContent = '×';
    delBtn.addEventListener('click', () => {
      state.constants.items.splice(i, 1);
      saveConstants();
      renderConstants();
      setStatus(`"${item.name}" removido das constantes`);
    });
    div.appendChild(delBtn);

    div.addEventListener('dblclick', () => editConstant(i));
    constantsList.appendChild(div);
  }
}

// ===== MINIMAP =====
function renderMinimap() {
  const container = document.getElementById('minimap-canvas');
  if (!container) return;
  container.innerHTML = '';
  const blocks = Object.values(state.blocks);
  if (blocks.length === 0) return;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of blocks) {
    const s = getBlockSize(b);
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + s.w); maxY = Math.max(maxY, b.y + s.h);
  }
  const pad = 40;
  const areaW = (maxX - minX) + pad * 2;
  const areaH = (maxY - minY) + pad * 2;
  const scaleX = 140 / areaW;
  const scaleY = 100 / areaH;
  const scale = Math.min(scaleX, scaleY, 1);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute('viewBox', `0 0 ${areaW} ${areaH}`);
  svg.style.width = '100%';
  svg.style.height = '100%';

  // Background
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('width', areaW); bg.setAttribute('height', areaH);
  bg.setAttribute('fill', '#1a1a2e');
  svg.appendChild(bg);

  // Blocks
  const cfgMap = { input: '#2ecc71', processing: '#3498db', output: '#e67e22', machinery: '#9b59b6' };
  for (const b of blocks) {
    const s = getBlockSize(b);
    const rx = b.x - minX + pad;
    const ry = b.y - minY + pad;
    const rw = s.w; const rh = s.h;
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', rx); rect.setAttribute('y', ry);
    rect.setAttribute('width', rw); rect.setAttribute('height', rh);
    rect.setAttribute('fill', cfgMap[b.type] || '#3498db');
    rect.setAttribute('rx', 3); rect.setAttribute('ry', 3);
    svg.appendChild(rect);
  }

  // Viewport
  const vx = -state.view.x - minX + pad;
  const vy = -state.view.y - minY + pad;
  const vw = canvas.clientWidth / state.view.zoom;
  const vh = canvas.clientHeight / state.view.zoom;
  const vp = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  vp.setAttribute('x', vx); vp.setAttribute('y', vy);
  vp.setAttribute('width', vw); vp.setAttribute('height', vh);
  vp.setAttribute('fill', 'rgba(233,69,96,0.1)');
  vp.setAttribute('stroke', '#e94560');
  vp.setAttribute('stroke-width', 2);
  vp.setAttribute('rx', 2);
  svg.appendChild(vp);

  container.appendChild(svg);
}

function renderStats() {
  const allConsumes = {};
  const allGenerates = {};
  const itemBlocks = {};
  let hasTicks = false;
  let totalTicks = 0;

  for (const b of Object.values(state.blocks)) {
    if (b.ticks > 0) { hasTicks = true; totalTicks += b.ticks; }
    for (const item of (b.consumes || [])) {
      const n = item.name;
      allConsumes[n] = (allConsumes[n] || 0) + (item.amount || 1);
      if (!itemBlocks[n]) itemBlocks[n] = [];
      if (!itemBlocks[n].includes(b.id)) itemBlocks[n].push(b.id);
    }
    for (const item of (b.generates || [])) {
      const n = item.name;
      allGenerates[n] = (allGenerates[n] || 0) + (item.amount || 1);
      if (!itemBlocks[n]) itemBlocks[n] = [];
      if (!itemBlocks[n].includes(b.id)) itemBlocks[n].push(b.id);
    }
  }

  let html = '';
  const allItems = new Set([...Object.keys(allConsumes), ...Object.keys(allGenerates)]);
  if (allItems.size === 0) {
    html = '<p class="hint">Adicione itens para ver o balanço.</p>';
  } else {
    html = '<div class="stats-summary">';
    for (const item of allItems) {
      const consumed = allConsumes[item] || 0;
      const generated = allGenerates[item] || 0;
      const balance = generated - consumed;
      const cls = balance > 0 ? 'positive' : balance < 0 ? 'negative' : 'neutral';
      const sign = balance > 0 ? '+' : '';
      const ids = (itemBlocks[item] || []).join(',');
      let line = `<span>${escHtml(item)}</span><span>${consumed} → ${generated} (${sign}${balance})`;
      if (hasTicks && totalTicks > 0) {
        line += ` | ${((consumed + generated) / (totalTicks / 20)).toFixed(1)}/s`;
      }
      line += '</span>';
      html += `<div class="stats-row ${cls}" data-item="${escHtml(item)}" data-ids="${ids}" style="cursor:pointer">${line}</div>`;
    }
    html += '</div>';
  }

  const onlyConsumed = Object.keys(allConsumes).filter(n => !allGenerates[n]);
  const onlyGenerated = Object.keys(allGenerates).filter(n => !allConsumes[n]);
  if (onlyConsumed.length > 0) {
    html += `<p style="font-size:10px;color:#e74c3c;margin-top:6px">⚠ Sem fonte: ${onlyConsumed.map(escHtml).join(', ')}</p>`;
  }
  if (onlyGenerated.length > 0) {
    html += `<p style="font-size:10px;color:#f39c12;margin-top:3px">📤 Excedente: ${onlyGenerated.map(escHtml).join(', ')}</p>`;
  }
  if (Object.keys(state.blocks).length > 1 && detectCycles()) {
    html += `<p style="font-size:10px;color:#e74c3c;margin-top:6px">🔄 Loop detectado! Conexões formam ciclo.</p>`;
  }

  statsContent.innerHTML = html;

  // Click on stats row → highlight blocks
  statsContent.querySelectorAll('.stats-row').forEach(row => {
    row.addEventListener('click', () => {
      const ids = (row.dataset.ids || '').split(',');
      state.highlightedIds = ids.filter(Boolean);
      render();
      if (ids.length > 0) {
        setStatus(`Destacando ${ids.length} bloco(s) com "${row.dataset.item}"`);
      }
    });
  });
}

// ===== CONTEXT MENU =====
function showContextMenu(items, x, y) {
  ctxMenu.innerHTML = '';
  ctxMenu.style.left = x + 'px';
  ctxMenu.style.top = y + 'px';
  ctxMenu.classList.remove('hidden');
  // Clamp to viewport
  requestAnimationFrame(() => {
    const r = ctxMenu.getBoundingClientRect();
    if (r.right > window.innerWidth) ctxMenu.style.left = (x - r.width) + 'px';
    if (r.bottom > window.innerHeight) ctxMenu.style.top = (y - r.height) + 'px';
    // Re-check after horizontal flip
    const r2 = ctxMenu.getBoundingClientRect();
    if (r2.bottom > window.innerHeight) ctxMenu.style.top = Math.max(0, window.innerHeight - r2.height - 4) + 'px';
  });

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'ctx-separator';
      ctxMenu.appendChild(sep);
      continue;
    }
    const el = document.createElement('div');
    el.className = 'ctx-item' + (item.disabled ? ' disabled' : '');
    // Only static HTML icons are in the label; dynamic names are pre-escaped via escHtml()
    el.textContent = item.label;
    if (!item.disabled) {
      el.addEventListener('click', () => { hideContextMenu(); item.action(); });
    }
    ctxMenu.appendChild(el);
  }
}

function hideContextMenu() {
  ctxMenu.classList.add('hidden');
}

document.addEventListener('click', (e) => {
  if (!ctxMenu.contains(e.target)) hideContextMenu();
  const qc = $('quick-create-menu');
  if (!qc.contains(e.target) && !qc.classList.contains('hidden')) {
    // Don't auto-dismiss immediately after showing (pointerup → click sequence)
    const elapsed = Date.now() - (_quickCreateShownAt || 0);
    if (elapsed > 200) hideQuickCreateMenu();
  }
});

// ===== BLOCKS =====
function createBlock(name, type, consumes, generates) {
  const id = uid();
  const centerX = Math.max(50, (canvas.clientWidth / 2) / state.view.zoom - PROC_W / 2);
  const centerY = Math.max(50, (canvas.clientHeight / 2) / state.view.zoom - PROC_H / 2);
  const size = getBlockSize({ type: type || 'processing' });

  const b = {
    id, name: name || 'Novo Bloco',
    type: type || 'processing',
    x: centerX - state.view.x,
    y: centerY - state.view.y,
    w: size.w, h: size.h,
    consumes: (consumes || []).map(normalizeItem),
    generates: (generates || []).map(normalizeItem),
    ticks: 0,
    locked: false,
  };
  state.blocks[id] = b;
  clearSelection();
  state.selectedIds.push(id);
  render();
  showPropsForBlock(id);
  setStatus(`Bloco "${b.name}" criado`);
  return b;
}

function alignBlocks(ids, dir) {
  const blocks = ids.map(id => state.blocks[id]).filter(Boolean);
  if (blocks.length < 2) return;
  const sizes = blocks.map(b => getBlockSize(b));
  if (dir === 'left') { const v = snap(Math.min(...blocks.map(b => b.x))); blocks.forEach(b => { b.x = v; }); }
  else if (dir === 'right') { const v = snap(Math.max(...blocks.map((b,i) => b.x + sizes[i].w))); blocks.forEach((b,i) => { b.x = v - sizes[i].w; }); }
  else if (dir === 'top') { const v = snap(Math.min(...blocks.map(b => b.y))); blocks.forEach(b => { b.y = v; }); }
  else if (dir === 'bottom') { const v = snap(Math.max(...blocks.map((b,i) => b.y + sizes[i].h))); blocks.forEach((b,i) => { b.y = v - sizes[i].h; }); }
  else if (dir === 'center-h') { const v = snap(blocks.reduce((s,b,i) => s + b.x + sizes[i].w/2, 0) / blocks.length); blocks.forEach((b,i) => { b.x = v - sizes[i].w/2; }); }
  else if (dir === 'center-v') { const v = snap(blocks.reduce((s,b,i) => s + b.y + sizes[i].h/2, 0) / blocks.length); blocks.forEach((b,i) => { b.y = v - sizes[i].h/2; }); }
  else if (dir === 'distribute-h') {
    const sorted = [...blocks].sort((a,b) => a.x - b.x);
    const totalW = sizes.reduce((s,sz,i) => s + sz.w, 0);
    const gap = snap((sorted[sorted.length-1].x + sizes[blocks.indexOf(sorted[sorted.length-1])].w - sorted[0].x - totalW) / (sorted.length - 1));
    let cx = sorted[0].x;
    for (const b of sorted) { b.x = snap(cx); cx += getBlockSize(b).w + gap; }
  }
  else if (dir === 'distribute-v') {
    const sorted = [...blocks].sort((a,b) => a.y - b.y);
    const totalH = sizes.reduce((s,sz,i) => s + sz.h, 0);
    const gap = snap((sorted[sorted.length-1].y + sizes[blocks.indexOf(sorted[sorted.length-1])].h - sorted[0].y - totalH) / (sorted.length - 1));
    let cy = sorted[0].y;
    for (const b of sorted) { b.y = snap(cy); cy += getBlockSize(b).h + gap; }
  }
}

function deleteBlock(id) {
  const b = state.blocks[id];
  if (!b) return;
  state.connections = state.connections.filter(c => c.sourceId !== id && c.targetId !== id);
  for (const g of Object.values(state.groups)) {
    g.blocks = g.blocks.filter(bid => bid !== id);
  }
  // Clean up orphan groups
  for (const gId of Object.keys(state.groups)) {
    if (state.groups[gId].blocks.length === 0) delete state.groups[gId];
  }
  delete state.blocks[id];
  state.selectedIds = state.selectedIds.filter(sid => sid !== id);
  render();
  showPropsForBlock(null);
  setStatus('Bloco removido');
}

function toggleBlockLock(id) {
  const b = state.blocks[id];
  if (!b) return;
  pushHistory();
  b.locked = !b.locked;
  setStatus(b.locked ? `"${b.name}" travado` : `"${b.name}" destravado`);
  render();
}

// ===== CONNECTIONS =====
function createConnection(sourceId, sourcePort, targetId, targetPort, label) {
  const exists = state.connections.some(
    c => c.sourceId === sourceId && c.sourcePort === sourcePort &&
         c.targetId === targetId && c.targetPort === targetPort
  );
  if (exists) return null;

  const conn = {
    id: cid(), sourceId, sourcePort: sourcePort || 'bottom',
    targetId, targetPort: targetPort || 'top', label: label || '',
  };
  state.connections.push(conn);
  render();
  setStatus('Conexão criada');
  return conn;
}

function deleteConnection(id) {
  pushHistory();
  state.connections = state.connections.filter(c => c.id !== id);
  state.selectedIds = state.selectedIds.filter(sid => sid !== id);
  render();
  showPropsForBlock(null);
  setStatus('Conexão removida');
}

// ===== GROUPS =====
function createGroup(name) {
  pushHistory();
  const ids = state.selectedIds.filter(id => state.blocks[id]);
  if (ids.length < 2) {
    showModal('Agrupar', '<p class="hint">Selecione pelo menos 2 blocos.</p>');
    return;
  }
  const id = gid();
      state.groups[id] = { id, name: name || `Fábrica ${Object.keys(state.groups).length + 1}`, blocks: [...ids] };
  const presetData = extractPresetData(ids);
  createPreset(name || state.groups[id].name, '', presetData);
  render();
  setStatus(`Grupo "${state.groups[id].name}" criado`);
}

function extractPresetData(blockIds) {
  const blocks = {};
  const connections = [];
  const idMap = {};
  for (const id of blockIds) {
    const b = state.blocks[id];
    if (!b) continue;
    const newId = uid(); idMap[id] = newId;
    const size = getBlockSize(b);
    // We only store the type for the preset; dimensions are recalculated
    blocks[newId] = { ...b, id: newId, x: b.x, y: b.y, w: size.w, h: size.h };
  }
  for (const conn of state.connections) {
    if (idMap[conn.sourceId] && idMap[conn.targetId]) {
      connections.push({ ...conn, id: cid(), sourceId: idMap[conn.sourceId], targetId: idMap[conn.targetId] });
    }
  }
  return { blocks, connections };
}

// ===== TEMPLATES =====
const TEMPLATES = [
  {
    name: 'Ferro',
    desc: 'Minério de ferro → Fornalha → Lingote',
    data: {
      blocks: [
        { name: '⛏ Minério', type: 'input', x: 0, y: 60, consumes: [], generates: [{ name: 'minério de ferro', amount: 3, itemType: 'item', category: 'primary' }], ticks: 0 },
        { name: '🔥 Fornalha', type: 'processing', x: 180, y: 60, consumes: [{ name: 'minério de ferro', amount: 3, itemType: 'item', category: 'primary' }, { name: 'carvão', amount: 1, itemType: 'item', category: 'secondary' }], generates: [{ name: 'lingote de ferro', amount: 2, itemType: 'item', category: 'primary' }], ticks: 40 },
        { name: '📦 Destino', type: 'output', x: 360, y: 60, consumes: [{ name: 'lingote de ferro', amount: 2, itemType: 'item', category: 'primary' }], generates: [], ticks: 0 },
      ],
      connections: [[0, 'right', 1, 'left'], [1, 'right', 2, 'left']],
    },
  },
  {
    name: 'Aço',
    desc: 'Lingote + Carvão + Água → Aço + Escória',
    data: {
      blocks: [
        { name: '📦 Lingotes', type: 'input', x: 0, y: 60, consumes: [], generates: [{ name: 'lingote de ferro', amount: 2, itemType: 'item', category: 'primary' }], ticks: 0 },
        { name: '📦 Carvão', type: 'input', x: 0, y: 140, consumes: [], generates: [{ name: 'carvão', amount: 2, itemType: 'item', category: 'secondary' }], ticks: 0 },
        { name: '💧 Água', type: 'input', x: 0, y: 220, consumes: [], generates: [{ name: 'água', amount: 1, itemType: 'liquid', category: 'secondary' }], ticks: 0 },
        { name: '🏭 Máquina de Aço', type: 'machinery', x: 180, y: 80, consumes: [{ name: 'lingote de ferro', amount: 2, itemType: 'item', category: 'primary' }, { name: 'carvão', amount: 2, itemType: 'item', category: 'secondary' }, { name: 'água', amount: 1, itemType: 'liquid', category: 'secondary' }], generates: [{ name: 'aço', amount: 1, itemType: 'item', category: 'primary' }, { name: 'escória', amount: 1, itemType: 'item', category: 'secondary' }], ticks: 80 },
        { name: '📦 Aço', type: 'output', x: 440, y: 80, consumes: [{ name: 'aço', amount: 1, itemType: 'item', category: 'primary' }], generates: [], ticks: 0 },
        { name: '📦 Escória', type: 'output', x: 440, y: 180, consumes: [{ name: 'escória', amount: 1, itemType: 'item', category: 'secondary' }], generates: [], ticks: 0 },
      ],
      connections: [[0, 'right', 3, 'in-0'], [1, 'right', 3, 'in-1'], [2, 'right', 3, 'in-2'], [3, 'out-0', 4, 'left'], [3, 'out-1', 5, 'left']],
    },
  },
  {
    name: 'Vidro',
    desc: 'Areia → Fornalha → Vidro',
    data: {
      blocks: [
        { name: '⛏ Areia', type: 'input', x: 0, y: 60, consumes: [], generates: [{ name: 'areia', amount: 2, itemType: 'item', category: 'primary' }], ticks: 0 },
        { name: '🔥 Fornalha', type: 'processing', x: 180, y: 60, consumes: [{ name: 'areia', amount: 2, itemType: 'item', category: 'primary' }, { name: 'carvão', amount: 1, itemType: 'item', category: 'secondary' }], generates: [{ name: 'vidro', amount: 2, itemType: 'item', category: 'primary' }], ticks: 40 },
        { name: '📦 Vidro', type: 'output', x: 360, y: 60, consumes: [{ name: 'vidro', amount: 2, itemType: 'item', category: 'primary' }], generates: [], ticks: 0 },
      ],
      connections: [[0, 'right', 1, 'left'], [1, 'right', 2, 'left']],
    },
  },
  {
    name: 'Redstone',
    desc: 'Redstone + Lingote → Circuito',
    data: {
      blocks: [
        { name: '📦 Redstone', type: 'input', x: 0, y: 60, consumes: [], generates: [{ name: 'redstone', amount: 4, itemType: 'item', category: 'primary' }], ticks: 0 },
        { name: '📦 Lingotes', type: 'input', x: 0, y: 140, consumes: [], generates: [{ name: 'lingote de ferro', amount: 1, itemType: 'item', category: 'primary' }], ticks: 0 },
        { name: '🏭 Montadora', type: 'machinery', x: 180, y: 50, consumes: [{ name: 'redstone', amount: 4, itemType: 'item', category: 'primary' }, { name: 'lingote de ferro', amount: 1, itemType: 'item', category: 'primary' }], generates: [{ name: 'circuito', amount: 2, itemType: 'item', category: 'primary' }], ticks: 60 },
        { name: '📦 Circuitos', type: 'output', x: 420, y: 80, consumes: [{ name: 'circuito', amount: 2, itemType: 'item', category: 'primary' }], generates: [], ticks: 0 },
      ],
      connections: [[0, 'right', 2, 'in-0'], [1, 'right', 2, 'in-1'], [2, 'out-0', 3, 'left']],
    },
  },
  {
    name: 'Carvão Vegetal',
    desc: 'Madeira → Fornalha → Carvão vegetal',
    data: {
      blocks: [
        { name: '🌲 Madeira', type: 'input', x: 0, y: 60, consumes: [], generates: [{ name: 'madeira', amount: 4, itemType: 'item', category: 'primary' }], ticks: 0 },
        { name: '🔥 Fornalha', type: 'processing', x: 180, y: 60, consumes: [{ name: 'madeira', amount: 4, itemType: 'item', category: 'primary' }, { name: 'carvão vegetal', amount: 1, itemType: 'item', category: 'secondary' }], generates: [{ name: 'carvão vegetal', amount: 4, itemType: 'item', category: 'primary' }], ticks: 50 },
        { name: '📦 Carvão', type: 'output', x: 360, y: 60, consumes: [{ name: 'carvão vegetal', amount: 4, itemType: 'item', category: 'primary' }], generates: [], ticks: 0 },
      ],
      connections: [[0, 'right', 1, 'left'], [1, 'right', 2, 'left']],
    },
  },
];

function insertTemplate(tplIndex) {
  pushHistory();
  const tpl = TEMPLATES[tplIndex];
  if (!tpl) return;
  const offsetX = 60, offsetY = 60;
  const idMap = {};
  const blocks = {};
  const connections = [];
  // Create blocks
  tpl.data.blocks.forEach((b, i) => {
    const newId = uid();
    idMap[i] = newId;
    blocks[newId] = {
      id: newId,
      name: b.name,
      type: b.type,
      x: b.x + offsetX,
      y: b.y + offsetY + Math.random() * 20, // slight offset to avoid overlap
      consumes: (b.consumes || []).map(normalizeItem),
      generates: (b.generates || []).map(normalizeItem),
      ticks: b.ticks || 0,
    };
  });
  // Create connections
  tpl.data.connections.forEach(([si, sp, ti, tp]) => {
    const newId = cid();
    connections.push({
      id: newId, sourceId: idMap[si], sourcePort: sp,
      targetId: idMap[ti], targetPort: tp,
    });
  });
  // Apply to state
  Object.assign(state.blocks, blocks);
  state.connections.push(...connections);
  clearSelection();
  render();
  setStatus(`Template "${tpl.name}" inserido`);
}

// ===== PRESETS =====
function createPreset(name, description, data) {
  const id = uid();
  state.presets[id] = { id, name, description, data };
  savePresets();
  renderPresets();
  return id;
}
function renderTemplates() {
  const container = document.getElementById('templateList');
  if (!container) return;
  container.replaceChildren();
  TEMPLATES.forEach((tpl, i) => {
    const card = document.createElement('div');
    card.className = 'preset-card';
    card.innerHTML = `<div class="preset-name">${escHtml(tpl.name)}</div><div class="preset-info">${escHtml(tpl.desc)}</div>`;
    card.addEventListener('click', () => insertTemplate(i));
    container.appendChild(card);
  });
}
function deletePreset(id) {
  delete state.presets[id];
  savePresets();
  renderPresets();
  setStatus('Preset removido');
}
function savePresets() { localStorage.setItem('planner_presets', JSON.stringify(state.presets)); }

function usePreset(id) {
  pushHistory();
  const preset = state.presets[id];
  if (!preset) return;
  const data = preset.data;
  const offsetX = 50, offsetY = 50;
  const idMap = {};
  let minX = Infinity, minY = Infinity;
  for (const b of Object.values(data.blocks || {})) {
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
  }
  for (const [oldId, b] of Object.entries(data.blocks || {})) {
    const newId = uid(); idMap[oldId] = newId;
    state.blocks[newId] = { ...b, id: newId, x: b.x - minX + offsetX, y: b.y - minY + offsetY };
  }
  for (const conn of (data.connections || [])) {
    if (idMap[conn.sourceId] && idMap[conn.targetId]) {
      state.connections.push({ ...conn, id: cid(), sourceId: idMap[conn.sourceId], targetId: idMap[conn.targetId], label: conn.label || '' });
    }
  }
  render();
  clearSelection();
  setStatus(`Preset "${preset.name}" inserido`);
}

// ===== CONSTANTS =====
function saveConstants() {
  localStorage.setItem('planner_constants', JSON.stringify(state.constants));
}

function addConstant(name, itemType) {
  if (!name || !name.trim()) return;
  const existing = state.constants.items.find(i => i.name === name.trim());
  if (existing) return;
  state.constants.items.push({ name: name.trim(), itemType: itemType || 'item' });
  saveConstants();
  renderConstants();
  syncAutocompleteDatalist();
}

function syncAutocompleteDatalist() {
  const dl = document.getElementById('mc-items-autocomplete');
  if (!dl) return;
  dl.innerHTML = '';
  const seen = new Set();
  for (const c of (state.constants.items || [])) {
    if (!seen.has(c.name)) { seen.add(c.name); dl.innerHTML += `<option value="${escHtml(c.name)}">`; }
  }
}

function populateDefaultConstants() {
  const defaults = [
    { name: 'minério de ferro', type: 'item' }, { name: 'minério de ouro', type: 'item' },
    { name: 'minério de cobre', type: 'item' }, { name: 'minério de carvão', type: 'item' },
    { name: 'minério de diamante', type: 'item' }, { name: 'minério de esmeralda', type: 'item' },
    { name: 'minério de redstone', type: 'item' }, { name: 'minério de lápis-lazúli', type: 'item' },
    { name: 'ferro bruto', type: 'item' }, { name: 'ouro bruto', type: 'item' }, { name: 'cobre bruto', type: 'item' },
    { name: 'lingote de ferro', type: 'item' }, { name: 'lingote de ouro', type: 'item' },
    { name: 'lingote de cobre', type: 'item' }, { name: 'lingote de netherita', type: 'item' },
    { name: 'aço', type: 'item' }, { name: 'carvão', type: 'item' }, { name: 'carvão vegetal', type: 'item' },
    { name: 'diamante', type: 'item' }, { name: 'esmeralda', type: 'item' },
    { name: 'redstone', type: 'item' }, { name: 'lápis-lazúli', type: 'item' },
    { name: 'pó de redstone', type: 'item' }, { name: 'quartzo do nether', type: 'item' },
    { name: 'fragmento de netherita', type: 'item' }, { name: 'circuito', type: 'item' },
    { name: 'tábua', type: 'item' }, { name: 'graveto', type: 'item' },
    { name: 'pedra', type: 'item' }, { name: 'pedregulho', type: 'item' }, { name: 'tijolo', type: 'item' },
    { name: 'vidro', type: 'item' }, { name: 'areia', type: 'item' }, { name: 'arenito', type: 'item' },
    { name: 'trigo', type: 'item' }, { name: 'cenoura', type: 'item' }, { name: 'batata', type: 'item' },
    { name: 'farinha de osso', type: 'item' }, { name: 'pão', type: 'item' },
    { name: 'fio de aranha', type: 'item' }, { name: 'osso', type: 'item' }, { name: 'pólvora', type: 'item' },
    { name: 'slimeball', type: 'item' }, { name: 'couro', type: 'item' }, { name: 'pena', type: 'item' },
    { name: 'obsidiana', type: 'item' }, { name: 'tijolo do nether', type: 'item' },
    { name: 'bloco de ferro', type: 'item' }, { name: 'bloco de ouro', type: 'item' },
    { name: 'bloco de diamante', type: 'item' }, { name: 'bloco de redstone', type: 'item' },
    { name: 'escória', type: 'item' }, { name: 'grafite', type: 'item' }, { name: 'silício', type: 'item' },
    { name: 'funil', type: 'item' }, { name: 'esteira', type: 'item' }, { name: 'baú', type: 'item' },
    { name: 'fornalha', type: 'item' }, { name: 'fornalha alta', type: 'item' },
    { name: 'bigorna', type: 'item' }, { name: 'bancada', type: 'item' },
    { name: 'água', type: 'liquid' }, { name: 'lava', type: 'liquid' },
    { name: 'óleo', type: 'liquid' }, { name: 'vapor', type: 'liquid' },
    { name: 'energia', type: 'energy' }, { name: 'EU', type: 'energy' },
  ];
  for (const d of defaults) addConstant(d.name, d.type);
  setStatus(`${defaults.length} itens padrão adicionados às constantes`);
}

function editConstant(index) {
  const item = state.constants.items[index];
  if (!item) return;
  showModal('Editar Item Constante', `
    <div class="form-group"><label>Nome</label><input type="text" id="dlg-const-name" value="${escHtml(item.name)}"></div>
    <div class="form-group"><label>Tipo</label>
      <select id="dlg-const-type">
        ${ITEM_TYPES.map(t => `<option value="${t}" ${t === item.itemType ? 'selected' : ''}>${ITEM_TYPE_LABELS[t]}</option>`).join('')}
      </select>
    </div>
    <div class="form-actions">
      <button class="btn-secondary" onclick="hideModal()">Cancelar</button>
      <button class="btn-primary" id="dlg-const-confirm">Salvar</button>
    </div>
  `);
  document.getElementById('dlg-const-confirm').addEventListener('click', () => {
    const name = document.getElementById('dlg-const-name').value.trim();
    const type = document.getElementById('dlg-const-type').value;
    if (name) { state.constants.items[index] = { name, itemType: type }; saveConstants(); renderConstants(); }
    hideModal();
  }, { once: true });
}

function showAddConstantDialog() {
  showModal('Adicionar Item Constante', `
    <div class="form-group"><label>Nome do Item</label><input type="text" id="dlg-const-name" placeholder="ex: lingote de ferro"></div>
    <div class="form-group"><label>Tipo</label>
      <select id="dlg-const-type">
        ${ITEM_TYPES.map(t => `<option value="${t}" ${t === 'item' ? 'selected' : ''}>${ITEM_TYPE_LABELS[t]}</option>`).join('')}
      </select>
    </div>
    <div class="form-actions">
      <button class="btn-secondary" onclick="hideModal()">Cancelar</button>
      <button class="btn-primary" id="dlg-const-confirm">Adicionar</button>
    </div>
  `);
  document.getElementById('dlg-const-confirm').addEventListener('click', () => {
    const name = document.getElementById('dlg-const-name').value.trim();
    const type = document.getElementById('dlg-const-type').value;
    if (name) addConstant(name, type);
    hideModal();
  }, { once: true });
  setTimeout(() => document.getElementById('dlg-const-name')?.focus(), 100);
}

// ===== PROPERTIES PANEL =====
function showPropsForBlock(id) {
  if (!id || !state.blocks[id]) {
    propsPopover.classList.add('hidden');
    propsPopover.classList.remove('visible');
    return;
  }

  const b = state.blocks[id];
  const isMach = b.type === 'machinery';
  const isNote = b.type === 'note';
  let html = '';

  if (isNote) {
    html += `<div class="prop-group"><label>Nota</label>
      <textarea id="prop-name" data-prop="name">${escHtml(b.name)}</textarea>
    </div>`;
  } else {
    html += `<div class="prop-group"><label>Nome</label><input type="text" id="prop-name" value="${escHtml(b.name)}" data-prop="name"></div>`;
  }

  if (!isNote && !isMach) {
    html += `<div class="prop-group"><label>Tipo</label>
      <select id="prop-type" data-prop="type">
        <option value="input" ${b.type === 'input' ? 'selected' : ''}>Fonte</option>
        <option value="processing" ${b.type === 'processing' ? 'selected' : ''}>Máquina</option>
        <option value="output" ${b.type === 'output' ? 'selected' : ''}>Destino</option>
        <option value="machinery" ${b.type === 'machinery' ? 'selected' : ''}>Fábrica</option>
      </select>
    </div>`;
  }

  if (!isNote) {
    html += `<div class="prop-group"><label>Ticks</label>
      <input type="number" id="prop-ticks" value="${b.ticks || 0}" min="0" max="999" data-prop="ticks">
      <span class="prop-helper">${b.ticks > 0 ? (b.ticks / 20).toFixed(1) + 's' : 'instantâneo'}</span>
    </div>`;

  html += renderItemEditor(b, 'consumes', 'Consome');
  html += renderItemEditor(b, 'generates', 'Produz');
  }

  html += `<div class="prop-group"><label>Travar</label>
    <input type="checkbox" id="prop-locked" ${b.locked ? 'checked' : ''} data-prop="locked"></div>`;

  propsContent.innerHTML = html;
  bindPropsEvents(id);
  positionPropsPopover(b);
  propsPopover.classList.remove('hidden');
  requestAnimationFrame(() => propsPopover.classList.add('visible'));
}

function positionPropsPopover(b) {
  const size = getBlockSize(b);
  const v = state.view;
  const zoom = v.zoom;
  const containerRect = canvasContainer.getBoundingClientRect();
  const popW = 260;
  const gap = 14;

  // Block edges in CSS pixels
  const bLeft   = (b.x + v.x) * zoom;
  const bTop    = (b.y + v.y) * zoom;
  const bRight  = (b.x + size.w + v.x) * zoom;
  const bBottom = (b.y + size.h + v.y) * zoom;

  let px, py;

  // Try right side first (aligned to top of block)
  if (bRight + gap + popW <= containerRect.width) {
    px = bRight + gap;
    py = Math.max(gap, Math.min(bTop, containerRect.height - 380));
  }
  // Try left side
  else if (bLeft - gap - popW >= 0) {
    px = bLeft - gap - popW;
    py = Math.max(gap, Math.min(bTop, containerRect.height - 380));
  }
  // Fallback: below the block
  else {
    px = Math.max(gap, Math.min(bLeft, containerRect.width - popW - gap));
    py = Math.min(bBottom + gap, containerRect.height - 380);
  }

  propsPopover.style.left = px + 'px';
  propsPopover.style.top = py + 'px';
}

function renderItemEditor(b, listName, label) {
  const items = b[listName] || [];
  const typeColors = { item: '#10b981', liquid: '#3b82f6', energy: '#f59e0b', other: '#8b5cf6' };

  let html = `<div class="prop-group"><label>${escHtml(label)}</label><div class="item-list" id="prop-${listName}-list">`;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const tc = typeColors[item.itemType] || '#888';
    html += `<div class="item-tag" data-index="${i}" data-list="${listName}">
      <span class="item-type-badge" style="background:${tc}">${item.itemType === 'liquid' ? 'L' : item.itemType === 'energy' ? 'E' : item.itemType === 'item' ? 'I' : 'O'}</span>
      <span>${escHtml(item.name)}</span>
      <span style="color:rgba(255,255,255,0.3)">×${item.amount}</span>
      <span class="cat-badge">${item.category === 'primary' ? 'P' : 'S'}</span>
      <span class="remove-item" data-list="${listName}" data-index="${i}">&times;</span>
    </div>`;
  }

  html += `</div>
    <div class="item-add-row">
      <input type="text" class="item-name-input" id="prop-${listName}-name" placeholder="nome do item..." list="mc-items-autocomplete">
      <select class="item-type-select">
        ${ITEM_TYPES.map(t => `<option value="${t}">${t === 'item' ? 'Item' : t === 'liquid' ? 'Líq' : t === 'energy' ? 'Ener' : t}</option>`).join('')}
      </select>
      <select class="item-cat-select">
        <option value="primary">P</option>
        <option value="secondary">S</option>
      </select>
      <input type="number" class="item-amount-input" value="1" min="1" max="999">
      <button class="btn-item-add" data-list="${listName}">+</button>
    </div>`;

  return html;
}

// Props panel state (for event delegation)
let _propsBlockId = null;

function setupPropsDelegation() {
  propsContent.addEventListener('change', (e) => {
    const b = state.blocks[_propsBlockId];
    if (!b) return;

    // data-prop bindings (name, type)
    const prop = e.target.dataset.prop;
    if (prop) {
      pushHistory();
      b[prop] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      if (prop === 'type') {
        const size = b.type === 'machinery' ? { w: MACH_W, h: MACH_H } : { w: PROC_W, h: PROC_H };
        b.w = size.w; b.h = size.h;
      }
      render(); showPropsForBlock(_propsBlockId);
      return;
    }

  });

  propsContent.addEventListener('click', (e) => {
    const b = state.blocks[_propsBlockId];
    if (!b) return;

    // Remove item
    if (e.target.classList.contains('remove-item')) {
      const list = e.target.dataset.list;
      const idx = parseInt(e.target.dataset.index);
      if (b[list] && idx >= 0 && idx < b[list].length) {
        pushHistory();
        b[list].splice(idx, 1);
        render(); showPropsForBlock(_propsBlockId);
      }
      return;
    }

    // Add item button
    if (e.target.classList.contains('btn-item-add')) {
      const btn = e.target;
      const list = btn.dataset.list;
      const group = btn.closest('.prop-group');
      const nameInput = group?.querySelector('.item-name-input');
      const typeSel = group?.querySelector('.item-type-select');
      const catSel = group?.querySelector('.item-cat-select');
      const amtInput = group?.querySelector('.item-amount-input');

      const name = nameInput?.value.trim() || '';
      const itemType = typeSel?.value || 'item';
      const amount = Math.max(1, parseInt(amtInput?.value) || 1);
      const category = catSel?.value || 'primary';

      if (!name) return;
      pushHistory();
      if (!b[list]) b[list] = [];
      b[list].push(makeItem(name, amount, itemType, category));
      addConstant(name, itemType);
      if (nameInput) nameInput.value = '';
      render(); showPropsForBlock(_propsBlockId);
      return;
    }
  });

  propsContent.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains('item-name-input')) {
      const btn = e.target.closest('.prop-group')?.querySelector('.btn-item-add');
      if (btn) btn.click();
    }
  });
}

function bindPropsEvents(blockId) {
  _propsBlockId = blockId;
}

function showPropsForConnection(id) {
  const conn = state.connections.find(c => c.id === id);
  if (!conn) return showPropsForBlock(null);
  const sourceB = state.blocks[conn.sourceId];
  const targetB = state.blocks[conn.targetId];

  let html = '<div class="prop-group"><label>Conexão</label>';
  html += `<p class="conn-path-label">${escHtml(sourceB?.name || '?')} → ${escHtml(targetB?.name || '?')}</p></div>`;
  html += `<div class="prop-group"><label>Rótulo</label><input type="text" id="conn-label" value="${escHtml(conn.label || '')}"></div>`;
  html += `<div class="prop-group"><button id="btn-delete-conn" class="btn-danger">Excluir Conexão</button></div>`;

  propsContent.innerHTML = html;
  document.getElementById('conn-label')?.addEventListener('change', () => { pushHistory(); conn.label = document.getElementById('conn-label').value; render(); });
  document.getElementById('btn-delete-conn')?.addEventListener('click', () => deleteConnection(id));

  // Position popover near the midpoint of the connection
  const sourceBInst = state.blocks[conn.sourceId];
  const targetBInst = state.blocks[conn.targetId];
  if (sourceBInst && targetBInst) {
    const midX = (sourceBInst.x + getBlockSize(sourceBInst).w / 2 + targetBInst.x + getBlockSize(targetBInst).w / 2) / 2;
    const midY = (sourceBInst.y + getBlockSize(sourceBInst).h / 2 + targetBInst.y + getBlockSize(targetBInst).h / 2) / 2;
    positionPropsPopover({ x: midX - 60, y: midY - 30 });
  }
  propsPopover.classList.remove('hidden');
  requestAnimationFrame(() => propsPopover.classList.add('visible'));
}

// ===== SELECTION =====
function clearSelection() { state.selectedIds = []; render(); hidePropsPopover(); hideContextMenu(); }
function hidePropsPopover() { propsPopover.classList.remove('visible'); propsPopover.classList.add('hidden'); }
function selectBlock(id, add) {
  if (!add) clearSelection();
  if (!state.selectedIds.includes(id)) state.selectedIds.push(id);
  render();
}

// ===== MODAL =====
function showModal(title, contentHtml) {
  modalBody.innerHTML = `<h2>${escHtml(title)}</h2>${contentHtml}`;
  modal.classList.remove('hidden');
  // Trap focus inside modal
  setTimeout(() => {
    const focusable = modalBody.querySelectorAll('input,select,textarea,button,[tabindex]:not([tabindex="-1"])');
    if (focusable.length) focusable[0].focus();
  }, 50);
}
function hideModal() { modal.classList.add('hidden'); }

document.getElementById('modal-close').addEventListener('click', hideModal);
modal.addEventListener('click', (e) => { if (e.target === modal) hideModal(); });
modal.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    const focusable = modalBody.querySelectorAll('input,select,textarea,button,[tabindex]:not([tabindex="-1"])');
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

function showNewBlockDialog() {
  showModal('Novo Bloco', `
    <div class="form-group"><label>Nome</label><input type="text" id="dlg-block-name" placeholder="ex: Fornalha" value="" list="mc-items-autocomplete"></div>
    <div class="form-group"><label>Tipo</label>
      <select id="dlg-block-type">
        <option value="input">Fonte</option>
        <option value="processing" selected>Máquina</option>
        <option value="output">Destino</option>
        <option value="machinery">🏭 Fábrica</option>
      </select>
    </div>
    <div class="form-group"><label>Consome (separado por vírgula)</label><input type="text" id="dlg-block-consumes" placeholder="ex: minério, carvão" list="mc-items-autocomplete"></div>
    <div class="form-group"><label>Gera (separado por vírgula)</label><input type="text" id="dlg-block-generates" placeholder="ex: lingote" list="mc-items-autocomplete"></div>
    <div class="form-actions">
      <button class="btn-secondary" onclick="hideModal()">Cancelar</button>
      <button class="btn-primary" id="dlg-block-confirm">Criar</button>
    </div>
  `);
  document.getElementById('dlg-block-confirm').addEventListener('click', () => {
    const name = document.getElementById('dlg-block-name').value.trim() || 'Novo Bloco';
    const type = document.getElementById('dlg-block-type').value;
    const consumes = document.getElementById('dlg-block-consumes').value.split(',').map(s => s.trim()).filter(Boolean).map(s => makeItem(s, 1, 'item', 'primary'));
    const generates = document.getElementById('dlg-block-generates').value.split(',').map(s => s.trim()).filter(Boolean).map(s => makeItem(s, 1, 'item', 'primary'));
    hideModal(); pushHistory();
    createBlock(name, type, consumes, generates);
  }, { once: true });
  document.getElementById('dlg-block-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('dlg-block-confirm').click(); });
  setTimeout(() => document.getElementById('dlg-block-name')?.focus(), 100);
}

function showSettingsDialog() {
  showModal('Configurações', `
    <div class="form-group">
      <label>Servidor Relay (WebSocket)</label>
      <input type="text" id="dlg-relay-url" placeholder="ws://192.168.1.100:3000" value="${state.relayUrl}">
      <p class="hint" style="margin-top:4px">
        Deixe vazio para usar BroadcastChannel (mesmo navegador, várias abas).<br>
        Preencha com URL do relay para colaborar entre dispositivos.
      </p>
    </div>
    <div class="form-group">
      <label>Opção 1 — Rede local (mais rápido)</label>
      <p class="hint" style="margin-top:2px;line-height:1.5">
        No PC servidor: <code style="background:#2a2a3e;padding:1px 4px;border-radius:3px">npm start</code><br>
        Aparecerá um IP tipo <code style="background:#2a2a3e;padding:1px 4px;border-radius:3px">ws://192.168.x.x:3000</code> — cole acima.
      </p>
    </div>
    <div class="form-group">
      <label>Opção 2 — Render (gratuito, funciona de qualquer lugar)</label>
      <p class="hint" style="margin-top:2px;line-height:1.5">
        1. Crie um repositório com: <code style="background:#2a2a3e;padding:1px 4px;border-radius:3px">server-relay.js</code>, <code style="background:#2a2a3e;padding:1px 4px;border-radius:3px">package.json</code><br>
        2. Faça push no GitHub<br>
        3. Acesse <a href="https://render.com" target="_blank" style="color:#3b82f6">render.com</a> → New Web Service → conecte o repo<br>
        4. Build: <code style="background:#2a2a3e;padding:1px 4px;border-radius:3px">npm install</code>, Start: <code style="background:#2a2a3e;padding:1px 4px;border-radius:3px">npm start</code><br>
        5. Render dará uma URL tipo <code style="background:#2a2a3e;padding:1px 4px;border-radius:3px">wss://planner-relay.onrender.com</code> — cole acima.
      </p>
    </div>
    <div class="form-group">
      <label>Opção 3 — Replit (gratuito, sem instalar nada)</label>
      <p class="hint" style="margin-top:2px;line-height:1.5">
        1. Acesse <a href="https://replit.com" target="_blank" style="color:#3b82f6">replit.com</a> → New Replit → Node.js<br>
        2. Cole o conteúdo de <code style="background:#2a2a3e;padding:1px 4px;border-radius:3px">server-relay.js</code> no <code style="background:#2a2a3e;padding:1px 4px;border-radius:3px">index.js</code><br>
        3. Pressione Run<br>
        4. Replit dará uma URL — cole acima
      </p>
    </div>
    <div class="form-actions">
      <button class="btn-secondary" onclick="hideModal()">Cancelar</button>
      <button class="btn-primary" id="dlg-settings-confirm">Salvar</button>
    </div>
  `);
  document.getElementById('dlg-settings-confirm').addEventListener('click', () => {
    const url = document.getElementById('dlg-relay-url').value.trim();
    state.relayUrl = url;
    localStorage.setItem('planner_relay_url', url);
    hideModal();
    setStatus(url ? 'Relay configurado: ' + url : 'Relay removido (usando BroadcastChannel)');
    // Reconnect collab if active
    if (_collabEnabled) {
      stopCollab();
      startCollab();
    }
  }, { once: true });
  setTimeout(() => document.getElementById('dlg-relay-url')?.focus(), 100);
}

function showGroupDialog() {
  const selected = state.selectedIds.filter(id => state.blocks[id]);
  if (selected.length < 2) {
    showModal('Agrupar', '<p class="hint">Selecione pelo menos 2 blocos (Ctrl+Clique).</p>');
    return;
  }
  showModal('Agrupar Blocos', `
    <p style="font-size:12px;color:#ccc;margin-bottom:8px">${selected.length} blocos selecionados</p>
        <div class="form-group"><label>Nome da Fábrica</label><input type="text" id="dlg-group-name" placeholder="ex: Máquina de Ferro"></div>
    <div class="form-actions">
      <button class="btn-secondary" onclick="hideModal()">Cancelar</button>
      <button class="btn-primary" id="dlg-group-confirm">Criar Grupo</button>
    </div>
  `);
  document.getElementById('dlg-group-confirm').addEventListener('click', () => {
      const name = document.getElementById('dlg-group-name').value.trim() || `Fábrica ${Object.keys(state.groups).length + 1}`;
    hideModal(); createGroup(name);
  }, { once: true });
  setTimeout(() => document.getElementById('dlg-group-name')?.focus(), 100);
}

// ===== CANVAS EVENTS =====
let canvasState = { pointerDown: false, downX: 0, downY: 0, downTime: 0, moved: false };

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const pt = getCanvasPoint(e);
  const rect = canvas.getBoundingClientRect();

  // Check what's under cursor
  const target = e.target;
  const blockEl = target.closest('.block-group');
  const connEl = target.closest('.connection-path');
  const portEl = target.closest('.block-port');

  // Clear highlights on canvas click
  state.highlightedIds = [];

  if (blockEl) {
    const bid = blockEl.getAttribute('data-id');
    const b = state.blocks[bid];
    const isNote = b && b.type === 'note';
    const isLocked = b && b.locked;
    const menuItems = [
      { label: (isNote ? '✏️ Editar nota' : '📋 Propriedades'), action: () => { selectBlock(bid); showPropsForBlock(bid); } },
      ...(isNote ? [] : [
        { label: '🔗 Conectar deste', action: () => { state.connectMode = true; $('btnConnectMode').classList.add('active'); canvas.classList.add('connecting'); setStatus('Clique numa porta de destino'); } },
      ]),
      { separator: true },
      { label: isLocked ? '🔓 Desbloquear' : '🔒 Bloquear', action: () => { toggleBlockLock(bid); } },
      { label: '📋 Copiar como Preset', action: () => { clearSelection(); state.selectedIds.push(bid); copySelectedAsPreset(); } },
      { label: '🗑 Excluir', action: () => { clearSelection(); state.selectedIds.push(bid); deleteSelected(); } },
    ];
    showContextMenu(menuItems, e.clientX, e.clientY);
  } else if (connEl) {
    const cid = connEl.getAttribute('data-id');
    const conn = state.connections.find(c => c.id === cid);
    const menuItems = [
      { label: '📋 Propriedades da conexão', action: () => { clearSelection(); state.selectedIds.push(cid); render(); showPropsForConnection(cid); } },
      { label: '🗑 Excluir conexão', action: () => deleteConnection(cid) },
    ];
    showContextMenu(menuItems, e.clientX, e.clientY);
  } else {
    // Canvas context menu
    const cp = { x: snap(pt.x), y: snap(pt.y) };
    const selCount = state.selectedIds.filter(id => state.blocks[id]).length;
    const menuItems = [
      { label: '💬 Nova Nota', action: () => {
        pushHistory();
        const b = createBlock('Nova nota', 'note');
        b.x = cp.x; b.y = cp.y;
        render();
      } },
      { label: '➕ Novo Bloco de Processo', action: () => showNewBlockDialog() },
        { label: '🏭 Nova Fábrica', action: () => {
        pushHistory();
        const b = createBlock('Nova Fábrica', 'machinery', [], []);
        b.x = cp.x; b.y = cp.y;
        render();
      } },
      { separator: true },
      { label: '📋 Colar', disabled: !state.clipboard, action: () => pasteBlocks() },
      { separator: true },
      ...(selCount >= 2 ? [
        { label: '📐 Alinhar à Esquerda', action: () => { pushHistory(); alignBlocks(state.selectedIds.filter(id=>state.blocks[id]), 'left'); render(); } },
        { label: '📐 Alinhar à Direita', action: () => { pushHistory(); alignBlocks(state.selectedIds.filter(id=>state.blocks[id]), 'right'); render(); } },
        { label: '📐 Alinhar ao Topo', action: () => { pushHistory(); alignBlocks(state.selectedIds.filter(id=>state.blocks[id]), 'top'); render(); } },
        { label: '📐 Alinhar à Base', action: () => { pushHistory(); alignBlocks(state.selectedIds.filter(id=>state.blocks[id]), 'bottom'); render(); } },
      ] : []),
      ...(selCount >= 3 ? [
        { label: '📐 Distribuir Horizontal', action: () => { pushHistory(); alignBlocks(state.selectedIds.filter(id=>state.blocks[id]), 'distribute-h'); render(); } },
        { label: '📐 Distribuir Vertical', action: () => { pushHistory(); alignBlocks(state.selectedIds.filter(id=>state.blocks[id]), 'distribute-v'); render(); } },
        { separator: true },
      ] : []),
      { label: '📦 Adicionar Item Constante', action: () => showAddConstantDialog() },
    ];
    showContextMenu(menuItems, e.clientX, e.clientY);
  }
});

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const pt = getCanvasPoint(e);
  canvasState.pointerDown = true;
  canvasState.downX = pt.x; canvasState.downY = pt.y;
  canvasState.downTime = Date.now(); canvasState.moved = false;

  const target = e.target;

  if (target.classList.contains('conn-handle')) {
    e.stopPropagation(); e.preventDefault();
    const connId = target.getAttribute('data-conn-id');
    const end = target.getAttribute('data-end');
    const conn = state.connections.find(c => c.id === connId);
    if (!conn) return;
    state.reconnecting = { connId, end };
    canvas.classList.add('connecting');
    const fixedB = state.blocks[end === 'source' ? conn.targetId : conn.sourceId];
    const fixedPort = end === 'source' ? conn.targetPort : conn.sourcePort;
    const fp = getPortPosition(fixedB, fixedPort);
    renderTempConnection(fp.x, fp.y);
    setStatus(`Reconectando...`);
    return;
  }

  if (target.classList.contains('block-port')) {
    e.stopPropagation();
    handlePortDown(target.getAttribute('data-block-id'), target.getAttribute('data-port'), e);
    return;
  }

  const blockEl = target.closest('.block-group');
  if (blockEl) {
    e.stopPropagation();
    handleBlockDown(blockEl.getAttribute('data-id'), e);
    return;
  }

  if (target.classList.contains('connection-path') || target.classList.contains('connection-hit')) {
    e.stopPropagation();
    const connId = target.getAttribute('data-id');
    clearSelection(); state.selectedIds.push(connId); render(); showPropsForConnection(connId);
    return;
  }

  clearSelection(); showPropsForBlock(null);
  if (e.shiftKey) {
    state.selectBox = { x: pt.x, y: pt.y, w: 0, h: 0 };
  } else {
    state.panning = { startX: e.clientX, startY: e.clientY, viewX: state.view.x, viewY: state.view.y };
    canvas.classList.add('dragging');
  }
});

canvas.addEventListener('pointermove', (e) => {
  const pt = getCanvasPoint(e);
  statusCoords.textContent = `${Math.round(pt.x)}, ${Math.round(pt.y)}`;

  // Reconnection drag
  if (state.reconnecting) {
    const conn = state.connections.find(c => c.id === state.reconnecting.connId);
    if (conn) {
      const fixedBlock = state.blocks[state.reconnecting.end === 'source' ? conn.targetId : conn.sourceId];
      const fixedPort = state.reconnecting.end === 'source' ? conn.targetPort : conn.sourcePort;
      const fixedPos = getPortPosition(fixedBlock, fixedPort);
      updateTempPath(`M ${fixedPos.x} ${fixedPos.y} L ${pt.x} ${pt.y}`);
    }
    const hovered = findPortAt(pt.x, pt.y, 15);
    document.querySelectorAll('.block-port.active').forEach(el => el.classList.remove('active'));
    if (hovered) {
      const el = blockLayer.querySelector(`[data-id="${hovered.block.id}"] .block-port[data-port="${hovered.port}"]`);
      if (el) el.classList.add('active');
    }
    return;
  }

  if (state.connecting) {
    renderTempConnection(pt.x, pt.y);
    const hovered = findPortAt(pt.x, pt.y, 15);
    document.querySelectorAll('.block-port.active').forEach(el => el.classList.remove('active'));
    if (hovered) {
      const el = blockLayer.querySelector(`[data-id="${hovered.block.id}"] .block-port[data-port="${hovered.port}"]`);
      if (el) el.classList.add('active');
    }
    return;
  }

  if (state.dragging) {
    e.preventDefault(); canvasState.moved = true;
    const dx = pt.x - canvasState.downX, dy = pt.y - canvasState.downY;
    state.dragging.ids.forEach((id, i) => {
      const b = state.blocks[id];
      if (!b) return;
      b.x = state.dragging.blockOrigins[i].x + dx;
      b.y = state.dragging.blockOrigins[i].y + dy;
    });
    updateDraggedBlocks();
    return;
  }

  if (state.selectBox && canvasState.pointerDown) {
    canvasState.moved = true;
    state.selectBox.w = pt.x - state.selectBox.x;
    state.selectBox.h = pt.y - state.selectBox.y;
    renderSelectionBox();
    return;
  }

  if (e.target.classList.contains('block-port') || e.target.classList.contains('conn-handle')) {
    e.target.classList.add('active');
  } else {
    document.querySelectorAll('.block-port.active, .conn-handle.active').forEach(el => el.classList.remove('active'));
  }

  const blockEl = e.target.closest('.block-group');
  if (blockEl) canvas.style.cursor = 'grab';
  else if (e.target.classList.contains('connection-path') || e.target.classList.contains('connection-hit')) canvas.style.cursor = 'pointer';
  else if (e.target.classList.contains('conn-handle')) canvas.style.cursor = 'move';
  else canvas.style.cursor = state.connectMode ? 'crosshair' : 'default';
});

canvas.addEventListener('pointerup', (e) => {
  if (e.button !== 0) return;
  const pt = getCanvasPoint(e);

  // Reconnection drop
  if (state.reconnecting) {
    const hovered = findPortAt(pt.x, pt.y, 18);
    const conn = state.connections.find(c => c.id === state.reconnecting.connId);
    if (conn && hovered) {
      const curId = state.reconnecting.end === 'source' ? conn.sourceId : conn.targetId;
      const curPort = state.reconnecting.end === 'source' ? conn.sourcePort : conn.targetPort;
      const sameBlock = hovered.block.id === curId;
      const samePort = hovered.port === curPort;
      if (sameBlock && samePort) {
        setStatus('Mesma conexão — mantido');
      } else {
        pushHistory();
        if (state.reconnecting.end === 'source') {
          conn.sourceId = hovered.block.id;
          conn.sourcePort = hovered.port;
        } else {
          conn.targetId = hovered.block.id;
          conn.targetPort = hovered.port;
        }
        setStatus('Conexão reatada');
      }
    } else { setStatus('Reconexão cancelada'); }
    state.reconnecting = null; clearTempConnection();
    document.querySelectorAll('.block-port.active').forEach(el => el.classList.remove('active'));
    canvas.classList.remove('connecting');
    render(); return;
  }

  if (state.connecting) {
    const hovered = findPortAt(pt.x, pt.y, 18);
    if (hovered && hovered.block.id !== state.connecting.sourceId) {
      pushHistory();
      createConnection(state.connecting.sourceId, state.connecting.sourcePort, hovered.block.id, hovered.port);
      state.connecting = null; clearTempConnection();
      document.querySelectorAll('.block-port.active, .block-port.connecting').forEach(el => el.classList.remove('active', 'connecting'));
      canvas.classList.remove('connecting'); $('btnConnectMode').classList.remove('active'); state.connectMode = false;
      render(); return;
    } else {
      // Show quick-create menu at drop position
      _quickCreatePos = { ...pt };
      showQuickCreateMenu(state.connecting.sourceId, state.connecting.sourcePort, e.clientX, e.clientY);
      state.connecting = null; clearTempConnection();
      document.querySelectorAll('.block-port.active, .block-port.connecting').forEach(el => el.classList.remove('active', 'connecting'));
      canvas.classList.remove('connecting'); $('btnConnectMode').classList.remove('active'); state.connectMode = false;
      return;
    }
  }

  if (state.dragging) {
    for (const id of state.dragging.ids) {
      const b = state.blocks[id];
      if (b) { b.x = snap(b.x); b.y = snap(b.y); }
    }
    state.dragging = null; render(); pushHistory(); return;
  }

  if (state.selectBox && canvasState.moved) {
    const sb = state.selectBox;
    const x1 = Math.min(sb.x, sb.x + sb.w), y1 = Math.min(sb.y, sb.y + sb.h);
    const x2 = Math.max(sb.x, sb.x + sb.w), y2 = Math.max(sb.y, sb.y + sb.h);
    clearSelection();
    for (const b of Object.values(state.blocks)) {
      const size = getBlockSize(b);
      if (b.x < x2 && b.x + size.w > x1 && b.y < y2 && b.y + size.h > y1) state.selectedIds.push(b.id);
    }
    state.selectBox = null; clearSelectionBox(); render();
    return;
  }
  canvasState.pointerDown = false;
});

function handleBlockDown(blockId, e) {
  const pt = getCanvasPoint(e);
  if (state.connectMode) {
    const b = state.blocks[blockId];
    if (!b) return;
    const allPorts = Object.keys(getPortPositions(b));
    let closest = { port: allPorts[0] || 'bottom', dist: Infinity };
    for (const p of allPorts) {
      const pos = getPortPosition(b, p);
      const d = dist(pt.x, pt.y, pos.x, pos.y);
      if (d < closest.dist) closest = { port: p, dist: d };
    }
    handlePortDown(blockId, closest.port, e);
    return;
  }

  const add = e.ctrlKey || e.metaKey || e.shiftKey;
  if (add) {
    const idx = state.selectedIds.indexOf(blockId);
    if (idx >= 0) state.selectedIds.splice(idx, 1);
    else state.selectedIds.push(blockId);
  } else if (!isSelected(blockId)) {
    clearSelection(); state.selectedIds.push(blockId);
  }

  render();
  const ids = state.selectedIds.filter(id => state.blocks[id]);
  if (ids.length === 0) return;
  // Don't drag locked blocks
  if (ids.some(id => state.blocks[id]?.locked)) {
    setStatus('Bloco travado — destrave para mover');
    return;
  }
  e.preventDefault();
  state.dragging = { ids, startX: pt.x, startY: pt.y, blockOrigins: ids.map(id => ({ x: state.blocks[id].x, y: state.blocks[id].y })) };
  canvasState.downX = pt.x; canvasState.downY = pt.y;
}

function handlePortDown(blockId, port, e) {
  state.connectMode = true; $('btnConnectMode').classList.add('active');
  canvas.classList.add('connecting');
  state.connecting = { sourceId: blockId, sourcePort: port };
  const pt = getCanvasPoint(e); renderTempConnection(pt.x, pt.y);
  setStatus(`Conectando de "${state.blocks[blockId]?.name}"...`);
  const portEl = blockLayer.querySelector(`[data-id="${blockId}"] .block-port[data-port="${port}"]`);
  if (portEl) portEl.classList.add('connecting');
}

function getOppositePort(sourcePort, targetBlockType) {
  const isOutput = /^(out-|right$)/.test(sourcePort);
  const isInput = /^(in-|left$)/.test(sourcePort);
  if (targetBlockType === 'machinery') {
    if (isOutput || sourcePort === 'bottom') return 'in-0';
    if (isInput || sourcePort === 'top') return 'out-0';
    return 'in-0';
  }
  if (isOutput || sourcePort === 'bottom') return 'left';
  if (isInput || sourcePort === 'top') return 'right';
  return 'left';
}

function createBlockAt(type, x, y) {
  const id = uid();
  const size = getBlockSize({ type });
  const b = {
    id, name: 'Novo Bloco',
    type,
    x: snap(x - size.w / 2),
    y: snap(y - size.h / 2),
    w: size.w, h: size.h,
    consumes: [],
    generates: [],
    ticks: 0,
    locked: false,
  };
  state.blocks[id] = b;
  clearSelection();
  state.selectedIds.push(id);
  render();
  showPropsForBlock(id);
  setStatus(`Bloco "${b.name}" criado`);
  return b;
}

function showQuickCreateMenu(sourceId, sourcePort, screenX, screenY) {
  const menu = $('quick-create-menu');
  menu.innerHTML = '';
  menu.style.left = Math.min(screenX, window.innerWidth - 200) + 'px';
  menu.style.top = Math.min(screenY, window.innerHeight - 220) + 'px';
  menu.classList.remove('hidden');
  _quickCreateShownAt = Date.now();

  const items = [
    { label: '📥 Fonte', type: 'input' },
    { label: '⚙ Máquina', type: 'processing' },
    { label: '📤 Destino', type: 'output' },
    { label: '🏭 Fábrica', type: 'machinery' },
  ];

  for (const item of items) {
    const el = document.createElement('div');
    el.className = 'ctx-item';
    el.textContent = item.label;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const pos = _quickCreatePos;
      hideQuickCreateMenu();
      if (!pos) return;
      pushHistory();
      const block = createBlockAt(item.type, pos.x, pos.y);
      if (block) {
        const srcBlock = state.blocks[sourceId];
        if (srcBlock) {
          const targetPort = getOppositePort(sourcePort, block.type);
          createConnection(sourceId, sourcePort, block.id, targetPort);
        }
      }
    });
    menu.appendChild(el);
  }
}

function hideQuickCreateMenu() {
  $('quick-create-menu').classList.add('hidden');
  _quickCreatePos = null;
}

let _tempPathEl = null;
let _selRectEl = null;
let _quickCreatePos = null;
let _quickCreateShownAt = 0;

// Collab via BroadcastChannel + WebSocket
let _collabChannel = null;
let _collabSessionId = null;
let _collabEnabled = false;
let _collabReceiveLock = false;
let _collabDebounceTimer = null;
let _collabWs = null;
let _collabTransport = null; // 'broadcast' | 'websocket'
let _collabReconnectTimer = null;
const COLLAB_CHANNEL = 'planner-collab-v1';

function toggleCollab() {
  _collabEnabled = !_collabEnabled;
  if (_collabEnabled) startCollab();
  else stopCollab();
  $('btnCollab')?.classList.toggle('active', _collabEnabled);
}

function startCollab() {
  _collabSessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let url = (state.relayUrl || '').trim();
  if (url) {
    _collabTransport = 'websocket';
    // Auto-convert https:// → wss:// and http:// → ws://
    if (url.startsWith('https://')) url = 'wss://' + url.slice(8);
    else if (url.startsWith('http://')) url = 'ws://' + url.slice(7);
    else if (!url.startsWith('ws://') && !url.startsWith('wss://')) url = 'wss://' + url;
    connectWs(url);
  } else {
    _collabTransport = 'broadcast';
    connectBroadcast();
  }
}

function stopCollab() {
  if (_collabWs) { _collabWs.close(); _collabWs = null; }
  if (_collabChannel) { _collabChannel.close(); _collabChannel = null; }
  clearTimeout(_collabReconnectTimer);
  clearTimeout(_collabDebounceTimer);
  _collabSessionId = null;
  _collabTransport = null;
  setStatus('Colaboração desativada');
}

function connectBroadcast() {
  try {
    _collabChannel = new BroadcastChannel(COLLAB_CHANNEL);
    _collabChannel.onmessage = (e) => {
      const msg = e.data;
      if (!msg || msg.session === _collabSessionId) return;
      handleCollabMessage(msg);
    };
    broadcastCollab({ type: 'join', session: _collabSessionId });
    setStatus('👥 Colaboração local ativa');
  } catch (e) {
    setStatus('Erro: ' + e.message);
    _collabEnabled = false;
  }
}

function connectWs(url) {
  try {
    _collabWs = new WebSocket(url);
    _collabWs.onopen = () => {
      setStatus('👥 Conectado ao relay');
      clearTimeout(_collabReconnectTimer);
      broadcastCollab({ type: 'join', session: _collabSessionId });
    };
    _collabWs.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'peers') { setStatus(`👥 ${msg.count} dispositivo(s) conectado(s)`); return; }
        if (msg.session === _collabSessionId) return;
        handleCollabMessage(msg);
      } catch (err) { /* ignore malformed */ }
    };
    _collabWs.onclose = () => {
      if (_collabEnabled) {
        setStatus('👥 Desconectado, reconectando...');
        _collabReconnectTimer = setTimeout(() => connectWs(url), 3000);
      }
    };
    _collabWs.onerror = () => {
      setStatus('👥 Erro de conexão');
    };
  } catch (e) {
    setStatus('Erro: ' + e.message);
    _collabEnabled = false;
  }
}

function handleCollabMessage(msg) {
  if (msg.type === 'state') {
    _collabReceiveLock = true;
    loadFullState(msg.state, true);
    _collabReceiveLock = false;
    setStatus('👥 Sincronizado');
  } else if (msg.type === 'join') {
    broadcastCollab({ type: 'state', session: _collabSessionId, state: getFullState() });
    setStatus('👥 Novo participante conectado');
  }
}

function broadcastCollab(msg) {
  if (_collabTransport === 'broadcast' && _collabChannel) {
    try { _collabChannel.postMessage(msg); } catch (e) { /* ignore */ }
  } else if (_collabTransport === 'websocket' && _collabWs && _collabWs.readyState === WebSocket.OPEN) {
    try { _collabWs.send(JSON.stringify(msg)); } catch (e) { /* ignore */ }
  }
}

function scheduleCollabSync() {
  if (!_collabEnabled || _collabReceiveLock) return;
  clearTimeout(_collabDebounceTimer);
  _collabDebounceTimer = setTimeout(() => {
    broadcastCollab({ type: 'state', session: _collabSessionId, state: getFullState() });
  }, 400);
}

function updateDraggedBlocks() {
  const dragged = state.dragging;
  if (!dragged) return;
  const draggedSet = new Set(dragged.ids);

  // Update block group transforms
  for (const id of dragged.ids) {
    const b = state.blocks[id];
    if (!b) continue;
    const el = blockLayer.querySelector(`.block-group[data-id="${id}"]`);
    if (!el) continue;
    const ox = dragged.blockOrigins[dragged.ids.indexOf(id)].x;
    const oy = dragged.blockOrigins[dragged.ids.indexOf(id)].y;
    el.setAttribute('transform', `translate(${b.x - ox}, ${b.y - oy})`);
  }

  // Reposition property popover if visible and tracking a dragged block
  if (!propsPopover.classList.contains('hidden') && _propsBlockId && draggedSet.has(_propsBlockId)) {
    const b = state.blocks[_propsBlockId];
    if (b) positionPropsPopover(b);
  }

  // Update group outlines for groups containing dragged blocks
  const groupEls = groupLayer.querySelectorAll('g[data-group-id]');
  for (const gEl of groupEls) {
    const gId = gEl.getAttribute('data-group-id');
    const g = state.groups[gId];
    if (!g) continue;
    const members = g.blocks || [];
    const anyDragged = members.some(m => draggedSet.has(m));
    if (!anyDragged) continue;
    const allBs = members.map(m => state.blocks[m]).filter(Boolean);
    if (allBs.length === 0) { gEl.style.display = 'none'; continue; }
    const minX = Math.min(...allBs.map(b => b.x)), maxX = Math.max(...allBs.map(b => b.x + getBlockSize(b).w));
    const minY = Math.min(...allBs.map(b => b.y)), maxY = Math.max(...allBs.map(b => b.y + getBlockSize(b).h));
    gEl.querySelector('.group-rect')?.setAttribute('x', minX - 8);
    gEl.querySelector('.group-rect')?.setAttribute('y', minY - 8);
    gEl.querySelector('.group-rect')?.setAttribute('width', maxX - minX + 16);
    gEl.querySelector('.group-rect')?.setAttribute('height', maxY - minY + 16);
    gEl.querySelector('.group-label')?.setAttribute('x', (minX + maxX) / 2);
    gEl.querySelector('.group-label')?.setAttribute('y', minY - 8 - 4);
    gEl.style.display = '';
  }

  // Update connection paths for connections involving dragged blocks
  const connGroups = connectionLayer.querySelectorAll('g[data-conn-id]');
  for (const g of connGroups) {
    const connId = g.getAttribute('data-conn-id');
    const conn = state.connections.find(c => c.id === connId);
    if (!conn) continue;
    if (!draggedSet.has(conn.sourceId) && !draggedSet.has(conn.targetId)) continue;

    const srcB = state.blocks[conn.sourceId];
    const tgtB = state.blocks[conn.targetId];
    if (!srcB || !tgtB) continue;

    const sp = getPortPosition(srcB, conn.sourcePort);
    const tp = getPortPosition(tgtB, conn.targetPort);
    const pathD = getConnectionPath(sp, tp, conn.sourcePort, conn.targetPort);

    g.querySelector('.connection-path')?.setAttribute('d', pathD);
    g.querySelector('.connection-hit')?.setAttribute('d', pathD);
    g.querySelector('.conn-handle-src')?.setAttribute('cx', sp.x);
    g.querySelector('.conn-handle-src')?.setAttribute('cy', sp.y);
    g.querySelector('.conn-handle-tgt')?.setAttribute('cx', tp.x);
    g.querySelector('.conn-handle-tgt')?.setAttribute('cy', tp.y);
  }
}

function renderTempConnection(x, y) {
  if (!state.connecting) return;
  const sb = state.blocks[state.connecting.sourceId];
  if (!sb) return;
  const sp = getPortPosition(sb, state.connecting.sourcePort);
  if (!_tempPathEl) {
    _tempPathEl = createSVG('path', { class: 'temp-path' });
    tempConnection.appendChild(_tempPathEl);
  }
  _tempPathEl.setAttribute('d', `M ${sp.x} ${sp.y} L ${x} ${y}`);
}

function updateTempPath(d) {
  if (!d) { clearTempConnection(); return; }
  if (!_tempPathEl) {
    _tempPathEl = createSVG('path', { class: 'temp-path' });
    tempConnection.appendChild(_tempPathEl);
  }
  _tempPathEl.setAttribute('d', d);
}

function clearTempConnection() {
  tempConnection.replaceChildren();
  _tempPathEl = null;
}

function renderSelectionBox() {
  const sb = state.selectBox; if (!sb) return;
  const x = sb.w >= 0 ? sb.x : sb.x + sb.w, y = sb.h >= 0 ? sb.y : sb.y + sb.h;
  const w = Math.abs(sb.w), h = Math.abs(sb.h);
  if (w < 3 && h < 3) return;
  if (!_selRectEl) {
    _selRectEl = createSVG('rect', { class: 'selection-rect' });
    selectionBox.appendChild(_selRectEl);
  }
  _selRectEl.setAttribute('x', x);
  _selRectEl.setAttribute('y', y);
  _selRectEl.setAttribute('width', w);
  _selRectEl.setAttribute('height', h);
}
function clearSelectionBox() {
  selectionBox.replaceChildren();
  _selRectEl = null;
}

// ===== KEYBOARD =====
document.addEventListener('keydown', (e) => {
  if (!modal.classList.contains('hidden')) { if (e.key === 'Escape') hideModal(); return; }

  // Allow Escape/Ctrl shortcuts even in inputs
  const isInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT';
  const mod = e.ctrlKey || e.metaKey;

  if (e.key === 'Escape') {
    if (isInput) { e.target.blur(); return; }
    if (!$('quick-create-menu').classList.contains('hidden')) { hideQuickCreateMenu(); clearSelection(); render(); return; }
    if (state.reconnecting) { state.reconnecting = null; clearTempConnection(); canvas.classList.remove('connecting'); render(); }
    if (state.connectMode) { state.connectMode = false; $('btnConnectMode').classList.remove('active'); canvas.classList.remove('connecting'); state.connecting = null; clearTempConnection(); }
    clearSelection(); showPropsForBlock(null); hideContextMenu(); return;
  }

  if (mod && e.key === 's') { e.preventDefault(); saveToDisk(); return; }
  if (mod && e.key === 'z' && e.shiftKey) { e.preventDefault(); redo(); setStatus('Refeito'); return; }
  if (mod && e.key === 'z') { e.preventDefault(); undo(); setStatus('Desfeito'); return; }

  if (isInput) return;

  if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelected(); return; }

  if (e.key === 'h' || e.key === 'H') { e.preventDefault(); zoomToSelection(); return; }

  if (e.key === 'p' || e.key === 'P') { e.preventDefault(); const sel = state.selectedIds.find(id => state.blocks[id]); if (sel) { showPropsForBlock(sel); } return; }
  if (e.key === '?' || (e.key === '/' && e.shiftKey)) { e.preventDefault(); showKeyboardShortcuts(); return; }

  if (mod && e.key === 'c' && e.shiftKey) { e.preventDefault(); copySelectedAsPreset(); return; }
  if (mod && e.key === 'c') { e.preventDefault(); copyBlocks(); return; }
  if (mod && e.key === 'd') { e.preventDefault(); copyBlocks(); pasteBlocks(); return; }
  if (mod && e.key === 'x') { e.preventDefault(); cutBlocks(); return; }
  if (mod && e.key === 'v') { e.preventDefault(); pasteBlocks(); return; }

  // Align shortcuts (Ctrl+Shift+arrow)
  if (mod && e.shiftKey) {
    const ids = state.selectedIds.filter(id => state.blocks[id]);
    if (ids.length < 2) return;
    pushHistory();
    if (e.key === 'ArrowLeft') alignBlocks(ids, 'left');
    else if (e.key === 'ArrowRight') alignBlocks(ids, 'right');
    else if (e.key === 'ArrowUp') alignBlocks(ids, 'top');
    else if (e.key === 'ArrowDown') alignBlocks(ids, 'bottom');
    else return;
    e.preventDefault(); render();
    return;
  }
});

// ===== CLIPBOARD (JSON Schema) =====
function clipboardSchema(data) {
  return { planner: true, version: 2, schema: 'blockflow-v2', ...data };
}

function copyBlocks() {
  const ids = state.selectedIds.filter(id => state.blocks[id]);
  if (ids.length === 0) { setStatus('Nada selecionado para copiar'); return; }
  const data = extractPresetData(ids);
  state.clipboard = data;
  const json = JSON.stringify(clipboardSchema({ blocks: data.blocks, connections: data.connections }));
  navigator.clipboard.writeText(json).catch(() => {});
  setStatus(`${ids.length} bloco(s) copiado(s) (JSON)`);
}

function cutBlocks() {
  const ids = state.selectedIds.filter(id => state.blocks[id]);
  if (ids.length === 0) { setStatus('Nada selecionado para recortar'); return; }
  copyBlocks();
  deleteSelected();
  setStatus(`${ids.length} bloco(s) recortado(s)`);
}

function pasteBlocks() {
  const tryPaste = (json) => {
    try {
      pushHistory();
      const data = JSON.parse(json);
      const src = data.blocks || data.project?.blocks || state.clipboard?.blocks;
      if (!src) { setStatus('Nada para colar'); return; }
      const srcConns = data.connections || data.project?.connections || state.clipboard?.connections || [];
      const offsetX = 30, offsetY = 30;
      const idMap = {};
      let minX = Infinity, minY = Infinity;
      for (const b of Object.values(src)) { minX = Math.min(minX, b.x); minY = Math.min(minY, b.y); }
      for (const [oldId, b] of Object.entries(src)) {
        const newId = uid(); idMap[oldId] = newId;
        state.blocks[newId] = { ...b, id: newId, x: b.x - minX + offsetX, y: b.y - minY + offsetY };
      }
      for (const conn of srcConns) {
        if (idMap[conn.sourceId] && idMap[conn.targetId])
          state.connections.push({ ...conn, id: cid(), sourceId: idMap[conn.sourceId], targetId: idMap[conn.targetId], label: conn.label || '' });
      }
      render(); clearSelection();
      setStatus('Blocos colados');
    } catch (e) { setStatus('Erro ao colar: ' + e.message); }
  };

  // Try system clipboard first
  if (navigator.clipboard && navigator.clipboard.readText) {
    navigator.clipboard.readText().then(txt => {
      if (txt) tryPaste(txt);
      else if (state.clipboard) tryPaste(JSON.stringify(state.clipboard));
      else setStatus('Nada para colar');
    }).catch(() => {
      if (state.clipboard) tryPaste(JSON.stringify(state.clipboard));
      else setStatus('Nada para colar');
    });
  } else if (state.clipboard) {
    tryPaste(JSON.stringify(state.clipboard));
  } else {
    setStatus('Nada para colar');
  }
}

// ===== TOOLBAR =====
function setupToolbar() {
  $('btnNewBlock').addEventListener('click', showNewBlockDialog);
  $('btnConnectMode').addEventListener('click', () => {
    state.connectMode = !state.connectMode;
    $('btnConnectMode').classList.toggle('active');
    canvas.classList.toggle('connecting');
    if (!state.connectMode) { state.connecting = null; clearTempConnection(); document.querySelectorAll('.block-port.connecting').forEach(el => el.classList.remove('connecting')); }
    setStatus(state.connectMode ? 'Modo conexão' : 'Modo normal');
  });
  $('btnGroup').addEventListener('click', showGroupDialog);
  $('btnSavePreset').addEventListener('click', copySelectedAsPreset);
  $('btnUngroup').addEventListener('click', () => {
    const ids = state.selectedIds.filter(id => state.blocks[id]);
    if (ids.length === 0) { showModal('Desagrupar', '<p class="hint">Selecione blocos do grupo.</p>'); return; }
    for (const g of Object.values(state.groups)) {
      if (ids.some(id => g.blocks.includes(id))) { delete state.groups[g.id]; render(); setStatus('Grupo desfeito'); return; }
    }
    showModal('Desagrupar', '<p class="hint">Nenhum grupo encontrado.</p>');
  });
  $('btnDelete').addEventListener('click', deleteSelected);
  $('btnSave').addEventListener('click', saveToDisk);
  $('btnLoad').addEventListener('click', loadFromDisk);
  $('btnExportPNG').addEventListener('click', exportPNG);
  $('btnExport').addEventListener('click', exportJSON);
  $('btnImport').addEventListener('click', importJSON);
  $('btnZoomIn').addEventListener('click', () => zoom(1.3));
  $('btnZoomOut').addEventListener('click', () => zoom(1/1.3));
  $('btnZoomSel').addEventListener('click', zoomToSelection);
  $('btnResetView').addEventListener('click', resetView);
  $('btnToggleGrid').addEventListener('click', toggleGrid);
  $('btnToggleMinimap').addEventListener('click', toggleMinimap);
  $('btnCollab').addEventListener('click', toggleCollab);
  $('btnSettings').addEventListener('click', showSettingsDialog);
  $('btnToggleGrid').classList.add('active');
  $('btnToggleMinimap').classList.add('active');

  // Block search
  document.getElementById('block-search')?.addEventListener('input', (e) => {
    state.filterText = e.target.value.toLowerCase().trim();
    render();
    if (state.filterText) {
      const matchCount = Object.values(state.blocks).filter(b => b.name.toLowerCase().includes(state.filterText)).length;
      setStatus(`Filtro: ${matchCount}/${Object.keys(state.blocks).length} blocos`);
    }
  });

  // Constants controls
  document.getElementById('btnAddConstant')?.addEventListener('click', showAddConstantDialog);

  // Palette: drag onto canvas
  for (const item of document.querySelectorAll('.palette-item')) {
    item.draggable = true;
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', item.dataset.type);
      e.dataTransfer.effectAllowed = 'copy';
    });
    item.addEventListener('dblclick', () => {
      pushHistory();
      const type = item.dataset.type;
      if (type === 'machinery') { createBlock('Nova Fábrica', 'machinery', [], []); return; }
      if (type === 'note') { createBlock('Nova nota', 'note'); return; }
      const names = { input: 'Fonte', processing: 'Máquina', output: 'Destino' };
      createBlock(`Novo ${names[type] || type}`, type, [], []);
    });
  }

  canvas.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  canvas.addEventListener('drop', (e) => {
    e.preventDefault(); pushHistory();
    const type = e.dataTransfer.getData('text/plain');
    if (!type) return;
    const pt = getCanvasPoint(e);
      const names = { input: 'Fonte', processing: 'Máquina', output: 'Destino', machinery: 'Nova Fábrica', note: 'Nova nota' };
    const size = getBlockSize({ type });
    const b = createBlock(names[type] || 'Novo Bloco', type, [], []);
    b.x = snap(pt.x - size.w/2);
    b.y = snap(pt.y - size.h/2);
    render();
  });
}

function deleteSelected() {
  pushHistory();
  const ids = [...state.selectedIds];
  if (ids.length === 0) { setStatus('Nada selecionado'); return; }
  let count = 0;
  for (const id of ids) {
    if (state.blocks[id]) { deleteBlock(id); count++; }
    else if (state.connections.find(c => c.id === id)) { deleteConnection(id); count++; }
  }
  if (count > 0) setStatus(`${count} item(ns) excluído(s)`);
}

function copySelectedAsPreset() {
  const ids = state.selectedIds.filter(id => state.blocks[id]);
  if (ids.length === 0) { setStatus('Selecione blocos para criar preset'); return; }
      showModal('Salvar como Fábrica', `
    <div class="form-group"><label>Nome</label><input type="text" id="dlg-preset-name" placeholder="ex: Máquina de Ferro"></div>
    <div class="form-group"><label>Descrição</label><input type="text" id="dlg-preset-desc" placeholder="opcional"></div>
    <div class="form-actions">
      <button class="btn-secondary" onclick="hideModal()">Cancelar</button>
      <button class="btn-primary" id="dlg-preset-confirm">Salvar</button>
    </div>
  `);
  document.getElementById('dlg-preset-confirm').addEventListener('click', () => {
      const name = document.getElementById('dlg-preset-name').value.trim() || `Fábrica ${Object.keys(state.presets).length + 1}`;
    const desc = document.getElementById('dlg-preset-desc').value.trim();
    const data = extractPresetData(ids);
    createPreset(name, desc, data);
    const gId = gid(); state.groups[gId] = { id: gId, name, blocks: [...ids] };
    hideModal(); render(); setStatus(`Preset "${name}" salvo`);
  }, { once: true });
  setTimeout(() => document.getElementById('dlg-preset-name')?.focus(), 100);
}

// ===== CYCLE DETECTION =====
function detectCycles() {
  const adj = {};
  for (const c of state.connections) {
    if (!adj[c.sourceId]) adj[c.sourceId] = [];
    adj[c.sourceId].push(c.targetId);
  }
  const visited = new Set(), stack = new Set();
  function dfs(id) {
    visited.add(id); stack.add(id);
    for (const nb of (adj[id] || [])) {
      if (stack.has(nb)) return true;
      if (!visited.has(nb) && dfs(nb)) return true;
    }
    stack.delete(id);
    return false;
  }
  for (const id of Object.keys(state.blocks)) {
    if (!visited.has(id) && dfs(id)) return true;
  }
  return false;
}

// ===== ZOOM & PAN =====
function zoom(factor) { state.view.zoom = clamp(state.view.zoom * factor, 0.2, 5); applyView(); renderMinimap(); }
function resetView() { state.view = { x: 0, y: 0, zoom: 1 }; applyView(); renderMinimap(); }

function zoomToSelection() {
  const ids = state.selectedIds.filter(id => state.blocks[id]);
  const blocks = ids.map(id => state.blocks[id]);
  if (blocks.length === 0) { fitView(); return; }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of blocks) {
    const s = getBlockSize(b);
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + s.w); maxY = Math.max(maxY, b.y + s.h);
  }
  const pad = 40;
  const areaW = (maxX - minX) + pad * 2;
  const areaH = (maxY - minY) + pad * 2;
  const zoomX = canvas.clientWidth / areaW;
  const zoomY = canvas.clientHeight / areaH;
  state.view.zoom = clamp(Math.min(zoomX, zoomY, 4), 0.2, 5);
  state.view.x = -(minX - pad);
  state.view.y = -(minY - pad);
  applyView(); renderMinimap();
}

function fitView() {
  const blocks = Object.values(state.blocks);
  if (blocks.length === 0) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of blocks) {
    const s = getBlockSize(b);
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + s.w); maxY = Math.max(maxY, b.y + s.h);
  }
  const pad = 60;
  const areaW = (maxX - minX) + pad * 2;
  const areaH = (maxY - minY) + pad * 2;
  const zoomX = canvas.clientWidth / areaW;
  const zoomY = canvas.clientHeight / areaH;
  state.view.zoom = clamp(Math.min(zoomX, zoomY, 2), 0.2, 5);
  state.view.x = -(minX - pad);
  state.view.y = -(minY - pad);
  applyView();
}

function applyView() {
  const v = state.view;
  canvas.setAttribute('viewBox', `${-v.x} ${-v.y} ${Math.max(1, canvas.clientWidth) / v.zoom} ${Math.max(1, canvas.clientHeight) / v.zoom}`);
  // Reposition props popover if visible
  if (!propsPopover.classList.contains('hidden')) {
    const selId = _propsBlockId;
    if (selId && state.blocks[selId]) {
      positionPropsPopover(state.blocks[selId]);
    }
  }
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoom(e.deltaY < 0 ? 1.1 : 1/1.1);
}, { passive: false });

canvas.addEventListener('pointerdown', (e) => {
  if (e.button === 1) { e.preventDefault(); state.panning = { startX: e.clientX, startY: e.clientY, viewX: state.view.x, viewY: state.view.y }; canvas.classList.add('dragging'); state.selectBox = null; }
});
canvas.addEventListener('dblclick', (e) => {
  const blockEl = e.target.closest('.block-group');
  if (blockEl) {
    const bid = blockEl.getAttribute('data-id');
    const b = state.blocks[bid];
    if (b && b.type === 'note') {
      selectBlock(bid);
      showPropsForBlock(bid);
      requestAnimationFrame(() => {
        const ta = document.querySelector('#prop-name');
        if (ta) { ta.focus(); ta.select(); }
      });
    }
    return;
  }
  // Double click on connection label → open props
  const connEl = e.target.closest('.connection-label');
  if (connEl) {
    const connId = connEl.getAttribute('data-id');
    if (connId) {
      clearSelection();
      state.selectedIds.push(connId);
      render();
      showPropsForConnection(connId);
      setTimeout(() => document.getElementById('conn-label')?.select(), 100);
    }
  }
});
document.addEventListener('pointermove', (e) => {
  if (state.panning) {
    const dx = e.clientX - state.panning.startX;
    const dy = e.clientY - state.panning.startY;
    if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    state.view.x = state.panning.viewX + dx / state.view.zoom;
    state.view.y = state.panning.viewY + dy / state.view.zoom;
    applyView();
    renderMinimap();
  }
});
document.addEventListener('pointerup', (e) => {
  if (state.panning) { state.panning = null; canvas.classList.remove('dragging'); }
});

function showKeyboardShortcuts() {
  showModal('⌨️ Atalhos de Teclado', `
    <style>
      .shortcuts-grid { display:grid;grid-template-columns:1fr 2fr;gap:4px 12px;font-size:12px;margin-top:8px }
      .shortcuts-grid .key { color:#ffc107;font-weight:700;font-family:monospace;background:#333;padding:1px 6px;border-radius:3px;text-align:center }
      .shortcuts-grid .desc { color:#ccc }
      .shortcuts-grid .header { font-weight:700;color:#fff;grid-column:span 2;margin-top:8px;border-bottom:1px solid #444;padding-bottom:2px }
    </style>
    <div class="shortcuts-grid">
      <div class="header">Geral</div>
      <span class="key">?</span><span class="desc">Abrir esta janela de atalhos</span>
      <span class="key">Del</span><span class="desc">Excluir selecionado(s)</span>
      <span class="key">Esc</span><span class="desc">Limpar seleção / sair de modo conexão</span>
      <span class="key">Ctrl+Z</span><span class="desc">Desfazer</span>
      <span class="key">Ctrl+Shift+Z</span><span class="desc">Refazer</span>
      <span class="key">Ctrl+S</span><span class="desc">Salvar no navegador</span>

      <div class="header">Copiar / Colar</div>
      <span class="key">Ctrl+C</span><span class="desc">Copiar blocos selecionados</span>
      <span class="key">Ctrl+V</span><span class="desc">Colar blocos</span>
      <span class="key">Ctrl+X</span><span class="desc">Recortar (copiar + deletar)</span>
      <span class="key">Ctrl+D</span><span class="desc">Duplicar selecionados</span>
      <span class="key">Ctrl+Shift+C</span><span class="desc">Copiar como Preset</span>

      <div class="header">Zoom / Visão</div>
      <span class="key">H</span><span class="desc">Zoom na seleção</span>
      <span class="key">Ctrl+Scroll</span><span class="desc">Zoom in/out</span>
      <span class="key">Scroll</span><span class="desc">Pan vertical</span>
      <span class="key">Meio-botão</span><span class="desc">Arrastar para pan</span>

      <div class="header">Alinhar (Ctrl+Shift + →←↑↓)</div>
      <span class="key">→</span><span class="desc">Alinhar à direita (2+)</span>
      <span class="key">←</span><span class="desc">Alinhar à esquerda (2+)</span>
      <span class="key">↑</span><span class="desc">Alinhar ao topo (2+)</span>
      <span class="key">↓</span><span class="desc">Alinhar à base (2+)</span>
    </div>
  `);
}

// ===== PERSISTENCE =====
function getFullState() { return { blocks: state.blocks, connections: state.connections, groups: state.groups, _uid, _cid, _gid }; }

function loadFullState(data, skipHistory) {
  if (!skipHistory) pushHistory();
  state.blocks = {}; state.connections = []; state.groups = {};
  // Normalize blocks from saved data
  if (data.blocks) {
    for (const [id, b] of Object.entries(data.blocks)) {
      state.blocks[id] = {
        ...b,
        consumes: (b.consumes || []).map(normalizeItem),
        generates: (b.generates || []).map(normalizeItem),
      };
      // Ensure correct dimensions
      const size = b.type === 'machinery' ? { w: MACH_W, h: MACH_H } : { w: PROC_W, h: PROC_H };
      state.blocks[id].w = size.w; state.blocks[id].h = size.h;
    }
  }
  state.connections = data.connections || [];
  state.groups = data.groups || {};
  if (data._uid) _uid = data._uid;
  if (data._cid) _cid = data._cid;
  if (data._gid) _gid = data._gid;
  state.selectedIds = []; state.connectMode = false; state.connecting = null;
  $('btnConnectMode').classList.remove('active'); canvas.classList.remove('connecting');
  render(); applyView();
}

function hasProject() {
  return Object.keys(state.blocks).length > 0 || state.connections.length > 0;
}

function confirmOverwrite(action) {
  if (!hasProject()) { action(); return; }
  showModal('Confirmar', `
    <p style="font-size:13px;color:#ccc;margin-bottom:12px">Tem certeza? O projeto atual será substituído.</p>
    <div class="form-actions">
      <button class="btn-secondary" onclick="hideModal()">Cancelar</button>
      <button class="btn-primary" id="dlg-confirm-overwrite">Sim, substituir</button>
    </div>
  `);
  document.getElementById('dlg-confirm-overwrite').addEventListener('click', () => {
    hideModal(); action();
  }, { once: true });
}

function saveToDisk() {
  try {
    const json = JSON.stringify(getFullState());
    if (json.length > 4.5e6) { setStatus('Erro: projeto muito grande para salvar'); return; }
    localStorage.setItem('planner_state', json); setStatus('Projeto salvo!');
  }
  catch (e) { setStatus('Erro: ' + e.message); }
}
function loadFromDisk() {
  confirmOverwrite(() => {
    try {
      const data = localStorage.getItem('planner_state');
      if (!data) { showModal('Carregar', '<p class="hint">Nenhum projeto salvo.</p>'); return; }
      loadFullState(JSON.parse(data)); setStatus('Projeto carregado!');
    } catch (e) { setStatus('Erro: ' + e.message); }
  });
}

function exportJSON() {
  const data = { version: 2, project: getFullState(), presets: state.presets, constants: state.constants };
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `maquinario-${new Date().toISOString().slice(0,10)}.json`;
  a.click(); URL.revokeObjectURL(url); setStatus('Exportado JSON!');
}

function exportPNG() {
  const svgClone = canvas.cloneNode(true);
  // Aplica viewBox atual para capturar a área visível
  const vb = canvas.getAttribute('viewBox');
  svgClone.setAttribute('viewBox', vb);
  const rect = svgClone.querySelector('#grid-bg');
  if (rect) rect.setAttribute('fill', '#1a1a2e');
  // Remove elementos interativos (handles, temp)
  svgClone.querySelectorAll('.conn-handle, .temp-path, .selection-rect').forEach(el => el.remove());
  const serializer = new XMLSerializer();
  const svgStr = serializer.serializeToString(svgClone);
  const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    const scale = 2;
    const cvs = document.createElement('canvas');
    cvs.width = img.width * scale;
    cvs.height = img.height * scale;
    const ctx = cvs.getContext('2d');
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    cvs.toBlob((pngBlob) => {
      const pngUrl = URL.createObjectURL(pngBlob);
      const a = document.createElement('a');
      a.href = pngUrl;
      a.download = `maquinario-${new Date().toISOString().slice(0,10)}.png`;
      a.click();
      URL.revokeObjectURL(pngUrl);
      setStatus('Exportado PNG!');
    }, 'image/png');
  };
  img.src = url;
}

function importJSON() {
  const input = document.createElement('input'); input.type = 'file'; input.accept = '.json';
  input.addEventListener('change', () => {
    const file = input.files[0]; if (!file) return;
    confirmOverwrite(() => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = JSON.parse(e.target.result);
          if (data.project) loadFullState(data.project);
          if (data.presets) { Object.assign(state.presets, data.presets); savePresets(); renderPresets(); }
          if (data.constants) { state.constants = data.constants; saveConstants(); renderConstants(); }
          setStatus('Importado!');
        } catch (err) { setStatus('Erro: ' + err.message); }
      };
      reader.readAsText(file);
    });
  });
  input.click();
}

document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (!file || !file.name.endsWith('.json')) return;
  confirmOverwrite(() => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (data.project) loadFullState(data.project);
        setStatus('Arquivo importado!');
      } catch (err) { setStatus('Erro'); }
    };
    reader.readAsText(file);
  });
});

// Warn before closing with unsaved changes
window.addEventListener('beforeunload', (e) => {
  if (hasProject()) {
    e.preventDefault();
    e.returnValue = '';
  }
});

function setStatus(msg) { statusText.textContent = msg; }

// ===== TOGGLES =====
function toggleGrid() {
  state.showGrid = !state.showGrid;
  const el = document.getElementById('grid-bg');
  if (el) el.style.display = state.showGrid ? '' : 'none';
  $('btnToggleGrid').classList.toggle('active', state.showGrid);
}
function toggleMinimap() {
  state.showMinimap = !state.showMinimap;
  const el = document.getElementById('canvas-minimap');
  if (el) el.style.display = state.showMinimap ? '' : 'none';
  $('btnToggleMinimap').classList.toggle('active', state.showMinimap);
}

// ===== INIT =====
function init() {
  setupToolbar();
  setupPropsDelegation();
  applyView();
  new ResizeObserver(() => applyView()).observe(canvas);

  const saved = localStorage.getItem('planner_state');
  if (saved) { try { loadFullState(JSON.parse(saved)); setStatus('Projeto carregado'); } catch (e) { console.warn('Failed to load saved state:', e); } }

  // Populate default constants if empty
  if ((state.constants.items || []).length === 0) {
    populateDefaultConstants();
  }
  syncAutocompleteDatalist();

  // Minimap click navigation
  const minimapEl = document.getElementById('canvas-minimap');
  minimapEl?.addEventListener('click', (e) => {
    const rect = minimapEl.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const svg = minimapEl.querySelector('svg');
    if (!svg) return;
    const vb = svg.viewBox.baseVal;
    const pctX = mx / rect.width;
    const pctY = my / rect.height;
    const worldX = vb.x + pctX * vb.width - canvas.clientWidth / state.view.zoom / 2;
    const worldY = vb.y + pctY * vb.height - canvas.clientHeight / state.view.zoom / 2;
    state.view.x = -worldX;
    state.view.y = -worldY;
    applyView(); renderMinimap();
  });

  if (Object.keys(state.blocks).length === 0) createExample();
  fitView();
  pushHistory();
  setInterval(() => {
    if (hasProject()) { localStorage.setItem('planner_state', JSON.stringify(getFullState())); }
  }, 30000);
  setStatus('Pronto — clique direito para menu contextual');

  // Props popover close
  $('props-popover-close')?.addEventListener('click', () => {
    propsPopover.classList.remove('visible');
    propsPopover.classList.add('hidden');
  });

  // Props popover drag
  let popoverDrag = null;
  const popoverHead = $('props-popover-header');
  popoverHead?.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#props-popover-close')) return;
    const rect = propsPopover.getBoundingClientRect();
    popoverDrag = { startX: e.clientX, startY: e.clientY, left: rect.left, top: rect.top };
    popoverHead.style.cursor = 'grabbing';
  });
  document.addEventListener('pointermove', (e) => {
    if (popoverDrag) {
      propsPopover.style.left = (popoverDrag.left + e.clientX - popoverDrag.startX) + 'px';
      propsPopover.style.top = (popoverDrag.top + e.clientY - popoverDrag.startY) + 'px';
    }
  });
  document.addEventListener('pointerup', () => {
    if (popoverDrag) { popoverDrag = null; popoverHead.style.cursor = 'move'; }
  });

  // Sidebar toggle
  document.getElementById('toggle-left').addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar-left');
    const btn = document.getElementById('toggle-left');
    sidebar.classList.toggle('collapsed');
    btn.textContent = sidebar.classList.contains('collapsed') ? '▶' : '◀';
    setTimeout(renderMinimap, 300);
  });
  document.getElementById('toggle-right').addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar-right');
    const btn = document.getElementById('toggle-right');
    sidebar.classList.toggle('collapsed');
    btn.classList.toggle('collapsed');
    btn.textContent = sidebar.classList.contains('collapsed') ? '◀' : '▶';
    setTimeout(renderMinimap, 300);
  });
}

function createExample() {
  // --- Fluxo VERTICAL de Processos ---
  // Entrada (topo) → Processamento (meio) → Saída (base)
  const mina = createBlock('⛏ Mina', 'input', [], [makeItem('minério bruto', 3, 'item', 'primary')]);
  mina.x = 40; mina.y = 20;

  const fornalha = createBlock('🔥 Fornalha', 'processing',
    [makeItem('minério bruto', 3, 'item', 'primary'), makeItem('carvão', 1, 'item', 'secondary')],
    [makeItem('lingote', 2, 'item', 'primary')]
  );
  fornalha.x = 40; fornalha.y = 140; fornalha.ticks = 40;

  const baú = createBlock('📦 Baú', 'output', [makeItem('lingote', 2, 'item', 'primary')], []);
  baú.x = 40; baú.y = 260;

  createConnection(mina.id, 'bottom', fornalha.id, 'top');
  createConnection(fornalha.id, 'bottom', baú.id, 'top');

  // --- Maquinário em HORIZONTAL ---
  // Recebe insumos pela esquerda, expele produtos pela direita
  const carvão = createBlock('🪨 Carvão', 'input', [], [makeItem('carvão', 2, 'item', 'secondary')]);
  carvão.x = 300; carvão.y = 20;

  const agua = createBlock('💧 Água', 'input', [], [makeItem('água', 1, 'liquid', 'secondary')]);
  agua.x = 300; agua.y = 100;

  const mach = createBlock('🏭 Máquina de Aço', 'machinery',
    [makeItem('lingote', 2, 'item', 'primary'), makeItem('carvão', 2, 'item', 'secondary'), makeItem('água', 1, 'liquid', 'secondary')],
    [makeItem('aço', 1, 'item', 'primary'), makeItem('escória', 1, 'item', 'secondary')]
  );
  mach.x = 460; mach.y = 60; mach.ticks = 80;

  const saidaAco = createBlock('✅ Aço', 'output', [makeItem('aço', 1, 'item', 'primary')], []);
  saidaAco.x = 710; saidaAco.y = 60;

  const saidaEscoria = createBlock('⬜ Escória', 'output', [makeItem('escória', 1, 'item', 'secondary')], []);
  saidaEscoria.x = 710; saidaEscoria.y = 180;

  // Conexões do maquinário
  createConnection(fornalha.id, 'right', mach.id, 'in-0');
  createConnection(carvão.id, 'bottom', mach.id, 'in-1');
  createConnection(agua.id, 'bottom', mach.id, 'in-2');
  createConnection(mach.id, 'out-0', saidaAco.id, 'left');
  createConnection(mach.id, 'out-1', saidaEscoria.id, 'top');

  clearSelection();
    setStatus('✅ Máquinas em VERTICAL | Fábricas em HORIZONTAL');
}

document.addEventListener('DOMContentLoaded', init);
window.createBlock = createBlock; window.hideModal = hideModal;
