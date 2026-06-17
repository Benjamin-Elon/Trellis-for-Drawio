/**
 * Draw.io Plugin: Garden Bed Conditions
 *
 * Stores growing-condition metadata on Trellis garden beds and garden modules,
 * then renders compact, non-persistent badges from that saved metadata.
 */
Draw.loadPlugin(function (ui) { // NEW
    const graph = ui && ui.editor && ui.editor.graph; // NEW
    if (!graph || graph.__gardenBedConditionsInstalled) return; // NEW
    graph.__gardenBedConditionsInstalled = true; // NEW

    const model = graph.getModel && graph.getModel(); // NEW
    if (!model) return; // NEW

    const ATTRS = { // NEW
        BED_JSON: "bed_conditions_json", // NEW
        DEFAULT_JSON: "default_bed_conditions_json", // NEW
        BADGES: "show_bed_condition_badges" // NEW
    }; // NEW

    const MIRROR_ATTRS = { // NEW
        sunExposure: "sun_exposure", // NEW
        soilMoisture: "soil_moisture", // NEW
        drainage: "drainage", // NEW
        soilTexture: "soil_texture", // NEW
        fertility: "fertility", // NEW
        irrigation: "irrigation", // NEW
        trellis: "trellis", // NEW
        bedUse: "bed_use" // NEW
    }; // NEW

    const FIELD_DEFS = [ // NEW
        { key: "sunExposure", label: "Sun exposure", values: ["unknown", "full_sun", "part_sun", "part_shade", "shade"], fallback: "unknown" }, // NEW
        { key: "soilMoisture", label: "Soil moisture", values: ["unknown", "dry", "moderate", "moist", "wet"], fallback: "unknown" }, // NEW
        { key: "drainage", label: "Drainage", values: ["unknown", "fast", "normal", "slow"], fallback: "unknown" }, // NEW
        { key: "soilTexture", label: "Soil texture", values: ["unknown", "sandy", "loamy", "clay", "mixed", "amended"], fallback: "unknown" }, // NEW
        { key: "fertility", label: "Fertility", values: ["unknown", "low", "medium", "high"], fallback: "unknown" }, // NEW
        { key: "irrigation", label: "Irrigation", values: ["unknown", "none", "manual", "drip", "sprinkler", "self_watering"], fallback: "unknown" }, // NEW
        { key: "trellis", label: "Trellis", values: ["none", "available", "required_structure"], fallback: "none" }, // NEW
        { key: "windExposure", label: "Wind exposure", values: ["unknown", "sheltered", "moderate", "exposed"], fallback: "unknown" }, // NEW
        { key: "frostRisk", label: "Frost risk", values: ["unknown", "low", "medium", "high"], fallback: "unknown" }, // NEW
        { key: "bedUse", label: "Bed use", values: ["unknown", "annuals", "perennials", "nursery", "seed_starting", "mixed", "resting"], fallback: "unknown" } // NEW
    ]; // NEW

    const FIELD_BY_KEY = FIELD_DEFS.reduce(function (out, field) { // NEW
        out[field.key] = field; // NEW
        return out; // NEW
    }, Object.create(null)); // NEW

    const VALUE_LABELS = { // NEW
        unknown: "Unknown", // NEW
        full_sun: "Full sun", // NEW
        part_sun: "Part sun", // NEW
        part_shade: "Part shade", // NEW
        shade: "Shade", // NEW
        dry: "Dry", // NEW
        moderate: "Moderate", // NEW
        moist: "Moist", // NEW
        wet: "Wet", // NEW
        fast: "Fast drainage", // NEW
        normal: "Normal drainage", // NEW
        slow: "Slow drainage", // NEW
        sandy: "Sandy", // NEW
        loamy: "Loamy", // NEW
        clay: "Clay", // NEW
        mixed: "Mixed", // NEW
        amended: "Amended", // NEW
        low: "Low", // NEW
        medium: "Medium", // NEW
        high: "High", // NEW
        none: "None", // NEW
        manual: "Manual", // NEW
        drip: "Drip", // NEW
        sprinkler: "Sprinkler", // NEW
        self_watering: "Self watering", // NEW
        available: "Trellis", // NEW
        required_structure: "Structure required", // NEW
        sheltered: "Sheltered", // NEW
        exposed: "Exposed", // NEW
        annuals: "Annuals", // NEW
        perennials: "Perennials", // NEW
        nursery: "Nursery", // NEW
        seed_starting: "Seed starting", // NEW
        resting: "Resting" // NEW
    }; // NEW

    const PRESETS = { // NEW
        "": { label: "Choose preset", values: {} }, // NEW
        sunny_vegetable: { label: "Sunny vegetable bed", values: { sunExposure: "full_sun", soilMoisture: "moderate", drainage: "normal", soilTexture: "loamy", fertility: "high", irrigation: "manual", trellis: "none", bedUse: "annuals" } }, // NEW
        shady_greens: { label: "Shady greens bed", values: { sunExposure: "part_shade", soilMoisture: "moist", drainage: "normal", fertility: "medium", irrigation: "manual", trellis: "none", bedUse: "annuals" } }, // NEW
        dry_herb: { label: "Dry herb bed", values: { sunExposure: "full_sun", soilMoisture: "dry", drainage: "fast", soilTexture: "sandy", fertility: "low", irrigation: "manual", trellis: "none", bedUse: "perennials" } }, // NEW
        wet_moist: { label: "Wet/moist bed", values: { sunExposure: "part_sun", soilMoisture: "moist", drainage: "slow", fertility: "medium", irrigation: "none", trellis: "none", bedUse: "mixed" } }, // NEW
        trellis_bed: { label: "Trellis bed", values: { sunExposure: "full_sun", soilMoisture: "moderate", drainage: "normal", fertility: "high", irrigation: "drip", trellis: "available", bedUse: "annuals" } }, // NEW
        nursery: { label: "Nursery bed", values: { sunExposure: "part_sun", soilMoisture: "moderate", drainage: "normal", fertility: "medium", irrigation: "manual", trellis: "none", bedUse: "nursery" } }, // NEW
        perennial: { label: "Perennial bed", values: { sunExposure: "full_sun", soilMoisture: "moderate", drainage: "normal", fertility: "medium", irrigation: "manual", trellis: "none", bedUse: "perennials" } }, // NEW
        resting: { label: "Resting bed", values: { sunExposure: "unknown", soilMoisture: "unknown", drainage: "unknown", fertility: "low", irrigation: "none", trellis: "none", bedUse: "resting" } } // NEW
    }; // NEW

    let copiedProfile = null; // NEW
    const badgeOverlays = new Map(); // NEW

    function getStyleSafe(cell) { // NEW
        return cell && typeof cell.getStyle === "function" ? (cell.getStyle() || "") : ((cell && cell.style) || ""); // NEW
    } // NEW

    function isGardenBed(cell) { // NEW
        return !!cell && cell.getAttribute && cell.getAttribute("garden_bed") === "1"; // NEW
    } // NEW

    function isGardenModule(cell) { // NEW
        return !!cell && cell.getAttribute && cell.getAttribute("garden_module") === "1" && getStyleSafe(cell).indexOf("module=1") >= 0; // NEW
    } // NEW

    function findGardenModuleAncestor(activeGraph, cell) { // NEW
        const activeModel = activeGraph && activeGraph.getModel && activeGraph.getModel(); // NEW
        let cur = cell; // NEW
        while (cur) { // NEW
            if (isGardenModule(cur)) return cur; // NEW
            cur = activeModel && activeModel.getParent ? activeModel.getParent(cur) : null; // NEW
        } // NEW
        return null; // NEW
    } // NEW

    function getCellAttr(cell, key, fallback) { // NEW
        if (!cell || !cell.getAttribute) return fallback || ""; // NEW
        const value = cell.getAttribute(key); // NEW
        return value == null ? (fallback || "") : String(value); // NEW
    } // NEW

    function createXmlDocument() { // NEW
        if (typeof mxUtils !== "undefined" && mxUtils.createXmlDocument) return mxUtils.createXmlDocument(); // NEW
        return document.implementation.createDocument("", "", null); // NEW
    } // NEW

    function ensureXmlValue(cell) { // NEW
        if (!cell) return null; // NEW
        const value = cell.value; // NEW
        if (value && value.nodeType === 1) return value; // NEW
        const node = createXmlDocument().createElement("object"); // NEW
        if (typeof value === "string" && value) node.setAttribute("label", value); // NEW
        cell.value = node; // NEW
        return node; // NEW
    } // NEW

    function setCellAttrs(cell, attrs) { // NEW
        const node = ensureXmlValue(cell); // NEW
        if (!node) return; // NEW
        Object.keys(attrs || {}).forEach(function (key) { // NEW
            const value = attrs[key]; // NEW
            if (value == null || value === "") node.removeAttribute(key); // NEW
            else node.setAttribute(key, String(value)); // NEW
        }); // NEW
        if (model.setValue) model.setValue(cell, node); // NEW
    } // NEW

    function nowIso() { // NEW
        return new Date().toISOString(); // NEW
    } // NEW

    function valueLabel(value) { // NEW
        return VALUE_LABELS[value] || String(value || "").replace(/_/g, " "); // NEW
    } // NEW

    function normalizeEnumValue(key, value) { // NEW
        const field = FIELD_BY_KEY[key]; // NEW
        const raw = String(value == null ? "" : value).trim(); // NEW
        if (!field || field.values.indexOf(raw) < 0) return field ? field.fallback : ""; // NEW
        return raw; // NEW
    } // NEW

    function normalizeTags(tags) { // NEW
        const values = Array.isArray(tags) ? tags : String(tags || "").split(","); // NEW
        const seen = Object.create(null); // NEW
        const out = []; // NEW
        values.forEach(function (tag) { // NEW
            const clean = String(tag || "").trim(); // NEW
            if (!clean || seen[clean]) return; // NEW
            seen[clean] = true; // NEW
            out.push(clean); // NEW
        }); // NEW
        return out; // NEW
    } // NEW

    function normalizeProfile(profile, options) { // NEW
        const source = profile && typeof profile === "object" ? profile : {}; // NEW
        const out = { schemaVersion: 1 }; // NEW
        FIELD_DEFS.forEach(function (field) { // NEW
            out[field.key] = normalizeEnumValue(field.key, source[field.key]); // NEW
        }); // NEW
        out.notes = String(source.notes || "").trim(); // NEW
        out.tags = normalizeTags(source.tags); // NEW
        out.lastUpdated = String(source.lastUpdated || (options && options.keepExistingDate ? "" : nowIso())); // NEW
        return out; // NEW
    } // NEW

    function parseProfileRecord(cell, attrName) { // NEW
        const raw = getCellAttr(cell, attrName, ""); // NEW
        if (!raw) return { raw: "", invalid: false, profile: normalizeProfile({}, { keepExistingDate: true }) }; // NEW
        try { // NEW
            return { raw: raw, invalid: false, profile: normalizeProfile(JSON.parse(raw), { keepExistingDate: true }) }; // NEW
        } catch (e) { // NEW
            return { raw: raw, invalid: true, profile: normalizeProfile({}, { keepExistingDate: true }) }; // NEW
        } // NEW
    } // NEW

    function readBedConditions(bedCell) { // NEW
        return parseProfileRecord(bedCell, ATTRS.BED_JSON).profile; // NEW
    } // NEW

    function readDefaultBedConditions(moduleCell) { // NEW
        return parseProfileRecord(moduleCell, ATTRS.DEFAULT_JSON).profile; // NEW
    } // NEW

    function buildMirrorAttrs(profile) { // NEW
        const attrs = {}; // NEW
        Object.keys(MIRROR_ATTRS).forEach(function (key) { // NEW
            attrs[MIRROR_ATTRS[key]] = profile[key]; // NEW
        }); // NEW
        return attrs; // NEW
    } // NEW

    function writeBedConditions(bedCell, profile) { // NEW
        if (!isGardenBed(bedCell)) return null; // NEW
        const normalized = normalizeProfile(profile); // NEW
        const attrs = buildMirrorAttrs(normalized); // NEW
        attrs[ATTRS.BED_JSON] = JSON.stringify(normalized); // NEW
        setCellAttrs(bedCell, attrs); // NEW
        refreshBadgesSoon(); // NEW
        return normalized; // NEW
    } // NEW

    function writeDefaultBedConditions(moduleCell, profile) { // NEW
        if (!isGardenModule(moduleCell)) return null; // NEW
        const normalized = normalizeProfile(profile); // NEW
        setCellAttrs(moduleCell, { [ATTRS.DEFAULT_JSON]: JSON.stringify(normalized) }); // NEW
        refreshBadgesSoon(); // NEW
        return normalized; // NEW
    } // NEW

    function clearBedConditions(bedCell) { // NEW
        if (!isGardenBed(bedCell)) return; // NEW
        const attrs = { [ATTRS.BED_JSON]: null }; // NEW
        Object.keys(MIRROR_ATTRS).forEach(function (key) { // NEW
            attrs[MIRROR_ATTRS[key]] = null; // NEW
        }); // NEW
        setCellAttrs(bedCell, attrs); // NEW
        refreshBadgesSoon(); // NEW
    } // NEW

    function isMeaningfulOverride(key, value) { // NEW
        if (key === "trellis") return value === "none" || value === "available" || value === "required_structure"; // NEW
        return !!value && value !== "unknown"; // NEW
    } // NEW

    function getEffectiveBedConditions(bedCell) { // NEW
        const moduleCell = findGardenModuleAncestor(graph, bedCell); // NEW
        const defaults = moduleCell ? readDefaultBedConditions(moduleCell) : normalizeProfile({}, { keepExistingDate: true }); // NEW
        const bedRecord = parseProfileRecord(bedCell, ATTRS.BED_JSON); // NEW
        const out = normalizeProfile(defaults, { keepExistingDate: true }); // NEW
        FIELD_DEFS.forEach(function (field) { // NEW
            const value = bedRecord.profile[field.key]; // NEW
            if (isMeaningfulOverride(field.key, value)) out[field.key] = value; // NEW
        }); // NEW
        if (bedRecord.profile.notes) out.notes = bedRecord.profile.notes; // NEW
        if (bedRecord.profile.tags && bedRecord.profile.tags.length) out.tags = bedRecord.profile.tags.slice(); // NEW
        out.lastUpdated = bedRecord.profile.lastUpdated || defaults.lastUpdated || ""; // NEW
        return out; // NEW
    } // NEW

    function isBedCompatibleWithCrop() { // NEW
        return { compatible: true, hardFailures: [], warnings: [] }; // NEW
    } // NEW

    function scoreBedSuitability() { // NEW
        return { score: 0, reasons: [] }; // NEW
    } // NEW

    function getCellId(cell) { // NEW
        return cell && cell.getId ? cell.getId() : (cell && cell.id); // NEW
    } // NEW

    function collectDescendants(root) { // NEW
        const out = []; // NEW
        function visit(cell) { // NEW
            if (!cell) return; // NEW
            out.push(cell); // NEW
            const count = model.getChildCount ? model.getChildCount(cell) : 0; // NEW
            for (let i = 0; i < count; i++) visit(model.getChildAt(cell, i)); // NEW
        } // NEW
        visit(root); // NEW
        return out; // NEW
    } // NEW

    function collectBedsInModule(moduleCell) { // NEW
        return collectDescendants(moduleCell).filter(isGardenBed); // NEW
    } // NEW

    function collectSelectedBeds(fallbackBed) { // NEW
        const cells = graph.getSelectionCells ? (graph.getSelectionCells() || []) : []; // NEW
        const byId = new Map(); // NEW
        cells.forEach(function (cell) { // NEW
            if (isGardenBed(cell)) byId.set(getCellId(cell), cell); // NEW
        }); // NEW
        if (!byId.size && fallbackBed) byId.set(getCellId(fallbackBed), fallbackBed); // NEW
        return Array.from(byId.values()); // NEW
    } // NEW

    function resolveEventCell(cell, evt) { // NEW
        if (cell) return cell; // NEW
        if (evt && graph.popupMenuHandler && typeof graph.popupMenuHandler.getCellForEvent === "function") { // NEW
            return graph.popupMenuHandler.getCellForEvent(evt); // NEW
        } // NEW
        if (evt && graph.container && typeof mxUtils !== "undefined") { // NEW
            const pt = mxUtils.convertPoint(graph.container, mxEvent.getClientX(evt), mxEvent.getClientY(evt)); // NEW
            return graph.getCellAt ? graph.getCellAt(pt.x, pt.y) : null; // NEW
        } // NEW
        return graph.getSelectionCell ? graph.getSelectionCell() : null; // NEW
    } // NEW

    function resolveBedTarget(cell, evt) { // NEW
        const target = resolveEventCell(cell, evt); // NEW
        return isGardenBed(target) ? target : null; // NEW
    } // NEW

    function resolveModuleTarget(cell, evt) { // NEW
        const target = resolveEventCell(cell, evt); // NEW
        if (isGardenModule(target)) return target; // NEW
        return findGardenModuleAncestor(graph, target); // NEW
    } // NEW

    function showMessageDialog(title, lines) { // NEW
        const div = document.createElement("div"); // NEW
        div.style.padding = "14px"; // NEW
        div.style.maxWidth = "520px"; // NEW
        const heading = document.createElement("h3"); // NEW
        heading.style.margin = "0 0 10px"; // NEW
        heading.textContent = title; // NEW
        div.appendChild(heading); // NEW
        const pre = document.createElement("pre"); // NEW
        pre.style.whiteSpace = "pre-wrap"; // NEW
        pre.style.fontFamily = "Arial, sans-serif"; // NEW
        pre.style.fontSize = "13px"; // NEW
        pre.style.margin = "0 0 12px"; // NEW
        pre.textContent = (lines || []).join("\n"); // NEW
        div.appendChild(pre); // NEW
        const buttonRow = document.createElement("div"); // NEW
        buttonRow.style.textAlign = "right"; // NEW
        buttonRow.appendChild(mxUtils.button("Close", function () { ui.hideDialog(); })); // NEW
        div.appendChild(buttonRow); // NEW
        ui.showDialog(div, 540, 360, true, true); // NEW
    } // NEW

    function profileSummaryLines(profile) { // NEW
        const lines = []; // NEW
        FIELD_DEFS.forEach(function (field) { // NEW
            lines.push(field.label + ": " + valueLabel(profile[field.key])); // NEW
        }); // NEW
        if (profile.tags && profile.tags.length) lines.push("Tags: " + profile.tags.join(", ")); // NEW
        if (profile.notes) lines.push("Notes: " + profile.notes); // NEW
        if (profile.lastUpdated) lines.push("Last updated: " + profile.lastUpdated); // NEW
        return lines; // NEW
    } // NEW

    function makeSelect(field, value) { // NEW
        const select = document.createElement("select"); // NEW
        select.style.width = "100%"; // NEW
        field.values.forEach(function (optionValue) { // NEW
            const option = document.createElement("option"); // NEW
            option.value = optionValue; // NEW
            option.textContent = valueLabel(optionValue); // NEW
            select.appendChild(option); // NEW
        }); // NEW
        select.value = normalizeEnumValue(field.key, value); // NEW
        return select; // NEW
    } // NEW

    function appendSection(container, title) { // NEW
        const section = document.createElement("div"); // NEW
        section.style.borderTop = "1px solid #e5e7eb"; // NEW
        section.style.paddingTop = "8px"; // NEW
        section.style.marginTop = "8px"; // NEW
        const label = document.createElement("div"); // NEW
        label.textContent = title; // NEW
        label.style.fontWeight = "bold"; // NEW
        label.style.marginBottom = "6px"; // NEW
        section.appendChild(label); // NEW
        container.appendChild(section); // NEW
        return section; // NEW
    } // NEW

    function appendField(section, field, input) { // NEW
        const row = document.createElement("label"); // NEW
        row.style.display = "grid"; // NEW
        row.style.gridTemplateColumns = "130px 1fr"; // NEW
        row.style.alignItems = "center"; // NEW
        row.style.gap = "8px"; // NEW
        row.style.marginBottom = "6px"; // NEW
        const text = document.createElement("span"); // NEW
        text.textContent = field.label; // NEW
        row.appendChild(text); // NEW
        row.appendChild(input); // NEW
        section.appendChild(row); // NEW
    } // NEW

    function showConditionEditorDialog(targetCell, options) { // NEW
        const isDefault = !!(options && options.defaults); // NEW
        const current = isDefault ? readDefaultBedConditions(targetCell) : readBedConditions(targetCell); // NEW
        const div = document.createElement("div"); // NEW
        div.style.padding = "14px"; // NEW
        div.style.fontSize = "13px"; // NEW
        const title = document.createElement("h3"); // NEW
        title.textContent = isDefault ? "Default Bed Conditions" : "Bed Conditions"; // NEW
        title.style.margin = "0 0 10px"; // NEW
        div.appendChild(title); // NEW

        const presetRow = document.createElement("label"); // NEW
        presetRow.style.display = "grid"; // NEW
        presetRow.style.gridTemplateColumns = "130px 1fr"; // NEW
        presetRow.style.alignItems = "center"; // NEW
        presetRow.style.gap = "8px"; // NEW
        const presetSelect = document.createElement("select"); // NEW
        Object.keys(PRESETS).forEach(function (key) { // NEW
            const option = document.createElement("option"); // NEW
            option.value = key; // NEW
            option.textContent = PRESETS[key].label; // NEW
            presetSelect.appendChild(option); // NEW
        }); // NEW
        presetRow.appendChild(document.createTextNode("Preset")); // NEW
        presetRow.appendChild(presetSelect); // NEW
        div.appendChild(presetRow); // NEW

        const controls = Object.create(null); // NEW
        const growing = appendSection(div, "Growing Conditions"); // NEW
        ["sunExposure", "soilMoisture", "drainage", "soilTexture", "fertility"].forEach(function (key) { // NEW
            controls[key] = makeSelect(FIELD_BY_KEY[key], current[key]); // NEW
            appendField(growing, FIELD_BY_KEY[key], controls[key]); // NEW
        }); // NEW

        const infra = appendSection(div, "Infrastructure"); // NEW
        ["irrigation", "trellis", "windExposure", "frostRisk"].forEach(function (key) { // NEW
            controls[key] = makeSelect(FIELD_BY_KEY[key], current[key]); // NEW
            appendField(infra, FIELD_BY_KEY[key], controls[key]); // NEW
        }); // NEW

        const use = appendSection(div, "Use"); // NEW
        controls.bedUse = makeSelect(FIELD_BY_KEY.bedUse, current.bedUse); // NEW
        appendField(use, FIELD_BY_KEY.bedUse, controls.bedUse); // NEW

        const tagsInput = document.createElement("input"); // NEW
        tagsInput.type = "text"; // NEW
        tagsInput.value = (current.tags || []).join(", "); // NEW
        tagsInput.style.width = "100%"; // NEW
        appendField(use, { label: "Tags" }, tagsInput); // NEW

        const notesInput = document.createElement("textarea"); // NEW
        notesInput.value = current.notes || ""; // NEW
        notesInput.rows = 3; // NEW
        notesInput.style.width = "100%"; // NEW
        appendField(use, { label: "Notes" }, notesInput); // NEW

        presetSelect.addEventListener("change", function () { // NEW
            const preset = PRESETS[presetSelect.value]; // NEW
            Object.keys((preset && preset.values) || {}).forEach(function (key) { // NEW
                if (controls[key]) controls[key].value = preset.values[key]; // NEW
            }); // NEW
        }); // NEW

        function readDialogProfile() { // NEW
            const next = {}; // NEW
            FIELD_DEFS.forEach(function (field) { next[field.key] = controls[field.key].value; }); // NEW
            next.tags = tagsInput.value; // NEW
            next.notes = notesInput.value; // NEW
            return next; // NEW
        } // NEW

        function persistDefaultDialogState() { // NEW
            writeDefaultBedConditions(targetCell, readDialogProfile()); // NEW
            setCellAttrs(targetCell, { [ATTRS.BADGES]: badgeToggle && badgeToggle.checked ? "1" : null }); // NEW
        } // NEW

        const actionRow = document.createElement("div"); // NEW
        actionRow.style.display = "flex"; // NEW
        actionRow.style.justifyContent = "space-between"; // NEW
        actionRow.style.alignItems = "center"; // NEW
        actionRow.style.gap = "8px"; // NEW
        actionRow.style.marginTop = "12px"; // NEW
        actionRow.style.paddingTop = "10px"; // NEW
        actionRow.style.borderTop = "1px solid #e5e7eb"; // NEW
        const secondaryButtons = document.createElement("div"); // NEW
        secondaryButtons.style.display = "flex"; // NEW
        secondaryButtons.style.gap = "8px"; // NEW
        let badgeToggle = null; // NEW

        if (isDefault) { // NEW
            const badgeLabel = document.createElement("label"); // NEW
            badgeLabel.style.display = "flex"; // NEW
            badgeLabel.style.alignItems = "center"; // NEW
            badgeLabel.style.gap = "6px"; // NEW
            badgeToggle = document.createElement("input"); // NEW
            badgeToggle.type = "checkbox"; // NEW
            badgeToggle.checked = getCellAttr(targetCell, ATTRS.BADGES, "") === "1"; // NEW
            badgeLabel.appendChild(badgeToggle); // NEW
            badgeLabel.appendChild(document.createTextNode("Show condition badges")); // NEW
            actionRow.appendChild(badgeLabel); // NEW
            secondaryButtons.appendChild(mxUtils.button("Apply to Empty Beds", function () { // NEW
                model.beginUpdate(); // NEW
                try { // NEW
                    persistDefaultDialogState(); // NEW
                    applyDefaultsToEmptyBeds(targetCell); // NEW
                } finally { // NEW
                    model.endUpdate(); // NEW
                } // NEW
                ui.hideDialog(); // NEW
            })); // NEW
        } else { // NEW
            actionRow.appendChild(document.createElement("span")); // NEW
            secondaryButtons.appendChild(mxUtils.button("Copy", function () { copiedProfile = normalizeProfile(readDialogProfile()); })); // NEW
            secondaryButtons.appendChild(mxUtils.button("Paste", function () { // NEW
                if (!copiedProfile) { ui.alert("No copied bed conditions are available."); return; } // NEW
                const targets = collectSelectedBeds(targetCell); // NEW
                model.beginUpdate(); // NEW
                try { targets.forEach(function (target) { writeBedConditions(target, copiedProfile); }); } // NEW
                finally { model.endUpdate(); } // NEW
                ui.hideDialog(); // NEW
            })); // NEW
            secondaryButtons.appendChild(mxUtils.button("Clear Overrides", function () { // NEW
                const targets = collectSelectedBeds(targetCell); // NEW
                model.beginUpdate(); // NEW
                try { targets.forEach(clearBedConditions); } // NEW
                finally { model.endUpdate(); } // NEW
                ui.hideDialog(); // NEW
            })); // NEW
        } // NEW

        actionRow.appendChild(secondaryButtons); // NEW
        div.appendChild(actionRow); // NEW

        const buttonRow = document.createElement("div"); // NEW
        buttonRow.style.display = "flex"; // NEW
        buttonRow.style.justifyContent = "flex-end"; // NEW
        buttonRow.style.gap = "8px"; // NEW
        buttonRow.style.marginTop = "12px"; // NEW
        buttonRow.appendChild(mxUtils.button("Cancel", function () { ui.hideDialog(); })); // NEW
        buttonRow.appendChild(mxUtils.button("Save", function () { // NEW
            model.beginUpdate(); // NEW
            try { // NEW
                if (isDefault) persistDefaultDialogState(); // CHANGE
                else writeBedConditions(targetCell, readDialogProfile()); // CHANGE
            } finally { // NEW
                model.endUpdate(); // NEW
            } // NEW
            ui.hideDialog(); // NEW
        })); // NEW
        div.appendChild(buttonRow); // NEW
        ui.showDialog(div, 520, isDefault ? 660 : 650, true, true); // CHANGE
    } // NEW

    function setModuleBadgeVisibility(moduleCell, visible) { // NEW
        model.beginUpdate(); // NEW
        try { // NEW
            setCellAttrs(moduleCell, { [ATTRS.BADGES]: visible ? "1" : null }); // NEW
        } finally { // NEW
            model.endUpdate(); // NEW
        } // NEW
        refreshBadgesSoon(); // NEW
    } // NEW

    function applyDefaultsToEmptyBeds(moduleCell) { // NEW
        const defaults = readDefaultBedConditions(moduleCell); // NEW
        const beds = collectBedsInModule(moduleCell).filter(function (bed) { return !getCellAttr(bed, ATTRS.BED_JSON, ""); }); // NEW
        model.beginUpdate(); // NEW
        try { // NEW
            beds.forEach(function (bed) { writeBedConditions(bed, defaults); }); // NEW
        } finally { // NEW
            model.endUpdate(); // NEW
        } // NEW
        refreshBadgesSoon(); // NEW
    } // NEW

    function showBedConditions(bedCell) { // NEW
        const record = parseProfileRecord(bedCell, ATTRS.BED_JSON); // NEW
        const lines = []; // NEW
        if (record.invalid) lines.push("Warning: invalid saved bed_conditions_json; showing normalized fallback values.", ""); // NEW
        lines.push.apply(lines, profileSummaryLines(getEffectiveBedConditions(bedCell))); // NEW
        showMessageDialog("Bed Conditions", lines); // NEW
    } // NEW

    function showReviewDialog(moduleCell) { // NEW
        const beds = collectBedsInModule(moduleCell); // NEW
        const lines = beds.length ? beds.map(function (bed, index) { // NEW
            const label = getCellAttr(bed, "label", "") || "Bed " + (index + 1); // NEW
            return label + ": " + buildBadgeText(getEffectiveBedConditions(bed)); // NEW
        }) : ["No garden beds found in this module."]; // NEW
        showMessageDialog("Review Bed Conditions", lines); // NEW
    } // NEW

    function buildBadgeText(profile) { // NEW
        const parts = []; // NEW
        if (!profile || profile.sunExposure === "unknown") parts.push("Unknown sun"); // NEW
        else parts.push(valueLabel(profile.sunExposure)); // NEW
        if (profile.irrigation && profile.irrigation !== "unknown" && profile.irrigation !== "none") parts.push(valueLabel(profile.irrigation)); // NEW
        else if (profile.soilMoisture && profile.soilMoisture !== "unknown") parts.push(valueLabel(profile.soilMoisture)); // NEW
        if (profile.trellis === "available") parts.push("Trellis"); // NEW
        else if (profile.trellis === "required_structure") parts.push("Needs structure"); // NEW
        if (profile.bedUse && profile.bedUse !== "unknown" && profile.bedUse !== "annuals") parts.push(valueLabel(profile.bedUse)); // NEW
        return parts.join(" - "); // NEW
    } // NEW

    function createBadgeDiv() { // NEW
        const div = document.createElement("div"); // NEW
        div.style.position = "absolute"; // NEW
        div.style.pointerEvents = "none"; // NEW
        div.style.zIndex = "998"; // NEW
        div.style.padding = "2px 6px"; // NEW
        div.style.borderRadius = "6px"; // NEW
        div.style.fontSize = "11px"; // NEW
        div.style.lineHeight = "16px"; // NEW
        div.style.whiteSpace = "nowrap"; // NEW
        div.style.color = "#111827"; // NEW
        div.style.background = "rgba(254, 249, 195, 0.94)"; // NEW
        div.style.border = "1px solid rgba(161, 98, 7, 0.45)"; // NEW
        div.style.boxShadow = "0 1px 2px rgba(0,0,0,0.18)"; // NEW
        return div; // NEW
    } // NEW

    function ensureBadgeContainer() { // NEW
        if (!graph.container) return; // NEW
        const style = window.getComputedStyle ? window.getComputedStyle(graph.container) : null; // NEW
        if (style && style.position === "static") graph.container.style.position = "relative"; // NEW
    } // NEW

    function positionBadge(entry) { // NEW
        const state = graph.view && graph.view.getState ? graph.view.getState(entry.cell) : null; // NEW
        if (!state) return false; // NEW
        entry.div.style.left = Math.round(state.x + 6) + "px"; // NEW
        entry.div.style.top = Math.round(state.y + 6) + "px"; // NEW
        entry.div.textContent = buildBadgeText(getEffectiveBedConditions(entry.cell)); // NEW
        return true; // NEW
    } // NEW

    function removeBadge(cellId) { // NEW
        const entry = badgeOverlays.get(cellId); // NEW
        if (!entry) return; // NEW
        if (entry.div && entry.div.parentNode) entry.div.parentNode.removeChild(entry.div); // NEW
        badgeOverlays.delete(cellId); // NEW
    } // NEW

    function clearBadges() { // NEW
        Array.from(badgeOverlays.keys()).forEach(removeBadge); // NEW
    } // NEW

    function shouldShowBadgeForBed(bedCell) { // NEW
        const moduleCell = findGardenModuleAncestor(graph, bedCell); // NEW
        return !!moduleCell && getCellAttr(moduleCell, ATTRS.BADGES, "") === "1"; // NEW
    } // NEW

    function syncBadges() { // NEW
        ensureBadgeContainer(); // NEW
        if (!graph.container || !model.getRoot) return; // NEW
        const beds = collectDescendants(model.getRoot()).filter(function (cell) { return isGardenBed(cell) && shouldShowBadgeForBed(cell); }); // NEW
        const keep = new Set(); // NEW
        beds.forEach(function (bed) { // NEW
            const id = getCellId(bed); // NEW
            if (!id) return; // NEW
            keep.add(id); // NEW
            let entry = badgeOverlays.get(id); // NEW
            if (!entry) { // NEW
                entry = { cell: bed, div: createBadgeDiv() }; // NEW
                graph.container.appendChild(entry.div); // NEW
                badgeOverlays.set(id, entry); // NEW
            } // NEW
            entry.cell = bed; // NEW
            if (!positionBadge(entry)) removeBadge(id); // NEW
        }); // NEW
        Array.from(badgeOverlays.keys()).forEach(function (id) { // NEW
            if (!keep.has(id)) removeBadge(id); // NEW
        }); // NEW
    } // NEW

    function refreshBadgesSoon() { // NEW
        setTimeout(syncBadges, 0); // NEW
    } // NEW

    function registerTrellisContextMenuContributor(contributor) { // NEW
        function finishRegistration() { // NEW
            if (!window.TrellisContextMenu) return; // NEW
            window.TrellisContextMenu.install(ui); // NEW
            window.TrellisContextMenu.register(contributor); // NEW
        } // NEW
        if (window.TrellisContextMenu) finishRegistration(); // NEW
        else if (typeof mxscript === "function") mxscript("plugins/garden_planner_plugins/Trellis_Context_Menu.js", finishRegistration); // NEW
    } // NEW

    registerTrellisContextMenuContributor({ // NEW
        id: "gardenBedConditions", // NEW
        priority: 350, // NEW
        addItems: function (menu, cell, evt) { // NEW
            const bed = resolveBedTarget(cell, evt); // NEW
            const moduleCell = resolveModuleTarget(cell, evt); // NEW
            if (!bed && !moduleCell) return; // NEW
            menu.addSeparator(); // NEW
            if (bed) { // NEW
                menu.addItem("Set Bed Conditions...", null, function () { showConditionEditorDialog(bed); }); // NEW
                menu.addItem("View Bed Conditions", null, function () { showBedConditions(bed); }); // NEW
            } // NEW
            if (!bed && moduleCell) { // CHANGE
                menu.addItem("Set Default Bed Conditions...", null, function () { showConditionEditorDialog(moduleCell, { defaults: true }); }); // NEW
                menu.addItem("Review Bed Conditions", null, function () { showReviewDialog(moduleCell); }); // NEW
            } // NEW
        } // NEW
    }); // NEW

    const selectionModel = graph.getSelectionModel ? graph.getSelectionModel() : null; // NEW
    model.addListener && model.addListener(mxEvent.CHANGE, refreshBadgesSoon); // NEW
    if (selectionModel && selectionModel.addListener) selectionModel.addListener(mxEvent.CHANGE, refreshBadgesSoon); // NEW
    if (graph.view && graph.view.addListener) { // NEW
        graph.view.addListener(mxEvent.SCALE, refreshBadgesSoon); // NEW
        graph.view.addListener(mxEvent.TRANSLATE, refreshBadgesSoon); // NEW
        graph.view.addListener(mxEvent.SCALE_AND_TRANSLATE, refreshBadgesSoon); // NEW
    } // NEW
    if (graph.container && graph.container.addEventListener) graph.container.addEventListener("scroll", refreshBadgesSoon, { passive: true }); // NEW
    graph.addListener && graph.addListener(mxEvent.DESTROY, clearBadges); // NEW

    window.TrellisBedConditions = { // NEW
        getEffectiveBedConditions: getEffectiveBedConditions, // NEW
        readBedConditions: readBedConditions, // NEW
        writeBedConditions: writeBedConditions, // NEW
        clearBedConditions: clearBedConditions, // NEW
        readDefaultBedConditions: readDefaultBedConditions, // NEW
        writeDefaultBedConditions: writeDefaultBedConditions, // NEW
        isGardenBed: isGardenBed, // NEW
        findGardenModuleAncestor: function (cellOrGraph, maybeCell) { // NEW
            return maybeCell ? findGardenModuleAncestor(cellOrGraph, maybeCell) : findGardenModuleAncestor(graph, cellOrGraph); // NEW
        }, // NEW
        isBedCompatibleWithCrop: isBedCompatibleWithCrop, // NEW
        scoreBedSuitability: scoreBedSuitability, // NEW
        _test: { // NEW
            buildBadgeText: buildBadgeText, // NEW
            normalizeProfile: normalizeProfile, // NEW
            parseProfileRecord: parseProfileRecord, // NEW
            syncBadges: syncBadges, // NEW
            collectSelectedBeds: collectSelectedBeds, // NEW
            applyDefaultsToEmptyBeds: applyDefaultsToEmptyBeds // NEW
        } // NEW
    }; // NEW

    refreshBadgesSoon(); // NEW
}); // NEW
