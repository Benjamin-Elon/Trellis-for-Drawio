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
        constructor({ plant, city, method, startISO, seasonEndISO, succession, policy, seasonStartYear }) {
            Object.assign(this, { plant, city, method, startISO, seasonEndISO, succession, policy, seasonStartYear: Number(seasonStartYear) });
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
            let d = new Date(Math.max(startCandidate, this.ctx.scanStart));
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

    // -------------------- Dialog builder ---------------------------------------------------
    async function buildScheduleDialog(ui, cell, plants, cities, onSubmit, options) {
        const { selectedPlant: initialPlant, earliestFeasibleSowDate, lastHarvestDate, startNote } = options || {};

        // Helper to centralize plant mode (perennial vs annual/biennial)          
        function getModeForPlant(plant) {
            const perennial = !!(plant && plant.isPerennial && plant.isPerennial());
            return { perennial };
        }

        const div = document.createElement('div');
        div.style.padding = '12px'; div.style.width = '600px';

        const inlineButton = (label, onClick) => { const b = mxUtils.button(label, onClick); b.style.marginLeft = '8px'; return b; };

        // Plant selector
        const plantOpts = (plants || []).map(p => ({ value: String(p.plant_id), label: p.plant_name + (p.abbr ? ` (${p.abbr})` : '') }));
        const plantSel = makeSelect(plantOpts, plantOpts[0]?.value);
        const findPlantById = (id) => (plants || []).find(p => Number(p.plant_id) === Number(id)) || null;
        const initId = initialPlant ? initialPlant.plant_id : (plantOpts[0] ? Number(plantOpts[0].value) : null);
        plantSel.value = String(initId);
        let selPlant = findPlantById(initId) || initialPlant;
        if (!selPlant) { mxUtils.alert('No plants available.'); return; }

        let mode = getModeForPlant(selPlant);

        const plantRow = document.createElement('div');
        const plantLbl = document.createElement('span'); plantLbl.textContent = 'Plant:';
        const plantNameSpan = document.createElement('span'); plantNameSpan.style.fontWeight = '600';
        plantNameSpan.textContent = selPlant.plant_name;
        plantRow.appendChild(plantLbl); plantRow.appendChild(document.createTextNode(' ')); plantRow.appendChild(plantNameSpan);
        div.appendChild(plantRow); div.appendChild(document.createElement('br'));
        const plantSelectRow = row('Select plant:', plantSel); div.appendChild(plantSelectRow.row);

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
        const allowsSucc = Number(selPlant?.succession ?? 1) === 1;
        const succCheck = makeCheckbox(allowsSucc, !allowsSucc);
        const maxSuccInput = makeNumber(allowsSucc ? 5 : 1, { min: 1 });
        const overlapInput = makeNumber(2, { min: 0 });
        const hwDefault = selPlant.defaultHW();               // may be null
        const hwInput = makeNumber(hwDefault ?? '', { min: 0 });
        const yieldTargetInput = makeNumber(1000, { min: 0 });
        const minYieldMultInput = makeNumber(0.50, { min: 0 }); minYieldMultInput.step = '0.01';

        // --- Season control (single field) ---
        const seasonStartYear0 = Number(cell.getAttribute?.('season_start_year') ?? (new Date()).getUTCFullYear());
        const seasonYearInput = makeNumber(seasonStartYear0, { min: 1900 });
        seasonYearInput.step = '1';

        // --- Central form state ---------------------------------------------------- 
        const formState = {
            plantId: initId,
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
        hwInput.value = (selPlant.defaultHW() ?? '').toString();
        minYieldMultInput.value = String(
            (Number.isFinite(existingCfg.minYieldMultiplier) ? existingCfg.minYieldMultiplier : 0.50)
        );

        syncStateFromControls();

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
            const canSucc = Number(selPlant?.succession ?? 1) === 1;
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

            const canSucc = Number(selPlant?.succession ?? 1) === 1;
            const useSucc = canSucc && succCheck.checked;

            if (useSucc) {
                firstSowRowObj.label.textContent = 'First sow date:';             // unchanged
                lastHarvestRowObj.label.textContent = 'Last harvest date:';
            } else {
                firstSowRowObj.label.textContent = 'Sow date:';                   // unchanged
                lastHarvestRowObj.label.textContent = 'Harvest date:';
            }
        }


        function refreshSuccessionUI() {
            const canSucc = Number(selPlant?.succession ?? 1) === 1;
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

                const city = await CityClimate.loadByName(formState.cityName);
                if (!city) return;

                const seasonStartYear = formState.seasonStartYear;

                const env = selPlant.cropTempEnvelope();
                const dailyRates = city.dailyRates(env.Tbase, seasonStartYear);
                const monthlyAvgTemp = city.monthlyMeans();
                const budget = selPlant.firstHarvestBudget();

                const HW_DAYS = formState.harvestWindowDays;
                if (!Number.isFinite(HW_DAYS)) return [];

                const overwinterAllowed = selPlant.isPerennial() || Number(selPlant.overwinter_ok ?? 0) === 1;
                const scanStart = asUTCDate(seasonStartYear, 1, 1);
                const scanEndYear = overwinterAllowed ? (seasonStartYear + 1) : seasonStartYear;
                const scanEndHard = asUTCDate(scanEndYear, 12, 31);

                const soilGateThresholdC = (Number.isFinite(Number(selPlant.soil_temp_min_plant_c))
                    ? Number(selPlant.soil_temp_min_plant_c)
                    : null);

                const methodVal = formState.method;
                const daysTransplant = Number.isFinite(Number(selPlant.days_transplant)) ? Number(selPlant.days_transplant) : 0;

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
                    startCoolingThresholdC: asCoolingThresholdC(selPlant.start_cooling_threshold_c),
                    useSpringFrostGate: !overwinterAllowed,
                    lastSpringFrostDOY: lsf,
                    daysTransplant,
                    overwinterAllowed,
                    successionEnabled: formState.useSuccession && Number(selPlant.succession ?? 1) === 1
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

                // NEW: let auto window drive season end when requested                      // CHANGE
                if (forceWriteEnd && r.climateEndDate instanceof Date) {                    // CHANGE
                    formState.seasonEndISO = r.climateEndDate.toISOString().slice(0, 10);   // CHANGE
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
                    selPlant.lifespan_years
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

            resetMethodOptions(newPlant);
            formState.method = methodSel.value;

            hwInput.value = (newPlant.defaultHW() ?? '').toString();
            formState.harvestWindowDays = (hwInput.value === '' ? null : Number(hwInput.value));

            const canSucc = Number(newPlant?.succession ?? 1) === 1;
            succCheck.disabled = !canSucc; succCheck.checked = canSucc;
            maxSuccInput.value = canSucc ? '5' : '1';
            overlapInput.value = canSucc ? '2' : '0';

            syncStateFromControls();

            if (newPlant.isPerennial()) {
                setPerennialMode(true, newPlant);
            } else {
                setPerennialMode(false, newPlant);
            }

            refreshSuccessionUI();

            // Let the orchestrator recompute feasibility + schedule                      
            await recomputeAll('plantChanged');
        });


        startInput.addEventListener('input', () => {
            firstSowDirty = true;                                                     // (keep)
            syncStateFromControls();                                                  // (keep)
            if (mode.perennial) {
                seasonEndInput.value = computePerennialEndISO(                        // (keep)
                    startInput.value,                                                 // (keep)
                    selPlant.lifespan_years                                           // (keep)
                );
                formState.seasonEndISO = seasonEndInput.value;                        // (keep)
                updateStartNote();                                                    // (keep)
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
            recomputeAll('cityChanged');
        });
        methodSel.addEventListener('change', () => {
            recomputeAll('methodChanged')
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


        // -------------------- Centralized builder for schedule context -------------------- 
        async function buildScheduleContextFromForm(formState, selPlant, options = {}) {
            const { enforcePlantSuccessionPolicy = false } = options;

            // Prefer current selected plant instance if provided                              
            const plant = selPlant || await PlantModel.loadById(formState.plantId);
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

            const inputs = new ScheduleInputs({
                plant,
                city,
                method,
                startISO: formState.startISO,
                seasonEndISO: formState.seasonEndISO,
                succession,
                policy,
                seasonStartYear: formState.seasonStartYear
            });

            return { plant, city, method, succession, policy, inputs };
        }


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
        recomputeAll('cityChanged');        // or 'yearChanged' or 'methodChanged'       

        ui.showDialog(div, 600, 540, true, true);

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


        // inner helpers (closure over UI controls)
        async function computePreviewRows(inputs, seasonYieldTargetKg) {
            const { rows } = await computeScheduleResult(inputs, seasonYieldTargetKg);
            return rows;
        }
    }
































































    // -------------------- Apply schedule to graph ------------------------------------------
    function stampPlanSummary(cell, {
        plant, city, method, Tbase, gddToMaturity,
        scheduleDates, multipliers, plants,
        timelines, expectedTotalYield, yieldTargetKg,
        successionConfig
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
        function buildTasksForPlan({ method, plant, schedule, timelines, successionOffset = 0, totalSuccessions = null }) {
            const tasks = [];
            const plantName = plant.plant_name || plant.abbr || 'Plant';

            // If caller explicitly passes totalSuccessions, use it; otherwise fall back to
            // "schedule length + offset" as an approximation.                                    
            const total = (Number.isFinite(totalSuccessions)
                ? totalSuccessions
                : (schedule.length + successionOffset));

            const showSuccLabel = total > 1;

            for (let i = 0; i < schedule.length; i++) {
                const tl = timelines[i];
                const succIdx = successionOffset + i + 1;
                const succSuffix = showSuccLabel ? ` (S${succIdx})` : '';

                const push = (title, startISO, endISO, extra = {}) => {
                    if (!startISO && !endISO) return;
                    const s = startISO || endISO;
                    const e = endISO || startISO;
                    const tasktitle = extra.titleOverride || kind;
                    tasks.push({
                        title: tasktitle,
                        startISO: s,
                        endISO: e,
                        notes: extra.notes || undefined,
                        plant_name: plant.plant_name,
                    });
                };

                const SOW = iso(tl.sow);
                const GERM = iso(tl.germ);
                const TRANS = iso(tl.transplant);
                const HSTART = iso(tl.harvestStart);
                const HEND = iso(tl.harvestEnd);

                // PREP: 3 days prior up to field activity (sow or transplant)           
                {
                    const anchor = SOW || TRANS;
                    if (anchor) {
                        push(
                            'PREP',
                            shiftDays(anchor, -3),
                            anchor,
                            {
                                titleOverride: `Prep bed for ${plantName}${succSuffix}`
                            }
                        );
                    }
                }

                // SOW: sow → sow+7                                                      
                if (SOW) {
                    push(
                        'SOW',
                        SOW,
                        shiftDays(SOW, 7),
                        {
                            titleOverride: `Sow ${plantName}${succSuffix}`
                        }
                    );
                }

                // THIN: germ+7 → germ+14 (fallback to sow+7 → sow+14 if germ missing)   
                {
                    const thinStart = GERM ? shiftDays(GERM, 7)
                        : (SOW ? shiftDays(SOW, 7) : null);
                    const thinEnd = GERM ? shiftDays(GERM, 14)
                        : (SOW ? shiftDays(SOW, 14) : null);
                    if (thinStart || thinEnd) {
                        push(
                            'THIN',
                            thinStart,
                            thinEnd,
                            {
                                titleOverride: `Thin / check ${plantName}${succSuffix}`
                            }
                        );
                    }
                }

                // START (indoor): sow → transplant                                      
                if (method === 'transplant_indoor' && SOW) {
                    push(
                        'START',
                        SOW,
                        TRANS || SOW,
                        {
                            titleOverride: `Start ${plantName} indoors${succSuffix}`
                        }
                    );
                }

                // HARDEN: transplant-7 → transplant (only if transplant date exists)    
                if (method === 'transplant_indoor' && TRANS) {
                    push(
                        'HARDEN',
                        shiftDays(TRANS, -7),
                        TRANS,
                        {
                            titleOverride: `Harden off ${plantName}${succSuffix}`
                        }
                    );
                }

                // TRANSPLANT: transplant → transplant+7                                 
                if (TRANS) {
                    push(
                        'TRANSPLANT',
                        TRANS,
                        shiftDays(TRANS, 7),
                        {
                            titleOverride: `Transplant ${plantName}${succSuffix}`
                        }
                    );
                }

                // HARVEST: first → last (single window)                                 
                if (HSTART || HEND) {
                    push(
                        'HARVEST',
                        HSTART || HEND,
                        HEND || HSTART,
                        {
                            titleOverride: `Harvest – ${plantName}${succSuffix}`
                        }
                    );
                }
            }

            return tasks;
        }



        function emitTasksForPlan({ method, plant, cell, schedule, timelines, plantsAlloc, successionOffset = 0, totalSuccessions = null }) {
            const tasks = buildTasksForPlan({
                method,
                plant,
                schedule,
                timelines,
                successionOffset,
                totalSuccessions
            });

            const plantName = plant.plant_name || plant.abbr || 'Plant';
            const targetGroupId = cell.id;

            // Custom event for task manager to listen for                                       
            const detail = {
                tasks,
                plantName,
                targetGroupId
            };

            try {
                const evtName = 'tasksCreated';
                if (typeof window.CustomEvent === 'function') {
                    window.dispatchEvent(new CustomEvent(evtName, { detail }));
                } else {
                    const ev = document.createEvent('CustomEvent');
                    ev.initCustomEvent(evtName, false, false, detail);
                    window.dispatchEvent(ev);
                }
            } catch (_) {
                // swallow; schedule should still succeed even if event dispatch fails           
            }

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
                successionConfig: succession
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

            for (let i = 1; i < scheduleF.length; i++) {
                const sib = createSiblingTilerGroup(graph, cell, `${abbr} group`, i * dx, dy);
                setAttr(sib, 'label', plant.plant_name + ' group');
                setAttr(sib, 'plant_name', plant.plant_name);
                setAttr(sib, 'plant_id', String(plant.plant_id));
                setAttr(sib, 'plant_abbr', abbr);
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
            mxUtils.alert('Schedule set.');
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






    // -------------------- Public API --------------------------------------------------------
    window.USL = window.USL || {};
    window.USL.scheduler = Object.assign({}, window.USL.scheduler, {
        openScheduleDialog: (ui, cell) => openScheduleDialog(ui, cell)
    });
    window.openUSLScheduleDialog = window.USL.scheduler.openScheduleDialog;

    // -------------------- Plugin entry: add popup menu item --------------------------------
    Draw.loadPlugin(function (ui) {
        const graph = ui.editor.graph;
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
