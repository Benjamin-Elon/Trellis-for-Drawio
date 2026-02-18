/**
 * Draw.io Plugin: Tiler Group Overlap Navigator (Multi-Cluster, DOM Buttons)
 * - Detects ANY overlap (edge/corner inclusive) among sibling tiler groups.
 * - Builds all disjoint overlap-connected components ("clusters") per parent.
 * - Each cluster gets its own Prev/Next controls and index badge.
 * - Non-current members of each cluster are rendered outline-only (fills/text/images hidden).
 * - Controls persist even when unselected; they clear only if a cluster disappears.
 */
Draw.loadPlugin(function (ui) {
    const graph = ui.editor.graph;
    const model = graph.getModel();

    if (graph.__tilerOverlapNavClustersInstalled) return;
    graph.__tilerOverlapNavClustersInstalled = true;

    // -------------------- Config --------------------
    const BTN_SIZE = 22;
    const BTN_INSET = 6;
    const ICON_PREV = 'data:image/svg+xml;utf8,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22">' +
        '<circle cx="11" cy="11" r="10" fill="white" stroke="black" stroke-width="1"/>' +
        '<polygon points="13,6 9,11 13,16" fill="black"/></svg>'
    );
    const ICON_NEXT = 'data:image/svg+xml;utf8,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22">' +
        '<circle cx="11" cy="11" r="10" fill="white" stroke="black" stroke-width="1"/>' +
        '<polygon points="9,6 13,11 9,16" fill="black"/></svg>'
    );

    const ICON_SELECT = 'data:image/svg+xml;utf8,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">' +
        '<circle cx="11" cy="11" r="10" fill="white" stroke="black" stroke-width="1"/>' +
        // cursor/selection arrow
        '<path d="M7 5 L7 15 L9.3 12.8 L10.8 16 L12.4 15.4 L10.9 12.2 L14 12 Z" fill="black"/>' +
        '</svg>'
    );

    const ICON_SELECT_BEDS = 'data:image/svg+xml;utf8,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">' +
        '<circle cx="11" cy="11" r="10" fill="white" stroke="black" stroke-width="1"/>' +
        // simple "bed" glyph: a rounded rectangle with hatch lines
        '<rect x="6" y="7" width="10" height="8" rx="1.5" ry="1.5" fill="none" stroke="black" stroke-width="1"/>' +
        '<path d="M7 9 H15 M7 11 H15 M7 13 H15" stroke="black" stroke-width="1"/>' +
        '</svg>'
    );

    const TIME_ATTRS_ASC = ['transplant_date', 'sow_date'];
    const EPS = 0; // inclusive AABB; set >0 to treat near-miss as overlap

    const OVERLAP_MIN_PCT = 0.40;
    const OVERLAP_PCT_MODE = 'smaller';

    // overlap badges config                                                             
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const OVERLAP_BADGE_W = 34;
    const OVERLAP_BADGE_H = 18;

    // overlap thresholds (0..1)
    const OVERLAP_FRAC_SMALL = 0.30; // % of the smaller
    const OVERLAP_FRAC_LARGE = 0.30; // % of the larger
    const OVERLAP_MIN_PX2 = 100;       // ignore microscopic overlaps

    // ---------------- Config ----------------
    const HEIGHT_ATTR = 'veg_height';          // cm (string)
    const DIAM_ATTR = 'veg_diameter_cm';     // cm (string)
    const PLANT_TAG = 'planting';            // optional: if you tag planting cells (recommended)
    const PLANT_TAG_ATTR = 'cellType';         // optional: 'planting'
    const REORDER_DEBOUNCE_MS = 80;

    // -------------------- NEW: canopy ordering --------------------
    function isPlantingCell(cell) {
        if (!cell || !cell.getAttribute) return false;
        // Prefer explicit tag if you use it, otherwise tiler group == planting         
        if (cell.getAttribute(PLANT_TAG_ATTR) === PLANT_TAG) return true;
        return isTilerGroup(cell);
    }

    function toNumOrNaN(v) {
        if (v == null) return NaN;
        const n = parseFloat(String(v).trim());
        return Number.isFinite(n) ? n : NaN;
    }

    function canopyKey(cell) {
        const h = toNumOrNaN(cell.getAttribute(HEIGHT_ATTR));
        const d = toNumOrNaN(cell.getAttribute(DIAM_ATTR));
        // We sort shorter->taller (back->front), so NaN becomes -Infinity              
        const hh = Number.isFinite(h) ? h : NaN;
        const dd = Number.isFinite(d) ? d : NaN;
        return { h: hh, d: dd };
    }

    function canopyCompare(a, b) {
        const ka = canopyKey(a), kb = canopyKey(b);

        // Primary: height                                                              
        const ah = Number.isFinite(ka.h) ? ka.h : -Infinity;
        const bh = Number.isFinite(kb.h) ? kb.h : -Infinity;
        if (ah !== bh) return ah - bh;

        // Fallback: diameter                                                           
        const ad = Number.isFinite(ka.d) ? ka.d : -Infinity;
        const bd = Number.isFinite(kb.d) ? kb.d : -Infinity;
        if (ad !== bd) return ad - bd;

        // Stable tie-break                                                             
        const id1 = a.id || '', id2 = b.id || '';
        return id1 < id2 ? -1 : id1 > id2 ? 1 : 0;
    }

    function snapCanopyOrderInParent(parent) {
        if (!parent) return;
        const childCount = model.getChildCount(parent);
        if (childCount <= 1) return;

        // Gather current child list (includes non-vertices too)                        
        const children = [];
        for (let i = 0; i < childCount; i++) children.push(model.getChildAt(parent, i));

        // Identify planting children and their current slot indices                    
        const plantingSlots = [];
        const plantings = [];
        for (let i = 0; i < children.length; i++) {
            const c = children[i];
            if (model.isVertex(c) && isPlantingCell(c)) {
                plantingSlots.push(i);
                plantings.push(c);
            }
        }

        if (plantings.length <= 1) return;

        // Sort: shorter first, taller last (front)                                     
        const sorted = plantings.slice().sort(canopyCompare);

        // Reinsert ONLY plantings into their existing slots (preserve non-plantings)   
        model.beginUpdate();
        try {
            for (let k = 0; k < plantingSlots.length; k++) {
                const idx = plantingSlots[k];
                const cell = sorted[k];
                // model.add moves within same parent; index is the z-order position   
                model.add(parent, cell, idx);
            }
        } finally {
            model.endUpdate();
        }
        graph.refresh();
    }

    let canopySnapRaf = null;
    function scheduleCanopySnap(parent) {
        if (!parent) return;
        if (canopySnapRaf != null) cancelAnimationFrame(canopySnapRaf);
        canopySnapRaf = requestAnimationFrame(() => {
            canopySnapRaf = null;
            snapCanopyOrderInParent(parent);

            const sel = graph.getSelectionCell();
            if (sel && model.getParent(sel) === parent && isPlantingCell(sel)) {
                bringCellToFrontInParent(sel);
            }
        });
    }


    // debounce
    let rafToken = null;
    function rafDebounce(fn) {
        if (rafToken != null) cancelAnimationFrame(rafToken);
        rafToken = requestAnimationFrame(() => { rafToken = null; fn(); });
    }

    // -------------------- Basic predicates & view helpers --------------------
    function isTilerGroup(cell) {
        return !!cell && cell.getAttribute && cell.getAttribute('tiler_group') === '1';
    }

    function getState(cell) {
        return cell ? graph.view.getState(cell) : null;
    }

    let cachedHost = null;
    function getHost() {
        if (cachedHost) return cachedHost;
        const pane = graph.view && graph.view.overlayPane;
        cachedHost = (pane && getComputedStyle(pane).position === 'absolute') ? pane : graph.container;
        return cachedHost;
    }
    graph.getView().addListener(mxEvent.REPAINT, () => { cachedHost = null; });


    // -------------------- Geometry & overlap --------------------
    const boundsCache = new Map();

    function getAbsBounds(cell) {
        if (!cell) return null;
        const cached = boundsCache.get(cell.id);
        if (cached) return cached;
        const st = graph.view.getState(cell);
        if (st) {
            const b = { x: st.x, y: st.y, w: st.width, h: st.height };
            boundsCache.set(cell.id, b);
            return b;
        }
        return null;
    }

    function invalidateBoundsCache() { boundsCache.clear(); }
    graph.addListener(mxEvent.CELLS_MOVED, invalidateBoundsCache);
    graph.addListener(mxEvent.CELLS_RESIZED, invalidateBoundsCache);
    graph.getView().addListener(mxEvent.SCALE_AND_TRANSLATE, invalidateBoundsCache);


    // -------------------- Significant overlap (area-based) -------------------- 
    function rectArea(r) {
        return (!r) ? 0 : Math.max(0, r.w) * Math.max(0, r.h);
    }

    function rectIntersectionArea(a, b) {
        if (!a || !b) return 0;
        const x1 = Math.max(a.x, b.x);
        const y1 = Math.max(a.y, b.y);
        const x2 = Math.min(a.x + a.w, b.x + b.w);
        const y2 = Math.min(a.y + a.h, b.y + b.h);
        const iw = x2 - x1;
        const ih = y2 - y1;
        if (iw <= 0 || ih <= 0) return 0;  // touching edges/corners => 0         
        return iw * ih;
    }

    function isGardenBed(cell) {
        if (!cell || !cell.getAttribute) return false;
        return cell.getAttribute('garden_bed') === '1' ||
            cell.getAttribute('gardenBed') === '1' ||
            cell.getAttribute('is_garden_bed') === '1';
    }

    function rectContainsPoint(r, px, py) {
        if (!r) return false;
        return px >= r.x && px <= (r.x + r.w) && py >= r.y && py <= (r.y + r.h);
    }

    function rectCenter(r) {
        return (!r) ? null : { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    }

    function bedsForCluster(key) {                                                                     
        const st = clusterStates.get(key);                                                             
        if (!st || !st.order || !st.order.length) return [];                                           
    
        const parent = model.getParent(st.order[0]);                                                    
        if (!parent) return [];                                                                         
    
        const sibVerts = graph.getChildVertices(parent) || [];                                          
        const beds = sibVerts.filter(isGardenBed);                                                      
        if (!beds.length) return [];                                                                    
    
        const bedBounds = beds.map(getAbsBounds);                                                       
        const chosenIds = new Set();                                                                    
    
        for (const tg of st.order) {                                                                    
            const b = getAbsBounds(tg);                                                                 
            const c = rectCenter(b);                                                                    
            if (!c) continue;                                                                           
    
            let chosen = null;                                                                          
            let chosenArea = Infinity;                                                                  
            for (let k = 0; k < beds.length; k++) {                                                     
                const bb = bedBounds[k];                                                                
                if (!bb) continue;                                                                      
                if (rectContainsPoint(bb, c.x, c.y)) {                                                   
                    const a = rectArea(bb);                                                             
                    if (a > 0 && a < chosenArea) {                                                      
                        chosenArea = a;                                                                 
                        chosen = beds[k];                                                               
                    }                                                                                   
                }                                                                                       
            }                                                                                           
            if (chosen && chosen.id) chosenIds.add(chosen.id);                                          
        }                                                                                               
    
        const out = [];                                                                                 
        chosenIds.forEach(id => {                                                                       
            const cell = model.getCell(id);                                                             
            if (cell && model.isVertex(cell) && isGardenBed(cell)) out.push(cell);                      
        });                                                                                             
        return out;                                                                                     
    }                                                                                                       

    function significantOverlap(a, b) {
        if (!a || !b) return false;
        const ia = rectIntersectionArea(a, b);
        if (ia <= 0) return false;
        const aa = rectArea(a), ab = rectArea(b);
        if (aa <= 0 || ab <= 0) return false;

        let denom;
        if (OVERLAP_PCT_MODE === 'union') {
            denom = (aa + ab - ia);
        } else {
            denom = Math.min(aa, ab); // 'smaller'                               
        }
        if (denom <= 0) return false;
        const pct = ia / denom;
        return pct >= OVERLAP_MIN_PCT;
    }

    function getSiblingsInParent(parent) {
        const verts = graph.getChildVertices(parent) || [];
        return verts.filter(isTilerGroup);
    }

    // -------------------- prevent beds from being dropped into tiler groups --------------------

    // Returns true if `cell` is a tiler group OR is inside a tiler group (any ancestor)          
    function isInTilerGroup(cell) {                                                               
        let p = cell;                                                                             
        while (p) {                                                                               
            if (isTilerGroup(p)) return true;                                                     
            p = model.getParent(p);                                                               
        }                                                                                         
        return false;                                                                             
    }                                                                                             

    // Find the nearest ancestor (including self) that is a tiler group, else null                
    function findTilerGroupAncestor(cell) {                                                       
        let p = cell;                                                                             
        while (p) {                                                                               
            if (isTilerGroup(p)) return p;                                                        
            p = model.getParent(p);                                                               
        }                                                                                         
        return null;                                                                              
    }                                                                                             

    // 1) Primary: block drop target at drag-time                                                  
    (function installBedDropBlock() {                                                             
        if (graph.__bedDropBlockInstalled) return;                                                
        graph.__bedDropBlockInstalled = true;                                                     

        const origIsValidDropTarget = graph.isValidDropTarget;                                    
        graph.isValidDropTarget = function (target, cells, evt) {                                 
            // If any dragged cell is a garden bed, forbid dropping into tiler groups              
            const dragged = (cells || []).filter(Boolean);                                        
            const anyBed = dragged.some(c => model.isVertex(c) && isGardenBed(c));                
            if (anyBed) {                                                                         
                const tg = target ? findTilerGroupAncestor(target) : null;                        
                if (tg) return false;                                                             
            }                                                                                     
            return origIsValidDropTarget ? origIsValidDropTarget.apply(this, arguments) : true;   
        };                                                                                        
    })();                                                                                         

    // 2) Secondary: safety net after moves (undo/redo/programmatic moves/outline drag)            
    function enforceBedsNotInTilerGroups(cells) {                                                  
        const moved = (cells || []).filter(Boolean);                                               
        if (!moved.length) return;                                                                 

        // Choose a safe parent. Default parent is usually correct.                                 
        const safeParent = graph.getDefaultParent();                                               

        model.beginUpdate();                                                                       
        try {                                                                                      
            for (const c of moved) {                                                               
                if (!model.isVertex(c) || !isGardenBed(c)) continue;                               
                const parent = model.getParent(c);                                                 
                if (!parent) continue;                                                             

                if (isInTilerGroup(parent)) {                                                      
                    // Move bed out to safe parent, preserving absolute geometry                     
                    const geo = model.getGeometry(c);                                              
                    if (!geo) {                                                                    
                        model.add(safeParent, c, model.getChildCount(safeParent));                 
                        continue;                                                                  
                    }                                                                              

                    // Convert current geometry to absolute, then re-add under safe parent          
                    const abs = geo.clone();                                                       
                    const parentGeo = model.getGeometry(parent);                                   
                    if (parentGeo) {                                                               
                        abs.x += parentGeo.x;                                                      
                        abs.y += parentGeo.y;                                                      
                    }                                                                              

                    model.add(safeParent, c, model.getChildCount(safeParent));                     
                    model.setGeometry(c, abs);                                                     
                }                                                                                  
            }                                                                                      
        } finally {                                                                                
            model.endUpdate();                                                                     
        }                                                                                          

        graph.refresh();                                                                           
    }                                                                                              

    graph.addListener(mxEvent.CELLS_MOVED, function (sender, evt) {                                
        const cells = evt.getProperty('cells');                                                    
        enforceBedsNotInTilerGroups(cells);                                                        
    });                                                                                            


    // -------------------- Time ordering --------------------
    function parseISO(s) {
        if (!s) return null;
        const d = new Date(s);
        return isNaN(+d) ? null : d;
    }

    function timeKey(cell) {
        for (const k of TIME_ATTRS_ASC) {
            const d = parseISO(cell.getAttribute(k));
            if (d) return +d;
        }
        const he = parseISO(cell.getAttribute('harvest_end'));
        return he ? +he : Number.POSITIVE_INFINITY;
    }

    // -------------------- Outline-only dimming (deep) --------------------
    let descendantsCache = new WeakMap();

    function collectVertexTree(root) {
        const out = [];
        const stack = [root];
        while (stack.length) {
            const c = stack.pop();
            if (!c) continue;
            if (model.isVertex(c)) out.push(c);
            const n = model.getChildCount(c);
            for (let i = 0; i < n; i++) stack.push(model.getChildAt(c, i));
        }
        return out;
    }

    function collectVertexTreeCached(root) {
        if (descendantsCache.has(root)) return descendantsCache.get(root);
        const out = collectVertexTree(root);
        descendantsCache.set(root, out);
        return out;
    }

    // -------------------- Config --------------------
    const BASE_TG_OPACITY = '50';
    const SELECTED_TG_OPACITY = '100';

    // -------------------- Outline-only dimming (deep) --------------------


    // In setOutlineOnlyVisibleDeep, swap to use cached:                        
    function setOutlineOnlyVisibleDeep(roots, visible) {
        const cells = [];
        (roots || []).forEach(r => cells.push(...collectVertexTreeCached(r)));
        if (!cells.length) return;
        const fillV = String(visible ? 100 : 0);
        const textV = String(visible ? 100 : 0);
        const imgV = String(visible ? 100 : 0);
        const stroke = '100';
        model.beginUpdate();
        try {
            graph.setCellStyles('fillOpacity', fillV, cells);
            graph.setCellStyles('textOpacity', textV, cells);
            graph.setCellStyles('imageOpacity', imgV, cells);
            graph.setCellStyles('strokeOpacity', stroke, cells);
        } finally {
            model.endUpdate();
        }
    }

    // deep opacity setter (root + descendants)
    function setOpacityDeep(roots, opacityPct) {
        const cells = [];
        (roots || []).forEach(r => cells.push(...collectVertexTreeCached(r)));
        if (!cells.length) return;
        model.beginUpdate();
        try {
            graph.setCellStyles('opacity', String(opacityPct), cells);
        } finally {
            model.endUpdate();
        }
    }

    // restore to baseline visuals for a tiler group (deep)
    function restoreBaselineTGDeep(roots) {
        if (!roots || !roots.length) return;
        setOutlineOnlyVisibleDeep(roots, true);
        setOpacityDeep(roots, BASE_TG_OPACITY);
    }

    // Invalidate when tree structure changes:                                   
    graph.addListener(mxEvent.ADD_CELLS, () => { descendantsCache = new WeakMap(); });
    graph.addListener(mxEvent.REMOVE_CELLS, () => { descendantsCache = new WeakMap(); });

    // -------------------- Multi-cluster state --------------------
    // key -> { order: mxCell[], currentIdx: number, anchorId: string, btnPrev, btnNext, badge, dimmed:Set<mxCell> }
    const clusterStates = new Map();

    function clusterKeyOf(members) {
        const ids = members.map(c => c.id || '').sort();
        return ids.join('|');
    }

    function orderComponentByTime(members) {
        return members.slice().sort((a, b) => {
            const t1 = timeKey(a), t2 = timeKey(b);
            if (t1 !== t2) return t1 - t2;
            const id1 = a.id || '', id2 = b.id || '';
            return id1 < id2 ? -1 : id1 > id2 ? 1 : 0;
        });
    }

    function buildAllComponentsInParent(parent) {
        const nodes = getSiblingsInParent(parent);
        const n = nodes.length;
        if (n < 2) return [];

        const bounds = nodes.map(getAbsBounds);

        // --- NEW: collect beds in same parent and precompute bounds ---
        const sibVerts = graph.getChildVertices(parent) || [];
        const beds = sibVerts.filter(isGardenBed);
        const bedBounds = beds.map(getAbsBounds);

        // Map each TG index -> chosen bed id (or null) based on center-in-bed
        const tgBedId = new Array(n).fill(null);
        for (let i = 0; i < n; i++) {
            const b = bounds[i];
            const c = rectCenter(b);
            if (!c) continue;

            let chosen = null;
            let chosenArea = Infinity;
            for (let k = 0; k < beds.length; k++) {
                const bb = bedBounds[k];
                if (!bb) continue;
                if (rectContainsPoint(bb, c.x, c.y)) {
                    const a = rectArea(bb);
                    // If multiple beds contain the point, pick the smallest bed (more specific)
                    if (a > 0 && a < chosenArea) {
                        chosenArea = a;
                        chosen = beds[k].id;
                    }
                }
            }
            tgBedId[i] = chosen;
        }

        const adj = Array.from({ length: n }, () => []);

        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const sameBed = (tgBedId[i] && tgBedId[i] === tgBedId[j]);
                const sigOv = significantOverlap(bounds[i], bounds[j]);
                if (sameBed || sigOv) {
                    adj[i].push(j);
                    adj[j].push(i);
                }
            }
        }

        const seen = new Array(n).fill(false);
        const comps = [];
        for (let i = 0; i < n; i++) {
            if (seen[i]) continue;
            const stack = [i], comp = [];
            seen[i] = true;
            while (stack.length) {
                const v = stack.pop();
                comp.push(nodes[v]);
                for (const w of adj[v]) if (!seen[w]) { seen[w] = true; stack.push(w); }
            }
            if (comp.length >= 2) comps.push(comp);
        }
        return comps;
    }


    function ensureClusterState(members, preferredAnchorId) {
        const key = clusterKeyOf(members);
        const order = orderComponentByTime(members);
        let st = clusterStates.get(key);
        if (!st) {
            let idx = 0;
            if (preferredAnchorId) {
                const k = order.findIndex(c => c.id === preferredAnchorId);
                if (k >= 0) idx = k;
            }
            st = {
                order,
                currentIdx: idx,
                anchorId: order[idx].id,
                btnPrev: null,
                btnNext: null,
                badge: null,
                dimmed: new Set(),
                badgePrev: null,
                badgeNext: null,
                btnDrag: null,
                btnSelectAll: null,
                btnSelectBeds: null,
            };
            clusterStates.set(key, st);
        } else {
            const oldAnchor = st.anchorId;
            st.order = order;
            const k = order.findIndex(c => c.id === oldAnchor);
            st.currentIdx = k >= 0 ? k : 0;
            st.anchorId = st.order[st.currentIdx].id;
        }
        return { key, st };
    }


    // Earliest start / latest end window for a group                                        
    function plantingWindowOf(cell) {
        // start = transplant_date if present, otherwise sow_date                                  
        const start = parseISO(cell.getAttribute('transplant_date')) ||
            parseISO(cell.getAttribute('sow_date'));

        // end = harvest_end only                                                                  
        const end = parseISO(cell.getAttribute('harvest_end'));

        return (start && end && end >= start) ? { start, end } : null;
    }

    // Inclusive overlap in whole days                                                       
    function inclusiveOverlapDays(w1, w2) {
        if (!w1 || !w2) return null;
        const s = Math.max(+w1.start, +w2.start);
        const e = Math.min(+w1.end, +w2.end);
        if (e < s) return 0;
        return Math.floor((e - s) / MS_PER_DAY) + 1;
    }

    // -------------------- Overlap badges UI ----------------------------------------------
    function styleOverlapBadge(el) {
        el.style.position = 'absolute';
        el.style.width = OVERLAP_BADGE_W + 'px';
        el.style.height = OVERLAP_BADGE_H + 'px';
        el.style.zIndex = '100000';
        el.style.pointerEvents = 'none';
        el.style.border = '1px solid #000';
        el.style.borderRadius = '10px';
        el.style.background = 'rgba(255,255,255,0.9)';
        el.style.font = '11px/18px sans-serif';
        el.style.textAlign = 'center';
    }

    function ensureOverlapBadgesFor(key) {
        const host = getHost();
        const st = clusterStates.get(key); if (!st) return;
        if (!st.badgePrev) {
            st.badgePrev = document.createElement('div');
            styleOverlapBadge(st.badgePrev);
            host.appendChild(st.badgePrev);
        } else if (st.badgePrev.parentNode !== host) {
            host.appendChild(st.badgePrev);
        }
        if (!st.badgeNext) {
            st.badgeNext = document.createElement('div');
            styleOverlapBadge(st.badgeNext);
            host.appendChild(st.badgeNext);
        } else if (st.badgeNext.parentNode !== host) {
            host.appendChild(st.badgeNext);
        }
        st.badgePrev.style.display = '';
        st.badgeNext.style.display = '';
    }

    function updateOverlapValuesFor(key) {
        const st = clusterStates.get(key); if (!st) return;
        ensureOverlapBadgesFor(key);
        const i = st.currentIdx;
        const curr = st.order[i];
        const wCurr = plantingWindowOf(curr);
        console.debug('[Overlap] current', curr?.id, wCurr);

        let prevText = '–', prevDim = true;
        if (i > 0) {
            const prevCell = st.order[i - 1];
            const wPrev = plantingWindowOf(prevCell);
            const d = inclusiveOverlapDays(wCurr, wPrev);
            console.debug('[Overlap] prev', prevCell?.id, wPrev, 'days=', d);
            if (d == null) { prevText = '–'; prevDim = true; } else { prevText = String(d); prevDim = (d === 0); }
        }
        let nextText = '–', nextDim = true;
        if (i < st.order.length - 1) {
            const nextCell = st.order[i + 1];
            const wNext = plantingWindowOf(nextCell);
            const d = inclusiveOverlapDays(wCurr, wNext);
            console.debug('[Overlap] next', nextCell?.id, wNext, 'days=', d);
            if (d == null) { nextText = '–'; nextDim = true; } else { nextText = String(d); nextDim = (d === 0); }
        }
        st.badgePrev.textContent = prevText;
        st.badgePrev.style.opacity = prevDim ? '0.6' : '1.0';
        st.badgeNext.textContent = nextText;
        st.badgeNext.style.opacity = nextDim ? '0.6' : '1.0';
    }

    function positionOverlapBadgesFor(key) {
        const st = clusterStates.get(key); if (!st) return;
        const box = getClusterBBox(key); if (!box) { hideUIFor(key); return; }
        // Place badges horizontally flush with where buttons would be                        
        const prevLeft = Math.round(box.x - BTN_SIZE - BTN_INSET - OVERLAP_BADGE_W - 4);
        const prevTop = Math.round(box.y + box.h / 2 - OVERLAP_BADGE_H / 2);
        const nextLeft = Math.round(box.x + box.w + BTN_INSET + BTN_SIZE + 4);
        const nextTop = prevTop;
        st.badgePrev.style.left = prevLeft + 'px';
        st.badgePrev.style.top = prevTop + 'px';
        st.badgeNext.style.left = nextLeft + 'px';
        st.badgeNext.style.top = nextTop + 'px';
    }


    // -------------------- Per-cluster UI helpers --------------------
    function styleBtn(el) {
        el.style.position = 'absolute';
        el.style.width = BTN_SIZE + 'px';
        el.style.height = BTN_SIZE + 'px';
        el.style.zIndex = '100000';
        el.style.cursor = 'pointer';
        el.style.pointerEvents = 'auto';
    }

    function styleSelectBtn(el) {
        el.style.position = 'absolute';
        el.style.width = BTN_SIZE + 'px';
        el.style.height = BTN_SIZE + 'px';
        el.style.zIndex = '100000';
        el.style.cursor = 'pointer';
        el.style.pointerEvents = 'auto';
        el.style.userSelect = 'none';
    }


    function consumeEvt(evt) {
        if (evt) mxEvent.consume(evt);
    }

    function setNavEnabled(btn, enabled) {
        if (!btn) return;
        btn.dataset.navEnabled = enabled ? '1' : '0';
        btn.style.cursor = enabled ? 'pointer' : 'default';
        btn.style.opacity = enabled ? '1' : '0.35';
    }

    function isNavEnabled(btn) {
        return !!btn && btn.dataset.navEnabled === '1';
    }


    function ensureButtonsFor(key) {
        const host = getHost();
        const st = clusterStates.get(key); if (!st) return;

        if (!st.btnPrev) {
            st.btnPrev = document.createElement('img');
            st.btnPrev.src = ICON_PREV; styleBtn(st.btnPrev); st.btnPrev.title = 'Previous';
            st.btnPrev.draggable = false;

            st.btnPrev.addEventListener('pointerdown', consumeEvt, { passive: false });
            st.btnPrev.addEventListener('mousedown', consumeEvt, { passive: false });

            st.btnPrev.addEventListener('click', function (evt) {
                consumeEvt(evt);
                if (!isNavEnabled(st.btnPrev)) return;
                onCycleCluster(key, -1);
            });

            host.appendChild(st.btnPrev);
        } else if (st.btnPrev.parentNode !== host) { host.appendChild(st.btnPrev); }

        if (!st.btnNext) {
            st.btnNext = document.createElement('img');
            st.btnNext.src = ICON_NEXT; styleBtn(st.btnNext); st.btnNext.title = 'Next';
            st.btnNext.draggable = false;

            st.btnNext.addEventListener('pointerdown', consumeEvt, { passive: false });
            st.btnNext.addEventListener('mousedown', consumeEvt, { passive: false });

            st.btnNext.addEventListener('click', function (evt) {
                consumeEvt(evt);
                if (!isNavEnabled(st.btnNext)) return;
                onCycleCluster(key, +1);
            });

            host.appendChild(st.btnNext);
        } else if (st.btnNext.parentNode !== host) { host.appendChild(st.btnNext); }

        st.btnPrev.style.display = '';
        st.btnNext.style.display = '';
    }

    function ensureSelectAllFor(key) {
        const host = getHost();
        const st = clusterStates.get(key); if (!st) return;

        if (!st.btnSelectAll) {
            const b = document.createElement('img');
            b.src = ICON_SELECT;
            b.alt = 'Select';
            styleSelectBtn(b);
            b.title = 'Select entire cluster';
            b.draggable = false;

            b.addEventListener('pointerdown', consumeEvt, { passive: false });
            b.addEventListener('mousedown', consumeEvt, { passive: false });

            b.addEventListener('click', function (evt) {
                consumeEvt(evt);
                const st2 = clusterStates.get(key);
                if (!st2 || !st2.order || st2.order.length < 2) return;

                const members = st2.order.slice();
                clearVisibilityFor(key);
                graph.setSelectionCells(members);
                graph.refresh();
                hideUIFor(key);
            });

            host.appendChild(b);
            st.btnSelectAll = b;
        } else if (st.btnSelectAll.parentNode !== host) {
            host.appendChild(st.btnSelectAll);
        }

        st.btnSelectAll.style.display = '';
    }

    function ensureSelectBedsFor(key) {
        const host = getHost();
        const st = clusterStates.get(key); if (!st) return;

        if (!st.btnSelectBeds) {
            const b = document.createElement('img');
            b.src = ICON_SELECT_BEDS;
            b.alt = 'Select beds';
            styleSelectBtn(b);
            b.title = 'Select garden beds (temporary bring-to-front)';
            b.draggable = false;

            b.addEventListener('pointerdown', consumeEvt, { passive: false });
            b.addEventListener('mousedown', consumeEvt, { passive: false });

            b.addEventListener('click', function (evt) {
                consumeEvt(evt);
                const st2 = clusterStates.get(key);
                if (!st2 || !st2.order || !st2.order.length) return;
            
                const parent = model.getParent(st2.order[0]);
                if (!parent) return;
            
                const beds = bedsForCluster(key);                                                               
                if (!beds.length) return;                                                                       
            
                bringCellsToFrontTemporarilyInParent(parent, beds);
                clearVisibilityFor(key);
                graph.setSelectionCells(beds);                                                                  
                graph.refresh(parent);
                hideUIFor(key);
            });
            

            host.appendChild(b);
            st.btnSelectBeds = b;
        } else if (st.btnSelectBeds.parentNode !== host) {
            host.appendChild(st.btnSelectBeds);
        }

        st.btnSelectBeds.style.display = '';
    }

    function ensureBadgeFor(key) {
        const host = getHost();
        const st = clusterStates.get(key); if (!st) return;
        if (!st.badge) {
            const b = document.createElement('div');
            b.style.position = 'absolute';
            b.style.zIndex = '100000';
            b.style.padding = '2px 6px';
            b.style.font = '12px/16px sans-serif';
            b.style.background = 'rgba(255,255,255,0.9)';
            b.style.border = '1px solid #000';
            b.style.borderRadius = '10px';
            b.style.pointerEvents = 'none';
            b.style.width = '54px';
            b.style.textAlign = 'center';
            host.appendChild(b);
            st.badge = b;
        } else if (st.badge.parentNode !== host) {
            host.appendChild(st.badge);
        }
        st.badge.style.display = '';
    }

    function hideUIFor(key) {
        const st = clusterStates.get(key); if (!st) return;
        if (st.btnPrev) st.btnPrev.style.display = 'none';
        if (st.btnNext) st.btnNext.style.display = 'none';
        if (st.badge) st.badge.style.display = 'none';
        if (st.badgePrev) st.badgePrev.style.display = 'none';
        if (st.badgeNext) st.badgeNext.style.display = 'none';
        if (st.btnSelectAll) st.btnSelectAll.style.display = 'none';
        if (st.btnSelectBeds) st.btnSelectBeds.style.display = 'none';

    }

    // compute cluster bounding box from member states                         
    function getClusterBBox(key) {
        const st = clusterStates.get(key); if (!st) return null;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const c of st.order) {
            const s = getState(c);
            if (!s) continue;
            if (s.x < minX) minX = s.x;
            if (s.y < minY) minY = s.y;
            const rx = s.x + s.width, ry = s.y + s.height;
            if (rx > maxX) maxX = rx;
            if (ry > maxY) maxY = ry;
        }
        if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) return null;
        return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }


    function positionUIFor(key) {
        const st = clusterStates.get(key); if (!st) return;
        const box = getClusterBBox(key);
        if (!box) { hideUIFor(key); return; }

        const midY = box.y + box.h / 2;
        st.btnPrev.style.left = Math.round(box.x - BTN_SIZE - BTN_INSET) + 'px';
        st.btnPrev.style.top = Math.round(midY - BTN_SIZE / 2) + 'px';
        st.btnNext.style.left = Math.round(box.x + box.w + BTN_INSET) + 'px';
        st.btnNext.style.top = Math.round(midY - BTN_SIZE / 2) + 'px';

        const gap = 6, cx = box.x + box.w / 2;
        st.badge.textContent = (st.currentIdx + 1) + ' / ' + st.order.length;
        const bw = 54, bh = 18;
        st.badge.style.left = Math.round(cx - bw / 2) + 'px';
        st.badge.style.top = Math.round(box.y - bh - gap) + 'px';

        // place select buttons at the top-left outside corner of the cluster bbox
        if (st.btnSelectAll || st.btnSelectBeds) {
            const baseX = Math.round(box.x - BTN_SIZE - BTN_INSET);
            const y = Math.round(box.y - BTN_SIZE - BTN_INSET);
            const gap = 4;

            // Left: beds, Right: cluster (so they read left->right)                     
            if (st.btnSelectBeds) {
                st.btnSelectBeds.style.left = baseX + 'px';
                st.btnSelectBeds.style.top = y + 'px';
            }
            if (st.btnSelectAll) {
                const x2 = baseX + (st.btnSelectBeds ? (BTN_SIZE + gap) : 0);
                st.btnSelectAll.style.left = x2 + 'px';
                st.btnSelectAll.style.top = y + 'px';
            }
        }

        updateOverlapValuesFor(key);
        positionOverlapBadgesFor(key);
    }

    function updateControlsVisibilityFor(key) {
        const st = clusterStates.get(key); if (!st) return;
        const last = st.order.length - 1;

        if (st.btnPrev) setNavEnabled(st.btnPrev, st.currentIdx > 0);
        if (st.btnNext) setNavEnabled(st.btnNext, st.currentIdx < last);

        if (st.badgePrev) st.badgePrev.style.opacity = (st.currentIdx > 0) ? '1' : '0.35';
        if (st.badgeNext) st.badgeNext.style.opacity = (st.currentIdx < last) ? '1' : '0.35';
    }


    // -------------------- Per-cluster visibility --------------------
    function clearVisibilityFor(key) {
        const st = clusterStates.get(key);
        if (!st) return;

        // Restore ALL members (not only st.dimmed), because current TG is never in dimmed. 
        const members = (st.order || []).slice();
        if (!members.length) return;

        st.dimmed.clear();
        restoreBaselineTGDeep(members);
    }

    function applyVisibilityFor(key) {
        const st = clusterStates.get(key); if (!st) return;
        if (st.order.length < 2) { clearVisibilityFor(key); return; }

        const curr = st.order[st.currentIdx];
        const nextDim = new Set(st.order.filter((c, i) => i !== st.currentIdx));

        // Dim newly added
        const toDim = [];
        nextDim.forEach(c => { if (!st.dimmed.has(c)) toDim.push(c); });
        if (toDim.length) {
            setOutlineOnlyVisibleDeep(toDim, false);
            setOpacityDeep(toDim, SELECTED_TG_OPACITY);
        }

        // Ensure current is fully visible
        setOutlineOnlyVisibleDeep([curr], true);
        setOpacityDeep([curr], SELECTED_TG_OPACITY);

        st.dimmed = nextDim;
    }


    // -------------------- Navigation per cluster --------------------
    function bringCellToFrontInParent(cell) {
        if (!cell) return;
        const p = model.getParent(cell);
        if (!p) return;
        model.beginUpdate();
        try {
            const topIdx = model.getChildCount(p);
            model.add(p, cell, topIdx);
        } finally {
            model.endUpdate();
        }
        graph.refresh(cell);
    }

    // -------------------- NEW: temporary bed front-ordering --------------------
    const parentOrderSnapshots = new Map(); // parentId -> [childId,...]               
    let lastSelectedBedParent = null;

    function snapshotChildOrder(parent) {
        if (!parent || !parent.id) return;
        if (parentOrderSnapshots.has(parent.id)) return;
        const n = model.getChildCount(parent);
        const ids = [];
        for (let i = 0; i < n; i++) {
            const c = model.getChildAt(parent, i);
            ids.push(c && c.id ? c.id : null);
        }
        parentOrderSnapshots.set(parent.id, ids);
    }

    function restoreChildOrder(parent) {
        if (!parent || !parent.id) return;
        const snap = parentOrderSnapshots.get(parent.id);
        if (!snap) return;

        // Re-add children in the snap order (ignoring missing/null ids)
        model.beginUpdate();
        try {
            let idx = 0;
            for (const id of snap) {
                if (!id) continue;
                const cell = model.getCell(id);
                if (!cell) continue;
                if (model.getParent(cell) !== parent) continue;
                model.add(parent, cell, idx++);
            }
        } finally {
            model.endUpdate();
        }
        parentOrderSnapshots.delete(parent.id);
        graph.refresh(parent);
    }

    function bringCellsToFrontTemporarilyInParent(parent, cells) {
        if (!parent || !cells || !cells.length) return;

        // Snapshot once, then move target cells to the end in their current order
        snapshotChildOrder(parent);

        // Preserve relative order as currently in parent
        const n = model.getChildCount(parent);
        const order = [];
        const set = new Set(cells.map(c => c && c.id).filter(Boolean));
        for (let i = 0; i < n; i++) {
            const c = model.getChildAt(parent, i);
            if (c && set.has(c.id)) order.push(c);
        }
        if (!order.length) return;

        model.beginUpdate();
        try {
            for (const c of order) {
                model.add(parent, c, model.getChildCount(parent)); // always append
            }
        } finally {
            model.endUpdate();
        }

        lastSelectedBedParent = parent;
        graph.refresh(parent);
    }


    function bringToFrontAndSelect(cell) {
        bringCellToFrontInParent(cell);
        graph.setSelectionCell(cell);
        lastSelectedPlantingId = cell ? cell.id : null;                                     
        lastSelectedPlantingParent = cell ? model.getParent(cell) : null;                  
    }

    function onCycleCluster(key, dir) {
        const st = clusterStates.get(key); if (!st) return;
        let i = st.currentIdx;
        i = (i + dir + st.order.length) % st.order.length;
        st.currentIdx = i;
        st.anchorId = st.order[i].id;
        bringToFrontAndSelect(st.order[i]);

        // keep time order & anchor
        st.order = orderComponentByTime(st.order);
        st.currentIdx = st.order.findIndex(c => c.id === st.anchorId);

        ensureButtonsFor(key);
        ensureBadgeFor(key);
        updateControlsVisibilityFor(key);
        positionUIFor(key);
        applyVisibilityFor(key);

        updateOverlapValuesFor(key);
        positionOverlapBadgesFor(key);
    }

    // -------------------- Orchestration --------------------
    function refreshClustersInParent(parent, preferredAnchorId, selectedId) {
        const comps = buildAllComponentsInParent(parent);
        const liveKeys = new Set();

        for (const members of comps) {
            const { key } = ensureClusterState(members, preferredAnchorId);
            liveKeys.add(key);

            // Only show UI/dimming for the cluster containing the selected tiler group
            const isSelectedCluster = selectedId && members.some(c => c.id === selectedId);
            if (!isSelectedCluster) {
                hideUIFor(key);
                clearVisibilityFor(key);
                continue;
            }

            ensureButtonsFor(key);
            ensureBadgeFor(key);
            ensureSelectAllFor(key);
            ensureSelectBedsFor(key);
            updateControlsVisibilityFor(key);
            positionUIFor(key);
            applyVisibilityFor(key);

        }

        for (const [key, st] of clusterStates.entries()) {
            if (!liveKeys.has(key)) {
                hideUIFor(key);
                clearVisibilityFor(key);
                clusterStates.delete(key);
            }
        }
    }

    // Collect all tiler groups recursively under a root
    function collectAllTilerGroupsRec(root) {
        const out = [];
        const stack = [root];
        while (stack.length) {
            const p = stack.pop();
            const childCount = model.getChildCount(p);
            for (let i = 0; i < childCount; i++) {
                const c = model.getChildAt(p, i);
                if (model.isVertex(c)) {
                    if (isTilerGroup(c)) out.push(c);
                }
                // Recurse into both vertices and groups/containers
                if (model.getChildCount(c) > 0) stack.push(c);
            }
        }
        return out;
    }

    // REPLACE parentsToScan() with grouping by actual immediate parent
    function parentsToScan() {
        const root = model.getRoot();
        const currentLayer = graph.getDefaultParent();
        const layers = [];
        const layerCount = model.getChildCount(root);
        for (let i = 0; i < layerCount; i++) layers.push(model.getChildAt(root, i));

        // Collect all tiler groups across all layers
        const allTGs = [];
        for (const layer of layers) allTGs.push(...collectAllTilerGroupsRec(layer));

        // Group by each tiler group's immediate parent
        const byParent = new Map();
        for (const tg of allTGs) {
            const p = model.getParent(tg);
            if (!byParent.has(p)) byParent.set(p, []);
            byParent.get(p).push(tg);
        }

        // Return only parents that have at least 2 tiler groups (eligible for clustering)
        const parents = [];
        for (const [p, arr] of byParent.entries()) if (arr.length >= 2) parents.push(p);

        // Fallback to current layer if nothing else qualifies (keeps behavior predictable)
        if (!parents.length) parents.push(currentLayer);
        return parents;
    }

    function refreshAllForSelectionOrAnchor() {
        const sel = graph.getSelectionCell();
        const preferred = sel && isTilerGroup(sel) ? sel.id : null;
        lastSelectedTGId = preferred || null;

        // If no tiler group is selected, hide all cluster UI and restore baseline visuals.
        if (!lastSelectedTGId) {
            for (const [k] of clusterStates.entries()) {
                hideUIFor(k);
                clearVisibilityFor(k);
            }
            return;
        }

        // Drive clustering only for the selection's parent as before
        const selCell = model.getCell(lastSelectedTGId);
        const p = selCell ? model.getParent(selCell) : null;
        if (p) {
            refreshClustersInParent(p, preferred, lastSelectedTGId);
            // Prune clusters not under this parent
            for (const [k, st] of clusterStates.entries()) {
                if (!st.order.every(c => model.getParent(c) === p)) {
                    hideUIFor(k);
                    clearVisibilityFor(k);
                    clusterStates.delete(k);
                }
            }
            return;
        }

        // Fallback (rare): scan parents but still gate by selected id                 
        const parents = parentsToScan();
        const live = new Set();
        parents.forEach(par => {
            refreshClustersInParent(par, preferred, lastSelectedTGId);
            for (const k of clusterStates.keys()) live.add(k);
        });
        for (const [k, st] of clusterStates.entries()) {
            const exists = st.order.every(c => !!model.getCell(c.id));
            if (!exists) {
                hideUIFor(k);
                clearVisibilityFor(k);
                clusterStates.delete(k);
            }
        }
    }



    function repositionAllUI() {
        for (const [key, st] of clusterStates.entries()) {
            // Only reposition visible UI (selected cluster only)                      
            if (!st.btnPrev || st.btnPrev.style.display === 'none') continue;
            positionUIFor(key);
        }
    }



    // -------------------- Events --------------------
    let lastSelectedPlantingId = null;
    let lastSelectedPlantingParent = null;

    graph.getSelectionModel().addListener(mxEvent.CHANGE, function () {
        const sel = graph.getSelectionCell();

        //if we previously brought beds to front, restore when leaving bed selection
        const selIsBed = sel && model.isVertex(sel) && isGardenBed(sel);
        if (lastSelectedBedParent && !selIsBed) {
            restoreChildOrder(lastSelectedBedParent);
            lastSelectedBedParent = null;
        }

        const selIsPlanting = sel && model.isVertex(sel) && isPlantingCell(sel);

        // If we just deselected a planting (or switched away), snap canopy in old parent
        if (lastSelectedPlantingId && (!selIsPlanting || sel.id !== lastSelectedPlantingId)) {
            scheduleCanopySnap(lastSelectedPlantingParent);
            lastSelectedPlantingId = null;
            lastSelectedPlantingParent = null;
        }

        // If selecting a planting, bring it to front (temporary) and remember it
        if (selIsPlanting) {
            graph.orderCells(false, [sel]); // to front                                
            lastSelectedPlantingId = sel.id;
            lastSelectedPlantingParent = model.getParent(sel);
        }

        rafDebounce(refreshAllForSelectionOrAnchor);
    });

    graph.addListener(mxEvent.CELLS_MOVED, function () { rafDebounce(refreshAllForSelectionOrAnchor); });
    graph.addListener(mxEvent.CELLS_RESIZED, function () { rafDebounce(refreshAllForSelectionOrAnchor); });
    graph.addListener(mxEvent.ADD_CELLS, function () { rafDebounce(refreshAllForSelectionOrAnchor); });
    graph.addListener(mxEvent.REMOVE_CELLS, function () { rafDebounce(refreshAllForSelectionOrAnchor); });
    graph.getModel().addListener(mxEvent.UNDO, function () { rafDebounce(refreshAllForSelectionOrAnchor); });
    graph.getModel().addListener(mxEvent.REDO, function () { rafDebounce(refreshAllForSelectionOrAnchor); });

    graph.getView().addListener(mxEvent.SCALE_AND_TRANSLATE, function () {
        repositionAllUI();
    });
    graph.getView().addListener(mxEvent.REPAINT, function () {
        repositionAllUI();
    });

    // Init
    setTimeout(refreshAllForSelectionOrAnchor, 0);
});
