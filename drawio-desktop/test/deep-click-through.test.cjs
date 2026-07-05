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
    "Deep_Click_Through.js" // NEW
); // NEW

class TestCell { // NEW
    constructor(id, attrs = {}, style = "") { // NEW
        this.id = id; // NEW
        this.attrs = { ...attrs }; // NEW
        this.style = style; // NEW
        this.children = []; // NEW
    } // NEW

    getAttribute(key) { return this.attrs[key] || null; } // NEW
} // NEW

class TestModel { // NEW
    constructor(root) { this.root = root; } // NEW
    getRoot() { return this.root; } // NEW
    getParent(cell) { return cell && cell.parent ? cell.parent : null; } // NEW
    getChildCount(cell) { return cell && cell.children ? cell.children.length : 0; } // NEW
    getChildAt(cell, index) { return cell.children[index]; } // NEW
    getChildCells(cell) { return cell && cell.children ? cell.children.slice() : []; } // NEW
    isVertex(cell) { return !!cell && cell !== this.root; } // NEW
} // NEW

function appendChild(parent, child) { // NEW
    child.parent = parent; // NEW
    parent.children.push(child); // NEW
    return child; // NEW
} // NEW

function makeHarness() { // NEW
    const dom = new JSDOM("<!doctype html><body><div id='graph'></div></body>"); // NEW
    const document = dom.window.document; // NEW
    const root = new TestCell("root"); // NEW
    const gardenModule = appendChild(root, new TestCell("garden", { garden_module: "1" }, "swimlane;module=1")); // NEW
    const legacyGardenModule = appendChild(root, new TestCell("legacyGarden", { trellis_garden_module: "1" }, "swimlane;module=1")); // NEW
    const regularModule = appendChild(root, new TestCell("regular", {}, "swimlane;module=1")); // NEW
    const bed = appendChild(gardenModule, new TestCell("bed", { garden_bed: "1" })); // NEW
    const tilerGroup = appendChild(gardenModule, new TestCell("tiler", { tiler_group: "1" })); // NEW
    const model = new TestModel(root); // NEW
    let selectedCells = []; // NEW
    const graph = { // NEW
        model, // NEW
        container: document.getElementById("graph"), // NEW
        view: { getState() { return null; } }, // NEW
        getModel() { return model; }, // NEW
        getCurrentRoot() { return root; }, // NEW
        getSelectionCells() { return selectedCells.slice(); }, // NEW
        setSelectionCell(cell) { selectedCells = cell ? [cell] : []; }, // NEW
        setSelectionCells(cells) { selectedCells = cells ? cells.slice() : []; }, // NEW
        clearSelection() { selectedCells = []; }, // NEW
        isCellSelected(cell) { return selectedCells.includes(cell); }, // NEW
        removeSelectionCell(cell) { selectedCells = selectedCells.filter(selected => selected !== cell); }, // NEW
        addSelectionCell(cell) { if (!selectedCells.includes(cell)) selectedCells.push(cell); }, // NEW
        isCellVisible() { return true; }, // NEW
        isCellMovable() { return true; }, // NEW
        getCellAt() { return graph.__hitCell || null; } // NEW
    }; // NEW
    const context = { // NEW
        window: dom.window, // NEW
        document, // NEW
        console: { debug() {}, log() {}, warn() {}, error() {} }, // NEW
        Draw: { loadPlugin(callback) { callback({ editor: { graph } }); } }, // NEW
        mxGraphHandler: function mxGraphHandler() {}, // NEW
        mxEvent: { // NEW
            isControlDown(evt) { return !!(evt && evt.ctrlKey); }, // NEW
            isMetaDown(evt) { return !!(evt && evt.metaKey); }, // NEW
            isShiftDown(evt) { return !!(evt && evt.shiftKey); }, // NEW
            getClientX(evt) { return evt && evt.clientX || 0; }, // NEW
            getClientY(evt) { return evt && evt.clientY || 0; } // NEW
        }, // NEW
        mxUtils: { // NEW
            convertPoint() { return { x: 0, y: 0 }; }, // NEW
            contains() { return true; }, // NEW
            getValue(style, key, fallback) { return style && key in style ? style[key] : fallback; }, // NEW
            toRadians(degrees) { return degrees * Math.PI / 180; }, // NEW
            getRotatedPoint(point) { return point; } // NEW
        }, // NEW
        mxConstants: { STYLE_ROTATION: "rotation" }, // NEW
        mxPoint: function mxPoint(x, y) { this.x = x; this.y = y; } // NEW
    }; // NEW
    context.mxGraphHandler.prototype = { // NEW
        isDelayedSelection() { return false; }, // NEW
        getCells(initialCell) { return [initialCell]; } // NEW
    }; // NEW
    vm.runInNewContext(fs.readFileSync(PLUGIN_PATH, "utf8"), context, { filename: PLUGIN_PATH }); // NEW
    return { graph, window: dom.window, gardenModule, legacyGardenModule, regularModule, bed, tilerGroup, getSelected: () => selectedCells.slice() }; // CHANGE
} // NEW

function plainClick(graph, cell, detail = 1) { // NEW
    graph.__hitCell = cell; // NEW
    graph.selectCellForEvent(cell, { detail, clientX: 0, clientY: 0 }); // NEW
} // NEW

function ctrlClick(graph, cell) { // NEW
    graph.__hitCell = cell; // NEW
    graph.selectCellForEvent(cell, { detail: 1, ctrlKey: true, clientX: 0, clientY: 0 }); // NEW
} // NEW

test("plain second-click on sole-selected garden module clears selection", () => { // NEW
    const { graph, gardenModule, getSelected } = makeHarness(); // NEW
    graph.setSelectionCell(gardenModule); // NEW
    plainClick(graph, gardenModule); // NEW
    assert.deepEqual(getSelected(), []); // NEW
}); // NEW

test("plain second-click on selected garden module closes graph-local irrigation mode before clearing selection", () => { // NEW
    const { graph, gardenModule, getSelected } = makeHarness(); // NEW
    const closeCalls = []; // NEW
    graph.__trellisIrrigationPlanner = { closeIrrigationMode() { closeCalls.push("graph"); } }; // NEW
    graph.setSelectionCell(gardenModule); // NEW
    plainClick(graph, gardenModule); // NEW
    assert.deepEqual(closeCalls, ["graph"]); // NEW
    assert.deepEqual(getSelected(), []); // NEW
}); // NEW

test("graph-local irrigation close is preferred over window fallback", () => { // NEW
    const { graph, window, gardenModule } = makeHarness(); // NEW
    const closeCalls = []; // NEW
    graph.__trellisIrrigationPlanner = { closeIrrigationMode() { closeCalls.push("graph"); } }; // NEW
    window.TrellisIrrigationPlanner = { closeIrrigationMode() { closeCalls.push("window"); } }; // NEW
    graph.setSelectionCell(gardenModule); // NEW
    plainClick(graph, gardenModule); // NEW
    assert.deepEqual(closeCalls, ["graph"]); // NEW
}); // NEW

test("window irrigation close is used when graph-local API is unavailable", () => { // NEW
    const { graph, window, gardenModule, getSelected } = makeHarness(); // NEW
    const closeCalls = []; // NEW
    window.TrellisIrrigationPlanner = { closeIrrigationMode() { closeCalls.push("window"); } }; // NEW
    graph.setSelectionCell(gardenModule); // NEW
    plainClick(graph, gardenModule); // NEW
    assert.deepEqual(closeCalls, ["window"]); // NEW
    assert.deepEqual(getSelected(), []); // NEW
}); // NEW

test("plain second-click also recognizes legacy garden module attribute", () => { // NEW
    const { graph, legacyGardenModule, getSelected } = makeHarness(); // NEW
    graph.setSelectionCell(legacyGardenModule); // NEW
    plainClick(graph, legacyGardenModule); // NEW
    assert.deepEqual(getSelected(), []); // NEW
}); // NEW

test("plain second-click on regular module stays selected", () => { // NEW
    const { graph, regularModule, getSelected } = makeHarness(); // NEW
    const closeCalls = []; // NEW
    graph.__trellisIrrigationPlanner = { closeIrrigationMode() { closeCalls.push("graph"); } }; // NEW
    graph.setSelectionCell(regularModule); // NEW
    plainClick(graph, regularModule); // NEW
    assert.deepEqual(getSelected(), [regularModule]); // NEW
    assert.deepEqual(closeCalls, []); // NEW
}); // NEW

test("plain second-click on garden objects other than modules stays selected", () => { // NEW
    const { graph, bed, tilerGroup, getSelected } = makeHarness(); // NEW
    const closeCalls = []; // NEW
    graph.__trellisIrrigationPlanner = { closeIrrigationMode() { closeCalls.push("graph"); } }; // NEW
    graph.setSelectionCell(bed); // NEW
    plainClick(graph, bed); // NEW
    assert.deepEqual(getSelected(), [bed]); // NEW
    graph.setSelectionCell(tilerGroup); // NEW
    plainClick(graph, tilerGroup); // NEW
    assert.deepEqual(getSelected(), [tilerGroup]); // NEW
    assert.deepEqual(closeCalls, []); // NEW
}); // NEW

test("ctrl-click selection toggle remains unchanged", () => { // NEW
    const { graph, gardenModule, getSelected } = makeHarness(); // NEW
    const closeCalls = []; // NEW
    graph.__trellisIrrigationPlanner = { closeIrrigationMode() { closeCalls.push("graph"); } }; // NEW
    graph.setSelectionCell(gardenModule); // NEW
    ctrlClick(graph, gardenModule); // NEW
    assert.deepEqual(getSelected(), []); // NEW
    assert.deepEqual(closeCalls, []); // NEW
}); // NEW

test("double-click on selected garden module does not clear selection", () => { // NEW
    const { graph, gardenModule, getSelected } = makeHarness(); // NEW
    const closeCalls = []; // NEW
    graph.__trellisIrrigationPlanner = { closeIrrigationMode() { closeCalls.push("graph"); } }; // NEW
    graph.setSelectionCell(gardenModule); // NEW
    plainClick(graph, gardenModule, 2); // NEW
    assert.deepEqual(getSelected(), [gardenModule]); // NEW
    assert.deepEqual(closeCalls, []); // NEW
}); // NEW
