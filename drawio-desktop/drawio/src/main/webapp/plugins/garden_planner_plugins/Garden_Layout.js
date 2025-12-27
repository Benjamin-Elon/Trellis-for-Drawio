/**
 * Draw.io Plugin: Drag Circle → Auto Group → Resize to Tile (Square Grid, SQLite-backed)
 * With debug logs, re-entrancy guard, resize debounce, and max-tile cap.
 */
Draw.loadPlugin(function (ui) {
    const graph = ui.editor.graph;

    // -------------------- Config --------------------
    const DB_PATH = "C:/Users/user/Desktop/Gardening/Syntropy(3).sqlite";
    const PX_PER_CM = 5;
    const DRAW_SCALE = 0.18;
    const DEFAULT_ICON_DIAM_RATIO = 0.55;
    const MIN_ICON_DIAM_PX = 12;
    const MAX_ICON_DIAM_PX = 28;
    const GROUP_PADDING_PX = 4;
    const MAX_TILES = 1500; // hard cap to avoid freezes
    const RESIZE_DEBOUNCE_MS = 120; // debounce tiling during resize

    // ---------- LOD settings ----------
    const LOD_TILE_THRESHOLD = 300; // collapse if rows*cols > this
    const LOD_SUMMARY_MIN_SIZE = 24; // min px size of summary marker

    // Yield
    const YIELD_UNIT = "kg"; // default display unit
    const SHOW_YIELD_IN_GROUP_LABEL = false; // update group title with total yield
    const SHOW_YIELD_IN_SUMMARY = true; // append total yield in summary label

    // -------------------- Debug helper --------------------
    function log(...args) {
        try {
            mxLog.show();
            mxLog.debug("[PlantTiler]", ...args);
        } catch (_) { }
    }

    // -------------------- Utils & Styles --------------------
    function toPx(cm) {
        return cm * PX_PER_CM * DRAW_SCALE;
    }
    function clamp(v, lo, hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    function plantCircleStyle() {
        return [
            "shape=ellipse",
            "aspect=fixed",
            "perimeter=ellipsePerimeter",
            "strokeColor=#111827",
            "strokeWidth=1",
            "fillColor=#ffffff",
            "fontSize=12",
            "align=center",
            "verticalAlign=middle",
            "html=0",
            "resizable=0",
            "movable=0",
            "deletable=1",
            "editable=0",
            "whiteSpace=nowrap",
        ].join(";");
    }

    function groupFrameStyle() {
        return [
            "shape=rectangle",
            "strokeColor=#000000",
            "strokeOpacity=100",
            "dashed=1",
            "fillColor=none",
            "dashPattern=3 3",
            "fontSize=12",
            "align=center",
            "verticalAlign=top",
            "resizable=1",
            "movable=1",
            "deletable=1",
            "editable=0",
            "whiteSpace=nowrap",
            "html=0",
        ].join(";");
    }

    // -------------------- DB (open → query → close) --------------------
    async function queryAll(sql, params) {
        if (!window.dbBridge || typeof window.dbBridge.open !== "function") {
            throw new Error("dbBridge not available; check preload/main wiring");
        }
        const opened = await window.dbBridge.open(DB_PATH, { readOnly: true });
        try {
            const res = await window.dbBridge.query(opened.dbId, sql, params);
            return Array.isArray(res?.rows) ? res.rows : [];
        } finally {
            try {
                await window.dbBridge.close(opened.dbId);
            } catch (_) { }
        }
    }

    async function loadPlants() {
        const sql = `
        SELECT plant_id, plant_name, abbr, spacing_cm, veg_diameter_cm, yield_per_plant_kg
        FROM Plants
        WHERE abbr IS NOT NULL AND spacing_cm IS NOT NULL
        ORDER BY plant_name;
      `;
        const rows = await queryAll(sql);
        log("DB rows:", rows.length);
        return rows;
    }

    async function loadCities() {
        const sql = `
        SELECT city_name
        FROM Cities
        ORDER BY city_name;
      `;
        const rows = await queryAll(sql);
        return rows.map((r) => r.city_name);
    }

    function findTilerGroupAncestor(graph, cell) {
        const model = graph.getModel();
        let cur = cell;
        while (cur) {
            if (isTilerGroup(cur)) return cur;
            cur = model.getParent(cur);
        }
        return null;
    }

    function shouldCollapseLOD(graph, groupCell, spacingXpx, spacingYpx) {
        const { count } = computeGridStatsXY(groupCell, spacingXpx, spacingYpx);      // unchanged
        return count > LOD_TILE_THRESHOLD;                                            // CHANGE: collapse when above threshold
    }

    function isCollapsedLOD(groupCell) {
        return (
            groupCell.getAttribute && groupCell.getAttribute("lod_collapsed") === "1"
        );
    }

    function setCollapsedFlag(groupCell, v) {
        // Attributes live on the XML value
        const flag = v ? "1" : "0";
        const val = groupCell.value;
        if (val && val.setAttribute) val.setAttribute("lod_collapsed", flag);
    }

    function clearChildren(graph, groupCell) {
        const kids = graph.getChildVertices(groupCell);
        if (kids && kids.length) graph.removeCells(kids);
    }

    function collapseToSummary(graph, groupCell, abbr, spacingXpx, spacingYpx) {
        const model = graph.getModel();
        model.beginUpdate();
        try {
            clearChildren(graph, groupCell); // wipe current children under group

            // DEBUG: assert empty before add
            const kids = graph.getChildVertices(groupCell) || [];
            log("[DBG] collapse pre-add, kids=", kids.length);

            const { rows, cols, count } = computeGridStatsXY(
                groupCell,
                spacingXpx,
                spacingYpx
            );
            const g = groupCell.getGeometry();
            const size = Math.max(
                LOD_SUMMARY_MIN_SIZE,
                Math.min(g.width, g.height) * 0.35
            );
            const xRel = (g.width - size) / 2;
            const yRel = (g.height - size) / 2;

            const geo = new mxGeometry(xRel, yRel, size, size);
            // In collapseToSummary summary style:
            const style = [
                "shape=ellipse",
                "aspect=fixed",
                "perimeter=ellipsePerimeter",
                "strokeColor=#374151",
                "strokeWidth=1",
                "fillColor=#e5e7eb",
                "fontSize=12",
                "align=center",
                "verticalAlign=middle",
                "html=0",
                "resizable=0",
                "movable=0",
                "editable=0",
            ].join(";");

            // --- NEW: Use full plant name in label ----------------------------------------------
            const fullName = getXmlAttr(groupCell, 'plant_name', abbr || '?');


            setXmlAttr(groupCell, "plant_count", count);
            const y = updateGroupYield(groupCell, { abbr, countOverride: count });

            // Pull unit and potential targets from attrs
            const unit = groupCell.getAttribute('yield_unit') || YIELD_UNIT;
            const perSuccessionTarget = Number(groupCell.getAttribute('target_yield') || '');
            const seasonTarget = Number(groupCell.getAttribute('yield_target_kg') || '');

            // Build label parts: "FullName × count [· target ...] [· current ...]"
            const parts = [];
            parts.push(`${fullName} × ${count}`);

            // Prefer per-succession target if present, otherwise show season target (if any)
            if (Number.isFinite(perSuccessionTarget) && perSuccessionTarget > 0) {
                parts.push(`target ${formatYield(perSuccessionTarget, unit)}`);
            } else if (Number.isFinite(seasonTarget) && seasonTarget > 0) {
                parts.push(`target ${formatYield(seasonTarget, unit)}`);
            }

            if (SHOW_YIELD_IN_SUMMARY) {
                parts.push(`Yield ${formatYield(y.totalYield, y.unit)}`);
            }

            const label = parts.join(' · ');



            const summary = new mxCell(label, geo, style);
            summary.setVertex(true);
            summary.setConnectable(false);

            // Tag and ID
            const val = mxUtils.createXmlDocument().createElement("Summary");
            val.setAttribute("lod_summary", "1");
            val.setAttribute("label", label);
            summary.setValue(val);

            graph.addCell(summary, groupCell);
            setCollapsedFlag(groupCell, true);

            log(
                "[DBG] collapse post-add, kids=",
                (graph.getChildVertices(groupCell) || []).length
            );
        } finally {
            model.endUpdate();
        }
    }


    function shouldExpandLOD(graph, groupCell, spacingXpx, spacingYpx) {
        const { count } = computeGridStatsXY(groupCell, spacingXpx, spacingYpx);      // CHANGE: expand when at or below threshold
        return count <= LOD_TILE_THRESHOLD;                                           // CHANGE
    }

    function expandTiles(graph, groupCell, abbr, spacingXpx, spacingYpx, iconDiamPx) {
        const model = graph.getModel();
        model.beginUpdate();
        try {
            clearChildren(graph, groupCell); // keep: clean slate under group

            const { rows, cols, count } = computeGridStatsXY(
                groupCell,
                spacingXpx,
                spacingYpx
            );
            setXmlAttr(groupCell, "plant_count", count);
            updateGroupYield(groupCell, { abbr });

            if (count > MAX_TILES) {
                collapseToSummary(graph, groupCell, abbr, spacingXpx, spacingYpx);
                return;
            }

            const g = groupCell.getGeometry();
            const x0Rel = GROUP_PADDING_PX + spacingXpx / 2;
            const y0Rel = GROUP_PADDING_PX + spacingYpx / 2;

            const cells = [];
            for (let r = 0; r < rows; r++) {
                const cyRel = y0Rel + r * spacingYpx;

                for (let c = 0; c < cols; c++) {
                    const cxRel = x0Rel + c * spacingXpx;

                    const geo = new mxGeometry(
                        cxRel - iconDiamPx / 2,
                        cyRel - iconDiamPx / 2,
                        iconDiamPx,
                        iconDiamPx
                    );
                    const v = new mxCell(abbr, geo, plantCircleStyle());
                    v.setVertex(true);
                    v.setConnectable(false);
                    cells.push(v);
                }
            }
            if (cells.length) graph.addCells(cells, groupCell);
            setCollapsedFlag(groupCell, false);

            log(
                "[DBG] expand post-add, kids=",
                (graph.getChildVertices(groupCell) || []).length,
                "rendered=",
                cells.length,
                "of",
                count
            );
        } finally {
            model.endUpdate();
        }
    }

    // -------------------- Palette (XML value) --------------------
    function createXmlValue(tag, attrs) {
        const doc = mxUtils.createXmlDocument();
        const node = doc.createElement(tag);
        Object.keys(attrs || {}).forEach((k) =>
            node.setAttribute(k, String(attrs[k]))
        );
        return node;
    }

    // ---------- (Optional) SHIMS if your plugin doesn't define these helpers ----------
    function getXmlAttr(cell, name, def = "") {
        return cell && cell.getAttribute ? cell.getAttribute(name) || def : def;
    }

    function setXmlAttr(cell, name, val) {
        const v = cell && cell.value;
        if (v && v.setAttribute) v.setAttribute(name, String(val));
    }

    function ensureXmlValue(cell) {                                                              // NEW
        // Return an XML Element for cell.value, creating one if needed                          // NEW
        const current = cell && cell.value;                                                      // NEW
        if (current && current.nodeType === 1) return current;                                   // NEW (already an Element)
        // Create a <Module> node and carry over the visible label                               // NEW
        const doc = mxUtils.createXmlDocument();                                                 // NEW
        const node = doc.createElement('Module');                                                // NEW
        const label = (typeof current === 'string' && current) ? current :                       // NEW
            (typeof graph.convertValueToString === 'function'                          // NEW
                ? graph.convertValueToString(cell)                                     // NEW
                : '');                                                                 // NEW
        if (label) node.setAttribute('label', label);                                            // NEW
        return node;                                                                             // NEW
    }                                                                                            // NEW

    function setCellAttr(model, cell, name, value) {                                             // NEW
        model.beginUpdate();                                                                      // NEW
        try {                                                                                    // NEW
            const base = ensureXmlValue(cell);                                                   // NEW
            const clone = base.cloneNode(true);                                                  // NEW
            if (value === null) {                                                                // NEW
                clone.removeAttribute(name);                                                     // NEW
            } else {                                                                             // NEW
                clone.setAttribute(name, String(value));                                         // NEW
            }                                                                                    // NEW
            model.setValue(cell, clone);  // ensures persistence, undo, events                   // NEW
        } finally {                                                                              // NEW
            model.endUpdate();                                                                   // NEW
        }                                                                                        // NEW
    }                                                                                            // NEW



    function getStyleSafe(cell) {
        return cell && typeof cell.getStyle === "function"
            ? cell.getStyle() || ""
            : (cell && cell.style) || "";
    }

    function isModule(cell) {
        return !!cell && getStyleSafe(cell).includes("module=1");
    }

    function isRegularModule(cell) {
        if (!isModule(cell)) return false;
        const isGarden =
            !!(cell.getAttribute && cell.getAttribute("garden_module") === "1");
        return !isGarden;
    }

    function isGardenModule(cell) {
        return (
            isModule(cell) &&
            !!(cell.getAttribute && cell.getAttribute("garden_module") === "1")
        );
    }

    function findModuleAncestor(graph, cell) {
        const m = graph.getModel();
        let cur = cell;
        while (cur) {
            if (isModule(cur)) return cur;
            cur = m.getParent(cur);
        }
        return null;
    }

    function hasCitySet(moduleCell) {
        return !!(moduleCell && moduleCell.getAttribute && moduleCell.getAttribute('city_name')); // CHANGE
    }

    /**
     * Creates an empty tiler group inside the given garden module.
     * - No plant is preselected.
     * - Defaults spacing to 30 cm (both axes).
     * - Centers a 240x240 group within the module bounds.
     */
    // Replace/create this helper in the tiler plugin:
    function createEmptyTilerGroup(graph, moduleCell, clickX, clickY) {             // CHANGE
        const DEFAULT_GROUP_PX = 240;
        const spacingCm = 30;

        const modGeo = moduleCell.getGeometry && moduleCell.getGeometry();
        const gx = modGeo ? modGeo.x : 0;                                           // absolute module x
        const gy = modGeo ? modGeo.y : 0;                                           // absolute module y
        const gw = modGeo ? modGeo.width : DEFAULT_GROUP_PX;
        const gh = modGeo ? modGeo.height : DEFAULT_GROUP_PX;

        const w = DEFAULT_GROUP_PX;
        const h = DEFAULT_GROUP_PX;

        // Convert click (graph coords) -> local coords in module
        const localX = (typeof clickX === "number") ? (clickX - gx - w / 2) : (gw - w) / 2; // CHANGE
        const localY = (typeof clickY === "number") ? (clickY - gy - h / 2) : (gh - h) / 2; // CHANGE

        // Clamp inside module bounds
        const relX = Math.max(0, Math.min(gw - w, localX));                         // CHANGE
        const relY = Math.max(0, Math.min(gh - h, localY));                         // CHANGE

        const groupVal = createXmlValue("TilerGroup", {
            label: "New Plant Group",
            tiler_group: "1",
            spacing_cm: String(spacingCm),
            spacing_x_cm: String(spacingCm),
            spacing_y_cm: String(spacingCm),
            veg_diameter_cm: "",
            plant_yield: "",
            yield_unit: YIELD_UNIT,
            total_yield: "0",
            plant_count: "0"
        });

        // Note: child geometry should be RELATIVE to parent module
        const geo = new mxGeometry(relX, relY, w, h);                               // CHANGE
        const group = new mxCell(groupVal, geo, groupFrameStyle());
        group.setVertex(true);
        group.setConnectable(false);
        group.setCollapsed(false);

        const model = graph.getModel();
        model.beginUpdate();
        try {
            graph.addCell(group, moduleCell);                                        // parent is module
            graph.setSelectionCell(group);
        } finally {
            model.endUpdate();
        }

        try { retileGroup(graph, group); } catch (_) { }
        return group;
    }

    // ---------- Debug helpers (compact, JSON-safe) ----------
    function dbgAttrMap(cell) {
        const out = {};
        const v = cell && cell.value;
        if (v && v.attributes) {
            for (let i = 0; i < v.attributes.length; i++) {
                const a = v.attributes[i];
                out[a.nodeName] = a.nodeValue;
            }
        }
        return out;
    }

    function dbgCellInfo(cell) {
        if (!cell) return { cell: false };
        const g = cell.getGeometry ? cell.getGeometry() : null;
        return {
            id: cell.id || null,
            tag: (cell.value && cell.value.nodeName) || "",
            attrs: dbgAttrMap(cell),
            style: cell.style || "",
            vertex: !!(cell.isVertex && cell.isVertex()),
            edge: !!(cell.isEdge && cell.isEdge()),
            geo: g ? { x: g.x, y: g.y, w: g.width, h: g.height } : null,
        };
    }

    function showSpacingDialog(ui, curX, curY, onOk) {
        const div = document.createElement("div");
        div.style.padding = "10px";
        div.style.minWidth = "280px";

        const title = document.createElement("div");
        title.style.fontWeight = "600";
        title.style.marginBottom = "8px";
        title.textContent = "Set Plant Spacing (cm)";
        div.appendChild(title);

        const row = (labelTxt, init) => {
            const wrap = document.createElement("div");
            wrap.style.display = "flex";
            wrap.style.alignItems = "center";
            wrap.style.gap = "8px";
            wrap.style.marginBottom = "8px";
            const lab = document.createElement("label");
            lab.textContent = labelTxt;
            lab.style.minWidth = "120px";
            const inp = document.createElement("input");
            inp.type = "number";
            inp.step = "0.1";
            inp.min = "0.1";
            inp.style.flex = "1";
            inp.value = String(init);
            wrap.appendChild(lab);
            wrap.appendChild(inp);
            div.appendChild(wrap);
            return inp;
        };

        const inputX = row("Horizontal spacing X:", curX);
        const inputY = row("Vertical spacing Y:", curY);

        const btnRow = document.createElement("div");
        btnRow.style.display = "flex";
        btnRow.style.justifyContent = "flex-end";
        btnRow.style.gap = "8px";

        const okBtn = mxUtils.button("OK", function () {
            const x = Number(inputX.value),
                y = Number(inputY.value);
            if (!isFinite(x) || !isFinite(y) || x <= 0 || y <= 0) {
                try {
                    mxLog.debug(
                        "[PlantTiler][spacing] invalid " + JSON.stringify({ x, y })
                    );
                } catch (_) { }
                return;
            }
            ui.hideDialog();
            onOk(x, y);
        });
        const cancelBtn = mxUtils.button("Cancel", function () {
            ui.hideDialog();
        });
        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(okBtn);
        div.appendChild(btnRow);

        // Enter/Escape keys
        mxEvent.addListener(div, "keydown", function (evt) {
            if (evt.key === "Enter") {
                okBtn.click();
            }
            if (evt.key === "Escape") {
                ui.hideDialog();
            }
        });

        ui.showDialog(div, 360, 170, true, true);
        inputX.focus();
    }

    function runSetGroupSpacingOn(graph, groupCell) {
        if (!groupCell || !isTilerGroup(groupCell)) {
            try {
                mxLog.debug("[PlantTiler][spacing] not a tiler group");
            } catch (_) { }
            return;
        }
        const curX = Number(
            getXmlAttr(
                groupCell,
                "spacing_x_cm",
                getXmlAttr(groupCell, "spacing_cm", "30")
            )
        );
        const curY = Number(
            getXmlAttr(
                groupCell,
                "spacing_y_cm",
                getXmlAttr(groupCell, "spacing_cm", "30")
            )
        );

        showSpacingDialog(ui, curX, curY, function (x, y) {
            const val = groupCell.value;
            if (val && val.setAttribute) {
                val.setAttribute("spacing_x_cm", String(x));
                val.setAttribute("spacing_y_cm", String(y));
            }
            const model = graph.getModel();
            model.beginUpdate();
            try {
                retileGroup(graph, groupCell);
            } finally {
                model.endUpdate();
            }
            try {
                mxLog.debug(
                    "[PlantTiler][spacing] applied " + JSON.stringify({ x, y })
                );
            } catch (_) { }
        });
    }

    // ---------- Popup menu: install robust factory wrapper ----------
    if (graph && graph.popupMenuHandler) {
        graph.popupMenuHandler.selectOnPopup = false;
        const oldFactory = graph.popupMenuHandler.factoryMethod;
        try {
            mxLog.debug("[PlantTiler] Installing popup factory wrapper");
        } catch (_) { }

        // Helpers must be defined BEFORE factoryMethod uses them
        function hitTestCell(evt) {
            try {
                const pt = mxUtils.convertPoint(graph.container, evt.clientX, evt.clientY);
                const s = graph.view.scale,
                    tr = graph.view.translate;
                const gx = pt.x / s - tr.x,
                    gy = pt.y / s - tr.y;
                const hit = graph.getCellAt(gx, gy);
                try {
                    mxLog.debug(
                        "[PlantTiler][hitTest] " +
                        JSON.stringify({
                            clientX: evt.clientX,
                            clientY: evt.clientY,
                            gx,
                            gy,
                            s,
                            tr: { x: tr.x, y: tr.y },
                        })
                    );
                } catch (_) { }
                return hit;
            } catch (e) {
                try {
                    mxLog.debug("[PlantTiler][hitTest] error " + e.message);
                } catch (_) { }
                return null;
            }
        }

        function resolveTarget(cell, evt) {
            const byParam = cell || null;
            const byHit = evt ? hitTestCell(evt) : null;
            const bySel = graph.getSelectionCell() || null;
            let t = byParam || byHit || bySel;
            if (t && !isTilerGroup(t)) {
                const parentGroup = findTilerGroupAncestor(graph, t);
                if (parentGroup) t = parentGroup;
            }
            try {
                mxLog.debug(
                    "[PlantTiler][popup] cells " +
                    JSON.stringify({
                        byParam: dbgCellInfo(byParam),
                        byHit: dbgCellInfo(byHit),
                        bySel: dbgCellInfo(bySel),
                        target: dbgCellInfo(t),
                    })
                );
            } catch (_) { }
            return t;
        }

        function resolveModuleTarget(cell, evt) {
            const byParam = cell || null;
            const byHit = evt ? hitTestCell(evt) : null;
            const bySel = graph.getSelectionCell() || null;
            const cand = byParam || byHit || bySel;
            const t = cand ? findModuleAncestor(graph, cand) : null;
            try {
                mxLog.debug(
                    "[PlantTiler][popup][module] cand=" +
                    JSON.stringify(dbgCellInfo(cand)) +
                    " -> target=" +
                    JSON.stringify(dbgCellInfo(t))
                );
            } catch (_) { }
            return t;
        }

        graph.popupMenuHandler.factoryMethod = function (menu, cell, evt) {
            try {
                mxLog.debug(
                    "[PlantTiler][popup] start " +
                    JSON.stringify({ hasOld: typeof oldFactory === "function" })
                );
            } catch (_) { }

            if (typeof oldFactory === "function") {
                oldFactory.apply(this, arguments);
            }

            // ----- Tiler group item -----
            const target = resolveTarget(cell, evt);
            if (target && isTilerGroup(target)) {
                const curX = Number(
                    getXmlAttr(
                        target,
                        "spacing_x_cm",
                        getXmlAttr(target, "spacing_cm", "30")
                    )
                );
                const curY = Number(
                    getXmlAttr(
                        target,
                        "spacing_y_cm",
                        getXmlAttr(target, "spacing_cm", "30")
                    )
                );
                const label = `Set Plant Spacing (cm)…  [${curX} × ${curY}]`; // fixed template string
                try {
                    mxLog.debug(
                        "[PlantTiler][popup] adding spacing item " +
                        JSON.stringify({ curX, curY })
                    );
                } catch (_) { }
                menu.addItem(label, null, function () {
                    try {
                        const act = ui.actions.get("setGroupSpacing");
                        if (act && typeof act.funct === "function") {
                            try {
                                mxLog.debug("[PlantTiler][popup] invoking action setGroupSpacing");
                            } catch (_) { }
                            act.funct();
                        } else {
                            try {
                                mxLog.debug(
                                    "[PlantTiler][popup] action missing; using direct invoker"
                                );
                            } catch (_) { }
                            runSetGroupSpacingOn(graph, target);
                        }
                    } catch (e) {
                        try {
                            mxLog.debug("[PlantTiler][popup] action error " + e.message);
                        } catch (_) { }
                    }
                });
            } else {
                try {
                    mxLog.debug("[PlantTiler][popup] no tiler group under cursor");
                } catch (_) { }
            }

            // ----- MODULE CONTEXT MENU -----
            const targetMod = resolveModuleTarget(cell, evt);
            if (targetMod && isRegularModule(targetMod)) {
                menu.addItem("Set as Garden Module", null, function () {
                    const model = graph.getModel();                                                      // CHANGE
                    setCellAttr(model, targetMod, "garden_module", "1");                                 // CHANGE
                    try { mxLog.debug("[PlantTiler][module] marked as garden " + targetMod.id); } catch (_) { }
                    graph.refresh(targetMod);                                                            // unchanged
                });
            }

            if (target && isTilerGroup(target)) {                                           // existing branch
                // …existing "Set Plant Spacing" item…
            
                const isCollapsed = isCollapsedLOD(target);                                 // NEW
                if (isCollapsed) {                                                          // NEW
                    menu.addItem("Expand detail", null, function () {                       // NEW
                        retileGroup(graph, target, { forceExpand: true });                  // NEW
                    });                                                                     // NEW
                } else {                                                                    // NEW
                    menu.addItem("Collapse to summary", null, function () {                 // NEW
                        retileGroup(graph, target, { forceCollapse: true });                // NEW
                    });                                                                     // NEW
                }                                                                           // NEW
            }

            if (targetMod && isGardenModule(targetMod)) {
                menu.addItem("Set as Regular Module", null, function () {
                    const model = graph.getModel();                                                      // CHANGE
                    setCellAttr(model, targetMod, "garden_module", null);                                // CHANGE (remove attr)
                    try { mxLog.debug("[PlantTiler][module] reverted to regular " + targetMod.id); } catch (_) { }
                    graph.refresh(targetMod);                                                            // unchanged
                });

                menu.addItem("Set City…", null, async function () {
                    try {
                        const cities = await loadCities();
                        if (!cities.length) {
                            mxUtils.alert("No cities found in database.");
                            return;
                        }
                        const div = document.createElement("div");
                        div.style.padding = "10px";
                        div.style.minWidth = "240px";
                        const label = document.createElement("div");
                        label.textContent = "Select city:";
                        label.style.marginBottom = "6px";
                        div.appendChild(label);
                        const select = document.createElement("select");
                        select.style.width = "100%";
                        cities.forEach((name) => {
                            const o = document.createElement("option");
                            o.value = name;
                            o.textContent = name;
                            select.appendChild(o);
                        });
                        div.appendChild(select);
                        const ok = mxUtils.button("OK", function () {
                            const chosen = select.value;
                            ui.hideDialog();
                            const model = graph.getModel();                                              // CHANGE
                            setCellAttr(model, targetMod, "city_name", chosen);                          // CHANGE
                            try { mxLog.debug("[PlantTiler][module] city set to " + chosen); } catch (_) { }
                            graph.refresh(targetMod);
                        });
                        const cancel = mxUtils.button("Cancel", function () {
                            ui.hideDialog();
                        });
                        const br = document.createElement("div");
                        br.style.textAlign = "right";
                        br.style.marginTop = "8px";
                        br.appendChild(cancel);
                        br.appendChild(ok);
                        div.appendChild(br);
                        ui.showDialog(div, 260, 140, true, true);
                    } catch (e) {
                        mxUtils.alert("Error loading cities: " + e.message);
                    }
                });
            }

            // --- Add New Plant Group (requires city set) ---------------------------------- // CHANGE
            if (hasCitySet(targetMod)) {                                                     // CHANGE
                menu.addItem("Add New Plant Group", null, function () {                      // CHANGE
                    try {                                                                     // CHANGE
                        const pt = graph.getPointForEvent(evt);                               // CHANGE
                        createEmptyTilerGroup(graph, targetMod, pt.x, pt.y);
                        mxLog.debug("[PlantTiler][module] empty tiler group created");        // CHANGE
                    } catch (e) {                                                             // CHANGE
                        mxUtils.alert("Error creating tiler group: " + e.message);            // CHANGE
                    }                                                                         // CHANGE
                });                                                                           // CHANGE
            } else {                                                                          // CHANGE
                // Grey, non-clickable prompt when no city is set                             // CHANGE
                menu.addItem("Set city to add plants", null, function () { }, null, null, false); // CHANGE
            }                                                                                 // CHANGE
        };

        try {
            mxLog.debug(
                "[PlantTiler] Popup wrapper installed " +
                JSON.stringify({
                    hasPopup: !!graph.popupMenuHandler,
                    hasAction: !!ui.actions.get("setGroupSpacing"),
                })
            );
        } catch (_) { }
    } else {
        try {
            mxLog.debug("[PlantTiler] popupMenuHandler not available");
        } catch (_) { }
    }

    // -------------------- Group wrapping & events --------------------
    function isPlantCircle(cell) {
        return !!cell && cell.getAttribute && cell.getAttribute("plant_tiler") === "1";
    }

    function isTilerGroup(cell) {
        const ok = !!cell && cell.getAttribute && cell.getAttribute("tiler_group") === "1";
        return ok;
    }

    function getNumberAttr(cell, name, def = 0) {
        const v = cell && cell.getAttribute ? cell.getAttribute(name) : null;
        const n = Number(v);
        return Number.isFinite(n) ? n : def;
    }

    function formatYield(value, unit) {
        // Simple formatting: keep three sig figs for small numbers
        if (!Number.isFinite(value)) return `0 ${unit}`; // fixed template string
        const abs = Math.abs(value);
        const s =
            abs >= 10 ? value.toFixed(1) : abs >= 1 ? value.toFixed(2) : value.toFixed(3);
        return `${s} ${unit}`; // fixed template string
    }

    let WRAP_GUARD = false; // re-entrancy guard
    const resizeTimers = new Map(); // debounce per group id

    function createTilerGroupFromCircle(graph, circleCell) {
        const cg = circleCell.getGeometry();
        log("Wrapping circle at", { x: cg.x, y: cg.y, w: cg.width, h: cg.height });

        const abbr = circleCell.getAttribute("abbr") || "?";
        const plantId = circleCell.getAttribute('plant_id') || '';
        const plantName = circleCell.getAttribute('plant_name') || '';
        const titleName = plantName || abbr || '?';

        // Default X/Y from source circle (both seeded from spacing_cm)
        const spacingCm = circleCell.getAttribute("spacing_cm") || "30";
        const spacingXcm = circleCell.getAttribute("spacing_x_cm") || spacingCm;
        const spacingYcm = circleCell.getAttribute("spacing_y_cm") || spacingCm;
        const vegDiamCm = circleCell.getAttribute("veg_diameter_cm") || "";
        const plantYield = circleCell.getAttribute("plant_yield") || "";
        const yieldUnit = circleCell.getAttribute("yield_unit") || YIELD_UNIT;

        const groupVal = createXmlValue("TilerGroup", {
            label: `${titleName} group`,
            tiler_group: "1",
            plant_abbr: abbr,
            plant_id: plantId,                               // persist id on group
            plant_name: plantName,                           // persist name on group
            spacing_cm: spacingCm,
            spacing_x_cm: spacingXcm,
            spacing_y_cm: spacingYcm,
            veg_diameter_cm: vegDiamCm,
            plant_yield: plantYield,
            yield_unit: yieldUnit,
            total_yield: "0", // will be updated on retile
            plant_count: "1",
        });

        const group = new mxCell(
            groupVal,
            new mxGeometry(cg.x, cg.y, cg.width, cg.height),
            groupFrameStyle()
        );
        group.setVertex(true);
        group.setConnectable(false);
        group.setCollapsed(false);

        const intendedParent =
            graph.getModel().getParent(circleCell) || graph.getDefaultParent(); // keep group with the circle’s current parent
        graph.addCell(group, intendedParent);

        const localGeo = cg.clone();
        localGeo.x = (group.getGeometry().width - cg.width) / 2;
        localGeo.y = (group.getGeometry().height - cg.height) / 2;
        circleCell.setGeometry(localGeo);
        graph.addCell(circleCell, group);

        graph.setSelectionCell(group);
        log("Group created and circle moved into group at", {
            x: localGeo.x,
            y: localGeo.y,
        });
        return group;
    }

    function computeGridStatsXY(groupCell, spacingXpx, spacingYpx) {
        const g = groupCell.getGeometry();
        const usableW = Math.max(0, g.width - GROUP_PADDING_PX * 2);
        const usableH = Math.max(0, g.height - GROUP_PADDING_PX * 2);
        if (usableW <= 0 || usableH <= 0) return { rows: 0, cols: 0, count: 0 };
        const cols = Math.max(1, Math.floor(usableW / spacingXpx));
        const rows = Math.max(1, Math.floor(usableH / spacingYpx));
        return { rows, cols, count: rows * cols };
    }

    graph.addListener(mxEvent.CELLS_ADDED, function (sender, evt) {
        const cells = evt.getProperty("cells") || [];
        log("CELLS_ADDED count=", cells.length);

        if (WRAP_GUARD) {
            log("wrap guard active; ignoring");
            return;
        }
        WRAP_GUARD = true;
        const model = graph.getModel();
        model.beginUpdate();
        try {
            for (const cell of cells) {
                if (!isPlantCircle(cell)) continue;

                const parent = model.getParent(cell);
                if (isTilerGroup(parent)) {
                    log("Already inside tiler group; skip");
                    continue;
                }
                createTilerGroupFromCircle(graph, cell);
            }
        } finally {
            model.endUpdate();
            WRAP_GUARD = false;
        }
    });

    graph.addListener(mxEvent.CELLS_RESIZED, function (sender, evt) {
        const cells = evt.getProperty("cells") || [];
        const groupsToUpdate = new Map();
        for (const c of cells) {
            const g = isTilerGroup(c) ? c : findTilerGroupAncestor(graph, c);
            if (g) groupsToUpdate.set(g.id, g);
        }
        for (const [id, groupCell] of groupsToUpdate) {
            if (resizeTimers.has(id)) clearTimeout(resizeTimers.get(id));
            resizeTimers.set(
                id,
                setTimeout(() => {
                    const model = graph.getModel();
                    model.beginUpdate();
                    try {
                        retileGroup(graph, groupCell);
                    } finally {
                        model.endUpdate();
                    }
                }, RESIZE_DEBOUNCE_MS)
            );
        }
    });

    // expand/collapse helpers
    function expandGroupDetail(graph, groupCell) {                                 // NEW
        const abbr = groupCell.getAttribute("plant_abbr") || "?";                  // NEW
        const sx = toPx(Number(groupCell.getAttribute("spacing_x_cm") ||
                                groupCell.getAttribute("spacing_cm") || "30"));    // NEW
        const sy = toPx(Number(groupCell.getAttribute("spacing_y_cm") ||
                                groupCell.getAttribute("spacing_cm") || "30"));    // NEW
        const vegDiam = Number(groupCell.getAttribute("veg_diameter_cm") || 0);    // NEW
        const iconDiam = Math.max(                                                 // NEW
            vegDiam > 0 ? toPx(vegDiam) : clamp(DEFAULT_ICON_DIAM_RATIO * Math.min(sx, sy), MIN_ICON_DIAM_PX, MAX_ICON_DIAM_PX), 6
        );                                                                         // NEW
        const { rows, cols, count } = computeGridStatsXY(groupCell, sx, sy);       // NEW
        if (count > MAX_TILES) {                                                   // NEW
            collapseToSummary(graph, groupCell, abbr, sx, sy);                     // NEW
            return;                                                                // NEW
        }                                                                          // NEW
        expandTiles(graph, groupCell, abbr, sx, sy, iconDiam);                     // NEW
    }                                                                              // NEW
    
    function collapseGroupDetail(graph, groupCell) {                               // NEW
        const abbr = groupCell.getAttribute("plant_abbr") || "?";                  // NEW
        const sx = toPx(Number(groupCell.getAttribute("spacing_x_cm") ||
                                groupCell.getAttribute("spacing_cm") || "30"));    // NEW
        const sy = toPx(Number(groupCell.getAttribute("spacing_y_cm") ||
                                groupCell.getAttribute("spacing_cm") || "30"));    // NEW
        collapseToSummary(graph, groupCell, abbr, sx, sy);                         // NEW
    }          
    
    function retileVisibleExpandedGroups(graph) {
        const parent = graph.getDefaultParent();
        const all = graph.getChildVertices(parent) || [];
        const model = graph.getModel();
        model.beginUpdate();
        try {
            for (const v of all) {
                if (!isTilerGroup(v)) continue;
                if (isCollapsedLOD(v)) continue;
                retileGroup(graph, v);
            }
        } finally {
            model.endUpdate();
        }
    }

    let SCROLL_TIMER = null;
    ui.editor.graph.container.addEventListener(
        "scroll",
        () => {
            if (SCROLL_TIMER) clearTimeout(SCROLL_TIMER);
            SCROLL_TIMER = setTimeout(() => retileVisibleExpandedGroups(graph), 100);
        },
        { passive: true }
    );

    let PAN_TIMER = null;
    graph.addListener(mxEvent.PAN, function () {
        if (PAN_TIMER) clearTimeout(PAN_TIMER);
        PAN_TIMER = setTimeout(() => retileVisibleExpandedGroups(graph), 100);
    });

    function updateGroupYield(groupCell, opts = {}) {
        // Reads per-plant yield & unit from group, multiplies by plant_count (or override),
        // stamps total_yield, logs, and (optionally) updates visible label with formatted total.
        const abbr = opts.abbr != null ? String(opts.abbr) : getXmlAttr(groupCell, "plant_abbr", "?");
        const fullName = getXmlAttr(groupCell, 'plant_name', abbr);
        const unit = groupCell.getAttribute("yield_unit") || YIELD_UNIT;
        const perYield = getNumberAttr(groupCell, "plant_yield", 0);
        const count =
            opts.countOverride != null
                ? Number(opts.countOverride)
                : getNumberAttr(groupCell, "plant_count", 0);
        const totalYield = perYield * (Number.isFinite(count) ? count : 0);
        setXmlAttr(groupCell, "Yield", totalYield);
        try {
            mxLog.debug(
                "[PlantTiler][yield] " +
                JSON.stringify({ abbr, perYield, count, totalYield, unit })
            );
        } catch (_) { }

        if (SHOW_YIELD_IN_GROUP_LABEL) {
            const val = groupCell.value;
            if (val && val.setAttribute) {
                val.setAttribute("label", `${fullName} group — ${formatYield(totalYield, unit)}`);
            }
        }

        return { perYield, count, totalYield, unit, abbr };
    }

    function retileGroup(graph, groupCell, opts = {}) {                              // CHANGE
        const abbr = groupCell.getAttribute("plant_abbr") || "?";                    // unchanged
        const spacingXcm = Number(groupCell.getAttribute("spacing_x_cm") ||
                                  groupCell.getAttribute("spacing_cm") || "30");     // unchanged
        const spacingYcm = Number(groupCell.getAttribute("spacing_y_cm") ||
                                  groupCell.getAttribute("spacing_cm") || "30");     // unchanged
        const spacingXpx = toPx(spacingXcm);                                         // unchanged
        const spacingYpx = toPx(spacingYcm);                                         // unchanged
    
        const vegDiamCm = Number(groupCell.getAttribute("veg_diameter_cm") || 0);    // unchanged
        let iconDiam = vegDiamCm > 0 ? toPx(vegDiamCm)
            : clamp(                                                                 // unchanged
                DEFAULT_ICON_DIAM_RATIO * Math.min(spacingXpx, spacingYpx),
                MIN_ICON_DIAM_PX,
                MAX_ICON_DIAM_PX
            );
        iconDiam = Math.max(iconDiam, 6);                                            // unchanged
    
        const collapsed = isCollapsedLOD(groupCell);                                 // unchanged
        const forceExpand = !!opts.forceExpand;                                      // unchanged
        const forceCollapse = !!opts.forceCollapse;                                  // unchanged
    
        const autoCollapse = shouldCollapseLOD(graph, groupCell, spacingXpx, spacingYpx); // NEW
        const autoExpand   = shouldExpandLOD(graph, groupCell, spacingXpx, spacingYpx);   // NEW
    
        if (forceCollapse) {                                                         // unchanged
            collapseToSummary(graph, groupCell, abbr, spacingXpx, spacingYpx);       // unchanged
            return;                                                                  // unchanged
        }
        if (forceExpand) {                                                           // unchanged
            expandGroupDetail(graph, groupCell);                                     // unchanged
            return;                                                                  // unchanged
        }
    
        if (autoCollapse && !collapsed) {                                            // NEW
            collapseToSummary(graph, groupCell, abbr, spacingXpx, spacingYpx);       // NEW
            return;                                                                  // NEW
        }
        if (autoExpand && collapsed) {                                               // NEW
            expandGroupDetail(graph, groupCell);                                     // NEW
            return;                                                                  // NEW
        }
    
        // Default path: keep current state; only refresh contents/summary           // unchanged comment
        if (!collapsed) {                                                            // unchanged behavior for expanded
            expandTiles(graph, groupCell, abbr, spacingXpx, spacingYpx, iconDiam);   // unchanged
        } else {
            collapseToSummary(graph, groupCell, abbr, spacingXpx, spacingYpx);       // unchanged
        }
    }
    
    // ---- Public API export (for other USL plugins) ---------------------------------
    window.USL = window.USL || {};
    window.USL.tiler = Object.assign({}, window.USL.tiler, {
        retileGroup, // expose the real tiler re-tile function
        getXmlAttr, // optional helper (shared utility)
        setXmlAttr, // optional helper (shared utility)
        findTilerGroupAncestor
    });

    // -------------------- Boot --------------------
    (async function init() {
        try {
            
                } catch (e) {
            log("Init error:", e.message);
        }
    })();
});
