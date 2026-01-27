/**
 * Draw.io Plugin: Year Planner (listens for dashboard Plan button events)
 *
 * Listens:
 *   window event "usl:planYearRequested" with detail:
 *     { moduleCellId: string, dashCellId?: string, year: number }
 *
 * Stores plan JSON on the module cell attribute:
 *   plan_year_json  -> JSON object keyed by year string
 */
Draw.loadPlugin(function (ui) {
    const graph = ui.editor && ui.editor.graph;
    if (!graph) return;

    const model = graph.getModel();

    // Prevent double install
    if (graph.__yearPlannerInstalled) return;
    graph.__yearPlannerInstalled = true;

    // -------------------- Config --------------------
    const DB_PATH = "C:/Users/user/Desktop/Gardening/Syntropy(3).sqlite";
    const PLAN_YEARS_ATTR = "plan_year_json";
    const PLAN_TEMPLATES_ATTR = "plan_year_templates";     // NEW (diagram-scoped)
    const PLAN_UNIT_DEFAULTS_ATTR = "plan_unit_defaults";  // NEW (diagram-scoped, per plantId)

    let __harvestSuggestedHandler = null;                                             // NEW

    // -------------------- DB helpers --------------------
    async function queryAll(sql, params) {
        if (!window.dbBridge || typeof window.dbBridge.open !== 'function') {
            throw new Error('dbBridge not available; check preload/main wiring');
        }
        const opened = await window.dbBridge.open(DB_PATH, { readOnly: true });
        try {
            const res = await window.dbBridge.query(opened.dbId, sql, params || []);
            return Array.isArray(res?.rows) ? res.rows : [];
        } finally {
            try { await window.dbBridge.close(opened.dbId); } catch (_) { }
        }
    }

    async function listPlantsBasicRows() {
        const sql = `
          SELECT plant_id, plant_name, yield_per_plant_kg, harvest_window_days
          FROM Plants
          WHERE abbr IS NOT NULL
          ORDER BY plant_name;`;
        return await queryAll(sql, []);
    }

    let __plantsBasicCache = null;
    async function getPlantsBasicCached() {
        if (__plantsBasicCache) return __plantsBasicCache;
        __plantsBasicCache = await listPlantsBasicRows();
        return __plantsBasicCache;
    }

    // -------------------- Attribute helpers --------------------
    function getCellAttr(cell, key, def = "") {
        if (!cell || !cell.getAttribute) return def;
        const v = cell.getAttribute(key);
        return (v === null || v === undefined) ? def : v;
    }

    function setCellAttr(cell, key, val) {
        if (graph.setAttributeForCell) {
            if (val == null) graph.setAttributeForCell(cell, key, null);
            else graph.setAttributeForCell(cell, key, String(val));
        } else if (cell.value && typeof cell.value.setAttribute === "function") {
            if (val == null) cell.value.removeAttribute(key);
            else cell.value.setAttribute(key, String(val));
        }
    }

    function safeJsonParse(s, fallback) {
        try { return JSON.parse(String(s || "")); } catch (_) { return fallback; }
    }

    function readPlanYearsMap(moduleCell) {
        const raw = getCellAttr(moduleCell, PLAN_YEARS_ATTR, "");
        const obj = safeJsonParse(raw, null);
        return (obj && typeof obj === "object" && !Array.isArray(obj)) ? obj : {};
    }

    function writePlanYearsMap(moduleCell, mapObj) {                                   // CHANGE
        model.beginUpdate();                                                           // NEW
        try {                                                                           // NEW
            setCellAttr(moduleCell, PLAN_YEARS_ATTR, JSON.stringify(mapObj || {}));     // CHANGE
        } finally {                                                                     // NEW
            model.endUpdate();                                                         // NEW
        }                                                                               // NEW
        graph.refresh(moduleCell);                                                     // CHANGE
    }                                                                                  // CHANGE                                                                              // CHANGE


    function loadPlanForYear(moduleCell, year) {
        const m = readPlanYearsMap(moduleCell);
        const p = m[String(year)];
        return (p && typeof p === "object" && !Array.isArray(p)) ? p : null;
    }

    function savePlanForYear(moduleCell, year, planObj) {
        const m = readPlanYearsMap(moduleCell);
        m[String(year)] = planObj;
        writePlanYearsMap(moduleCell, m);
    }

    function deletePlanForYear(moduleCell, year) {
        const m = readPlanYearsMap(moduleCell);
        delete m[String(year)];
        writePlanYearsMap(moduleCell, m);
    }

    function getDiagramRootCell() {                 // CHANGE
        try { return model.getRoot(); } catch (_) { }
        return null;
    }                                                                           // NEW

    function readRootJsonMap(attrName) {                                            // NEW
        const root = getDiagramRootCell();                                          // NEW
        if (!root) return {};                                                       // NEW
        const raw = getCellAttr(root, attrName, "");                                // NEW
        const obj = safeJsonParse(raw, null);                                       // NEW
        return (obj && typeof obj === "object" && !Array.isArray(obj)) ? obj : {};  // NEW
    }                                                                              // NEW

    function writeRootJsonMap(attrName, mapObj) {                                   // NEW
        const root = getDiagramRootCell();                                          // NEW
        if (!root) return;                                                          // NEW
        model.beginUpdate();                                                        // NEW
        try { setCellAttr(root, attrName, JSON.stringify(mapObj || {})); }          // NEW
        finally { model.endUpdate(); }                                              // NEW
        graph.refresh(root);                                                        // NEW
    }                                                                              // NEW

    // -------------------- Template helpers ---------------------

    function listTemplateNames() {                                                  // NEW
        return Object.keys(readRootJsonMap(PLAN_TEMPLATES_ATTR)).sort();            // NEW
    }                                                                              // NEW

    function loadTemplateByName(name) {                                             // NEW
        const m = readRootJsonMap(PLAN_TEMPLATES_ATTR);                             // NEW
        const t = m[String(name || "")];                                            // NEW
        return (t && typeof t === "object" && !Array.isArray(t)) ? t : null;        // NEW
    }                                                                              // NEW

    function saveTemplateByName(name, templateObj) {                                // NEW
        const key = String(name || "").trim();                                      // NEW
        if (!key) return;                                                           // NEW
        const m = readRootJsonMap(PLAN_TEMPLATES_ATTR);                             // NEW
        m[key] = templateObj;                                                       // NEW
        writeRootJsonMap(PLAN_TEMPLATES_ATTR, m);                                   // NEW
    }                                                                              // NEW

    function deleteTemplateByName(name) {                                           // NEW
        const key = String(name || "").trim();                                      // NEW
        if (!key) return;                                                           // NEW
        const m = readRootJsonMap(PLAN_TEMPLATES_ATTR);                             // NEW
        delete m[key];                                                              // NEW
        writeRootJsonMap(PLAN_TEMPLATES_ATTR, m);                                   // NEW
    }                                                                              // NEW

    function deepClone(obj) {                                                      // NEW
        return safeJsonParse(JSON.stringify(obj), null);                            // NEW
    }                                                                              // NEW

    function rekeyTemplateToPlan(templateObj, year) {                               // NEW
        // Apply template: bind to year, regenerate crop IDs, and remap CSA cropIds.
        const t = deepClone(templateObj) || {};                                     // NEW
        t.version = 1;                                                              // NEW
        t.year = year;                                                              // NEW
        if (!Number.isFinite(t.weekStartDow)) t.weekStartDow = 1;                   // NEW
        t.crops = Array.isArray(t.crops) ? t.crops : [];                            // NEW
        t.csa = (t.csa && typeof t.csa === "object") ? t.csa : { enabled: false, boxesPerWeek: 0, start: "", end: "", components: [] }; // NEW
        t.csa.components = Array.isArray(t.csa.components) ? t.csa.components : []; // NEW

        const idMap = new Map();                                                    // NEW
        for (const c of t.crops) {                                                  // NEW
            const oldId = c.id;                                                     // NEW
            c.id = uid("crop");                                                     // NEW
            idMap.set(oldId, c.id);                                                 // NEW
        }                                                                           // NEW
        for (const comp of t.csa.components) {                                      // NEW
            if (idMap.has(comp.cropId)) comp.cropId = idMap.get(comp.cropId);       // NEW
        }                                                                           // NEW
        return t;                                                                   // NEW
    }                                                                              // NEW

    // -------------------- Default helpers --------------------

    function readUnitDefaultsMap() {                                                // NEW
        return readRootJsonMap(PLAN_UNIT_DEFAULTS_ATTR);                             // NEW
    }                                                                              // NEW

    function writeUnitDefaultsMap(mapObj) {                                         // NEW
        writeRootJsonMap(PLAN_UNIT_DEFAULTS_ATTR, mapObj);                           // NEW
    }                                                                              // NEW

    function getDefaultsForPlant(plantId) {                                         // NEW
        const m = readUnitDefaultsMap();                                            // NEW
        const v = m[String(plantId || "")];                                         // NEW
        return Array.isArray(v) ? v : null;                                         // NEW
    }                                                                              // NEW

    function saveDefaultsForPlant(plantId, packagesArray) {                         // NEW
        const pid = String(plantId || "").trim();                                   // NEW
        if (!pid) return;                                                           // NEW
        const m = readUnitDefaultsMap();                                            // NEW
        m[pid] = Array.isArray(packagesArray) ? packagesArray : [];                 // NEW
        writeUnitDefaultsMap(m);                                                    // NEW
    }                                                                              // NEW                                                                                 // NEW


    // -------------------- Plan math helpers (MVP) --------------------
    function pushWarn(warns, msg) {                                                  // NEW
        if (!warns) return;                                                          // NEW
        warns.push(String(msg || ""));                                               // NEW
    }                                                                                // NEW

    function hasYmd(s) {                                                             // NEW
        return /^\d{4}-\d{2}-\d{2}$/.test(String(s || "").trim());                    // NEW
    }                                                                                // NEW    

    function toIsoDateLocal(d) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const da = String(d.getDate()).padStart(2, "0");
        return `${y}-${m}-${da}`;
    }

    function parseYmdLocalToMs(ymd) {
        const s = String(ymd || "").trim();
        if (!s) return NaN;
        const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (!m) return NaN;
        const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
        const dt = new Date(y, mo, d, 0, 0, 0, 0);
        const t = dt.getTime();
        return Number.isFinite(t) ? t : NaN;
    }

    function addDaysMs(ms, days) {
        return ms + (days * 24 * 60 * 60 * 1000);
    }

    function buildWeekStartsForYearLocal(year, weekStartDow /* 0=Sun..6=Sat */) {
        const start = new Date(year, 0, 1);
        const startDow = start.getDay();
        const delta = (7 + (startDow - weekStartDow)) % 7;
        const firstWeekStart = new Date(year, 0, 1 - delta);

        const out = [];
        for (let i = 0; i < 60; i++) {
            const d = new Date(firstWeekStart.getFullYear(), firstWeekStart.getMonth(), firstWeekStart.getDate() + i * 7);
            out.push({ iso: toIsoDateLocal(d), ms: d.getTime() });
            if (d.getFullYear() > year + 1) break;
        }

        const yearStartMs = new Date(year, 0, 1).getTime();
        const yearEndExMs = new Date(year + 1, 0, 1).getTime();
        return out.filter(w => w.ms < yearEndExMs && addDaysMs(w.ms, 7) > yearStartMs);
    }

    function weekIndexForDate(weekStarts, dateYmd) {
        const t = parseYmdLocalToMs(dateYmd);
        if (!Number.isFinite(t)) return -1;
        for (let i = 0; i < weekStarts.length; i++) {
            const a = weekStarts[i].ms;
            const b = addDaysMs(a, 7);
            if (t >= a && t < b) return i;
        }
        return -1;
    }

    function findCrop(plan, cropId) {
        const list = (plan && plan.crops) ? plan.crops : [];
        return list.find(c => c && c.id === cropId) || null;
    }

    function resolveUnitToKgPerUnit(crop, unit) {
        const u = String(unit || "").trim().toLowerCase();
        if (!u) return NaN;

        // universal
        if (u === "kg") return 1;
        if (u === "g") return 0.001;
        if (u === "lb" || u === "lbs") return 0.45359237;

        const packs = (crop && crop.packages) ? crop.packages : [];
        const p = packs.find(x => String(x.unit || "").trim().toLowerCase() === u);
        if (!p) return NaN;

        const baseType = String(p.baseType || "").trim().toLowerCase();
        const baseQty = Number(p.baseQty);
        if (!Number.isFinite(baseQty) || baseQty <= 0) return NaN;

        if (baseType === "kg") return baseQty;

        if (baseType === "plant" || baseType === "plants") {
            const kgPerPlant = Number(crop.kgPerPlant);
            if (!Number.isFinite(kgPerPlant) || kgPerPlant <= 0) return NaN;
            return baseQty * kgPerPlant;
        }

        return NaN;
    }

    function addKgAcrossWeeks(series, weekStarts, fromYmd, toYmd, kgPerWeek) {
        const i0 = weekIndexForDate(weekStarts, fromYmd);
        const i1 = weekIndexForDate(weekStarts, toYmd);
        if (i0 < 0 || i1 < 0) return;
        const a = Math.min(i0, i1);
        const b = Math.max(i0, i1);
        for (let i = a; i <= b; i++) series[i] += kgPerWeek;
    }

    function computePlanWeekly(plan, warns) {                                        // CHANGE

        warns = Array.isArray(warns) ? warns : [];                            // NEW

        const year = Number(plan && plan.year);                                      // CHANGE
        const weekStartDow = Number.isFinite(plan && plan.weekStartDow) ? plan.weekStartDow : 1;
        const weeks = buildWeekStartsForYearLocal(year, weekStartDow);
        const n = weeks.length;

        const targetTotal = Array(n).fill(0);
        const supplyTotal = Array(n).fill(0);
        const perCrop = new Map();

        function ensureCropArrays(cropId) {
            if (!perCrop.has(cropId)) {
                perCrop.set(cropId, { target: Array(n).fill(0), supply: Array(n).fill(0) });
            }
            return perCrop.get(cropId);
        }

        const crops = (plan && plan.crops) ? plan.crops : [];

        // market
        for (const crop of crops) {
            if (!crop || !crop.id) continue;
            const arr = ensureCropArrays(crop.id);
            const market = crop.market || [];
            for (const line of market) {
                const qty = Number(line && line.qty);
                if (!Number.isFinite(qty) || qty <= 0) {
                    pushWarn(warns, `CSA component skipped (qty missing) for ${crop.plant || crop.id}`); // CHANGE
                    continue;
                }

                if (!hasYmd(line.from) || !hasYmd(line.to)) {                         // NEW
                    pushWarn(warns, `Market line skipped (missing dates) for ${crop.plant || crop.id}`); // FIX
                    continue;                                                         // NEW
                }                                                                      // NEW

                const kgPerUnit = resolveUnitToKgPerUnit(crop, line.unit);
                if (!Number.isFinite(kgPerUnit)) {                                     // CHANGE
                    pushWarn(warns, `Market line skipped (unknown unit "${line.unit}") for ${crop.plant || crop.id}`); // CHANGE
                    continue;                                                         // CHANGE
                }                                                                   // NEW

                addKgAcrossWeeks(arr.target, weeks, line.from, line.to, qty * kgPerUnit);
            }
        }

        // CSA
        const csa = plan && plan.csa;
        if (csa && csa.enabled) {
            const boxes = Number(csa.boxesPerWeek);
            if (!Number.isFinite(boxes) || boxes <= 0) {
                pushWarn(warns, "CSA enabled but boxes/week is not set.");             // NEW
            } else {
                const comps = csa.components || [];
                for (const comp of comps) {
                    const crop = findCrop(plan, comp.cropId);
                    if (!crop) { pushWarn(warns, "CSA component skipped (missing crop)."); continue; } // NEW

                    const qty = Number(comp.qty);
                    if (!Number.isFinite(qty) || qty <= 0) {
                        pushWarn(warns, `Market line skipped (qty missing) for ${crop.plant || crop.id}`);
                        continue;
                    }

                    const kgPerUnit = resolveUnitToKgPerUnit(crop, comp.unit);
                    if (!Number.isFinite(kgPerUnit)) {                                // NEW
                        pushWarn(warns, `CSA component skipped (unknown unit "${comp.unit}") for ${crop.plant || crop.id}`); // NEW
                        continue;                                                     // NEW
                    }                                                                  // NEW

                    const everyN = Math.max(1, Number(comp.everyNWeeks) || 1);
                    const from = comp.start || csa.start;
                    const to = comp.end || csa.end;

                    if (!hasYmd(from) || !hasYmd(to)) {                                // NEW
                        pushWarn(warns, `CSA component skipped (missing dates) for ${crop.plant || crop.id}`); // NEW
                        continue;                                                     // NEW
                    }                                                                  // NEW

                    const i0 = weekIndexForDate(weeks, from);
                    const i1 = weekIndexForDate(weeks, to);
                    if (i0 < 0 || i1 < 0) continue;

                    const a = Math.min(i0, i1), b = Math.max(i0, i1);
                    const arr = ensureCropArrays(crop.id);

                    for (let i = a; i <= b; i++) {
                        const rel = i - a;
                        if (rel % everyN !== 0) continue;
                        arr.target[i] += boxes * qty * kgPerUnit;
                    }
                }
            }
        }

        // supply estimate (plannedPlants)
        for (const crop of crops) {
            if (!crop || !crop.id) continue;

            const plannedPlants = Number(crop.plannedPlants);
            const kgPerPlant = Number(crop.kgPerPlant);
            if (!Number.isFinite(plannedPlants) || plannedPlants <= 0) continue;

            if (!Number.isFinite(kgPerPlant) || kgPerPlant <= 0) {                    // NEW
                pushWarn(warns, `Supply skipped (kg/plant missing) for ${crop.plant || crop.id}`); // NEW
                continue;                                                             // NEW
            }                                                                          // NEW

            if (!hasYmd(crop.harvestStart) || !hasYmd(crop.harvestEnd)) {              // NEW
                pushWarn(warns, `Supply skipped (harvest window missing) for ${crop.plant || crop.id}`); // NEW
                continue;                                                             // NEW
            }                                                                          // NEW

            const i0 = weekIndexForDate(weeks, crop.harvestStart);
            const i1 = weekIndexForDate(weeks, crop.harvestEnd);
            if (i0 < 0 || i1 < 0) continue;

            const a = Math.min(i0, i1), b = Math.max(i0, i1);
            const countWeeks = b - a + 1;
            if (countWeeks <= 0) continue;

            const totalKg = plannedPlants * kgPerPlant;
            const kgPerWeek = totalKg / countWeeks;
            const arr = ensureCropArrays(crop.id);
            for (let i = a; i <= b; i++) arr.supply[i] += kgPerWeek;
        }

        // totals
        for (const [, v] of perCrop.entries()) {
            for (let i = 0; i < n; i++) {
                targetTotal[i] += v.target[i];
                supplyTotal[i] += v.supply[i];
            }
        }

        return { weeks, targetTotal, supplyTotal, perCrop };
    }

    function computePlanCropTotals(plan, weekly) {
        const crops = (plan && plan.crops) ? plan.crops : [];
        const out = [];
        for (const crop of crops) {
            if (!crop || !crop.id) continue;
            const v = weekly.perCrop.get(crop.id);
            const targetKg = v ? v.target.reduce((a, b) => a + b, 0) : 0;
            const supplyKg = v ? v.supply.reduce((a, b) => a + b, 0) : 0;
            const kgPerPlant = Number(crop.kgPerPlant);
            const plantsReq = (Number.isFinite(kgPerPlant) && kgPerPlant > 0) ? (targetKg / kgPerPlant) : NaN;
            out.push({ crop, targetKg, supplyKg, plantsReq });
        }
        return out;
    }


    function validatePlan(plan) {                                                    // NEW
        const errs = [];
        const crops = plan.crops || [];

        for (const c of crops) {
            if (!c.id) errs.push("Crop missing id.");
            if (!c.plantId) errs.push(`Crop "${c.plant || c.id}" missing plantId.`);
            if (!Number.isFinite(Number(c.kgPerPlant)) || Number(c.kgPerPlant) <= 0) {
                errs.push(`Crop "${c.plant || c.id}" missing valid kg/plant.`);
            }
            // packages must resolve
            for (const p of (c.packages || [])) {
                const kg = resolveUnitToKgPerUnit(c, p.unit);
                if (!Number.isFinite(kg)) errs.push(`Crop "${c.plant || c.id}" package unit "${p.unit}" does not resolve to kg.`);
            }
            // market lines must have valid dates + unit
            for (const mkt of (c.market || [])) {
                if (!hasYmd(mkt.from) || !hasYmd(mkt.to)) errs.push(`Crop "${c.plant || c.id}" market line missing dates.`);
                const kg = resolveUnitToKgPerUnit(c, mkt.unit);
                if (!Number.isFinite(kg)) errs.push(`Crop "${c.plant || c.id}" market unit "${mkt.unit}" does not resolve to kg.`);
            }
        }

        if (plan.csa && plan.csa.enabled) {
            if (!Number.isFinite(Number(plan.csa.boxesPerWeek)) || Number(plan.csa.boxesPerWeek) <= 0) {
                errs.push("CSA enabled but boxes/week is not set.");
            }
            for (const comp of (plan.csa.components || [])) {
                const crop = findCrop(plan, comp.cropId);
                if (!crop) { errs.push("CSA component references missing crop."); continue; }
                if (!hasYmd(comp.start) || !hasYmd(comp.end)) errs.push(`CSA component for "${crop.plant || crop.id}" missing dates.`);
                const kg = resolveUnitToKgPerUnit(crop, comp.unit);
                if (!Number.isFinite(kg)) errs.push(`CSA component for "${crop.plant || crop.id}" unit "${comp.unit}" does not resolve to kg.`);
            }
        }

        return errs;
    }                                                                                // NEW


    // -------------------- Modal UI (row-based MVP) --------------------
    let planModalEl = null;

    function closePlanModal() {
        if (planModalEl) { planModalEl.remove(); planModalEl = null; }
        if (__harvestSuggestedHandler) {                                              // NEW
            window.removeEventListener("usl:harvestWindowsSuggested", __harvestSuggestedHandler); // NEW
            __harvestSuggestedHandler = null;                                         // NEW
        }                                                                             // NEW
    }

    function uid(prefix) {
        return prefix + "_" + Math.random().toString(36).slice(2, 10);
    }

    function clampInt(n, defVal) {
        const x = Number(n);
        return Number.isFinite(x) ? Math.max(0, Math.trunc(x)) : defVal;
    }

    function clampNum(n, defVal) {
        const x = Number(n);
        return Number.isFinite(x) ? x : defVal;
    }

    function clampNonNegInt(n, defVal) {                         // NEW
        const x = Number(n);
        if (!Number.isFinite(x)) return defVal;
        return Math.max(0, Math.trunc(x));
    }                                                            // NEW

    function clampNonNegNum(n, defVal) {                         // NEW
        const x = Number(n);
        if (!Number.isFinite(x)) return defVal;
        return Math.max(0, x);
    }                                                            // NEW


    function downloadJson(filename, obj) {
        const txt = JSON.stringify(obj, null, 2);
        const blob = new Blob([txt], { type: "application/json;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    function drawPlanChart(canvas, weekly, seriesTarget, seriesSupply) {             // CHANGE
        const ctx = canvas.getContext("2d");                                         // NEW
        if (!ctx) return;                                                           // NEW
        const t = seriesTarget || weekly.targetTotal || [];                          // CHANGE
        const s = seriesSupply || weekly.supplyTotal || [];

        const n = Math.max(t.length, s.length);
        if (n === 0) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }

        const maxV = Math.max(1, ...t, ...s);
        const w = canvas.width, h = canvas.height;
        const padL = 40, padR = 10, padT = 10, padB = 24;

        ctx.clearRect(0, 0, w, h);

        ctx.strokeStyle = "#999";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padL, padT);
        ctx.lineTo(padL, h - padB);
        ctx.lineTo(w - padR, h - padB);
        ctx.stroke();

        function x(i) { return padL + (i * (w - padL - padR) / Math.max(1, n - 1)); }
        function y(v) {
            const frac = v / maxV;
            return (h - padB) - frac * (h - padT - padB);
        }

        ctx.strokeStyle = "#000";
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
            const v = t[i] || 0;
            if (i === 0) ctx.moveTo(x(i), y(v)); else ctx.lineTo(x(i), y(v));
        }
        ctx.stroke();
        ctx.fillStyle = "#000";
        ctx.fillText("Target", padL + 6, padT + 12);

        ctx.strokeStyle = "#555";
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
            const v = s[i] || 0;
            if (i === 0) ctx.moveTo(x(i), y(v)); else ctx.lineTo(x(i), y(v));
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "#555";
        ctx.fillText("Supply", padL + 60, padT + 12);
    }

    function renderPlanTotals(hostEl, plan, weekly) {
        if (!hostEl) return;
        const rows = computePlanCropTotals(plan, weekly);
        const esc = (v) => mxUtils.htmlEntities(String(v ?? ""));
        const fmt = (n) => Number.isFinite(n) ? n.toFixed(1) : "—";

        const EPS = 0.0001; // NEW: tolerance to avoid tiny float noise

        const trs = rows.map(r => {
            const name =
                `${r.crop.plant || ""}${r.crop.variety ? " — " + r.crop.variety : ""}`.trim() || r.crop.id;

            const target = Number(r.targetKg);                                         // NEW
            const supply = Number(r.supplyKg);                                         // NEW
            const hasTarget = Number.isFinite(target);                                 // NEW
            const hasSupply = Number.isFinite(supply);                                 // NEW

            const shortKg = (hasTarget && hasSupply) ? Math.max(0, target - supply) : NaN;   // NEW
            const surplusKg = (hasTarget && hasSupply) ? Math.max(0, supply - target) : NaN; // NEW

            // Supply is only meaningful if the user set plannedPlants (your current model) // NEW
            const hasPlanned = Number.isFinite(Number(r.crop.plannedPlants)) && Number(r.crop.plannedPlants) > 0; // NEW

            let flag = "EST";                                                          // NEW
            if (hasPlanned && hasTarget && hasSupply) {                                // NEW
                if (shortKg > EPS) flag = "SHORT";                                     // NEW
                else if (surplusKg > EPS) flag = "SURPLUS";                            // NEW
                else flag = "OK";                                                      // NEW
            }                                                                          // NEW

            return `<tr>
                <td style="border:1px solid #ddd;padding:4px;white-space:nowrap;">${esc(name)}</td>
                <td style="border:1px solid #ddd;padding:4px;text-align:right;">${fmt(target)}</td>
                <td style="border:1px solid #ddd;padding:4px;text-align:right;">${fmt(supply)}</td>
                <td style="border:1px solid #ddd;padding:4px;text-align:right;">${fmt(shortKg)}</td>     <!-- NEW -->
                <td style="border:1px solid #ddd;padding:4px;text-align:right;">${fmt(surplusKg)}</td>   <!-- NEW -->
                <td style="border:1px solid #ddd;padding:4px;text-align:right;">${fmt(r.plantsReq)}</td>
                <td style="border:1px solid #ddd;padding:4px;text-align:center;">${esc(flag)}</td>
            </tr>`;
        }).join("");

        hostEl.innerHTML = `
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr>
                <th style="border:1px solid #ddd;padding:4px;text-align:left;">Crop</th>
                <th style="border:1px solid #ddd;padding:4px;text-align:right;">Target kg</th>
                <th style="border:1px solid #ddd;padding:4px;text-align:right;">Supply kg</th>
                <th style="border:1px solid #ddd;padding:4px;text-align:right;">Short kg</th>     <!-- NEW -->
                <th style="border:1px solid #ddd;padding:4px;text-align:right;">Surplus kg</th>   <!-- NEW -->
                <th style="border:1px solid #ddd;padding:4px;text-align:right;">Plants req</th>
                <th style="border:1px solid #ddd;padding:4px;text-align:center;">Flag</th>
              </tr>
            </thead>
            <tbody>${trs || `<tr><td colspan="7" style="border:1px solid #ddd;padding:6px;">No crops.</td></tr>`}</tbody> <!-- CHANGE -->
          </table>
        `.trim();
    }

    function openPlanModal(moduleCell, year) {
        closePlanModal();

        let currentYear = year;

        const existing = loadPlanForYear(moduleCell, year);
        const plan = existing || {
            version: 1,
            year: year,
            weekStartDow: 1,
            crops: [],
            csa: { enabled: false, boxesPerWeek: 0, start: "", end: "", components: [] }
        };

        plan.year = currentYear;
        if (!Number.isFinite(plan.weekStartDow)) plan.weekStartDow = 1;                    // NEW
        if (!Array.isArray(plan.crops)) plan.crops = [];                                   // NEW
        if (!plan.csa || typeof plan.csa !== "object") {                                   // NEW
            plan.csa = { enabled: false, boxesPerWeek: 0, start: "", end: "", components: [] }; // NEW
        }                                                                                  // NEW
        if (!Array.isArray(plan.csa.components)) plan.csa.components = [];                 // NEW


        const wrap = document.createElement("div");
        wrap.style.position = "fixed";
        wrap.style.left = "0";
        wrap.style.top = "0";
        wrap.style.right = "0";
        wrap.style.bottom = "0";
        wrap.style.zIndex = "9999";
        wrap.style.background = "rgba(0,0,0,0.35)";
        wrap.style.display = "flex";
        wrap.style.alignItems = "center";
        wrap.style.justifyContent = "center";

        const card = document.createElement("div");
        card.style.width = "980px";
        card.style.maxWidth = "96vw";
        card.style.maxHeight = "92vh";
        card.style.background = "#fff";
        card.style.border = "1px solid #777";
        card.style.borderRadius = "10px";
        card.style.boxShadow = "0 10px 30px rgba(0,0,0,0.25)";
        card.style.display = "flex";
        card.style.flexDirection = "column";
        card.style.overflow = "hidden";

        const head = document.createElement("div");
        head.style.padding = "10px 12px";
        head.style.borderBottom = "1px solid #ddd";
        head.style.display = "flex";
        head.style.alignItems = "center";
        head.style.justifyContent = "space-between";

        const btnBar = document.createElement("div");
        btnBar.style.display = "flex";
        btnBar.style.gap = "8px";

        const titleEl = document.createElement("div");                                  // NEW
        titleEl.style.fontFamily = "Arial";                                             // NEW
        titleEl.style.fontWeight = "700";                                               // NEW
        titleEl.textContent = `Plan Year — ${currentYear}`;                                    // NEW

        head.innerHTML = "";                                                            // CHANGE
        head.appendChild(titleEl);                                                      // NEW
        head.appendChild(btnBar);                                                       // NEW

        const mkBtn = (label) => {
            const b = document.createElement("button");
            b.textContent = label;
            b.style.border = "1px solid #777";
            b.style.borderRadius = "6px";
            b.style.background = "#fff";
            b.style.cursor = "pointer";
            b.style.padding = "6px 10px";
            b.style.fontFamily = "Arial";
            b.style.fontSize = "12px";
            return b;
        };

        const saveBtn = mkBtn("Save");
        const exportBtn = mkBtn("Export JSON");
        const resetBtn = mkBtn(existing ? "Reset" : "Clear");
        const closeBtn = mkBtn("Close");

        btnBar.appendChild(saveBtn);
        btnBar.appendChild(exportBtn);
        btnBar.appendChild(resetBtn);
        btnBar.appendChild(closeBtn);
        head.appendChild(btnBar);

        const reloadPlantsBtn = mkBtn("Reload plants");                                    // NEW
        btnBar.insertBefore(reloadPlantsBtn, saveBtn);

        const body = document.createElement("div");
        body.style.padding = "12px";
        body.style.overflow = "auto";
        body.style.fontFamily = "Arial";
        body.style.fontSize = "12px";

        // UI skeleton (same as your current row-based MVP) -------------------
        const globalRow = document.createElement("div");                                // NEW
        globalRow.style.display = "flex";                                               // NEW
        globalRow.style.flexWrap = "wrap";                                              // NEW
        globalRow.style.gap = "10px";                                                   // NEW
        globalRow.style.alignItems = "center";                                          // NEW
        globalRow.style.marginBottom = "10px";                                          // NEW

        const yearInput = mkInput("number", year, 90);                                  // NEW
        yearInput.min = "1900"; yearInput.max = "3000";                                 // NEW

        const templateSel = document.createElement("select");                           // NEW
        templateSel.style.padding = "6px";                                              // NEW
        templateSel.style.border = "1px solid #bbb";                                    // NEW
        templateSel.style.borderRadius = "6px";                                         // NEW
        templateSel.style.minWidth = "220px";                                           // NEW

        const applyTemplateBtn = mkBtn("Apply template");                               // NEW
        const saveTemplateBtn = mkBtn("Save as template");                              // NEW
        const deleteTemplateBtn = mkBtn("Delete template");                             // NEW

        const cropFilterSel = document.createElement("select");                         // NEW
        cropFilterSel.style.padding = "6px";                                            // NEW
        cropFilterSel.style.border = "1px solid #bbb";                                  // NEW
        cropFilterSel.style.borderRadius = "6px";                                       // NEW
        cropFilterSel.style.minWidth = "260px";                                         // NEW

        globalRow.appendChild(document.createTextNode("Year"));                          // NEW
        globalRow.appendChild(yearInput);                                                // NEW
        globalRow.appendChild(document.createTextNode("Template"));                      // NEW
        globalRow.appendChild(templateSel);                                              // NEW
        globalRow.appendChild(applyTemplateBtn);                                         // NEW
        globalRow.appendChild(saveTemplateBtn);                                          // NEW
        globalRow.appendChild(deleteTemplateBtn);                                         // NEW

        refreshTemplateDropdown();                                                       // NEW
        refreshCropFilterDropdown();

        const topRow = document.createElement("div"); // NEW

        body.appendChild(globalRow);

        const plantSelect = document.createElement("select");
        plantSelect.style.flex = "1 1 auto";
        plantSelect.style.padding = "6px";
        plantSelect.style.border = "1px solid #bbb";
        plantSelect.style.borderRadius = "6px";

        const addCropBtn = mkBtn("Add crop");

        const msg = document.createElement("div");
        msg.style.color = "#555";
        msg.style.fontSize = "12px";
        msg.textContent = "Loading plants...";

        topRow.appendChild(plantSelect);
        topRow.appendChild(addCropBtn);
        topRow.appendChild(msg);

        const cropsBox = document.createElement("div");
        cropsBox.style.border = "1px solid #ddd";
        cropsBox.style.borderRadius = "8px";
        cropsBox.style.padding = "10px";
        cropsBox.style.marginBottom = "12px";

        const cropsTitle = document.createElement("div");
        cropsTitle.style.fontWeight = "700";
        cropsTitle.style.marginBottom = "8px";
        cropsTitle.textContent = "Crops";
        cropsBox.appendChild(cropsTitle);

        const cropsList = document.createElement("div");
        cropsList.style.display = "flex";
        cropsList.style.flexDirection = "column";
        cropsList.style.gap = "10px";
        cropsBox.appendChild(cropsList);

        const preview = document.createElement("div");
        preview.style.display = "grid";
        preview.style.gridTemplateColumns = "1fr 1fr";
        preview.style.gap = "12px";

        const chartBox = document.createElement("div");
        chartBox.style.border = "1px solid #ddd";
        chartBox.style.borderRadius = "8px";
        chartBox.style.padding = "8px";
        chartBox.innerHTML = `<div style="font-weight:700;margin-bottom:6px;">Weekly kg (Target vs Supply)</div>`;

        const chartControlsRow = document.createElement("div");                           // NEW
        chartControlsRow.style.display = "flex";                                          // NEW
        chartControlsRow.style.flexWrap = "wrap";                                         // NEW
        chartControlsRow.style.gap = "10px";                                              // NEW
        chartControlsRow.style.alignItems = "center";                                     // NEW
        chartControlsRow.style.marginBottom = "8px";                                      // NEW

        chartControlsRow.appendChild(document.createTextNode("Crop filter"));             // NEW
        chartControlsRow.appendChild(cropFilterSel);                                      // NEW

        chartBox.appendChild(chartControlsRow);                                           // NEW

        const canvas = document.createElement("canvas");
        canvas.width = 900;
        canvas.height = 220;
        canvas.style.width = "100%";
        canvas.style.height = "220px";
        chartBox.appendChild(canvas);


        const tableBox = document.createElement("div");
        tableBox.style.border = "1px solid #ddd";
        tableBox.style.borderRadius = "8px";
        tableBox.style.padding = "8px";
        tableBox.innerHTML = `<div style="font-weight:700;margin-bottom:6px;">Totals</div><div id="planTotals"></div>`;

        preview.appendChild(chartBox);
        preview.appendChild(tableBox);

        body.appendChild(topRow);

        const warnBox = document.createElement("div");                                     // NEW
        warnBox.style.border = "1px solid #f0c36d";                                        // NEW
        warnBox.style.background = "#fff8e1";                                              // NEW
        warnBox.style.borderRadius = "8px";                                                // NEW
        warnBox.style.padding = "8px";                                                     // NEW
        warnBox.style.marginBottom = "12px";                                               // NEW
        warnBox.style.display = "none";                                                    // NEW
        body.appendChild(warnBox);                                                         // NEW

        body.appendChild(cropsBox);
        body.appendChild(preview);

        card.appendChild(head);
        card.appendChild(body);
        wrap.appendChild(card);

        function mkInput(type, val, wPx) {                                                 // NEW
            const i = document.createElement("input");                                     // NEW
            i.type = type;                                                                 // NEW
            if (val != null) i.value = String(val);                                        // NEW
            i.style.padding = "5px 6px";                                                   // NEW
            i.style.border = "1px solid #bbb";                                             // NEW
            i.style.borderRadius = "6px";                                                  // NEW
            if (wPx) i.style.width = wPx + "px";                                           // NEW
            return i;                                                                      // NEW
        }                                                                                  // NEW

        function mkSelect(options, value, wPx) {                                           // NEW
            const s = document.createElement("select");                                    // NEW
            s.style.padding = "5px 6px";                                                   // NEW
            s.style.border = "1px solid #bbb";                                             // NEW
            s.style.borderRadius = "6px";                                                  // NEW
            if (wPx) s.style.width = wPx + "px";                                           // NEW
            for (const opt of options) {                                                   // NEW
                const o = document.createElement("option");                                // NEW
                o.value = String(opt.value);                                               // NEW
                o.textContent = String(opt.label);                                         // NEW
                s.appendChild(o);                                                          // NEW
            }                                                                              // NEW
            s.value = String(value ?? "");                                                 // NEW
            return s;                                                                      // NEW
        }                                                                                  // NEW

        function labelCrop(c) {                                                            // NEW
            const a = (c.plant || "").trim();                                              // NEW
            const b = (c.variety || "").trim();                                            // NEW
            return (a && b) ? `${a} — ${b}` : (a || b || c.id);                            // NEW
        }                                                                                  // NEW                                                                             // NEW

        function addDaysYmd(ymd, days) {                                                    // NEW
            const ms = parseYmdLocalToMs(ymd);
            if (!Number.isFinite(ms)) return null;
            return toIsoDateLocal(new Date(addDaysMs(ms, days)));
        }                                                                                   // NEW

        function subDaysYmd(ymd, days) {                                                // NEW
            return addDaysYmd(ymd, -Number(days || 0));                                  // NEW
        }                                                                                // NEW

        function getShelfDays(crop) {                                                    // NEW
            return Number.isFinite(Number(crop && crop.shelfLifeDays))                   // NEW
                ? Math.trunc(Number(crop.shelfLifeDays))                                 // NEW
                : 0;                                                                     // NEW
        }                                                                                // NEW

        function ensureMarketBaseTo(crop, mkt) {                                         // NEW
            if (!mkt) return;                                                            // NEW
            if (hasYmd(mkt.__baseTo)) return;                                            // NEW

            // Derive baseTo from current to when enabling sync.                          // NEW
            // If current to already looks like "harvestEnd + shelf", use harvestEnd.     // NEW
            const shelf = getShelfDays(crop);                                            // NEW
            const he = crop && crop.harvestEnd;                                          // NEW
            const availEnd = cropAvailEndYmd(crop);                                      // NEW

            if (hasYmd(he) && hasYmd(availEnd) && hasYmd(mkt.to) && String(mkt.to) === String(availEnd)) { // NEW
                mkt.__baseTo = String(he);                                               // NEW
            } else if (hasYmd(mkt.to)) {                                                 // NEW
                mkt.__baseTo = String(mkt.to);                                           // NEW
            } else if (hasYmd(he)) {                                                     // NEW
                mkt.__baseTo = String(he);                                               // NEW
            } else {                                                                      // NEW
                mkt.__baseTo = "";                                                       // NEW
            }                                                                             // NEW
        }                                                                                 // NEW

        function applyShelfToMarketTo(crop, mkt) {                                       // NEW
            if (!mkt) return;                                                            // NEW
            ensureMarketBaseTo(crop, mkt);                                               // NEW
            const shelf = getShelfDays(crop);                                            // NEW
            if (hasYmd(mkt.__baseTo)) {                                                  // NEW
                mkt.to = addDaysYmd(mkt.__baseTo, shelf) || mkt.to;                      // NEW
            }                                                                             // NEW
        }                                                                                 // NEW

        function removeShelfFromMarketTo(crop, mkt) {                                    // NEW
            if (!mkt) return;                                                            // NEW
            ensureMarketBaseTo(crop, mkt);                                               // NEW
            if (hasYmd(mkt.__baseTo)) mkt.to = String(mkt.__baseTo);                     // NEW
        }                                                                                 // NEW


        function cropAvailEndYmd(c) {                                                       // NEW
            if (!hasYmd(c.harvestEnd)) return null;                                         // NEW
            const shelf = Number.isFinite(Number(c.shelfLifeDays)) ? Number(c.shelfLifeDays) : 0; // NEW
            return addDaysYmd(c.harvestEnd, shelf) || c.harvestEnd;                         // NEW
        }                                                                                   // NEW

        function autoFillAndClampCsa(plan) {                                                 // NEW
            plan.csa = plan.csa || { enabled: false, boxesPerWeek: 0, start: "", end: "", components: [] }; // NEW
            if (!Array.isArray(plan.csa.components)) plan.csa.components = [];              // NEW

            // Auto-fill CSA start/end from crop windows if missing                          // NEW
            const crops = (plan.crops || []).filter(c => hasYmd(c.harvestStart) && hasYmd(c.harvestEnd)); // NEW
            if (crops.length) {                                                             // NEW
                const minStart = crops.reduce((a, c) => (a < c.harvestStart ? a : c.harvestStart), crops[0].harvestStart); // NEW
                const maxEnd = crops.reduce((a, c) => {                                     // NEW
                    const e = cropAvailEndYmd(c) || c.harvestEnd;                           // NEW
                    return (a > e ? a : e);                                                 // NEW
                }, cropAvailEndYmd(crops[0]) || crops[0].harvestEnd);                       // NEW

                if (!hasYmd(plan.csa.start)) plan.csa.start = minStart;                     // NEW
                if (!hasYmd(plan.csa.end)) plan.csa.end = maxEnd;                           // NEW
            }                                                                               // NEW

            // Clamp CSA component dates into crop availability (incl shelf life)            // NEW
            const byId = new Map((plan.crops || []).map(c => [c.id, c]));                   // NEW
            for (const comp of plan.csa.components) {                                       // NEW
                const crop = byId.get(comp.cropId);                                         // NEW
                if (!crop) continue;                                                       // NEW

                if (!hasYmd(comp.start) && hasYmd(plan.csa.start)) comp.start = plan.csa.start; // NEW
                if (!hasYmd(comp.end) && hasYmd(plan.csa.end)) comp.end = plan.csa.end;         // NEW

                if (hasYmd(crop.harvestStart) && hasYmd(comp.start) && comp.start < crop.harvestStart) comp.start = crop.harvestStart; // NEW
                const endMax = cropAvailEndYmd(crop);                                       // NEW
                if (endMax && hasYmd(comp.end) && comp.end > endMax) comp.end = endMax;    // NEW
            }                                                                               // NEW
        }                                                                                   // NEW

        function ymdMin(a, b) {                                                        // NEW
            if (!hasYmd(a)) return b;                                                   // NEW
            if (!hasYmd(b)) return a;                                                   // NEW
            return (a < b) ? a : b;                                                     // NEW
        }                                                                               // NEW

        function ymdMax(a, b) {                                                        // NEW
            if (!hasYmd(a)) return b;                                                   // NEW
            if (!hasYmd(b)) return a;                                                   // NEW
            return (a > b) ? a : b;                                                     // NEW
        }                                                                               // NEW

        function isBlankYmd(s) {                                                       // NEW
            return !hasYmd(s);                                                          // NEW
        }                                                                               // NEW

        function clampYmdIntoRange(v, lo, hi) {                                         // NEW
            if (!hasYmd(v) || (!hasYmd(lo) && !hasYmd(hi))) return v;                    // NEW
            let out = v;                                                                // NEW
            if (hasYmd(lo) && hasYmd(out) && out < lo) out = lo;                         // NEW
            if (hasYmd(hi) && hasYmd(out) && out > hi) out = hi;                         // NEW
            return out;                                                                 // NEW
        }                                                                               // NEW

        function shouldAutoReplaceDate(cur, lastAuto) {                                 // NEW
            // Replace only if blank or still equal to the last auto-set value           // NEW
            if (isBlankYmd(cur)) return true;                                           // NEW
            if (hasYmd(lastAuto) && cur === lastAuto) return true;                       // NEW
            return false;                                                               // NEW
        }                                                                               // NEW

        function syncCropDatesIfEnabled(crop, oldSnap) {                                // NEW
            if (!crop || !crop.syncDates) return;                                       // NEW
            const hs = crop.harvestStart;                                               // NEW
            const he = crop.harvestEnd;                                                 // NEW
            const availEnd = cropAvailEndYmd(crop);                                     // NEW
            const planCsa = plan && plan.csa ? plan.csa : null;                         // NEW

            // Initialize sync memory if absent                                          // NEW
            crop.__sync_lastHarvestStart = crop.__sync_lastHarvestStart ?? (oldSnap && oldSnap.hs) ?? ""; // NEW
            crop.__sync_lastHarvestEnd = crop.__sync_lastHarvestEnd ?? (oldSnap && oldSnap.he) ?? ""; // NEW
            crop.__sync_lastAvailEnd = crop.__sync_lastAvailEnd ?? (oldSnap && oldSnap.availEnd) ?? ""; // NEW

            // ---- Market lines ------------------------------------------------------  // NEW
            crop.market = crop.market || [];                                             // NEW
            for (const mkt of crop.market) {                                             // NEW
                if (!mkt) continue;                                                      // NEW

                // From: fill/clamp                                                     // NEW
                if (shouldAutoReplaceDate(mkt.from, crop.__sync_lastHarvestStart) && hasYmd(hs)) { // NEW
                    mkt.from = hs;                                                       // NEW
                }                                                                        // NEW
                mkt.from = clampYmdIntoRange(mkt.from, hs, availEnd);                     // NEW

                // To: fill/clamp (prefer availEnd when present)
                const lastAutoTo = crop.__sync_lastAvailEnd || crop.__sync_lastHarvestEnd;

                // NEW: if "to" is still exactly harvestEnd, treat it as auto and let it track shelf life
                const looksAutoHarvestEnd =
                    hasYmd(he) && hasYmd(mkt.to) && String(mkt.to) === String(he);

                if (shouldAutoReplaceDate(mkt.to, lastAutoTo) || looksAutoHarvestEnd) { // CHANGE
                    if (hasYmd(availEnd)) mkt.to = availEnd;
                    else if (hasYmd(he)) mkt.to = he;
                }

                mkt.to = clampYmdIntoRange(mkt.to, hs, availEnd);
                // NEW
            }                                                                            // NEW

            // ---- CSA components referencing this crop ------------------------------  // NEW
            if (planCsa && Array.isArray(planCsa.components)) {                          // NEW
                for (const comp of planCsa.components) {                                  // NEW
                    if (!comp || comp.cropId !== crop.id) continue;                       // NEW

                    // Start: fill/clamp                                                 // NEW
                    const csaStart = planCsa.start;                                       // NEW
                    const desiredStart = hasYmd(hs) ? ymdMax(hs, csaStart) : csaStart;    // NEW
                    if (shouldAutoReplaceDate(comp.start, crop.__sync_lastHarvestStart) && hasYmd(desiredStart)) { // NEW
                        comp.start = desiredStart;                                        // NEW
                    }                                                                    // NEW
                    comp.start = clampYmdIntoRange(comp.start, hs, availEnd);             // NEW

                    // End: fill/clamp                                                   // NEW
                    const csaEnd = planCsa.end;                                           // NEW
                    const desiredEnd = hasYmd(availEnd) ? ymdMin(availEnd, csaEnd) : (hasYmd(he) ? ymdMin(he, csaEnd) : csaEnd); // NEW
                    const lastAutoEnd = crop.__sync_lastAvailEnd || crop.__sync_lastHarvestEnd; // NEW
                    if (shouldAutoReplaceDate(comp.end, lastAutoEnd) && hasYmd(desiredEnd)) { // NEW
                        comp.end = desiredEnd;                                            // NEW
                    }                                                                    // NEW
                    comp.end = clampYmdIntoRange(comp.end, hs, availEnd);                 // NEW
                }                                                                         // NEW
            }                                                                             // NEW

            // Update sync memory after applying                                         // NEW
            crop.__sync_lastHarvestStart = hasYmd(hs) ? hs : crop.__sync_lastHarvestStart; // NEW
            crop.__sync_lastHarvestEnd = hasYmd(he) ? he : crop.__sync_lastHarvestEnd;   // NEW
            crop.__sync_lastAvailEnd = hasYmd(availEnd) ? availEnd : crop.__sync_lastAvailEnd; // NEW
        }                                                                               // NEW

        function snapshotMarketToBeforeSync(crop) {                                      // NEW
            if (!crop) return;                                                           // NEW
            crop.market = crop.market || [];                                              // NEW
            for (const mkt of crop.market) {                                              // NEW
                if (!mkt) continue;                                                       // NEW
                if (mkt.__preSyncTo === undefined) {                                      // NEW
                    mkt.__preSyncTo = String(mkt.to || "");                               // NEW
                }                                                                         // NEW
            }                                                                             // NEW
        }                                                                                 // NEW

        function restoreMarketToAfterUnsync(crop) {                                       // NEW
            if (!crop) return;                                                            // NEW
            crop.market = crop.market || [];                                              // NEW
            for (const mkt of crop.market) {                                              // NEW
                if (!mkt) continue;                                                       // NEW
                if (mkt.__preSyncTo !== undefined) {                                      // NEW
                    mkt.to = String(mkt.__preSyncTo || "");                               // NEW
                    delete mkt.__preSyncTo;                                               // NEW
                }                                                                         // NEW
            }                                                                             // NEW
        }                                                                                 // NEW


        // -------------------- Refresh helpers --------------------

        function refreshTemplateDropdown() {                                             // NEW
            templateSel.innerHTML = "";                                                  // NEW
            const o0 = document.createElement("option");                                 // NEW
            o0.value = ""; o0.textContent = "-- Select template --";                     // NEW
            templateSel.appendChild(o0);                                                 // NEW
            for (const name of listTemplateNames()) {                                    // NEW
                const o = document.createElement("option");                              // NEW
                o.value = name; o.textContent = name;                                    // NEW
                templateSel.appendChild(o);                                              // NEW
            }                                                                            // NEW
        }                                                                                // NEW

        function refreshCropFilterDropdown() {                                           // NEW
            cropFilterSel.innerHTML = "";                                                // NEW
            const o0 = document.createElement("option");                                 // NEW
            o0.value = ""; o0.textContent = "-- All crops --";                           // NEW
            cropFilterSel.appendChild(o0);                                               // NEW
            for (const c of (plan.crops || [])) {                                        // NEW
                const o = document.createElement("option");                              // NEW
                o.value = c.id; o.textContent = labelCrop(c);                            // NEW
                cropFilterSel.appendChild(o);                                            // NEW
            }                                                                            // NEW
            cropFilterSel.value = String(plan.cropFilterId || "");                       // NEW
        }


        function renderPreview() {                                                         // CHANGE
            autoFillAndClampCsa(plan);                                                     // SAME

            const warnings = [];                                                           // SAME
            const weekly = computePlanWeekly(plan, warnings);                              // SAME

            const cropId = String(plan.cropFilterId || "");                                // CHANGE

            if (cropId) {                                                                  // CHANGE
                const v = weekly.perCrop.get(cropId);                                      // CHANGE
                const t = v ? v.target : [];                                               // CHANGE
                const s = v ? v.supply : [];                                               // CHANGE
                drawPlanChart(canvas, weekly, t, s);                                       // CHANGE
            } else {                                                                       // CHANGE
                // Per-crop only: require a crop selection; fallback to totals so chart isn't blank
                drawPlanChart(canvas, weekly);                                             // CHANGE
                if (!warnings.includes("Select a crop to view the per-crop chart.")) {     // CHANGE
                    warnings.push("Select a crop to view the per-crop chart.");            // CHANGE
                }                                                                          // CHANGE
            }                                                                              // CHANGE

            renderPlanTotals(tableBox.querySelector("#planTotals"), plan, weekly);         // SAME

            if (warnings.length) {                                                         // SAME
                warnBox.style.display = "block";                                           // SAME
                warnBox.innerHTML =
                    `<div style="font-weight:700;margin-bottom:4px;">Warnings</div>` +     // SAME
                    warnings.map(w => `<div>• ${mxUtils.htmlEntities(w)}</div>`).join("");  // SAME
            } else {                                                                       // SAME
                warnBox.style.display = "none";                                            // SAME
                warnBox.innerHTML = "";                                                    // SAME
            }                                                                              // SAME
        }                                                                                  // CHANGE


        function showWarnings(list) {                                                      // NEW
            const msgs = Array.isArray(list) ? list.filter(Boolean) : [];                  // NEW
            if (msgs.length === 0) { warnBox.style.display = "none"; warnBox.innerHTML = ""; return; } // NEW
            warnBox.style.display = "block";                                               // NEW
            warnBox.innerHTML = `<div style="font-weight:700;margin-bottom:6px;">Warnings</div>` + // NEW
                `<ul style="margin:0 0 0 18px;padding:0;">${msgs.map(m => `<li>${mxUtils.htmlEntities(m)}</li>`).join("")}</ul>`; // NEW
        }                                                                                  // NEW        

        function renderCrops() {                                                           // CHANGE
            cropsList.innerHTML = "";                                                      // CHANGE
            const crops = plan.crops || [];                                                // CHANGE

            for (const crop of crops) {                                                    // NEW
                const panel = document.createElement("div");                               // NEW
                panel.style.border = "1px solid #eee";                                     // NEW
                panel.style.borderRadius = "8px";                                          // NEW
                panel.style.padding = "10px";                                              // NEW

                const header = document.createElement("div");                              // NEW
                header.style.display = "flex";                                             // NEW
                header.style.justifyContent = "space-between";                             // NEW
                header.style.alignItems = "center";                                        // NEW
                header.style.marginBottom = "8px";                                         // NEW

                const title = document.createElement("div");                               // NEW
                title.style.fontWeight = "700";                                            // NEW
                title.textContent = labelCrop(crop);                                       // NEW

                const delCrop = mkBtn("Remove crop");                                      // NEW
                header.appendChild(title);                                                 // NEW
                header.appendChild(delCrop);                                               // NEW

                // --- crop fields ------------------------------------------------------ // NEW
                const row = document.createElement("div");                                 // NEW
                row.style.display = "flex";                                                // NEW
                row.style.flexWrap = "wrap";                                               // NEW
                row.style.gap = "8px";                                                     // NEW
                row.style.alignItems = "center";                                           // NEW

                const variety = mkInput("text", crop.variety ?? "", 180);                  // NEW
                const kgpp = mkInput("number", crop.kgPerPlant ?? "", 110);                // NEW
                const hs = mkInput("date", crop.harvestStart ?? "", 150);                  // NEW
                const he = mkInput("date", crop.harvestEnd ?? "", 150);                    // NEW
                const shelf = mkInput("number", crop.shelfLifeDays ?? 0, 90);              // NEW
                const planned = mkInput("number", crop.plannedPlants ?? 0, 120);           // NEW

                const syncDatesCb = document.createElement("input");                     // NEW
                syncDatesCb.type = "checkbox";                                           // NEW
                syncDatesCb.checked = !!crop.syncDates;                                  // NEW

                const syncDatesLab = document.createElement("label");                    // NEW
                syncDatesLab.style.display = "flex";                                     // NEW
                syncDatesLab.style.alignItems = "center";                                // NEW
                syncDatesLab.style.gap = "6px";                                          // NEW
                syncDatesLab.appendChild(syncDatesCb);                                   // NEW
                syncDatesLab.appendChild(document.createTextNode("Sync dates"));         // NEW

                row.appendChild(document.createTextNode("Variety"));                       // NEW
                row.appendChild(variety);                                                  // NEW
                row.appendChild(document.createTextNode("kg/plant"));                      // NEW
                row.appendChild(kgpp);                                                     // NEW
                row.appendChild(document.createTextNode("Harvest"));                       // NEW
                row.appendChild(hs);                                                       // NEW
                row.appendChild(document.createTextNode("→"));                             // NEW
                row.appendChild(he);                                                       // NEW
                row.appendChild(document.createTextNode("Shelf (days)"));                  // NEW
                row.appendChild(shelf);                                                    // NEW
                row.appendChild(syncDatesLab);

                row.appendChild(document.createTextNode("Planned plants"));                // NEW
                row.appendChild(planned);                                                  // NEW

                // --- packages --------------------------------------------------------- // NEW
                const packsTitle = document.createElement("div");                          // NEW
                packsTitle.style.fontWeight = "700";                                       // NEW
                packsTitle.style.margin = "10px 0 6px";                                    // NEW
                packsTitle.textContent = "Packages (display units)";                       // NEW

                const saveDefRow = document.createElement("div");                               // NEW
                saveDefRow.style.display = "flex";                                              // NEW
                saveDefRow.style.alignItems = "center";                                         // NEW
                saveDefRow.style.gap = "8px";                                                   // NEW
                saveDefRow.style.marginBottom = "6px";                                          // NEW

                const saveDefCb = document.createElement("input");                              // NEW
                saveDefCb.type = "checkbox";                                                    // NEW
                saveDefCb.checked = !!crop.savePackagesAsDefault;                               // NEW

                const saveDefLab = document.createElement("label");                             // NEW
                saveDefLab.style.display = "flex";                                              // NEW
                saveDefLab.style.alignItems = "center";                                         // NEW
                saveDefLab.style.gap = "6px";                                                   // NEW
                saveDefLab.appendChild(saveDefCb);                                              // NEW
                saveDefLab.appendChild(document.createTextNode("Save as default for plant"));   // NEW

                saveDefRow.appendChild(saveDefLab);                                             // NEW
                panel.appendChild(saveDefRow);                                                  // NEW

                saveDefCb.addEventListener("change", () => {                                    // NEW
                    crop.savePackagesAsDefault = !!saveDefCb.checked;                            // NEW
                });                                                                             // NEW                

                const packsWrap = document.createElement("div");                           // NEW
                packsWrap.style.display = "flex";                                          // NEW
                packsWrap.style.flexDirection = "column";                                  // NEW
                packsWrap.style.gap = "6px";                                               // NEW

                const addPackBtn = mkBtn("Add package");                                   // NEW
                addPackBtn.style.marginTop = "6px";                                        // NEW

                function renderPacks() {                                                   // NEW
                    packsWrap.innerHTML = "";                                              // NEW
                    crop.packages = crop.packages || [];                                   // NEW
                    for (const p of crop.packages) {                                       // NEW
                        const line = document.createElement("div");                        // NEW
                        line.style.display = "flex";                                       // NEW
                        line.style.gap = "8px";                                            // NEW
                        line.style.alignItems = "center";                                  // NEW

                        const unit = mkInput("text", p.unit ?? "bunch", 90);               // NEW
                        const baseType = mkSelect(                                         // NEW
                            [{ value: "kg", label: "kg" }, { value: "plant", label: "plant" }], // NEW
                            p.baseType ?? "kg",                                            // NEW
                            90                                                            // NEW
                        );                                                                 // NEW
                        const baseQty = mkInput("number", p.baseQty ?? 1, 90);             // NEW
                        const price = mkInput("number", p.price ?? "", 90);                // NEW
                        const del = mkBtn("Remove");                                       // NEW

                        line.appendChild(document.createTextNode("1"));                    // NEW
                        line.appendChild(unit);                                            // NEW
                        line.appendChild(document.createTextNode("="));                    // NEW
                        line.appendChild(baseQty);                                         // NEW
                        line.appendChild(baseType);                                        // NEW
                        line.appendChild(document.createTextNode("Price"));                // NEW
                        line.appendChild(price);                                           // NEW
                        line.appendChild(del);                                             // NEW

                        unit.addEventListener("input", () => { p.unit = String(unit.value || ""); renderPreview(); }); // NEW
                        baseType.addEventListener("change", () => { p.baseType = String(baseType.value || "kg"); renderPreview(); }); // NEW
                        baseQty.addEventListener("input", () => {
                            p.baseQty = clampNonNegNum(baseQty.value, 1);                        // CHANGE
                            renderPreview();
                        });

                        price.addEventListener("input", () => {
                            p.price = clampNonNegNum(price.value, NaN);                          // CHANGE
                        });


                        del.addEventListener("click", (ev) => {                             // NEW
                            ev.preventDefault();                                           // NEW
                            crop.packages = crop.packages.filter(x => x !== p);            // NEW
                            renderPacks();                                                 // NEW
                            renderPreview();                                               // NEW
                        });                                                                // NEW

                        packsWrap.appendChild(line);                                       // NEW
                    }                                                                      // NEW
                }                                                                          // NEW

                syncDatesCb.addEventListener("change", () => {                            // CHANGE
                    crop.syncDates = !!syncDatesCb.checked;                               // SAME
                    crop.market = crop.market || [];                                      // NEW

                    if (crop.syncDates) {                                                 // NEW
                        for (const mkt of crop.market) applyShelfToMarketTo(crop, mkt);   // NEW
                        renderMarket();                                                   // NEW
                        renderCsaSection();                                               // SAME (if you still want CSA clamping) 
                    } else {                                                              // NEW
                        for (const mkt of crop.market) removeShelfFromMarketTo(crop, mkt);// NEW
                        renderMarket();                                                   // NEW
                    }                                                                     // NEW

                    renderPreview();                                                      // SAME
                });                                                                        // CHANGE


                addPackBtn.addEventListener("click", (ev) => {                             // NEW
                    ev.preventDefault();                                                   // NEW
                    crop.packages = crop.packages || [];                                   // NEW
                    crop.packages.push({ unit: "kg", baseType: "kg", baseQty: 1, price: NaN }); // NEW
                    renderPacks();                                                         // NEW
                    renderPreview();                                                       // NEW
                });                                                                        // NEW

                // --- market demand ---------------------------------------------------- // NEW
                const marketTitle = document.createElement("div");                         // NEW
                marketTitle.style.fontWeight = "700";                                      // NEW
                marketTitle.style.margin = "10px 0 6px";                                   // NEW
                marketTitle.textContent = "Market demand (per week)";                      // NEW

                const marketWrap = document.createElement("div");                          // NEW
                marketWrap.style.display = "flex";                                         // NEW
                marketWrap.style.flexDirection = "column";                                 // NEW
                marketWrap.style.gap = "6px";                                              // NEW

                const addMarketBtn = mkBtn("Add market line");                             // NEW
                addMarketBtn.style.marginTop = "6px";                                      // NEW

                function renderMarket() {                                                  // NEW
                    marketWrap.innerHTML = "";                                             // NEW
                    crop.market = crop.market || [];                                       // NEW
                    for (const mkt of crop.market) {                                       // NEW
                        const line = document.createElement("div");                        // NEW
                        line.style.display = "flex";                                       // NEW
                        line.style.gap = "8px";                                            // NEW
                        line.style.alignItems = "center";                                  // NEW

                        const qty = mkInput("number", mkt.qty ?? 0, 90);                   // NEW
                        const unit = mkInput("text", mkt.unit ?? "kg", 90);                // NEW
                        const from = mkInput("date", mkt.from ?? crop.harvestStart ?? "", 150); // NEW
                        const to = mkInput("date", mkt.to ?? crop.harvestEnd ?? "", 150);       // NEW
                        const del = mkBtn("Remove");                                       // NEW

                        line.appendChild(document.createTextNode("Target"));               // NEW
                        line.appendChild(qty);                                             // NEW
                        line.appendChild(unit);                                            // NEW
                        line.appendChild(document.createTextNode("From"));                 // NEW
                        line.appendChild(from);                                            // NEW
                        line.appendChild(document.createTextNode("To"));                   // NEW
                        line.appendChild(to);                                              // NEW
                        line.appendChild(del);                                             // NEW

                        qty.addEventListener("input", () => {
                            mkt.qty = clampNonNegNum(qty.value, 0);                              // CHANGE
                            renderPreview();
                        });
                        unit.addEventListener("input", () => { mkt.unit = String(unit.value || ""); renderPreview(); }); // NEW
                        from.addEventListener("change", () => { mkt.from = String(from.value || ""); renderPreview(); }); // NEW

                        to.addEventListener("change", () => {                              // CHANGE
                            const newTo = String(to.value || "");                          // NEW
                            mkt.to = newTo;                                                // SAME (but explicit) 

                            if (crop.syncDates) {                                          // NEW
                                // User edited the shelf-adjusted date -> update baseTo.   // NEW
                                const shelf = getShelfDays(crop);                          // NEW
                                mkt.__baseTo = subDaysYmd(newTo, shelf) || "";             // NEW
                            } else {                                                       // NEW
                                // Unsynced edit directly sets baseTo.                      // NEW
                                mkt.__baseTo = hasYmd(newTo) ? newTo : "";                 // NEW
                            }                                                              // NEW

                            renderPreview();                                               // SAME
                        });                                                                 // CHANGE

                        del.addEventListener("click", (ev) => {                             // NEW
                            ev.preventDefault();                                           // NEW
                            crop.market = crop.market.filter(x => x !== mkt);              // NEW
                            renderMarket();                                                // NEW
                            renderPreview();                                               // NEW
                        });                                                                // NEW

                        marketWrap.appendChild(line);                                      // NEW
                    }                                                                      // NEW
                }                                                                          // NEW

                addMarketBtn.addEventListener("click", (ev) => {                           // CHANGE
                    ev.preventDefault();                                                   // SAME
                    crop.market = crop.market || [];                                       // SAME

                    const nl = { qty: 0, unit: "kg", from: crop.harvestStart || "", to: crop.harvestEnd || "" }; // CHANGE
                    nl.__baseTo = String(nl.to || "");                                                           // NEW
                    if (crop.syncDates) applyShelfToMarketTo(crop, nl);                                          // NEW
                    crop.market.push(nl);                                                                         // CHANGE

                    renderMarket();                                                        // SAME
                    renderPreview();                                                       // SAME
                });                                                                        // CHANGE

                // events for crop fields ------------------------------------------------ // NEW
                variety.addEventListener("input", () => { crop.variety = String(variety.value || ""); title.textContent = labelCrop(crop); renderPreview(); }); // NEW
                kgpp.addEventListener("input", () => {
                    crop.kgPerPlant = clampNonNegNum(kgpp.value, NaN);                   // CHANGE
                    renderPreview();
                });

                hs.addEventListener("change", () => {                                     // CHANGE
                    const snap = {                                                        // NEW
                        hs: crop.harvestStart, he: crop.harvestEnd, availEnd: cropAvailEndYmd(crop) // NEW
                    };                                                                    // NEW
                    crop.harvestStart = String(hs.value || "");                           // CHANGE
                    syncCropDatesIfEnabled(crop, snap);                                   // NEW
                    renderCsaSection();                                            // NEW
                    renderMarket();                                                       // SAME
                    renderPreview();                                                      // SAME
                });                                                                       // CHANGE

                he.addEventListener("change", () => {                                     // CHANGE
                    const snap = {                                                        // NEW
                        hs: crop.harvestStart, he: crop.harvestEnd, availEnd: cropAvailEndYmd(crop) // NEW
                    };                                                                    // NEW
                    crop.harvestEnd = String(he.value || "");                             // CHANGE
                    syncCropDatesIfEnabled(crop, snap);                                   // NEW
                    renderCsaSection();                                            // NEW
                    renderMarket();                                                       // SAME
                    renderPreview();                                                      // SAME
                });                                                                       // CHANGE

                shelf.addEventListener("input", () => {
                    const snap = { hs: crop.harvestStart, he: crop.harvestEnd, availEnd: cropAvailEndYmd(crop) };
                    crop.shelfLifeDays = clampNonNegInt(shelf.value, 0);                 // CHANGE

                    if (crop.syncDates) {                                                        // NEW
                        for (const mkt of (crop.market || [])) applyShelfToMarketTo(crop, mkt);   // NEW
                        renderMarket();                                                           // NEW
                    }                                                                              // NEW

                    syncCropDatesIfEnabled(crop, snap);
                    renderMarket();                                                // NEW
                    renderCsaSection();                                            // NEW
                    renderPreview();
                });                                                                 // CHANGE

                planned.addEventListener("input", () => {
                    crop.plannedPlants = clampNonNegInt(planned.value, 0);               // CHANGE
                    renderPreview();
                }); // NEW

                delCrop.addEventListener("click", (ev) => {                                // NEW
                    ev.preventDefault();                                                   // NEW
                    plan.crops = (plan.crops || []).filter(x => x !== crop);               // NEW
                    if (plan.csa && Array.isArray(plan.csa.components)) {                  // NEW
                        plan.csa.components = plan.csa.components.filter(c => c.cropId !== crop.id); // NEW
                    }
                    refreshCropFilterDropdown();                                                                      // NEW
                    renderCrops();                                                         // NEW
                    renderCsaSection();                                                    // NEW
                    renderPreview();                                                       // NEW
                });                                                                        // NEW

                panel.appendChild(header);                                                 // NEW
                panel.appendChild(row);                                                    // NEW
                panel.appendChild(packsTitle);                                             // NEW
                panel.appendChild(packsWrap);                                              // NEW
                panel.appendChild(addPackBtn);                                             // NEW
                panel.appendChild(marketTitle);                                            // NEW
                panel.appendChild(marketWrap);                                             // NEW
                panel.appendChild(addMarketBtn);                                           // NEW

                cropsList.appendChild(panel);                                              // NEW
                renderPacks();                                                             // NEW
                renderMarket();                                                            // NEW
            }                                                                              // NEW
        }                                                                                  // CHANGE


        const csaBox = document.createElement("div");                                      // NEW
        csaBox.style.border = "1px solid #ddd";                                            // NEW
        csaBox.style.borderRadius = "8px";                                                 // NEW
        csaBox.style.padding = "10px";                                                     // NEW
        csaBox.style.marginBottom = "12px";                                                // NEW
        body.insertBefore(csaBox, preview);                                                // NEW

        function renderCsaSection() {                                                      // NEW
            csaBox.innerHTML = "";                                                         // NEW
            plan.csa = plan.csa || { enabled: false, boxesPerWeek: 0, start: "", end: "", components: [] }; // NEW

            const title = document.createElement("div");                                   // NEW
            title.style.fontWeight = "700";                                                // NEW
            title.style.marginBottom = "8px";                                              // NEW
            title.textContent = "CSA (optional)";                                          // NEW
            csaBox.appendChild(title);                                                     // NEW

            const row1 = document.createElement("div");                                    // NEW
            row1.style.display = "flex";                                                   // NEW
            row1.style.gap = "10px";                                                       // NEW
            row1.style.alignItems = "center";                                              // NEW
            row1.style.marginBottom = "8px";                                               // NEW

            const enabled = document.createElement("input");                               // NEW
            enabled.type = "checkbox";                                                     // NEW
            enabled.checked = !!plan.csa.enabled;                                          // NEW

            const enabledLab = document.createElement("label");                            // NEW
            enabledLab.textContent = "Enable CSA";                                         // NEW
            enabledLab.style.display = "flex";                                             // NEW
            enabledLab.style.alignItems = "center";                                        // NEW
            enabledLab.style.gap = "6px";                                                  // NEW
            enabledLab.appendChild(enabled);                                               // NEW

            const boxes = mkInput("number", plan.csa.boxesPerWeek ?? 0, 100);              // NEW
            const csaStart = mkInput("date", plan.csa.start ?? "", 150);                   // NEW
            const csaEnd = mkInput("date", plan.csa.end ?? "", 150);                       // NEW

            row1.appendChild(enabledLab);                                                  // NEW
            row1.appendChild(document.createTextNode("Boxes/week"));                       // NEW
            row1.appendChild(boxes);                                                       // NEW
            row1.appendChild(document.createTextNode("Start"));                            // NEW
            row1.appendChild(csaStart);                                                    // NEW
            row1.appendChild(document.createTextNode("End"));                              // NEW
            row1.appendChild(csaEnd);                                                      // NEW
            csaBox.appendChild(row1);                                                      // NEW

            const compsTitle = document.createElement("div");                              // NEW
            compsTitle.style.fontWeight = "700";                                           // NEW
            compsTitle.style.margin = "8px 0 6px";                                         // NEW
            compsTitle.textContent = "CSA components (per box)";                           // NEW
            csaBox.appendChild(compsTitle);                                                // NEW

            const compsWrap = document.createElement("div");                               // NEW
            compsWrap.style.display = "flex";                                              // NEW
            compsWrap.style.flexDirection = "column";                                      // NEW
            compsWrap.style.gap = "6px";                                                   // NEW
            csaBox.appendChild(compsWrap);                                                 // NEW

            const addCompBtn = mkBtn("Add component");                                     // NEW
            addCompBtn.style.marginTop = "8px";                                            // NEW
            csaBox.appendChild(addCompBtn);                                                // NEW

            function syncPlanCsa() {
                plan.csa.enabled = !!enabled.checked;
                plan.csa.boxesPerWeek = clampNonNegInt(boxes.value, 0);              // CHANGE
                plan.csa.start = String(csaStart.value || "");
                plan.csa.end = String(csaEnd.value || "");
                renderPreview();
            }

            enabled.addEventListener("change", syncPlanCsa);                               // NEW
            boxes.addEventListener("input", syncPlanCsa);                                  // NEW
            csaStart.addEventListener("change", syncPlanCsa);                              // NEW
            csaEnd.addEventListener("change", syncPlanCsa);

            function renderComponents() {                                                  // NEW
                compsWrap.innerHTML = "";                                                  // NEW
                plan.csa.components = plan.csa.components || [];                           // NEW

                for (const comp of plan.csa.components) {                                  // NEW
                    const line = document.createElement("div");                            // NEW
                    line.style.display = "flex";                                           // NEW
                    line.style.gap = "8px";                                                // NEW
                    line.style.alignItems = "center";                                      // NEW

                    const cropSel = mkSelect(                                              // NEW
                        (plan.crops || []).map(c => ({ value: c.id, label: labelCrop(c) })), // NEW
                        comp.cropId || "",                                                 // NEW
                        260                                                               // NEW
                    );                                                                     // NEW
                    const qty = mkInput("number", comp.qty ?? 1, 70);                      // NEW
                    const unit = mkInput("text", comp.unit ?? "kg", 90);                   // NEW
                    const everyN = mkInput("number", comp.everyNWeeks ?? 1, 80);           // NEW
                    const st = mkInput("date", comp.start ?? (plan.csa.start || ""), 150); // NEW
                    const en = mkInput("date", comp.end ?? (plan.csa.end || ""), 150);     // NEW
                    const del = mkBtn("Remove");                                           // NEW

                    line.appendChild(document.createTextNode("Crop"));                     // NEW
                    line.appendChild(cropSel);                                             // NEW
                    line.appendChild(document.createTextNode("Qty"));                      // NEW
                    line.appendChild(qty);                                                 // NEW
                    line.appendChild(unit);                                                // NEW
                    line.appendChild(document.createTextNode("Every"));                    // NEW
                    line.appendChild(everyN);                                              // NEW
                    line.appendChild(document.createTextNode("weeks"));                    // NEW
                    line.appendChild(st);                                                  // NEW
                    line.appendChild(en);                                                  // NEW
                    line.appendChild(del);                                                 // NEW

                    cropSel.addEventListener("change", () => { comp.cropId = String(cropSel.value || ""); renderPreview(); }); // NEW
                    qty.addEventListener("input", () => {
                        comp.qty = clampNonNegNum(qty.value, 0);                             // CHANGE
                        renderPreview();
                    });
                    unit.addEventListener("input", () => { comp.unit = String(unit.value || ""); renderPreview(); }); // NEW
                    everyN.addEventListener("input", () => {
                        comp.everyNWeeks = Math.max(1, clampNonNegInt(everyN.value, 1));     // CHANGE (still enforces >=1)
                        renderPreview();
                    });
                    st.addEventListener("change", () => { comp.start = String(st.value || ""); renderPreview(); }); // NEW
                    en.addEventListener("change", () => { comp.end = String(en.value || ""); renderPreview(); }); // NEW

                    del.addEventListener("click", (ev) => {                                 // NEW
                        ev.preventDefault();                                               // NEW
                        plan.csa.components = plan.csa.components.filter(x => x !== comp); // NEW
                        renderComponents();                                                // NEW
                        renderPreview();                                                   // NEW
                    });                                                                    // NEW

                    compsWrap.appendChild(line);                                           // NEW
                }                                                                          // NEW
            }                                                                              // NEW

            addCompBtn.addEventListener("click", (ev) => {                                 // NEW
                ev.preventDefault();                                                       // NEW
                plan.csa.components = plan.csa.components || [];                           // NEW
                plan.csa.components.push({                                                 // NEW
                    cropId: (plan.crops && plan.crops[0]) ? plan.crops[0].id : "",         // NEW
                    qty: 1, unit: "kg", everyNWeeks: 1, start: plan.csa.start || "", end: plan.csa.end || "" // NEW
                });                                                                        // NEW
                renderComponents();                                                        // NEW
                renderPreview();                                                           // NEW
            });                                                                            // NEW

            renderComponents();                                                            // NEW
        }                                                                                  // NEW


        async function initPlantsDropdown() {
            try {
                const plants = await getPlantsBasicCached();
                plantSelect.innerHTML = "";
                const opt0 = document.createElement("option");
                opt0.value = ""; opt0.textContent = "-- Select plant --";
                plantSelect.appendChild(opt0);

                for (const p of plants) {
                    const o = document.createElement("option");
                    o.value = String(p.plant_id);
                    o.textContent = String(p.plant_name);
                    plantSelect.appendChild(o);
                }
                msg.textContent = "";
            } catch (e) {
                msg.textContent = String(e && e.message ? e.message : e);
            }
        }

        reloadPlantsBtn.addEventListener("click", async (ev) => {                          // NEW
            ev.preventDefault();                                                           // NEW
            __plantsBasicCache = null;                                                     // NEW
            await initPlantsDropdown();                                                    // NEW
        });                                                                                // NEW

        addCropBtn.addEventListener("click", async (ev) => {
            ev.preventDefault();
            const plantId = String(plantSelect.value || "").trim();
            if (!plantId) return;

            const plants = await getPlantsBasicCached();
            const p = plants.find(x => String(x.plant_id) === plantId);
            if (!p) return;

            const defaults = getDefaultsForPlant(p.plant_id);                               // NEW
            const initialPackages = (defaults && defaults.length) ? deepClone(defaults) : [{ unit: "kg", baseType: "kg", baseQty: 1, price: NaN }]; // NEW

            const crop = {
                id: uid("crop"),
                plantId: String(p.plant_id),
                plant: String(p.plant_name),
                variety: "",
                harvestStart: "",
                harvestEnd: "",
                shelfLifeDays: 0,
                kgPerPlant: clampNum(p.yield_per_plant_kg, NaN),
                plannedPlants: 0,
                packages: initialPackages,
                market: []
            };

            plan.crops = plan.crops || [];
            plan.crops.push(crop);
            refreshCropFilterDropdown(); // NEW

            const USL_DEBUG_HARVEST_WINDOWS = true;


            function emitHarvestWindowsNeeded(moduleCell, year, cropsReq) {
                if (USL_DEBUG_HARVEST_WINDOWS) {
                    console.groupCollapsed('[USL][YearPlanner] emit usl:harvestWindowsNeeded');
                    console.log('moduleCellId:', moduleCell.getId ? moduleCell.getId() : moduleCell.id);
                    console.log('year:', year);
                    console.log('cropsReq:', JSON.parse(JSON.stringify(cropsReq)));
                    console.groupEnd();
                }

                try {
                    window.dispatchEvent(new CustomEvent("usl:harvestWindowsNeeded", {
                        detail: {
                            moduleCellId: moduleCell.getId ? moduleCell.getId() : moduleCell.id,
                            year,
                            crops: cropsReq
                        }
                    }));
                } catch (e) {
                    console.error('[USL][YearPlanner] Failed to dispatch usl:harvestWindowsNeeded', e);
                }
            }
            // NEW            

            // after plan.crops.push(crop);
            emitHarvestWindowsNeeded(moduleCell, year, [{
                cropId: crop.id,
                plantId: crop.plantId,
                varietyId: crop.varietyId ?? null,
                method: crop.method ?? null,
                yieldTargetKg: 0
            }]);

            renderCrops();
            renderCsaSection();   // ADD
            renderPreview();
        });


        yearInput.addEventListener("change", () => {                                      // CHANGE
            const newYear = Number(yearInput.value);
            if (!Number.isFinite(newYear) || newYear < 1900 || newYear > 3000) return;

            savePlanForYear(moduleCell, currentYear, plan);                               // CHANGE

            currentYear = newYear;                                                       // CHANGE
            const loaded = loadPlanForYear(moduleCell, currentYear);

            const nextPlan = loaded || {
                version: 1,
                year: currentYear,
                weekStartDow: 1,
                crops: [],
                csa: { enabled: false, boxesPerWeek: 0, start: "", end: "", components: [] }
            };

            Object.keys(plan).forEach(k => delete plan[k]);                               // CHANGE
            Object.assign(plan, nextPlan);                                                // CHANGE
            plan.year = currentYear;                                                     // CHANGE

            titleEl.textContent = `Plan Year — ${currentYear}`;                           // CHANGE

            refreshCropFilterDropdown();                                                 // CHANGE
            renderCrops();                                                               // CHANGE
            renderCsaSection();                                                          // CHANGE
            renderPreview();                                                             // CHANGE
        });                                                                              // CHANGE

        cropFilterSel.addEventListener("change", () => {                                 // NEW
            plan.cropFilterId = String(cropFilterSel.value || "");                       // NEW
            renderPreview();                                                             // NEW
        });                                                                              // NEW


        applyTemplateBtn.addEventListener("click", () => {                               // CHANGE
            const name = String(templateSel.value || "").trim();                         // CHANGE
            if (!name) return;                                                           // CHANGE
            const t = loadTemplateByName(name);                                          // CHANGE
            if (!t) return;                                                              // CHANGE

            const applied = rekeyTemplateToPlan(t, currentYear);                         // CHANGE

            Object.keys(plan).forEach(k => delete plan[k]);                              // CHANGE
            Object.assign(plan, applied);                                                // CHANGE
            plan.year = currentYear;                                                     // CHANGE (bind)

            refreshCropFilterDropdown();                                                 // CHANGE
            renderCrops();                                                               // CHANGE
            renderCsaSection();                                                          // CHANGE
            renderPreview();                                                             // CHANGE
        });                                                                              // CHANGE

        saveTemplateBtn.addEventListener("click", () => {                                // NEW
            const name = prompt("Template name?");                                       // NEW
            const key = String(name || "").trim();                                       // NEW
            if (!key) return;                                                            // NEW
            // Store template without module binding, but keep crop IDs as-is in template
            const t = deepClone(plan) || {};                                             // NEW
            t.year = null;                                                               // NEW (template is year-agnostic)
            saveTemplateByName(key, t);                                                  // NEW
            refreshTemplateDropdown();                                                   // NEW
            templateSel.value = key;                                                     // NEW
        });                                                                              // NEW

        deleteTemplateBtn.addEventListener("click", () => {                              // NEW
            const name = String(templateSel.value || "").trim();                         // NEW
            if (!name) return;                                                           // NEW
            deleteTemplateByName(name);                                                  // NEW
            refreshTemplateDropdown();                                                   // NEW
        });                                                                              // NEW


        saveBtn.addEventListener("click", (ev) => {
            ev.preventDefault();

            const errs = validatePlan(plan);                                            // NEW
            if (errs.length) { showWarnings(errs); return; }                             // NEW

            // persist unit defaults
            for (const c of (plan.crops || [])) {                                       // NEW
                if (c && c.savePackagesAsDefault && c.plantId && Array.isArray(c.packages)) {
                    saveDefaultsForPlant(c.plantId, c.packages);                        // NEW
                }
            }

            savePlanForYear(moduleCell, currentYear, plan);
        });


        exportBtn.addEventListener("click", (ev) => {
            ev.preventDefault();
            const safeName = String(getCellAttr(moduleCell, "label", "garden"))
                .replace(/[^\w\-]+/g, "_").slice(0, 60);
            downloadJson(`${safeName}_${currentYear}_plan.json`, plan);                  // CHANGE
        });

        resetBtn.addEventListener("click", (ev) => {
            ev.preventDefault();
            deletePlanForYear(moduleCell, currentYear);
            plan.version = 1;
            plan.year = currentYear;                                                     // CHANGE
            plan.weekStartDow = 1;
            plan.crops = [];
            plan.csa = { enabled: false, boxesPerWeek: 0, start: "", end: "", components: [] };
            renderCrops();
            renderCsaSection();
            renderPreview();
        });


        closeBtn.addEventListener("click", (ev) => {
            ev.preventDefault();
            closePlanModal();
        });

        wrap.addEventListener("click", (ev) => {
            if (ev.target === wrap) closePlanModal();
        });

        document.body.appendChild(wrap);
        planModalEl = wrap;


        function applyHarvestSuggestionsToPlan(plan, results) {                             // NEW
            if (!plan || !Array.isArray(plan.crops)) return;
            const byId = new Map(plan.crops.map(c => [c.id, c]));

            // Update crops
            for (const r of (results || [])) {
                const crop = byId.get(r.cropId);
                if (!crop) continue;

                if (!hasYmd(crop.harvestStart) && hasYmd(r.harvestStart)) crop.harvestStart = r.harvestStart;
                if (!hasYmd(crop.harvestEnd) && hasYmd(r.harvestEnd)) crop.harvestEnd = r.harvestEnd;

                // Only fill shelf life if currently empty/0 and scheduler gave one
                if ((!Number.isFinite(Number(crop.shelfLifeDays)) || Number(crop.shelfLifeDays) <= 0) &&
                    Number.isFinite(Number(r.shelfLifeDays)) && Number(r.shelfLifeDays) > 0) {
                    crop.shelfLifeDays = Math.trunc(Number(r.shelfLifeDays));
                }
            }

            // CSA auto-fill:
            // - if plan.csa.start/end missing, set to min/max across crops (availability end includes shelf life)
            plan.csa = plan.csa || { enabled: false, boxesPerWeek: 0, start: "", end: "", components: [] };
            const cropsWithWindows = plan.crops.filter(c => hasYmd(c.harvestStart) && hasYmd(c.harvestEnd));

            if (cropsWithWindows.length) {
                const minStart = cropsWithWindows.reduce((a, c) => (a < c.harvestStart ? a : c.harvestStart), cropsWithWindows[0].harvestStart);
                const maxAvailEnd = cropsWithWindows.reduce((a, c) => {
                    const shelf = Number.isFinite(Number(c.shelfLifeDays)) ? Number(c.shelfLifeDays) : 0;
                    const availEnd = addDaysYmd(c.harvestEnd, shelf) || c.harvestEnd;
                    return (a > availEnd ? a : availEnd);
                }, addDaysYmd(cropsWithWindows[0].harvestEnd, Number(cropsWithWindows[0].shelfLifeDays) || 0) || cropsWithWindows[0].harvestEnd);

                if (!hasYmd(plan.csa.start)) plan.csa.start = minStart;
                if (!hasYmd(plan.csa.end)) plan.csa.end = maxAvailEnd;
            }

            // Fill CSA component start/end if missing; clamp to crop availability (end includes shelf life)
            if (Array.isArray(plan.csa.components)) {
                for (const comp of plan.csa.components) {
                    const crop = byId.get(comp.cropId);
                    const csaStart = plan.csa.start;
                    const csaEnd = plan.csa.end;

                    if (!hasYmd(comp.start) && hasYmd(csaStart)) comp.start = csaStart;
                    if (!hasYmd(comp.end) && hasYmd(csaEnd)) comp.end = csaEnd;

                    if (crop && hasYmd(crop.harvestStart) && hasYmd(crop.harvestEnd)) {
                        const shelf = Number.isFinite(Number(crop.shelfLifeDays)) ? Number(crop.shelfLifeDays) : 0;
                        const cropAvailEnd = addDaysYmd(crop.harvestEnd, shelf) || crop.harvestEnd;

                        // clamp
                        if (hasYmd(comp.start) && comp.start < crop.harvestStart) comp.start = crop.harvestStart;
                        if (hasYmd(comp.end) && comp.end > cropAvailEnd) comp.end = cropAvailEnd;
                    }
                }
            }
        }                                                                                   // NEW

        function onHarvestWindowsSuggested(ev) {                                             // NEW
            const d = ev && ev.detail ? ev.detail : null;
            if (!d) return;

            const moduleCellId = String(d.moduleCellId || "").trim();
            const year = Number(d.year);
            if (!moduleCellId || !Number.isFinite(year)) return;

            // If your modal is open, you have `plan` in closure.
            // Apply to the current open plan only if it matches the year and module.
            if (String(moduleCell.getId ? moduleCell.getId() : moduleCell.id) !== moduleCellId) return;
            if (Number(plan.year) !== year) return;

            applyHarvestSuggestionsToPlan(plan, d.results || []);
            renderCrops();
            renderCsaSection();
            renderPreview();
        }                                                                                   // NEW

        if (__harvestSuggestedHandler) {                                                  // NEW
            window.removeEventListener("usl:harvestWindowsSuggested", __harvestSuggestedHandler); // NEW
        }
        __harvestSuggestedHandler = onHarvestWindowsSuggested;                            // NEW
        window.addEventListener("usl:harvestWindowsSuggested", __harvestSuggestedHandler); // NEW

        initPlantsDropdown();                                                       // CHANGE 
        renderCrops();                                                                    // CHANGE
        renderCsaSection();                                                               // NEW
        renderPreview();                                                                  // CHANGE




    }

    // -------------------- Event listener --------------------
    function onPlanYearRequested(ev) {
        const d = ev && ev.detail ? ev.detail : null;
        if (!d) return;

        const moduleCellId = String(d.moduleCellId || "").trim();
        const year = Number(d.year);

        if (!moduleCellId) return;
        if (!Number.isFinite(year) || year < 1900 || year > 3000) return;

        const moduleCell = model.getCell(moduleCellId);
        if (!moduleCell) return;

        openPlanModal(moduleCell, year);
    }

    window.addEventListener("usl:planYearRequested", onPlanYearRequested);
});
