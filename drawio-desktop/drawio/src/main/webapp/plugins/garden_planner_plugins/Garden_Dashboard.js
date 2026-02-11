/**
 * Draw.io Plugin: Garden Dashboard (Garden-Module Scoped)
 *
 * Features:
 * - Right-click a garden module -> "Create Garden Dashboard" (only if none exists)
 * - Dashboard is a child cell inside the garden module
 * - In-canvas Prev/Next year buttons + current year label
 * - Metrics are computed from tiler groups under that module
 * - Only includes crops that begin in selected year (season_start_year == selected year)
When a garden module is created we should also listen in this plugin and automatically add a dashboard to the garden module:
 

* UPDATE:
 * - Dashboard table is now a DOM overlay anchored to the dashboard cell (not an in-cell html table). 
 * - Dashboard cell label is a compact summary for portability. 
 */
Draw.loadPlugin(function (ui) {
    const graph = ui.editor && ui.editor.graph;
    if (!graph) return;

    const model = graph.getModel();

    // Prevent double install
    if (graph.__gardenDashboardInstalled) return;
    graph.__gardenDashboardInstalled = true;

    // -------------------- Config --------------------
    const PX_PER_CM = 5;
    const DRAW_SCALE = 0.18; // meters per drawn-centimeter (assumption)

    const DASH_ATTR = "garden_dashboard";
    const DASH_YEAR_ATTR = "dashboard_year";
    const YEAR_HIDDEN_ATTR = "year_hidden";


    const BTN_SIZE = 22;
    const BTN_GAP = 6;
    const CTRL_PAD = 6;

    const DASH_STYLE =
        "rounded=0;whiteSpace=wrap;html=1;" +
        "align=left;verticalAlign=top;" +
        "labelPosition=left;verticalLabelPosition=top;" +
        "spacing=0;spacingTop=0;spacingLeft=0;spacingRight=0;spacingBottom=0;" +
        "strokeColor=#666666;fillColor=#f7f7f7;fontSize=12;";

    const PLAN_YEAR_EVENT = "usl:planYearRequested"; // NEW
    const ALLOCATE_PLAN_EVENT = "usl:allocatePlanRequested"; // NEW

    // -------------------- Helpers --------------------
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

    function findDashboardAncestor(cell) {
        let cur = cell;
        while (cur) {
            if (cur.getAttribute && cur.getAttribute(DASH_ATTR) === "1") return cur;
            cur = model.getParent(cur);
        }
        return null;
    }

    function isTilerGroup(cell) {
        const ok = !!cell && cell.getAttribute && cell.getAttribute("tiler_group") === "1";
        return ok;
    }

    function hasCitySet(moduleCell) {
        return !!(moduleCell && moduleCell.getAttribute && moduleCell.getAttribute("city_name"));
    }

    // -------------------- Helpers --------------------
    function toInt(v, def = 0) {
        const n = Number(v);
        return Number.isFinite(n) ? Math.trunc(n) : def;
    }

    function toNum(v, def = 0) {
        const n = Number(v);
        return Number.isFinite(n) ? n : def;
    }

    function getCellAttr(cell, key, def = "") {
        if (!cell || !cell.getAttribute) return def;
        const v = cell.getAttribute(key);
        return (v === null || v === undefined) ? def : v;
    }

    function setCellAttr(cell, key, val) {
        if (graph.setAttributeForCell) {
            if (val == null) graph.setAttributeForCell(cell, key, null);                // CHANGE
            else graph.setAttributeForCell(cell, key, String(val));                     // CHANGE
        } else if (cell.value && typeof cell.value.setAttribute === "function") {
            if (val == null) cell.value.removeAttribute(key);                           // CHANGE
            else cell.value.setAttribute(key, String(val));                             // CHANGE
        }
    }

    function setYearHidden(cell, hidden) {                                              // NEW
        if (!cell) return;                                                              // NEW
        if (hidden) setCellAttr(cell, YEAR_HIDDEN_ATTR, "1");                            // NEW
        else setCellAttr(cell, YEAR_HIDDEN_ATTR, null);                                  // NEW (remove)
    }                                                                                   // NEW

    function isYearHidden(cell) {                                                       // NEW
        return getCellAttr(cell, YEAR_HIDDEN_ATTR, "") === "1";                          // NEW
    }                                                                                   // NEW


    function getDescendants(root) {
        const out = [];
        if (!root) return out;

        const stack = [root];
        while (stack.length) {
            const cur = stack.pop();
            const childCount = model.getChildCount(cur);
            for (let i = 0; i < childCount; i++) {
                const ch = model.getChildAt(cur, i);
                out.push(ch);
                stack.push(ch);
            }
        }
        return out;
    }

    function findDashboardCell(moduleCell) {
        if (!moduleCell) return null;
        const kids = getDescendants(moduleCell);
        for (const c of kids) {
            if (c && c.getAttribute && c.getAttribute(DASH_ATTR) === "1") {
                return c;
            }
        }
        return null;
    }

    function getDashboardYear(dashCell) {
        const y = toInt(getCellAttr(dashCell, DASH_YEAR_ATTR, ""), NaN);
        if (Number.isFinite(y) && y > 1900 && y < 3000) return y;
        return new Date().getFullYear();
    }

    function setDashboardYear(dashCell, year) {
        setCellAttr(dashCell, DASH_YEAR_ATTR, String(year));
    }

    function notifyYearFilterChanged(moduleCell, selectedYear) {                         // NEW
        try {                                                                            // NEW
            window.dispatchEvent(new CustomEvent("yearFilterChanged", {                  // NEW
                detail: { moduleCellId: moduleCell ? moduleCell.getId() : null, year: selectedYear } // NEW
            }));                                                                         // NEW
        } catch (e) { }                                                                  // NEW
    }                                                                                    // NEW


    function pxToAreaM2(wPx, hPx) {
        const wCm = wPx / PX_PER_CM;
        const hCm = hPx / PX_PER_CM;
        const wM = wCm * DRAW_SCALE;
        const hM = hCm * DRAW_SCALE;
        return wM * hM;
    }

    function getUiScale() {
        const s = graph.view && graph.view.scale;
        if (!Number.isFinite(s)) return 1;
        return s;
    }


    function getCropKey(tg) {
        const plant = getCellAttr(tg, "plant_name", "").trim();
        const variety = getCellAttr(tg, "variety_name", "").trim();
        if (plant && variety) return `${plant} — ${variety}`;
        return plant || variety || "(Unnamed crop)";
    }

    function computeModuleMetrics(moduleCell, selectedYear) {
        const all = getDescendants(moduleCell);
        const tilers = all.filter(isTilerGroup);

        const tilersInYear = tilers.filter((tg) => shouldRenderTilerGroup(tg, selectedYear)); // CHANGE


        const byCrop = new Map();

        let totalAreaM2 = 0;
        let totalSeeds = 0;
        let totalTargetKg = 0;
        let totalExpectedKg = 0;

        for (const tg of tilersInYear) {
            const geo = model.getGeometry(tg);

            let areaM2 = 0;
            if (geo) areaM2 = pxToAreaM2(geo.width, geo.height);

            const seeds = toNum(getCellAttr(tg, "plants_required", 0), 0);
            const expectedKg = toNum(getCellAttr(tg, "planting_expected_yield_kg", 0), 0);

            const targetDirect = toNum(getCellAttr(tg, "planting_target_yield_kg", NaN), NaN);
            const targetLegacy = toNum(getCellAttr(tg, "target_yield", NaN), NaN);
            const targetKg = Number.isFinite(targetDirect) ? targetDirect : (Number.isFinite(targetLegacy) ? targetLegacy : 0);

            totalAreaM2 += areaM2;              // CHANGE
            totalSeeds += seeds;
            totalExpectedKg += expectedKg;
            totalTargetKg += targetKg;

            const crop = getCropKey(tg);
            const cur = byCrop.get(crop) || {
                crop, area_m2: 0, seeds: 0,
                target_kg: 0, expected_kg: 0,
                count: 0
            };
            cur.area_m2 += areaM2;
            cur.seeds += seeds;
            cur.target_kg += targetKg;
            cur.expected_kg += expectedKg;
            cur.count += 1;
            byCrop.set(crop, cur);

        }

        const rows = Array.from(byCrop.values()).sort((a, b) => a.crop.localeCompare(b.crop));

        const city = hasCitySet(moduleCell) ? getCellAttr(moduleCell, "city_name", "") : "";
        const moduleName = (moduleCell.value && moduleCell.value.getAttribute)
            ? (moduleCell.value.getAttribute("label") || moduleCell.getAttribute("label") || moduleCell.getId())
            : (moduleCell.getAttribute ? (moduleCell.getAttribute("label") || moduleCell.getId()) : moduleCell.getId());

        return {
            moduleName,
            city,
            tilerGroupsTotal: tilers.length,
            tilerGroupsInYear: tilersInYear.length,
            totalAreaM2,
            totalSeeds,
            totalTargetKg,
            totalExpectedKg,
            rows
        };
    }


    // -------------------- year Filtering Helpers --------------------

    function isKanbanCard(cell) {                                                     // NEW
        return getCellAttr(cell, "kanban_card", "") === "1";                          // NEW
    }                                                                                 // NEW    

    function isPerennialTilerGroup(tg) {                                              // NEW
        // Prefer a single canonical attribute; fall back to reasonable alternates.    // NEW
        const lc = getCellAttr(tg, "life_cycle", "").trim().toLowerCase();            // NEW
        if (lc === "perennial") return true;                                          // NEW
        if (getCellAttr(tg, "is_perennial", "") === "1") return true;                // NEW
        return false;                                                                 // NEW
    }                                                                                 // NEW

    function shouldRenderTilerGroup(tg, selectedYear) {                               // CHANGE
        if (!isTilerGroup(tg)) return false;                                          // NEW
        if (isPerennialTilerGroup(tg)) return true;                                   // NEW

        const startY = toInt(getCellAttr(tg, "season_start_year", ""), NaN);          // CHANGE
        if (Number.isFinite(startY) && startY === selectedYear) return true;          // NEW

        const endY = harvestEndUtcYear(tg);                                           // NEW
        if (Number.isFinite(endY) && endY === selectedYear) return true;              // NEW

        return false;                                                                 // NEW
    }                                                                                 // CHANGE                                                                                  // NEW

    function yearBounds(selectedYear) {                                               // NEW
        // [start, endExclusive] in ms UTC.                                            // NEW
        const start = Date.UTC(selectedYear, 0, 1, 0, 0, 0, 0);                        // NEW
        const endEx = Date.UTC(selectedYear + 1, 0, 1, 0, 0, 0, 0);                    // NEW
        return { start, endEx };                                                      // NEW
    }                                                                                 // NEW

    function getFirstNonEmptyAttr(cell, keys) {                                      // NEW
        for (const k of keys) {                                                      // NEW
            const v = getCellAttr(cell, k, "");                                      // NEW
            if (String(v || "").trim()) return v;                                    // NEW
        }                                                                            // NEW
        return "";                                                                   // NEW
    }                                                                                // NEW

    function harvestEndUtcYear(tg) {                                                 // NEW
        const raw = getFirstNonEmptyAttr(tg, [                                       // NEW
            "harvest_end",                                                           // NEW
            "harvest_end_date",                                                      // NEW
            "planting_harvest_end",                                                  // NEW
            "season_harvest_end",                                                    // NEW
            "end"                                                                    // NEW
        ]);                                                                          // NEW
        const ms = parseIsoDateToUtcMs(raw);                                         // NEW
        if (!Number.isFinite(ms)) return NaN;                                        // NEW
        return new Date(ms).getUTCFullYear();                                        // NEW
    }                                                                                // NEW    

    function parseIsoDateToUtcMs(s) {                                                 // NEW
        // Expects "YYYY-MM-DD" or full ISO.                                           // NEW
        const str = String(s || "").trim();                                           // NEW
        if (!str) return NaN;                                                         // NEW
        const d = new Date(str);                                                      // NEW
        const t = d.getTime();                                                        // NEW
        return Number.isFinite(t) ? t : NaN;                                          // NEW
    }                                                                                 // NEW

    function taskOverlapsYear(taskStartMs, taskEndExMs, selectedYear) {               // NEW
        if (!Number.isFinite(taskStartMs) || !Number.isFinite(taskEndExMs)) return false; // NEW
        const b = yearBounds(selectedYear);                                           // NEW
        return taskStartMs < b.endEx && taskEndExMs > b.start;                        // NEW
    }                                                                                 // NEW

    function shouldRenderTaskCard(taskCell, selectedYear) {                           // CHANGE
        if (!isKanbanCard(taskCell)) return false;                                    // NEW

        const sMs = parseIsoDateToUtcMs(getCellAttr(taskCell, "start", ""));          // CHANGE
        const eMs = parseIsoDateToUtcMs(getCellAttr(taskCell, "end", ""));            // CHANGE

        // Treat "end" as inclusive YYYY-MM-DD and convert to exclusive end.           // CHANGE
        const endExMs = Number.isFinite(eMs) ? (eMs + 24 * 60 * 60 * 1000) : NaN;     // CHANGE

        return taskOverlapsYear(sMs, endExMs, selectedYear);                          // CHANGE
    }

    function setStyleKey(style, key, val) {                                           // NEW
        const re = new RegExp("(^|;)" + key + "=[^;]*", "g");                          // NEW
        const cleaned = String(style || "").replace(re, "");                           // NEW
        const suffix = cleaned && !cleaned.endsWith(";") ? ";" : "";                  // NEW
        return cleaned + suffix + key + "=" + val + ";";                               // NEW
    }                                                                                 // NEW

    function setCellVisible(cell, isVisible) {                                        // CHANGE
        if (!cell) return;                                                            // NEW
        const m = graph.getModel();                                                   // NEW
        if (typeof m.setVisible === "function") {                                     // NEW
            m.setVisible(cell, !!isVisible);                                          // NEW
            return;                                                                   // NEW
        }

        // Fallback if setVisible is not available (rare)                              // NEW
        graph.toggleCells(!isVisible, [cell], true);                                  // NEW
        graph.refresh(cell);                                                          // NEW
    }                                                                                 // CHANGE                                                                        // NEW

    function applyYearVisibilityToModule(moduleCell, selectedYear) {                     // CHANGE
        const all = getDescendants(moduleCell);                                          // CHANGE
        const tilers = all.filter(isTilerGroup);                                         // CHANGE
        const cards = all.filter(isKanbanCard);                                          // CHANGE

        model.beginUpdate();                                                            // CHANGE
        try {
            // --- tiler groups: dashboard owns visibility ---------------------------- // NEW
            for (const tg of tilers) {                                                   // CHANGE
                const show = shouldRenderTilerGroup(tg, selectedYear);                   // CHANGE
                setYearHidden(tg, !show);                                                // NEW (persist)
                setCellVisible(tg, show);                                                // CHANGE (actual hide/show)
            }

            // --- kanban cards: kanban owns visibility (paging) ---------------------- // NEW
            for (const c of cards) {                                                     // CHANGE
                const show = shouldRenderTaskCard(c, selectedYear);                      // CHANGE
                setYearHidden(c, !show);                                                 // NEW (persist only)
                // DO NOT setCellVisible(c, show);                                      // NEW (prevent paging conflict)
            }
        } finally {
            model.endUpdate();                                                          // CHANGE
        }

        graph.refresh(moduleCell);                                                      // CHANGE
        notifyYearFilterChanged(moduleCell, selectedYear);                               // NEW
    }                                                                                    // CHANGE                                                                           // NEW                                                                  // NEW


    // -------------------- Overlay HTML (not persisted) --------------------
    function formatOverlayTableHtml(metrics, year) {
        const fmt1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : "0.0");
        const fmt0 = (n) => (Number.isFinite(n) ? Math.round(n).toString() : "0");
        const esc = (v) => mxUtils.htmlEntities(String(v ?? ""));

        const cropRows = (metrics.rows || []).map((r) => `
          <tr>
            <td style="border:1px solid #999; padding:4px; text-align:left; white-space:nowrap;">${esc(r.crop)}</td>
            <td style="border:1px solid #999; padding:4px; text-align:right;">${fmt1(r.area_m2)}</td>
            <td style="border:1px solid #999; padding:4px; text-align:right;">${fmt0(r.seeds)}</td>
            <td style="border:1px solid #999; padding:4px; text-align:right;">${fmt1(r.target_kg)}</td>    
            <td style="border:1px solid #999; padding:4px; text-align:right;">${fmt1(r.expected_kg)}</td>  
          </tr>
        `).join("");

        return `
<div style="font-family: Arial; font-size: 12px; line-height: 1.25;">
  <table style="width:100%; border-collapse:collapse;">
    <tbody>
      <tr>
        <td style="border:1px solid #999; padding:4px; font-weight:700; width:34%;">Garden module</td>
        <td colspan="4" style="border:1px solid #999; padding:4px;">${esc(metrics.moduleName)}</td>
      </tr>
      <tr>
        <td style="border:1px solid #999; padding:4px; font-weight:700;">Location (city)</td>
        <td colspan="4" style="border:1px solid #999; padding:4px;">${esc(metrics.city)}</td>
      </tr>
      <tr>
        <td style="border:1px solid #999; padding:4px; font-weight:700;">Selected year</td>
        <td style="border:1px solid #999; padding:4px;">${esc(year)}</td>
        <td style="border:1px solid #999; padding:4px; font-weight:700;">Total tiler groups</td>
        <td style="border:1px solid #999; padding:4px; text-align:right;">${esc(metrics.tilerGroupsTotal)}</td>
      </tr>
      <tr>
        <td style="border:1px solid #999; padding:4px; font-weight:700;">Tiler groups in year</td>
        <td style="border:1px solid #999; padding:4px; text-align:right;">${esc(metrics.tilerGroupsInYear)}</td>
        <td style="border:1px solid #999; padding:4px; font-weight:700;">(Filter)</td>
        <td style="border:1px solid #999; padding:4px;">perennial OR season_start_year == ${esc(year)}</td>
      </tr>

      <tr>
        <th colspan="5" style="border:1px solid #999; padding:6px; text-align:left;">Totals for selected year</th>
      </tr>
      <tr>
        <td style="border:1px solid #999; padding:4px; font-weight:700;">Total area (m²)</td>
        <td style="border:1px solid #999; padding:4px; text-align:right;">${fmt1(metrics.totalAreaM2)}</td>
        <td style="border:1px solid #999; padding:4px; font-weight:700;">Total seeds</td>
        <td style="border:1px solid #999; padding:4px; text-align:right;">${fmt0(metrics.totalSeeds)}</td>
      </tr>
      <tr>
        <td style="border:1px solid #999; padding:4px; font-weight:700;">Total target (kg)</td>        
        <td style="border:1px solid #999; padding:4px; text-align:right;">${fmt1(metrics.totalTargetKg)}</td> 
        <td style="border:1px solid #999; padding:4px; font-weight:700;">Total expected (kg)</td>      
        <td style="border:1px solid #999; padding:4px; text-align:right;">${fmt1(metrics.totalExpectedKg)}</td> 

        <td style="border:1px solid #999; padding:4px; font-weight:700;">Crop rows</td>
        <td style="border:1px solid #999; padding:4px; text-align:right;">${esc((metrics.rows || []).length)}</td>
      </tr>

      <tr>
        <th style="border:1px solid #999; padding:6px; text-align:left;">Crop</th>
        <th style="border:1px solid #999; padding:6px; text-align:right;">Area (m²)</th>
        <th style="border:1px solid #999; padding:6px; text-align:right;">Seeds</th>
        <th style="border:1px solid #999; padding:6px; text-align:right;">Target (kg)</th>    
        <th style="border:1px solid #999; padding:6px; text-align:right;">Expected (kg)</th>  
      </tr>

      ${cropRows || `
      <tr>
        <td colspan="5" style="border:1px solid #999; padding:8px; text-align:left;">
          No crops found for ${esc(year)}.
        </td>
      </tr>
      `}
    </tbody>

    <tfoot>
      <tr>
        <td style="border:1px solid #999; padding:6px; font-weight:700;">Total</td>
        <td style="border:1px solid #999; padding:6px; text-align:right; font-weight:700;">${fmt1(metrics.totalAreaM2)}</td>
        <td style="border:1px solid #999; padding:6px; text-align:right; font-weight:700;">${fmt0(metrics.totalSeeds)}</td>
        <td style="border:1px solid #999; padding:6px; text-align:right; font-weight:700;">${fmt1(metrics.totalTargetKg)}</td>
        <td style="border:1px solid #999; padding:6px; text-align:right; font-weight:700;">${fmt1(metrics.totalExpectedKg)}</td>
      </tr>
    </tfoot>
  </table>
</div>`.trim();
    }

    // -------------------- CSV helpers --------------------
    function csvEscape(s) {
        const str = String(s ?? "");
        const needsQuotes = /[",\n\r]/.test(str);
        const escaped = str.replace(/"/g, '""');
        return needsQuotes ? `"${escaped}"` : escaped;
    }

    function downloadCsv(filename, csvText) {
        const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    function buildDashboardCsvSingleTable(metrics, year) {                                   // CHANGE
        const rows = [];                                                                    // CHANGE
        const push = (arr) => rows.push(arr.map(csvEscape).join(","));                      // NEW

        push(["Garden Dashboard"]);                                                         // NEW
        push(["Garden module", metrics.moduleName || ""]);                                  // NEW
        push(["Location (city)", metrics.city || ""]);                                      // NEW
        push(["Selected year", String(year)]);                                              // NEW
        push(["Total tiler groups", String(metrics.tilerGroupsTotal ?? 0)]);                // NEW
        push(["Tiler groups in year", String(metrics.tilerGroupsInYear ?? 0)]);             // NEW
        push(["Filter", `perennial OR season_start_year == ${year}`]);                      // NEW

        push([""]);                                                                         // NEW
        push(["Totals for selected year"]);                                                 // NEW
        push(["Total area (m²)", Number.isFinite(metrics.totalAreaM2) ? metrics.totalAreaM2.toFixed(1) : "0.0"]); // NEW
        push(["Total seeds", Number.isFinite(metrics.totalSeeds) ? String(Math.round(metrics.totalSeeds)) : "0"]); // NEW
        push(["Total target (kg)", Number.isFinite(metrics.totalTargetKg) ? metrics.totalTargetKg.toFixed(1) : "0.0"]); // NEW
        push(["Total expected (kg)", Number.isFinite(metrics.totalExpectedKg) ? metrics.totalExpectedKg.toFixed(1) : "0.0"]); // NEW

        push([""]);                                                                         // NEW
        push(["Crop", "Area (m²)", "Seeds", "Target (kg)", "Expected (kg)"]);               // NEW

        const list = metrics.rows || [];                                                    // NEW
        if (list.length === 0) {
            push([`No crops found for ${year}.`]);                                          // NEW
        } else {
            for (const r of list) {
                push([
                    r.crop || "",
                    Number.isFinite(r.area_m2) ? r.area_m2.toFixed(1) : "0.0",
                    Number.isFinite(r.seeds) ? String(Math.round(r.seeds)) : "0",
                    Number.isFinite(r.target_kg) ? r.target_kg.toFixed(1) : "0.0",
                    Number.isFinite(r.expected_kg) ? r.expected_kg.toFixed(1) : "0.0"
                ]);                                                                         // NEW
            }
        }

        push(["Total",
            Number.isFinite(metrics.totalAreaM2) ? metrics.totalAreaM2.toFixed(1) : "0.0",
            Number.isFinite(metrics.totalSeeds) ? String(Math.round(metrics.totalSeeds)) : "0",
            Number.isFinite(metrics.totalTargetKg) ? metrics.totalTargetKg.toFixed(1) : "0.0",
            Number.isFinite(metrics.totalExpectedKg) ? metrics.totalExpectedKg.toFixed(1) : "0.0"
        ]);                                                                                 // NEW

        return rows.join("\r\n");                                                           // NEW
    }                                                                                       // CHANGE

    // -------------------- DOM overlay (controls + table) --------------------
    const overlayByDashId = new Map();

    function removeOverlay(dashId) {
        const entry = overlayByDashId.get(dashId);
        if (!entry) return;
        entry.wrap.remove();
        overlayByDashId.delete(dashId);
    }

    function ensureOverlay(dashCell) {
        const dashId = dashCell.getId();
        if (overlayByDashId.has(dashId)) return overlayByDashId.get(dashId);

        const wrap = document.createElement("div");
        wrap.style.display = "flex";
        wrap.style.flexDirection = "column";
        wrap.style.minHeight = "0";

        wrap.style.position = "absolute";
        wrap.style.zIndex = "10";
        wrap.style.pointerEvents = "auto";
        wrap.style.boxSizing = "border-box";
        wrap.style.padding = CTRL_PAD + "px";

        // Visual: keep overlay readable but inside the cell bounds 
        wrap.style.background = "rgba(255,255,255,0.0)";

        // Header bar (controls) 
        const header = document.createElement("div");
        header.style.flex = "0 0 auto";
        header.style.display = "flex";
        header.style.alignItems = "center";
        header.style.justifyContent = "flex-end";
        header.style.gap = BTN_GAP + "px";
        header.style.marginBottom = "6px";
        header.style.pointerEvents = "auto";

        const mkBtn = (txt) => {
            const b = document.createElement("button");
            b.textContent = txt;
            b.style.width = BTN_SIZE + "px";
            b.style.height = BTN_SIZE + "px";
            b.style.border = "1px solid #777";
            b.style.borderRadius = "6px";
            b.style.background = "#fff";
            b.style.cursor = "pointer";
            b.style.padding = "0";
            b.style.lineHeight = "1";
            return b;
        };

        const prev = mkBtn("◀");
        const next = mkBtn("▶");

        const yearLabel = document.createElement("div");
        yearLabel.style.minWidth = "60px";
        yearLabel.style.textAlign = "center";
        yearLabel.style.fontFamily = "Arial";
        yearLabel.style.fontSize = "12px";
        yearLabel.style.fontWeight = "700";
        yearLabel.style.padding = "2px 6px";
        yearLabel.style.border = "1px solid #777";
        yearLabel.style.borderRadius = "6px";
        yearLabel.style.background = "#fff";

        const planBtn = document.createElement("button");                 // NEW
        planBtn.textContent = "Plan";                                     // NEW
        planBtn.style.height = BTN_SIZE + "px";                           // NEW
        planBtn.style.border = "1px solid #777";                          // NEW
        planBtn.style.borderRadius = "6px";                               // NEW
        planBtn.style.background = "#fff";                                // NEW
        planBtn.style.cursor = "pointer";                                 // NEW
        planBtn.style.padding = "0 8px";                                  // NEW
        planBtn.style.fontFamily = "Arial";                               // NEW
        planBtn.style.fontSize = "12px";                                  // NEW

        const allocateBtn = document.createElement("button");    // NEW
        allocateBtn.textContent = "Allocate";                    // NEW
        allocateBtn.style.height = BTN_SIZE + "px";              // NEW
        allocateBtn.style.border = "1px solid #777";             // NEW
        allocateBtn.style.borderRadius = "6px";                  // NEW
        allocateBtn.style.background = "#fff";                   // NEW
        allocateBtn.style.cursor = "pointer";                    // NEW
        allocateBtn.style.padding = "0 8px";                     // NEW
        allocateBtn.style.fontFamily = "Arial";                  // NEW
        allocateBtn.style.fontSize = "12px";                     // NEW

        const exportBtn = document.createElement("button");
        exportBtn.textContent = "Export";
        exportBtn.style.height = BTN_SIZE + "px";
        exportBtn.style.border = "1px solid #777";
        exportBtn.style.borderRadius = "6px";
        exportBtn.style.background = "#fff";
        exportBtn.style.cursor = "pointer";
        exportBtn.style.padding = "0 8px";
        exportBtn.style.fontFamily = "Arial";
        exportBtn.style.fontSize = "12px";

        // Content area 
        const content = document.createElement("div");
        content.style.pointerEvents = "auto";
        content.style.background = "#fff";
        content.style.border = "1px solid #999";
        content.style.borderRadius = "6px";
        content.style.padding = "6px";
        content.style.overflow = "auto";

        content.style.flex = "1 1 auto";
        content.style.minHeight = "0";
        content.style.maxHeight = "none";
        content.style.boxSizing = "border-box";



        function syncYearLabel() {
            yearLabel.textContent = String(getDashboardYear(dashCell));
        }

        prev.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            model.beginUpdate();
            try {
                const y = getDashboardYear(dashCell);
                setDashboardYear(dashCell, y - 1);
            } finally {
                model.endUpdate();
            }

            const moduleCell = findModuleAncestor(graph, dashCell);                              // NEW
            if (moduleCell) applyYearVisibilityToModule(moduleCell, getDashboardYear(dashCell)); // NEW

            recomputeAndRenderDashboard(dashCell);
        });


        next.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            model.beginUpdate();
            try {
                const y = getDashboardYear(dashCell);
                setDashboardYear(dashCell, y + 1);
            } finally {
                model.endUpdate();
            }
            const moduleCell = findModuleAncestor(graph, dashCell);                              // NEW
            if (moduleCell) applyYearVisibilityToModule(moduleCell, getDashboardYear(dashCell)); // NEW

            recomputeAndRenderDashboard(dashCell);
        });

        planBtn.addEventListener("click", (ev) => {                        // NEW
            ev.preventDefault();                                           // NEW
            ev.stopPropagation();                                          // NEW

            const moduleCell = findModuleAncestor(graph, dashCell);        // NEW
            if (!moduleCell) return;                                       // NEW

            const year = getDashboardYear(dashCell);                       // NEW

            try {                                                          // NEW
                window.dispatchEvent(new CustomEvent(PLAN_YEAR_EVENT, {     // NEW
                    detail: {
                        moduleCellId: moduleCell.getId ? moduleCell.getId() : moduleCell.id,
                        dashCellId: dashCell.getId ? dashCell.getId() : dashCell.id,
                        year: year
                    }
                }));
            } catch (_) { }
        });                                                                // NEW        

        allocateBtn.addEventListener("click", (ev) => {                         // NEW
            ev.preventDefault();                                                // NEW
            ev.stopPropagation();                                               // NEW
        
            const moduleCell = findModuleAncestor(graph, dashCell);             // NEW
            if (!moduleCell) return;                                            // NEW
        
            const year = getDashboardYear(dashCell);                            // NEW
        
            try {                                                               // NEW
                window.dispatchEvent(new CustomEvent(ALLOCATE_PLAN_EVENT, {      // NEW
                    detail: {
                        moduleCellId: moduleCell.getId ? moduleCell.getId() : moduleCell.id,
                        dashCellId: dashCell.getId ? dashCell.getId() : dashCell.id,
                        year: year
                    }
                }));
            } catch (_) { }
        });                                                                     // NEW        

        exportBtn.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();

            const moduleCell = findModuleAncestor(graph, dashCell);
            if (!moduleCell) return;

            const year = getDashboardYear(dashCell);

            applyYearVisibilityToModule(moduleCell, year); // NEW

            const metrics = computeModuleMetrics(moduleCell, year);

            const safeName = String(metrics.moduleName || "garden")
                .replace(/[^\w\-]+/g, "_")
                .slice(0, 60);

            const filename = `${safeName}_${year}_dashboard.csv`;
            const csv = buildDashboardCsvSingleTable(metrics, year);
            downloadCsv(filename, csv);
        });

        header.appendChild(prev);
        header.appendChild(yearLabel);
        header.appendChild(next);
        header.appendChild(planBtn);       // NEW
        header.appendChild(allocateBtn);   // NEW
        header.appendChild(exportBtn);

        wrap.appendChild(header);
        wrap.appendChild(content);

        graph.container.appendChild(wrap);

        const entry = { wrap, header, content, prev, next, planBtn, allocateBtn, exportBtn, yearLabel, syncYearLabel }; // CHANGE
        overlayByDashId.set(dashId, entry);

        function isOverlayControlTarget(el) {
            if (!el) return false;
            // Treat header controls and form-like elements as interactive.         
            if (el.closest && el.closest("button,a,input,select,textarea,label")) return true;
            if (entry && entry.header && entry.header.contains(el)) return true;
            return false;
        }

        function selectDashboardCell(ev) {
            // If the user clicked a control, let existing handlers run.            
            if (isOverlayControlTarget(ev.target)) return;

            // Select the dashboard cell explicitly.                                
            graph.setSelectionCell(dashCell);

            // Keep overlay from starting unwanted browser selection/drag.          
            ev.preventDefault();
            ev.stopPropagation();
        }

        wrap.addEventListener("pointerdown", selectDashboardCell, true);
        wrap.addEventListener("mousedown", selectDashboardCell, true);
        wrap.addEventListener("contextmenu", function (ev) {
            // Ensure right-click also selects the dashboard before menu shows.     
            if (isOverlayControlTarget(ev.target)) return;
            graph.setSelectionCell(dashCell);
        }, true);

        syncYearLabel();
        return entry;
    }

    function applyScaledControlStyles(entry) {
        if (!entry) return;

        const s = getUiScale();

        const btnPx = Math.round(BTN_SIZE * s);
        const gapPx = Math.round(BTN_GAP * s);
        const fontPx = Math.max(10, Math.round(12 * s));
        const radiusPx = Math.round(6 * s);
        const padYPx = Math.round(2 * s);
        const padXPx = Math.round(6 * s);

        entry.header.style.gap = gapPx + "px";

        for (const b of [entry.prev, entry.next]) {
            b.style.width = btnPx + "px";
            b.style.height = btnPx + "px";
            b.style.borderRadius = radiusPx + "px";
            b.style.fontSize = fontPx + "px";
        }

        entry.yearLabel.style.minWidth = Math.round(60 * s) + "px";
        entry.yearLabel.style.fontSize = fontPx + "px";
        entry.yearLabel.style.padding =
            padYPx + "px " + padXPx + "px";
        entry.yearLabel.style.borderRadius = radiusPx + "px";

        entry.exportBtn.style.height = btnPx + "px";
        entry.exportBtn.style.fontSize = fontPx + "px";
        entry.exportBtn.style.padding =
            padYPx + "px " + padXPx + "px";
        entry.exportBtn.style.borderRadius = radiusPx + "px";

        entry.planBtn.style.height = btnPx + "px";                         // NEW
        entry.planBtn.style.fontSize = fontPx + "px";                      // NEW
        entry.planBtn.style.padding = padYPx + "px " + padXPx + "px";      // NEW
        entry.planBtn.style.borderRadius = radiusPx + "px";                // NEW

        entry.allocateBtn.style.height = btnPx + "px";                         // NEW
        entry.allocateBtn.style.fontSize = fontPx + "px";                      // NEW
        entry.allocateBtn.style.padding = padYPx + "px " + padXPx + "px";      // NEW
        entry.allocateBtn.style.borderRadius = radiusPx + "px";                // NEW        

    }


    function positionOverlay(dashCell) {
        if (!dashCell) return;

        const st = graph.view.getState(dashCell);
        if (!st) return;

        const dashId = dashCell.getId();
        const entry = overlayByDashId.get(dashId);
        if (!entry) return;

        // Overlay fills the dashboard cell rect (deterministic; no DOM measuring). 
        entry.wrap.style.left = Math.round(st.x) + "px";
        entry.wrap.style.top = Math.round(st.y) + "px";
        entry.wrap.style.width = Math.max(0, Math.round(st.width)) + "px";
        entry.wrap.style.height = Math.max(0, Math.round(st.height)) + "px";

        // Make content area fit remaining space (header is natural height). 
        // Keep simple: rely on overflow:auto and wrap padding. 

        applyScaledControlStyles(entry);
    }

    function renderOverlay(dashCell, metrics, year) {
        const entry = ensureOverlay(dashCell);
        entry.syncYearLabel();
        entry.content.innerHTML = formatOverlayTableHtml(metrics, year);
        positionOverlay(dashCell);
    }

    function cleanupMissingDashboards() {
        for (const [dashId, entry] of overlayByDashId.entries()) {
            const cell = model.getCell(dashId);
            if (!cell || !cell.getAttribute || cell.getAttribute(DASH_ATTR) !== "1") {
                removeOverlay(dashId);
            }
        }
    }

    // -------------------- Dashboard update orchestration --------------------
    function recomputeAndRenderDashboard(dashCell) {
        if (!dashCell) return;
        const moduleCell = findModuleAncestor(graph, dashCell);
        if (!moduleCell) return;

        const year = getDashboardYear(dashCell);
        const metrics = computeModuleMetrics(moduleCell, year);

        // Render the full UI as a DOM overlay. 
        renderOverlay(dashCell, metrics, year);
    }

    function ensureOverlayForDashboard(dashCell) {
        if (!dashCell) return;
        ensureOverlay(dashCell);
        positionOverlay(dashCell);
    }

    // -------------------- Create dashboard cell --------------------
    function createDashboardCell(moduleCell) {
        const parent = moduleCell;

        const x = 20;
        const y = 20;
        const w = 320;
        const h = 220;

        // Safer: use graph.insertVertex which handles value nodes correctly
        const inserted = graph.insertVertex(parent, null, "", x, y, w, h, DASH_STYLE);

        setCellAttr(inserted, DASH_ATTR, "1");                                              // CHANGE (moved up)
        setDashboardYear(inserted, new Date().getFullYear());                               // CHANGE (moved up)
        applyYearVisibilityToModule(moduleCell, getDashboardYear(inserted));                // CHANGE (moved down)        

        // Ensure it is visually on top of other children (optional)
        try { graph.orderCells(false, [inserted]); } catch (e) { }

        ensureOverlayForDashboard(inserted);
        recomputeAndRenderDashboard(inserted);

        return inserted;
    }

    function hasGardenSettingsSet(moduleCell) {                                               // NEW
        return !!(moduleCell && moduleCell.getAttribute &&                                   // NEW
            moduleCell.getAttribute("city_name") &&                                          // NEW
            moduleCell.getAttribute("unit_system"));                                         // NEW
    }                                                                                        // NEW

    // -------------------- Auto-create dashboard on garden module event -------------------- // NEW
    if (!graph.__gardenDashboardAutoCreateInstalled) {                                         // NEW
        graph.__gardenDashboardAutoCreateInstalled = true;                                     // NEW

        graph.addListener("usl:gardenModuleNeedsSettings", function (sender, evt) {            // NEW
            const mod = evt.getProperty("cell");                                               // NEW
            if (!mod || !isGardenModule(mod)) return;                                          // NEW

            // Idempotent: do nothing if already present                                       // NEW
            if (findDashboardCell(mod)) return;                                                // NEW

            // Optional gating: only create after mandatory settings exist                      // NEW
            // If you want immediate dashboard creation, delete this block.                     // NEW
            if (!hasGardenSettingsSet(mod)) return;                                            // NEW

            setTimeout(function () {                                                           // NEW
                // Re-check after delay                                                         // NEW
                if (!model.getCell(mod.getId ? mod.getId() : mod.id)) return;                  // NEW
                if (!isGardenModule(mod)) return;                                              // NEW
                if (findDashboardCell(mod)) return;                                            // NEW
                if (!hasGardenSettingsSet(mod)) return;                                        // NEW

                model.beginUpdate();                                                           // NEW
                try {
                    createDashboardCell(mod);                                                  // NEW
                } finally {
                    model.endUpdate();                                                         // NEW
                }
            }, 0);                                                                             // NEW
        });                                                                                    // NEW
    }                                                                                          // NEW


    // -------------------- View/model event wiring --------------------
    let rafPending = false;
    function scheduleOverlayReposition() {
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(function () {
            rafPending = false;
            cleanupMissingDashboards();
            for (const [dashId, entry] of overlayByDashId.entries()) {
                const cell = model.getCell(dashId);
                if (cell) positionOverlay(cell);
            }
        });
    }

    // Hook into view updates (zoom/pan/resize)
    const oldValidate = graph.view.validate;
    graph.view.validate = function () {
        const res = oldValidate.apply(this, arguments);
        scheduleOverlayReposition();
        return res;
    };

    window.addEventListener("resize", function () {
        scheduleOverlayReposition();
    });

    // On model changes, reposition overlays (and optionally recompute when selected). 
    model.addListener(mxEvent.CHANGE, function () {
        scheduleOverlayReposition();

        // Conservative recompute: if a dashboard is selected (or inside selected), update it. 
        const sel = graph.getSelectionCell && graph.getSelectionCell();
        if (!sel) return;
        const dash = (sel.getAttribute && sel.getAttribute(DASH_ATTR) === "1") ? sel : findDashboardAncestor(sel);
        if (!dash) return;
        recomputeAndRenderDashboard(dash);
    });

    // Recompute when selecting a dashboard (or something inside it)
    graph.getSelectionModel().addListener(mxEvent.CHANGE, function () {
        const sel = graph.getSelectionCell();
        if (!sel) return;

        const dash = (sel.getAttribute && sel.getAttribute(DASH_ATTR) === "1")
            ? sel
            : findDashboardAncestor(sel);

        if (!dash) return;

        setTimeout(function () {
            ensureOverlayForDashboard(dash);
            recomputeAndRenderDashboard(dash);
        }, 0);
    });

    // -------------------- Context menu: Create Garden Dashboard --------------------
    const oldCreatePopupMenu = ui.menus.createPopupMenu;
    ui.menus.createPopupMenu = function (menu, cell, evt) {
        oldCreatePopupMenu.apply(this, arguments);

        if (!cell) return;

        // If user right-clicks inside something, we want the garden module ancestor
        const mod = isGardenModule(cell) ? cell : (function () {
            const anc = findModuleAncestor(graph, cell);
            return (anc && isGardenModule(anc)) ? anc : null;
        })();

        if (!mod) return;

        const existing = findDashboardCell(mod);
        if (existing) return;

        menu.addSeparator();
        menu.addItem("Create Garden Dashboard", null, function () {
            graph.getModel().beginUpdate();
            try {
                createDashboardCell(mod);
            } finally {
                graph.getModel().endUpdate();
            }
        });
    };

    // -------------------- If dashboards already exist in file, attach overlays --------------------
    function attachExistingDashboards() {
        const root = model.getRoot();
        const all = getDescendants(root);

        for (const c of all) {
            if (c && c.getAttribute && c.getAttribute(DASH_ATTR) === "1") {
                ensureOverlayForDashboard(c);
                recomputeAndRenderDashboard(c);

                const mod = findModuleAncestor(graph, c);                                        // FIX
                if (mod) applyYearVisibilityToModule(mod, getDashboardYear(c));                  // FIX
            }
        }

        scheduleOverlayReposition();
    }

    attachExistingDashboards();
});
