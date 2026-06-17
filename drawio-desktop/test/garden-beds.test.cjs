const assert = require("node:assert/strict"); // NEW
const fs = require("node:fs"); // NEW
const path = require("node:path"); // NEW
const test = require("node:test"); // NEW
const vm = require("node:vm"); // NEW
const { JSDOM } = require("jsdom"); // NEW

const PLUGIN_PATH = path.join( // NEW
    __dirname, // NEW
    "..", // NEW
    "drawio", // NEW
    "src", // NEW
    "main", // NEW
    "webapp", // NEW
    "plugins", // NEW
    "garden_planner_plugins", // NEW
    "Garden_Beds.js" // CHANGE
); // NEW

class TestCell { // NEW
    constructor(id, value = "", style = "") { // NEW
        this.id = id; // NEW
        this.value = value; // NEW
        this.style = style; // NEW
        this.children = []; // NEW
    } // NEW

    getId() { return this.id; } // NEW
    getStyle() { return this.style; } // NEW

    getAttribute(key) { // NEW
        return this.value && this.value.nodeType === 1 ? this.value.getAttribute(key) : null; // NEW
    } // NEW
} // NEW

class TestModel { // NEW
    constructor(root) { // NEW
        this.root = root; // NEW
        this.valuesWritten = 0; // NEW
        this.listeners = new Map(); // NEW
    } // NEW

    getRoot() { return this.root; } // NEW
    getParent(cell) { return cell && cell.parent ? cell.parent : null; } // NEW
    getChildCount(cell) { return cell && cell.children ? cell.children.length : 0; } // NEW
    getChildAt(cell, index) { return cell.children[index]; } // NEW
    setValue(cell, value) { cell.value = value; this.valuesWritten++; } // NEW
    beginUpdate() {} // NEW
    endUpdate() {} // NEW
    addListener(name, fn) { // CHANGE
        if (!this.listeners.has(name)) this.listeners.set(name, []); // NEW
        this.listeners.get(name).push(fn); // NEW
    } // CHANGE
    fire(name) { (this.listeners.get(name) || []).forEach(fn => fn(this, {})); } // NEW
} // NEW

function appendChild(parent, child) { // NEW
    child.parent = parent; // NEW
    parent.children.push(child); // NEW
    return child; // NEW
} // NEW

class TestMenu { // NEW
    constructor() { // NEW
        this.items = []; // NEW
    } // NEW

    addSeparator() { this.items.push({ separator: true }); } // NEW
    addItem(label, image, fn) { this.items.push({ label, fn }); return this.items[this.items.length - 1]; } // NEW
    labels() { return this.items.map(item => item.label).filter(Boolean); } // NEW
    click(label) { // NEW
        const item = this.items.find(entry => entry.label === label); // NEW
        assert.ok(item, "missing menu item " + label); // NEW
        item.fn(); // NEW
    } // NEW
} // NEW

function makeXmlCell(document, id, attrs, style = "") { // NEW
    const node = document.implementation.createDocument("", "", null).createElement("object"); // NEW
    Object.entries(attrs || {}).forEach(([key, value]) => node.setAttribute(key, value)); // NEW
    return new TestCell(id, node, style); // NEW
} // NEW

function loadPlugin(options = {}) { // NEW
    const dom = new JSDOM("<!doctype html><body><div id='graph'></div></body>"); // NEW
    const document = dom.window.document; // NEW
    const root = new TestCell("root"); // NEW
    const moduleCell = appendChild(root, makeXmlCell(document, "module", { garden_module: "1", label: "Garden" }, "swimlane;module=1")); // NEW
    const bed = appendChild(moduleCell, makeXmlCell(document, "bed", { garden_bed: "1", label: "Bed 1" })); // NEW
    const bed2 = appendChild(moduleCell, makeXmlCell(document, "bed2", { garden_bed: "1", label: "Bed 2" })); // NEW
    const model = new TestModel(root); // NEW
    const contributors = []; // NEW
    const graph = { // NEW
        __states: new Map([[bed, { x: 10, y: 20, width: 100, height: 60 }], [bed2, { x: 130, y: 20, width: 100, height: 60 }]]), // NEW
        container: document.getElementById("graph"), // NEW
        popupMenuHandler: {}, // NEW
        getModel() { return model; }, // NEW
        getSelectionCells() { return options.selectedCells || []; }, // NEW
        getSelectionCell() { return (options.selectedCells || [])[0] || null; }, // NEW
        getSelectionModel() { return { addListener() {} }; }, // NEW
        view: { // NEW
            getState: cell => graph.__states.get(cell), // NEW
            addListener() {} // NEW
        }, // NEW
        addListener() {} // NEW
    }; // NEW
    const ui = { // NEW
        editor: { graph }, // NEW
        alert(message) { ui.lastAlert = message; }, // NEW
        showDialog(div) { ui.lastDialog = div; }, // NEW
        hideDialog() { ui.hidden = true; } // NEW
    }; // NEW
    const context = { // NEW
        window: dom.window, // NEW
        document, // NEW
        console, // NEW
        setTimeout(fn) { fn(); }, // NEW
        Draw: { loadPlugin(callback) { callback(ui); } }, // NEW
        mxEvent: { CHANGE: "change", SCALE: "scale", TRANSLATE: "translate", SCALE_AND_TRANSLATE: "scaleAndTranslate", DESTROY: "destroy" }, // NEW
        mxUtils: { // NEW
            createXmlDocument() { return document.implementation.createDocument("", "", null); }, // NEW
            button(label, fn) { const button = document.createElement("button"); button.textContent = label; button.addEventListener("click", fn); return button; } // NEW
        } // NEW
    }; // NEW
    dom.window.TrellisContextMenu = { // NEW
        install() {}, // NEW
        register(contributor) { contributors.push(contributor); } // NEW
    }; // NEW

    vm.runInNewContext(fs.readFileSync(PLUGIN_PATH, "utf8"), context, { filename: PLUGIN_PATH }); // NEW
    return { api: dom.window.TrellisGardenBeds, legacyApi: dom.window.TrellisBedConditions, contributors, graph, model, root, moduleCell, bed, bed2, ui, document }; // CHANGE
} // NEW

function getDialogButton(ui, label) { // NEW
    const buttons = Array.from(ui.lastDialog.querySelectorAll("button")); // NEW
    const button = buttons.find(entry => entry.textContent === label); // NEW
    assert.ok(button, "missing dialog button " + label); // NEW
    return button; // NEW
} // NEW

function getDialogButtonLabels(ui) { // NEW
    return Array.from(ui.lastDialog.querySelectorAll("button")).map(button => button.textContent); // NEW
} // NEW

test("context menu contributor registers only garden bed actions", () => { // CHANGE
    const { api, legacyApi, contributors, bed, moduleCell } = loadPlugin(); // CHANGE
    assert.equal(contributors.length, 1); // NEW
    assert.equal(contributors[0].id, "gardenBeds"); // CHANGE
    assert.equal(legacyApi, api); // NEW

    const bedMenu = new TestMenu(); // CHANGE
    contributors[0].addItems(bedMenu, bed, null); // CHANGE

    assert.deepEqual(bedMenu.labels(), [ // CHANGE
        "Set Bed Conditions...", // NEW
        "View Bed Conditions" // CHANGE
    ]); // CHANGE

    const moduleMenu = new TestMenu(); // NEW
    contributors[0].addItems(moduleMenu, moduleCell, null); // NEW
    assert.deepEqual(moduleMenu.labels(), []); // CHANGE
}); // NEW

test("bed and default conditions persist, mirror, merge, and clear safely", () => { // NEW
    const { api, moduleCell, bed } = loadPlugin(); // NEW

    api.writeDefaultBedConditions(moduleCell, { // NEW
        sunExposure: "full_sun", // NEW
        soilTexture: "loamy", // NEW
        irrigation: "manual" // NEW
    }); // NEW
    api.writeBedConditions(bed, { // NEW
        sunExposure: "part_shade", // NEW
        soilMoisture: "bogus", // NEW
        irrigation: "drip", // NEW
        trellis: "available", // NEW
        notes: "Gets fence shade.", // NEW
        tags: ["near_path", "near_path"] // NEW
    }); // NEW

    const stored = JSON.parse(bed.getAttribute("bed_conditions_json")); // NEW
    assert.equal(bed.getAttribute("label"), "Bed 1"); // NEW
    assert.equal(stored.soilMoisture, "unknown"); // NEW
    assert.equal(bed.getAttribute("sun_exposure"), "part_shade"); // NEW
    assert.equal(bed.getAttribute("irrigation"), "drip"); // NEW
    assert.equal(bed.getAttribute("trellis"), "available"); // NEW
    assert.deepEqual(stored.tags, ["near_path"]); // NEW

    const effective = api.getEffectiveBedConditions(bed); // NEW
    assert.equal(effective.sunExposure, "part_shade"); // NEW
    assert.equal(effective.soilTexture, "loamy"); // NEW
    assert.equal(effective.irrigation, "drip"); // NEW
    assert.equal(effective.trellis, "available"); // NEW

    api.clearBedConditions(bed); // NEW
    assert.equal(bed.getAttribute("bed_conditions_json"), null); // NEW
    assert.equal(bed.getAttribute("sun_exposure"), null); // NEW
    assert.equal(bed.getAttribute("label"), "Bed 1"); // NEW
}); // NEW

test("newly created garden beds inherit module default conditions", () => { // NEW
    const { api, moduleCell, bed, model, document } = loadPlugin(); // NEW
    api.writeDefaultBedConditions(moduleCell, { // NEW
        sunExposure: "full_sun", // NEW
        soilMoisture: "moderate", // NEW
        irrigation: "drip", // NEW
        trellis: "available" // NEW
    }); // NEW

    assert.equal(bed.getAttribute("bed_conditions_json"), null); // NEW
    const newBed = appendChild(moduleCell, makeXmlCell(document, "newBed", { garden_bed: "1", label: "New Bed" })); // NEW
    model.fire("change"); // NEW

    const stored = JSON.parse(newBed.getAttribute("bed_conditions_json")); // NEW
    assert.equal(stored.sunExposure, "full_sun"); // NEW
    assert.equal(stored.soilMoisture, "moderate"); // NEW
    assert.equal(stored.irrigation, "drip"); // NEW
    assert.equal(newBed.getAttribute("sun_exposure"), "full_sun"); // NEW
    assert.equal(newBed.getAttribute("irrigation"), "drip"); // NEW
    assert.equal(bed.getAttribute("bed_conditions_json"), null); // NEW
}); // NEW

test("invalid JSON and invalid enum values normalize to non-throwing defaults", () => { // NEW
    const { api, bed } = loadPlugin(); // NEW
    bed.value.setAttribute("bed_conditions_json", "{not-json"); // NEW

    assert.equal(api.readBedConditions(bed).sunExposure, "unknown"); // NEW
    assert.equal(api._test.parseProfileRecord(bed, "bed_conditions_json").invalid, true); // NEW
    assert.equal(api._test.normalizeProfile({ sunExposure: "lava", trellis: "maybe" }).sunExposure, "unknown"); // NEW
    assert.equal(api._test.normalizeProfile({ sunExposure: "lava", trellis: "maybe" }).trellis, "none"); // NEW
}); // NEW

test("bed dialog exposes copy, paste, set-default, and clear actions", () => { // CHANGE
    const setup = loadPlugin(); // NEW
    const { api, contributors, moduleCell, bed, bed2, ui } = setup; // CHANGE
    api.writeBedConditions(bed, { sunExposure: "full_sun", irrigation: "drip", trellis: "available" }); // NEW

    const copyMenu = new TestMenu(); // NEW
    contributors[0].addItems(copyMenu, bed, null); // NEW
    copyMenu.click("Set Bed Conditions..."); // CHANGE
    assert.deepEqual(getDialogButtonLabels(ui), ["Copy", "Paste", "Set as Default", "Clear", "Cancel", "Save"]); // CHANGE
    getDialogButton(ui, "Copy").click(); // CHANGE
    getDialogButton(ui, "Set as Default").click(); // NEW
    assert.equal(JSON.parse(moduleCell.getAttribute("default_bed_conditions_json")).sunExposure, "full_sun"); // NEW

    setup.graph.getSelectionCells = () => [bed, bed2]; // NEW
    const pasteMenu = new TestMenu(); // NEW
    contributors[0].addItems(pasteMenu, bed2, null); // NEW
    pasteMenu.click("Set Bed Conditions..."); // CHANGE
    getDialogButton(ui, "Paste").click(); // CHANGE

    assert.equal(bed2.getAttribute("sun_exposure"), "full_sun"); // NEW
    assert.equal(bed2.getAttribute("irrigation"), "drip"); // NEW
    assert.equal(bed2.getAttribute("trellis"), "available"); // NEW

    setup.graph.getSelectionCells = () => [bed2]; // NEW
    const clearMenu = new TestMenu(); // NEW
    contributors[0].addItems(clearMenu, bed2, null); // NEW
    clearMenu.click("Set Bed Conditions..."); // NEW
    getDialogButton(ui, "Clear").click(); // CHANGE
    assert.equal(bed2.getAttribute("bed_conditions_json"), null); // NEW
}); // NEW

test("default conditions can still be applied to empty beds without module context options", () => { // CHANGE
    const { api, contributors, moduleCell, bed2 } = loadPlugin(); // CHANGE
    api.writeDefaultBedConditions(moduleCell, { sunExposure: "full_sun", irrigation: "manual" }); // NEW

    const menu = new TestMenu(); // NEW
    contributors[0].addItems(menu, moduleCell, null); // NEW
    assert.deepEqual(menu.labels(), []); // CHANGE
    api._test.applyDefaultsToEmptyBeds(moduleCell); // CHANGE
    assert.equal(JSON.parse(bed2.getAttribute("bed_conditions_json")).sunExposure, "full_sun"); // NEW
}); // NEW

test("badges use priority text and respect module visibility", () => { // NEW
    const { api, moduleCell, bed, graph } = loadPlugin(); // NEW
    api.writeBedConditions(bed, { sunExposure: "full_sun", irrigation: "drip", trellis: "available" }); // NEW

    api._test.syncBadges(); // NEW
    assert.equal(graph.container.children.length, 0); // NEW

    api.writeDefaultBedConditions(moduleCell, { sunExposure: "part_shade", soilMoisture: "moist" }); // NEW
    moduleCell.value.setAttribute("show_bed_condition_badges", "1"); // NEW
    api._test.syncBadges(); // NEW

    assert.equal(api._test.buildBadgeText(api.getEffectiveBedConditions(bed)), "Full sun - Drip - Trellis"); // NEW
    assert.equal(graph.container.children.length, 2); // NEW
    assert.equal(graph.container.children[0].textContent, "Full sun - Drip - Trellis"); // NEW

    moduleCell.value.removeAttribute("show_bed_condition_badges"); // NEW
    api._test.syncBadges(); // NEW
    assert.equal(graph.container.children.length, 0); // NEW
}); // NEW
