// USL Draw.io Plugin: Plant Scheduling (GDD-based, class-refactor)
//
// - Right-click tiler group -> "Set schedule…"
// - Fetches plant/city from SQLite via window.dbBridge
// - Computes schedule, plants, timelines, and writes attrs
//
// Key changes in this version:
//  * Class-based encapsulation: PlantModel, CityClimate, PolicyFlags, ScheduleInputs
//  * Overwinter-aware feasibility & scanning
//  * Yield multipliers computed over HARVEST window
//  * UI keeps the same behavior (manual/auto dates, min fi filter, preview)
//
// ---------------------------------------------------------------------------------------------

Draw.loadPlugin(function (ui) {
    const graph = ui.editor && ui.editor.graph;
    if (!graph) return;

    console.log("[Scheduler] file instance:", "Planting_Scheduler.js", "STAMP=2026-01-25Txx:yy");

    // -------------------- Logging ---------------------------------------------------------
    function log() { try { mxLog.debug.apply(mxLog, ["[USL-Schedule]"].concat([].slice.call(arguments))); } catch (_) {/*noop*/ } }

    // -------------------- Small utils (dates, math) --------------------------------------
    function daysInMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }
    function addDaysUTC(d, days) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days)); }
    function asUTCDate(y, m, d) { return new Date(Date.UTC(y, m - 1, d)); }
    function dateLTE(d1, d2) {
        return d1.getUTCFullYear() < d2.getUTCFullYear() ||
            (d1.getUTCFullYear() === d2.getUTCFullYear() && (
                d1.getUTCMonth() < d2.getUTCMonth() ||
                (d1.getUTCMonth() === d2.getUTCMonth() && d1.getUTCDate() <= d2.getUTCDate())
            ));
    }
    function fmtISO(d) { return d ? d.toISOString().slice(0, 10) : ''; }
    function iso(d) { return d ? d.toISOString().slice(0, 10) : null; }
    function shiftDays(isoStr, days) {
        if (!isoStr) return null;
        const d = new Date(isoStr + 'T00:00:00Z');
        d.setUTCDate(d.getUTCDate() + days);
        return iso(d);
    }

    function dayOfYear(d) {
        const start = Date.UTC(d.getUTCFullYear(), 0, 1);
        const ms = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - start;
        return Math.floor(ms / 86400000) + 1;
    }
    function pickFrostByRisk(city, risk = 'p50') {
        // fallbacks: specific percentile → pX → plain
        if (risk === 'p90' && Number.isFinite(Number(city.last_spring_frost_p90_doy))) return Number(city.last_spring_frost_p90_doy);
        if (risk === 'p50' && Number.isFinite(Number(city.last_spring_frost_p50_doy))) return Number(city.last_spring_frost_p50_doy);
        if (risk === 'p10' && Number.isFinite(Number(city.last_spring_frost_p10_doy))) return Number(city.last_spring_frost_p10_doy);
        if (Number.isFinite(Number(city.last_spring_frost_doy))) return Number(city.last_spring_frost_doy);
        // worst-case: mid-April DOY=105 (safe-ish default for many temperate zones)
        return 105;
    }

    let __dbPathCached = null;

    async function getDbPath() {
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


    // -------------------- DB helpers (open → query → close) ------------------------------
    async function queryAll(sql, params) {
        if (!window.dbBridge || typeof window.dbBridge.open !== 'function') {
            throw new Error('dbBridge not available; check preload/main wiring');
        }
        const dbPath = await getDbPath();
        const opened = await window.dbBridge.open(dbPath, { readOnly: true });
        try {
            const res = await window.dbBridge.query(opened.dbId, sql, params);
            return Array.isArray(res?.rows) ? res.rows : [];
        } finally {
            try { await window.dbBridge.close(opened.dbId); } catch (_) { }
        }
    }

    async function execAll(sql, params) {
        if (!window.dbBridge || typeof window.dbBridge.open !== 'function') {
            throw new Error('dbBridge not available; check preload/main wiring');
        }

        const dbPath = await getDbPath();
        const opened = await window.dbBridge.open(dbPath, { readOnly: false });

        try {
            if (typeof window.dbBridge.exec === 'function') {
                await window.dbBridge.exec(opened.dbId, sql, params || []);
            } else if (typeof window.dbBridge.run === 'function') {
                await window.dbBridge.run(opened.dbId, sql, params || []);
            } else {
                throw new Error('dbBridge.exec/run not available');
            }
        } finally {
            try { await window.dbBridge.close(opened.dbId); } catch (_) { }
        }
    }


    // -------------------- Models ----------------------------------------------------------
    class PlantModel {
        constructor(row) {
            Object.assign(this, row);
            this.annual = Number(this.annual ?? 0);
            this.biennial = Number(this.biennial ?? 0);
            this.perennial = Number(this.perennial ?? 0);
            this.lifespan_years = Number(this.lifespan_years ?? NaN); // may be null/NaN
            this.overwinter_ok = Number(this.overwinter_ok ?? 0);
        }
        isAnnual() { return this.annual === 1; }
        isBiennial() { return this.biennial === 1; }
        isPerennial() { return this.perennial === 1; }

        // In PlantModel constructor (no change needed; Object.assign handles it)
        // Optional helpers:
        startCoolingThresholdC() {
            return asCoolingThresholdC(this.start_cooling_threshold_c);
        }
        hasCoolingTrigger() {
            return asCoolingThresholdC(this.start_cooling_threshold_c) != null;
        }


        static async loadByName(name) {
            const sql = `
          SELECT *,
                 COALESCE(direct_sow,0) AS direct_sow,
                 COALESCE(transplant,0) AS transplant,
                 COALESCE(overwinter_ok,0) AS overwinter_ok
          FROM Plants
          WHERE plant_name = ?
          LIMIT 1;`;
            const rows = await queryAll(sql, [name]);
            return rows[0] ? new PlantModel(rows[0]) : null;
        }

        static async loadById(id) {
            const sql = `
          SELECT *,
                 COALESCE(direct_sow,0) AS direct_sow,
                 COALESCE(transplant,0) AS transplant,
                 COALESCE(overwinter_ok,0) AS overwinter_ok
          FROM Plants
          WHERE plant_id = ?;`;
            const rows = await queryAll(sql, [id]);
            return rows[0] ? new PlantModel(rows[0]) : null;
        }

        static async listBasic() {
            const sql = `
          SELECT plant_id, plant_name, abbr, yield_per_plant_kg, gdd_to_maturity,
                 tmin_c, topt_low_c, topt_high_c, tmax_c, tbase_c,
                 harvest_window_days, days_maturity, days_transplant, days_germ,
                 direct_sow, transplant, overwinter_ok, start_cooling_threshold_c,
                 soil_temp_min_plant_c, annual, biennial, perennial, lifespan_years, veg_diameter_cm, spacing_cm                                                                  
          FROM Plants
          WHERE abbr IS NOT NULL
          ORDER BY plant_name;`;
            const rows = await queryAll(sql, []);
            return rows.map(r => new PlantModel(r));
        }

        allowedMethods() {
            const m = [];
            if (this.direct_sow === 1) m.push('direct_sow');
            if (this.transplant === 1) {
                m.push('transplant_indoor');   // trays/indoors → field later
                m.push('transplant_outdoor');  // field date is the “start”
            }
            if (!m.length) m.push('transplant_indoor'); // conservative fallback
            return m;
        }


        gddRequired() {
            const a = Number(this.gdd_to_maturity);
            if (Number.isFinite(a) && a > 0) return a;
            const b = Number(this.days_maturity);
            if (Number.isFinite(b) && b > 0) return b;
            throw new Error(`Plant "${this.plant_name}": requires gdd_to_maturity or days_maturity in DB.`);
        }



        defaultHW() {
            return (this.harvest_window_days != null)
                ? Number(this.harvest_window_days)
                : null;
        }

        cropTempEnvelope() {
            const Tbase = Number(this.tbase_c ?? 10);
            return {
                Tmin: Number(this.tmin_c ?? 0),
                ToptLow: Number(this.topt_low_c ?? (Tbase + 6)),
                ToptHigh: Number(this.topt_high_c ?? (Tbase + 14)),
                Tmax: Number(this.tmax_c ?? (Tbase + 24)),
                Tbase
            };
        }

        yieldPerPlant() {
            return Number(this.yield_per_plant_kg ?? 0.25);
        }

        // Amount UNTIL FIRST HARVEST, with units
        firstHarvestBudget() {
            const days = Number(this.days_maturity);
            const gdd = Number(this.gdd_to_maturity);

            const isTruePerennial = this.isPerennial() && !(Number(this.overwinter_ok) === 1 && this.isAnnual());

            // True perennials: prefer explicit days
            if (isTruePerennial && Number.isFinite(days) && days > 0)
                return { mode: 'days', amount: days };

            // Overwintered annuals (e.g., garlic): prefer GDD if present
            if (Number(this.overwinter_ok) === 1 && Number.isFinite(gdd) && gdd > 0)
                return { mode: 'gdd', amount: gdd };

            // Otherwise: prefer GDD, else days
            if (Number.isFinite(gdd) && gdd > 0) return { mode: 'gdd', amount: gdd };
            if (Number.isFinite(days) && days > 0) return { mode: 'days', amount: days };

            throw new Error(`Plant "${this.plant_name}": needs gdd_to_maturity or days_maturity.`);
        }

        static async create(patch) {
            const cols = [];
            const qs = [];
            const vals = [];
            for (const [k, v] of Object.entries(patch || {})) {
                cols.push(k);
                qs.push('?');
                vals.push(v);
            }
            if (!cols.length) throw new Error('No fields to create plant.');

            const sql = `INSERT INTO Plants (${cols.join(', ')}) VALUES (${qs.join(', ')});`;
            await execAll(sql, vals);

            // Return the created row (SQLite: last_insert_rowid)                              
            const rows = await queryAll(`SELECT * FROM Plants WHERE plant_id = last_insert_rowid();`, []);
            return rows[0] ? new PlantModel(rows[0]) : null;
        }

        static async update(plantId, patch) {
            const id = Number(plantId);
            if (!Number.isFinite(id)) throw new Error('Invalid plantId');

            const sets = [];
            const vals = [];
            for (const [k, v] of Object.entries(patch || {})) {
                sets.push(`${k} = ?`);
                vals.push(v);
            }
            if (!sets.length) return await PlantModel.loadById(id);

            vals.push(id);
            const sql = `UPDATE Plants SET ${sets.join(', ')} WHERE plant_id = ?;`;
            await execAll(sql, vals);

            return await PlantModel.loadById(id);
        }
    }


    class TaskTemplateModel {
        static async ensureTables() {
            const sql1 = `
                CREATE TABLE IF NOT EXISTS PlantTaskTemplates (
                  plant_id      INTEGER NOT NULL,                                  
                  method        TEXT    NOT NULL,                                  
                  template_json TEXT    NOT NULL,                                  
                  updated_at    TEXT    NOT NULL,                                  
                  PRIMARY KEY (plant_id, method)
                );`;
            const sql2 = `
                CREATE TABLE IF NOT EXISTS VarietyTaskTemplates (
                  variety_id    INTEGER NOT NULL,                                  
                  method        TEXT    NOT NULL,                                  
                  template_json TEXT    NOT NULL,                                  
                  updated_at    TEXT    NOT NULL,                                  
                  PRIMARY KEY (variety_id, method)
                );`;
            await execAll(sql1, []);
            await execAll(sql2, []);
        }

        static _safeParseTemplateRow(row) {
            if (!row) return null;
            try {
                const tpl = JSON.parse(row.template_json);
                return tpl && typeof tpl === 'object' ? tpl : null;
            } catch (_) {
                return null;
            }
        }

        static async loadPlantTemplate(plantId, method) {
            await this.ensureTables();
            const sql = `
                SELECT template_json                                                
                FROM PlantTaskTemplates
                WHERE plant_id = ? AND method = ?
                LIMIT 1;`;
            const rows = await queryAll(sql, [Number(plantId), String(method)]);
            return this._safeParseTemplateRow(rows[0] || null);
        }

        static async loadVarietyTemplate(varietyId, method) {
            await this.ensureTables();
            const sql = `
                SELECT template_json                                                
                FROM VarietyTaskTemplates
                WHERE variety_id = ? AND method = ?
                LIMIT 1;`;
            const rows = await queryAll(sql, [Number(varietyId), String(method)]);
            return this._safeParseTemplateRow(rows[0] || null);
        }

        static async savePlantTemplate(plantId, method, template) {
            await this.ensureTables();
            const json = JSON.stringify(template ?? {});
            const now = new Date().toISOString();
            const sql = `
                INSERT INTO PlantTaskTemplates (plant_id, method, template_json, updated_at)  
                VALUES (?, ?, ?, ?)
                ON CONFLICT(plant_id, method) DO UPDATE SET
                  template_json = excluded.template_json,                           
                  updated_at = excluded.updated_at;`;
            await execAll(sql, [Number(plantId), String(method), json, now]);
        }

        static async saveVarietyTemplate(varietyId, method, template) {
            await this.ensureTables();
            const json = JSON.stringify(template ?? {});
            const now = new Date().toISOString();
            const sql = `
                INSERT INTO VarietyTaskTemplates (variety_id, method, template_json, updated_at) 
                VALUES (?, ?, ?, ?)
                ON CONFLICT(variety_id, method) DO UPDATE SET
                  template_json = excluded.template_json,                          
                  updated_at = excluded.updated_at;`;
            await execAll(sql, [Number(varietyId), String(method), json, now]);
        }

        static async resolveFor({ plantId, varietyId, method }) {
            // 1) variety+method
            if (varietyId != null) {
                const v = await this.loadVarietyTemplate(varietyId, method);
                if (v) return v;
            }
            // 2) plant+method
            if (plantId != null) {
                const p = await this.loadPlantTemplate(plantId, method);
                if (p) return p;
            }
            // 3) code default
            return getDefaultTaskTemplateForMethod(method);
        }

        static async saveForSelection({ plantId, varietyId, method, template }) {
            // If variety selected -> variety template; else -> plant template
            if (varietyId != null) {
                return this.saveVarietyTemplate(varietyId, method, template);
            }
            return this.savePlantTemplate(plantId, method, template);
        }
    }


    // =====================================================================
    // PlantVarietyModel (JSON overrides)                                    
    // =====================================================================
    class PlantVarietyModel {
        constructor(row) {
            Object.assign(this, row);
            this.variety_id = Number(this.variety_id);
            this.plant_id = Number(this.plant_id);
        }

        static async ensureTable() {
            const sql = `
                    CREATE TABLE IF NOT EXISTS PlantVarieties (
                        variety_id     INTEGER PRIMARY KEY AUTOINCREMENT,
                        plant_id       INTEGER NOT NULL,
                        variety_name   TEXT NOT NULL,
                        overrides_json TEXT NOT NULL,
                        created_at     TEXT NOT NULL,
                        updated_at     TEXT NOT NULL
                    );`;
            await execAll(sql, []);

            await execAll(
                `CREATE INDEX IF NOT EXISTS idx_PlantVarieties_plant_id
                     ON PlantVarieties (plant_id);`,
                []
            );

            await execAll(
                `CREATE UNIQUE INDEX IF NOT EXISTS idx_PlantVarieties_unique
                     ON PlantVarieties (plant_id, variety_name);`,
                []
            );
        }

        static _parseOverrides(jsonStr) {
            if (jsonStr == null || jsonStr === '') return {};
            try {
                const o = JSON.parse(jsonStr);
                return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
            } catch (e) {
                console.warn('Bad overrides_json in PlantVarieties', e);
                return {};
            }
        }

        overridesObject() {
            return PlantVarietyModel._parseOverrides(this.overrides_json);
        }

        static async listByPlantId(plantId) {
            await this.ensureTable();
            const pid = Number(plantId);
            if (!Number.isFinite(pid)) return [];

            const sql = `
                    SELECT variety_id, plant_id, variety_name, overrides_json, created_at, updated_at
                    FROM PlantVarieties
                    WHERE plant_id = ?
                    ORDER BY variety_name COLLATE NOCASE;`;
            const rows = await queryAll(sql, [pid]);
            return rows.map(r => new PlantVarietyModel(r));
        }

        static async loadById(varietyId) {
            await this.ensureTable();
            const vid = Number(varietyId);
            if (!Number.isFinite(vid)) return null;

            const sql = `
                    SELECT variety_id, plant_id, variety_name, overrides_json, created_at, updated_at
                    FROM PlantVarieties
                    WHERE variety_id = ?
                    LIMIT 1;`;
            const rows = await queryAll(sql, [vid]);
            return rows[0] ? new PlantVarietyModel(rows[0]) : null;
        }

        static async create({ plantId, varietyName, overrides }) {
            await this.ensureTable();
            const pid = Number(plantId);
            if (!Number.isFinite(pid)) throw new Error('create: invalid plantId');

            const name = String(varietyName ?? '').trim();
            if (!name) throw new Error('create: varietyName is required');

            const obj = (overrides && typeof overrides === 'object') ? overrides : {};
            const json = JSON.stringify(obj);
            const now = new Date().toISOString();

            const sql = `
                    INSERT INTO PlantVarieties (plant_id, variety_name, overrides_json, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?);`;
            await execAll(sql, [pid, name, json, now, now]);

            // Return the created row (SQLite last_insert_rowid not exposed here)        
            const rows = await queryAll(
                `SELECT variety_id, plant_id, variety_name, overrides_json, created_at, updated_at
                     FROM PlantVarieties
                     WHERE plant_id = ? AND variety_name = ?
                     LIMIT 1;`,
                [pid, name]
            );
            return rows[0] ? new PlantVarietyModel(rows[0]) : null;
        }

        static async update({ varietyId, varietyName, overrides }) {
            await this.ensureTable();
            const vid = Number(varietyId);
            if (!Number.isFinite(vid)) throw new Error('update: invalid varietyId');

            const name = (varietyName == null) ? null : String(varietyName).trim();
            const json = (overrides == null) ? null : JSON.stringify(
                (overrides && typeof overrides === 'object') ? overrides : {}
            );
            const now = new Date().toISOString();

            // Build dynamic update: only set provided fields                            
            const sets = [];
            const params = [];
            if (name != null) { sets.push('variety_name = ?'); params.push(name); }
            if (json != null) { sets.push('overrides_json = ?'); params.push(json); }
            sets.push('updated_at = ?'); params.push(now);
            params.push(vid);

            const sql = `
                    UPDATE PlantVarieties
                    SET ${sets.join(', ')}
                    WHERE variety_id = ?;`;
            await execAll(sql, params);

            return await this.loadById(vid);
        }

        static async deleteById(varietyId) {
            await this.ensureTable();
            const vid = Number(varietyId);
            if (!Number.isFinite(vid)) return;
            const sql = `DELETE FROM PlantVarieties WHERE variety_id = ?;`;
            await execAll(sql, [vid]);
        }
    }

    // =====================================================================
    // helper to apply overrides to a base plant row          
    // =====================================================================
    function applyPlantOverrides(basePlantRow, overridesObj) {
        const out = Object.assign({}, basePlantRow || {});
        const o = (overridesObj && typeof overridesObj === 'object') ? overridesObj : {};
        Object.keys(o).forEach(k => { out[k] = o[k]; });
        return out;
    }


    class CityClimate {
        constructor(row) {
            Object.assign(this, row);
        }

        static async loadAll() {
            const sql = `SELECT * FROM Cities ORDER BY city_name;`;
            const rows = await queryAll(sql, []);
            return rows.map(r => new CityClimate(r));
        }

        static async loadByName(name) {
            const sql = `SELECT * FROM Cities WHERE city_name = ? LIMIT 1;`;
            const rows = await queryAll(sql, [name]);
            return rows[0] ? new CityClimate(rows[0]) : null;
        }

        monthlyHighs() {
            const out = {};
            for (let m = 1; m <= 12; m++) out[m] = this[`avg_monthly_high_c${m}`];
            return out;
        }

        monthlyLows() {
            const out = {};
            for (let m = 1; m <= 12; m++) out[m] = this[`avg_monthly_low_c${m}`];
            return out;
        }

        monthlyMeans() {
            const highs = this.monthlyHighs(), lows = this.monthlyLows();
            const out = {};
            for (let m = 1; m <= 12; m++) {
                const hi = highs[m], lo = lows[m];
                if (hi == null || lo == null) continue;
                out[m] = (Number(hi) + Number(lo)) / 2;
            }
            return out;
        }

        dailyRates(tbase, year) {
            const means = this.monthlyMeans();
            const gddMonthly = {};
            for (let m = 1; m <= 12; m++) {
                const Tm = means?.[m];
                const dim = daysInMonth(year, m);
                gddMonthly[m] = (Tm == null) ? 0 : Math.max(0, Tm - tbase) * dim;
            }
            const daily = {};
            for (let m = 1; m <= 12; m++) {
                const dim = daysInMonth(year, m);
                daily[m] = dim > 0 ? (gddMonthly[m] / dim) : 0;
            }
            return daily;
        }
    }


    class PolicyFlags {
        constructor({
            // spring frost gate
            useSpringFrostGate = true,          // default ON for non-overwinter crops
            springFrostRisk = 'p50',            // 'p90' | 'p50' | 'p10'

            // Soil gate
            useSoilTempGate = false,
            soilGateThresholdC = null,
            soilGateConsecutiveDays = 3,

            overwinterAllowed = false
        } = {}) {
            this.overwinterAllowed = !!overwinterAllowed;

            // Spring frost is disabled if overwinter is allowed
            this.useSpringFrostGate = !!useSpringFrostGate && !this.overwinterAllowed;
            this.springFrostRisk = springFrostRisk;

            const thr = Number(soilGateThresholdC);
            this.soilGateThresholdC = Number.isFinite(thr) ? thr : null;
            this.useSoilTempGate = !!useSoilTempGate && this.soilGateThresholdC != null;
            this.soilGateConsecutiveDays = Math.max(1, Number(soilGateConsecutiveDays ?? 3));
            Object.freeze(this);
        }

        static fromPlant(plant, method) {
            const raw = Number(plant.soil_temp_min_plant_c);
            const threshold = Number.isFinite(raw) ? raw : null;
            const soilGate = (method === 'direct_sow') && threshold != null;
            const overwinterAllowed = plant.isPerennial() || Number(plant.overwinter_ok ?? 0) === 1;

            return new PolicyFlags({
                rejectOutsideThermalWindow: true,
                // default spring frost ON when not overwintering
                useSpringFrostGate: !overwinterAllowed,
                springFrostRisk: 'p50',
                useSoilTempGate: soilGate,
                soilGateThresholdC: threshold,
                soilGateConsecutiveDays: 3,
                overwinterAllowed
            });
        }
    }



    class ScheduleInputs {
        constructor({ plant, city, method, startISO, seasonEndISO, policy, seasonStartYear, harvestWindowDays, varietyId = null, varietyName = '' }) {
            Object.assign(this, {
                plant, city, method, startISO, seasonEndISO, policy,
                seasonStartYear: Number(seasonStartYear),
                harvestWindowDays: (harvestWindowDays == null ? null : Number(harvestWindowDays)),
                varietyId: (varietyId != null ? Number(varietyId) : null),
                varietyName: String(varietyName || '')
            });
            Object.freeze(this);
        }

        derived() {
            const startDate = new Date(this.startISO + 'T00:00:00Z');
            const seasonEnd = new Date(this.seasonEndISO + 'T00:00:00Z');

            const env = this.plant.cropTempEnvelope();

            // Determine scan years strictly from DB (no implicit defaults):
            let scanYears = 1;
            if (this.plant.isPerennial()) {
                if (!Number.isFinite(this.plant.lifespan_years) || this.plant.lifespan_years < 1)
                    throw new Error('Perennial requires lifespan_years in DB.');
                scanYears = Math.floor(this.plant.lifespan_years);
            } else if (this.plant.isBiennial()) {
                // Expect 2+ years to finish; use lifespan_years if present, else block.
                if (!Number.isFinite(this.plant.lifespan_years) || this.plant.lifespan_years < 2)
                    throw new Error('Biennial requires lifespan_years ≥ 2 in DB (e.g., 2 for bulbils).');
                scanYears = Math.floor(this.plant.lifespan_years);
            } else {
                // Annuals: 1 season; if DB marks overwinter_ok=1 you may allow 2 seasons,
                // but ONLY if you also have an explicit DB maturity span that needs it.
                scanYears = 1 + (Number(this.plant.overwinter_ok) === 1 ? 1 : 0);
            }

            const scanStart = asUTCDate(this.seasonStartYear, 1, 1);
            const scanEndHard = asUTCDate(this.seasonStartYear + scanYears - 1, 12, 31);

            // Build thermals keyed to the first scan year only (monthly means are reused)
            const year = scanStart.getUTCFullYear();
            const dailyRates = this.city.dailyRates(env.Tbase, year);
            const monthlyAvg = this.city.monthlyMeans();

            return { startDate, seasonEnd, year, env, dailyRates, monthlyAvg, scanStart, scanEndHard };
        }
    }



    class Planner {
        constructor(inputs) {
            // Build the full, read-only context once
            const { plant, city, method, policy, varietyId, varietyName } = inputs;
            const { startDate, seasonEnd, env, dailyRates, monthlyAvg, scanStart, scanEndHard } = inputs.derived();
            const budget = plant.firstHarvestBudget();  // {mode, amount}

            const HW_DAYS = Number.isFinite(Number(inputs.harvestWindowDays))
                ? Number(inputs.harvestWindowDays)
                : (Number.isFinite(Number(plant.harvest_window_days)) ? Number(plant.harvest_window_days) : 7);

            // --- cooling gate (based on plant.start_cooling_threshold_c) ---
            const coolingThreshold = asCoolingThresholdC(plant.start_cooling_threshold_c);


            let coolingCross = null;
            if (coolingThreshold != null) {
                coolingCross = firstCoolingCrossingDate({
                    thresholdC: coolingThreshold,
                    monthlyAvgTemp: monthlyAvg,
                    scanStart,
                    scanEndHard
                });
            }


            this.ctx = Object.freeze({
                // invariants for the whole planning pass
                method,
                // cooling gate config
                useCoolingGate: coolingThreshold != null,
                coolingThresholdC: coolingThreshold,
                coolingCrossDate: coolingCross,   // first day gate opens (may be null)
                overwinterAllowed: policy.overwinterAllowed,
                useSoilTempGate: policy.useSoilTempGate,
                soilGateThresholdC: policy.soilGateThresholdC,
                soilGateConsecutiveDays: policy.soilGateConsecutiveDays,
                useSpringFrostGate: policy.useSpringFrostGate,
                springFrostRisk: policy.springFrostRisk,
                lastSpringFrostDOY: pickFrostByRisk(city, policy.springFrostRisk),
                plant,
                HW_DAYS,

                // crop & climate
                BUDGET: budget,                            // <-- add this
                env,                // {Tmin,ToptLow,ToptHigh,Tmax,Tbase}
                dailyRates,         // {1..12: gdd/day}
                monthlyAvg,         // {1..12: mean air temp}
                Tbase: env.Tbase,

                // season anchors
                startDate,
                seasonEnd,          // UI end
                scanStart,          // hard window start
                scanEndHard,        // hard window end
            });
        }

        // --- tiny accessors -----------------------------------------------------
        gddRateOn(d) { return (this.ctx.dailyRates[d.getUTCMonth() + 1] ?? 0); }
        addDays(d, k) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + k)); }
        withinWindow(d) { return d >= this.ctx.scanStart && d <= this.ctx.scanEndHard; }

        normalizeUtcMidnight(d) {
            return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
        }

        soilGateOK(startDate) {
            const { soilGateConsecutiveDays, soilGateThresholdC, monthlyAvg } = this.ctx;   //(optional)

            let cur = new Date(startDate);
            for (let i = 0; i < soilGateConsecutiveDays; i++) {
                // simple soil estimate using monthly mean w/ lag baked into policy option
                const lagged = this.addDays(cur, -10);
                const Tair = monthlyAvg[lagged.getUTCMonth() + 1] ?? 0;
                const Tsoil = 1 * Tair - 1;
                if (Tsoil < soilGateThresholdC) return false;
                cur = this.addDays(cur, 1);
            }
            return true;
        }


        // --- gate helpers as instance methods -----------------------------------
        checkSpringFrostGate(gateDate) {
            const C = this.ctx;
            if (!C.useSpringFrostGate || !gateDate) return { ok: true };
            const doy = dayOfYear(gateDate);
            if (doy < Number(C.lastSpringFrostDOY || 0)) {
                return { ok: false, reason: `spring_frost_gate(doy ${doy} < ${C.lastSpringFrostDOY})` };
            }
            return { ok: true };
        }

        checkCoolingGate(gateDate) {
            const C = this.ctx;
            if (!C.useCoolingGate || !gateDate) return { ok: true };
            if (!C.coolingCrossDate || gateDate < C.coolingCrossDate) {
                return { ok: false, reason: 'cooling_gate' };
            }
            return { ok: true };
        }

        checkSoilGate(sowDate) {
            const C = this.ctx;
            if (!C.useSoilTempGate || C.method !== 'direct_sow') return { ok: true };
            if (!this.soilGateOK(sowDate)) {
                return { ok: false, reason: 'soil_gate' };
            }
            return { ok: true };
        }


        isSowFeasible(sowDate) {
            const C = this.ctx;

            if (!this.withinWindow(sowDate)) return { ok: false, reason: 'outside_scan_window' };

            // --- compute transplant date (for transplant_* methods)
            let transplantDate = null;
            if (C.method === 'transplant_indoor' || C.method === 'transplant_outdoor') {
                const dTrans = Number(C.plant?.days_transplant ?? NaN);
                const daysTrans = Number.isFinite(dTrans) && dTrans > 0 ? Math.round(dTrans) : 0;
                transplantDate = this.addDays(sowDate, daysTrans);
            }

            const gateDate = (C.method === 'direct_sow') ? sowDate : transplantDate;

            // --- gates, in order
            const frost = this.checkSpringFrostGate(gateDate);
            if (!frost.ok) return frost;

            const cooling = this.checkCoolingGate(gateDate);
            if (!cooling.ok) return cooling;

            const soil = this.checkSoilGate(sowDate);
            if (!soil.ok) return soil;

            // --- GDD sufficiency
            if (C.BUDGET.mode === 'gdd') {
                const acc = accumulateGDDUntil(sowDate, C.BUDGET.amount, C.dailyRates, C.scanEndHard);
                if (!acc.reached) {
                    return { ok: false, reason: 'insufficient_gdd' };
                }
            }

            // --- maturity / harvest window (truncation logic as you wrote)
            const mat = maturityDateFromBudget(sowDate, C.BUDGET, C.dailyRates, C.scanEndHard);
            const fullHarvestEnd = this.addDays(mat, C.HW_DAYS);

            if (!C.overwinterAllowed && sowDate.getUTCFullYear() !== fullHarvestEnd.getUTCFullYear()) {
                return { ok: false, reason: 'cross_year_disallowed' };
            }

            const hardEnd = (C.seasonEnd && C.seasonEnd <= C.scanEndHard) ? C.seasonEnd : C.scanEndHard;

            const effectiveHarvestEnd = (fullHarvestEnd <= hardEnd)
                ? fullHarvestEnd
                : hardEnd;

            const MS_PER_DAY = 24 * 60 * 60 * 1000;
            const harvestSpanDays = Math.max(0, Math.round(
                (effectiveHarvestEnd.getTime() - mat.getTime()) / MS_PER_DAY
            ));

            const minHarvestDays = Math.min(C.HW_DAYS, 3);
            if (harvestSpanDays < minHarvestDays) {
                return { ok: false, reason: 'beyond_hard_end' };
            }

            const TmeanHarvest = weightedMeanTempOverRange(
                mat,
                effectiveHarvestEnd,
                C.monthlyAvg,
                C.dailyRates,
                C.Tbase
            );

            const { Tmin, Tmax } = C.env;
            if (TmeanHarvest < Tmin) return { ok: false, reason: `harvest_too_cold(${TmeanHarvest.toFixed(1)}<${Tmin})` };
            if (TmeanHarvest > Tmax) return { ok: false, reason: `harvest_too_hot(${TmeanHarvest.toFixed(1)}>${Tmax})` };

            const truncated = fullHarvestEnd.getTime() > effectiveHarvestEnd.getTime();
            return {
                ok: true,
                maturity: mat,
                harvestStart: mat,
                harvestEnd: effectiveHarvestEnd,
                truncated,
                TmeanHarvest
            };
        }

        findNextFeasible(startCandidate, maxDays = 366) {
            const startMs = Math.max(
                this.normalizeUtcMidnight(startCandidate).getTime(),
                this.normalizeUtcMidnight(this.ctx.scanStart).getTime()
            );
            let d = new Date(startMs);

            for (let i = 0; i <= maxDays && d <= this.ctx.scanEndHard; i++) {
                const feas = this.isSowFeasible(d);
                if (feas.ok) return { date: d, info: feas };
                d = this.addDays(d, 1);
            }
            return { date: null, info: null };
        }
    }

    // dialog helpers

    async function resolveEffectivePlant(plantId, varietyId) {
        const base = await PlantModel.loadById(Number(plantId));
        if (!base) return null;
        if (!varietyId) return base;

        const v = await PlantVarietyModel.loadById(Number(varietyId));
        if (!v) return base;

        const overrides = (typeof v.overridesObject === 'function')
            ? v.overridesObject()
            : {};

        const merged = applyPlantOverrides(toPlainDict(base), overrides);
        return new PlantModel(merged);
    }


    // -------------------- Centralized builder for schedule results (pure) -----------
    async function computeScheduleResult(inputs) {
        const { plant, method } = inputs;
        const { seasonEnd, env, dailyRates, monthlyAvg } = inputs.derived();

        const HW_DAYS = Number.isFinite(Number(inputs.harvestWindowDays)) ? Number(inputs.harvestWindowDays) : 0;
        const budget = plant.firstHarvestBudget();

        const schedule = buildPlantingSchedule(inputs); // CHANGE: canonical single planting
        const sow0 = schedule[0];

        if (!(sow0 instanceof Date) || Number.isNaN(sow0.getTime())) {
            return { rows: [], lastScheduledHarvestEndISO: null };
        }

        const stageDays = {
            maturityDays: (budget.mode === 'days') ? budget.amount : (Number(plant.days_maturity) || 0),
            transplantDays: Number.isFinite(Number(plant.days_transplant)) ? Number(plant.days_transplant) : 0,
            germinationDays: Number.isFinite(Number(plant.days_germ)) ? Number(plant.days_germ) : 0,
            harvest_window_days: HW_DAYS
        };

        const timelines = computeStageTimelineForSchedule({
            schedule, budget, stageDays, dailyRatesMap: dailyRates, seasonEnd
        });

        const multipliers = deriveYieldMultipliersFromTemp({
            schedule, budget, dailyRatesMap: dailyRates,
            cropTemp: env, monthlyAvgTemp: monthlyAvg,
            seasonEnd, Tbase: env.Tbase, window: 'harvest', HW_DAYS
        });

        const { plants: plantsAlloc } = distributePlantsToMeetTarget({
            N: 1, // CHANGE: explicitly 1
            yieldPerPlant: plant.yieldPerPlant(),
            multipliers: [Number.isFinite(multipliers[0]) ? multipliers[0] : 0]
        });

        const tl = timelines[0];
        if (!tl || !(tl.harvestEnd instanceof Date)) return { rows: [], lastScheduledHarvestEndISO: null };

        const row = {
            idx: 1,
            plant: plant.plant_name || (plant.abbr || '?'),
            method,
            sow: fmtISO(sow0),                         // CHANGE: sow0
            germ: fmtISO(tl.germ),
            trans: fmtISO(tl.transplant),
            harvStart: fmtISO(tl.harvestStart),
            harvEnd: fmtISO(tl.harvestEnd),
            mult: (Number.isFinite(multipliers[0]) ? multipliers[0].toFixed(3) : ''),
            plantsReq: (Array.isArray(plantsAlloc) ? plantsAlloc[0] : '')
        };

        return { rows: [row], lastScheduledHarvestEndISO: row.harvEnd };
    }



    async function resolveVarietyName(varietyId, varietyList) {
        if (!varietyId) return '';

        // Prefer UI-provided list (no DB round-trip)                                        
        const list = Array.isArray(varietyList) ? varietyList : [];
        const hit = list.find(v => Number(v.variety_id) === Number(varietyId));
        if (hit && hit.variety_name != null) return String(hit.variety_name);

        // Fallback: query DB by id                                                          
        const v = await PlantVarietyModel.loadById(Number(varietyId));
        return v && v.variety_name != null ? String(v.variety_name) : '';
    }


    // -------------------- Centralized builder for schedule context -------------------- 
    async function buildScheduleContextFromForm(formState, selPlant, options = {}) {

        // Prefer current selected plant instance if provided                              
        const plant = await resolveEffectivePlant(formState.plantId, formState.varietyId);
        if (!plant) throw new Error('Plant not found for schedule.');

        const city = await CityClimate.loadByName(formState.cityName);
        if (!city) throw new Error('City not found for schedule.');

        const method = formState.method;

        const policy = PolicyFlags.fromPlant(plant, method);

        // --- NEW: define varietyId/varietyName in this scope ---
        const varietyId = formState.varietyId != null ? Number(formState.varietyId) : null;
        const varietyName = varietyId
            ? await resolveVarietyName(varietyId, options.currentVarieties)
            : '';

        const inputs = new ScheduleInputs({
            plant,
            city,
            method,
            startISO: formState.startISO,
            seasonEndISO: formState.seasonEndISO,
            policy,
            seasonStartYear: formState.seasonStartYear,
            harvestWindowDays: formState.harvestWindowDays,
            varietyId,
            varietyName
        });


        return { plant, city, method, policy, inputs };
    }

    async function computeFeasibilityWindow({
        plant,          // effectivePlant (base+variety resolved)
        cityName,
        seasonStartYear,
        method,
        harvestWindowDays,
    }) {
        const city = await CityClimate.loadByName(cityName);
        if (!city) return null;

        const env = plant.cropTempEnvelope();
        const dailyRates = city.dailyRates(env.Tbase, seasonStartYear);
        const monthlyAvgTemp = city.monthlyMeans();
        const budget = plant.firstHarvestBudget();

        const overwinterAllowed = plant.isPerennial() || Number(plant.overwinter_ok ?? 0) === 1;
        const scanStart = asUTCDate(seasonStartYear, 1, 1);
        const scanEndYear = overwinterAllowed ? (seasonStartYear + 1) : seasonStartYear;
        const scanEndHard = asUTCDate(scanEndYear, 12, 31);

        const soilGateThresholdC = Number.isFinite(Number(plant.soil_temp_min_plant_c))
            ? Number(plant.soil_temp_min_plant_c)
            : null;

        const daysTransplant = Number.isFinite(Number(plant.days_transplant)) ? Number(plant.days_transplant) : 0;
        const lastSpringFrostDOY = pickFrostByRisk(city, "p50");

        const r = computeAutoStartEndWindowForward({
            method,
            budget,
            HW_DAYS: harvestWindowDays,
            dailyRatesMap: dailyRates,
            monthlyAvgTemp,
            Tbase: env.Tbase,
            cropTemp: env,
            scanStart,
            scanEndHard,
            soilGateThresholdC,
            soilGateConsecutiveDays: 3,
            startCoolingThresholdC: asCoolingThresholdC(plant.start_cooling_threshold_c),
            useSpringFrostGate: !overwinterAllowed,
            lastSpringFrostDOY,
            daysTransplant,
            overwinterAllowed
        });

        return {
            autoEarliestISO: r.earliestFeasibleSowDate?.toISOString().slice(0, 10) ?? null,
            lastFeasibleSowISO: r.lastFeasibleSowDate ? r.lastFeasibleSowDate.toISOString().slice(0, 10) : null,
            climateEndISO: (r.climateEndDate instanceof Date) ? r.climateEndDate.toISOString().slice(0, 10) : null
        };
    }

    function accumulateGDDUntil(startDate, targetGDD, dailyRatesMap, seasonEnd) {
        let acc = 0;
        let cur = new Date(Date.UTC(startDate.getUTCFullYear(),
            startDate.getUTCMonth(),
            startDate.getUTCDate()));
        while (acc < targetGDD) {
            if (seasonEnd && !dateLTE(cur, seasonEnd)) break;
            const rate = Math.max(0, dailyRatesMap[cur.getUTCMonth() + 1] ?? 0);
            acc += rate;
            if (acc >= targetGDD) break;
            cur = addDaysUTC(cur, 1);
        }
        const reached = acc >= targetGDD;
        return { date: cur, gdd: acc, reached };
    }

    function accumulateGDDBackward(targetDate, targetGDD, dailyRatesMap, seasonStart = null) {
        let acc = 0;
        let cur = addDaysUTC(targetDate, -1);
        while (acc < targetGDD) {
            if (seasonStart && dateLTE(cur, addDaysUTC(seasonStart, -1))) break;
            const rate = Math.max(0, dailyRatesMap[cur.getUTCMonth() + 1] ?? 0);
            acc += rate;
            cur = addDaysUTC(cur, -1);
        }
        return { date: addDaysUTC(cur, 1), gdd: acc };
    }

    function maturityDateFromBudget(startDate, budget, dailyRatesMap, seasonEnd) {
        if (budget.mode === 'days') {
            return addDaysUTC(startDate, Math.max(0, Math.round(budget.amount)));
        }
        return accumulateGDDUntil(startDate, budget.amount, dailyRatesMap, seasonEnd).date;
    }

    function sowDateBackFromTargetMaturity(targetMaturityDate, budget, dailyRatesMap, seasonStart) {
        if (budget.mode === 'days') {
            return addDaysUTC(targetMaturityDate, -Math.max(0, Math.round(budget.amount)));
        }
        // 'gdd'
        return accumulateGDDBackward(targetMaturityDate, budget.amount, dailyRatesMap, seasonStart).date;
    }



    // -------------------- Thermal / yield helpers -----------------------------------------

    function thermalYieldFactor(T, cropTemp) {
        const { Tmin, ToptLow, ToptHigh, Tmax } = cropTemp;
        if (T <= Tmin || T >= Tmax) return 0;
        if (T < ToptLow) return (T - Tmin) / Math.max(1e-9, (ToptLow - Tmin));
        if (T <= ToptHigh) return 1;
        return (Tmax - T) / Math.max(1e-9, (Tmax - ToptHigh));
    }
    function weightedMeanTempOverRange(startDate, endDate, monthlyAvgTemp, dailyRatesMap, Tbase = 10) {
        let cur = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate()));
        let sum = 0, n = 0;
        while (cur < endDate) {
            const m = cur.getUTCMonth() + 1;
            let T = monthlyAvgTemp?.[m];
            if (T == null) {
                const gdd = Math.max(0, dailyRatesMap[cur.getUTCMonth() + 1] ?? 0);
                T = gdd > 0 ? (Tbase + gdd) : (Tbase - 2);
            }
            sum += T; n += 1; cur = addDaysUTC(cur, 1);
        }
        return n > 0 ? (sum / n) : Tbase;
    }

    function deriveYieldMultipliersFromTemp({ schedule, budget, dailyRatesMap, cropTemp, monthlyAvgTemp, seasonEnd, Tbase, window = 'harvest', HW_DAYS = 0 }) {
        const raw = schedule.map(sow => {
            const mat = maturityDateFromBudget(sow, budget, dailyRatesMap, seasonEnd);
            const wStart = (window === 'harvest') ? mat : sow;
            const wEnd = (window === 'harvest') ? addDaysUTC(mat, Math.max(0, HW_DAYS))
                : mat;
            const Tmean = weightedMeanTempOverRange(wStart, wEnd, monthlyAvgTemp, dailyRatesMap, Tbase);
            return thermalYieldFactor(Tmean, cropTemp);
        });
        const maxF = Math.max(...raw, 0);
        return raw.map(f => Math.max(0.05, Math.min(1, maxF > 0 ? f / maxF : 0)));
    }


    // -------------------- Soil-temperature gate --------------------------------------------

    // Convert model instance to plain {column: value} dict (primitives only)           
    function toPlainDict(obj) {
        const out = {};
        if (!obj) return out;
        for (const k of Object.keys(obj)) {
            const v = obj[k];
            if (v == null) continue;
            const t = typeof v;
            if (t === 'function') continue;
            if (t === 'object') continue;
            out[k] = v;
        }
        return out;
    }

    function asCoolingThresholdC(v) {
        if (v === null || v === undefined || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    }



    function monthMeanAt(date, monthlyAvgTemp) {
        return monthlyAvgTemp?.[date.getUTCMonth() + 1] ?? null;
    }

    function firstCoolingCrossingDate({ thresholdC, monthlyAvgTemp, scanStart, scanEndHard }) {
        // Walk month by month within [scanStart, scanEndHard]
        let cursor = asUTCDate(scanStart.getUTCFullYear(), scanStart.getUTCMonth() + 1, 1);
        const end = asUTCDate(scanEndHard.getUTCFullYear(), scanEndHard.getUTCMonth() + 1, 1);

        // previous month reference
        let prevMonth = addDaysUTC(cursor, -1);
        let Tprev = monthMeanAt(prevMonth, monthlyAvgTemp);

        while (dateLTE(cursor, end)) {
            const Tcur = monthMeanAt(cursor, monthlyAvgTemp);
            if (Tcur != null && Tprev != null) {
                if (Tprev > thresholdC && Tcur <= thresholdC) {
                    // Linear day-of-month estimate
                    const dim = daysInMonth(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1);
                    const frac = Math.min(1, Math.max(0, (Tprev - thresholdC) / Math.max(1e-6, (Tprev - Tcur))));
                    const day = Math.max(1, Math.min(dim, Math.round(frac * dim)));
                    return asUTCDate(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, day);
                }
            }
            Tprev = Tcur;
            // next month 1st
            cursor = asUTCDate(cursor.getUTCFullYear(), cursor.getUTCMonth() + 2, 1);
        }

        // Edge cases:
        // If scanStart month is already <= threshold, start at scanStart.
        const Tstart = monthMeanAt(scanStart, monthlyAvgTemp);
        if (Tstart != null && Tstart <= thresholdC) return new Date(scanStart);

        return null;
    }

    function buildPlantingSchedule(inputs) {
        const planner = new Planner(inputs);
        const C = planner.ctx;

        // 1) first sow baseline: scanStart or cooling trigger
        let first = new Date(Math.max(C.startDate, C.scanStart));
        if (C.coolingCrossDate) {
            first = new Date(Math.max(first, C.coolingCrossDate));
        }

        // 2) slide forward by soil gate & overall feasibility
        let feas = planner.isSowFeasible(first);
        if (!feas.ok) {
            const nxt = planner.findNextFeasible(first);
            if (!nxt.date) return [];
            first = nxt.date;
        }

        // single planting date only
        return [first];
    }


    function computeStageDatesForPlanting({ sowDate, budget, stageDays, dailyRatesMap, seasonEnd }) {
        const maturity = maturityDateFromBudget(sowDate, budget, dailyRatesMap, seasonEnd);
        const harvestDays = Math.max(0, stageDays.harvest_window_days || 0);
        const harvestStart = maturity;                          // first harvest
        const harvestEnd = addDaysUTC(maturity, harvestDays); // window after first harvest

        // Simple fractions: interpret against the *same unit* as budget
        const total = budget.amount;
        const byFrac = (frac) => {
            if (!(frac > 0 && frac < 1)) return null;
            if (budget.mode === 'days') return addDaysUTC(sowDate, Math.round(total * frac));
            return accumulateGDDUntil(sowDate, Math.round(total * frac), dailyRatesMap, seasonEnd).date;
        };

        const mDays = Number(stageDays.maturityDays); // optional legacy
        const f_germ = mDays ? (Number(stageDays.germinationDays || stageDays.days_germ) / mDays) : null;
        const f_trans = mDays ? (Number(stageDays.transplantDays || stageDays.days_transplant) / mDays) : null;

        return {
            sow: sowDate,
            germ: byFrac(f_germ),
            transplant: byFrac(f_trans),
            maturity,
            harvestStart,
            harvestEnd
        };
    }


    function computeStageTimelineForSchedule({ schedule, budget, stageDays, dailyRatesMap, seasonEnd }) {

        if (!budget || !Number.isFinite(budget.amount) || budget.amount <= 0) {
            throw new Error('Invalid maturity budget');
        }
        return (schedule || []).map(sow =>
            computeStageDatesForPlanting({ sowDate: sow, budget, stageDays, dailyRatesMap, seasonEnd })
        );
    }

    function classifyIsThermal(reason) {
        if (!reason) return false;
        return reason.indexOf('harvest_too_cold') === 0 ||
            reason.indexOf('harvest_too_hot') === 0 ||
            reason === 'insufficient_gdd';
    }

    function firstNonSoilStart(planner, startD) {
        const C = planner.ctx;
        let d = new Date(Math.max(startD, C.scanStart));
        for (; d <= C.scanEndHard; d = planner.addDays(d, 1)) {
            if (!C.useSoilTempGate || planner.soilGateOK(d)) return d;
        }
        return null;
    }

    function impliedHarvestEndForDate(planner, sow, HW_DAYS) {
        const C = planner.ctx;
        const mat = maturityDateFromBudget(sow, C.BUDGET, C.dailyRates, C.scanEndHard);
        return planner.addDays(mat, Math.max(0, HW_DAYS || 0));
    }

    // helper near your other date utils
    function dateFromDOY(year, doy) {
        const d0 = Date.UTC(year, 0, 1);
        return new Date(d0 + (Math.max(1, Math.floor(doy)) - 1) * 86400000);
    }







































    // -------------------- Graph helpers ----------------------------------------------------
    function setAttr(cell, k, v) { const val = cell && cell.value; if (val && val.setAttribute) val.setAttribute(k, String(v)); }
    function getAttr(cell, k) { return cell && cell.getAttribute ? cell.getAttribute(k) : null; }
    function isTilerGroup(cell) { return !!cell && cell.getAttribute && cell.getAttribute('tiler_group') === '1'; }
    // --- NEW: tiny helper to detect schedule -----------------------------------
    function hasTilerSchedule(cell) {
        const hs = getAttr(cell, 'harvest_start');
        return hs != null && String(hs).trim() !== '';
    }
    // --- helpers: find garden module ancestor & scoped board lookup ---
    function isGardenModule(cell) {
        return !!(cell && cell.getAttribute && cell.getAttribute('garden_module') === '1');
    }
    function findGardenModuleAncestor(model, cell) {
        if (!cell) return null;
        const m = model;
        let cur = cell;
        while (cur) {
            if (isGardenModule(cur)) return cur;
            cur = m.getParent(cur);
        }
        return null;
    }
    function defaultGroupStyle() {
        return [
            'shape=rectangle', 'strokeColor=#2563eb', 'dashed=1', 'fillColor=none',
            'dashPattern=3 3', 'fontSize=12', 'align=center', 'verticalAlign=top',
            'resizable=1', 'movable=1', 'deletable=1', 'editable=0', 'whiteSpace=nowrap', 'html=0'
        ].join(';');
    }
    function createXmlValue(tag, attrs) {
        const doc = mxUtils.createXmlDocument();
        const node = doc.createElement(tag);
        Object.keys(attrs || {}).forEach(k => node.setAttribute(k, String(attrs[k])));
        return node;
    }
    function createSiblingTilerGroup(graph, anchorGroup, label, dx, dy) {
        const parent = graph.getModel().getParent(anchorGroup) || graph.getDefaultParent();
        const gg = anchorGroup.getGeometry();
        const geo = new mxGeometry(gg.x + dx, gg.y + dy, gg.width, gg.height);
        const val = createXmlValue('TilerGroup', { tiler_group: '1', label });
        const g = new mxCell(val, geo, defaultGroupStyle());
        g.setVertex(true); g.setConnectable(false);
        graph.addCell(g, parent);
        return g;
    }
    function copySpacingAttrs(fromCell, toCell) {
        const x = fromCell.getAttribute && fromCell.getAttribute('spacing_x_cm');
        const y = fromCell.getAttribute && fromCell.getAttribute('spacing_y_cm');
        const s = fromCell.getAttribute && fromCell.getAttribute('spacing_cm');
        const vd = fromCell.getAttribute && fromCell.getAttribute('veg_diameter_cm');
        if (x) setAttr(toCell, 'spacing_x_cm', x);
        if (y) setAttr(toCell, 'spacing_y_cm', y);
        if (s) setAttr(toCell, 'spacing_cm', s);
        if (vd) setAttr(toCell, 'veg_diameter_cm', vd);
    }

    function applyPlantSpacingToGroup(groupCell, plantRow) {
        if (!groupCell || !plantRow) return;

        const sx = plantRow.spacing_x_cm;
        const sy = plantRow.spacing_y_cm;
        const s = plantRow.spacing_cm;
        const vd = plantRow.veg_diameter_cm;

        const hasVal = (v) => v !== undefined && v !== null && v !== '';

        // Derive canonical spacing X/Y: prefer explicit x/y, fall back to spacing_cm    
        let spacingX = hasVal(sx) ? sx : (hasVal(s) ? s : null);
        let spacingY = hasVal(sy) ? sy : (hasVal(s) ? s : null);

        if (hasVal(spacingX)) {
            setAttr(groupCell, 'spacing_x_cm', spacingX);
        }
        if (hasVal(spacingY)) {
            setAttr(groupCell, 'spacing_y_cm', spacingY);
        }
        if (hasVal(s)) {                                                                 //(same as before but via helper)
            setAttr(groupCell, 'spacing_cm', s);
        }

        if (hasVal(vd)) {                                                                //(same semantics, cleaner)
            setAttr(groupCell, 'veg_diameter_cm', vd);
        }
    }

































    function buildAutoWindowPlanner(params) {
        const {
            method, budget, HW_DAYS,
            dailyRatesMap, monthlyAvgTemp, Tbase, cropTemp,
            scanStart, scanEndHard,
            soilGateThresholdC, soilGateConsecutiveDays,
            startCoolingThresholdC,
            useSpringFrostGate,
            daysTransplant,
            overwinterAllowed
        } = params;

        const fakePlant = {
            start_cooling_threshold_c: startCoolingThresholdC,
            soil_temp_min_plant_c: soilGateThresholdC,
            isPerennial: () => false,
            isBiennial: () => false,
            overwinter_ok: overwinterAllowed ? 1 : 0,
            days_transplant: daysTransplant,
            cropTempEnvelope: () => cropTemp,
            firstHarvestBudget: () => budget
        };

        const fakeCity = {
            dailyRates: (_tbase, _year) => dailyRatesMap,
            monthlyMeans: () => monthlyAvgTemp
        };

        const policy = new PolicyFlags({
            useSoilTempGate: Number.isFinite(soilGateThresholdC) && method === 'direct_sow',
            soilGateThresholdC,
            soilGateConsecutiveDays,
            overwinterAllowed,
            useSpringFrostGate: !!useSpringFrostGate && !overwinterAllowed,
            springFrostRisk: 'p50'
        });

        const inputs = new ScheduleInputs({
            plant: fakePlant,
            city: fakeCity,
            method,
            startISO: scanStart.toISOString().slice(0, 10),
            seasonEndISO: scanEndHard.toISOString().slice(0, 10),
            policy,
            seasonStartYear: scanStart.getUTCFullYear()
        });

        const planner = new Planner(inputs);
        return { planner, ctx: planner.ctx };
    }


    // -------------------- Feasibility + window (single pure function) --------------------
    function computeAutoStartEndWindowForward(params) {
        const {
            method, budget, HW_DAYS,
            dailyRatesMap, monthlyAvgTemp, Tbase, cropTemp,
            scanStart, scanEndHard,
            // gates                                                                         
            soilGateThresholdC = null, soilGateConsecutiveDays = 3,
            startCoolingThresholdC = null,
            useSpringFrostGate = false,
            lastSpringFrostDOY = null,
            // transplant specifics                                                          
            daysTransplant = 0,
            // behavior                                                                      
            overwinterAllowed = false,
        } = params;

        // Build planner using fake plant/city with the given environment                    
        const { planner } = buildAutoWindowPlanner({
            method, budget, HW_DAYS,
            dailyRatesMap, monthlyAvgTemp, Tbase, cropTemp,
            scanStart, scanEndHard,
            soilGateThresholdC, soilGateConsecutiveDays,
            startCoolingThresholdC,
            useSpringFrostGate,
            daysTransplant,
            overwinterAllowed
        });

        const C = planner.ctx;

        // Limit sow scanning for overwinter crops to the first season year        
        const sowScanEnd = overwinterAllowed
            ? asUTCDate(C.scanStart.getUTCFullYear(), 12, 31)
            : C.scanEndHard;

        // --- Build earliest FIELD date (air-gated date) ---                                
        let fieldGateStart = new Date(C.scanStart);

        // spring frost gate                                                                 
        if (useSpringFrostGate && Number.isFinite(lastSpringFrostDOY)) {
            const frostDate = dateFromDOY(C.scanStart.getUTCFullYear(), lastSpringFrostDOY);
            if (frostDate > fieldGateStart) fieldGateStart = frostDate;
        }

        // cooling gate (air)                                                                
        if (Number.isFinite(startCoolingThresholdC)) {
            const cross = firstCoolingCrossingDate({
                thresholdC: startCoolingThresholdC,
                monthlyAvgTemp,
                scanStart: C.scanStart,
                scanEndHard: C.scanEndHard
            });
            if (cross && cross > fieldGateStart) fieldGateStart = cross;
        }

        // --- Convert fieldGateStart → sow candidate based on method ---                    
        let sowCandidate = new Date(fieldGateStart);

        if (method === 'transplant_indoor') {
            const dt = Math.max(0, Math.round(Number(daysTransplant) || 0));
            const indoorSow = planner.addDays(fieldGateStart, -dt);
            sowCandidate = indoorSow < C.scanStart ? new Date(C.scanStart) : indoorSow;
        } else if (method === 'transplant_outdoor') {
            sowCandidate = fieldGateStart;
        } else if (method === 'direct_sow') {
            sowCandidate = fieldGateStart;
        }

        // --- Walk feasibility from that candidate using full planner logic ---             
        const firstNonSoil = (method === 'direct_sow')
            ? (firstNonSoilStart(planner, sowCandidate) || sowCandidate)
            : sowCandidate;

        let firstOkSow = null;
        let firstOkHarvestEnd = null;
        let lastOkHarvestEnd = null;
        let lastThermalHarvestEnd = null;
        let lastOkSow = null;

        for (let d = new Date(firstNonSoil); d <= sowScanEnd; d = planner.addDays(d, 1)) {
            const r = planner.isSowFeasible(d, true);
            if (r.ok) {

                if (!firstOkSow) {
                    firstOkSow = new Date(d);
                    firstOkHarvestEnd = r.harvestEnd;
                }
                lastOkSow = new Date(d);

                const hEnd = r.harvestEnd;
                if (!lastOkHarvestEnd || hEnd > lastOkHarvestEnd) {
                    lastOkHarvestEnd = hEnd;
                }
            } else {
                const isThermal = classifyIsThermal(r.reason) ||
                    r.reason === 'cross_year_disallowed' ||
                    r.reason === 'beyond_hard_end';
                if (isThermal && Number.isFinite(HW_DAYS)) {
                    let hEnd = impliedHarvestEndForDate(planner, d, HW_DAYS);
                    if (hEnd > C.scanEndHard) hEnd = new Date(C.scanEndHard);
                    if (!lastThermalHarvestEnd || hEnd > lastThermalHarvestEnd) {
                        lastThermalHarvestEnd = hEnd;
                    }
                }
            }
        }

        // No feasible sow found                                                             
        if (!firstOkSow) {
            console.log('[autoWindow] scan (no feasible)', {
                scanStart: C.scanStart.toISOString().slice(0, 10),
                scanEndHard: C.scanEndHard.toISOString().slice(0, 10),
                method,
                firstNonSoil: firstNonSoil ? firstNonSoil.toISOString().slice(0, 10) : null,
                lastThermalHarvestEnd: lastThermalHarvestEnd
                    ? lastThermalHarvestEnd.toISOString().slice(0, 10)
                    : null
            });

            const earliest = firstNonSoil || new Date(C.scanStart);
            const fallbackHarvestEnd = lastThermalHarvestEnd || new Date(C.scanEndHard);

            return {
                earliestFeasibleSowDate: earliest,
                lastHarvestDate: fallbackHarvestEnd,
                lastFeasibleSowDate: null,
                climateEndDate: fallbackHarvestEnd
            };
        }

        // At least one feasible sow                                                         
        const earliestFeasibleSow = firstOkSow;
        const lastFeasibleSow = lastOkSow;
        const firstFeasibleHarvestEnd = firstOkHarvestEnd;
        const lastFeasibleHarvestEnd = lastOkHarvestEnd;

        // Fallback for logging/debug (not used in return)                                   
        const fallbackHarvestEnd = lastFeasibleHarvestEnd ||
            firstFeasibleHarvestEnd ||
            lastThermalHarvestEnd ||
            new Date(C.scanEndHard);

        // Decide which harvest-end to expose as lastHarvestDate                             
        const lastHarvestDate = firstFeasibleHarvestEnd || earliestFeasibleSow;

        // climate-level end of window
        let climateEndDate;
        if (overwinterAllowed) {
            // For overwinter crops, tie climate end to the last (schedule) harvest      
            climateEndDate = lastHarvestDate
                || lastFeasibleHarvestEnd
                || lastThermalHarvestEnd
                || firstFeasibleHarvestEnd
                || new Date(C.scanEndHard);
        } else {
            // Non-overwinter crops: keep full climate envelope behavior as before       
            climateEndDate = lastFeasibleHarvestEnd
                || lastThermalHarvestEnd
                || firstFeasibleHarvestEnd
                || new Date(C.scanEndHard);
        }


        console.log('[autoWindow] RESULT', {
            earliestFeasibleSowDate: fmtISO(earliestFeasibleSow),
            lastHarvestDate: fmtISO(lastHarvestDate),
            lastFeasibleSowDate: lastFeasibleSow ? fmtISO(lastFeasibleSow) : null,
            HW_DAYS, method
        });

        return {
            earliestFeasibleSowDate: earliestFeasibleSow,
            lastHarvestDate,
            lastFeasibleSowDate: lastFeasibleSow,
            climateEndDate
        };
    }




































































    // -------------------- UI bits (small DOM helpers) --------------------------------------
    function row(labelText, controlEl) {
        const wrap = document.createElement('div');
        wrap.style.display = 'flex';
        wrap.style.alignItems = 'center';
        wrap.style.gap = '8px';
        wrap.style.margin = '6px 0';
        const lab = document.createElement('label');
        lab.textContent = labelText;
        lab.style.display = 'inline-block';
        lab.style.minWidth = '180px';
        wrap.appendChild(lab);
        wrap.appendChild(controlEl);
        return { row: wrap, label: lab, control: controlEl };
    }
    function makeSelect(options, initialValue) {
        const sel = document.createElement('select');
        sel.style.width = '100%'; sel.style.padding = '6px';
        options.forEach(o => {
            const opt = document.createElement('option');
            opt.value = o.value; opt.textContent = o.label;
            sel.appendChild(opt);
        });
        if (initialValue != null) sel.value = String(initialValue);
        return sel;
    }
    function makeNumber(initial, { min = null } = {}) {
        const el = document.createElement('input'); el.type = 'number';
        el.value = String(initial ?? 0); if (min != null) el.min = String(min);
        return el;
    }
    function makeCheckbox(initialChecked, disabled = false) {
        const el = document.createElement('input'); el.type = 'checkbox';
        el.checked = !!initialChecked; el.disabled = !!disabled;
        return el;
    }
    function makeDate(valueISO, disabled = true) {
        const el = document.createElement('input'); el.type = 'date';
        el.value = valueISO; el.disabled = !!disabled;
        return el;
    }

    function makeNullableNumber(initial, { min = null, step = null } = {}) {
        const el = document.createElement('input');
        el.type = 'number';
        el.value = (initial == null || initial === '') ? '' : String(initial);
        if (min != null) el.min = String(min);
        if (step != null) el.step = String(step);
        el.style.width = '100%'; el.style.padding = '6px';                    // NEW
        return el;
    }    

    function readNullableNumber(inputEl) {
        const s = String(inputEl?.value ?? '').trim();
        if (s === '') return null;
        const n = Number(s);
        if (!Number.isFinite(n)) throw new Error('Invalid number');
        return n;
    }

    function readIntGE0(inputEl) {
        const n = Number(String(inputEl?.value ?? '').trim());
        if (!Number.isFinite(n) || n < 0) throw new Error('Expected integer >= 0');
        return Math.trunc(n);
    }

    function readNumGE0(inputEl) {
        const n = Number(String(inputEl?.value ?? '').trim());
        if (!Number.isFinite(n) || n < 0) throw new Error('Expected number >= 0');
        return n;
    }


    // -------------------- View helpers (schema → rows, layout) --------------------------  
    function buildFieldRows(schema, rowFactory = row) {
        const fieldRows = {};
        const ordered = [];
        schema.forEach(def => {
            const r = rowFactory(def.label, def.control);
            fieldRows[def.key] = r;
            ordered.push({ key: def.key, row: r.row, meta: def, view: r });
        });
        return { fieldRows, ordered };
    }

    function appendFieldRows(container, fieldRows, keys) {
        keys.forEach(k => {
            const fr = fieldRows[k];
            if (fr && fr.row) container.appendChild(fr.row);
        });
    }

    // Scans season feasibility day-by-day.
    async function explainFeasibilityOverSeason(inputs, maxDays = 400, stopAtFirstOk = false) {
        const planner = new Planner(inputs);
        const out = [];
        let d = new Date(Math.max(planner.ctx.startDate, planner.ctx.scanStart));
        for (let i = 0; i < maxDays && d <= planner.ctx.scanEndHard; i++) {
            try {
                const r = planner.isSowFeasible(d, true);
                if (r && r.ok) {
                    out.push({
                        date: fmtISO(d),
                        ok: true,
                        reason: r.reason || 'ok',
                        maturity: fmtISO(r.maturity || null),
                        harvestEnd: fmtISO(r.harvestEnd || null),
                        TmeanHarvest: Number.isFinite(r.TmeanHarvest) ? r.TmeanHarvest.toFixed(1) : ''
                    });
                    if (stopAtFirstOk) break;
                } else {
                    out.push({
                        date: fmtISO(d),
                        ok: false,
                        reason: (r && r.reason) ? r.reason : 'unknown'
                    });
                }
            } catch (e) {
                out.push({ date: fmtISO(d), ok: false, reason: 'error:' + (e?.message || 'unknown') });
            }
            d = addDaysUTC(d, 1);
        }
        return out;
    }

    function showCommitDialog(ui, {
        container,
        width,
        height,
        modal = true,
        closable = true
    } = {}) {
        return new Promise((resolve) => {
            let settled = false;
            const originalHide = ui.hideDialog.bind(ui);

            function settle(val) {
                if (settled) return;
                settled = true;
                ui.hideDialog = originalHide;
                resolve(val);
            }

            ui.hideDialog = function () {
                // Only treat it as a cancel if THIS dialog is the active one                   
                const active = ui.dialog && ui.dialog.container;
                const isThis = active === container || container.contains(active);
                try {
                    originalHide();
                } finally {
                    if (isThis) settle(null);
                }
            };

            // commit channel                                                                    
            container.__commit = (val) => {
                settle(val);
                // Close after settling; hideDialog wrapper is already restored                 
                try { originalHide(); } catch (_) { }
            };

            // explicit cancel channel (optional, but clearer at call sites)                      
            container.__cancel = () => {
                ui.hideDialog();
            };

            ui.showDialog(container, width, height, modal, closable);
        });
    }

    function renderPreviewTable(ui, rows) {
        const div = document.createElement('div');
        div.style.padding = '12px';
        div.style.maxWidth = '840px';
        div.style.maxHeight = '70vh';
        div.style.overflow = 'auto';

        const title = document.createElement('div');
        title.textContent = 'Schedule Preview';
        title.style.fontWeight = '600';
        title.style.marginBottom = '8px';
        div.appendChild(title);

        const table = document.createElement('table');
        table.style.borderCollapse = 'collapse';
        table.style.width = '100%';

        const headers = [
            'Plant', 'Method',
            'Sow', 'Germ', 'Transplant', 'Harvest Start', 'Harvest End',
            'Yield Multiplier', 'Plants Required'
        ];
        const thead = document.createElement('thead');
        const trh = document.createElement('tr');
        headers.forEach(h => {
            const th = document.createElement('th');
            th.textContent = h;
            th.style.border = '1px solid #ddd';
            th.style.padding = '6px 8px';
            th.style.background = '#f3f4f6';
            th.style.fontWeight = '600';
            th.style.textAlign = 'left';
            trh.appendChild(th);
        });
        thead.appendChild(trh);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        rows.forEach(r => {
            const tr = document.createElement('tr');
            [
                r.plant, r.method,
                r.sow, r.germ, r.trans, r.harvStart, r.harvEnd,
                r.mult, r.plantsReq
            ].forEach(val => {
                const td = document.createElement('td');
                td.textContent = String(val ?? '');
                td.style.border = '1px solid #eee';
                td.style.padding = '6px 8px';
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);

        div.appendChild(table);

        const btns = document.createElement('div');
        btns.style.marginTop = '12px';
        btns.style.textAlign = 'right';
        const closeBtn = mxUtils.button('Close', () => ui.hideDialog());
        btns.appendChild(closeBtn);
        div.appendChild(btns);

        ui.showDialog(div, 860, 480, true, true);
    }

    async function openPlantEditorDialog(ui, { mode, plantId = null } = {}) {
        const isEdit = mode === 'edit';
        const existing = isEdit ? await PlantModel.loadById(Number(plantId)) : null;
        if (isEdit && !existing) throw new Error('Plant not found');

        const div = document.createElement('div');
        div.style.padding = '12px';
        div.style.width = '640px';
        div.style.maxHeight = '70vh';
        div.style.overflow = 'auto';

        const title = document.createElement('div');
        title.textContent = isEdit ? 'Edit plant' : 'Add plant';
        title.style.fontWeight = '600';
        title.style.marginBottom = '10px';
        div.appendChild(title);

        // --- Identity ---
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.value = existing?.plant_name ?? '';
        nameInput.style.width = '100%';
        nameInput.style.padding = '6px';

        const abbrInput = document.createElement('input');
        abbrInput.type = 'text';
        abbrInput.value = existing?.abbr ?? '';
        abbrInput.style.width = '100%';
        abbrInput.style.padding = '6px';

        div.appendChild(row('Plant name:', nameInput).row);
        div.appendChild(row('Abbreviation (abbr):', abbrInput).row);

        // --- Lifecycle ---
        const typeSel = makeSelect([
            { value: 'annual', label: 'Annual' },
            { value: 'biennial', label: 'Biennial' },
            { value: 'perennial', label: 'Perennial' }
        ], (existing?.perennial === 1) ? 'perennial' : (existing?.biennial === 1 ? 'biennial' : 'annual'));

        const lifespanInput = makeNullableNumber(existing?.lifespan_years ?? null, { min: 1, step: 1 });
        const overwinterChk = makeCheckbox(existing?.overwinter_ok === 1);

        div.appendChild(row('Lifecycle:', typeSel).row);
        const lifeRow = row('Lifespan (years):', lifespanInput);
        div.appendChild(lifeRow.row);
        div.appendChild(row('Overwinter OK:', overwinterChk).row);

        function syncLifecycleEnablement() {
            const isPer = typeSel.value === 'perennial';
            lifespanInput.disabled = !isPer;
            if (!isPer) lifespanInput.value = '';
        }
        syncLifecycleEnablement();
        typeSel.addEventListener('change', syncLifecycleEnablement);

        // --- Methods ---
        const directSowChk = makeCheckbox((existing?.direct_sow ?? 0) === 1);
        const transplantChk = makeCheckbox((existing?.transplant ?? 0) === 1);

        div.appendChild(row('Direct sow:', directSowChk).row);
        div.appendChild(row('Transplant:', transplantChk).row);

        // --- Maturity budget ---
        const hasGdd = Number(existing?.gdd_to_maturity ?? 0) > 0;
        const budgetModeSel = makeSelect([
            { value: 'gdd', label: 'GDD to maturity' },
            { value: 'days', label: 'Days to maturity' }
        ], hasGdd ? 'gdd' : 'days');

        const gddInput = makeNullableNumber(existing?.gdd_to_maturity ?? null, { min: 0, step: 1 });
        const daysMatInput = makeNullableNumber(existing?.days_maturity ?? null, { min: 0, step: 1 });

        const gddRow = row('GDD to maturity:', gddInput);
        const daysRow = row('Days to maturity:', daysMatInput);

        div.appendChild(row('Maturity budget:', budgetModeSel).row);
        div.appendChild(gddRow.row);
        div.appendChild(daysRow.row);

        function syncBudgetModeUI() {
            const mode = budgetModeSel.value;
            gddRow.row.style.display = (mode === 'gdd') ? '' : 'none';
            daysRow.row.style.display = (mode === 'days') ? '' : 'none';
        }
        syncBudgetModeUI();
        budgetModeSel.addEventListener('change', syncBudgetModeUI);

        // --- Timing ---
        const daysGermInput = makeNullableNumber(existing?.days_germ ?? 0, { min: 0, step: 1 });
        const daysTransInput = makeNullableNumber(existing?.days_transplant ?? 0, { min: 0, step: 1 });
        div.appendChild(row('Days to germ:', daysGermInput).row);
        div.appendChild(row('Days to transplant:', daysTransInput).row);

        // --- Yield ---
        const yieldInput = makeNullableNumber(existing?.yield_per_plant_kg ?? null, { min: 0, step: 0.001 });
        const hwInput = makeNullableNumber(existing?.harvest_window_days ?? null, { min: 0, step: 1 });
        div.appendChild(row('Yield per plant (kg):', yieldInput).row);
        div.appendChild(row('Harvest window (days):', hwInput).row);

        // --- Temperature envelope ---
        const tbaseInput = makeNullableNumber(existing?.tbase_c ?? null, { step: 0.1 });
        const tminInput = makeNullableNumber(existing?.tmin_c ?? null, { step: 0.1 });
        const toptLowInput = makeNullableNumber(existing?.topt_low_c ?? null, { step: 0.1 });
        const toptHighInput = makeNullableNumber(existing?.topt_high_c ?? null, { step: 0.1 });
        const tmaxInput = makeNullableNumber(existing?.tmax_c ?? null, { step: 0.1 });

        div.appendChild(row('Tbase (C):', tbaseInput).row);
        div.appendChild(row('Tmin (C):', tminInput).row);
        div.appendChild(row('Topt low (C):', toptLowInput).row);
        div.appendChild(row('Topt high (C):', toptHighInput).row);
        div.appendChild(row('Tmax (C):', tmaxInput).row);

        // --- Gates ---
        const soilMinInput = makeNullableNumber(existing?.soil_temp_min_plant_c ?? null, { step: 0.1 });
        const coolThreshInput = makeNullableNumber(existing?.start_cooling_threshold_c ?? null, { step: 0.1 });
        div.appendChild(row('Soil temp min plant (C):', soilMinInput).row);
        div.appendChild(row('Start cooling threshold (C):', coolThreshInput).row);

        // --- Buttons ---
        const btns = document.createElement('div');
        btns.style.marginTop = '12px';
        btns.style.display = 'flex';
        btns.style.justifyContent = 'flex-end';
        btns.style.gap = '8px';

        const cancelBtn = mxUtils.button('Cancel', () => div.__cancel());

        const saveBtn = mxUtils.button('Save', async () => {
            try {
                const plant_name = String(nameInput.value || '').trim();
                if (!plant_name) throw new Error('Plant name is required');

                const lifecycle = typeSel.value;
                const annual = (lifecycle === 'annual') ? 1 : 0;
                const biennial = (lifecycle === 'biennial') ? 1 : 0;
                const perennial = (lifecycle === 'perennial') ? 1 : 0;

                const lifespan_years = perennial ? readNullableNumber(lifespanInput) : null;
                if (perennial && !(Number.isFinite(Number(lifespan_years)) && Number(lifespan_years) >= 1)) {
                    throw new Error('Perennials require lifespan_years >= 1');
                }

                const direct_sow = directSowChk.checked ? 1 : 0;
                const transplant = transplantChk.checked ? 1 : 0;
                if (!direct_sow && !transplant) throw new Error('Enable direct_sow and/or transplant');

                const overwinter_ok = overwinterChk.checked ? 1 : 0;

                const budgetMode = budgetModeSel.value;
                const gdd_to_maturity = (budgetMode === 'gdd') ? readNullableNumber(gddInput) : null;
                const days_maturity = (budgetMode === 'days') ? readNullableNumber(daysMatInput) : null;

                if (budgetMode === 'gdd' && !(Number.isFinite(Number(gdd_to_maturity)) && Number(gdd_to_maturity) >= 0)) {
                    throw new Error('GDD to maturity must be >= 0');
                }
                if (budgetMode === 'days' && !(Number.isFinite(Number(days_maturity)) && Number(days_maturity) >= 0)) {
                    throw new Error('Days to maturity must be >= 0');
                }

                const patch = {
                    plant_name,
                    abbr: String(abbrInput.value || '').trim() || null,
                    annual, biennial, perennial,
                    lifespan_years,
                    overwinter_ok,
                    direct_sow, transplant,
                    gdd_to_maturity, days_maturity,
                    days_germ: readIntGE0(daysGermInput),
                    days_transplant: readIntGE0(daysTransInput),
                    yield_per_plant_kg: readNullableNumber(yieldInput),
                    harvest_window_days: (hwInput.value === '' ? null : readIntGE0(hwInput)),
                    tbase_c: readNullableNumber(tbaseInput),
                    tmin_c: readNullableNumber(tminInput),
                    topt_low_c: readNullableNumber(toptLowInput),
                    topt_high_c: readNullableNumber(toptHighInput),
                    tmax_c: readNullableNumber(tmaxInput),
                    soil_temp_min_plant_c: readNullableNumber(soilMinInput),
                    start_cooling_threshold_c: readNullableNumber(coolThreshInput)
                };

                let saved = null;
                if (isEdit) {
                    saved = await PlantModel.update(Number(plantId), patch);
                } else {
                    saved = await PlantModel.create(patch);
                }

                div.__commit(saved);

            } catch (e) {
                mxUtils.alert('Save plant error: ' + (e?.message || String(e)));
            }
        });

        btns.appendChild(cancelBtn);
        btns.appendChild(saveBtn);
        div.appendChild(btns);

        return await showCommitDialog(ui, { container: div, width: 680, height: 620, modal: true, closable: true });
    }


    (function installVarietyEditorBridge() {
        const graph = ui && ui.editor ? ui.editor.graph : null;
        if (!graph) return;

        if (graph.__uslVarietyEditorBridgeInstalled) return;
        graph.__uslVarietyEditorBridgeInstalled = true;

        graph.addListener("usl:openVarietyEditor", async function (sender, evt) {
            const cropId = String(evt.getProperty("cropId") || "").trim();
            const plantId = Number(evt.getProperty("plantId"));
            const varietyIdRaw = evt.getProperty("varietyId");
            const varietyId = (varietyIdRaw == null || varietyIdRaw === "") ? null : Number(varietyIdRaw);

            console.log("[Scheduler] received usl:openVarietyEditor", { cropId, plantId, varietyId });

            if (!Number.isFinite(plantId)) return;

            const mode = (varietyId != null && Number.isFinite(varietyId)) ? "edit" : "add";

            try {
                const saved = await openVarietyEditorDialog(ui, {
                    mode,
                    plantId,
                    varietyId
                });

                // Emit close event (include cropId so Year Planner updates right row)
                graph.fireEvent(new mxEventObject(
                    "usl:varietyEditorClosed",
                    "cropId", cropId,
                    "plantId", plantId,
                    "action", saved && saved.variety_id ? mode : "cancel",
                    "varietyId", saved && saved.variety_id ? Number(saved.variety_id) : null,
                    "varietyName", saved && saved.variety_name ? String(saved.variety_name) : ""
                ));
            } catch (e) {
                console.error("[Scheduler] openVarietyEditorDialog failed", e);
                try {
                    graph.fireEvent(new mxEventObject(
                        "usl:varietyEditorClosed",
                        "cropId", cropId,
                        "plantId", plantId,
                        "action", "error",
                        "varietyId", null,
                        "varietyName", "",
                        "error", String(e?.message || e)
                    ));
                } catch (_) { }
            }
        });
    })();


    async function openVarietyEditorDialog(ui, { mode, plantId = null, varietyId = null } = {}) {
        const isEdit = mode === 'edit';
        const existing = isEdit ? await PlantVarietyModel.loadById(Number(varietyId)) : null;
        if (isEdit && !existing) throw new Error('Variety not found');

        const pid = Number(plantId);
        if (!Number.isFinite(pid)) throw new Error('plantId is required');

        const basePlant = await PlantModel.loadById(pid);
        if (!basePlant) throw new Error('Base plant not found');
        const baseDict = toPlainDict(basePlant);

        // ---- parse initial overrides ----
        let initialOverrides = {};
        try {
            const raw = existing?.overrides_json;
            if (raw) {
                const obj = JSON.parse(String(raw));
                if (obj && typeof obj === 'object' && !Array.isArray(obj)) initialOverrides = obj;
            }
        } catch (_) { initialOverrides = {}; }

        const div = document.createElement('div');
        div.style.padding = '12px';
        div.style.width = '720px';
        div.style.maxHeight = '70vh';
        div.style.overflow = 'auto';

        const title = document.createElement('div');
        title.textContent = isEdit ? 'Edit variety' : 'Add variety';
        title.style.fontWeight = '600';
        title.style.marginBottom = '10px';
        div.appendChild(title);

        // --- Variety name ---
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.value = String(existing?.variety_name ?? '');
        nameInput.style.width = '100%';
        nameInput.style.padding = '6px';
        div.appendChild(row('Variety name:', nameInput).row);

        // --- helpers ---
        function fmtBaseVal(key) {
            const v = baseDict[key];
            if (v == null || v === '') return '(null)';
            return String(v);
        }

        function makeOverrideRow(def) {
            const wrap = document.createElement('div');
            wrap.style.display = 'flex';
            wrap.style.gap = '8px';
            wrap.style.alignItems = 'center';

            const chk = makeCheckbox(Object.prototype.hasOwnProperty.call(initialOverrides, def.key));

            let input = null;
            if (def.type === 'int_ge0') input = makeNullableNumber(initialOverrides[def.key] ?? null, { min: 0, step: 1 });
            else if (def.type === 'num_ge0') input = makeNullableNumber(initialOverrides[def.key] ?? null, { min: 0, step: def.step ?? 0.1 });
            else if (def.type === 'nullable_num') input = makeNullableNumber(
                Object.prototype.hasOwnProperty.call(initialOverrides, def.key) ? initialOverrides[def.key] : null,
                { step: def.step ?? 0.1 }
            );
            else if (def.type === 'bool01') {
                input = makeCheckbox(Number(initialOverrides[def.key] ?? 0) === 1);
            }

            input.style.flex = '1';
            input.disabled = !chk.checked;

            const baseSpan = document.createElement('div');
            baseSpan.textContent = 'Base: ' + fmtBaseVal(def.key);
            baseSpan.style.fontSize = '12px';
            baseSpan.style.opacity = '0.8';
            baseSpan.style.minWidth = '170px';

            chk.addEventListener('change', () => {
                input.disabled = !chk.checked;
                if (!chk.checked) {
                    // reset UI to initial override value or blank
                    if (def.type === 'bool01') input.checked = false;
                    else input.value = '';
                }
            });

            wrap.appendChild(chk);
            wrap.appendChild(input);
            wrap.appendChild(baseSpan);

            return { chk, input, wrap };
        }

        function readOverrideValue(def, inputEl) {
            if (def.type === 'bool01') return inputEl.checked ? 1 : 0;
            if (def.type === 'int_ge0') return readIntGE0(inputEl);
            if (def.type === 'num_ge0') return readNumGE0(inputEl);
            if (def.type === 'nullable_num') return readNullableNumber(inputEl);
            return null;
        }

        // --- schema ---
        const OVERRIDE_SCHEMA = [
            { section: 'Timing & yield', key: 'days_maturity', label: 'Days to maturity', type: 'int_ge0' },
            { section: 'Timing & yield', key: 'gdd_to_maturity', label: 'GDD to maturity', type: 'num_ge0', step: 1 },
            { section: 'Timing & yield', key: 'days_germ', label: 'Days to germ', type: 'int_ge0' },
            { section: 'Timing & yield', key: 'days_transplant', label: 'Days to transplant', type: 'int_ge0' },
            { section: 'Timing & yield', key: 'yield_per_plant_kg', label: 'Yield per plant (kg)', type: 'num_ge0', step: 0.001 },
            { section: 'Timing & yield', key: 'harvest_window_days', label: 'Harvest window (days)', type: 'int_ge0' },

            { section: 'Gates', key: 'soil_temp_min_plant_c', label: 'Soil temp min plant (C)', type: 'nullable_num', step: 0.1 },
            { section: 'Gates', key: 'start_cooling_threshold_c', label: 'Start cooling threshold (C)', type: 'nullable_num', step: 0.1 },
            { section: 'Gates', key: 'overwinter_ok', label: 'Overwinter OK', type: 'bool01' },

            { section: 'Temperature envelope (advanced)', key: 'tbase_c', label: 'Tbase (C)', type: 'nullable_num', step: 0.1 },
            { section: 'Temperature envelope (advanced)', key: 'tmin_c', label: 'Tmin (C)', type: 'nullable_num', step: 0.1 },
            { section: 'Temperature envelope (advanced)', key: 'topt_low_c', label: 'Topt low (C)', type: 'nullable_num', step: 0.1 },
            { section: 'Temperature envelope (advanced)', key: 'topt_high_c', label: 'Topt high (C)', type: 'nullable_num', step: 0.1 },
            { section: 'Temperature envelope (advanced)', key: 'tmax_c', label: 'Tmax (C)', type: 'nullable_num', step: 0.1 }
        ];

        // --- render overrides grouped by section ---
        const overridesTitle = document.createElement('div');
        overridesTitle.textContent = 'Overrides';
        overridesTitle.style.marginTop = '12px';
        overridesTitle.style.fontWeight = '600';
        div.appendChild(overridesTitle);

        const rowsByKey = {};
        let lastSection = null;
        OVERRIDE_SCHEMA.forEach(def => {
            if (def.section !== lastSection) {
                lastSection = def.section;
                const h = document.createElement('div');
                h.textContent = def.section;
                h.style.marginTop = '10px';
                h.style.fontWeight = '600';
                h.style.opacity = '0.9';
                div.appendChild(h);
            }

            const { chk, input, wrap } = makeOverrideRow(def);
            rowsByKey[def.key] = { def, chk, input };

            const r = row(def.label + ':', wrap);
            r.label.style.minWidth = '240px';
            div.appendChild(r.row);
        });

        // --- Buttons ---
        const btns = document.createElement('div');
        btns.style.marginTop = '12px';
        btns.style.display = 'flex';
        btns.style.justifyContent = 'flex-end';
        btns.style.gap = '8px';

        const cancelBtn = mxUtils.button('Cancel', () => div.__cancel());

        const saveBtn = mxUtils.button('Save', async () => {
            try {
                const varietyName = String(nameInput.value || '').trim();
                if (!varietyName) throw new Error('Variety name is required');

                // Build sparse overrides
                const overrides = {};
                for (const key of Object.keys(rowsByKey)) {
                    const { def, chk, input } = rowsByKey[key];
                    if (!chk.checked) continue;
                    overrides[key] = readOverrideValue(def, input);
                }

                // Optional: envelope sanity warning (non-blocking)
                const tmin = overrides.tmin_c ?? baseDict.tmin_c;
                const tlow = overrides.topt_low_c ?? baseDict.topt_low_c;
                const thigh = overrides.topt_high_c ?? baseDict.topt_high_c;
                const tmax = overrides.tmax_c ?? baseDict.tmax_c;
                if ([tmin, tlow, thigh, tmax].every(v => v != null && Number.isFinite(Number(v)))) {
                    if (!(Number(tmin) <= Number(tlow) && Number(tlow) <= Number(thigh) && Number(thigh) <= Number(tmax))) {
                        // warning only
                        console.warn('Variety envelope order is unusual', { tmin, tlow, thigh, tmax });
                    }
                }

                let saved = null;
                if (isEdit) {
                    saved = await PlantVarietyModel.update({
                        varietyId: Number(varietyId),
                        varietyName,
                        overrides
                    });
                } else {
                    saved = await PlantVarietyModel.create({
                        plantId: pid,
                        varietyName,
                        overrides
                    });
                }

                div.__commit(saved);
            } catch (e) {
                mxUtils.alert('Save variety error: ' + (e?.message || String(e)));
            }
        });

        btns.appendChild(cancelBtn);
        btns.appendChild(saveBtn);
        div.appendChild(btns);

        setTimeout(() => { try { nameInput.focus(); nameInput.select(); } catch (_) { } }, 0);

        return await showCommitDialog(ui, { container: div, width: 760, height: 640, modal: true, closable: true });
    }



    // -------------------- Dialog builder ---------------------------------------------------
    async function buildScheduleDialog(ui, cell, plants, cities, onSubmit, options) {
        let plantsLocal = Array.isArray(plants) ? plants.slice() : [];
        const { selectedPlant: initialPlant, earliestFeasibleSowDate, lastHarvestDate, startNote } = options || {};

        // Helper to centralize plant mode (perennial vs annual/biennial)          
        function getModeForPlant(plant) {
            const perennial = !!(plant && plant.isPerennial && plant.isPerennial());
            return { perennial };
        }

        async function reloadPlantsList() {
            const prev = plantSel.value;
            plantsLocal = await PlantModel.listBasic();
            const opts = (plantsLocal || []).map(p => ({
                value: String(p.plant_id),
                label: p.plant_name + (p.abbr ? ` (${p.abbr})` : '')
            }));
            setSelectOptions(plantSel, opts, prev);
            if (!findPlantById(Number(plantSel.value)) && opts[0]) {
                plantSel.value = String(opts[0].value);
            }
        }


        const div = document.createElement('div');
        div.style.padding = '12px'; div.style.width = '600px';

        const inlineButton = (label, onClick) => { const b = mxUtils.button(label, onClick); b.style.marginLeft = '8px'; return b; };

        // Plant selector
        const plantOpts = (plantsLocal || []).map(p => ({ value: String(p.plant_id), label: p.plant_name + (p.abbr ? ` (${p.abbr})` : '') }));
        const plantSel = makeSelect(plantOpts, plantOpts[0]?.value);

        const plantControlsWrap = document.createElement('div');
        plantControlsWrap.style.display = 'flex';
        plantControlsWrap.style.gap = '8px';
        plantControlsWrap.style.alignItems = 'center';
        plantControlsWrap.appendChild(plantSel);

        const addPlantBtn = inlineButton('Add plant', async () => {
            try {
                const saved = await openPlantEditorDialog(ui, { mode: 'add' });
                if (!saved) return;
                await reloadPlantsList();
                plantSel.value = String(saved.plant_id);
                if (!findPlantById(Number(plantSel.value))) {
                    mxUtils.alert('Saved plant was not found in refreshed list.');
                    return;
                }
                plantSel.dispatchEvent(new Event('change'));
            } catch (e) {
                mxUtils.alert('Add plant error: ' + (e?.message || String(e)));
            }
        });

        const editPlantBtn = inlineButton('Edit plant', async () => {
            try {
                const pid = Number(plantSel.value);
                if (!Number.isFinite(pid)) return;
                const saved = await openPlantEditorDialog(ui, { mode: 'edit', plantId: pid });
                if (!saved) return;
                await reloadPlantsList();
                plantSel.value = String(saved.plant_id);
                if (!findPlantById(Number(plantSel.value))) {
                    mxUtils.alert('Saved plant was not found in refreshed list.');
                    return;
                }
                plantSel.dispatchEvent(new Event('change'));
            } catch (e) {
                mxUtils.alert('Edit plant error: ' + (e?.message || String(e)));
            }
        });

        plantControlsWrap.appendChild(addPlantBtn);
        plantControlsWrap.appendChild(editPlantBtn);

        const plantSelectRow = row('Select plant:', plantControlsWrap);
        div.appendChild(plantSelectRow.row);

        const findPlantById = (id) => (plantsLocal || []).find(p => Number(p.plant_id) === Number(id)) || null;

        const fallbackId = (plantOpts[0] ? Number(plantOpts[0].value) : null);
        const initId = Number.isFinite(Number(initialPlant?.plant_id))
            ? Number(initialPlant.plant_id)
            : fallbackId;

        if (!Number.isFinite(initId)) {
            mxUtils.alert('No plants available.');
            return;
        }

        plantSel.value = String(initId);
        let selPlant = findPlantById(initId);
        if (!selPlant) selPlant = await PlantModel.loadById(initId);
        if (!selPlant) { mxUtils.alert('Plant not found.'); return; }

        let mode = getModeForPlant(selPlant);

        let effectivePlant = selPlant;

        function setSelectOptions(selectEl, opts, selectedValue) {
            selectEl.innerHTML = '';
            (opts || []).forEach(o => {
                const opt = document.createElement('option');
                opt.value = String(o.value);
                opt.textContent = o.label;
                selectEl.appendChild(opt);
            });
            if (selectedValue != null) selectEl.value = String(selectedValue);
        }

        async function refreshEffectivePlant() {
            effectivePlant = await resolveEffectivePlant(
                formState.plantId,
                formState.varietyId
            );
            if (!effectivePlant) {
                effectivePlant = selPlant;
            }
            mode = getModeForPlant(effectivePlant);
        }


        const plantRow = document.createElement('div');
        const plantLbl = document.createElement('span'); plantLbl.textContent = 'Plant:';
        const plantNameSpan = document.createElement('span'); plantNameSpan.style.fontWeight = '600';
        plantNameSpan.textContent = selPlant.plant_name;
        plantRow.appendChild(plantLbl); plantRow.appendChild(document.createTextNode(' ')); plantRow.appendChild(plantNameSpan);
        div.appendChild(plantRow); div.appendChild(document.createElement('br'));

        // Variety selector + Add button                                       
        const varietySel = document.createElement('select');
        varietySel.style.width = '100%';
        varietySel.style.padding = '6px';

        const varietyControlsWrap = document.createElement('div');
        varietyControlsWrap.style.display = 'flex';
        varietyControlsWrap.style.gap = '8px';
        varietyControlsWrap.style.alignItems = 'center';
        varietyControlsWrap.appendChild(varietySel);

        const addVarietyBtn = inlineButton('Add variety', async () => {
            try {
                syncStateFromControls();

                const saved = await openVarietyEditorDialog(ui, { mode: 'add', plantId: formState.plantId });
                if (!saved) return;

                await reloadVarietyOptionsForPlant(formState.plantId);

                const savedId = Number(saved?.variety_id ?? saved?.varietyId ?? saved?.id);
                if (Number.isFinite(savedId)) {
                    varietySel.value = String(savedId);
                }

                syncStateFromControls();
                await refreshEffectivePlant();
                resetMethodOptions(effectivePlant);
                await recomputeAll('varietyChanged');
                await refreshTaskTemplateFromSelection();
            } catch (e) {
                mxUtils.alert('Add variety error: ' + (e?.message || String(e)));
            }
        });
        varietyControlsWrap.appendChild(addVarietyBtn);

        const editVarietyBtn = inlineButton('Edit variety', async () => {
            try {
                syncStateFromControls();
                if (!formState.varietyId) {
                    setVarietyStatus('Select a variety to edit.');
                    return;
                }

                setVarietyStatus('');
                const saved = await openVarietyEditorDialog(ui, {
                    mode: 'edit',
                    plantId: formState.plantId,
                    varietyId: formState.varietyId
                });
                if (!saved) return;

                await reloadVarietyOptionsForPlant(formState.plantId);

                const savedId = Number(saved?.variety_id ?? saved?.varietyId ?? formState.varietyId);
                varietySel.value = String(savedId);

                syncStateFromControls();
                await refreshEffectivePlant();
                resetMethodOptions(effectivePlant);
                await recomputeAll('varietyChanged');
                await refreshTaskTemplateFromSelection();
            } catch (e) {
                setVarietyStatus('Edit variety error: ' + (e?.message || String(e)));
            }
        });
        varietyControlsWrap.appendChild(editVarietyBtn);

        const varietyRow = row('Variety:', varietyControlsWrap);
        div.appendChild(varietyRow.row);

        const varietyStatus = document.createElement('div');
        varietyStatus.style.fontSize = '12px';
        varietyStatus.style.color = '#92400e';
        varietyStatus.style.marginTop = '4px';
        varietyStatus.textContent = '';
        div.appendChild(varietyStatus);

        function setVarietyStatus(msg) {
            varietyStatus.textContent = msg || '';
        }

        function syncVarietyButtons() {
            const hasVariety = !!(varietySel && varietySel.value);
            editVarietyBtn.disabled = !hasVariety;
            if (!hasVariety) setVarietyStatus('');
        }

        let currentVarieties = [];
        async function reloadVarietyOptionsForPlant(plantId, selectedVarietyId = null) {
            currentVarieties = await PlantVarietyModel.listByPlantId(Number(plantId));
            const opts = [{ value: '', label: '(base plant)' }]
                .concat(currentVarieties.map(v => ({
                    value: String(v.variety_id),
                    label: String(v.variety_name)
                })));
            const sel = Number.isFinite(Number(selectedVarietyId)) ? String(selectedVarietyId) : '';
            setSelectOptions(varietySel, opts, sel);
        }


        // City & Method
        const cityOpts = cities.map(c => ({ value: c.city_name, label: c.city_name }));
        const citySel = makeSelect(cityOpts, cityOpts[0]?.value);
        const methodSel = document.createElement('select'); methodSel.style.width = '100%'; methodSel.style.padding = '6px';

        function resetMethodOptions(p) {
            const LABELS = {
                'direct_sow': 'direct_sow',
                'transplant_indoor': 'transplant (indoor → field)',
                'transplant_outdoor': 'transplant (field date)'
            };
            const opts = p.allowedMethods().map(v => ({ value: v, label: LABELS[v] || v }));
            methodSel.innerHTML = '';
            opts.forEach(o => {
                const opt = document.createElement('option');
                opt.value = o.value; opt.textContent = o.label;
                methodSel.appendChild(opt);
            });
            methodSel.value = opts[0].value;
        }

        resetMethodOptions(selPlant);

        // Start/End inputs + auto buttons
        const initialStartISO = earliestFeasibleSowDate.toISOString().slice(0, 10);
        const initialEndISO = lastHarvestDate.toISOString().slice(0, 10);

        // Read-only auto-computed bounds                                         
        const autoEarliestInput = makeDate(initialStartISO, true);
        const autoLastSowInput = makeDate(initialStartISO, true);

        // User-controlled first sow date (used for schedule startISO)                   
        const startInput = makeDate(initialStartISO, false);

        // Auto-computed season end constraint (read-only for annuals, editable for perennials)
        const seasonEndInput = makeDate(initialEndISO, true);

        // Schedule-derived last harvest date (always read-only)
        const lastHarvestInput = makeDate(initialEndISO, true);

        let firstSowDirty = false;

        const startNoteSpan = document.createElement('span');
        startNoteSpan.style.marginLeft = '8px'; startNoteSpan.style.fontSize = '12px'; startNoteSpan.style.color = '#92400e';
        startNoteSpan.textContent = startNote || '';

        // --- Harvest window
        const hwDefault = effectivePlant.defaultHW();                              // existing
        const harvestWindowInput = makeNullableNumber(hwDefault ?? null, { min: 0, step: 1 });
        const minYieldMultInput = makeNumber(0.50, { min: 0 }); minYieldMultInput.step = '0.01'; // unchanged (even if unused)

        // --- Season control (single field) ---
        const seasonStartYear0 = Number(cell.getAttribute?.('season_start_year') ?? (new Date()).getUTCFullYear());
        const seasonYearInput = makeNumber(seasonStartYear0, { min: 1900 });
        seasonYearInput.step = '1';

        let taskTemplate = null;
        let taskRules = Array.isArray(taskTemplate?.rules) ? [...taskTemplate.rules] : [];
        // --- task reset helpers ----------------------------------------------------   
        let taskDirty = false;

        function clearCellTaskTemplateUndoable(graph, cell) {
            const model = graph.getModel();
            model.execute(new mxCellAttributeChange(cell, "task_template_json", ""));
            graph.refresh(cell);
        }

        async function loadDefaultsForCurrentSelection() {
            // Factory defaults = code default, not DB “saved defaults”                       
            taskTemplate = getDefaultTaskTemplateForMethod(formState.method);
            taskRules = Array.isArray(taskTemplate?.rules) ? [...taskTemplate.rules] : [];
            taskEditorDiv.innerHTML = "";
            taskDirty = false;
            renderTasksList();
        }

        const saveDefaultChk = makeCheckbox(false);

        // Prefill plant/variety from existing cell attrs                             
        const cellVarietyId0 = (() => {
            const raw = cell?.getAttribute?.('variety_id');
            const n = Number(raw);
            return Number.isFinite(n) && n > 0 ? n : null;
        })();

        // --- Central form state ---------------------------------------------------- 
        const formState = {
            plantId: initId,
            varietyId: cellVarietyId0,
            cityName: citySel.value,
            method: methodSel.value,
            startISO: startInput.value,
            seasonEndISO: seasonEndInput.value,
            seasonStartYear: Number(seasonYearInput.value || (new Date()).getUTCFullYear()),
            harvestWindowDays: (harvestWindowInput.value === '' ? null : Number(harvestWindowInput.value)),
            autoEarliestISO: initialStartISO,                        // auto earliest sow
            lastFeasibleSowISO: null,
            lastHarvestISO: initialEndISO,                           // schedule-derived last harvest
            lastHarvestSource: 'auto'                                // track where it came from
        };




        function syncStateFromControls() {
            formState.plantId = Number(plantSel.value);
            formState.varietyId = (varietySel && varietySel.value) ? Number(varietySel.value) : null;
            formState.cityName = citySel.value;
            formState.method = methodSel.value;
            formState.startISO = startInput.value;
            formState.seasonEndISO = seasonEndInput.value;
            formState.seasonStartYear = Number(seasonYearInput.value || (new Date()).getUTCFullYear());
            formState.harvestWindowDays = (harvestWindowInput.value === '' ? null : Number(harvestWindowInput.value));
        }

        function syncControlsFromState({ start = false, end = false, lastHarvest = false } = {}) {
            if (start && formState.startISO) {
                startInput.value = formState.startISO;
            }
            if (end && formState.seasonEndISO) {
                seasonEndInput.value = formState.seasonEndISO;
            }
            if (lastHarvest && lastHarvestInput) {
                lastHarvestInput.value = formState.lastHarvestISO || '';
            }
            // Other controls are already wired directly from user edits               
        }



        // -------------------- Form schema for simple labeled fields ---------------- 
        const FIELD_SCHEMA = [
            { key: 'seasonStartYear', label: 'Season start year:', control: seasonYearInput },
            { key: 'cityName', label: 'City:', control: citySel },
            { key: 'method', label: 'Method:', control: methodSel },
            { key: 'harvestWindowDays', label: 'Harvest window days:', control: harvestWindowInput },
        ];

        const { fieldRows } = buildFieldRows(FIELD_SCHEMA);
        // ----------------------------------------------------------

        // Load varieties and preselect from cell                                     
        await reloadVarietyOptionsForPlant(formState.plantId, formState.varietyId);
        syncVarietyButtons();                                                        // same

        // Ensure the selected value actually exists; if not, fall back to base plant 
        if (formState.varietyId != null && !String(varietySel.value)) {
            formState.varietyId = null;
        }

        syncStateFromControls();                                                     // MOVED (after setting varietySel) 
        await refreshEffectivePlant();                                                // same
        resetMethodOptions(effectivePlant);                                           // same

        const autoEarliestRowObj = row('Earliest feasible sow:', autoEarliestInput);

        const autoLastSowRowObj = row('Last feasible sow:', autoLastSowInput);

        const firstSowRowObj = row('First sow date:', startInput);
        if (startNote) firstSowRowObj.row.appendChild(startNoteSpan);

        const endRow = row('Season end date:', seasonEndInput);

        const lastHarvestRowObj = row('Last harvest date:', lastHarvestInput);

        appendFieldRows(div, fieldRows, ['seasonStartYear']);
        appendFieldRows(div, fieldRows, ['cityName', 'method', 'harvestWindowDays']); // NEW
        div.appendChild(autoEarliestRowObj.row);
        div.appendChild(autoLastSowRowObj.row);
        div.appendChild(firstSowRowObj.row);
        div.appendChild(endRow.row);
        div.appendChild(lastHarvestRowObj.row);


        const baseStartNote = startNote || '';

        function applyModeToUI() {
            const perennial = mode.perennial;

            // Labels                                                                   
            if (perennial) {
                firstSowRowObj.label.textContent = 'Planting date:';
                endRow.label.textContent = 'Lifespan end:';
                lastHarvestRowObj.row.style.display = 'none';                           // hide schedule last-harvest for perennials
            } else {
                endRow.label.textContent = 'Season end date:';
                lastHarvestRowObj.row.style.display = '';
            }

            // Auto-window visibility                                                   
            autoEarliestRowObj.row.style.display = perennial ? 'none' : '';
            autoLastSowRowObj.row.style.display = perennial ? 'none' : '';

            // End date editability                                                     
            seasonEndInput.disabled = !perennial;
        }


        function updateStartNote() {
            if (!startNoteSpan) return;

            const userISO = formState.startISO;
            const autoStartISO = formState.autoEarliestISO;
            const lastSowISO = formState.lastFeasibleSowISO;

            let status = '';

            if (userISO && autoStartISO) {
                const userD = new Date(userISO + 'T00:00:00Z');
                const autoStartD = new Date(autoStartISO + 'T00:00:00Z');
                const lastSowD = lastSowISO ? new Date(lastSowISO + 'T00:00:00Z') : null;

                if (userD < autoStartD) {
                    status = 'Selected first sow is earlier than the earliest feasible sow.';
                } else if (lastSowD && userD > lastSowD) {
                    status = 'Selected first sow is later than the last feasible sow.';
                } else {
                    status = '';
                }
            }

            const hasFeasibleWindow = !!formState.lastFeasibleSowISO;

            const parts = [];
            if (baseStartNote && !hasFeasibleWindow) parts.push(baseStartNote);
            if (status) parts.push(status);

            startNoteSpan.textContent = parts.join(' ');
        }


        // recomputeAnchors:
        //  - concern: climate feasibility window (earliest sow, last feasible sow, climate last harvest)
        //  - does NOT decide scheduling or yield
        //  - allowed to change seasonEndISO ONLY when called with forceWriteEnd=true
        async function recomputeAnchors(forceWriteStart = false, forceWriteEnd = false) {
            try {
                if (mode.perennial) return;

                syncStateFromControls();

                await refreshEffectivePlant();
                const p = effectivePlant;


                const city = await CityClimate.loadByName(formState.cityName);
                if (!city) return;

                const seasonStartYear = formState.seasonStartYear;

                const env = p.cropTempEnvelope();
                const dailyRates = city.dailyRates(env.Tbase, seasonStartYear);
                const monthlyAvgTemp = city.monthlyMeans();
                const budget = p.firstHarvestBudget();

                const HW_DAYS = formState.harvestWindowDays;
                if (!Number.isFinite(HW_DAYS)) return [];

                const overwinterAllowed = p.isPerennial() || Number(p.overwinter_ok ?? 0) === 1;
                const scanStart = asUTCDate(seasonStartYear, 1, 1);
                const scanEndYear = overwinterAllowed ? (seasonStartYear + 1) : seasonStartYear;
                const scanEndHard = asUTCDate(scanEndYear, 12, 31);

                const soilGateThresholdC = (Number.isFinite(Number(p.soil_temp_min_plant_c))
                    ? Number(p.soil_temp_min_plant_c)
                    : null);

                const methodVal = formState.method;
                const daysTransplant = Number.isFinite(Number(p.days_transplant)) ? Number(p.days_transplant) : 0;

                const lsf = pickFrostByRisk(city, 'p50');

                const r = computeAutoStartEndWindowForward({
                    method: methodVal,
                    budget,
                    HW_DAYS,
                    dailyRatesMap: dailyRates,
                    monthlyAvgTemp,
                    Tbase: env.Tbase,
                    cropTemp: env,
                    scanStart,
                    scanEndHard,
                    soilGateThresholdC,
                    soilGateConsecutiveDays: 3,
                    startCoolingThresholdC: asCoolingThresholdC(p.start_cooling_threshold_c),
                    useSpringFrostGate: !overwinterAllowed,
                    lastSpringFrostDOY: lsf,
                    daysTransplant,
                    overwinterAllowed,
                });

                console.log('[recomputeAnchors] result', {
                    forceWriteStart,
                    forceWriteEnd,
                    startISO_before: formState.startISO,
                    seasonEndISO_before: formState.seasonEndISO,
                    earliestFeasibleSowDate: fmtISO(r.earliestFeasibleSowDate),
                    lastHarvestDate: fmtISO(r.lastHarvestDate),
                    lastFeasibleSowDate: r.lastFeasibleSowDate ? fmtISO(r.lastFeasibleSowDate) : null
                });

                const autoStartISO = r.earliestFeasibleSowDate.toISOString().slice(0, 10);
                const lastSowISO = r.lastFeasibleSowDate ? r.lastFeasibleSowDate.toISOString().slice(0, 10) : null;
                // Store auto window (for display/guidance)                          
                formState.autoEarliestISO = autoStartISO;
                formState.lastFeasibleSowISO = lastSowISO;

                // Optionally reset user-chosen first sow date to earliest           
                if (forceWriteStart || !firstSowDirty) {
                    formState.startISO = autoStartISO;
                }

                // let auto window drive season end when requested                      
                if (forceWriteEnd && r.climateEndDate instanceof Date) {
                    formState.seasonEndISO = r.climateEndDate.toISOString().slice(0, 10);
                }

                // Push values to the read-only controls                              
                if (formState.autoEarliestISO && autoEarliestInput) {
                    autoEarliestInput.value = formState.autoEarliestISO;
                }
                if (autoLastSowInput) {
                    autoLastSowInput.value = formState.lastFeasibleSowISO || '';
                }

                // Push editable fields (first sow & last harvest) as needed          
                syncControlsFromState({
                    start: forceWriteStart || !firstSowDirty,
                    end: forceWriteEnd
                });
                updateStartNote();
            } catch (_) { /* silent */ }
        }

        // --- mode switcher (annual <-> perennial) ---
        function computePerennialEndISO(fromISO, lifespanYears) {
            // if no start yet, anchor to Jan 1 of season year
            const s = fromISO ? new Date(fromISO + 'T00:00:00Z')
                : asUTCDate(Number(seasonYearInput.value), 1, 1);
            const end = new Date(Date.UTC(
                s.getUTCFullYear() + Math.max(1, Math.floor(Number(lifespanYears) || 1)),
                11, 31
            ));
            return end.toISOString().slice(0, 10);
        }

        function setPerennialMode(on, plant) {
            mode = getModeForPlant(plant);

            if (mode.perennial) {
                // Ensure start date exists                                           
                if (!startInput.value) {
                    const sISO = asUTCDate(Number(seasonYearInput.value), 1, 1)
                        .toISOString().slice(0, 10);
                    startInput.value = sISO;
                }

                // Compute lifespan end based on current start                         
                seasonEndInput.value = computePerennialEndISO(
                    startInput.value,
                    plant && Number.isFinite(Number(plant.lifespan_years))
                        ? Number(plant.lifespan_years)
                        : 1
                );

                formState.startISO = startInput.value;
                formState.seasonEndISO = seasonEndInput.value;
                formState.lastHarvestISO = formState.seasonEndISO;                    // tie schedule last-harvest to lifespan end for perennials
                syncStateFromControls();
                firstSowDirty = false;
            } else {
                // Non-perennial: reset HW default and clear dirty flag               
                harvestWindowInput.value = (plant?.defaultHW() ?? '').toString();
                firstSowDirty = false;
                syncStateFromControls();
            }

            applyModeToUI();
        }

        // recomputeAll:
        //  - concern: policy: when to let climate auto window override constraint
        //  - enforce: seasonEndISO may only be set in specific reasons
        async function recomputeAll(reason) {
            syncStateFromControls();

            const isPerennial = mode.perennial;

            if (isPerennial) {
                const endISO = computePerennialEndISO(
                    startInput.value,
                    effectivePlant.lifespan_years
                );

                seasonEndInput.value = endISO;
                formState.seasonEndISO = endISO;

                // For perennials, schedule last harvest == lifespan end                 
                formState.lastScheduleEndISO = endISO;
                formState.lastHarvestSource = 'user';

                if (lastHarvestInput) {
                    lastHarvestInput.value = endISO;
                }

                return;
            }


            switch (reason) {

                case 'varietyChanged': {
                    await recomputeAnchors(true, true);
                    await recomputeLastHarvestFromSchedule();
                    break;
                }

                case 'yearChanged': {
                    // season → refresh both start and end from feasibility
                    await recomputeAnchors(true, true);

                    await recomputeLastHarvestFromSchedule();
                    break;
                }

                case 'plantChanged': {
                    // City/method/plant change → respect user sow date if dirty
                    await recomputeAnchors(true, true);

                    await recomputeLastHarvestFromSchedule();
                    break;
                }

                case 'cityChanged':
                case 'methodChanged': {
                    // City/method change → keep user sow date if dirty,              
                    // but don't force end update unless you want to:                 
                    await recomputeAnchors(false, false);

                    await recomputeLastHarvestFromSchedule();
                    break;
                }

                case 'startChanged':
                    // User explicitly changed first sow; keep it, but recompute schedule 
                    await recomputeAnchors(false, false);
                    await recomputeLastHarvestFromSchedule();
                    break;

                case 'hwChanged': {
                    await recomputeAnchors(false, false);
                    await recomputeLastHarvestFromSchedule();
                    break;
                }

            }

            // Keep everything in sync, including schedule-derived last harvest
            syncControlsFromState({
                start: true,
                end: true,
                lastHarvest: true
            });
            updateStartNote();
        }


        plantSel.addEventListener('change', async () => {
            const newPlant = findPlantById(Number(plantSel.value)); if (!newPlant) return;
            selPlant = newPlant; plantNameSpan.textContent = newPlant.plant_name;

            mode = getModeForPlant(selPlant);

            formState.plantId = Number(plantSel.value);

            // reset varieties for new base plant                               
            await reloadVarietyOptionsForPlant(formState.plantId);
            varietySel.value = '';
            formState.varietyId = null;
            await refreshEffectivePlant();


            resetMethodOptions(effectivePlant);
            formState.method = methodSel.value;

            harvestWindowInput.value = (effectivePlant.defaultHW() ?? '');
            formState.harvestWindowDays = (harvestWindowInput.value === '' ? null : Number(harvestWindowInput.value));


            syncStateFromControls();

            if (effectivePlant.isPerennial()) {
                setPerennialMode(true, effectivePlant);
            } else {
                setPerennialMode(false, effectivePlant);
            }


            // Let the orchestrator recompute feasibility + schedule                      
            await recomputeAll('plantChanged');
            await refreshTaskTemplateFromSelection();
        });

        varietySel.addEventListener('change', async () => {
            syncVarietyButtons();
            syncStateFromControls();
            await refreshEffectivePlant();
            resetMethodOptions(effectivePlant);
            harvestWindowInput.value = (effectivePlant.defaultHW() ?? '');
            formState.harvestWindowDays = (harvestWindowInput.value === '' ? null : Number(harvestWindowInput.value));
            await recomputeAll('varietyChanged');
            await refreshTaskTemplateFromSelection();

        });


        startInput.addEventListener('input', () => {
            firstSowDirty = true;
            syncStateFromControls();
            if (mode.perennial) {
                seasonEndInput.value = computePerennialEndISO(
                    startInput.value,
                    effectivePlant.lifespan_years
                );
                formState.seasonEndISO = seasonEndInput.value;
                updateStartNote();
            } else {
                recomputeAll('startChanged');
            }
        });




        seasonEndInput.addEventListener('input', () => {
            syncStateFromControls();
        });


        seasonYearInput.addEventListener('input', () => {
            recomputeAll('yearChanged');
        });

        citySel.addEventListener('change', () => {
            (async () => {
                await recomputeAll('cityChanged');
            })();
        });
        methodSel.addEventListener('change', async () => {
            await recomputeAll('methodChanged');
            syncStateFromControls();
            await refreshTaskTemplateFromSelection();
        });

        // recomputeLastHarvestFromSchedule:
        //  - concern: full schedule under current constraint
        //  - NEVER changes seasonEndISO, only lastScheduleEndISO / lastHarvestISO
        async function recomputeLastHarvestFromSchedule() {
            try {
                syncStateFromControls();

                const { inputs } = await buildScheduleContextFromForm(formState, selPlant, {
                    currentVarieties
                });


                const { rows, lastScheduledHarvestEndISO } =
                    await computeScheduleResult(inputs);

                if (!rows.length || !lastScheduledHarvestEndISO) {
                    console.log('[recomputeLastHarvestFromSchedule] no rows', {
                        startISO: formState.startISO,
                        seasonEndISO: formState.seasonEndISO,
                        harvestWindowDays: formState.harvestWindowDays,
                    });
                    formState.lastScheduleEndISO = null;
                    if (lastHarvestInput) lastHarvestInput.value = '';
                    return;
                }

                console.log('[recomputeLastHarvestFromSchedule] rows summary', {
                    count: rows.length,
                    first: rows[0],
                    last: rows[rows.length - 1]
                });

                formState.lastScheduleEndISO = lastScheduledHarvestEndISO;
                formState.lastHarvestISO = lastScheduledHarvestEndISO;

                // Update schedule-derived last-harvest field ONLY                        
                if (typeof lastHarvestInput !== 'undefined' && lastHarvestInput) {
                    lastHarvestInput.value = lastScheduledHarvestEndISO;
                }

                console.log('[recomputeLastHarvestFromSchedule] scheduleEnd', {
                    lastScheduleEndISO: formState.lastScheduleEndISO
                });

            } catch (e) {
                console.warn('recomputeLastHarvestFromSchedule error:', e);
            }
        }




        const btns = document.createElement('div');
        btns.style.marginTop = '12px'; btns.style.display = 'flex'; btns.style.justifyContent = 'space-between';
        const rightBtns = document.createElement('div'); rightBtns.style.display = 'flex'; rightBtns.style.gap = '8px';

        const explainBtn = mxUtils.button('Explain season', async () => {
            try {
                syncStateFromControls();

                const { plant, city, inputs } = await buildScheduleContextFromForm(
                    formState,
                    selPlant,
                    { currentVarieties }
                );

                const rows = await explainFeasibilityOverSeason(inputs, 400, false);

                // include plant & city dictionaries
                const plantDict = toPlainDict(plant);
                const cityDict = toPlainDict(city);

                const header = [
                    'Plant data:',
                    JSON.stringify(plantDict, null, 2),
                    '',
                    'City data:',
                    JSON.stringify(cityDict, null, 2),
                    '',
                    'Feasibility scan:'
                ].join('\n');

                const scan = rows.map(r => JSON.stringify(r)).join('\n');
                const text = header + '\n' + scan;

                const div = document.createElement('div');
                div.style.whiteSpace = 'pre'; div.style.maxHeight = '70vh'; div.style.overflow = 'auto';
                div.style.padding = '12px'; div.textContent = text;
                ui.showDialog(div, 720, 480, true, true);
            } catch (e) { mxUtils.alert('Explain error: ' + e.message); }
        });
        rightBtns.insertBefore(explainBtn, rightBtns.firstChild);


        const previewBtn = mxUtils.button('Preview', async () => {
            try {
                syncStateFromControls();

                const { inputs } = await buildScheduleContextFromForm(
                    formState,
                    selPlant,
                    { currentVarieties }
                );

                const rows = await computePreviewRows(inputs);
                if (!rows.length) { mxUtils.alert('No feasible planting dates in the chosen season.'); return; }
                renderPreviewTable(ui, rows);
            } catch (e) { mxUtils.alert('Preview error: ' + e.message); }
        });


        const okBtn = mxUtils.button('OK', async () => {
            try {
                syncStateFromControls();

                const { inputs } = await buildScheduleContextFromForm(
                    formState,
                    selPlant,
                    { currentVarieties }
                );

                // Build taskTemplate object from current rules
                taskTemplate = {
                    version: 1,
                    rules: taskRules
                };

                // Save template if requested
                if (saveDefaultChk.checked) {
                    await TaskTemplateModel.saveForSelection({
                        plantId: formState.plantId,
                        varietyId: formState.varietyId,
                        method: formState.method,
                        template: taskTemplate
                    });
                }

                const graph = ui.editor.graph;
                const model = graph.getModel();

                model.beginUpdate();
                try {
                    // save task template undoably (but execute inside this transaction)
                    model.execute(new mxCellAttributeChange(cell, "task_template_json", JSON.stringify(taskTemplate)));

                    model.execute(new mxCellAttributeChange(cell, 'plant_id', String(formState.plantId)));
                    const isBase = (formState.varietyId == null);

                    model.execute(new mxCellAttributeChange(cell, 'variety_id', isBase ? '' : String(formState.varietyId)));
                    model.execute(new mxCellAttributeChange(cell, 'variety_name', isBase ? '' : String(inputs.varietyName || '')));

                } finally {
                    model.endUpdate();
                }
                graph.refresh(cell);



                await applyScheduleToGraph(ui, cell, inputs);
                ui.hideDialog();
            } catch (e) {
                mxUtils.alert('Scheduling error: ' + e.message);
            }
        });

        const cancelBtn = mxUtils.button('Cancel', () => ui.hideDialog());
        [previewBtn, okBtn, cancelBtn].forEach(b => rightBtns.appendChild(b));
        btns.appendChild(rightBtns); div.appendChild(btns);

        await recomputeAll('cityChanged');        // or 'yearChanged' or 'methodChanged'       

        // ============================================================================
        // TASK TAB UI ADDITION
        // ============================================================================

        // 1. Load existing OR resolve from DB fallback chain                                

        const rawTpl = cell?.getAttribute?.('task_template_json');
        if (rawTpl) {
            try { taskTemplate = JSON.parse(rawTpl); } catch (_) { taskTemplate = null; }
        }

        if (!taskTemplate) {
            taskTemplate = await TaskTemplateModel.resolveFor({
                plantId: formState.plantId,
                varietyId: formState.varietyId,
                method: formState.method
            });
        }

        taskRules = Array.isArray(taskTemplate?.rules) ? [...taskTemplate.rules] : [];

        // 2. Build the Tasks tab body
        const tasksTab = document.createElement("div");
        tasksTab.style.padding = "12px";

        // List container
        const tasksListDiv = document.createElement("div");

        // Render list
        function renderTasksList() {
            tasksListDiv.innerHTML = "";
            if (!taskRules.length) {
                const empty = document.createElement("div");
                empty.textContent = "No tasks defined.";
                tasksListDiv.appendChild(empty);
                return;
            }

            taskRules.forEach((rule, idx) => {
                const wrap = document.createElement("div");
                wrap.style.border = "1px solid #ddd";
                wrap.style.margin = "6px 0";
                wrap.style.padding = "6px";
                wrap.style.display = "flex";
                wrap.style.justifyContent = "space-between";

                const summary = document.createElement("div");
                summary.textContent =
                    `${rule.title} • ${rule.durationDays} day(s) • ${rule.offsetDays} ` +
                    `day(s) ${rule.offsetDirection} ${humanStageLabel(rule.anchorStage)}`;

                const btnWrap = document.createElement("div");
                btnWrap.style.display = "flex";
                btnWrap.style.gap = "6px";

                const editBtn = mxUtils.button("Edit", () => openTaskEditor(rule, idx));
                const delBtn = mxUtils.button("Delete", () => {
                    taskRules.splice(idx, 1);
                    taskDirty = true;
                    renderTasksList();
                });

                btnWrap.appendChild(editBtn);
                btnWrap.appendChild(delBtn);

                wrap.appendChild(summary);
                wrap.appendChild(btnWrap);
                tasksListDiv.appendChild(wrap);
            });
        }

        tasksTab.appendChild(tasksListDiv);

        // 3. Task editor (inline)
        const taskEditorDiv = document.createElement("div");
        tasksTab.appendChild(taskEditorDiv);

        async function refreshTaskTemplateFromSelection() {
            // Do not overwrite if the cell already has a per-plan template 
            const raw = String(cell?.getAttribute?.('task_template_json') || '').trim();
            const hasCellTpl = raw.length > 0;
            if (hasCellTpl || taskDirty) return;

            const resolved = await TaskTemplateModel.resolveFor({
                plantId: formState.plantId,
                varietyId: formState.varietyId,
                method: formState.method
            });

            taskTemplate = resolved;
            taskRules = Array.isArray(taskTemplate?.rules) ? [...taskTemplate.rules] : [];
            taskEditorDiv.innerHTML = '';
            renderTasksList();
        }

        function openTaskEditor(rule, index) {
            taskEditorDiv.innerHTML = "";

            const editing = !!rule;
            const r = rule
                ? JSON.parse(JSON.stringify(rule))
                : {
                    id: "rule_" + Date.now(),
                    title: "",
                    anchorStage: "SOW",
                    offsetDays: 0,
                    offsetDirection: "after",
                    durationDays: 1,
                    repeat: false,
                    repeatEveryDays: 1,
                    repeatUntilMode: "x_times",
                    repeatUntilValue: 1
                };

            // Build form fields
            const titleInput = document.createElement("input");
            titleInput.type = "text";
            titleInput.value = r.title;
            const titleRow = row("Title", titleInput).row;

            const offsetNum = makeNumber(r.offsetDays);
            const offsetDir = makeSelect([
                { value: "before", label: "before" },
                { value: "after", label: "after" }
            ], r.offsetDirection);
            const anchorSel = makeSelect(
                Object.keys(TASK_STAGE_LABELS).map(k => ({
                    value: k,
                    label: TASK_STAGE_LABELS[k]
                })),
                r.anchorStage
            );
            const offsetWrap = document.createElement("div");
            offsetWrap.style.display = "flex";
            offsetWrap.style.gap = "8px";
            offsetWrap.appendChild(offsetNum);
            offsetWrap.appendChild(offsetDir);
            offsetWrap.appendChild(anchorSel);
            const offsetRow = row("Start", offsetWrap).row;

            const durationNum = makeNumber(r.durationDays);
            const durationRow = row("Duration (days)", durationNum).row;

            const repeatChk = makeCheckbox(r.repeat);
            const repeatEveryNum = makeNumber(r.repeatEveryDays);
            const repeatTimesNum = makeNumber(r.repeatUntilValue);
            const repeatRow = row("Repeat", repeatChk).row;

            const repeatConfigDiv = document.createElement("div");
            repeatConfigDiv.style.marginLeft = "20px";
            repeatConfigDiv.style.display = r.repeat ? "" : "none";

            const repeatEveryRow = row("Every (days)", repeatEveryNum).row;
            const repeatTimesRow = row("Times", repeatTimesNum).row;

            repeatConfigDiv.appendChild(repeatEveryRow);
            repeatConfigDiv.appendChild(repeatTimesRow);

            repeatChk.addEventListener("change", () => {
                repeatConfigDiv.style.display = repeatChk.checked ? "" : "none";
            });

            taskEditorDiv.appendChild(titleRow);
            taskEditorDiv.appendChild(offsetRow);
            taskEditorDiv.appendChild(durationRow);
            taskEditorDiv.appendChild(repeatRow);
            taskEditorDiv.appendChild(repeatConfigDiv);

            const btnWrap = document.createElement("div");
            btnWrap.style.marginTop = "8px";
            btnWrap.style.display = "flex";
            btnWrap.style.gap = "8px";

            const saveBtn = mxUtils.button("Save", () => {
                r.title = titleInput.value.trim();
                r.offsetDays = Number(offsetNum.value);
                r.offsetDirection = offsetDir.value;
                r.anchorStage = anchorSel.value;
                r.durationDays = Number(durationNum.value);
                r.repeat = repeatChk.checked;
                r.repeatEveryDays = Number(repeatEveryNum.value);
                r.repeatUntilMode = "x_times";
                r.repeatUntilValue = Number(repeatTimesNum.value);

                if (editing) taskRules[index] = r;
                else taskRules.push(r);
                taskDirty = true;

                taskEditorDiv.innerHTML = "";
                renderTasksList();
            });

            const cancelBtn = mxUtils.button("Cancel", () => {
                taskEditorDiv.innerHTML = "";
            });

            btnWrap.appendChild(saveBtn);
            btnWrap.appendChild(cancelBtn);
            taskEditorDiv.appendChild(btnWrap);
        }

        // Add "Add Task" button
        const addTaskBtn = mxUtils.button("Add Task", () => openTaskEditor(null, null));
        addTaskBtn.style.marginTop = "12px";
        tasksTab.appendChild(addTaskBtn);

        // Reset to defaults button                                                    
        const resetTasksBtn = mxUtils.button("Reset to defaults", async () => {
            try {
                syncStateFromControls();

                const graph = ui.editor.graph;
                clearCellTaskTemplateUndoable(graph, cell);   // remove per-plan override

                await loadDefaultsForCurrentSelection();      // refresh UI list
            } catch (e) {
                mxUtils.alert("Reset tasks error: " + (e?.message || String(e)));
            }
        });
        resetTasksBtn.style.marginTop = "8px";
        tasksTab.appendChild(resetTasksBtn);


        // Save default checkbox
        tasksTab.appendChild(
            row("Save these tasks as default", saveDefaultChk).row
        );


        // ============================================================================
        // TABS WRAPPER
        // ============================================================================

        const tabsContainer = document.createElement("div");
        tabsContainer.style.display = "flex";
        tabsContainer.style.flexDirection = "column";
        tabsContainer.style.height = "100%";

        const tabsHeader = document.createElement("div");
        tabsHeader.style.display = "flex";
        tabsHeader.style.gap = "8px";
        tabsHeader.style.marginBottom = "8px";

        const tabsBody = document.createElement("div");
        tabsBody.style.flex = "1";
        tabsBody.style.overflow = "auto";

        function makeTabButton(label, targetEl) {
            const b = mxUtils.button(label, () => {
                tabsBody.innerHTML = "";
                tabsBody.appendChild(targetEl);
            });
            b.style.minWidth = "100px";
            return b;
        }

        const scheduleTabBtn = makeTabButton("Schedule", div);
        const tasksTabBtn = makeTabButton("Tasks", tasksTab);

        tabsHeader.appendChild(scheduleTabBtn);
        tabsHeader.appendChild(tasksTabBtn);
        tabsBody.appendChild(div);

        tabsContainer.appendChild(tabsHeader);
        tabsContainer.appendChild(tabsBody);

        // INITIAL RENDER
        renderTasksList();

        ui.showDialog(tabsContainer, 620, 560, true, true);


        // inner helpers (closure over UI controls)
        async function computePreviewRows(inputs) {
            const { rows } = await computeScheduleResult(inputs);
            return rows;
        }
    }



    // ============================================================================
    // Task Template Model (In-Memory + Cell Persistence)
    // ============================================================================

    // canonical stage names
    const TASK_STAGE_LABELS = {
        SOW: "Sow",
        GERM: "Germination",
        TRANSPLANT: "Transplant",
        HARVEST_START: "Harvest start",
        HARVEST_END: "Harvest end"
    };

    function humanStageLabel(stage) {
        return TASK_STAGE_LABELS[stage] || stage;
    }

    function prepAnchorFor(method) {
        return method === "direct_sow" ? "SOW" : "TRANSPLANT";
    }

    function getDefaultTaskTemplateForMethod(method) {
        // Base rules common to all methods (harvest + thin)                   
        const common = [
            {
                id: "thin",
                title: "Thin / check {plant}",
                anchorStage: "GERM",
                offsetDays: 7,
                offsetDirection: "after",
                durationDays: 7,
                repeat: false
            },
            {
                id: "harvest",
                title: "Harvest – {plant}",
                anchorStage: "HARVEST_START",
                offsetDays: 0,
                offsetDirection: "after",
                durationDays: 0, // HARVEST_START → HARVEST_END
                repeat: false
            }
        ];

        if (method === "direct_sow") {
            return {
                version: 1,
                rules: [
                    {
                        id: "prep",
                        title: "Prep bed for {plant}",
                        anchorStage: prepAnchorFor(method),
                        offsetDays: 3,
                        offsetDirection: "before",
                        durationDays: 3,
                        repeat: false
                    },
                    {
                        id: "sow",
                        title: "Sow {plant}",
                        anchorStage: "SOW",
                        offsetDays: 0,
                        offsetDirection: "after",
                        durationDays: 7,
                        repeat: false
                    },
                    ...common
                ]
            };
        }

        if (method === "transplant_indoor") {
            return {
                version: 1,
                rules: [
                    {
                        id: "prep",
                        title: "Prep bed for {plant}",
                        anchorStage: prepAnchorFor(method),
                        offsetDays: 3,
                        offsetDirection: "before",
                        durationDays: 3,
                        repeat: false
                    },
                    {
                        id: "start",
                        title: "Start {plant} indoors",
                        anchorStage: "SOW", // indoor sow date
                        offsetDays: 0,
                        offsetDirection: "after",
                        durationDays: 0,
                        repeat: false
                    },
                    {
                        id: "harden",
                        title: "Harden off {plant}",
                        anchorStage: "TRANSPLANT",
                        offsetDays: 7,
                        offsetDirection: "before",
                        durationDays: 7,
                        repeat: false
                    },
                    {
                        id: "transplant",
                        title: "Transplant {plant}",
                        anchorStage: "TRANSPLANT",
                        offsetDays: 0,
                        offsetDirection: "after",
                        durationDays: 7,
                        repeat: false
                    },
                    ...common
                ]
            };
        }

        if (method === "transplant_outdoor") {
            // Choose whether we include indoor work; here: minimal field-focused set.
            return {
                version: 1,
                rules: [
                    {
                        id: "prep",
                        title: "Prep bed for {plant}",
                        anchorStage: prepAnchorFor(method),
                        offsetDays: 3,
                        offsetDirection: "before",
                        durationDays: 3,
                        repeat: false
                    },
                    {
                        id: "harden",
                        title: "Harden off {plant}",
                        anchorStage: "TRANSPLANT",
                        offsetDays: 7,
                        offsetDirection: "before",
                        durationDays: 7,
                        repeat: false
                    },
                    {
                        id: "transplant",
                        title: "Transplant {plant}",
                        anchorStage: "TRANSPLANT",
                        offsetDays: 0,
                        offsetDirection: "after",
                        durationDays: 7,
                        repeat: false
                    },
                    ...common
                ]
            };
        }

        // Fallback: original generic template (for unknown methods)            
        return {
            version: 1,
            rules: [
                {
                    id: "prep",
                    title: "Prep bed for {plant}",
                    anchorStage: prepAnchorFor(method),
                    offsetDays: 3,
                    offsetDirection: "before",
                    durationDays: 3,
                    repeat: false
                },
                {
                    id: "sow",
                    title: "Sow {plant}",
                    anchorStage: "SOW",
                    offsetDays: 0,
                    offsetDirection: "after",
                    durationDays: 7,
                    repeat: false
                },
                {
                    id: "thin",
                    title: "Thin / check {plant}",
                    anchorStage: "GERM",
                    offsetDays: 7,
                    offsetDirection: "after",
                    durationDays: 7,
                    repeat: false
                },
                {
                    id: "start",
                    title: "Start {plant} indoors",
                    anchorStage: "SOW",
                    offsetDays: 0,
                    offsetDirection: "after",
                    durationDays: 0,
                    repeat: false
                },
                {
                    id: "harden",
                    title: "Harden off {plant}",
                    anchorStage: "TRANSPLANT",
                    offsetDays: 7,
                    offsetDirection: "before",
                    durationDays: 7,
                    repeat: false
                },
                {
                    id: "transplant",
                    title: "Transplant {plant}",
                    anchorStage: "TRANSPLANT",
                    offsetDays: 0,
                    offsetDirection: "after",
                    durationDays: 7,
                    repeat: false
                },
                {
                    id: "harvest",
                    title: "Harvest – {plant}",
                    anchorStage: "HARVEST_START",
                    offsetDays: 0,
                    offsetDirection: "after",
                    durationDays: 0,
                    repeat: false
                }
            ]
        };
    }


    // Load template from cell or fallback
    function loadTaskTemplateFromCell(cell, method) {
        const raw = cell.getAttribute && cell.getAttribute("task_template_json");
        if (raw) {
            try {
                return JSON.parse(raw);
            } catch (_) {
                console.warn("Invalid task_template_json");
            }
        }
        return getDefaultTaskTemplateForMethod(method);
    }


































































    function stampPlanSummary(cell, {
        plant, city, method, Tbase,
        scheduleDates, plants, timelines,
        expectedTotalYield,
        varietyId = null,
        varietyName = ''
    }) {
        const fmt = (d) => (d ? d.toISOString().slice(0, 10) : null);

        if (Number.isFinite(Number(plant.start_cooling_threshold_c))) {
            setAttr(cell, 'start_cooling_threshold_c', String(plant.start_cooling_threshold_c));
        }

        setAttr(cell, 'label', plant.plant_name + ' group');

        setAttr(cell, 'plant_id', String(plant.plant_id));
        setAttr(cell, 'plant_name', plant.plant_name);
        setAttr(cell, 'plant_abbr', String(plant.abbr || ''));
        setAttr(cell, 'city_name', city.city_name);
        setAttr(cell, 'method', method);
        setAttr(cell, 'variety_id', String(varietyId ?? ''));
        setAttr(cell, 'variety_name', String(varietyName || ''));

        setAttr(cell, 'tbase_c', String(Tbase));

        const sow0 = scheduleDates && scheduleDates[0] ? scheduleDates[0] : null;
        const tl0 = timelines && timelines[0] ? timelines[0] : {};

        setAttr(cell, 'sow_date', fmt(sow0));
        setAttr(cell, 'germ_date', fmt(tl0.germ));
        setAttr(cell, 'transplant_date', fmt(tl0.transplant));
        setAttr(cell, 'maturity_date', fmt(tl0.maturity));
        setAttr(cell, 'harvest_start', fmt(tl0.harvestStart));
        setAttr(cell, 'harvest_end', fmt(tl0.harvestEnd));
    }


    async function applyScheduleToGraph(ui, cell, inputs) {
        const { plant, city, method } = inputs;
        const { startDate, seasonEnd, env, dailyRates, monthlyAvg } = inputs.derived();

        const budget = plant.firstHarvestBudget();
        if (!budget || !Number.isFinite(budget.amount) || budget.amount <= 0) {
            throw new Error("Invalid maturity budget for " + plant.plant_name);
        }

        // Single-planting model: schedule is exactly one start date. 
        const schedule = [startDate];
        if (!(schedule[0] instanceof Date)) {
            throw new Error("Invalid start date for scheduling.");
        }

        const stageDays = {
            maturityDays: Number.isFinite(Number(plant.days_maturity)) && Number(plant.days_maturity) > 0
                ? Number(plant.days_maturity)
                : (budget.mode === "days" ? budget.amount : 0),                               // same intent
            transplantDays: Number.isFinite(Number(plant.days_transplant)) ? Number(plant.days_transplant) : 0,
            germinationDays: Number.isFinite(Number(plant.days_germ)) ? Number(plant.days_germ) : 0,
        };

        const timelines = computeStageTimelineForSchedule({
            schedule,
            budget,
            stageDays,
            dailyRatesMap: dailyRates,
            seasonEnd
        });

        // Plants allocation is single-group only.                                             
        // Prefer an explicit per-group requirement if you already store it.                   
        const plantsReqRaw =
            cell?.getAttribute?.("plants_required") ??
            cell?.getAttribute?.("plantsReq") ??
            cell?.getAttribute?.("actualPlants") ??
            "";

        const plantsReq = (() => {
            const n = Number(String(plantsReqRaw).trim());
            return Number.isFinite(n) && n >= 0 ? n : 0;
        })();

        const plantsAlloc = [plantsReq];

        const ypp = (() => {
            const v =
                (typeof plant.yieldPerPlant === 'function'
                    ? plant.yieldPerPlant()
                    : plant.yield_per_plant_kg);

            const n = Number(v);
            return Number.isFinite(n) && n > 0 ? n : 0;
        })();

        // Build tasks from a single planting timeline
        function buildTasksForPlan({
            method,
            plant,
            schedule,
            timelines,
            taskTemplate
        }) {
            const tasks = [];
            const plantName = plant?.plant_name || plant?.abbr || "Plant";

            const rules = (taskTemplate && Array.isArray(taskTemplate.rules))
                ? taskTemplate.rules
                : getDefaultTaskTemplateForMethod(method).rules;

            // Force single planting: use the first schedule/timeline entry only          
            const sowDate = Array.isArray(schedule) ? schedule[0] : schedule;
            const tl = Array.isArray(timelines) ? timelines[0] : timelines;
            if (!sowDate || !tl) return tasks;

            function substituteTitle(template, { plantName }) {
                let t = template || "";
                t = t.replace(/\{plant\}/g, plantName);
                t = t.replace(/\{succ\}/g, ""); // remove any legacy {succ} token         
                return t;
            }

            function anchorDatesForTimeline(tl, sowDate) {
                return {
                    SOW: iso(sowDate),
                    GERM: iso(tl.germ),
                    TRANSPLANT: iso(tl.transplant),
                    HARVEST_START: iso(tl.harvestStart),
                    HARVEST_END: iso(tl.harvestEnd)
                };
            }

            const anchors = anchorDatesForTimeline(tl, sowDate);

            for (const rule of rules) {
                const stage = rule.anchorStage || "SOW";
                let anchorISO = anchors[stage];

                // Optional fallback for missing GERM: use SOW
                if (!anchorISO && stage === "GERM") {
                    anchorISO = anchors.SOW || null;
                }

                if (!anchorISO) continue;

                const offsetDays = Number(rule.offsetDays || 0);
                const dir = rule.offsetDirection === "before" ? -1 : 1;

                const baseISO = shiftDays(anchorISO, dir * offsetDays);

                // Determine endISO based on duration and/or HARVEST_END special case
                let startISO = baseISO;
                let endISO = baseISO;

                const dur = Number(rule.durationDays || 0);

                if (dur > 0) {
                    endISO = shiftDays(baseISO, dur);
                } else {
                    // Special-case: harvest rule spans HARVEST_START → HARVEST_END if available
                    if (stage === "HARVEST_START" && anchors.HARVEST_END) {
                        startISO = baseISO;
                        endISO = anchors.HARVEST_END;
                    }
                }

                // Handle repeat
                const repeat = !!rule.repeat;
                const every = Number(rule.repeatEveryDays || 0);
                const untilMode = rule.repeatUntilMode || "x_times";
                const untilVal = Number(rule.repeatUntilValue || 0);

                const occurrences = [];

                if (!repeat || every <= 0 || untilVal <= 0) {
                    occurrences.push({ startISO, endISO });
                } else if (untilMode === "x_times") {
                    let curStart = startISO;
                    let curEnd = endISO;
                    for (let k = 0; k < untilVal; k++) {
                        occurrences.push({ startISO: curStart, endISO: curEnd });
                        curStart = shiftDays(curStart, every);
                        curEnd = shiftDays(curEnd, every);
                    }
                } else {
                    occurrences.push({ startISO, endISO });
                }

                const baseTitle = substituteTitle(rule.title || "", { plantName });
                const finalTitle = baseTitle || `Task for ${plantName}`;

                for (const occ of occurrences) {
                    if (!occ.startISO && !occ.endISO) continue;
                    const s = occ.startISO || occ.endISO;
                    const e = occ.endISO || occ.startISO;

                    tasks.push({
                        title: finalTitle,
                        startISO: s,
                        endISO: e,
                        plant_name: plantName,
                        rule_id: rule.id || null,
                        anchorStage: stage
                    });
                }
            }

            return tasks;
        }

        function emitTasksForPlan({
            method,
            plant,
            cell,
            schedule,
            timelines
        }) {
            const taskTemplate = loadTaskTemplateFromCell(cell, method);

            const tasks = buildTasksForPlan({
                method,
                plant,
                schedule,
                timelines,
                taskTemplate
            });

            const detail = {
                tasks,
                plantName: plant.plant_name,
                targetGroupId: cell.id
            };

            try {
                window.dispatchEvent(new CustomEvent("tasksCreated", { detail }));
            } catch (_) { }

            return tasks;
        }

        const graph = ui.editor.graph;
        const model = graph.getModel();

        const unit = 'kg';
        setAttr(cell, 'season_start_year', String(inputs.seasonStartYear));

        model.beginUpdate();
        try {
            if (budget.mode === 'gdd') {
                setAttr(cell, 'gdd_to_maturity', String(budget.amount));
                setAttr(cell, 'days_maturity', '');
            } else {
                setAttr(cell, 'days_maturity', String(budget.amount));
                setAttr(cell, 'gdd_to_maturity', '');
            }

            setAttr(cell, 'variety_id', String(inputs.varietyId ?? ''));
            setAttr(cell, 'variety_name', String(inputs.varietyName || ''));

            stampPlanSummary(cell, {
                plant,
                city,
                method,
                Tbase: env.Tbase,
                scheduleDates: schedule,
                plants: plantsAlloc,
                timelines: timelines,
                varietyId: inputs.varietyId,
                varietyName: inputs.varietyName
            });

            setAttr(cell, 'plant_yield', String(ypp));
            setAttr(cell, 'yield_unit', unit);

            applyPlantSpacingToGroup(cell, plant);

            const r = (window.USL && window.USL.tiler && window.USL.tiler.retileGroup) || null;
            if (typeof r === 'function') r(graph, cell);
            graph.refresh(cell);

        } finally {
            model.endUpdate();
        }

        emitTasksForPlan({
            method,
            plant,
            cell,
            schedule: schedule,
            timelines: timelines
        });
    }

























































    // -------------------- Orchestrator: open schedule dialog --------------------------------
    async function openScheduleDialog(ui, cell) {
        // 1) Load reference data
        const plants = await PlantModel.listBasic();
        const cities = await CityClimate.loadAll();
        if (!cities.length) throw new Error('Cities not available');

        // 2) Selected plant: fall back if cell has no plant_name
        const plantNameAttr = cell && cell.getAttribute && cell.getAttribute('plant_name');
        let selectedPlant = null;
        if (plantNameAttr) {
            selectedPlant = await PlantModel.loadByName(plantNameAttr);
            if (!selectedPlant) throw new Error(`Plant not found: ${plantNameAttr}`);
        } else {
            if (!plants.length) throw new Error('No plants available');
            selectedPlant = plants[0];
        }

        // 3) Initial city & method
        const year = (new Date()).getUTCFullYear();
        const todayUTC = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
        const groupCityName = (cell && cell.getAttribute && cell.getAttribute('city_name')) || null;
        const initialCityName = groupCityName || (cities[0].city_name || cities[0]);
        const methodPreview = (selectedPlant.allowedMethods?.()[0]) || 'direct_sow';

        const cityInit = await CityClimate.loadByName(initialCityName);
        if (!cityInit) throw new Error(`City not found: ${initialCityName}`);

        const env = selectedPlant.cropTempEnvelope();
        const dailyRates = cityInit.dailyRates(env.Tbase, year);
        const monthlyAvgTemp = cityInit.monthlyMeans();
        const budget = selectedPlant.firstHarvestBudget();

        // --- compute initial auto anchors safely ---
        const overwinterAllowed0 = selectedPlant.isPerennial() || Number(selectedPlant.overwinter_ok ?? 0) === 1;
        const scanStart = asUTCDate(year, 1, 1);
        const scanEndHard = asUTCDate(overwinterAllowed0 ? (year + 1) : year, 12, 31);


        // HW_DAYS may be null (perennials etc.)
        const HW_DAYS = selectedPlant.defaultHW(); // may be null

        let earliestFeasibleSowDate = new Date(scanStart);
        let lastHarvestDate = new Date(scanEndHard);

        if (Number.isFinite(HW_DAYS)) {
            const { earliestFeasibleSowDate: a, lastHarvestDate: b } = computeAutoStartEndWindowForward({
                method: methodPreview,
                budget: budget,
                HW_DAYS: HW_DAYS,
                dailyRatesMap: dailyRates,
                monthlyAvgTemp: monthlyAvgTemp,
                Tbase: env.Tbase,
                cropTemp: env,
                scanStart,
                scanEndHard,
                soilGateThresholdC: (Number.isFinite(Number(selectedPlant.soil_temp_min_plant_c))
                    ? Number(selectedPlant.soil_temp_min_plant_c)
                    : null),
                soilGateConsecutiveDays: 3,
                startCoolingThresholdC: asCoolingThresholdC(selectedPlant.start_cooling_threshold_c),
                overwinterAllowed: overwinterAllowed0
            });
            earliestFeasibleSowDate = a;
            lastHarvestDate = b;
        }


        // no stray reassignments like: earliestFeasibleSowDate = a; lastHarvestDate = b;  <-- remove these

        let previewStart = earliestFeasibleSowDate;
        let startNote = '';

        // If we have a finite harvest window, we can run feasibility tweaks.
        // (For perennials / null HW_DAYS we skip this step but still open the dialog.)
        if (Number.isFinite(HW_DAYS)) {
            const inputs0 = new ScheduleInputs({
                plant: selectedPlant,
                city: cityInit,
                method: methodPreview,
                startISO: earliestFeasibleSowDate.toISOString().slice(0, 10),
                seasonEndISO: lastHarvestDate.toISOString().slice(0, 10),
                policy: PolicyFlags.fromPlant(selectedPlant, methodPreview),
                seasonStartYear: year
            });

            const planner0 = new Planner(inputs0);
            const feasToday = planner0.isSowFeasible(todayUTC);
            const feasStart = planner0.isSowFeasible(previewStart);

            if (dateLTE(previewStart, addDaysUTC(todayUTC, -1))) {
                if (feasToday.ok) {
                    startNote = `Start date was before today; set to today (${todayUTC.toISOString().slice(0, 10)}).`;
                    previewStart = todayUTC;
                } else {
                    const nxt = planner0.findNextFeasible(todayUTC, 366);
                    if (nxt.date) {
                        startNote = `Start date was before today; advanced to next valid date (${nxt.date.toISOString().slice(0, 10)}).`;
                        previewStart = nxt.date;
                    } else {
                        startNote = `No valid start date remains this season.`;
                    }
                }
            }
        }

        // Always open the dialog (even when HW_DAYS is null/perennial)
        await buildScheduleDialog(ui, cell, plants, cities, async (_form) => { /* handled inside builder */ }, {
            selectedPlant,
            earliestFeasibleSowDate: previewStart,
            lastHarvestDate,
            startNote
        });
    }

    const USL_DEBUG_HARVEST_WINDOWS = true;





    // -------------------- Public API --------------------------------------------------------
    window.USL = window.USL || {};
    window.USL.scheduler = Object.assign({}, window.USL.scheduler, {
        openScheduleDialog: (ui, cell) => openScheduleDialog(ui, cell)
    });
    window.openUSLScheduleDialog = window.USL.scheduler.openScheduleDialog;

    // -------------------- Plugin entry: add popup menu item --------------------------------
    Draw.loadPlugin(function (ui) {
        const graph = ui.editor.graph;

        // --- Harvest window bridge (installed once) ---
        if (!graph.__uslHarvestWindowsBridgeInstalled) {
            graph.__uslHarvestWindowsBridgeInstalled = true;
            console.log('[USL][Scheduler] harvest windows bridge installed'); // debug

            window.addEventListener("usl:harvestWindowsNeeded", async (ev) => {
                console.log("[Scheduler] suggest fn head:", String(suggestHarvestWindowForCropReq).slice(0, 120));
                console.log("[Scheduler] normalize in listener scope:", typeof normalizeUtcMidnight);

                const d = ev?.detail;
                if (!d) return;

                const moduleCellId = String(d.moduleCellId || "").trim();
                const year = Number(d.year);
                const crops = Array.isArray(d.crops) ? d.crops : [];
                if (!moduleCellId || !Number.isFinite(year) || year < 1900 || year > 3000) return;
                if (!crops.length) return;

                const moduleCell = graph.getModel().getCell(moduleCellId);
                if (!moduleCell) return;

                const cityName = String(moduleCell.getAttribute?.("city_name") || "").trim();
                if (!cityName) {
                    emitHarvestWindowsSuggested(moduleCellId, year, crops.map(c => ({
                        cropId: c.cropId, harvestStart: null, harvestEnd: null, shelfLifeDays: null,
                        reason: "Module city_name not set"
                    })));
                    return;
                }

                const results = [];
                for (const req of crops) {
                    results.push(await suggestHarvestWindowForCropReq(req, cityName, year));
                }
                emitHarvestWindowsSuggested(moduleCellId, year, results);
            });
        }

        function emitHarvestWindowsSuggested(moduleCellId, year, results) {
            if (USL_DEBUG_HARVEST_WINDOWS) {
                console.groupCollapsed('[USL][Scheduler] emit usl:harvestWindowsSuggested');
                console.log('moduleCellId:', moduleCellId);
                console.log('year:', year);
                console.log('results:', JSON.parse(JSON.stringify(results)));
                console.groupEnd();
            }

            try {
                window.dispatchEvent(new CustomEvent("usl:harvestWindowsSuggested", {
                    detail: { moduleCellId, year, results }
                }));
            } catch (e) {
                console.error('[USL][Scheduler] Failed to dispatch usl:harvestWindowsSuggested', e);
            }
        }


        console.log("[Scheduler] defining normalizeUtcMidnight now");

        function normalizeUtcMidnight(d) {
            return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
        }

        function toYmdUTC(d) {
            if (!d) return null;
            return normalizeUtcMidnight(d).toISOString().slice(0, 10);
        }

        function findPrevFeasible(planner, endCandidate, maxDays) {
            let d = normalizeUtcMidnight(endCandidate);
            const C = planner.ctx;

            if (d > C.scanEndHard) d = normalizeUtcMidnight(C.scanEndHard);
            if (d < C.scanStart) return { date: null, info: null };

            for (let i = 0; i <= maxDays && d >= C.scanStart; i++) {
                const info = planner.isSowFeasible(d);
                if (info.ok) return { date: d, info };
                d = planner.addDays(d, -1);
            }
            return { date: null, info: null };
        }

        async function suggestHarvestWindowForCropReq(req, cityName, year) {
            const cropId = String(req?.cropId || "");
            const plantId = (req?.plantId != null) ? Number(req.plantId) : NaN;
            const varietyId = (req?.varietyId != null && req.varietyId !== "") ? Number(req.varietyId) : null;

            if (!cropId || !Number.isFinite(plantId)) {
                return { cropId, harvestStart: null, harvestEnd: null, shelfLifeDays: null, reason: "Missing cropId/plantId" };
            }

            try {
                const plant = await resolveEffectivePlant(plantId, varietyId);
                if (!plant) return { cropId, harvestStart: null, harvestEnd: null, shelfLifeDays: null, reason: "Plant not found" };

                const city = await CityClimate.loadByName(cityName);
                if (!city) return { cropId, harvestStart: null, harvestEnd: null, shelfLifeDays: null, reason: "City not found" };

                const method = String(req?.method || "direct_sow");

                let hw = Number(plant.harvest_window_days ?? (typeof plant.defaultHW === "function" ? plant.defaultHW() : NaN));
                if (!Number.isFinite(hw) || hw <= 0) hw = 14; // planning fallback

                const policy = PolicyFlags.fromPlant(plant, method);

                const inputs = new ScheduleInputs({
                    plant, city, method,
                    startISO: `${year}-01-01`,
                    seasonEndISO: `${year}-12-31`,
                    policy,
                    seasonStartYear: year,
                    varietyId, varietyName: ""
                });

                const planner = new Planner(inputs);
                const C = planner.ctx;

                const maxSpanDays = Math.ceil((C.scanEndHard.getTime() - C.scanStart.getTime()) / 86400000) + 2;

                const first = planner.findNextFeasible(C.scanStart, maxSpanDays);
                if (!first?.date || !first?.info?.ok) {
                    return { cropId, harvestStart: null, harvestEnd: null, shelfLifeDays: null, reason: "No feasible sow date found in scan window" };
                }

                const last = findPrevFeasible(planner, C.scanEndHard, maxSpanDays);
                if (!last?.date || !last?.info?.ok) {
                    return {
                        cropId,
                        harvestStart: toYmdUTC(first.info.harvestStart),
                        harvestEnd: toYmdUTC(first.info.harvestEnd),
                        shelfLifeDays: null,
                        reason: "No late-season feasible sow date found"
                    };
                }

                const shelfLifeDays =
                    Number.isFinite(Number(plant.shelf_life_days)) ? Number(plant.shelf_life_days) : null;

                // ordering sanity
                if (last.info.harvestEnd < first.info.harvestStart) {
                    return {
                        cropId,
                        harvestStart: toYmdUTC(first.info.harvestStart),
                        harvestEnd: toYmdUTC(first.info.harvestEnd),
                        shelfLifeDays,
                        reason: "Late harvest end < early harvest start (constraints)"
                    };
                }

                return {
                    cropId,
                    harvestStart: toYmdUTC(first.info.harvestStart),
                    harvestEnd: toYmdUTC(last.info.harvestEnd),
                    shelfLifeDays
                };
            } catch (e) {
                return { cropId, harvestStart: null, harvestEnd: null, shelfLifeDays: null, reason: String(e?.message || e) };
            }
        }


        if (graph.popupMenuHandler) graph.popupMenuHandler.selectOnPopup = false;

        const oldCreateMenu = graph.popupMenuHandler.factoryMethod;
        graph.popupMenuHandler.factoryMethod = function (menu, cell, evt) {
            if (oldCreateMenu) oldCreateMenu.apply(this, arguments);

            function hitTestCell(evt, cellArg) {
                try {
                    if (evt && typeof graph.popupMenuHandler.getCellForEvent === 'function') {
                        return graph.popupMenuHandler.getCellForEvent(evt);
                    }
                    if (evt && (evt.clientX != null) && (evt.clientY != null)) {
                        const x = mxEvent.getClientX ? mxEvent.getClientX(evt) : evt.clientX;
                        const y = mxEvent.getClientY ? mxEvent.getClientY(evt) : evt.clientY;
                        const pt = mxUtils.convertPoint(graph.container, x, y);
                        return graph.getCellAt(pt.x, pt.y);
                    }
                } catch (_) { /* noop */ }
                if (cellArg) return cellArg;
                return graph.getSelectionCell() || null;
            }

            function findTilerGroupAncestorLocal(graph, c) {
                if (!c) return null;
                const m = graph.getModel();
                let cur = c;
                while (cur) {
                    if (isTilerGroup(cur)) return cur;
                    cur = m.getParent(cur);
                }
                return null;
            }

            const hit = hitTestCell(evt, cell);
            let target = findTilerGroupAncestorLocal(graph, hit);
            if (!target) {
                const sel = graph.getSelectionCell();
                target = findTilerGroupAncestorLocal(graph, sel);
            }

            menu.addSeparator();

            if (target) {
                const hasPlant = !!(target && target.getAttribute && target.getAttribute('plant_name'));

                if (!hasPlant) {
                    menu.addItem('Set Plant…', null, async function () {
                        try {
                            const allPlants = await PlantModel.listBasic();
                            if (!allPlants.length) { mxUtils.alert('No plants found in database.'); return; }

                            // Simple picker
                            const div = document.createElement('div');
                            div.style.padding = '12px';
                            div.style.width = '420px';
                            const title = document.createElement('div');
                            title.textContent = 'Select Plant'; title.style.fontWeight = '600'; title.style.marginBottom = '8px';
                            div.appendChild(title);
                            const sel = document.createElement('select'); sel.style.width = '100%'; sel.style.padding = '6px'; sel.style.margin = '8px 0';
                            allPlants.forEach(p => {
                                const opt = document.createElement('option');
                                opt.value = String(p.plant_id);
                                opt.textContent = p.plant_name + (p.abbr ? ` (${p.abbr})` : '');
                                sel.appendChild(opt);
                            });
                            div.appendChild(sel);

                            const btns = document.createElement('div');
                            btns.style.display = 'flex'; btns.style.justifyContent = 'flex-end'; btns.style.gap = '8px';
                            const ok = mxUtils.button('OK', async () => {
                                const id = Number(sel.value);
                                const row = await PlantModel.loadById(id);
                                if (!row) { mxUtils.alert('Plant not found.'); return; }
                                ui.hideDialog();

                                const graph = ui.editor.graph;
                                const model = graph.getModel();

                                model.beginUpdate();
                                try {
                                    // inherit city from garden module ancestor if present
                                    const gardenParent = findGardenModuleAncestor(model, target);
                                    if (gardenParent) {
                                        const inheritedCity = gardenParent.getAttribute('city_name');
                                        if (inheritedCity) setAttr(target, 'city_name', inheritedCity);
                                    }

                                    setAttr(target, 'plant_id', String(row.plant_id));
                                    setAttr(target, 'plant_name', row.plant_name);
                                    if (row.abbr) setAttr(target, 'plant_abbr', row.abbr);
                                    setAttr(target, 'plant_locked', '1');
                                    setAttr(target, 'label', row.plant_name + ' group');

                                    applyPlantSpacingToGroup(target, row);

                                    const r = (window.USL && window.USL.tiler && window.USL.tiler.retileGroup) || null;
                                    if (typeof r === 'function') r(graph, target);
                                    graph.refresh(target);
                                } finally {
                                    model.endUpdate();
                                }
                            });
                            const cancel = mxUtils.button('Cancel', () => ui.hideDialog());
                            btns.appendChild(ok); btns.appendChild(cancel); div.appendChild(btns);
                            ui.showDialog(div, 440, 220, true, true);
                        } catch (e) {
                            mxUtils.alert('Set Plant error: ' + e.message);
                        }
                    });
                }

                const label = hasTilerSchedule(target) ? 'Change Schedule' : 'Set Schedule';

                menu.addItem(label, null, async function () {
                    try { await openScheduleDialog(ui, target); }
                    catch (e) { mxUtils.alert('Scheduling error: ' + e.message); }
                });

            }
        };

    });

})
