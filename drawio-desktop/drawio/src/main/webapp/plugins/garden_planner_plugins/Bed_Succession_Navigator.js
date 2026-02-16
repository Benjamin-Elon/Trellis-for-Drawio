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
    const TIME_ATTRS_ASC = ['transplant_date', 'sow_date'];                                  
    const EPS = 0; // inclusive AABB; set >0 to treat near-miss as overlap

    // overlap badges config                                                             
    const MS_PER_DAY = 24 * 60 * 60 * 1000;                                                  
    const OVERLAP_BADGE_W = 34;                                                              
    const OVERLAP_BADGE_H = 18;

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


    // Inclusive AABB: edges/corners count as overlap
    function rectsOverlap(a, b) {
        if (!a || !b) return false;
        return (a.x - EPS) <= (b.x + b.w + EPS) &&
            (b.x - EPS) <= (a.x + a.w + EPS) &&
            (a.y - EPS) <= (b.y + b.h + EPS) &&
            (b.y - EPS) <= (a.y + a.h + EPS);
    }

    function getSiblingsInParent(parent) {
        const verts = graph.getChildVertices(parent) || [];
        return verts.filter(isTilerGroup);
    }

    // -------------------- NEW: selection-aware helpers --------------------          
    let lastSelectedTGId = null;                                                      
    function clusterContainsId(key, cellId) {                                         
        const st = clusterStates.get(key);                                            
        return !!st && st.order.some(c => c.id === cellId);                           
    }                                                                                 


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
        const adj = Array.from({ length: n }, () => []);
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                if (rectsOverlap(bounds[i], bounds[j])) { adj[i].push(j); adj[j].push(i); }
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
                badgeNext: null    
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

    function ensureButtonsFor(key) {
        const host = getHost();
        const st = clusterStates.get(key); if (!st) return;

        if (!st.btnPrev) {
            st.btnPrev = document.createElement('img');
            st.btnPrev.src = ICON_PREV; styleBtn(st.btnPrev); st.btnPrev.title = 'Previous';
            st.btnPrev.addEventListener('click', function (evt) { onCycleCluster(key, -1); mxEvent.consume(evt); });
            host.appendChild(st.btnPrev);
        } else if (st.btnPrev.parentNode !== host) { host.appendChild(st.btnPrev); }

        if (!st.btnNext) {
            st.btnNext = document.createElement('img');
            st.btnNext.src = ICON_NEXT; styleBtn(st.btnNext); st.btnNext.title = 'Next';
            st.btnNext.addEventListener('click', function (evt) { onCycleCluster(key, +1); mxEvent.consume(evt); });
            host.appendChild(st.btnNext);
        } else if (st.btnNext.parentNode !== host) { host.appendChild(st.btnNext); }

        st.btnPrev.style.display = '';
        st.btnNext.style.display = '';
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
            b.style.width = '54px';  // fixed to avoid reflow reads                 
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

        updateOverlapValuesFor(key);                                                            
        positionOverlapBadgesFor(key);                                                         
    }

    function updateControlsVisibilityFor(key) {
        const st = clusterStates.get(key); if (!st) return;
        const last = st.order.length - 1;
        st.btnPrev.style.display = (st.currentIdx <= 0) ? 'none' : '';
        st.btnNext.style.display = (st.currentIdx >= last) ? 'none' : '';
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
    function bringToFrontAndSelect(cell) {
        graph.orderCells(false, [cell]); // to front
        graph.setSelectionCell(cell);
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
    graph.getSelectionModel().addListener(mxEvent.CHANGE, function () {
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
