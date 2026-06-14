const assert = require("node:assert/strict");
const test = require("node:test");
const {
    createYearPlannerHarness,
    makePlanCrop
} = require("./helpers/year-planner-harness.cjs");

function savePlan(harness, year, configure) {
    const plan = harness.api.PlanSchema.createEmptyPlan(year);
    plan.crops.push(makePlanCrop());
    if (configure) configure(plan);
    harness.api.PlanRepository.savePlanForYear(harness.moduleCell, year, plan);
    return plan;
}

function findCsaStrip(document) {
    return Array.from(document.querySelectorAll("button"))
        .find(button => button.textContent.trim().startsWith("CSA Box Plan:")) || null;
}

test("modal renders compact status, reordered tabs, Plan Check, and collapsed CSA", async t => {
    const harness = createYearPlannerHarness();
    t.after(() => harness.dom.window.close());
    savePlan(harness, 2026);

    await harness.openModal(2026);

    assert.match(harness.document.body.textContent, /2026 · 1 crop/);
    const tabLabels = Array.from(harness.document.querySelectorAll("button"))
        .map(button => button.textContent.trim())
        .filter(label => ["Basics", "Packages", "Demand", "Advanced"].includes(label));
    assert.deepEqual(tabLabels, ["Basics", "Packages", "Demand", "Advanced"]);
    assert.ok(harness.findButton("Show plan check"));
    assert.doesNotMatch(harness.document.body.textContent, /Diagnostics/);

    const csaStrip = findCsaStrip(harness.document);
    assert.ok(csaStrip);
    assert.match(csaStrip.textContent, /CSA Box Plan: Off/);
    assert.equal(csaStrip.getAttribute("aria-expanded"), "false");
    assert.equal(harness.findButton("Add component"), null);
});

test("template input controls save state and saves without a native prompt", async t => {
    const harness = createYearPlannerHarness();
    t.after(() => harness.dom.window.close());
    savePlan(harness, 2026);
    await harness.openModal(2026);

    const nameInput = harness.document.querySelector('input[placeholder="Template name"]');
    const saveTemplate = harness.findButton("Save template");
    const templateSelect = Array.from(harness.document.querySelectorAll("select"))
        .find(select => Array.from(select.options).some(option => option.textContent === "-- Select template --"));

    assert.ok(nameInput);
    assert.ok(saveTemplate);
    assert.ok(templateSelect);
    assert.equal(saveTemplate.disabled, true);

    harness.setControlValue(nameInput, "Market Plan");
    assert.equal(saveTemplate.disabled, false);
    saveTemplate.click();

    assert.deepEqual(Array.from(harness.api.PlanRepository.listTemplateNames()), ["Market Plan"]);
    assert.equal(templateSelect.value, "Market Plan");
    assert.equal(nameInput.value, "Market Plan");

    harness.setControlValue(nameInput, "   ");
    assert.equal(saveTemplate.disabled, true);
    templateSelect.value = "Market Plan";
    templateSelect.dispatchEvent(new harness.window.Event("change", { bubbles: true }));
    assert.equal(nameInput.value, "Market Plan");
    assert.equal(saveTemplate.disabled, false);
});

test("invalid enabled CSA auto-expands CSA and Plan Check", async t => {
    const harness = createYearPlannerHarness();
    t.after(() => harness.dom.window.close());
    savePlan(harness, 2026, plan => {
        plan.csa.enabled = true;
        plan.csa.boxesPerWeek = 0;
    });

    await harness.openModal(2026);

    const csaStrip = findCsaStrip(harness.document);
    assert.ok(csaStrip);
    assert.equal(csaStrip.getAttribute("aria-expanded"), "true");
    assert.match(csaStrip.textContent, /0 boxes\/week/);
    assert.ok(harness.findButton("Add component"));
    assert.ok(harness.findButton("Hide plan check"));
    assert.match(harness.document.body.textContent, /CSA enabled but boxes\/week is not set/);
});

test("CSA summary updates as controls and components change", async t => {
    const harness = createYearPlannerHarness();
    t.after(() => harness.dom.window.close());
    savePlan(harness, 2026);
    const session = await harness.openModal(2026);

    let csaStrip = findCsaStrip(harness.document);
    csaStrip.click();
    csaStrip = findCsaStrip(harness.document);
    const csaBox = csaStrip.parentElement;
    const enabled = csaBox.querySelector('input[type="checkbox"]');
    const boxes = csaBox.querySelector('input[type="number"]');
    const dates = csaBox.querySelectorAll('input[type="date"]');

    enabled.checked = true;
    enabled.dispatchEvent(new harness.window.Event("change", { bubbles: true }));
    harness.setControlValue(boxes, 25);
    harness.setControlValue(dates[0], "2026-06-01", "change");
    harness.setControlValue(dates[1], "2026-09-30", "change");
    harness.findButton("Add component").click();

    csaStrip = findCsaStrip(harness.document);
    assert.match(csaStrip.textContent, /25 boxes\/week/);
    assert.match(csaStrip.textContent, /Jun 01–Sep 30/);
    assert.match(csaStrip.textContent, /1 component/);

    await harness.settle(120);
    assert.equal(session.plan.csa.components.length, 1);
    assert.ok(harness.findButton("Show plan check"));
    assert.equal(harness.api.PlanSchema.validateCsa(session.plan).length, 0);
});

test("dirty close uses the inline save-discard-cancel workflow", async t => {
    const harness = createYearPlannerHarness();
    t.after(() => harness.dom.window.close());
    savePlan(harness, 2026);
    await harness.openModal(2026);

    harness.findButton("Packages").click();
    harness.findButton("Add package").click();
    harness.findButton("Close").click();

    assert.match(harness.document.body.textContent, /Unsaved changes\./);
    assert.ok(harness.findButton("Save and Close"));
    assert.ok(harness.findButton("Discard"));
    assert.ok(harness.findButton("Cancel"));

    harness.findButton("Cancel").click();
    assert.equal(harness.findButton("Save and Close").parentElement.style.display, "none");
    assert.ok(harness.findButton("Close"));
});

test("public plan request event opens one modal and replaces the active session", async t => {
    const harness = createYearPlannerHarness();
    t.after(() => harness.dom.window.close());
    savePlan(harness, 2026);

    harness.window.dispatchEvent(new harness.window.CustomEvent("usl:planYearRequested", {
        detail: { moduleCellId: harness.moduleCell.id, year: 2026 }
    }));
    await harness.settle();
    assert.match(harness.document.body.textContent, /Plan Year - 2026/);
    assert.equal(harness.document.body.children.length, 1);

    harness.window.dispatchEvent(new harness.window.CustomEvent("usl:planYearRequested", {
        detail: { moduleCellId: harness.moduleCell.id, year: 2027 }
    }));
    await harness.settle();
    assert.match(harness.document.body.textContent, /Plan Year - 2027/);
    assert.equal(harness.document.body.children.length, 1);
});
