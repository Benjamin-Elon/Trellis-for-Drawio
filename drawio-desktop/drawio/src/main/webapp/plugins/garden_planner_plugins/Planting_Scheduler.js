// USL Draw.io Plugin: Plant Scheduling (GDD-based, class-refactor)
//
// - Right-click tiler group -> "Set schedule…"
// - Fetches plant/city from SQLite via window.dbBridge
// - Computes schedule (single or succession), plants, timelines, and writes attrs
//
// Key changes in this version:
//  * Class-based encapsulation: PlantModel, CityClimate, SuccessionConfig, PolicyFlags, ScheduleInputs
//  * Overwinter-aware feasibility & scanning
//  * Yield multipliers computed over HARVEST window
//  * UI keeps the same behavior (manual/auto dates, min fi filter, preview)
//
// ---------------------------------------------------------------------------------------------

(function () {

    console.log("[Scheduler] file instance:", "Planting_Scheduler.js", "STAMP=2026-01-25Txx:yy");

    const DB_PATH = "C:/Users/user/Desktop/Gardening/Syntropy(3).sqlite";

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


    // -------------------- DB helpers (open → query → close) ------------------------------
    async function queryAll(sql, params) {
        if (!window.dbBridge || typeof window.dbBridge.open !== 'function') {
            throw new Error('dbBridge not available; check preload/main wiring');
        }
        const opened = await window.dbBridge.open(DB_PATH, { readOnly: true });
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
        const opened = await window.dbBridge.open(DB_PATH, { readOnly: false });
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
                 COALESCE(succession,1) AS succession,
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
                 COALESCE(succession,1) AS succession,
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
                 direct_sow, transplant, succession, overwinter_ok, start_cooling_threshold_c,
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
    }


    class TaskTemplateModel {
        static async ensureTables() {                                              // <-- CHANGED
            const sql1 = `
                CREATE TABLE IF NOT EXISTS PlantTaskTemplates (
                  plant_id      INTEGER NOT NULL,                                  -- CHANGED
                  method        TEXT    NOT NULL,                                  -- CHANGED
                  template_json TEXT    NOT NULL,                                  -- CHANGED
                  updated_at    TEXT    NOT NULL,                                  -- CHANGED
                  PRIMARY KEY (plant_id, method)
                );`;                                                               // <-- CHANGED
            const sql2 = `
                CREATE TABLE IF NOT EXISTS VarietyTaskTemplates (
                  variety_id    INTEGER NOT NULL,                                  -- CHANGED
                  method        TEXT    NOT NULL,                                  -- CHANGED
                  template_json TEXT    NOT NULL,                                  -- CHANGED
                  updated_at    TEXT    NOT NULL,                                  -- CHANGED
                  PRIMARY KEY (variety_id, method)
                );`;                                                               // <-- CHANGED
            await execAll(sql1, []);                                               // <-- CHANGED
            await execAll(sql2, []);                                               // <-- CHANGED
        }

        static _safeParseTemplateRow(row) {                                        // <-- CHANGED
            if (!row) return null;
            try {
                const tpl = JSON.parse(row.template_json);                         // <-- CHANGED
                return tpl && typeof tpl === 'object' ? tpl : null;
            } catch (_) {
                return null;
            }
        }

        static async loadPlantTemplate(plantId, method) {                          // <-- CHANGED
            await this.ensureTables();
            const sql = `
                SELECT template_json                                                -- CHANGED
                FROM PlantTaskTemplates
                WHERE plant_id = ? AND method = ?
                LIMIT 1;`;
            const rows = await queryAll(sql, [Number(plantId), String(method)]);
            return this._safeParseTemplateRow(rows[0] || null);
        }

        static async loadVarietyTemplate(varietyId, method) {                      // <-- CHANGED
            await this.ensureTables();
            const sql = `
                SELECT template_json                                                -- CHANGED
                FROM VarietyTaskTemplates
                WHERE variety_id = ? AND method = ?
                LIMIT 1;`;
            const rows = await queryAll(sql, [Number(varietyId), String(method)]);
            return this._safeParseTemplateRow(rows[0] || null);
        }

        static async savePlantTemplate(plantId, method, template) {                // <-- CHANGED
            await this.ensureTables();
            const json = JSON.stringify(template ?? {});                           // <-- CHANGED
            const now = new Date().toISOString();
            const sql = `
                INSERT INTO PlantTaskTemplates (plant_id, method, template_json, updated_at)  -- CHANGED
                VALUES (?, ?, ?, ?)
                ON CONFLICT(plant_id, method) DO UPDATE SET
                  template_json = excluded.template_json,                           -- CHANGED
                  updated_at = excluded.updated_at;`;
            await execAll(sql, [Number(plantId), String(method), json, now]);      // <-- CHANGED
        }

        static async saveVarietyTemplate(varietyId, method, template) {            // <-- CHANGED
            await this.ensureTables();
            const json = JSON.stringify(template ?? {});                           // <-- CHANGED
            const now = new Date().toISOString();
            const sql = `
                INSERT INTO VarietyTaskTemplates (variety_id, method, template_json, updated_at) -- CHANGED
                VALUES (?, ?, ?, ?)
                ON CONFLICT(variety_id, method) DO UPDATE SET
                  template_json = excluded.template_json,                          -- CHANGED
                  updated_at = excluded.updated_at;`;
            await execAll(sql, [Number(varietyId), String(method), json, now]);    // <-- CHANGED
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

    class SuccessionConfig {
        constructor({
            enabled = true,
            max = 5,
            overlapDays = 2,
            harvestWindowDays = null, // null => use plant default
            minYieldMultiplier = 0.5
        } = {}) {
            this.enabled = !!enabled;
            this.max = Math.max(1, Number(max ?? 1));
            this.overlapDays = Math.max(0, Number(overlapDays ?? 0));
            this.harvestWindowDays = (harvestWindowDays == null ? null : Math.max(0, Number(harvestWindowDays)));
            this.minYieldMultiplier = Math.max(0, Number(minYieldMultiplier ?? 0));
            Object.freeze(this);
        }

        static fromUI(plant, { useSucc, maxSucc, overlapDays, harvestWindowDays, minYieldMultiplier }) {
            const hw = (harvestWindowDays == null || Number.isNaN(harvestWindowDays)) ? null : Number(harvestWindowDays);
            return new SuccessionConfig({
                enabled: (Number(plant?.succession ?? 1) === 1) && !!useSucc,
                max: Math.max(1, Number(maxSucc ?? 1)),
                overlapDays: Math.max(0, Number(overlapDays ?? 0)),
                harvestWindowDays: hw,
                minYieldMultiplier: Number(minYieldMultiplier ?? 0.5)
            });
        }

        withPlantDefaults(plant) {
            const hw = (this.harvestWindowDays == null) ? plant.defaultHW() : this.harvestWindowDays;
            return new SuccessionConfig({
                enabled: this.enabled,
                max: this.max,
                overlapDays: this.overlapDays,
                harvestWindowDays: hw,
                minYieldMultiplier: this.minYieldMultiplier
            });
        }

        toAttrs() {
            return {
                use_succession: this.enabled ? '1' : '0',
                max_successions: String(this.max),
                overlap_days: String(this.overlapDays),
                harvest_window_days: String(this.harvestWindowDays),
                min_yield_multiplier: String(this.minYieldMultiplier)
            };
        }

        static fromAttrs(cell) {
            const get = (k, d = null) => cell && cell.getAttribute ? cell.getAttribute(k) : d;
            const hwRaw = get('harvest_window_days', null);
            return new SuccessionConfig({
                enabled: get('use_succession', '1') === '1',
                max: Number(get('max_successions', '5')),
                overlapDays: Number(get('overlap_days', '2')),
                harvestWindowDays: (hwRaw == null || hwRaw === '') ? null : Number(hwRaw),
                minYieldMultiplier: Number(get('min_yield_multiplier', '0.5'))
            });
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
        constructor({ plant, city, method, startISO, seasonEndISO, succession, policy, seasonStartYear, varietyId = null, varietyName = '' }) { // <-- CHANGED
            Object.assign(this, {
                plant, city, method, startISO, seasonEndISO, succession, policy,
                seasonStartYear: Number(seasonStartYear),
                varietyId: (varietyId != null ? Number(varietyId) : null), // <-- NEW
                varietyName: String(varietyName || '')                     // <-- NEW
            }); // <-- CHANGED
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
            const { plant, city, method, succession, policy } = inputs;
            const { startDate, seasonEnd, env, dailyRates, monthlyAvg, scanStart, scanEndHard } = inputs.derived();
            const budget = plant.firstHarvestBudget();  // {mode, amount}


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

                // crop & climate
                BUDGET: budget,                            // <-- add this
                HW_DAYS: succession.harvestWindowDays,
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


        isSowFeasible(sowDate, debug = false) {
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
          

        nextPlantingDate(prevSow, overlapDays, minHarvestDays = 3) {
            const C = this.ctx;
            const m_n = maturityDateFromBudget(prevSow, C.BUDGET, C.dailyRates, C.scanEndHard);
            const end_n = this.addDays(m_n, C.HW_DAYS);

            const hardEnd = (C.seasonEnd && C.seasonEnd <= C.scanEndHard) ? C.seasonEnd : C.scanEndHard;
            if (end_n > hardEnd) return null;
            if (!C.overwinterAllowed && prevSow.getUTCFullYear() !== end_n.getUTCFullYear()) return null;

            const targetMatNext = this.addDays(m_n, Math.max(0, overlapDays));
            if (targetMatNext > hardEnd) return null;

            const sow_next = sowDateBackFromTargetMaturity(targetMatNext, C.BUDGET, C.dailyRates, C.scanStart);
            const earlyEnd = this.addDays(targetMatNext, Math.max(0, minHarvestDays));
            if (earlyEnd > hardEnd) return null;
            return sow_next;
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
    async function computeScheduleResult(inputs, seasonYieldTargetKg) {
        const { plant, method, succession } = inputs;
        const { startDate, seasonEnd, env, dailyRates, monthlyAvg } = inputs.derived();

        const budget = plant.firstHarvestBudget();
        const HW_DAYS = succession.harvestWindowDays;
        if (!Number.isFinite(HW_DAYS)) {
            return { rows: [], lastScheduledHarvestEndISO: null };
        }

        const schedule = buildSuccessionSchedule(inputs);
        if (!schedule.length) {
            return { rows: [], lastScheduledHarvestEndISO: null };
        }

        const stageDays = {
            maturityDays: (budget.mode === 'days')
                ? budget.amount
                : (Number(plant.days_maturity) || 0),
            transplantDays: Number.isFinite(Number(plant.days_transplant))
                ? Number(plant.days_transplant)
                : 0,
            germinationDays: Number.isFinite(Number(plant.days_germ))
                ? Number(plant.days_germ)
                : 0,
            harvest_window_days: HW_DAYS
        };

        const timelines = computeStageTimelinesForSchedule({
            schedule, budget, stageDays,
            dailyRatesMap: dailyRates, seasonEnd
        });

        const multipliers = deriveYieldMultipliersFromTemp({
            schedule, budget,
            dailyRatesMap: dailyRates,
            cropTemp: env,
            monthlyAvgTemp: monthlyAvg,
            seasonEnd,
            Tbase: env.Tbase,
            window: 'harvest',
            HW_DAYS: HW_DAYS
        });

        // Filter by min field index                                                    
        const keep = [];
        for (let i = 0; i < schedule.length; i++) {
            const fi = Number.isFinite(multipliers[i]) ? multipliers[i] : 0;
            if (fi >= succession.minYieldMultiplier) keep.push(i);
        }
        if (!keep.length) {
            return { rows: [], lastScheduledHarvestEndISO: null };
        }

        const scheduleF = keep.map(i => schedule[i]);
        const timelinesF = keep.map(i => timelines[i]);
        const multipliersF = keep.map(i => multipliers[i]);

        const { plants: plantsAlloc } = distributePlantsToMeetTarget({
            N: scheduleF.length,
            seasonYieldTarget: Number(seasonYieldTargetKg ?? 0),
            yieldPerPlant: plant.yieldPerPlant(),
            multipliers: multipliersF
        });

        const plantName = plant.plant_name || (plant.abbr || '?');
        const rows = scheduleF.map((sow, k) => {
            const tl = timelinesF[k];
            return {
                idx: k + 1,
                plant: plantName,
                method,
                sow: fmtISO(sow),
                germ: fmtISO(tl.germ),
                trans: fmtISO(tl.transplant),
                harvStart: fmtISO(tl.harvestStart),
                harvEnd: fmtISO(tl.harvestEnd),
                mult: (Number.isFinite(multipliersF[k])
                    ? multipliersF[k].toFixed(3)
                    : ''),
                plantsReq: (Array.isArray(plantsAlloc) ? plantsAlloc[k] : '')
            };
        });

        const lastRow = rows[rows.length - 1] || null;
        const lastScheduledHarvestEndISO = lastRow ? lastRow.harvEnd : null;

        console.log('[computeScheduleResult] summary', {
            N_schedule: schedule.length,
            N_kept: rows.length,
            firstRow: rows[0] || null,
            lastRow,
            lastScheduledHarvestEndISO
        });

        return { rows, lastScheduledHarvestEndISO };
    }


    // -------------------- Centralized builder for schedule context -------------------- 
    async function buildScheduleContextFromForm(formState, selPlant, options = {}) {
        const { enforcePlantSuccessionPolicy = false } = options;

        // Prefer current selected plant instance if provided                              
        const plant = await resolveEffectivePlant(formState.plantId, formState.varietyId);
        if (!plant) throw new Error('Plant not found for schedule.');

        const city = await CityClimate.loadByName(formState.cityName);
        if (!city) throw new Error('City not found for schedule.');

        const method = formState.method;

        let succession = SuccessionConfig.fromUI(plant, {
            useSucc: formState.useSuccession,
            maxSucc: formState.maxSucc,
            overlapDays: formState.overlapDays,
            harvestWindowDays: formState.harvestWindowDays,
            minYieldMultiplier: formState.minYieldMultiplier
        }).withPlantDefaults(plant);

        // Optionally enforce plant-level succession policy (used by OK handler)          
        if (enforcePlantSuccessionPolicy && Number(plant.succession ?? 1) !== 1) {
            succession = new SuccessionConfig({
                enabled: false,
                max: 1,
                overlapDays: 0,
                harvestWindowDays: succession.harvestWindowDays,
                minYieldMultiplier: succession.minYieldMultiplier
            });
        }

        const policy = PolicyFlags.fromPlant(plant, method);

        // --- NEW: define varietyId/varietyName in this scope ---
        const varietyId = (formState.varietyId != null) ? Number(formState.varietyId) : null;          // NEW
        const varietyName = varietyId
            ? String((currentVarieties || []).find(v => Number(v.variety_id) === varietyId)?.variety_name || '')
            : '';                                                                                      // NEW

        const inputs = new ScheduleInputs({
            plant,
            city,
            method,
            startISO: formState.startISO,
            seasonEndISO: formState.seasonEndISO,
            succession,
            policy,
            seasonStartYear: formState.seasonStartYear,
            varietyId,                    // now defined
            varietyName                   // now defined
        });


        return { plant, city, method, succession, policy, inputs };
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

















































    // -------------------- Thermal / yield helpers -----------------------------------------

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

    function buildSuccessionSchedule(inputs) {
        const planner = new Planner(inputs);
        const C = planner.ctx;

        // 1) first sow baseline: scanStart or cooling trigger
        let first = new Date(Math.max(C.startDate, C.scanStart));
        if (C.coolingCrossDate) {
            first = new Date(Math.max(first, C.coolingCrossDate));                         // (optional)
        }


        // 2) slide forward by soil gate & overall feasibility
        let feas = planner.isSowFeasible(first);
        if (!feas.ok) {
            const nxt = planner.findNextFeasible(first);
            if (!nxt.date) return [];
            first = nxt.date;
        }

        const dates = [first];
        const total = Math.max(1, inputs.succession.enabled ? inputs.succession.max : 1);

        // 3) successive plantings
        for (let i = 1; i < total; i++) {
            const next = planner.nextPlantingDate(dates[dates.length - 1], inputs.succession.overlapDays, 3);
            if (!next || next > C.scanEndHard) break;
            dates.push(next);
        }
        return dates;
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


    function computeStageTimelinesForSchedule({ schedule, budget, stageDays, dailyRatesMap, seasonEnd }) {

        if (!budget || !Number.isFinite(budget.amount) || budget.amount <= 0) {
            throw new Error('Invalid maturity budget');
        }
        return (schedule || []).map(sow =>
            computeStageDatesForPlanting({ sowDate: sow, budget, stageDays, dailyRatesMap, seasonEnd })
        );
    }

    function distributePlantsToMeetTarget({ N, seasonYieldTarget, yieldPerPlant, multipliers }) {
        const f = (multipliers && multipliers.length === N) ? multipliers.slice() : Array.from({ length: N }, () => 1);
        const eps = 1e-6;
        if (yieldPerPlant <= 0 || N <= 0 || seasonYieldTarget <= 0)
            return { plants: Array.from({ length: N }, () => 0), expectedTotalYield: 0 };

        const perSuccessionYield = seasonYieldTarget / N;
        const ideal = f.map(fi => perSuccessionYield / (yieldPerPlant * Math.max(eps, fi)));
        const plants = ideal.map(x => Math.ceil(x));
        const expected = (arr) => arr.reduce((acc, p, i) => acc + p * yieldPerPlant * f[i], 0);
        let expYield = expected(plants);
        let idx = 0;
        while (expYield < seasonYieldTarget) {
            plants[idx % N] += 1;
            expYield = expected(plants);
            if (++idx > 100000) break;
        }
        return { plants, expectedTotalYield: expYield };
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
            succession: new SuccessionConfig({
                enabled: false, max: 1, overlapDays: 0,
                harvestWindowDays: HW_DAYS, minYieldMultiplier: 0
            }),
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
            successionEnabled = false
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

        // Limit sow scanning for overwinter crops to the first season year        // CHANGE
        const sowScanEnd = overwinterAllowed                                      // CHANGE
            ? asUTCDate(C.scanStart.getUTCFullYear(), 12, 31)                     // CHANGE
            : C.scanEndHard;                                                      // CHANGE

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

        for (let d = new Date(firstNonSoil); d <= sowScanEnd; d = planner.addDays(d, 1)) { // CHANGE
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
                successionEnabled,
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
                climateEndDate: fallbackHarvestEnd               // CHANGE
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
        let lastHarvestDate;
        if (successionEnabled) {
            lastHarvestDate = lastFeasibleHarvestEnd || firstFeasibleHarvestEnd;
        } else {
            lastHarvestDate = firstFeasibleHarvestEnd || earliestFeasibleSow;
        }

        // NEW: climate-level end of window (independent of successions)
        let climateEndDate;                                                              // CHANGE
        if (overwinterAllowed) {                                                         // CHANGE
            // For overwinter crops, tie climate end to the last (schedule) harvest      // CHANGE
            climateEndDate = lastHarvestDate                                             // CHANGE
                || lastFeasibleHarvestEnd                                                // CHANGE
                || lastThermalHarvestEnd                                                 // CHANGE
                || firstFeasibleHarvestEnd                                               // CHANGE
                || new Date(C.scanEndHard);                                              // CHANGE
        } else {                                                                         // CHANGE
            // Non-overwinter crops: keep full climate envelope behavior as before       // CHANGE
            climateEndDate = lastFeasibleHarvestEnd                                      // CHANGE
                || lastThermalHarvestEnd                                                 // CHANGE
                || firstFeasibleHarvestEnd                                               // CHANGE
                || new Date(C.scanEndHard);                                              // CHANGE
        }                                                                               // CHANGE


        console.log('[autoWindow] RESULT', {
            successionEnabled,
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


    function setRowVisible(fieldRows, key, visible) {
        const fr = fieldRows[key];
        if (fr && fr.row) fr.row.style.display = visible ? '' : 'none';
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

    function askText(ui, { title = 'Enter text', label = 'Value:', initial = '' } = {}) {
        const wrap = document.createElement('div');
        wrap.style.padding = '12px';
        wrap.style.width = '420px';

        const t = document.createElement('div');
        t.textContent = title;
        t.style.fontWeight = '600';
        t.style.marginBottom = '10px';
        wrap.appendChild(t);

        const input = document.createElement('input');
        input.type = 'text';
        input.value = String(initial || '');
        input.style.width = '100%';
        input.style.boxSizing = 'border-box';
        input.style.padding = '8px';

        const r = row(label, input);
        wrap.appendChild(r.row);

        const btns = document.createElement('div');
        btns.style.marginTop = '12px';
        btns.style.display = 'flex';
        btns.style.justifyContent = 'flex-end';
        btns.style.gap = '8px';

        const cancelBtn = mxUtils.button('Cancel', () => wrap.__cancel());

        const okBtn = mxUtils.button('OK', () => {
            const val = String(input.value || '').trim();
            wrap.__commit(val || null);
        });

        btns.appendChild(cancelBtn);
        btns.appendChild(okBtn);
        wrap.appendChild(btns);

        setTimeout(() => { try { input.focus(); input.select(); } catch (_) { } }, 0);

        return showCommitDialog(ui, { container: wrap, width: 440, height: 180, modal: true, closable: true });
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
            'Succession', 'Plant', 'Method',
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
                r.idx, r.plant, r.method,
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
        const successionChk = makeCheckbox((existing?.succession ?? 1) === 1);

        div.appendChild(row('Direct sow:', directSowChk).row);
        div.appendChild(row('Transplant:', transplantChk).row);
        div.appendChild(row('Allow successions:', successionChk).row);

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

                const succession = successionChk.checked ? 1 : 0;
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
                    direct_sow, transplant, succession,
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
                refreshSuccessionUI();
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
                refreshSuccessionUI();
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
        async function reloadVarietyOptionsForPlant(plantId) {
            currentVarieties = await PlantVarietyModel.listByPlantId(Number(plantId));
            const opts = [{ value: '', label: '(base plant)' }]
                .concat(currentVarieties.map(v => ({
                    value: String(v.variety_id),
                    label: String(v.variety_name)
                })));
            setSelectOptions(varietySel, opts, '');
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
        const autoLastSowInput = makeDate(initialStartISO, true);                         // (placeholder, updated by recomputeAnchors)

        // User-controlled first sow date (used for schedule startISO)                   
        const startInput = makeDate(initialStartISO, false);                             // (editable)

        // Auto-computed season end constraint (read-only for annuals, editable for perennials)
        const seasonEndInput = makeDate(initialEndISO, true);

        // Schedule-derived last harvest date (always read-only)
        const lastHarvestInput = makeDate(initialEndISO, true);

        let firstSowDirty = false;

        const startNoteSpan = document.createElement('span');
        startNoteSpan.style.marginLeft = '8px'; startNoteSpan.style.fontSize = '12px'; startNoteSpan.style.color = '#92400e';
        startNoteSpan.textContent = startNote || '';

        // Succession inputs
        const allowsSucc = Number(effectivePlant?.succession ?? 1) === 1;
        const succCheck = makeCheckbox(allowsSucc, !allowsSucc);
        const maxSuccInput = makeNumber(allowsSucc ? 5 : 1, { min: 1 });
        const overlapInput = makeNumber(2, { min: 0 });
        const hwDefault = effectivePlant.defaultHW();               // may be null
        const hwInput = makeNumber(hwDefault ?? '', { min: 0 });
        const yieldTargetInput = makeNumber(1000, { min: 0 });
        const minYieldMultInput = makeNumber(0.50, { min: 0 }); minYieldMultInput.step = '0.01';

        // --- Season control (single field) ---
        const seasonStartYear0 = Number(cell.getAttribute?.('season_start_year') ?? (new Date()).getUTCFullYear());
        const seasonYearInput = makeNumber(seasonStartYear0, { min: 1900 });
        seasonYearInput.step = '1';

        let taskTemplate = null;
        let taskRules = Array.isArray(taskTemplate?.rules) ? [...taskTemplate.rules] : [];
        const saveDefaultChk = makeCheckbox(false);

        // --- Central form state ---------------------------------------------------- 
        const formState = {
            plantId: initId,
            varietyId: null,
            cityName: citySel.value,
            method: methodSel.value,
            startISO: startInput.value,
            seasonEndISO: seasonEndInput.value,
            seasonStartYear: Number(seasonYearInput.value || (new Date()).getUTCFullYear()),
            useSuccession: succCheck.checked,
            maxSucc: Number(maxSuccInput.value || 1),
            overlapDays: Number(overlapInput.value || 0),
            harvestWindowDays: (hwInput.value === '' ? null : Number(hwInput.value)),
            yieldTargetKg: Number(yieldTargetInput.value || 0),
            minYieldMultiplier: Number(minYieldMultInput.value || 0.5),
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
            formState.useSuccession = succCheck.checked;
            formState.maxSucc = Number(maxSuccInput.value || 1);
            formState.overlapDays = Number(overlapInput.value || 0);
            formState.harvestWindowDays = (hwInput.value === '' ? null : Number(hwInput.value));
            formState.yieldTargetKg = Number(yieldTargetInput.value || 0);
            formState.minYieldMultiplier = Number(minYieldMultInput.value || 0.5);
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
            { key: 'useSuccession', label: 'Use successions', control: succCheck },
            { key: 'maxSucc', label: 'Max successions:', control: maxSuccInput },
            { key: 'overlapDays', label: 'Overlap days:', control: overlapInput },
            { key: 'harvestWindowDays', label: 'Harvest window days:', control: hwInput },
            { key: 'yieldTargetKg', label: 'Yield target (kg):', control: yieldTargetInput },
            { key: 'minYieldMultiplier', label: 'Min yield multiplier:', control: minYieldMultInput }
        ];

        const { fieldRows } = buildFieldRows(FIELD_SCHEMA);
        // ----------------------------------------------------------

        // Prefill succession config from current cell attrs
        const existingCfg = SuccessionConfig.fromAttrs(cell);
        succCheck.checked = allowsSucc && (existingCfg.enabled ?? allowsSucc);
        maxSuccInput.value = String(existingCfg.max ?? (allowsSucc ? 5 : 1));
        overlapInput.value = String(existingCfg.overlapDays ?? 2);
        hwInput.value = (effectivePlant.defaultHW() ?? '').toString();
        minYieldMultInput.value = String(
            (Number.isFinite(existingCfg.minYieldMultiplier) ? existingCfg.minYieldMultiplier : 0.50)
        );

        syncStateFromControls();

        await reloadVarietyOptionsForPlant(formState.plantId);
        syncVarietyButtons();
        await refreshEffectivePlant();
        resetMethodOptions(effectivePlant);


        // Layout rows
        const useSuccRow = fieldRows.useSuccession;
        const maxSuccRow = fieldRows.maxSucc;
        const overlapRow = fieldRows.overlapDays;

        const autoEarliestRowObj = row('Earliest feasible sow:', autoEarliestInput);

        const autoLastSowRowObj = row('Last feasible sow:', autoLastSowInput);

        const firstSowRowObj = row('First sow date:', startInput);
        if (startNote) firstSowRowObj.row.appendChild(startNoteSpan);

        const endRow = row('Season end date:', seasonEndInput);

        const lastHarvestRowObj = row('Last harvest date:', lastHarvestInput);

        appendFieldRows(div, fieldRows, ['seasonStartYear']);
        appendFieldRows(div, fieldRows, ['cityName', 'method']);
        div.appendChild(autoEarliestRowObj.row);
        div.appendChild(autoLastSowRowObj.row);
        div.appendChild(firstSowRowObj.row);
        div.appendChild(endRow.row);
        div.appendChild(lastHarvestRowObj.row);

        appendFieldRows(div, fieldRows, [
            'useSuccession',
            'maxSucc',
            'overlapDays',
            'harvestWindowDays',
            'yieldTargetKg',
            'minYieldMultiplier'
        ]);


        const baseStartNote = startNote || '';

        function applyModeToUI() {
            const perennial = mode.perennial;
            const canSucc = Number(effectivePlant?.succession ?? 1) === 1;
            const useSucc = canSucc && succCheck.checked && !perennial;

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

            // Succession controls                                                      
            succCheck.disabled = !canSucc || perennial;
            if (perennial) succCheck.checked = false;

            const showSuccRows = !perennial && canSucc && succCheck.checked;
            setRowVisible(fieldRows, 'useSuccession', !perennial && canSucc);
            setRowVisible(fieldRows, 'maxSucc', showSuccRows);
            setRowVisible(fieldRows, 'overlapDays', showSuccRows);

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
                    status = '';                                                             // (inside feasible window → no extra warning)
                }
            }

            const hasFeasibleWindow = !!formState.lastFeasibleSowISO;

            const parts = [];
            if (baseStartNote && !hasFeasibleWindow) parts.push(baseStartNote);
            if (status) parts.push(status);

            startNoteSpan.textContent = parts.join(' ');
        }


        function updateAnnualLabelsForSuccession() {
            if (mode.perennial) {
                return; // perennial labels are managed by setPerennialMode       
            }

            const canSucc = Number(effectivePlant?.succession ?? 1) === 1;
            const useSucc = canSucc && succCheck.checked;

            if (useSucc) {
                firstSowRowObj.label.textContent = 'First sow date:';
                lastHarvestRowObj.label.textContent = 'Last harvest date:';
            } else {
                firstSowRowObj.label.textContent = 'Sow date:';
                lastHarvestRowObj.label.textContent = 'Harvest date:';
            }
        }


        function refreshSuccessionUI() {
            const canSucc = Number(effectivePlant?.succession ?? 1) === 1;
            if (!canSucc) {
                succCheck.checked = false;
                maxSuccInput.value = '1';
                overlapInput.value = '0';
            }
            applyModeToUI();
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
                    successionEnabled: formState.useSuccession && Number(p.succession ?? 1) === 1
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
                hwInput.value = (plant?.defaultHW() ?? '').toString();
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
            const useSucc = formState.useSuccession;

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
                    formState.lastHarvestSource = useSucc ? 'schedule' : 'auto';
                    break;
                }

                case 'yearChanged': {
                    // New season → refresh both start and end from feasibility
                    await recomputeAnchors(true, true);

                    await recomputeLastHarvestFromSchedule();
                    formState.lastHarvestSource = useSucc ? 'schedule' : 'auto';
                    break;
                }

                case 'plantChanged': {
                    // City/method/plant change → respect user sow date if dirty
                    await recomputeAnchors(true, true);

                    await recomputeLastHarvestFromSchedule();
                    formState.lastHarvestSource = useSucc ? 'schedule' : 'auto';
                    break;
                }

                case 'cityChanged':
                case 'methodChanged': {
                    // City/method change → keep user sow date if dirty,              
                    // but don't force end update unless you want to:                 
                    await recomputeAnchors(false, false);

                    await recomputeLastHarvestFromSchedule();
                    formState.lastHarvestSource = useSucc ? 'schedule' : 'auto';
                    break;
                }

                case 'startChanged':
                    // User explicitly changed first sow; keep it, but recompute schedule 
                    await recomputeAnchors(false, false);
                    await recomputeLastHarvestFromSchedule();
                    formState.lastHarvestSource = useSucc ? 'schedule' : 'auto';
                    break;

                case 'successionParamsChanged': {
                    // Recheck because useSucc may have changed                                
                    const useSuccNow = formState.useSuccession;

                    if (useSuccNow) {
                        // Successions ON: allow auto refit of end date                        
                        await recomputeAnchors(false, false);
                    } else {
                        // Successions OFF: keep seasonEndISO as a hard constraint             
                        await recomputeAnchors(false, false);
                    }

                    await recomputeLastHarvestFromSchedule();
                    formState.lastHarvestSource = useSuccNow ? 'schedule' : 'auto';
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

            hwInput.value = (effectivePlant.defaultHW() ?? '').toString();
            formState.harvestWindowDays = (hwInput.value === '' ? null : Number(hwInput.value));

            const canSucc = Number(effectivePlant?.succession ?? 1) === 1;
            succCheck.disabled = !canSucc; succCheck.checked = canSucc;
            maxSuccInput.value = canSucc ? '5' : '1';
            overlapInput.value = canSucc ? '2' : '0';

            syncStateFromControls();

            if (effectivePlant.isPerennial()) {
                setPerennialMode(true, effectivePlant);
            } else {
                setPerennialMode(false, effectivePlant);
            }

            refreshSuccessionUI();

            // Let the orchestrator recompute feasibility + schedule                      
            await recomputeAll('plantChanged');
            await refreshTaskTemplateFromSelection();
        });

        varietySel.addEventListener('change', async () => {
            syncVarietyButtons();
            syncStateFromControls();
            await refreshEffectivePlant();
            resetMethodOptions(effectivePlant);
            hwInput.value = (effectivePlant.defaultHW() ?? '').toString();
            refreshSuccessionUI();
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
        succCheck.addEventListener('change', () => {
            refreshSuccessionUI();
            recomputeAll('successionParamsChanged');
        });


        maxSuccInput.addEventListener('input', () => {
            recomputeAll('successionParamsChanged');
        });

        overlapInput.addEventListener('input', () => {
            recomputeAll('successionParamsChanged');
        });

        hwInput.addEventListener('input', () => {
            recomputeAll('successionParamsChanged');
        });

        yieldTargetInput.addEventListener('input', () => {
            recomputeAll('successionParamsChanged');
        });

        minYieldMultInput.addEventListener('input', () => {
            recomputeAll('successionParamsChanged');
        });


        // recomputeLastHarvestFromSchedule:
        //  - concern: full schedule under current constraint
        //  - NEVER changes seasonEndISO, only lastScheduleEndISO / lastHarvestISO
        async function recomputeLastHarvestFromSchedule() {
            try {
                syncStateFromControls();

                const { inputs } = await buildScheduleContextFromForm(
                    formState,
                    selPlant,
                    { enforcePlantSuccessionPolicy: false }
                );

                const { rows, lastScheduledHarvestEndISO } =
                    await computeScheduleResult(inputs, formState.yieldTargetKg);

                if (!rows.length || !lastScheduledHarvestEndISO) {
                    console.log('[recomputeLastHarvestFromSchedule] no rows', {
                        startISO: formState.startISO,
                        seasonEndISO: formState.seasonEndISO,
                        useSuccession: formState.useSuccession,
                        harvestWindowDays: formState.harvestWindowDays,
                        minYieldMultiplier: formState.minYieldMultiplier,
                        yieldTargetKg: formState.yieldTargetKg
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
                    { enforcePlantSuccessionPolicy: false }
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
                    { enforcePlantSuccessionPolicy: false }
                );

                const rows = await computePreviewRows(inputs, formState.yieldTargetKg);
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
                    { enforcePlantSuccessionPolicy: true }
                );

                // Build taskTemplate object from current rules
                taskTemplate = {
                    version: 1,
                    rules: taskRules
                };

                // Save per-plan template onto cell
                saveTaskTemplateToCell(cell, taskTemplate);

                // Save template if requested
                if (saveDefaultChk.checked) {
                    await TaskTemplateModel.saveForSelection({
                        plantId: formState.plantId,
                        varietyId: formState.varietyId,
                        method: formState.method,
                        template: taskTemplate
                    });
                }


                await applyScheduleToGraph(ui, cell, inputs, formState.yieldTargetKg);
                ui.hideDialog();
            } catch (e) {
                mxUtils.alert('Scheduling error: ' + e.message);
            }
        });

        const cancelBtn = mxUtils.button('Cancel', () => ui.hideDialog());
        [previewBtn, okBtn, cancelBtn].forEach(b => rightBtns.appendChild(b));
        btns.appendChild(rightBtns); div.appendChild(btns);

        refreshSuccessionUI();
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
            // Do not overwrite if the cell already has a per-plan template                  (optional policy)
            const hasCellTpl = !!cell?.getAttribute?.('task_template_json');
            if (hasCellTpl) return;

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
        async function computePreviewRows(inputs, seasonYieldTargetKg) {
            const { rows } = await computeScheduleResult(inputs, seasonYieldTargetKg);
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

    // Save template to cell
    function saveTaskTemplateToCell(cell, template) {
        const json = JSON.stringify(template);
        cell.setAttribute("task_template_json", json);
    }
































































    // -------------------- Apply schedule to graph ------------------------------------------
    function stampPlanSummary(cell, {
        plant, city, method, Tbase, gddToMaturity,
        scheduleDates, multipliers, plants,
        timelines, expectedTotalYield, yieldTargetKg,
        successionConfig,
        varietyId = null,            // <-- NEW
        varietyName = ''             // <-- NEW
    }) {
        const fmt = (d) => (d ? d.toISOString().slice(0, 10) : null);

        if (Number.isFinite(Number(plant.start_cooling_threshold_c))) {
            setAttr(cell, 'start_cooling_threshold_c', String(plant.start_cooling_threshold_c));
        }

        // visible label
        setAttr(cell, 'label', plant.plant_name + ' group');

        // Plan metadata
        setAttr(cell, 'plant_id', String(plant.plant_id));
        setAttr(cell, 'plant_name', plant.plant_name);
        setAttr(cell, 'city_name', city.city_name);
        setAttr(cell, 'method', method);
        setAttr(cell, 'variety_id', String(varietyId ?? ''));                 // <-- NEW
        setAttr(cell, 'variety_name', String(varietyName || ''));             // <-- NEW

        // Thermal anchors
        setAttr(cell, 'tbase_c', String(Tbase));
        setAttr(cell, 'gdd_to_maturity', String(gddToMaturity));

        // Succession config persisted on the group
        const cfgAttrs = successionConfig.toAttrs();
        Object.keys(cfgAttrs).forEach(k => setAttr(cell, k, cfgAttrs[k]));

        // scalar fields from FIRST succession
        const sow0 = scheduleDates && scheduleDates[0] ? scheduleDates[0] : null;
        const tl0 = timelines && timelines[0] ? timelines[0] : {};
        const f0 = multipliers && multipliers[0] != null ? multipliers[0] : 1;
        const p0 = plants && plants[0] != null ? plants[0] : 0;

        setAttr(cell, 'sow_date', fmt(sow0));
        setAttr(cell, 'germ_date', fmt(tl0.germ));
        setAttr(cell, 'transplant_date', fmt(tl0.transplant));
        setAttr(cell, 'maturity_date', fmt(tl0.maturity));
        setAttr(cell, 'harvest_start', fmt(tl0.harvestStart));
        setAttr(cell, 'harvest_end', fmt(tl0.harvestEnd));
        setAttr(cell, 'yield_multiplier', String(Number.isFinite(f0) ? f0 : 1));
        setAttr(cell, 'plants_required', String(Number.isFinite(p0) ? p0 : 0));
        setAttr(cell, 'yield_target_kg', String(yieldTargetKg ?? 0));
        setAttr(cell, 'expected_total_yield_kg', String(expectedTotalYield ?? 0));
    }

    function stampSuccessionGroup(cell, i, { abbr, unit, yieldPerPlant }, {
        sow, timeline, fi, plantsRequired, perSuccessionTarget
    }) {
        setAttr(cell, 'succession_index', i + 1);
        setAttr(cell, 'plant_abbr', abbr);
        setAttr(cell, 'plants_required', plantsRequired);
        setAttr(cell, 'plant_yield', yieldPerPlant);
        setAttr(cell, 'target_yield', Number(perSuccessionTarget || 0).toFixed(3));
        setAttr(cell, 'yield_multiplier', (Number.isFinite(fi) ? fi : 1));

        const fmt = d => (d ? d.toISOString().slice(0, 10) : '');
        setAttr(cell, 'sow_date', fmt(sow));
        setAttr(cell, 'germ_date', fmt(timeline.germ));
        setAttr(cell, 'transplant_date', fmt(timeline.transplant));
        setAttr(cell, 'maturity_date', fmt(timeline.maturity));
        setAttr(cell, 'harvest_start', fmt(timeline.harvestStart));
        setAttr(cell, 'harvest_end', fmt(timeline.harvestEnd));

    }

    async function applyScheduleToGraph(ui, cell, inputs, seasonYieldTargetKg) {
        const { plant, city, method, succession, policy } = inputs;
        const { startDate, seasonEnd, env, dailyRates, monthlyAvg } = inputs.derived();

        const budget = plant.firstHarvestBudget();
        if (!budget || !Number.isFinite(budget.amount) || budget.amount <= 0)
            throw new Error('Invalid maturity budget for ' + plant.plant_name);
        const HW_DAYS = inputs.succession.harvestWindowDays;
        if (!Number.isFinite(HW_DAYS))
            throw new Error('Harvest window is required for scheduling.');

        const schedule = buildSuccessionSchedule(inputs);
        if (!schedule.length) throw new Error('No feasible planting dates in the chosen season.');

        const multipliers = deriveYieldMultipliersFromTemp({
            schedule, budget,
            dailyRatesMap: dailyRates, cropTemp: env, monthlyAvgTemp: monthlyAvg, seasonEnd, Tbase: env.Tbase,
            window: 'harvest', HW_DAYS: HW_DAYS
        });

        const stageDays = {
            maturityDays: Number.isFinite(Number(plant.days_maturity)) && Number(plant.days_maturity) > 0
                ? Number(plant.days_maturity)
                : (budget.mode === 'days' ? budget.amount : 0),            // <- avoid GDD fallback here
            transplantDays: Number.isFinite(Number(plant.days_transplant)) ? Number(plant.days_transplant) : 0,
            germinationDays: Number.isFinite(Number(plant.days_germ)) ? Number(plant.days_germ) : 0,
            harvest_window_days: HW_DAYS
        };
        const timelines = computeStageTimelinesForSchedule({
            schedule, budget, stageDays, dailyRatesMap: dailyRates, seasonEnd
        });

        // filter by min fi
        const keep = [];
        for (let i = 0; i < schedule.length; i++) {
            const fi = Number.isFinite(multipliers[i]) ? multipliers[i] : 0;
            if (fi >= succession.minYieldMultiplier) keep.push(i);
        }
        if (!keep.length) throw new Error('No successions meet the minimum yield multiplier.');

        const scheduleF = keep.map(i => schedule[i]);
        const timelinesF = keep.map(i => timelines[i]);
        const multipliersF = keep.map(i => multipliers[i]);

        const { plants: plantsAlloc, expectedTotalYield } = distributePlantsToMeetTarget({
            N: scheduleF.length,
            seasonYieldTarget: Number(seasonYieldTargetKg ?? 0),
            yieldPerPlant: plant.yieldPerPlant(),
            multipliers: multipliersF
        });

        // Build tasks from schedule/timelines without emitting events                     
        function buildTasksForPlan({
            method,
            plant,
            schedule,
            timelines,
            successionOffset = 0,
            totalSuccessions = null,
            taskTemplate
        }) {
            const tasks = [];
            const plantName = plant.plant_name || plant.abbr || 'Plant';

            const rules = (taskTemplate && Array.isArray(taskTemplate.rules))
                ? taskTemplate.rules
                : getDefaultTaskTemplateForMethod(method).rules;

            const total = (Number.isFinite(totalSuccessions)
                ? totalSuccessions
                : (schedule.length + successionOffset));

            const showSuccLabel = total > 1;

            function substituteTitle(template, { plantName, succIdx }) {
                let t = template || '';
                t = t.replace(/\{plant\}/g, plantName);
                t = t.replace(/\{succ\}/g, String(succIdx));
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

            for (let i = 0; i < schedule.length; i++) {
                const tl = timelines[i];
                const sowDate = schedule[i];
                const anchors = anchorDatesForTimeline(tl, sowDate);

                const succIdx = successionOffset + i + 1;
                const succSuffix = showSuccLabel ? ` (S${succIdx})` : '';

                for (const rule of rules) {
                    const stage = rule.anchorStage || 'SOW';
                    let anchorISO = anchors[stage];

                    // Optional fallback for missing GERM: use SOW
                    if (!anchorISO && stage === 'GERM') {
                        anchorISO = anchors.SOW || null;
                    }

                    if (!anchorISO) continue; // cannot schedule this rule for this succession

                    const offsetDays = Number(rule.offsetDays || 0);
                    const dir = rule.offsetDirection === 'before' ? -1 : 1;

                    const baseISO = shiftDays(anchorISO, dir * offsetDays);

                    // Determine endISO based on duration and/or HARVEST_END special case
                    let startISO = baseISO;
                    let endISO = baseISO;

                    const dur = Number(rule.durationDays || 0);

                    if (dur > 0) {
                        endISO = shiftDays(baseISO, dur);
                    } else {
                        // Special-case: harvest rule spans HARVEST_START → HARVEST_END if available
                        if (stage === 'HARVEST_START' && anchors.HARVEST_END) {
                            startISO = baseISO;
                            endISO = anchors.HARVEST_END;
                        }
                    }

                    // Handle repeat
                    const repeat = !!rule.repeat;
                    const every = Number(rule.repeatEveryDays || 0);
                    const untilMode = rule.repeatUntilMode || 'x_times';
                    const untilVal = Number(rule.repeatUntilValue || 0);

                    const occurrences = [];

                    if (!repeat || every <= 0 || untilVal <= 0) {
                        occurrences.push({ startISO, endISO });
                    } else if (untilMode === 'x_times') {
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

                    const baseTitle = substituteTitle(rule.title || '', {
                        plantName,
                        succIdx
                    });

                    const finalTitle = baseTitle || (`Task for ${plantName}${succSuffix}`);

                    for (const occ of occurrences) {
                        if (!occ.startISO && !occ.endISO) continue;
                        const s = occ.startISO || occ.endISO;
                        const e = occ.endISO || occ.startISO;

                        tasks.push({
                            title: finalTitle + succSuffix,
                            startISO: s,
                            endISO: e,
                            plant_name: plantName,
                            rule_id: rule.id || null,
                            anchorStage: stage,
                            successionIndex: succIdx
                        });
                    }
                }
            }

            return tasks;
        }



        function emitTasksForPlan({
            method,
            plant,
            cell,
            schedule,
            timelines,
            plantsAlloc,
            successionOffset = 0,
            totalSuccessions = null
        }) {
            // load template
            const taskTemplate = loadTaskTemplateFromCell(cell, method);

            const tasks = buildTasksForPlan({
                method,
                plant,
                schedule,
                timelines,
                successionOffset,
                totalSuccessions,
                taskTemplate
            });

            const detail = {
                tasks,
                plantName: plant.plant_name,
                targetGroupId: cell.id,
                successionIndex: successionOffset,
                totalSuccessions: totalSuccessions
            };

            try {
                window.dispatchEvent(new CustomEvent("tasksCreated", { detail }));
            } catch (_) { }

            return tasks;
        }


        const graph = ui.editor.graph;
        const model = graph.getModel();

        const abbr = plant.abbr || '?';
        const unit = 'kg';
        setAttr(cell, 'season_start_year', String(inputs.seasonStartYear));

        let createdTasks = [];
        let created = [];

        model.beginUpdate();
        try {
            // Stamp maturity definition by unit
            if (budget.mode === 'gdd') {
                setAttr(cell, 'gdd_to_maturity', String(budget.amount));
                setAttr(cell, 'days_maturity', '');
            } else {
                setAttr(cell, 'days_maturity', String(budget.amount));
                setAttr(cell, 'gdd_to_maturity', '');
            }
            // stamp summary on anchor cell
            stampPlanSummary(cell, {
                plant, city, method, Tbase: env.Tbase,
                gddToMaturity: (budget.mode === 'gdd' ? budget.amount : ''),   // optional
                scheduleDates: scheduleF,
                multipliers: multipliersF,
                plants: plantsAlloc,
                timelines: timelinesF,
                expectedTotalYield,
                yieldTargetKg: Number(seasonYieldTargetKg ?? 0),
                successionConfig: succession,
                varietyId: inputs.varietyId,                // <-- NEW
                varietyName: inputs.varietyName             // <-- NEW
            });

            setAttr(cell, 'plant_yield', plant.yieldPerPlant());
            setAttr(cell, 'yield_unit', unit);

            applyPlantSpacingToGroup(cell, plant);

            // stamp first succession in the same group
            const perSuccessionTarget = (Number(seasonYieldTargetKg || 0) > 0)
                ? (Number(seasonYieldTargetKg) / scheduleF.length)
                : 0;

            stampSuccessionGroup(cell, 0, { abbr, unit, yieldPerPlant: plant.yieldPerPlant() }, {
                sow: scheduleF[0], timeline: timelinesF[0], fi: multipliersF[0],
                plantsRequired: plantsAlloc[0], perSuccessionTarget
            });

            // retile/refresh
            const r = (window.USL && window.USL.tiler && window.USL.tiler.retileGroup) || null;
            if (typeof r === 'function') r(graph, cell);
            graph.refresh(cell);

            // create sibling groups for remaining successions
            const dx = 24 + (cell.getGeometry()?.width || 200);
            const dy = 0;
            created = [cell];

            const taskTplJson = cell.getAttribute && cell.getAttribute('task_template_json');

            for (let i = 1; i < scheduleF.length; i++) {
                const sib = createSiblingTilerGroup(graph, cell, `${abbr} group`, i * dx, dy);
                setAttr(sib, 'label', plant.plant_name + ' group');
                setAttr(sib, 'plant_name', plant.plant_name);
                setAttr(sib, 'plant_id', String(plant.plant_id));
                setAttr(sib, 'plant_abbr', abbr);
                setAttr(sib, 'variety_id', String(inputs.varietyId ?? ''));             // <-- NEW
                setAttr(sib, 'variety_name', String(inputs.varietyName || ''));         // <-- NEW
                setAttr(sib, 'plant_yield', plant.yieldPerPlant());
                setAttr(sib, 'yield_unit', unit);
                setAttr(sib, 'city_name', city.city_name);
                setAttr(sib, 'method', method);
                setAttr(sib, 'tbase_c', String(env.Tbase));
                setAttr(sib, 'gdd_to_maturity', budget.mode === 'gdd' ? String(budget.amount) : '');
                setAttr(sib, 'days_maturity', budget.mode === 'days' ? String(budget.amount) : '');
                // also persist cfg on each sibling
                const cfgAttrs = succession.toAttrs();
                Object.keys(cfgAttrs).forEach(k => setAttr(sib, k, cfgAttrs[k]));

                // copy task template to sibling
                if (taskTplJson) {
                    setAttr(sib, 'task_template_json', taskTplJson);
                }

                copySpacingAttrs(cell, sib);

                stampSuccessionGroup(sib, i, { abbr, unit, yieldPerPlant: plant.yieldPerPlant() }, {
                    sow: scheduleF[i], timeline: timelinesF[i], fi: multipliersF[i],
                    plantsRequired: plantsAlloc[i], perSuccessionTarget
                });

                const r2 = (window.USL && window.USL.tiler && window.USL.tiler.retileGroup) || null;
                if (typeof r2 === 'function') r2(graph, sib);
                graph.refresh(sib);

                created.push(sib);
            }

            const ids = created.map(g => g.id).join(',');
            created.forEach(g => setAttr(g, 'linked_succession_ids', ids));

        } finally {
            model.endUpdate();
        }

        // Build & send tasks now that the graph is committed:
        createdTasks = [];

        if (!created.length) {
            // Fallback: attach all tasks to the anchor group if something went wrong
            createdTasks = emitTasksForPlan({
                method,
                plant,
                cell,
                schedule: scheduleF,
                timelines: timelinesF,
                plantsAlloc,
                successionOffset: 0,
                totalSuccessions: scheduleF.length
            });
        } else {
            const totalSucc = created.length;
            for (let i = 0; i < created.length; i++) {
                const group = created[i];
                const tasksForGroup = emitTasksForPlan({
                    method,
                    plant,
                    cell: group,
                    schedule: [scheduleF[i]],
                    timelines: [timelinesF[i]],
                    plantsAlloc: Array.isArray(plantsAlloc)
                        ? [plantsAlloc[i]]
                        : undefined,
                    successionOffset: i,
                    totalSuccessions: totalSucc
                });
                createdTasks = createdTasks.concat(tasksForGroup);
            }
        }
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
                succession: new SuccessionConfig({
                    enabled: Number(selectedPlant.succession ?? 1) === 1,
                    max: 1,
                    overlapDays: 0,
                    harvestWindowDays: HW_DAYS,
                    minYieldMultiplier: 0.5
                }).withPlantDefaults(selectedPlant),
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
            } else if (feasStart.ok) {
                // (optional) handle 'barely'/'truncated' flags
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
        // NEW
    
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
          
              const succession = new SuccessionConfig({
                enabled: false,
                max: 1,
                overlapDays: 0,
                harvestWindowDays: hw,
                minYieldMultiplier: 1.0
              }).withPlantDefaults(plant);
          
              const policy = PolicyFlags.fromPlant(plant, method);
          
              const inputs = new ScheduleInputs({
                plant, city, method,
                startISO: `${year}-01-01`,
                seasonEndISO: `${year}-12-31`,
                succession, policy,
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

})();
