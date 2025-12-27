/**
 * Draw.io Plugin: ChangeMap + CreateMap (Scope + Time Slice + Navigate)
 *
 * Features
 * - Right-click menu: Show/Hide ChangeMap, Show/Hide CreateMap
 * - Overlay UI (top-right of graph):
 *   - Mode: ChangeMap / CreateMap
 *   - Scope: Diagram / Selection / Subtree (single selected root)
 *   - Time slice: last N (minutes/hours/days); out-of-range cells are de-emphasized
 *   - Navigate: Prev/Next + clickable list of top N matches (newest-first or oldest-first)
 *
 * Persistent attributes on each cell:
 * - createdAt      : epoch ms (write-once on insert if missing)
 * - lastEditedAt   : epoch ms (only for user-selected edits during a short input window)
 * - origStyle      : persisted original style string (write-once on first map apply; removed on restore)
 */

Draw.loadPlugin(function (ui) {
  const graph = ui && ui.editor && ui.editor.graph;
  if (!graph) return;

  if (graph.__ccMapInstalled) return;
  graph.__ccMapInstalled = true;

  const model = graph.getModel();

  // -------------------- Config --------------------

  const ATTR_CREATED = 'createdAt';
  const ATTR_EDITED = 'lastEditedAt';
  const ATTR_ORIG_STYLE = 'origStyle';

  const MODE_NONE = 'none';
  const MODE_CHANGE = 'changemap';
  const MODE_CREATE = 'createdmap';

  const SCOPE_DIAGRAM = 'diagram';
  const SCOPE_SELECTION = 'selection';
  const SCOPE_SUBTREE = 'subtree';

  const COLOR_RAMP = [
    '#2509FF', // blue (oldest)
    '#5e5ce6', // purple
    '#ff3b30', // red
    '#ff9f0a', // orange
    '#ffd60a', // yellow
    '#a8e063', // yellow-green
    '#34c759'  // green (newest)
  ];

  const VERTEX_WIDTH_MIN = 2;
  const VERTEX_WIDTH_MAX = 5;
  const EDGE_WIDTH_MIN = 1;
  const EDGE_WIDTH_MAX = 10;

  const UNKNOWN_STYLE = { strokeColor: '#c7c7cc', dashed: 1, strokeOpacity: 60 };
  const OUT_OF_RANGE_STYLE = { strokeColor: '#c7c7cc', dashed: 1, strokeOpacity: 25 };

  const ATTR_LOD_SUMMARY = 'lod_summary';

  function isLodSummaryCell(cell) {
    return getAttrStr(cell, ATTR_LOD_SUMMARY) === '1';
  }

  graph.__ccPasteUntil = 0;                                                                   // NEW
  graph.__ccPasteIds = new Set();                                                             // NEW
  const PASTE_WINDOW_MS = 250;                                                                // NEW


  // Input window for "user action" gating
  const USER_ACTION_WINDOW_MS = 1000;

  // List size for click-to-navigate
  const NAV_LIST_MAX = 200;


  // -------------------- Responsive apply scheduler --------------------  
  const APPLY_DEBOUNCE_MS = 1000;
  const APPLY_BATCH_SIZE = 300;
  graph.__ccApplyTimer = null;
  graph.__ccApplyToken = 0;
  graph.__ccApplyQueued = false;

  function scheduleRefreshIfEnabled() {
    if (graph.__ccMode === MODE_NONE) return;
    if (graph.__ccApplyTimer) clearTimeout(graph.__ccApplyTimer);
    graph.__ccApplyTimer = setTimeout(() => {
      graph.__ccApplyTimer = null;
      applyMapBatched(graph.__ccMode);
    }, APPLY_DEBOUNCE_MS);
  }


  // -------------------- State --------------------

  graph.__ccMapInternalChange = false;

  graph.__ccMode = MODE_NONE;
  graph.__ccScope = SCOPE_DIAGRAM;

  graph.__ccWindowValue = 7;        // default: last 7 days
  graph.__ccWindowUnit = 'days';    // minutes | hours | days

  graph.__ccSortOrder = 'newest';   // Newest | oldest
  graph.__ccFiltered = [];          // current filtered cells (for navigation)
  graph.__ccNavIndex = 0;


  // -------------------- Zoom-aware stroke width --------------------     // NEW
  graph.__ccZoomStrokeMult = 1;                                            // NEW
  graph.__ccLastScale = null;                                              // NEW

  function getGraphScale() {                                               // NEW
    return (graph.view && typeof graph.view.scale === 'number')            // NEW
      ? graph.view.scale                                                   // NEW
      : 1;                                                                 // NEW
  }                                                                        // NEW

  function computeZoomStrokeMult(scale) {                                  // NEW
    // Scale-aware: when zoomed out (<1), increase stroke widths.           // NEW
    // Clamp to prevent absurd widths.                                      // NEW
    const s = Math.max(0.2, Number(scale) || 1);                           // NEW
    const mult = 1 / s;                                                    // NEW
    return Math.max(1, Math.min(4, mult));                                 // NEW
  }                                                                        // NEW

  function updateZoomStrokeMult() {                                        // NEW
    const s = getGraphScale();                                             // NEW
    if (graph.__ccLastScale != null && Math.abs(s - graph.__ccLastScale) < 0.001) return; // NEW
    graph.__ccLastScale = s;                                               // NEW
    graph.__ccZoomStrokeMult = computeZoomStrokeMult(s);                   // NEW
  }                                                                        // NEW


  // User action gating state
  graph.__ccUserActionActive = false;
  graph.__ccUserActionUntil = 0;
  graph.__ccUserActionSelIds = new Set();

  // -------------------- Small utilities --------------------

  function nowMs() { return Date.now(); }

  function isCell(obj) {
    return obj != null && typeof obj === 'object' && typeof obj.getId === 'function';
  }

  function isVertex(cell) { return !!(cell && model.isVertex(cell)); }
  function isEdge(cell) { return !!(cell && model.isEdge(cell)); }

  function shouldStyleCell(cell) {
    if (!cell) return false;
    if (cell === model.getRoot()) return false;
    if (isLodSummaryCell(cell)) return false;
    if (shouldIgnoreBecauseInTilerGroup(cell)) return false;
    return isVertex(cell) || isEdge(cell);
  }



  function getAttrStr(cell, key) {
    if (!cell || typeof cell.getAttribute !== 'function') return null;
    const v = cell.getAttribute(key);
    if (v == null || v === '') return null;
    return String(v);
  }

  function getAttrMs(cell, key) {
    const raw = getAttrStr(cell, key);
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  function ensureXmlValue(cell) {                                                            // NEW
    if (!cell) return false;                                                                  // NEW
    const v = cell.value;                                                                     // NEW
    const isXml = v && typeof v === 'object' && typeof v.nodeName === 'string';               // NEW
    if (isXml) return true;                                                                   // NEW

    // Create an XML user object and preserve the visible label if present.                   // NEW
    const doc = mxUtils.createXmlDocument();                                                  // NEW
    const obj = doc.createElement('object');                                                  // NEW
    const label = (v != null) ? String(v) : '';                                               // NEW
    if (label) obj.setAttribute('label', label);                                              // NEW

    model.setValue(cell, obj);                                                                // NEW
    return true;                                                                              // NEW
  }


  function setAttrMs(cell, key, ms) {
    if (!cell) return;                                                                        // FIX
    ensureXmlValue(cell);                                                                     // NEW
    if (typeof cell.setAttribute !== 'function') return;                                      // FIX
    cell.setAttribute(key, String(ms));
  }


  function removeAttr(cell, key) {
    if (!cell) return;
    if (typeof cell.removeAttribute === 'function') cell.removeAttribute(key);
    else if (typeof cell.setAttribute === 'function') cell.setAttribute(key, '');
  }

  function clamp01(x) {
    if (x < 0) return 0;
    if (x > 1) return 1;
    return x;
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  function hexToRgb(hex) {
    const h = (hex || '').replace('#', '').trim();
    if (h.length !== 6) return null;
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
    return { r, g, b };
  }

  function rgbToHex(rgb) {
    function to2(n) {
      const s = Math.max(0, Math.min(255, Math.round(n))).toString(16);
      return s.length === 1 ? '0' + s : s;
    }
    return '#' + to2(rgb.r) + to2(rgb.g) + to2(rgb.b);
  }

  function lerpColor(aHex, bHex, t) {
    const a = hexToRgb(aHex);
    const b = hexToRgb(bHex);
    if (!a || !b) return aHex;
    return rgbToHex({
      r: lerp(a.r, b.r, t),
      g: lerp(a.g, b.g, t),
      b: lerp(a.b, b.b, t)
    });
  }

  function lerpColorRamp(colors, p) {
    if (!colors || colors.length === 0) return '#000000';
    if (colors.length === 1) return colors[0];

    const n = colors.length - 1;
    const scaled = clamp01(p) * n;
    const i = Math.floor(scaled);
    const t = scaled - i;

    const c0 = colors[Math.max(0, Math.min(n, i))];
    const c1 = colors[Math.max(0, Math.min(n, i + 1))];

    return lerpColor(c0, c1, t);
  }

  function parseStyle(styleStr) {
    const out = Object.create(null);
    const s = styleStr || '';
    const parts = s.split(';');
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p) continue;
      const eq = p.indexOf('=');
      if (eq < 0) out[p] = '';
      else out[p.substring(0, eq)] = p.substring(eq + 1);
    }
    return out;
  }

  function styleToString(styleObj) {
    const keys = Object.keys(styleObj);
    keys.sort();
    let s = '';
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const v = styleObj[k];
      s += (v === '' ? (k + ';') : (k + '=' + v + ';'));
    }
    return s;
  }

  function mergeStyle(baseStyleStr, overrides) {
    const o = parseStyle(baseStyleStr);

    if (overrides.strokeColor != null) o.strokeColor = String(overrides.strokeColor);
    if (overrides.strokeWidth != null) o.strokeWidth = String(overrides.strokeWidth);
    if (overrides.dashed != null) o.dashed = String(overrides.dashed);
    if (overrides.strokeOpacity != null) o.strokeOpacity = String(overrides.strokeOpacity);

    return styleToString(o);
  }

  function iterAllCells(fn) {
    const root = model.getRoot();
    if (!root) return;
    (function visit(cell) {
      fn(cell);
      const n = model.getChildCount(cell);
      for (let i = 0; i < n; i++) visit(model.getChildAt(cell, i));
    })(root);
  }

  function modeKey(mode) {
    return mode === MODE_CHANGE ? ATTR_EDITED : ATTR_CREATED;
  }

  function isDirectEditChange(ch) {
    const n = ch && ch.constructor && ch.constructor.name;
    return n === 'mxStyleChange' ||
      n === 'mxValueChange' ||
      n === 'mxTerminalChange' ||
      n === 'mxGeometryChange' ||
      n === 'mxCollapseChange' ||
      n === 'mxVisibleChange';
  }

  // -------------------- Tiler-group ignore --------------------

  const TILER_GROUP_STYLE_KEY = 'tiler_group';
  const TILER_GROUP_STYLE_VAL = '1';

  function getStyle(cell) {
    return (cell && typeof cell.getStyle === 'function') ? (cell.getStyle() || '') : (cell && cell.style ? cell.style : '') || '';
  }

  function getStoredStyle(cell) {                                                             // NEW
    if (!cell) return '';
    // Prefer the raw property if present (most direct)                                         // NEW
    if (typeof cell.style === 'string') return cell.style || '';                               // NEW
    // Fallback to API                                                                          // NEW
    if (typeof cell.getStyle === 'function') return cell.getStyle() || '';                     // NEW
    return '';
  }
  

  function isTilerGroup(cell) {
    if (!cell) return false;
    const st = getStoredStyle(cell);                                                          // FIX
    const styleHit = /(?:^|;)tiler_group=1(?:;|$)/.test(st);                                  // FIX
    const attrHit = getAttrStr(cell, 'tiler_group') === '1';                                  // NEW
    return styleHit || attrHit;                                                               // FIX
  }
  
  function hasTilerGroupAncestor(cell) {
    if (!cell) return false;
    let p = model.getParent(cell);
    while (p) {
      if (isTilerGroup(p)) return true;
      p = model.getParent(p);
    }
    return false;
  }

  function shouldIgnoreBecauseInTilerGroup(cell) {
    // Ignore descendants, but NOT the tiler group cell itself
    return !!cell && !isTilerGroup(cell) && hasTilerGroupAncestor(cell);
  }


  // -------------------- Timestamp stamping --------------------

  function stampCreatedIfMissing(cell, tNow) {
    if (!shouldStyleCell(cell)) return;
    if (getAttrMs(cell, ATTR_CREATED) == null) setAttrMs(cell, ATTR_CREATED, tNow);
  }

  function stampEdited(cell, tNow) {
    if (!shouldStyleCell(cell)) return;
    setAttrMs(cell, ATTR_EDITED, tNow);
  }

  function snapshotSelectionIds() {
    const sel = (graph.getSelectionCells && graph.getSelectionCells()) || [];
    const ids = new Set();
    for (let i = 0; i < sel.length; i++) {
      const c = sel[i];
      if (c && c.id) ids.add(c.id);
    }
    return ids;
  }

  function beginUserActionWindow() {
    graph.__ccUserActionActive = true;
    graph.__ccUserActionUntil = nowMs() + USER_ACTION_WINDOW_MS;

    // Snapshot after selection has had a chance to update from the click.               // FIX
    setTimeout(function () {                                                            // FIX
      graph.__ccUserActionSelIds = snapshotSelectionIds();                               // FIX
    }, 0);                                                                              // FIX
  }


  function endUserActionWindowIfExpired() {
    if (!graph.__ccUserActionActive) return;
    if (nowMs() > graph.__ccUserActionUntil) {
      graph.__ccUserActionActive = false;
      graph.__ccUserActionSelIds = new Set();
    }
  }

  function stampEditedFromSelectedIntersection(edit) {
    endUserActionWindowIfExpired();
    if (!graph.__ccUserActionActive) return false;

    const selIds = graph.__ccUserActionSelIds;
    if (!selIds || selIds.size === 0) return false;

    const changes = (edit && edit.changes) || [];
    const touched = new Map();
    const tNow = nowMs();                                                                  // FIX
    let did = false;                                                                       // NEW

    for (let i = 0; i < changes.length; i++) {
      const ch = changes[i];
      if (!isDirectEditChange(ch)) continue;                                               // FIX

      const cell = ch.cell || ch.child || null;
      if (!cell || !cell.id) continue;
      if (!selIds.has(cell.id)) continue;                                                  // NEW (selection intersection)
      if (!shouldStyleCell(cell)) continue;
      if (shouldIgnoreBecauseInTilerGroup(cell)) continue;

      touched.set(cell.id, cell);                                                          // FIX
    }

    if (touched.size === 0) return false;

    model.beginUpdate();
    try {
      for (const cell of touched.values()) {
        stampCreatedIfMissing(cell, tNow);                                                 // keep createdAt stable
        stampEdited(cell, tNow);
        did = true;                                                                        // NEW
      }
    } finally {
      model.endUpdate();
    }

    return did;
  }

  function stampCreatedOnInsert(edit) {
    const changes = (edit && edit.changes) || [];
    const tNow = nowMs();
    let did = false;

    model.beginUpdate();
    try {
      for (let i = 0; i < changes.length; i++) {
        const ch = changes[i];
        const name = ch && ch.constructor && ch.constructor.name;
        if (name !== 'mxChildChange') continue;                                            // FIX

        const child = ch.child || ch.cell;                                                 // FIX
        if (!child || !child.id) continue;
        if (!shouldStyleCell(child)) continue;
        if (shouldIgnoreBecauseInTilerGroup(child)) continue;

        // Insert-like: child is being attached to a parent
        // mxChildChange commonly has ch.parent when attached, and ch.previous when detached
        const isAttach = (ch.parent != null);                                              // NEW
        if (!isAttach) continue;                                                           // NEW

        if (getAttrMs(child, ATTR_CREATED) == null) {                                      // FIX
          setAttrMs(child, ATTR_CREATED, tNow);
          did = true;
        }
      }
    } finally {
      model.endUpdate();
    }

    return did;
  }

  // Input hooks (keep tight to reduce false positives)
  if (graph.container) {
    graph.container.addEventListener('mousedown', beginUserActionWindow, true);
    graph.container.addEventListener('mouseup', beginUserActionWindow, true);           // NEW
    graph.container.addEventListener('touchstart', beginUserActionWindow, true);
    graph.container.addEventListener('touchend', beginUserActionWindow, true);          // NEW
  }

  document.addEventListener('keydown', beginUserActionWindow, true);

  // -------------------- origStyle persist/restore --------------------

  const NULL_STYLE_SENTINEL = '__NULL_STYLE__';                                               // NEW

  function ensureOrigStyle(cell) {
    if (!shouldStyleCell(cell)) return;
    const orig = getAttrStr(cell, ATTR_ORIG_STYLE);
    if (orig != null) return;
  
    const st = (typeof cell.getStyle === 'function') ? cell.getStyle() : (cell.style || null); // FIX
    cell.setAttribute(ATTR_ORIG_STYLE, st == null ? NULL_STYLE_SENTINEL : String(st));       // FIX
  }

  function baseStyleForApply(cell) {
    const orig = getAttrStr(cell, ATTR_ORIG_STYLE);
    if (orig === NULL_STYLE_SENTINEL) return null;                                            // NEW
    return orig != null ? orig : ((cell.getStyle && cell.getStyle()) || null);                // FIX
  }

  // -------------------- Scope + filtering --------------------

  function collectScopeCells(scope) {
    if (scope === SCOPE_SELECTION) return collectSelectionCellsOnly();
    if (scope === SCOPE_SUBTREE) return collectSubtreeCellsFromSingleSelection();
    return collectDiagramCells();
  }

  function collectDiagramCells() {
    const out = [];
    iterAllCells(function (cell) {
      if (shouldStyleCell(cell)) out.push(cell);
    });
    return out;
  }

  function collectSelectionCellsOnly() {
    const sel = (graph.getSelectionCells && graph.getSelectionCells()) || [];
    const out = [];
    const seen = new Set();
    for (let i = 0; i < sel.length; i++) {
      const c = sel[i];
      if (!c || !c.id) continue;
      if (!shouldStyleCell(c)) continue;
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
    }
    return out;
  }

  function collectSubtreeCellsFromSingleSelection() {
    const sel = (graph.getSelectionCells && graph.getSelectionCells()) || [];
    if (sel.length !== 1) return collectSelectionCellsOnly();

    const root = sel[0];
    const out = [];
    (function visit(cell) {
      if (shouldStyleCell(cell)) out.push(cell);

      // If this cell is a tiler group, do not include its descendants               
      if (isTilerGroup(cell)) return;

      const n = model.getChildCount(cell);
      for (let i = 0; i < n; i++) visit(model.getChildAt(cell, i));
    })(root);

    return out;
  }

  function windowMsFromSettings() {
    const v = Number(graph.__ccWindowValue);
    if (!Number.isFinite(v) || v <= 0) return null;

    const unit = graph.__ccWindowUnit;
    if (unit === 'minutes') return v * 60 * 1000;
    if (unit === 'hours') return v * 60 * 60 * 1000;
    return v * 24 * 60 * 60 * 1000; // days default
  }

  function getTimestampForMode(cell, mode) {
    if (mode === MODE_CHANGE) {                                        // NEW
      const edited = getAttrMs(cell, ATTR_EDITED);                     // NEW
      if (edited != null) return edited;                               // NEW
      return getAttrMs(cell, ATTR_CREATED);                            // NEW (fallback)
    }
    // MODE_CREATE
    return getAttrMs(cell, ATTR_CREATED);
  }
  

  function filterCellsByTimeSlice(cells, mode) {
    const ms = windowMsFromSettings();
    if (ms == null) {
      // no slicing: include all timestamped cells for range; still keep non-ts cells for unknown styling
      return { inRange: cells.slice(), tMin: null, tMax: null, windowMs: null };
    }

    const cutoff = nowMs() - ms;
    const inRange = [];
    let tMin = Infinity;
    let tMax = -Infinity;

    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const ts = getTimestampForMode(c, mode);
      if (ts == null) continue;
      if (ts < cutoff) continue;
      inRange.push(c);
      if (ts < tMin) tMin = ts;
      if (ts > tMax) tMax = ts;
    }

    if (inRange.length === 0) return { inRange: [], tMin: null, tMax: null, windowMs: ms };
    return { inRange, tMin, tMax, windowMs: ms };
  }

  function positionForTimestamp(ts, tMin, tMax) {
    const span = (tMax - tMin);
    if (span <= 0) return 1;
    return clamp01((ts - tMin) / span);
  }

  function widthFromP(cell, p) {
    updateZoomStrokeMult();                                                // NEW
    const m = graph.__ccZoomStrokeMult || 1;                               // NEW
    if (isVertex(cell)) return lerp(VERTEX_WIDTH_MIN, VERTEX_WIDTH_MAX, p) * m; // FIX
    return lerp(EDGE_WIDTH_MIN, EDGE_WIDTH_MAX, p) * m;                    // FIX
  }


  // -------------------- Apply map --------------------

  function applyMapBatched(mode) {
    const token = ++graph.__ccApplyToken;

    const scopeCells = collectScopeCells(graph.__ccScope);
    const slice = filterCellsByTimeSlice(scopeCells, mode);

    const inRangeSet = new Set(slice.inRange.map(c => c.id));
    graph.__ccFiltered = buildNavList(slice.inRange, mode);
    graph.__ccNavIndex = 0;
    updateNavUI();

    graph.__ccMapInternalChange = true;
    model.beginUpdate();

    let i = 0;

    function step() {
      if (token !== graph.__ccApplyToken) {
        try { model.endUpdate(); } finally { graph.__ccMapInternalChange = false; }
        return;
      }

      const end = Math.min(scopeCells.length, i + APPLY_BATCH_SIZE);

      for (; i < end; i++) {
        const cell = scopeCells[i];
        if (!shouldStyleCell(cell)) continue;

        ensureOrigStyle(cell);
        const base = baseStyleForApply(cell);

        const ts = getTimestampForMode(cell, mode);

        if (ts == null) {
          const p0 = 0;                                                    // NEW
          const strokeWidth = widthFromP(cell, p0);                        // NEW
          model.setStyle(cell, mergeStyle(base, {                           // FIX
            strokeColor: UNKNOWN_STYLE.strokeColor,                         // FIX
            dashed: UNKNOWN_STYLE.dashed,                                   // FIX
            strokeOpacity: UNKNOWN_STYLE.strokeOpacity,                     // FIX
            strokeWidth: strokeWidth                                        // NEW
          }));
          continue;
        }


        if (slice.windowMs != null && !inRangeSet.has(cell.id)) {
          const p0 = 0;                                                    // NEW
          const strokeWidth = widthFromP(cell, p0);                        // NEW
          model.setStyle(cell, mergeStyle(base, {                           // FIX
            strokeColor: OUT_OF_RANGE_STYLE.strokeColor,                    // FIX
            dashed: OUT_OF_RANGE_STYLE.dashed,                              // FIX
            strokeOpacity: OUT_OF_RANGE_STYLE.strokeOpacity,                // FIX
            strokeWidth: strokeWidth                                        // NEW
          }));
          continue;
        }


        if (slice.tMin == null || slice.tMax == null) {
          const p0 = 0;                                                    // NEW
          const strokeWidth = widthFromP(cell, p0);                        // NEW
          model.setStyle(cell, mergeStyle(base, {                           // FIX
            strokeColor: OUT_OF_RANGE_STYLE.strokeColor,                    // FIX
            dashed: OUT_OF_RANGE_STYLE.dashed,                              // FIX
            strokeOpacity: OUT_OF_RANGE_STYLE.strokeOpacity,                // FIX
            strokeWidth: strokeWidth                                        // NEW
          }));
          continue;
        }


        const p = positionForTimestamp(ts, slice.tMin, slice.tMax);
        const strokeColor = lerpColorRamp(COLOR_RAMP, p);
        const strokeWidth = widthFromP(cell, p);

        model.setStyle(cell, mergeStyle(base, { strokeColor, strokeWidth, dashed: 0, strokeOpacity: 100 }));
      }

      if (i < scopeCells.length) {
        requestAnimationFrame(step);
      } else {
        try {
          model.endUpdate();
        } finally {
          graph.__ccMapInternalChange = false;
          // Single refresh at end (avoid per-cell refresh)                
          if (typeof graph.refresh === 'function') graph.refresh();
        }
      }
    }

    requestAnimationFrame(step);
  }


  function clearMap() {
    const scopeCells = collectScopeCells(graph.__ccScope);
  
    graph.__ccFiltered = [];
    graph.__ccNavIndex = 0;
    updateNavUI();
  
    graph.__ccMapInternalChange = true;
    model.beginUpdate();
    try {
      for (let i = 0; i < scopeCells.length; i++) {
        const cell = scopeCells[i];
        const orig = getAttrStr(cell, ATTR_ORIG_STYLE);
        if (orig == null) continue;
  
        model.setStyle(cell, orig === NULL_STYLE_SENTINEL ? null : orig);                     // FIX
        removeAttr(cell, ATTR_ORIG_STYLE);
      }
    } finally {
      model.endUpdate();
      graph.__ccMapInternalChange = false;
      if (typeof graph.refresh === 'function') graph.refresh();
    }
  
    graph.__ccMode = MODE_NONE;
  }

  function enableMode(mode) {
    if (graph.__ccMode !== MODE_NONE) clearMap();
    graph.__ccMode = mode;
    scheduleRefreshIfEnabled();
  }

  function toggleMode(mode) {
    if (graph.__ccMode === mode) clearMap();
    else enableMode(mode);
  }

  function refreshIfEnabled() {
    scheduleRefreshIfEnabled();
  }


  // -------------------- Navigation --------------------

  function buildNavList(cellsInRange, mode) {
    const key = modeKey(mode);
    const list = [];
    for (let i = 0; i < cellsInRange.length; i++) {
      const c = cellsInRange[i];
      const ts = getAttrMs(c, key);
      if (ts == null) continue;
      list.push({ cell: c, ts });
    }

    list.sort(function (a, b) {
      return graph.__ccSortOrder === 'oldest' ? (a.ts - b.ts) : (b.ts - a.ts);
    });

    return list;
  }

  function navSelectIndex(idx) {
    if (!graph.__ccFiltered || graph.__ccFiltered.length === 0) return;
    const clamped = Math.max(0, Math.min(graph.__ccFiltered.length - 1, idx));
    graph.__ccNavIndex = clamped;

    const entry = graph.__ccFiltered[clamped];
    if (!entry || !entry.cell) return;

    graph.setSelectionCell(entry.cell);
    if (typeof graph.scrollCellToVisible === 'function') {
      graph.scrollCellToVisible(entry.cell);
    }

    updateNavUI();
  }

  function navPrev() { navSelectIndex(graph.__ccNavIndex - 1); }
  function navNext() { navSelectIndex(graph.__ccNavIndex + 1); }

  // -------------------- UI overlay --------------------

  let panel = null;
  let modeSelect = null;
  let scopeSelect = null;
  let windowValueInput = null;
  let windowUnitSelect = null;
  let sortSelect = null;
  let infoLabel = null;
  let prevBtn = null;
  let nextBtn = null;
  let listWrap = null;

  function makeEl(tag, styleObj) {
    const el = document.createElement(tag);
    if (styleObj) Object.assign(el.style, styleObj);
    return el;
  }

  function createPanel() {
    if (panel) return;

    panel = makeEl('div', {
      position: 'absolute',
      top: '10px',
      right: '10px',
      zIndex: 9999,
      background: 'rgba(255,255,255,0.92)',
      border: '1px solid #c7c7cc',
      borderRadius: '8px',
      padding: '10px',
      fontFamily: 'Arial, sans-serif',
      fontSize: '12px',
      minWidth: '260px',
      boxShadow: '0 2px 8px rgba(0,0,0,0.12)'
    });

    const title = makeEl('div', { fontWeight: '600', marginBottom: '8px' });
    title.textContent = 'Change/Create Map';
    panel.appendChild(title);

    panel.appendChild(makeRow('Mode', (modeSelect = makeSelect([
      { value: MODE_NONE, label: 'Off' },
      { value: MODE_CHANGE, label: 'ChangeMap' },
      { value: MODE_CREATE, label: 'CreateMap' }
    ]))));

    panel.appendChild(makeRow('Scope', (scopeSelect = makeSelect([
      { value: SCOPE_DIAGRAM, label: 'Diagram' },
      { value: SCOPE_SELECTION, label: 'Selection' },
      { value: SCOPE_SUBTREE, label: 'Subtree (single selected)' }
    ]))));

    const timeRow = makeEl('div', { display: 'flex', alignItems: 'center', gap: '8px', margin: '6px 0' });
    const timeLab = makeEl('div', { minWidth: '60px' });
    timeLab.textContent = 'Window';
    timeRow.appendChild(timeLab);

    windowValueInput = makeEl('input', { width: '70px', padding: '3px 6px' });
    windowValueInput.type = 'number';
    windowValueInput.min = '0';
    windowValueInput.value = String(graph.__ccWindowValue);

    windowUnitSelect = makeSelect([
      { value: 'minutes', label: 'minutes' },
      { value: 'hours', label: 'hours' },
      { value: 'days', label: 'days' }
    ]);

    timeRow.appendChild(windowValueInput);
    timeRow.appendChild(windowUnitSelect);

    const hint = makeEl('div', { color: '#666', marginTop: '2px', fontSize: '11px' });
    hint.textContent = 'Set window=0 to disable slicing.';
    panel.appendChild(timeRow);
    panel.appendChild(hint);

    panel.appendChild(makeRow('Order', (sortSelect = makeSelect([
      { value: 'newest', label: 'Newest first' },
      { value: 'oldest', label: 'Oldest first' }
    ]))));

    const navRow = makeEl('div', { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' });
    prevBtn = makeEl('button', { padding: '4px 8px', cursor: 'pointer' });
    prevBtn.textContent = 'Prev';
    nextBtn = makeEl('button', { padding: '4px 8px', cursor: 'pointer' });
    nextBtn.textContent = 'Next';
    infoLabel = makeEl('div', { flex: '1', textAlign: 'right', color: '#444' });
    navRow.appendChild(prevBtn);
    navRow.appendChild(nextBtn);
    navRow.appendChild(infoLabel);
    panel.appendChild(navRow);

    listWrap = makeEl('div', {
      marginTop: '8px',
      borderTop: '1px solid #ddd',
      paddingTop: '6px',
      maxHeight: '180px',
      overflow: 'auto'
    });
    panel.appendChild(listWrap);

    wirePanelEvents();
    attachPanel();
    syncPanelFromState();
    updateNavUI();
  }

  function makeRow(label, control) {
    const row = makeEl('div', { display: 'flex', alignItems: 'center', gap: '8px', margin: '6px 0' });
    const lab = makeEl('div', { minWidth: '60px' });
    lab.textContent = label;
    row.appendChild(lab);
    row.appendChild(control);
    control.style.flex = '1';
    return row;
  }

  function makeSelect(options) {
    const sel = makeEl('select', { padding: '3px 6px' });
    for (let i = 0; i < options.length; i++) {
      const opt = document.createElement('option');
      opt.value = options[i].value;
      opt.textContent = options[i].label;
      sel.appendChild(opt);
    }
    return sel;
  }

  function attachPanel() {
    if (!graph.container || !panel) return;
    const parent = graph.container.parentNode || graph.container;
    if (panel.parentNode !== parent) parent.appendChild(panel);
  }

  function wirePanelEvents() {
    modeSelect.addEventListener('change', function () {
      const v = modeSelect.value;
      if (v === MODE_NONE) clearMap();
      else enableMode(v);
    });

    scopeSelect.addEventListener('change', function () {
      graph.__ccScope = scopeSelect.value;
      refreshIfEnabled();
    });

    windowValueInput.addEventListener('change', function () {
      graph.__ccWindowValue = Number(windowValueInput.value || 0);
      refreshIfEnabled();
    });

    windowUnitSelect.addEventListener('change', function () {
      graph.__ccWindowUnit = windowUnitSelect.value;
      refreshIfEnabled();
    });

    sortSelect.addEventListener('change', function () {
      graph.__ccSortOrder = sortSelect.value;
      refreshIfEnabled();
    });

    prevBtn.addEventListener('click', function () { navPrev(); });
    nextBtn.addEventListener('click', function () { navNext(); });
  }

  function syncPanelFromState() {
    modeSelect.value = graph.__ccMode;
    scopeSelect.value = graph.__ccScope;
    windowValueInput.value = String(graph.__ccWindowValue);
    windowUnitSelect.value = graph.__ccWindowUnit;
    sortSelect.value = graph.__ccSortOrder;
  }

  function formatTs(ts) {
    try { return new Date(ts).toLocaleString(); } catch (e) { return String(ts); }
  }

  function updateNavUI() {
    if (!panel) return;

    const n = graph.__ccFiltered ? graph.__ccFiltered.length : 0;
    const idx = graph.__ccNavIndex;

    infoLabel.textContent = n === 0 ? '0' : ((idx + 1) + ' / ' + n);

    prevBtn.disabled = (n === 0 || idx <= 0);
    nextBtn.disabled = (n === 0 || idx >= n - 1);

    // Build clickable list
    listWrap.innerHTML = '';
    if (n === 0) {
      const empty = makeEl('div', { color: '#666' });
      empty.textContent = 'No matches in window.';
      listWrap.appendChild(empty);
      return;
    }

    const max = Math.min(NAV_LIST_MAX, n);
    for (let i = 0; i < max; i++) {
      const entry = graph.__ccFiltered[i];
      const row = makeEl('div', {
        padding: '4px 6px',
        cursor: 'pointer',
        borderRadius: '6px',
        marginBottom: '2px',
        background: (i === idx) ? 'rgba(52,199,89,0.12)' : 'transparent'
      });

      const label = entry.cell.value && entry.cell.value.nodeName
        ? (entry.cell.value.getAttribute('label') || entry.cell.id)
        : (entry.cell.id);

      row.textContent = label + '  —  ' + formatTs(entry.ts);

      (function (targetIndex) {
        row.addEventListener('click', function () {
          navSelectIndex(targetIndex);
        });
      })(i);

      listWrap.appendChild(row);
    }
  }

  function dedupeTimestampsOnPaste(cells) {                                                    // NEW
    if (!Array.isArray(cells) || cells.length === 0) return false;                             // NEW
  
    const tBase = nowMs();                                                                     // NEW
    let bump = 0;                                                                              // NEW
    let did = false;                                                                           // NEW
  
    model.beginUpdate();                                                                       // NEW
    try {
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        if (!c || !c.id) continue;
        if (!shouldStyleCell(c)) continue;
        if (shouldIgnoreBecauseInTilerGroup(c)) continue;
  
        ensureXmlValue(c);                                                                     // NEW
  
        // createdAt: reset only if it conflicts with another cell                             // NEW
        const created = getAttrMs(c, ATTR_CREATED);                                             // NEW
        if (created != null && hasTimestampConflict(ATTR_CREATED, created, c.id)) {            // NEW
          setAttrMs(c, ATTR_CREATED, tBase + (bump++));                                         // NEW
          did = true;                                                                           // NEW
        }
  
        // Optional: lastEditedAt can also be duplicated on paste; same rule                    // NEW
        const edited = getAttrMs(c, ATTR_EDITED);                                               // NEW
        if (edited != null && hasTimestampConflict(ATTR_EDITED, edited, c.id)) {               // NEW
          setAttrMs(c, ATTR_EDITED, tBase + (bump++));                                          // NEW
          did = true;                                                                           // NEW
        }
      }
    } finally {
      model.endUpdate();                                                                       // NEW
    }
  
    return did;                                                                                // NEW
  }
  
  function hasTimestampConflict(key, ts, excludeId) {                                         // NEW
    if (ts == null) return false;                                                             // NEW
    let conflict = false;                                                                     // NEW
    iterAllCells(function (c) {                                                               // NEW
      if (conflict) return;                                                                   // NEW
      if (!c || !c.id || c.id === excludeId) return;                                          // NEW
      const other = getAttrMs(c, key);                                                        // NEW
      if (other != null && other === ts) conflict = true;                                     // NEW
    });                                                                                       // NEW
    return conflict;                                                                          // NEW
  }
  

  function isWithinPasteWindow() {                                                            // NEW
    return nowMs() <= (graph.__ccPasteUntil || 0);                                            // NEW
  }

  function stampCreatedCells(cells, tNow) {                                                   // NEW
    if (!Array.isArray(cells) || cells.length === 0) return false;                            // NEW
    let did = false;                                                                          // NEW
  
    model.beginUpdate();                                                                      // NEW
    try {
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        if (!c || !c.id) continue;
        if (!shouldStyleCell(c)) continue;
        if (shouldIgnoreBecauseInTilerGroup(c)) continue;
  
        ensureXmlValue(c);                                                                    // NEW
        if (getAttrMs(c, ATTR_CREATED) == null) {                                             // NEW
          setAttrMs(c, ATTR_CREATED, tNow);                                                   // NEW
          did = true;                                                                         // NEW
        }
      }
    } finally {
      model.endUpdate();                                                                      // NEW
    }
  
    return did;                                                                               // NEW
  }

  // -------------------- Listen for model changes --------------------
  function debugLogEdit(edit, label) {                                                     // NEW
    try {
      const changes = (edit && edit.changes) || [];
      console.log(`[CCMap] ${label}: ${changes.length} change(s)`);
      for (let i = 0; i < changes.length; i++) {
        const ch = changes[i];
        const name = ch && ch.constructor && ch.constructor.name;
        const cell = ch && (ch.child || ch.cell || ch.previous || ch.terminal || null);
        const id = cell && cell.id;
        const parent = cell ? model.getParent(cell) : null;
        console.log(`  - #${i} ${name}`, { id, parentId: parent && parent.id, ch });
      }
    } catch (e) {
      console.warn('[CCMap] debugLogEdit failed', e);
    }
  }

  model.addListener(mxEvent.CHANGE, function (sender, evt) {
    if (graph.__ccMapInternalChange) return;

    const edit = evt && evt.getProperty && evt.getProperty('edit');
    if (!edit || !edit.changes) return;

    debugLogEdit(edit, 'CHANGE');                                                          // NEW

    const createdStamped = stampCreatedOnInsert(edit);
    const editedStamped = stampEditedFromSelectedIntersection(edit);

    if (createdStamped || editedStamped) scheduleRefreshIfEnabled();
  });


  const originalAddCells = graph.addCells;                                                   // NEW

  graph.addCells = function (cells, parent, index, source, target, absolute) {               // NEW
    const tNow = nowMs();                                                                    // NEW
    model.beginUpdate();                                                                     // NEW
    try {
      // Ensure user object exists + stamp createdAt before actual insertion.                 // NEW
      if (Array.isArray(cells)) {
        for (let i = 0; i < cells.length; i++) {
          const c = cells[i];
          if (!c || !c.id) continue;
          if (!shouldStyleCell(c)) continue;
          if (shouldIgnoreBecauseInTilerGroup(c)) continue;

          ensureXmlValue(c);                                                                 // NEW
          if (getAttrMs(c, ATTR_CREATED) == null) setAttrMs(c, ATTR_CREATED, tNow);          // NEW
        }
      }

      return originalAddCells.apply(this, arguments);                                        // NEW
    } finally {
      model.endUpdate();                                                                     // NEW
    }
  };

  graph.addListener(mxEvent.CELLS_ADDED, function (sender, evt) {                              // NEW
    if (graph.__ccMapInternalChange) return;                                                   // NEW
  
    const cells = (evt && evt.getProperty && (evt.getProperty('cells') || evt.getProperty('added'))) || []; // NEW
  
    // Normal insert stamping (createdAt if missing)                                            // NEW
    const didCreate = stampCreatedCells(cells, nowMs());                                       // NEW
  
    // Paste-specific dedupe                                                                    // NEW
    const maybePaste = isWithinPasteWindow() ||                                                // NEW
      (cells || []).some(c => c && c.id && graph.__ccPasteIds && graph.__ccPasteIds.has(c.id)); // NEW
  
    const didDedupe = maybePaste ? dedupeTimestampsOnPaste(cells) : false;                     // NEW
  
    if (didCreate || didDedupe) scheduleRefreshIfEnabled();                                    // NEW
  });
  

  const originalImportCells = graph.importCells;                                             // NEW

  graph.importCells = function (cells, dx, dy, target, evt, mapping) {                       // NEW
    const tNow = nowMs();                                                                    // NEW
    model.beginUpdate();                                                                     // NEW
    try {
      if (Array.isArray(cells)) {
        for (let i = 0; i < cells.length; i++) {
          const c = cells[i];
          if (!c || !c.id) continue;
          if (!shouldStyleCell(c)) continue;
          if (shouldIgnoreBecauseInTilerGroup(c)) continue;

          ensureXmlValue(c);                                                                 // NEW
          if (getAttrMs(c, ATTR_CREATED) == null) setAttrMs(c, ATTR_CREATED, tNow);          // NEW
        }
      }

      return originalImportCells.apply(this, arguments);                                     // NEW
    } finally {
      model.endUpdate();                                                                     // NEW
    }
  };


  graph.addListener(mxEvent.PASTE, function (sender, evt) {                                   // NEW
    const cells = (evt && evt.getProperty && evt.getProperty('cells')) || [];                 // NEW
    graph.__ccPasteIds = new Set((cells || []).map(c => c && c.id).filter(Boolean));          // NEW
    graph.__ccPasteUntil = nowMs() + PASTE_WINDOW_MS;                                         // NEW
  });



  // -------------------- Zoom listener (debounced apply) ---------------- // NEW
  if (graph.view && typeof graph.view.addListener === 'function') {        // NEW
    graph.view.addListener(mxEvent.SCALE, function () {                    // NEW
      if (graph.__ccMode === MODE_NONE) return;                            // NEW
      updateZoomStrokeMult();                                             // NEW
      scheduleRefreshIfEnabled();                                         // NEW
    });                                                                    // NEW
  }                                                                        // NEW


  // -------------------- Context menu --------------------

  const oldFactory = graph.popupMenuHandler.factoryMethod;

  graph.popupMenuHandler.factoryMethod = function (menu, cell, evt) {
    oldFactory.apply(this, arguments);

    menu.addSeparator();

    const changeLabel = (graph.__ccMode === MODE_CHANGE) ? 'Hide ChangeMap' : 'Show ChangeMap';
    const createLabel = (graph.__ccMode === MODE_CREATE) ? 'Hide CreateMap' : 'Show CreateMap';

    menu.addItem(changeLabel, null, function () {
      toggleMode(MODE_CHANGE);
      createPanel();
      syncPanelFromState();
    });

    menu.addItem(createLabel, null, function () {
      toggleMode(MODE_CREATE);
      createPanel();
      syncPanelFromState();
    });

    menu.addSeparator();
    menu.addItem('Show Map Panel', null, function () {
      createPanel();
      syncPanelFromState();
    });
  };

  // Create panel immediately on plugin load
  createPanel();
});
