const assert = require("node:assert/strict"); // NEW
const fs = require("node:fs"); // NEW
const path = require("node:path"); // NEW
const test = require("node:test"); // NEW

const PLUGIN_PATH = path.join( // NEW
    __dirname, // NEW
    "..", // NEW
    "drawio", // NEW
    "src", // NEW
    "main", // NEW
    "webapp", // NEW
    "plugins", // NEW
    "garden_planner_plugins", // NEW
    "Vertex_Linking_Standalone.js" // NEW
); // NEW

function readSource() { // NEW
    return fs.readFileSync(PLUGIN_PATH, "utf8"); // NEW
} // NEW

test("planting overlay has Cards, Schedule, and Occupancy modes", () => { // NEW
    const source = readSource(); // NEW

    assert.match(source, /const MODE_OCCUPANCY = 'occupancy';/); // NEW
    assert.match(source, /createModeButton\(entry, 'Cards', MODE_CARDS\)/); // NEW
    assert.match(source, /createModeButton\(entry, 'Schedule', MODE_SCHEDULE\)/); // NEW
    assert.match(source, /createModeButton\(entry, 'Occupancy', MODE_OCCUPANCY\)/); // NEW
    assert.match(source, /activeMode = mode === MODE_OCCUPANCY \? MODE_OCCUPANCY : \(mode === MODE_SCHEDULE \? MODE_SCHEDULE : MODE_CARDS\)/); // NEW
}); // NEW

test("schedule-only planting overlays expose Occupancy without linked tasks", () => { // NEW
    const source = readSource(); // NEW

    assert.match(source, /function createScheduleOnlyHeader\(entry\)[\s\S]*createModeButton\(entry, 'Schedule', MODE_SCHEDULE, effectiveMode\)/); // NEW
    assert.match(source, /function createScheduleOnlyHeader\(entry\)[\s\S]*createModeButton\(entry, 'Occupancy', MODE_OCCUPANCY, effectiveMode\)/); // NEW
    assert.match(source, /if \(activeMode === MODE_OCCUPANCY\) \{[\s\S]*renderOccupancyView\(entry, body\);[\s\S]*\}/); // NEW
}); // NEW

test("occupancy uses navigator API with selected-group fallback", () => { // NEW
    const source = readSource(); // NEW

    assert.match(source, /graph\.__trellisBedSuccessionNavigator\.getSelectedClusterOccupancy/); // NEW
    assert.match(source, /const result = api\.getSelectedClusterOccupancy\(source\);/); // NEW
    assert.match(source, /return fallbackOccupancyForSource\(source\);/); // NEW
}); // NEW

test("occupancy interval prefers transplant date, then sow date, and requires harvest end", () => { // NEW
    const source = readSource(); // NEW

    assert.match(source, /parseTaskOverlayDate\(getAttr\(cell, 'transplant_date'\)\) \|\| parseTaskOverlayDate\(getAttr\(cell, 'sow_date'\)\)/); // NEW
    assert.match(source, /parseTaskOverlayDate\(getAttr\(cell, 'harvest_end'\)\)/); // NEW
    assert.match(source, /if \(!start \|\| !end \|\| end\.dayNumber < start\.dayNumber\) return \{ startISO: null, endISO: null \};/); // NEW
    assert.match(source, /renderOccupancyUnscheduledSection\(entry, body, unscheduledItems\);/); // NEW
}); // NEW

test("occupancy rows select and reveal their planting group", () => { // NEW
    const source = readSource(); // NEW

    assert.match(source, /function makeOccupancyRow\(entry, item\)[\s\S]*const cell = item && item\.cellId \? model\.getCell\(item\.cellId\) : null;/); // NEW
    assert.match(source, /if \(cell && model\.isVertex\(cell\)\) selectAndReveal\(cell\);/); // NEW
}); // NEW
