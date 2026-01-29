/**
 * Draw.io Plugin: Drag Circle → Auto Group → Resize to Tile (Square Grid, SQLite-backed)
 * With debug logs, re-entrancy guard, resize debounce, and max-tile cap.
 */
Draw.loadPlugin(function (ui) {
    const graph = ui.editor.graph;

    // -------------------- Config --------------------
    const DB_PATH = "C:/Users/user/Desktop/Trellis for Drawio/drawio-desktop/Trellis_database.sqlite";
    const PX_PER_CM = 5;
    const DRAW_SCALE = 0.18;
    const DEFAULT_ICON_DIAM_RATIO = 0.55;
    const MIN_ICON_DIAM_PX = 12;
    const MAX_ICON_DIAM_PX = 28;
    const GROUP_PADDING_PX = 4;
    const MAX_TILES = 1500; // hard cap to avoid freezes
    const RESIZE_DEBOUNCE_MS = 120; // debounce tiling during resize

    const GROUP_LABEL_FONT_PX = 12;
    const GROUP_LABEL_LINE_HEIGHT = 1.25;
    const GROUP_LABEL_BAND_PAD_PX = 6;
    const GROUP_LABEL_BAND_PX = Math.ceil(GROUP_LABEL_FONT_PX * GROUP_LABEL_LINE_HEIGHT + GROUP_LABEL_BAND_PAD_PX);

    // ---------- LOD settings ----------
    const LOD_TILE_THRESHOLD = 300; // collapse if rows*cols > this
    const LOD_SUMMARY_MIN_SIZE = 24; // min px size of summary marker

    // Yield
    const YIELD_UNIT = "kg"; // default display unit
    const ATTR_YIELD_TARGET = "planting_target_yield_kg";                     // CHANGE
    const ATTR_YIELD_EXPECTED = "planting_expected_yield_kg";                 // CHANGE
    const ATTR_YIELD_ACTUAL = "planting_actual_yield_kg";                     // CHANGE

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
            `fontSize=${GROUP_LABEL_FONT_PX}`,
            "align=center",
            "verticalAlign=top",
            "labelBackgroundColor=#ffffff",
            "labelBorderColor=000000",
            "resizable=1",
            "movable=1",
            "deletable=1",
            "editable=0",
            "whiteSpace=nowrap",
            "html=0",
        ].join(";");
    }

    let __dbPathCached = null; // NEW

    async function getDbPath() { // NEW
      if (__dbPathCached) return __dbPathCached;
    
      if (!window.dbBridge || typeof window.dbBridge.resolvePath !== "function") {
        throw new Error("dbBridge.resolvePath not available; add dbResolvePath wiring");
      }
    
      const r = await window.dbBridge.resolvePath({
        dbName: "Trellis_database.sqlite"
        // seedRelPath omitted -> main uses its default ../../trellis_database/Trellis_database.sqlite
        // reset: true // only for testing if you want to re-copy seed
      });
    
      __dbPathCached = r.dbPath;
      return __dbPathCached;
    }
    

    // -------------------- DB (open → query → close) --------------------
    async function queryAll(sql, params) {
        if (!window.dbBridge || typeof window.dbBridge.open !== "function") {
            throw new Error("dbBridge not available; check preload/main wiring");
        }
        const dbPath = await getDbPath();                            // NEW
        const opened = await window.dbBridge.open(dbPath, { readOnly: true }); // CHANGE
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
        const { count } = computeGridStatsXY(groupCell, spacingXpx, spacingYpx);
        return count > LOD_TILE_THRESHOLD;
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
                "html=1",
                "resizable=0",
                "movable=0",
                "editable=0",
            ].join(";");

            // --- NEW: Use full plant name in label ----------------------------------------------
            const fullName = getGroupDisplayName(groupCell, abbr);


            setXmlAttr(groupCell, "plant_count", count);
            const y = updateGroupYield(groupCell, { abbr, countOverride: count });

            // Pull unit and potential targets from attrs
            const unit = groupCell.getAttribute('yield_unit') || YIELD_UNIT;

            const plantingTargetKg = Number(groupCell.getAttribute('planting_target_yield_kg') || ''); // CHANGE

            // Build label parts: "FullName × count [· target ...] [· current ...]"
            const parts = [];
            parts.push(`× ${count}`);

            if (Number.isFinite(plantingTargetKg) && plantingTargetKg > 0) {                            // CHANGE
                parts.push(`target ${formatYield(plantingTargetKg, unit)}`);                            // CHANGE
            }                                                                                           // CHANGE

            if (SHOW_YIELD_IN_SUMMARY) {
                parts.push(`Expected yield ${formatYield(y.expectedYield, y.unit)}`);
            }

            const label = parts.join('<br/>');




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
        const { count } = computeGridStatsXY(groupCell, spacingXpx, spacingYpx);
        return count <= LOD_TILE_THRESHOLD;
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
            const y0Rel = GROUP_PADDING_PX + GROUP_LABEL_BAND_PX + spacingYpx / 2;

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

    function ensureXmlValue(cell) {
        // Return an XML Element for cell.value, creating one if needed                          
        const current = cell && cell.value;
        if (current && current.nodeType === 1) return current;
        // Create a <Module> node and carry over the visible label                               
        const doc = mxUtils.createXmlDocument();
        const node = doc.createElement('Module');
        const label = (typeof current === 'string' && current) ? current :
            (typeof graph.convertValueToString === 'function'
                ? graph.convertValueToString(cell)
                : '');
        if (label) node.setAttribute('label', label);
        return node;
    }

    // -------------------- Utils & Styles --------------------

    // NEW: batch set multiple attrs with one undoable value update
    function setCellAttrs(model, cell, attrs) {                                              // NEW
        model.beginUpdate();                                                                 // NEW
        try {                                                                                // NEW
            const base = ensureXmlValue(cell);                                               // NEW
            const clone = base.cloneNode(true);                                              // NEW
            for (const [k, v] of Object.entries(attrs || {})) {                              // NEW
                if (v === null || v === undefined || v === "") clone.removeAttribute(k);     // NEW
                else clone.setAttribute(k, String(v));                                       // NEW
            }                                                                                // NEW
            model.setValue(cell, clone);                                                     // NEW
        } finally {                                                                          // NEW
            model.endUpdate();                                                               // NEW
        }                                                                                    // NEW
    }

    function hasGardenSettingsSet(moduleCell) {                                              // CHANGE
        if (!(moduleCell && moduleCell.getAttribute)) return false;                          // NEW
        const city = String(moduleCell.getAttribute("city_name") || "").trim();              // NEW
        const units = String(moduleCell.getAttribute("unit_system") || "").trim();           // NEW
        return !!(city && units);                                                            // CHANGE
    }


    // NEW: garden settings dialog (city + units)
    async function showGardenSettingsDialog(ui, graph, moduleCell) {                        // CHANGE
        const model = graph.getModel();                                                     // CHANGE
        const curCity = getXmlAttr(moduleCell, "city_name", "");                            // CHANGE
        const curUnits = getXmlAttr(moduleCell, "unit_system", "");                         // CHANGE

        let cities = [];
        try {
            cities = await loadCities();
        } catch (e) {
            mxUtils.alert("Error loading cities: " + e.message);
            return;
        }
        if (!cities.length) {
            mxUtils.alert("No cities found in database.");
            return;
        }

        const div = document.createElement("div");
        div.style.padding = "10px";
        div.style.minWidth = "360px";

        const title = document.createElement("div");
        title.style.fontWeight = "600";
        title.style.marginBottom = "10px";
        title.textContent = "Garden Settings";
        div.appendChild(title);

        const err = document.createElement("div");                                          // NEW
        err.style.color = "#b91c1c";                                                        // NEW
        err.style.fontSize = "12px";                                                        // NEW
        err.style.marginBottom = "8px";                                                     // NEW
        err.style.display = "none";                                                         // NEW
        div.appendChild(err);                                                               // NEW

        function row(labelText, controlEl) {
            const wrap = document.createElement("div");
            wrap.style.display = "flex";
            wrap.style.alignItems = "center";
            wrap.style.gap = "8px";
            wrap.style.margin = "8px 0";
            const lab = document.createElement("label");
            lab.textContent = labelText;
            lab.style.minWidth = "140px";
            wrap.appendChild(lab);
            wrap.appendChild(controlEl);
            div.appendChild(wrap);
        }

        // City (mandatory)
        const citySel = document.createElement("select");
        citySel.style.flex = "1";

        const cityPlaceholder = document.createElement("option");                           // NEW
        cityPlaceholder.value = "";                                                         // NEW
        cityPlaceholder.textContent = "Select a city…";                                     // NEW
        cityPlaceholder.disabled = true;                                                    // NEW
        cityPlaceholder.selected = !curCity;                                                // NEW
        citySel.appendChild(cityPlaceholder);                                               // NEW

        cities.forEach((name) => {
            const o = document.createElement("option");
            o.value = name;
            o.textContent = name;
            if (name === curCity) o.selected = true;
            citySel.appendChild(o);
        });
        row("City:", citySel);

        // Units (mandatory)
        const unitsSel = document.createElement("select");
        unitsSel.style.flex = "1";

        const unitsPlaceholder = document.createElement("option");                          // NEW
        unitsPlaceholder.value = "";                                                        // NEW
        unitsPlaceholder.textContent = "Select units…";                                     // NEW
        unitsPlaceholder.disabled = true;                                                   // NEW
        unitsPlaceholder.selected = !curUnits;                                              // NEW
        unitsSel.appendChild(unitsPlaceholder);                                             // NEW

        [{ v: "metric", t: "Metric (m, cm)" }, { v: "imperial", t: "Imperial (ft, in)" }]
            .forEach(({ v, t }) => {
                const o = document.createElement("option");
                o.value = v;
                o.textContent = t;
                if (v === curUnits) o.selected = true;
                unitsSel.appendChild(o);
            });
        row("Units:", unitsSel);

        function showError(msg) {                                                           // NEW
            err.textContent = msg;                                                          // NEW
            err.style.display = "block";                                                    // NEW
        }                                                                                   // NEW

        const btnRow = document.createElement("div");
        btnRow.style.display = "flex";
        btnRow.style.justifyContent = "flex-end";
        btnRow.style.gap = "8px";
        btnRow.style.marginTop = "12px";

        const cancelBtn = mxUtils.button("Cancel", () => ui.hideDialog());
        const okBtn = mxUtils.button("OK", () => {
            err.style.display = "none";                                                     // NEW
            const chosenCity = (citySel.value || "").trim();
            const chosenUnits = (unitsSel.value || "").trim();

            if (!chosenCity) { showError("City is required."); citySel.focus(); return; }   // NEW
            if (!chosenUnits) { showError("Units are required."); unitsSel.focus(); return; } // NEW

            ui.hideDialog();
            setCellAttrs(model, moduleCell, {
                city_name: chosenCity,
                unit_system: chosenUnits,
                // meters_per_px omitted (scale removed)
            });
            graph.refresh(moduleCell);
        });

        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(okBtn);
        div.appendChild(btnRow);

        ui.showDialog(div, 420, 220, true, true);
        citySel.focus();
    }                                                                                        // NEW


    // Listen for garden-module settings requests emitted by the module plugin               // NEW
    if (!graph.__uslGardenSettingsListenerInstalled) {                                       // NEW
        graph.__uslGardenSettingsListenerInstalled = true;                                   // NEW

        graph.addListener("usl:gardenModuleNeedsSettings", function (sender, evt) {          // NEW
            const moduleCell = evt.getProperty("cell");                                      // NEW
            if (!moduleCell || !isGardenModule(moduleCell)) return;                          // NEW

            if (hasGardenSettingsSet(moduleCell)) return;                                    // NEW

            // Defer dialog until after current paint/update completes                        // NEW
            setTimeout(() => {                                                               // NEW
                // Re-check in case settings were set during the delay                         // NEW
                if (hasGardenSettingsSet(moduleCell)) return;                                // NEW
                showGardenSettingsDialog(ui, graph, moduleCell);                             // NEW
            }, 0);                                                                           // NEW
        });                                                                                  // NEW
    }                                                                                        // NEW


    function setCellAttr(model, cell, name, value) {
        model.beginUpdate();
        try {
            const base = ensureXmlValue(cell);
            const clone = base.cloneNode(true);
            if (value === null) {
                clone.removeAttribute(name);
            } else {
                clone.setAttribute(name, String(value));
            }
            model.setValue(cell, clone);  // ensures persistence, undo, events                   
        } finally {
            model.endUpdate();
        }
    }

    function getGroupDisplayName(groupCell, fallbackAbbr = '?') {
        const plantName = getXmlAttr(groupCell, 'plant_name', '') || '';
        const varietyName = getXmlAttr(groupCell, 'variety_name', '') || '';
        const base = (plantName || fallbackAbbr || '?').trim();
        const v = varietyName.trim();
        return v ? `${base} - ${v}` : base;
    }


    function getStyleSafe(cell) {
        return cell && typeof cell.getStyle === "function"
            ? cell.getStyle() || ""
            : (cell && cell.style) || "";
    }

    function isModule(cell) {
        return !!cell && getStyleSafe(cell).includes("module=1");
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
        return !!(moduleCell && moduleCell.getAttribute && moduleCell.getAttribute('city_name'));
    }

    /**
     * Creates an empty tiler group inside the given garden module.
     * - No plant is preselected.
     * - Defaults spacing to 30 cm (both axes).
     * - Centers a 240x240 group within the module bounds.
     */
    // Replace/create this helper in the tiler plugin:
    function createEmptyTilerGroup(graph, moduleCell, clickX, clickY) {
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
        const localX = (typeof clickX === "number") ? (clickX - gx - w / 2) : (gw - w) / 2;
        const localY = (typeof clickY === "number") ? (clickY - gy - h / 2) : (gh - h) / 2;

        // Clamp inside module bounds
        const relX = Math.max(0, Math.min(gw - w, localX));
        const relY = Math.max(0, Math.min(gh - h, localY));

        const groupVal = createXmlValue("TilerGroup", {
            label: "New Plant Group",
            tiler_group: "1",
            spacing_cm: String(spacingCm),
            spacing_x_cm: String(spacingCm),
            spacing_y_cm: String(spacingCm),
            veg_diameter_cm: "",
            yield_per_plant_kg: "",
            yield_unit: YIELD_UNIT,
            plant_count: "0",
            planting_target_yield_kg: "0",          // CHANGE
            planting_expected_yield_kg: "0",        // CHANGE
            planting_actual_yield_kg: "0"
        });

        // Note: child geometry should be RELATIVE to parent module
        const geo = new mxGeometry(relX, relY, w, h);
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

        function collectSelectedTilerGroups(graph, fallbackTarget) {
            const sel = graph.getSelectionCells ? (graph.getSelectionCells() || []) : [];
            const out = new Map();

            function addIfGroup(c) {
                if (!c) return;
                const g = isTilerGroup(c) ? c : findTilerGroupAncestor(graph, c);
                if (g && g.id) out.set(g.id, g);
            }

            // Include selection-derived groups                                              
            for (const c of sel) addIfGroup(c);

            // Fallback: if selection has no groups, use the target under cursor             
            if (out.size === 0) addIfGroup(fallbackTarget);

            return Array.from(out.values());
        }

        function selectionGroupState(groups) {
            let anyCollapsed = false;
            let anyExpanded = false;
            for (const g of groups) {
                const collapsed = isCollapsedLOD(g);
                if (collapsed) anyCollapsed = true;
                else anyExpanded = true;
                if (anyCollapsed && anyExpanded) break;
            }
            return { anyCollapsed, anyExpanded };
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

            // ----- Expand/Collapse (selection-aware) ---------------------------------- 
            const selectedGroups = collectSelectedTilerGroups(graph, target);
            const n = selectedGroups.length;
            const noun = n > 1 ? "plantings" : "planting";
            if (selectedGroups.length) {
                const st = selectionGroupState(selectedGroups);

                if (st.anyCollapsed) {
                    menu.addItem(`Expand ${noun}`, null, function () {
                        const model = graph.getModel();
                        model.beginUpdate();
                        try {
                            for (const g of selectedGroups) {
                                retileGroup(graph, g, { forceExpand: true });
                                graph.refresh(g); // refresh each
                            }
                        } finally {
                            model.endUpdate();
                        }
                    });
                }

                if (st.anyExpanded) {
                    menu.addItem(`Collapse ${noun}`, null, function () {
                        const model = graph.getModel();
                        model.beginUpdate();
                        try {
                            for (const g of selectedGroups) {
                                retileGroup(graph, g, { forceCollapse: true });                                         // CHANGE
                                graph.refresh(g); // refresh each
                            }
                        } finally {
                            model.endUpdate();
                        }
                    });
                }
            }

            if (targetMod && isGardenModule(targetMod)) {
                menu.addItem("Garden Settings…", null, async function () {                            // NEW
                    await showGardenSettingsDialog(ui, graph, targetMod);                             // NEW
                });
            }

            // --- Add New Plant Group (requires garden settings) ----------------------------------
            if (targetMod && isGardenModule(targetMod)) {                                            // NEW
                if (hasGardenSettingsSet(targetMod)) {                                               // CHANGE
                    menu.addItem("Add New Plant Group", null, function () {
                        try {
                            const pt = graph.getPointForEvent(evt);
                            createEmptyTilerGroup(graph, targetMod, pt.x, pt.y);
                            mxLog.debug("[PlantTiler][module] empty tiler group created");
                        } catch (e) {
                            mxUtils.alert("Error creating tiler group: " + e.message);
                        }
                    });
                } else {
                    // Disabled hint (non-clickable)
                    menu.addItem("Set garden settings to add plants", null, function () { }, null, null, false); // NEW
                }
            }                                                                                         // NEW
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
        if (!Number.isFinite(value)) return `0 ${unit}`;
        const abs = Math.abs(value);
        const s =
            abs >= 10 ? value.toFixed(1) : abs >= 1 ? value.toFixed(2) : value.toFixed(3);
        return `${s} ${unit}`;
    }

    let WRAP_GUARD = false; // re-entrancy guard
    const resizeTimers = new Map(); // debounce per group id

    function createTilerGroupFromCircle(graph, circleCell) {
        const cg = circleCell.getGeometry();
        log("Wrapping circle at", { x: cg.x, y: cg.y, w: cg.width, h: cg.height });

        const abbr = circleCell.getAttribute("abbr") || "?";
        const plantId = circleCell.getAttribute('plant_id') || '';
        const plantName = circleCell.getAttribute('plant_name') || '';
        const varietyName = circleCell.getAttribute('variety_name') || '';
        const titleName = (varietyName && plantName)
            ? `${plantName} - ${varietyName}`
            : (plantName || abbr || '?');

        // Default X/Y from source circle (both seeded from spacing_cm)
        const spacingCm = circleCell.getAttribute("spacing_cm") || "30";
        const spacingXcm = circleCell.getAttribute("spacing_x_cm") || spacingCm;
        const spacingYcm = circleCell.getAttribute("spacing_y_cm") || spacingCm;
        const vegDiamCm = circleCell.getAttribute("veg_diameter_cm") || "";
        const plantYield = circleCell.getAttribute("yield_per_plant_kg") || "";
        const yieldUnit = circleCell.getAttribute("yield_unit") || YIELD_UNIT;

        const groupVal = createXmlValue("TilerGroup", {
            label: `${titleName} group`,
            tiler_group: "1",
            plant_abbr: abbr,
            plant_id: plantId,                               // persist id on group
            plant_name: plantName,                           // persist name on group
            variety_name: varietyName,
            spacing_cm: spacingCm,
            spacing_x_cm: spacingXcm,
            spacing_y_cm: spacingYcm,
            veg_diameter_cm: vegDiamCm,
            yield_per_plant_kg: plantYield,
            yield_unit: yieldUnit,
            plant_count: "1",
            planting_target_yield_kg: circleCell.getAttribute("planting_target_yield_kg") || "0", // CHANGE
            planting_expected_yield_kg: "0",                                                     // CHANGE
            planting_actual_yield_kg: "0"
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
        const usableH = Math.max(0, g.height - GROUP_PADDING_PX * 2 - GROUP_LABEL_BAND_PX);
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
    function expandGroupDetail(graph, groupCell) {
        const abbr = groupCell.getAttribute("plant_abbr") || "?";
        const sx = toPx(Number(groupCell.getAttribute("spacing_x_cm") ||
            groupCell.getAttribute("spacing_cm") || "30"));
        const sy = toPx(Number(groupCell.getAttribute("spacing_y_cm") ||
            groupCell.getAttribute("spacing_cm") || "30"));
        const vegDiam = Number(groupCell.getAttribute("veg_diameter_cm") || 0);
        const iconDiam = Math.max(
            vegDiam > 0 ? toPx(vegDiam) : clamp(DEFAULT_ICON_DIAM_RATIO * Math.min(sx, sy), MIN_ICON_DIAM_PX, MAX_ICON_DIAM_PX), 6
        );
        const { rows, cols, count } = computeGridStatsXY(groupCell, sx, sy);
        if (count > MAX_TILES) {
            collapseToSummary(graph, groupCell, abbr, sx, sy);
            return;
        }
        expandTiles(graph, groupCell, abbr, sx, sy, iconDiam);
    }

    function collapseGroupDetail(graph, groupCell) {
        const abbr = groupCell.getAttribute("plant_abbr") || "?";
        const sx = toPx(Number(groupCell.getAttribute("spacing_x_cm") ||
            groupCell.getAttribute("spacing_cm") || "30"));
        const sy = toPx(Number(groupCell.getAttribute("spacing_y_cm") ||
            groupCell.getAttribute("spacing_cm") || "30"));
        collapseToSummary(graph, groupCell, abbr, sx, sy);
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
        const fullName = getGroupDisplayName(groupCell, abbr || '?');
        const unit = groupCell.getAttribute("yield_unit") || YIELD_UNIT;
        const perYield = getNumberAttr(groupCell, "yield_per_plant_kg", 0);
        const count =
            opts.countOverride != null
                ? Number(opts.countOverride)
                : getNumberAttr(groupCell, "plant_count", 0);

        const expectedYield = perYield * (Number.isFinite(count) ? count : 0);             // CHANGE

        setXmlAttr(groupCell, "planting_expected_yield_kg", expectedYield);                // CHANGE (new canonical)
        try {
            mxLog.debug(
                "[PlantTiler][yield] " +
                JSON.stringify({ abbr, perYield, count, expectedYield, unit })
            );
        } catch (_) { }

        if (SHOW_YIELD_IN_GROUP_LABEL) {
            const val = groupCell.value;
            if (val && val.setAttribute) {
                val.setAttribute("label", `${fullName} group — ${formatYield(expectedYield, unit)}`);
            }
        }

        return { perYield, count, expectedYield, unit, abbr };
    }

    function retileGroup(graph, groupCell, opts = {}) {
        const abbr = groupCell.getAttribute("plant_abbr") || "?";
        const spacingXcm = Number(groupCell.getAttribute("spacing_x_cm") ||
            groupCell.getAttribute("spacing_cm") || "30");
        const spacingYcm = Number(groupCell.getAttribute("spacing_y_cm") ||
            groupCell.getAttribute("spacing_cm") || "30");
        const spacingXpx = toPx(spacingXcm);
        const spacingYpx = toPx(spacingYcm);

        const vegDiamCm = Number(groupCell.getAttribute("veg_diameter_cm") || 0);
        let iconDiam = vegDiamCm > 0 ? toPx(vegDiamCm)
            : clamp(
                DEFAULT_ICON_DIAM_RATIO * Math.min(spacingXpx, spacingYpx),
                MIN_ICON_DIAM_PX,
                MAX_ICON_DIAM_PX
            );
        iconDiam = Math.max(iconDiam, 6);

        const collapsed = isCollapsedLOD(groupCell);
        const forceExpand = !!opts.forceExpand;
        const forceCollapse = !!opts.forceCollapse;

        const autoCollapse = shouldCollapseLOD(graph, groupCell, spacingXpx, spacingYpx);
        const autoExpand = shouldExpandLOD(graph, groupCell, spacingXpx, spacingYpx);

        if (forceCollapse) {
            collapseToSummary(graph, groupCell, abbr, spacingXpx, spacingYpx);
            return;
        }
        if (forceExpand) {
            expandGroupDetail(graph, groupCell);
            return;
        }

        if (autoCollapse && !collapsed) {
            collapseToSummary(graph, groupCell, abbr, spacingXpx, spacingYpx);
            return;
        }
        if (autoExpand && collapsed) {
            expandGroupDetail(graph, groupCell);
            return;
        }

        // Default path: keep current state; only refresh contents/summary        
        if (!collapsed) {
            expandTiles(graph, groupCell, abbr, spacingXpx, spacingYpx, iconDiam);
        } else {
            collapseToSummary(graph, groupCell, abbr, spacingXpx, spacingYpx);
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
