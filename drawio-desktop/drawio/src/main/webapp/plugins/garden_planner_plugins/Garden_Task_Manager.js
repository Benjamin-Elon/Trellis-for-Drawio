/**
 * Draw.io Plugin: Task Manager (Kanban Template Style + Auto Placement + Auto Archive + Badges)
 */
Draw.loadPlugin(function (ui) {
    const graph = ui.editor.graph;
    const model = graph.getModel();

    const BOARD_KEY = 'KANBAN_BOARD';
    const BOARD_ROLE_ATTR = 'board_role';

    // -------------------- Template styles --------------------
    const BOARD_STYLE =
        'swimlane;fontStyle=2;childLayout=stackLayout;horizontal=1;startSize=28;horizontalStack=1;resizeParent=1;resizeParentMax=0;resizeLast=0;collapsible=1;marginBottom=0;swimlaneFillColor=none;fontFamily=Permanent Marker;fontSize=16;points=[];verticalAlign=top;stackBorder=0;resizable=1;strokeWidth=2;disableMultiStroke=1;';
    const LANE_STYLE_BASE =
        'swimlane;strokeWidth=2;fontFamily=Permanent Marker;html=0;startSize=1;verticalAlign=bottom;spacingBottom=5;points=[];childLayout=stackLayout;stackBorder=20;stackSpacing=20;resizeLast=0;resizeParent=1;horizontalStack=0;collapsible=1;fillStyle=solid;fillColor=#f8cecc;swimlaneFillColor=default;';
    const CARD_STYLE =
        'whiteSpace=wrap;html=1;strokeWidth=2;fillColor=swimlane;fontStyle=1;spacingTop=0;rounded=1;arcSize=9;points=[];fontFamily=Permanent Marker;hachureGap=8;fillWeight=1;';

    // Lane fills
    const LANE_FILL = [
        '#C7D2FE', // UPCOMING (year)
        '#BAE6FD', // UPCOMING (month)
        '#BBF7D0', // UPCOMING (week)
        '#E5E7EB', // TODO (staged)
        '#F8CECC', // TODO
        '#FFF2CC', // DOING
        '#D5E8D4', // DONE
        '#D1FAE5', // DONE (week)
        '#A7F3D0', // DONE (month)
        '#6EE7B7', // DONE (year)
        '#F3F4F6'  // ARCHIVED
    ];

    const BOARD_GEOM = { x: 40, y: 40, w: 2200, h: 760 };
    const LANE_W = 220, LANE_H = 680, LANE_GAP = 16;

    const LINK_ATTR = 'linkedTo';

    const LANES = [
        { key: 'UPCOMING_YEAR', label: 'UPCOMING (year)' },
        { key: 'UPCOMING_MONTH', label: 'UPCOMING (month)' },
        { key: 'UPCOMING_WEEK', label: 'UPCOMING (week)' },
        { key: 'TODO_STAGED', label: 'TODO (staged)' },
        { key: 'TODO', label: 'TODO' },
        { key: 'DOING', label: 'DOING' },
        { key: 'DONE', label: 'DONE' },
        { key: 'DONE_WEEK', label: 'DONE (week)' },
        { key: 'DONE_MONTH', label: 'DONE (month)' },
        { key: 'DONE_YEAR', label: 'DONE (year)' },
        { key: 'ARCHIVED', label: 'ARCHIVED' }
    ];

    // -------------------- Helpers --------------------
    function ensureXmlValue(cell) {
        if (!cell.value || typeof cell.value === 'string') {
            const doc = mxUtils.createXmlDocument();
            const obj = doc.createElement('object');
            obj.setAttribute('label', cell.value || '');
            cell.value = obj;
        }
        return cell.value;
    }
    function setAttrUndoable(cell, k, v) {
        ensureXmlValue(cell);
        model.execute(new mxCellAttributeChange(cell, k, v == null ? null : String(v)));
    }
    function getAttr(cell, k) {
        const v = cell && cell.value;
        return (v && v.getAttribute) ? v.getAttribute(k) : null;
    }
    function createVertex(label, x, y, w, h, style) {
        const v = new mxCell(label || '', new mxGeometry(x, y, w, h), style || '');
        v.setVertex(true);
        v.setConnectable(false);
        return v;
    }

    // Garden-module helpers
    function isGardenModule(cell) { return getAttr(cell, 'garden_module') === '1'; }
    function findGardenModuleAncestor(cell) {
        if (!cell) return null;
        let cur = cell;
        while (cur) {
            if (isGardenModule(cur)) return cur;
            cur = model.getParent(cur);
        }
        return null;
    }

    function ensureBoardTemplateIn(containerVertex) {
        const parent = containerVertex || graph.getDefaultParent();
        let { main } = findBoardsIn(parent);

        model.beginUpdate();
        try {
            let board = main;
            if (!board) {
                board = createVertex('Kanban', BOARD_GEOM.x, BOARD_GEOM.y, BOARD_GEOM.w, BOARD_GEOM.h, BOARD_STYLE);
                model.add(parent, board, model.getChildCount(parent));
                setAttrUndoable(board, 'board_key', BOARD_KEY);
                setAttrUndoable(board, BOARD_ROLE_ATTR, 'main');
                main = board;
            }
            ensureLanes(main);
            return { parent, board: main, lanes: lanesMap(main) };
        } finally { model.endUpdate(); }
    }

    function createSecondaryBoardIn(parent) {
        const board = createVertex('Kanban', BOARD_GEOM.x, BOARD_GEOM.y, BOARD_GEOM.w, BOARD_GEOM.h, BOARD_STYLE);
        model.add(parent, board, model.getChildCount(parent));
        setAttrUndoable(board, 'board_key', BOARD_KEY);
        setAttrUndoable(board, BOARD_ROLE_ATTR, 'secondary');
        ensureLanes(board);
        return board;
    }

    function ensureLanes(board) {
        const existingByKey = {};
        const count = model.getChildCount(board);
        for (let i = 0; i < count; i++) {
            const ch = model.getChildAt(board, i);
            if (!model.isVertex(ch)) continue;
            const k = getAttr(ch, 'lane_key');
            if (k) existingByKey[k] = ch;
        }
        let x = 10, y = 28;
        LANES.forEach((lane, idx) => {
            const fill = LANE_FILL[idx % LANE_FILL.length];
            const style = LANE_STYLE_BASE + 'fillColor=' + fill + ';strokeColor=' + fill + ';';
            let laneCell = existingByKey[lane.key];
            if (!laneCell) {
                laneCell = createVertex(lane.label, x, y, LANE_W, LANE_H, style);
                model.add(board, laneCell, model.getChildCount(board));
                setAttrUndoable(laneCell, 'lane_key', lane.key);
                setAttrUndoable(laneCell, 'status', lane.label);
            } else {
                laneCell.setStyle(style);
                ensureXmlValue(laneCell).setAttribute('label', lane.label);
                setAttrUndoable(laneCell, 'status', lane.label);
            }
            x += LANE_W + LANE_GAP;
        });
        const totalW = 10 + (LANES.length * LANE_W) + ((LANES.length - 1) * LANE_GAP) + 10;
        const geo = board.getGeometry().clone();
        geo.width = Math.max(totalW, BOARD_GEOM.w);
        geo.height = BOARD_GEOM.h;
        model.setGeometry(board, geo);
    }

    function lanesMap(board) {
        const lanes = {};
        const n = model.getChildCount(board);
        for (let i = 0; i < n; i++) {
            const ch = model.getChildAt(board, i);
            if (!model.isVertex(ch)) continue;
            const k = getAttr(ch, 'lane_key');
            if (k) lanes[k] = ch;
        }
        return lanes;
    }

    // Lane Helpers
    const PROTECTED_WORK_LANES = new Set(['TODO_STAGED', 'TODO', 'DOING']);

    function isDoneLikeLane(laneKey) {
        return laneKey === 'DONE' || laneKey === 'DONE_WEEK' ||
            laneKey === 'DONE_MONTH' || laneKey === 'DONE_YEAR' ||
            laneKey === 'ARCHIVED';
    }

    function isUpcomingLane(lk) {
        return lk === 'UPCOMING_YEAR' || lk === 'UPCOMING_MONTH' || lk === 'UPCOMING_WEEK';
    }

    function isWorkLane(laneKey) {
        return laneKey === 'UPCOMING_YEAR' || laneKey === 'UPCOMING_MONTH' ||
            laneKey === 'UPCOMING_WEEK' || laneKey === 'TODO_STAGED' ||
            laneKey === 'TODO' || laneKey === 'DOING';
    }

    // -------------------- Time helpers --------------------
    const MS_DAY = 86400000;
    function parseISO(iso) {
        if (!iso) return null;
        const [y, m, d] = iso.split('-').map(Number);
        if (!y || !m || !d) return null;
        return new Date(Date.UTC(y, m - 1, d));
    }
    function startOfUTCDay(d) {
        return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    }
    function todayISO() {
        const t = startOfUTCDay(new Date());
        const y = t.getUTCFullYear(), m = String(t.getUTCMonth() + 1).padStart(2, '0'), d = String(t.getUTCDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    function daysUntilUTC(dateISO) {
        const dt = parseISO(dateISO);
        if (!dt) return null;
        const today = startOfUTCDay(new Date());
        return Math.floor((dt - today) / MS_DAY);
    }
    function daysSinceUTC(dateISO) {
        const dt = parseISO(dateISO);
        if (!dt) return null;
        const today = startOfUTCDay(new Date());
        return Math.floor((today - dt) / MS_DAY);
    }
    function daysBetweenUTC(aISO, bISO) {
        const a = parseISO(aISO), b = parseISO(bISO);
        if (!a || !b) return null;
        return Math.floor((a - b) / MS_DAY);
    }
    function fmtSigned(n) {
        if (n == null) return '';
        if (n > 0) return '+' + n;
        return String(n);
    }

    // -------------------- Classification --------------------
    function decideUpcomingLaneKey(startISO) {
        const du = daysUntilUTC(startISO);
        if (du == null || du <= 0) return 'TODO_STAGED';
        if (du <= 7) return 'UPCOMING_WEEK';
        if (du <= 30) return 'UPCOMING_MONTH';
        if (du <= 365) return 'UPCOMING_YEAR';
        return 'TODO_STAGED';
    }

    function classifyDoneLane(ageDays) {
        if (ageDays == null || ageDays < 1) return 'DONE';        // safety default
        if (ageDays <= 7) return 'DONE_WEEK';
        if (ageDays <= 30) return 'DONE_MONTH';
        if (ageDays <= 365) return 'DONE_YEAR';
        return 'ARCHIVED';
    }


    // -------------------- Badge helpers --------------------                                           
    function computeDaysToStart(startISO) {
        const n = daysUntilUTC(startISO);
        return (n == null) ? null : n;
    }
    function computeDaysLeft(endISO) {
        const n = daysUntilUTC(endISO);
        return (n == null) ? null : n;
    }
    function computeCompletedDelta(endISO, compISO) {
        if (!endISO) return null;
        const comp = compISO || todayISO();
        const delta = daysBetweenUTC(endISO, comp);  // end - completed                                  
        if (delta == null) return null;
        if (delta === 0) return { text: 'On Time', numeric: 0 };
        if (delta > 0) return { text: delta + ' Days Early', numeric: delta };
        return { text: Math.abs(delta) + ' Days Late', numeric: delta };
    }
    function renderBadge(label, text) {
        if (text == null || text === '') return '';
        return '<span style="display:inline-block;margin:2px 4px 0 0;border:1px solid #000;padding:0 6px;border-radius:10px;font-size:11px;line-height:16px;vertical-align:middle;"><b>' +
            mxUtils.htmlEntities(label) + ':</b> ' + mxUtils.htmlEntities(String(text)) + '</span>';
    }
    function computeBadgesFor(card, laneKey) {
        const startISO = getAttr(card, 'start');
        const endISO = getAttr(card, 'end');
        const compISO = getAttr(card, 'completed');
        if (isUpcomingLane(laneKey)) {
            const dts = computeDaysToStart(startISO);
            return { primaryText: (dts == null ? '' : String(dts)), html: renderBadge('Days to Start', dts) };
        }
        if (isWorkLane(laneKey)) {
            const dl = computeDaysLeft(endISO);
            return { primaryText: (dl == null ? '' : String(dl)), html: renderBadge('Days Left', dl) };
        }
        // DONE-like lanes                                                                                
        const delta = computeCompletedDelta(endISO, compISO);
        const text = delta ? delta.text : '';
        const primary = delta ? (delta.numeric === 0 ? '0' : fmtSigned(delta.numeric)) : '';
        return { primaryText: primary, html: renderBadge('Completed Time', text) };
    }

    function getLinkCount(cell) {
        return getLinkSet(cell).size;
    }


    // -------------------- Sorting helpers --------------------                                             
    function tsFromISO(iso) {
        const d = parseISO(iso);
        return d ? d.getTime() : null;
    }

    function getLaneSortKey(laneKey, card) {
        if (isUpcomingLane(laneKey)) {
            const dts = computeDaysToStart(getAttr(card, 'start'));
            return (dts == null) ? Number.POSITIVE_INFINITY : dts;
        }
        if (PROTECTED_WORK_LANES.has(laneKey)) {
            const dl = computeDaysLeft(getAttr(card, 'end'));
            return (dl == null) ? Number.POSITIVE_INFINITY : dl;
        }
        if (isDoneLikeLane(laneKey)) {
            const compISO = getAttr(card, 'completed') || getAttr(card, 'end');
            const t = tsFromISO(compISO);
            // Most recent first -> larger timestamp first                                                  
            return (t == null) ? Number.NEGATIVE_INFINITY : t;
        }
        return Number.POSITIVE_INFINITY;
    }

    function sortLaneCards(lane, laneKey) {
        // Collect cards                                                                                    
        const items = [];
        const n = model.getChildCount(lane);
        for (let i = 0; i < n; i++) {
            const c = model.getChildAt(lane, i);
            if (model.isVertex(c) && getAttr(c, 'kanban_card') === '1') {
                const key = getLaneSortKey(laneKey, c);
                const title = (getAttr(c, 'title') || '').toLowerCase();
                items.push({ cell: c, key, title });
            }
        }
        if (!items.length) return;

        // Choose comparator                                                                                
        let cmp;
        if (isDoneLikeLane(laneKey)) {
            // Descending by timestamp (recent first). Nulls already mapped to -INF so they end last.       
            cmp = (a, b) => (b.key - a.key) || a.title.localeCompare(b.title);
        } else {
            // Ascending. Nulls mapped to +INF so they end last.                                            
            cmp = (a, b) => (a.key - b.key) || a.title.localeCompare(b.title);
        }

        const sorted = items.slice().sort(cmp);

        // Reinsert in desired order                                                                        
        model.beginUpdate();
        try {
            for (let i = 0; i < sorted.length; i++) {
                const c = sorted[i].cell;
                // Place at index i among lane children                                                     
                model.add(lane, c, i);
            }
        } finally { model.endUpdate(); }
    }

    // -------------------- Badge + label --------------------
    function refreshCardLabel(card) {
        if (getAttr(card, 'kanban_card') !== '1') return;                                  // guard non-cards
        const title = mxUtils.htmlEntities(getAttr(card, 'title') || 'Task');
        const parent = model.getParent(card);
        const laneKey = parent ? getAttr(parent, 'lane_key') : null;
        const badgesHtml = getAttr(card, 'badges_html') || '';

        // Compute link-count badge (only if > 1)                                                         
        const linkCount = getLinkCount(card);
        const linkBadge = (linkCount > 1) ? renderBadge('Links', linkCount) : '';

        const badgesBlock = (badgesHtml || linkBadge)
            ? ('<br/>' + badgesHtml + linkBadge)
            : '';

        const html = title + badgesBlock;

        ensureXmlValue(card).setAttribute('label', html);
        graph.refresh(card);                                                                                // force repaint so badge updates immediately
    }



    function setBadge(card, text) {
        setAttrUndoable(card, 'badge', text || '');
        // no refresh here; refreshCardLabel builds full badges block                                     
    }

    function updateBadgeForLane(card, laneKey) {
        const badges = computeBadgesFor(card, laneKey);
        setBadge(card, badges.primaryText || '');
        setAttrUndoable(card, 'badges_html', badges.html || '');
        refreshCardLabel(card);
    }


    // Delete old / unlink tasks
    function removeTasksLinkedOnlyTo(targetGroupId) {
        if (!targetGroupId) return;

        const grp = model.getCell(targetGroupId);
        if (!grp) return;

        // All cells currently linked FROM this group
        const linkedCells = getLinkedCellsOf(grp) || [];
        if (!linkedCells.length) return;

        // Mutable link set for the group itself
        const groupLinkSet = getLinkSet(grp);

        model.beginUpdate();
        try {
            for (const c of linkedCells) {
                // Only operate on Kanban cards
                if (!isKanbanCard(c)) continue;

                // All IDs linked TO this card
                const linkSet = getLinkSet(c);
                if (!linkSet || !linkSet.has(targetGroupId)) continue;

                if (linkSet.size === 1) {
                    // Case 1: card is linked ONLY to this group → delete card
                    groupLinkSet.delete(c.id);      // unlink from group side
                    model.remove(c);
                } else {
                    // Case 2: card is linked to this group AND others → just unlink this group
                    linkSet.delete(targetGroupId);  // unlink group on card side
                    setLinkSet(c, linkSet);         // writes back + refreshes label

                    groupLinkSet.delete(c.id);      // unlink card on group side
                }
            }

            // Write back updated group link set once
            setLinkSet(grp, groupLinkSet);

        } finally {
            model.endUpdate();
        }
    }



    // -------------------- Task creation --------------------
    async function createTasks(tasks, targetGroupId) {
        if (!Array.isArray(tasks) || tasks.length === 0) return [];

        let gardenModule = null;

        const grp = model.getCell(targetGroupId);
        if (grp) {
            const gm = findGardenModuleAncestor(grp);
            if (gm) gardenModule = gm;
        }

        const { lanes } = ensureBoardTemplateIn(gardenModule);

        const out = [];
        model.beginUpdate();
        try {
            for (const t of tasks) {
                const laneKey = decideUpcomingLaneKey(t.startISO);
                const parentLane = lanes[laneKey] || lanes['TODO_STAGED'];

                const card = createCard(parentLane, {
                    title: t.title,
                    notes: t.notes,
                    startISO: t.startISO,
                    endISO: t.endISO
                });

                if (t.method) setAttrUndoable(card, 'method', t.method);
                if (t.plant_name) setAttrUndoable(card, 'plant_name', t.plant_name);
                if (t.succession_index != null) {
                    setAttrUndoable(card, 'succession_index', String(t.succession_index));
                }

                // Link card to group                                                    
                if (grp) linkBothWays(grp, card);

                // Initialize badge based on initial lane
                updateBadgeForLane(card, getAttr(parentLane, 'lane_key'));

                out.push({ cellId: card.id, title: t.title });
            }
        } finally {
            model.endUpdate();
        }

        if (out.length) {
            const last = model.getCell(out[out.length - 1].cellId);
            if (last) {
                graph.setSelectionCell(last);
                graph.scrollCellToVisible(last, true);
            }
        }

        try { scanAllBoards(); } catch (_) { }
        return out;
    }


    function createCard(parentLane, { title, notes, startISO, endISO }) {
        const card = createVertex('', 0, 0, 160, 80, CARD_STYLE);
        model.add(parentLane, card, model.getChildCount(parentLane));
        setAttrUndoable(card, 'kanban_card', '1');
        setAttrUndoable(card, 'title', title || 'Task');
        if (notes) setAttrUndoable(card, 'notes', notes);
        if (startISO) setAttrUndoable(card, 'start', startISO);
        if (endISO) setAttrUndoable(card, 'end', endISO);
        const laneStatus = getAttr(parentLane, 'status') || parentLane.value || '';
        setAttrUndoable(card, 'status', laneStatus);
        setAttrUndoable(card, 'badge', '');
        setAttrUndoable(card, 'badges_html', '');
        refreshCardLabel(card);
        return card;
    }



    // -------------------- Linking --------------------
    function getLinkSet(cell) {
        const raw = getAttr(cell, LINK_ATTR);
        if (!raw) return new Set();
        return new Set(String(raw).split(',').map(s => s.trim()).filter(Boolean));
    }
    function setLinkSet(cell, set) {
        setAttrUndoable(cell, LINK_ATTR, Array.from(set).join(','));
        if (getAttr(cell, 'kanban_card') === '1') refreshCardLabel(cell);                  // refresh only for cards
    }
    function linkBothWays(a, b) {
        if (!a || !b || a === b) return false;
        const sa = getLinkSet(a), sb = getLinkSet(b);
        let changed = false;
        if (!sa.has(b.id)) { sa.add(b.id); setLinkSet(a, sa); changed = true; } // route via setLinkSet (refresh)
        if (!sb.has(a.id)) { sb.add(a.id); setLinkSet(b, sb); changed = true; } // route via setLinkSet (refresh)
        return changed;
    }
    function getLinkedCellsOf(cell) {
        const out = [];
        getLinkSet(cell).forEach(id => {
            const c = model.getCell(id);
            if (c && model.isVertex(c)) out.push(c);
        });
        return out;
    }


    // -------------------- Reflow logic --------------------
    function boardLanes(board) { return lanesMap(board); }

    function putInLane(card, lanes, laneKey) {
        const lane = lanes[laneKey];
        if (!lane) return;
        if (model.getParent(card) === lane) return;
        model.add(lane, card, model.getChildCount(lane));
        const status = getAttr(lane, 'status') || lane.value || '';
        setAttrUndoable(card, 'status', status);
        updateBadgeForLane(card, laneKey);
    }

    // 2) Guard reclassifyUpcoming so it never moves cards out of protected lanes  
    function reclassifyUpcoming(card, lanes) {
        const parent = model.getParent(card);
        const curKey = parent ? getAttr(parent, 'lane_key') : null;
        if (curKey && PROTECTED_WORK_LANES.has(curKey)) {
            updateBadgeForLane(card, curKey);                                   // keep badge fresh
            return;                                                             // no move
        }
        const startISO = getAttr(card, 'start');
        const laneKey = decideUpcomingLaneKey(startISO);
        putInLane(card, lanes, laneKey);
    }


    function reclassifyDone(card, lanes) {
        let comp = getAttr(card, 'completed') || getAttr(card, 'end');
        if (!comp) { comp = todayISO(); setAttrUndoable(card, 'completed', comp); }
        const age = daysSinceUTC(comp);
        const target = classifyDoneLane(age);
        putInLane(card, lanes, target);
    }

    // 3) Scan logic: skip auto-move for protected lanes; still refresh badges     
    function scanAndReflowBoard(board) {
        if (!board) return;
        const lanes = boardLanes(board);
        model.beginUpdate();
        try {
            for (const key in lanes) {
                const lane = lanes[key];
                const n = model.getChildCount(lane);
                for (let i = 0; i < n; i++) {
                    const c = model.getChildAt(lane, i);
                    if (!model.isVertex(c) || getAttr(c, 'kanban_card') !== '1') continue;

                    if (isDoneLikeLane(key)) {                                   // DONE buckets auto-promo
                        reclassifyDone(c, lanes);
                        continue;
                    }
                    if (key === 'ARCHIVED') {                                    // archive: leave in place
                        updateBadgeForLane(c, 'ARCHIVED');
                        continue;
                    }
                    if (PROTECTED_WORK_LANES.has(key)) {                         // TODO_STAGED/TODO/DOING are user-owned
                        updateBadgeForLane(c, key);                               // refresh badge only
                        continue;
                    }
                    // Only UPCOMING lanes reflow by date
                    if (isUpcomingLane(key)) {
                        reclassifyUpcoming(c, lanes);
                        continue;
                    }
                    // Fallback: just refresh badge
                    updateBadgeForLane(c, key);
                }

                // After processing all children for this lane, sort them                                   
                sortLaneCards(lane, key);
            }
        } finally { model.endUpdate(); }
    }

    function scanAllBoards() {
        const containers = [];
        (function walk(p) {
            const n = model.getChildCount(p);
            for (let i = 0; i < n; i++) {
                const ch = model.getChildAt(p, i);
                if (!ch) continue;
                if (model.isVertex(ch) && isGardenModule(ch)) containers.push(ch);
                walk(ch);
            }
        })(model.getRoot());
        const targets = containers.length ? containers : [graph.getDefaultParent()];
        targets.forEach(parent => {
            const { main, secondary } = findBoardsIn(parent);
            [main, ...secondary].filter(Boolean).forEach(scanAndReflowBoard);
        });
    }

    // -------------------- Kanban / Group helpers --------------------
    function isKanbanCard(cell) { return getAttr(cell, 'kanban_card') === '1'; }
    function isTilerGroup(cell) {
        return !isKanbanCard(cell) && (
            getAttr(cell, 'tiler_group') === '1'
        );
    }
    function laneKeyOfCard(card) {
        const p = model.getParent(card);
        return p ? getAttr(p, 'lane_key') : null;
    }
    function allLinkedCardsDone(group) {
        const cards = getLinkedCellsOf(group).filter(isKanbanCard);
        if (cards.length === 0) return null;  // indicates "no linked cards"
        return cards.every(c => {
            const lk = laneKeyOfCard(c);
            return lk && isDoneLikeLane(lk);
        });
    }
    function updateGroupRenderState(group) {
        if (!group || !isTilerGroup(group)) return;
        const cards = getLinkedCellsOf(group).filter(isKanbanCard);
        if (cards.length === 0) {
            // no linked cards left -> delete the group
            const edges = graph.getEdges(group, null, true, true, true) || [];
            model.beginUpdate();
            try {
                edges.forEach(e => model.remove(e));
                model.remove(group);
            } finally { model.endUpdate(); }
            return;
        }
        const allDone = allLinkedCardsDone(group);
        const shouldHide = allDone === true;
        const curVisible = model.isVisible ? model.isVisible(group) : true;
        if (curVisible === !shouldHide) return;
        model.setVisible(group, !shouldHide);
        graph.refresh(group);
    }
    function updateRenderForGroupsLinkedTo(card) {
        if (!card) return;
        getLinkedCellsOf(card)
            .filter(isTilerGroup)
            .forEach(updateGroupRenderState);
    }



    // -------------------- Auto-status, badges, and DONE autopromotion --------------------
    model.addListener(mxEvent.CHANGE, function (_sender, evt) {
        const edit = evt.getProperty('edit');
        if (!edit || !edit.changes) return;
        for (const ch of edit.changes) {
            if (ch instanceof mxChildChange) {
                const cell = ch.child;
                if (!cell || !model.isVertex(cell) || !isKanbanCard(cell)) continue;

                const parent = model.getParent(cell);
                if (!parent) continue;

                const laneKey = getAttr(parent, 'lane_key');
                if (!laneKey) continue;

                // Keep %status% and badge in sync
                const laneStatus = getAttr(parent, 'status') || parent.value || '';
                setAttrUndoable(cell, 'status', laneStatus);
                updateBadgeForLane(cell, laneKey);

                // If entering any DONE-like lane...
                if (isDoneLikeLane(laneKey)) {
                    if (!getAttr(cell, 'completed')) setAttrUndoable(cell, 'completed', todayISO());
                    const board = model.getParent(parent);
                    const lanes = boardLanes(board);
                    reclassifyDone(cell, lanes);
                    updateRenderForGroupsLinkedTo(cell);                                            // moved before continue
                    continue;
                }

                // If entering a work lane from completed/archived, remove completed
                if (isWorkLane(laneKey) && getAttr(cell, 'completed') != null) {
                    setAttrUndoable(cell, 'completed', null);
                    updateBadgeForLane(cell, laneKey);
                    updateRenderForGroupsLinkedTo(cell);                                           // evaluate after badge reset
                    continue;
                }

                // Fallback: still evaluate groups
                updateRenderForGroupsLinkedTo(cell);
            }
            // no-op for non-child changes
        }
    });


    graph.addListener('linksChanged', function (_sender, evt) {
        const deletedIdArr = evt.getProperty('deletedIds') || [];
        const impactedIdArr = evt.getProperty('impactedIds') || [];
        if ((!deletedIdArr || deletedIdArr.length === 0) && impactedIdArr.length === 0) {
            console.warn('[Kanban] linksChanged: no deletedIds/impactedIds payload');
            return;
        }

        const deletedIds = new Set(deletedIdArr);
        const impactedIds = new Set(impactedIdArr);

        // --- NEW: clean groups regardless of card deletion outcome ---------------------------------
        (function cleanGroupsAndReevaluate() {
            if (!deletedIds || deletedIds.size === 0) return;
            const touchedGroups = new Set();
            (function walk(p) {
                const n = model.getChildCount(p);
                for (let i = 0; i < n; i++) {
                    const ch = model.getChildAt(p, i);
                    if (!ch) continue;
                    if (model.isVertex(ch) && isTilerGroup(ch)) {
                        const links = getLinkSet(ch);
                        let changed = false;
                        deletedIds.forEach(id => {
                            if (links.has(id)) { links.delete(id); changed = true; }
                        });
                        if (changed) {
                            setLinkSet(ch, links);                                                 // keeps undo; no label refresh for non-cards
                            touchedGroups.add(ch.id);
                        }
                    }
                    walk(ch);
                }
            })(model.getRoot());

            touchedGroups.forEach(id => {
                const g = model.getCell(id);
                if (g) updateGroupRenderState(g);                                                  // hide or delete now
            });
        })();
        // ------------------------------------------------------------------------------------------

        const toDelete = [];
        const deletedCards = [];
        const debug = [];
        let cardsSeen = 0, cardsLinkedToDeleted = 0, cardsWithSurvivors = 0, cardsNoLinks = 0;

        function forEachCandidate(fn) {
            if (impactedIds.size > 0) {
                impactedIds.forEach(id => {
                    const c = model.getCell(id);
                    if (c && model.isVertex(c) && isKanbanCard(c)) fn(c);
                });
            } else {
                (function walk(p) {
                    const n = model.getChildCount(p);
                    for (let i = 0; i < n; i++) {
                        const ch = model.getChildAt(p, i);
                        if (!ch) continue;
                        if (model.isVertex(ch) && isKanbanCard(ch)) fn(ch);
                        walk(ch);
                    }
                })(model.getRoot());
            }
        }

        // Decide per candidate (unchanged logic) ...
        // [ keep your existing deletion loop here ]

        if (toDelete.length === 0) {
            console.log(`[Kanban] Orphan cleanup summary: deletedIds=${deletedIdArr.length}, cardsSeen=${cardsSeen}, linkedToDeleted=${cardsLinkedToDeleted}, survivors=${cardsWithSurvivors}, noLinks=${cardsNoLinks}, removed=0`);
            console.log('[Kanban] No cards removed. Detailed traces:\n' + debug.join('\n'));
            return;
        }

        model.beginUpdate();
        try {
            for (const c of toDelete) {
                deletedCards.push({ id: c.id, title: getAttr(c, 'title') || 'Untitled' });
                const edges = graph.getEdges(c, null, true, true, true) || [];
                edges.forEach(e => model.remove(e));
                model.remove(c);
            }
        } finally { model.endUpdate(); }

        console.log(`[Kanban] Orphan cleanup summary: deletedIds=${deletedIdArr.length}, cardsSeen=${cardsSeen}, linkedToDeleted=${cardsLinkedToDeleted}, survivors=${cardsWithSurvivors}, noLinks=${cardsNoLinks}, removed=${toDelete.length}`);
        console.log('[Kanban] Deleted cards:');
        deletedCards.forEach(c => console.log(`  - ${c.id}: ${c.title}`));
    });


    // -------------------- Board selection scan --------------------
    graph.getSelectionModel().addListener(mxEvent.CHANGE, function () {
        const sel = graph.getSelectionCell();
        if (!sel || !model.isVertex(sel)) return;
        const key = getAttr(sel, 'board_key');
        if (key === BOARD_KEY || key === 'MAIN_KANBAN_BOARD') {
            scanAndReflowBoard(sel);
        }
    });

    function findBoardsIn(parent) {
        const out = { main: null, secondary: [] };
        if (!parent) return out;
        const n = model.getChildCount(parent);
        for (let i = 0; i < n; i++) {
            const c = model.getChildAt(parent, i);
            if (!model.isVertex(c)) continue;
            const key = getAttr(c, 'board_key');
            if (key !== BOARD_KEY && key !== 'MAIN_KANBAN_BOARD') continue;
            const role = getAttr(c, BOARD_ROLE_ATTR);
            const isMain = role === 'main' || key === 'MAIN_KANBAN_BOARD';
            if (isMain && !out.main) out.main = c;
            else out.secondary.push(c);
        }
        return out;
    }

    // -------------------- Menu hook --------------------
    (function addMenuHook() {
        const pmh = graph.popupMenuHandler;
        const prev = pmh.factoryMethod;
        pmh.factoryMethod = function (menu, cell, evt) {
            if (typeof prev === 'function') prev.apply(this, arguments);
            menu.addSeparator();
            menu.addItem('Add Kanban Board (Template Style)', null, function () {
                model.beginUpdate();
                try { ensureBoardTemplateIn(null); } finally { model.endUpdate(); }
            });
        };
    })();

    // -------------------- Event bridge from scheduler --------------------                
    function handleTasksCreatedEvent(ev) {
        const detail = ev && ev.detail ? ev.detail : {};
        const tasks = Array.isArray(detail.tasks) ? detail.tasks : [];
        const targetGroupId = detail.targetGroupId;
        if (!tasks.length || !targetGroupId) return;

        // Remove old tasks uniquely linked to this tiler group                          
        removeTasksLinkedOnlyTo(targetGroupId);

        // add scheduled tasks
        createTasks(tasks, targetGroupId);
    }

    window.addEventListener('tasksCreated', handleTasksCreatedEvent);


    console.log('[TaskManager] Kanban loaded. Use window.TaskBus.createTasks([...]).');
});
