const assert = require("node:assert/strict"); // NEW
const fs = require("node:fs"); // NEW
const path = require("node:path"); // NEW
const test = require("node:test"); // NEW
const vm = require("node:vm"); // NEW
const { JSDOM } = require("jsdom"); // NEW

const projectRoot = path.resolve(__dirname, ".."); // NEW
const pluginPath = path.join(projectRoot, "drawio/src/main/webapp/plugins/garden_planner_plugins/Trellis_Users.js"); // NEW

class TestCell { // NEW
    constructor(id, value = null, style = "") { // NEW
        this.id = id; // NEW
        this.value = value; // NEW
        this.style = style; // NEW
        this.children = []; // NEW
        this.vertex = true; // NEW
    } // NEW
    getId() { return this.id; } // NEW
    getAttribute(key) { return this.value && this.value.nodeType === 1 ? this.value.getAttribute(key) : null; } // NEW
    setAttribute(key, value) { if (this.value && this.value.nodeType === 1) this.value.setAttribute(key, value); } // NEW
    removeAttribute(key) { if (this.value && this.value.nodeType === 1) this.value.removeAttribute(key); } // NEW
} // NEW

class TestModel { // NEW
    constructor(root) { // NEW
        this.root = root; // NEW
        this.listeners = new Map(); // NEW
        this.cells = new Map(); // NEW
        this.index(root); // NEW
    } // NEW
    index(cell) { cell.model = this; this.cells.set(cell.id, cell); (cell.children || []).forEach(child => this.index(child)); } // CHANGE
    getRoot() { return this.root; } // NEW
    getParent(cell) { return cell && cell.parent ? cell.parent : null; } // NEW
    getChildCount(cell) { return cell && cell.children ? cell.children.length : 0; } // NEW
    getChildAt(cell, index) { return cell.children[index]; } // NEW
    getCell(id) { return this.cells.get(id) || null; } // NEW
    beginUpdate() {} // NEW
    endUpdate() {} // NEW
    setValue(cell, value) { this.setValueCalls = (this.setValueCalls || 0) + 1; cell.value = value; } // CHANGE
    addListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(fn); } // NEW
    fireChange(edit) { (this.listeners.get("change") || []).forEach(fn => fn(this, { getProperty: key => key === "edit" ? edit : null })); } // NEW
} // NEW

function appendChild(parent, child) { // NEW
    child.parent = parent; // NEW
    parent.children.push(child); // NEW
    if (parent.model) parent.model.index(child); // NEW
    return child; // NEW
} // NEW

function linkCells(left, right) { // NEW
    [ // NEW
        [left, right], // NEW
        [right, left] // NEW
    ].forEach(([source, target]) => { // NEW
        const ids = new Set(String(source.getAttribute("linkedTo") || "").split(",").map(part => part.trim()).filter(Boolean)); // NEW
        ids.add(target.id); // NEW
        source.setAttribute("linkedTo", Array.from(ids).join(",")); // NEW
    }); // NEW
} // NEW

function installGardenRoleModuleApi(harness) { // NEW
    harness.graph.__trellisModules = { // NEW
        ensureGardenTeamModule(garden) { // NEW
            const existingId = garden.getAttribute("trellis_team_module_id"); // NEW
            const existing = existingId && harness.model.getCell(existingId); // NEW
            if (existing) return existing; // NEW
            const team = appendChild(harness.layer, makeXmlCell(harness.document, "team-" + garden.id, { label: (garden.getAttribute("label") || "Garden") + " Team", team_module: "1", trellis_garden_module_id: garden.id })); // CHANGE
            team.style = "module=1"; // NEW
            garden.setAttribute("trellis_team_module_id", team.id); // NEW
            linkCells(garden, team); // NEW
            return team; // NEW
        }, // NEW
        createRoleCard(team, x, y) { // NEW
            const role = appendChild(team, new TestCell("role-" + team.id + "-" + (team.children.length + 1), makeXmlCell(harness.document, "role-value", { label: "Role" }).value, "shape=swimlane;role_card=1;role_card_version=2;")); // NEW
            appendChild(role, new TestCell(role.id + "-name", "", "shape=rectangle;role_name=1;")); // NEW
            appendChild(role, new TestCell(role.id + "-title", "", "shape=rectangle;role_title=1;")); // NEW
            appendChild(role, new TestCell(role.id + "-contact", "", "shape=rectangle;role_contact=1;")); // NEW
            role.createdAt = { x, y }; // NEW
            return role; // NEW
        }, // NEW
        addReciprocalLink: linkCells, // CHANGE
        applyModuleMargins(moduleCell, opts) { // NEW
            harness.moduleMarginCalls = harness.moduleMarginCalls || []; // NEW
            harness.moduleMarginCalls.push({ moduleCell, opts }); // NEW
        } // NEW
    }; // NEW
} // NEW

function roleFieldText(roleCard, flag) { // NEW
    const field = (roleCard.children || []).find(child => String(child.style || "").includes(flag + "=1")); // NEW
    return field && field.value && field.value.nodeType === 1 ? field.value.getAttribute("label") : (field ? field.value : ""); // NEW
} // NEW

function makeXmlCell(document, id, attrs = {}) { // NEW
    const node = document.implementation.createDocument("", "", null).createElement("object"); // NEW
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value)); // NEW
    return new TestCell(id, node); // NEW
} // NEW

function loadUsersPlugin(options = {}) { // CHANGE
    const dom = new JSDOM("<!doctype html><body><div id='host'><div id='graph'></div></div></body>", { url: "https://app.test/" }); // NEW
    const document = dom.window.document; // NEW
    Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: 1024 }); // NEW
    Object.defineProperty(dom.window, "innerHeight", { configurable: true, value: 768 }); // NEW
    const root = new TestCell("root"); // NEW
    const layer = appendChild(root, makeXmlCell(document, "layer", { label: "Layer" })); // NEW
    const module = appendChild(layer, makeXmlCell(document, "module", { label: "Module" })); // NEW
    const card = appendChild(module, makeXmlCell(document, "card", { label: "Card" })); // NEW
    const outside = appendChild(layer, makeXmlCell(document, "outside", { label: "Outside" })); // NEW
    const model = new TestModel(root); // NEW
    const graphListeners = new Map(); // NEW
    const editorListeners = new Map(); // NEW
    const graph = { // NEW
        container: document.getElementById("graph"), // NEW
        getModel() { return model; }, // NEW
        getDefaultParent() { return layer; }, // NEW
        getSelectionCell() { return graph.selectedCells && graph.selectedCells.length ? graph.selectedCells[0] : (graph.selected || null); }, // CHANGE
        getSelectionCells() { return graph.selectedCells || (graph.selected ? [graph.selected] : []); }, // CHANGE
        setSelectionCell(cell) { graph.selected = cell; graph.selectedCells = cell ? [cell] : []; }, // CHANGE
        setSelectionCells(cells) { graph.selectedCells = (cells || []).filter(Boolean); graph.selected = graph.selectedCells[0] || null; }, // NEW
        getSelectionModel() { return { addListener() {} }; }, // NEW
        addListener(name, fn) { if (!graphListeners.has(name)) graphListeners.set(name, []); graphListeners.get(name).push(fn); }, // NEW
        setEnabled(value) { graph.enabled = value; }, // NEW
        refresh() { graph.refreshed = true; } // NEW
    }; // NEW
    const actions = {}; // NEW
    const toolbarContainer = document.createElement("div"); // NEW
    document.body.insertBefore(toolbarContainer, document.body.firstChild); // NEW
    if (options.historyButton) { // NEW
        const history = document.createElement("button"); // NEW
        history.className = "geButton trellis-changemap-history-button"; // NEW
        history.textContent = "History"; // NEW
        toolbarContainer.appendChild(history); // NEW
    } // NEW
    const ui = { // NEW
        editor: { // CHANGE
            graph, // NEW
            addListener(name, fn) { if (!editorListeners.has(name)) editorListeners.set(name, []); editorListeners.get(name).push(fn); }, // CHANGE
            setGraphXml(node) { // NEW
                ui.setGraphXmlCalls = (ui.setGraphXmlCalls || 0) + 1; // NEW
                const edit = ui.setGraphXmlEdit || { changes: [{ constructor: { name: "mxChildChange" }, child: module, parent: layer }], undo() { ui.setGraphXmlUndone = true; } }; // NEW
                model.fireChange(edit); // NEW
                ui.setGraphXmlNode = node; // NEW
            } // NEW
        }, // CHANGE
        actions: { addAction(id, fn) { actions[id] = { funct: fn }; } }, // NEW
        menus: { get() { return null; }, addMenuItems() {} }, // CHANGE
        toolbarContainer, // NEW
        fileLoaded(file) { ui.loadedFile = file; (editorListeners.get("fileLoaded") || []).forEach(fn => fn()); }, // NEW
        getCurrentFile() { return ui.currentFile || null; } // NEW
    }; // NEW
    const testConsole = Object.prototype.hasOwnProperty.call(options, "console") ? options.console : console; // NEW
    const context = { // NEW
        window: dom.window, document, console: testConsole, Promise, Error, String, Number, Math, Date, Set, Map, JSON, // CHANGE
        setTimeout: fn => { fn(); return 1; }, // NEW
        Draw: { loadPlugin(callback) { callback(ui); } }, // NEW
        mxEvent: { CHANGE: "change" }, // NEW
        mxUtils: { createXmlDocument() { return document.implementation.createDocument("", "", null); } } // NEW
    }; // NEW
    vm.runInNewContext(fs.readFileSync(pluginPath, "utf8"), context, { filename: pluginPath }); // NEW
    const loginButton = document.querySelector(".trellis-users-login-button"); // NEW
    if (loginButton) loginButton.getBoundingClientRect = () => ({ left: 850, right: 910, top: 10, bottom: 34, width: 60, height: 24 }); // NEW
    return { context, document, graph, model, layer, module, card, outside, actions, ui, toolbarContainer, editorListeners }; // CHANGE
} // NEW

function buttonByText(document, text) { // NEW
    return Array.from(document.querySelectorAll("button")).find(button => button.textContent === text); // NEW
} // NEW

function inputByPlaceholder(document, text) { // NEW
    return Array.from(document.querySelectorAll("input")).find(input => input.placeholder === text); // NEW
} // NEW

function userGroupByTitle(document, title) { // NEW
    return Array.from(document.querySelectorAll(".trellis-users-user-group")).find(group => group.getAttribute("data-trellis-users-group") === title); // NEW
} // NEW

function selectByOptionText(document, text) { // NEW
    return Array.from(document.querySelectorAll("select")).find(select => Array.from(select.options || []).some(option => option.textContent === text)); // NEW
} // NEW

function checkboxByLabel(document, text) { // NEW
    return labelByText(document, text)?.querySelector("input[type='checkbox']") || null; // CHANGE
} // NEW

function accessRowByUserId(document, userId) { // NEW
    return document.querySelector('.trellis-users-access-row[data-trellis-users-user-id="' + userId + '"]'); // NEW
} // NEW

function openGardenAccessPopover(document, userId) { // NEW
    const dropdown = document.querySelector('.trellis-users-garden-access-dropdown[data-trellis-users-user-id="' + userId + '"]'); // NEW
    assert.ok(dropdown); // NEW
    const button = dropdown.querySelector(".trellis-users-garden-access-button"); // NEW
    assert.ok(button); // NEW
    if (button.getAttribute("aria-expanded") !== "true") button.click(); // NEW
    const reopened = document.querySelector('.trellis-users-garden-access-dropdown[data-trellis-users-user-id="' + userId + '"]'); // NEW
    assert.ok(reopened); // NEW
    return reopened; // NEW
} // NEW

function gardenAccessRow(document, userId, gardenId) { // NEW
    const selector = '.trellis-users-garden-access-row[data-trellis-users-user-id="' + userId + '"]' + (gardenId ? '[data-trellis-users-garden-id="' + gardenId + '"]' : ''); // NEW
    return document.querySelector(selector); // NEW
} // NEW

function labelByText(root, text) { // NEW
    return Array.from(root.querySelectorAll("label")).find(label => label.textContent.trim() === text) || null; // NEW
} // NEW

function checkboxByLabelIn(root, text) { // NEW
    return labelByText(root, text)?.querySelector("input[type='checkbox']") || null; // CHANGE
} // NEW

test("disabled diagrams do not prompt or block edits", () => { // CHANGE
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    assert.equal(users.isEnabled(), false); // NEW
    assert.equal(harness.document.querySelector(".trellis-users-auth-overlay"), null); // NEW
    assert.ok(harness.document.querySelector(".trellis-users-login-button")); // NEW
    assert.equal(users.canEditCell(harness.card), true); // NEW
    assert.equal(users.login("Alice", "1234").ok, false); // NEW
    let undone = false; // NEW
    harness.model.fireChange({ changes: [{ constructor: { name: "mxValueChange" }, cell: harness.card }], undo() { undone = true; } }); // NEW
    assert.equal(undone, false); // NEW
    assert.ok(harness.actions.trellisUsers); // NEW
}); // NEW

test("toolbar login enables users and keeps the first admin logged in for this diagram", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    harness.document.querySelector(".trellis-users-login-button").click(); // NEW
    assert.ok(harness.document.querySelector(".trellis-users-auth-overlay")); // NEW
    inputByPlaceholder(harness.document, "Admin name").value = "Alice"; // NEW
    inputByPlaceholder(harness.document, "PIN").value = "1234"; // NEW
    harness.document.querySelector(".trellis-users-auth-overlay input[type='checkbox']").checked = true; // NEW
    buttonByText(harness.document, "Enable Users").click(); // NEW
    assert.equal(users.isEnabled(), true); // NEW
    assert.equal(users.isLoggedIn(), true); // NEW
    assert.equal(harness.document.querySelector(".trellis-users-auth-overlay"), null); // NEW
    const key = users._test.getDiagramLoginKey(false); // NEW
    assert.equal(harness.context.window.localStorage.getItem("trellis_users_remembered_login_v1:" + key), users.getCurrentUser().id); // NEW
}); // NEW

test("users toolbar button is inserted beside an existing ChangeMap History button", () => { // NEW
    const harness = loadUsersPlugin({ historyButton: true }); // NEW
    const buttons = Array.from(harness.toolbarContainer.querySelectorAll("button")); // NEW
    assert.equal(buttons[0].className.includes("trellis-users-login-button"), true); // NEW
    assert.equal(buttons[1].className.includes("trellis-changemap-history-button"), true); // NEW
}); // NEW

test("enable users creates the first admin and persists usersEnabled", () => { // CHANGE
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    const result = users.enableUsers("Alice", "1234"); // NEW
    assert.equal(result.ok, true); // NEW
    assert.equal(users.isEnabled(), true); // NEW
    assert.equal(users.isLoggedIn(), true); // NEW
    assert.equal(users.isAdmin(), true); // NEW
    assert.equal(users.getCurrentUser().name, "Alice"); // NEW
    assert.equal(users.listUsers().length, 1); // NEW
    assert.equal(users._test.readStore().usersEnabled, true); // NEW
    assert.match(harness.layer.getAttribute("trellis_users_json"), /Alice/); // CHANGE
}); // NEW

test("accepted visible edits merge actor metadata into the same undoable edit", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    const edit = { changes: [{ constructor: { name: "mxGeometryChange" }, cell: harness.card }] }; // NEW
    harness.model.fireChange(edit); // NEW
    assert.equal(edit.changes.length, 2); // NEW
    assert.equal(harness.card.getAttribute(users.attrs.editedBy), users.getCurrentUser().id); // NEW
    const actorChange = edit.changes.find(change => change.__trellisUsersActorStamp); // NEW
    assert.ok(actorChange); // NEW
    actorChange.execute(); // NEW
    assert.equal(harness.card.getAttribute(users.attrs.editedBy), null); // NEW
    actorChange.execute(); // NEW
    assert.equal(harness.card.getAttribute(users.attrs.editedBy), users.getCurrentUser().id); // NEW
}); // NEW

test("created planting ownership metadata is included in the creation undo edit", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    const planting = makeXmlCell(harness.document, "planting", { label: "Planting", tiler_group: "1" }); // NEW
    appendChild(harness.module, planting); // NEW
    const edit = { changes: [{ constructor: { name: "mxChildChange" }, child: planting, parent: harness.module }] }; // NEW
    harness.model.fireChange(edit); // NEW
    assert.equal(edit.changes.length, 2); // NEW
    assert.equal(planting.getAttribute(users.attrs.owner), users.getCurrentUser().id); // NEW
    assert.equal(planting.getAttribute(users.attrs.createdBy), users.getCurrentUser().id); // NEW
    const actorChange = edit.changes.find(change => change.__trellisUsersActorStamp); // NEW
    actorChange.execute(); // NEW
    assert.equal(planting.getAttribute(users.attrs.owner), null); // NEW
    assert.equal(planting.getAttribute(users.attrs.createdBy), null); // NEW
    actorChange.execute(); // NEW
    assert.equal(planting.getAttribute(users.attrs.owner), users.getCurrentUser().id); // NEW
}); // NEW

test("direct actor stamping mutates XML without model setValue calls", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    const preInsert = new TestCell("pre-insert", "Pre Insert"); // NEW
    harness.model.setValueCalls = 0; // NEW
    assert.equal(users.stampActorDirect(preInsert, "created"), true); // NEW
    assert.equal(harness.model.setValueCalls, 0); // NEW
    assert.equal(preInsert.getAttribute(users.attrs.createdBy), users.getCurrentUser().id); // NEW
}); // NEW

test("logged-out enabled diagrams reject edits", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    users.logout(); // NEW
    let undone = false; // NEW
    harness.model.fireChange({ changes: [{ constructor: { name: "mxValueChange" }, cell: harness.card }], undo() { undone = true; } }); // NEW
    assert.equal(undone, true); // NEW
}); // NEW

test("enabled diagram load changes are allowed while logged out but later edits are rejected", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    users.logout(); // NEW
    let loadUndone = false; // NEW
    harness.ui.openingFile = true; // NEW
    harness.model.fireChange({ changes: [{ constructor: { name: "mxChildChange" }, child: harness.module, parent: harness.layer }], undo() { loadUndone = true; } }); // NEW
    harness.ui.openingFile = false; // NEW
    harness.ui.fileLoaded({}); // NEW
    assert.equal(loadUndone, false); // NEW
    assert.ok(harness.document.querySelector(".trellis-users-auth-overlay")); // NEW
    let editUndone = false; // NEW
    harness.model.fireChange({ changes: [{ constructor: { name: "mxValueChange" }, cell: harness.card }], undo() { editUndone = true; } }); // NEW
    assert.equal(editUndone, true); // NEW
}); // NEW

test("direct setGraphXml load changes are allowed and then show the auth gate", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    users.logout(); // NEW
    harness.ui.setGraphXmlUndone = false; // NEW
    harness.ui.editor.setGraphXml(harness.document.createElement("mxGraphModel")); // NEW
    assert.equal(harness.ui.setGraphXmlCalls, 1); // NEW
    assert.equal(harness.ui.setGraphXmlUndone, false); // NEW
    assert.ok(harness.document.querySelector(".trellis-users-auth-overlay")); // NEW
}); // NEW

test("logged-out enabled diagrams show an opaque auth gate until login succeeds", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    users.logout(); // NEW
    assert.ok(harness.document.querySelector(".trellis-users-auth-overlay")); // NEW
    assert.equal(harness.graph.enabled, false); // NEW
    assert.equal(users.login("Alice", "bad").ok, false); // NEW
    assert.ok(harness.document.querySelector(".trellis-users-auth-overlay")); // NEW
    assert.equal(users.login("Alice", "1234").ok, true); // NEW
    assert.equal(harness.document.querySelector(".trellis-users-auth-overlay"), null); // NEW
    assert.equal(harness.graph.enabled, true); // NEW
}); // NEW

test("remembered login restores on file load and logout forgets it", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    const alice = users.getCurrentUser(); // NEW
    assert.equal(users.rememberLogin(alice.id, true).ok, true); // NEW
    harness.ui.fileLoaded({}); // NEW
    assert.equal(users.isLoggedIn(), true); // NEW
    assert.equal(users.getCurrentUser().id, alice.id); // NEW
    users.logout(); // NEW
    const key = users._test.getDiagramLoginKey(false); // NEW
    assert.equal(harness.context.window.localStorage.getItem("trellis_users_remembered_login_v1:" + key), null); // NEW
    assert.ok(harness.document.querySelector(".trellis-users-auth-overlay")); // NEW
}); // NEW

test("remembered login is ignored when the stored user is disabled", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    const bob = users.createUser("Bob", "5678", false).user; // NEW
    assert.equal(users.rememberLogin(bob.id, true).ok, true); // NEW
    users.setUserDisabled(bob.id, true); // NEW
    harness.ui.fileLoaded({}); // NEW
    assert.equal(users.isLoggedIn(), false); // NEW
    assert.ok(harness.document.querySelector(".trellis-users-auth-overlay")); // NEW
}); // NEW

test("logged-in toolbar button toggles a user panel below the button", () => { // CHANGE
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    const button = harness.document.querySelector(".trellis-users-login-button"); // NEW
    assert.equal(button.textContent, "Alice"); // NEW
    button.click(); // NEW
    assert.equal(harness.document.querySelector(".trellis-users-account-menu"), null); // CHANGE
    const panel = harness.document.body.querySelector("div[style*='width: 400px'], div[style*='width:400px']"); // CHANGE
    assert.ok(panel); // NEW
    assert.equal(panel.parentNode, harness.document.body); // NEW
    assert.equal(panel.style.position, "fixed"); // CHANGE
    assert.equal(panel.style.zIndex, "2000000000"); // CHANGE
    assert.equal(panel.style.top, "38px"); // NEW
    assert.equal(panel.style.left, "510px"); // CHANGE
    assert.ok(buttonByText(harness.document, "Close")); // NEW
    button.click(); // NEW
    assert.equal(panel.style.display, "none"); // NEW
    button.click(); // NEW
    assert.notEqual(panel.style.display, "none"); // NEW
    buttonByText(harness.document, "Close").click(); // NEW
    assert.equal(panel.style.display, "none"); // NEW
    button.click(); // NEW
    buttonByText(harness.document, "Logout").click(); // NEW
    assert.equal(users.isLoggedIn(), false); // NEW
    assert.equal(harness.document.querySelector(".trellis-users-account-menu"), null); // NEW
    assert.ok(harness.document.querySelector(".trellis-users-auth-overlay")); // NEW
}); // NEW

test("admin roster management supports PIN reset disable reactivate and last-admin guards", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    const bob = users.createUser("Bob", "5678", false).user; // NEW
    assert.equal(users.resetUserPin(bob.id, "9999").ok, true); // NEW
    users.logout(); // NEW
    assert.equal(users.login("Bob", "5678").ok, false); // NEW
    assert.equal(users.login("Bob", "9999").ok, true); // NEW
    assert.equal(users.setUserAdmin(bob.id, true).ok, false); // NEW
    users.logout(); // NEW
    users.login("Alice", "1234"); // NEW
    assert.equal(users.setUserAdmin(bob.id, true).ok, true); // NEW
    const alice = users.getCurrentUser(); // NEW
    assert.equal(users.setUserDisabled(alice.id, true).ok, true); // NEW
    assert.equal(users.isLoggedIn(), false); // NEW
    users.login("Bob", "9999"); // NEW
    assert.equal(users.setUserAdmin(bob.id, false).ok, false); // NEW
    assert.equal(users.setUserDisabled(bob.id, true).ok, false); // NEW
    assert.equal(users.setUserDisabled(alice.id, false).ok, true); // NEW
}); // NEW

test("admin roster PIN reset uses an inline form without native prompt", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    users.createUser("Bob", "5678", false); // NEW
    harness.context.window.prompt = function () { throw new Error("prompt() is not supported"); }; // NEW
    harness.actions.trellisUsers.funct(); // NEW
    const firstPinButtons = Array.from(harness.document.querySelectorAll("button")).filter(button => button.textContent === "PIN"); // NEW
    assert.equal(firstPinButtons.length, 2); // NEW
    assert.doesNotThrow(() => firstPinButtons[1].click()); // NEW
    assert.ok(inputByPlaceholder(harness.document, "New PIN")); // NEW
    buttonByText(harness.document, "Cancel").click(); // NEW
    assert.equal(inputByPlaceholder(harness.document, "New PIN"), undefined); // NEW
    const secondPinButtons = Array.from(harness.document.querySelectorAll("button")).filter(button => button.textContent === "PIN"); // NEW
    assert.doesNotThrow(() => secondPinButtons[1].click()); // NEW
    inputByPlaceholder(harness.document, "New PIN").value = "9999"; // NEW
    buttonByText(harness.document, "Save").click(); // NEW
    assert.equal(inputByPlaceholder(harness.document, "New PIN"), undefined); // NEW
    users.logout(); // NEW
    assert.equal(users.login("Bob", "5678").ok, false); // NEW
    assert.equal(users.login("Bob", "9999").ok, true); // NEW
}); // NEW

test("admin panel groups networked local and pending users", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const bobInvite = users.createPendingInvite({ email: "bob@example.com", scopeCellIds: [harness.module.id] }); // NEW
    assert.equal(bobInvite.ok, true); // NEW
    users.logout(); // NEW
    assert.equal(users.acceptInvite({ email: "bob@example.com", code: bobInvite.code, name: "Bob", pin: "5678" }).ok, true); // NEW
    users.logout(); // NEW
    assert.equal(users.login("Alice", "1234").ok, true); // NEW
    assert.equal(users.createPendingInvite({ email: "carol@example.com", scopeCellIds: [harness.module.id] }).ok, true); // NEW
    harness.actions.trellisUsers.funct(); // NEW
    const networked = userGroupByTitle(harness.document, "Networked users"); // NEW
    const local = userGroupByTitle(harness.document, "Local users"); // NEW
    assert.ok(networked); // NEW
    assert.ok(local); // NEW
    assert.match(networked.textContent, /Bob/); // NEW
    assert.doesNotMatch(networked.textContent, /Alice/); // NEW
    assert.match(local.textContent, /Alice/); // NEW
    assert.doesNotMatch(local.textContent, /Bob/); // NEW
    assert.match(harness.document.body.textContent, /Pending invites/); // NEW
    assert.match(harness.document.body.textContent, /carol@example\.com/); // NEW
    local.querySelector("input[placeholder='Local user']").value = "Dana"; // NEW
    local.querySelector("input[placeholder='PIN']").value = "2468"; // NEW
    buttonByText(harness.document, "Add local user").click(); // NEW
    assert.ok(users.listUsers().find(user => user.name === "Dana" && !user.email)); // NEW
}); // NEW

test("people access panel title and filters search roster invites and access rows by name or email", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const bobInvite = users.createPendingInvite({ email: "bob@example.com", scopeCellIds: [harness.module.id] }); // NEW
    users.logout(); // NEW
    const accepted = users.acceptInvite({ email: "bob@example.com", code: bobInvite.code, name: "Bob", pin: "5678" }); // NEW
    assert.equal(accepted.ok, true); // NEW
    users.logout(); // NEW
    assert.equal(users.login("Alice", "1234").ok, true); // NEW
    const dana = users.createUser("Dana", "2468", false).user; // NEW
    assert.equal(users.setScopeGrant(harness.module, { userId: accepted.user.id, preset: "visitor" }).ok, true); // CHANGE
    assert.equal(users.setScopeGrant(harness.module, { userId: dana.id, preset: "visitor" }).ok, true); // CHANGE
    assert.equal(users.createPendingInvite({ email: "carol@example.com", scopeCellIds: [harness.module.id] }).ok, true); // NEW
    harness.graph.setSelectionCell(harness.module); // NEW
    harness.actions.trellisUsers.funct(); // NEW
    assert.match(harness.document.body.textContent, /People & Access/); // NEW
    assert.match(harness.document.body.textContent, /Module: Module/); // NEW
    assert.match(harness.document.body.textContent, /Bob/); // NEW
    assert.match(harness.document.body.textContent, /Dana/); // NEW
    const search = inputByPlaceholder(harness.document, "Search name or email"); // NEW
    search.value = "bob@example"; // NEW
    search.dispatchEvent(new harness.context.window.Event("input", { bubbles: true })); // NEW
    assert.match(userGroupByTitle(harness.document, "Networked users").textContent, /Bob/); // NEW
    assert.doesNotMatch(harness.document.body.textContent, /carol@example\.com/); // NEW
    assert.doesNotMatch(harness.document.body.textContent, /Dana\s*Visitor/); // CHANGE
    assert.match(harness.document.body.textContent, /Granted/); // NEW
    assert.match(harness.document.body.textContent, /1 granted user is hidden by the current filter/); // NEW
    const filter = selectByOptionText(harness.document, "Networked"); // NEW
    search.value = ""; // NEW
    search.dispatchEvent(new harness.context.window.Event("input", { bubbles: true })); // NEW
    filter.value = "networked"; // NEW
    filter.dispatchEvent(new harness.context.window.Event("change", { bubbles: true })); // NEW
    assert.match(harness.document.body.textContent, /Pending invites/); // NEW
    assert.match(harness.document.body.textContent, /carol@example\.com/); // NEW
    assert.equal(userGroupByTitle(harness.document, "Local users"), undefined); // NEW
    filter.value = "local"; // NEW
    filter.dispatchEvent(new harness.context.window.Event("change", { bubbles: true })); // NEW
    assert.equal(userGroupByTitle(harness.document, "Networked users"), undefined); // NEW
    assert.equal(harness.document.body.textContent.includes("Pending invites"), false); // NEW
}); // NEW

test("selected access summarizes scope labels and hides editor for multiple selections", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const bed = appendChild(harness.module, makeXmlCell(harness.document, "bed", { garden_bed: "1", label: "North Bed" })); // NEW
    const board = appendChild(harness.module, makeXmlCell(harness.document, "board", { board_key: "KANBAN_BOARD", label: "Harvest Board" })); // NEW
    const bob = users.createUser("Bob", "5678", false).user; // NEW
    assert.equal(users.setScopeGrant(board, { userId: bob.id, preset: "gardener" }).ok, true); // CHANGE
    harness.graph.setSelectionCell(bed); // NEW
    harness.actions.trellisUsers.funct(); // NEW
    assert.match(harness.document.body.textContent, /Garden Bed: North Bed/); // NEW
    harness.graph.setSelectionCell(board); // NEW
    users._test.refreshPanel(); // NEW
    assert.match(harness.document.body.textContent, /Task Board: Harvest Board/); // NEW
    assert.match(harness.document.body.textContent, /Granted/); // NEW
    harness.graph.setSelectionCells([harness.module, bed, board]); // NEW
    users._test.refreshPanel(); // NEW
    assert.match(harness.document.body.textContent, /Module: Module/); // NEW
    assert.match(harness.document.body.textContent, /Garden Bed: North Bed/); // NEW
    assert.match(harness.document.body.textContent, /Task Board: Harvest Board/); // NEW
    assert.match(harness.document.body.textContent, /Access editor is hidden while multiple scopes are selected/); // NEW
    assert.doesNotMatch(harness.document.body.textContent, /Your effective access/); // NEW
}); // NEW

test("visitor grant keeps regular users view-only", () => { // CHANGE
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const bob = users.createUser("Bob", "5678", false).user; // NEW
    assert.equal(users.setScopeGrant(harness.module, { userId: bob.id, preset: "visitor" }).ok, true); // CHANGE
    users.logout(); // NEW
    assert.equal(users.login("Bob", "5678").ok, true); // NEW
    assert.equal(users.canEditCell(harness.card), false); // CHANGE
    assert.equal(users.canAddCell(harness.module), false); // NEW
    assert.equal(users.canDeleteCell(harness.card), false); // NEW
    assert.equal(users.canManageAccess(harness.module), false); // NEW
    assert.equal(users._test.changeAllowed({ constructor: { name: "mxCellAttributeChange" }, cell: harness.card, attribute: "label" }), false); // NEW
    const planting = appendChild(harness.module, makeXmlCell(harness.document, "viewer-planting", { tiler_group: "1" })); // NEW
    let undone = false; // NEW
    harness.model.fireChange({ changes: [{ constructor: { name: "mxChildChange" }, child: planting, parent: harness.module }], undo() { undone = true; } }); // NEW
    assert.equal(undone, true); // NEW
    const bed = appendChild(harness.module, makeXmlCell(harness.document, "viewer-bed", { garden_bed: "1" })); // NEW
    undone = false; // NEW
    harness.model.fireChange({ changes: [{ constructor: { name: "mxChildChange" }, child: bed, parent: harness.module }], undo() { undone = true; } }); // NEW
    assert.equal(undone, true); // NEW
    bed.parent = null; // NEW
    undone = false; // NEW
    harness.model.fireChange({ changes: [{ constructor: { name: "mxChildChange" }, child: bed, previous: harness.module }], undo() { undone = true; } }); // NEW
    assert.equal(undone, true); // NEW
}); // NEW

test("access request from inaccessible child resolves to nearest shareable scope", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const bed = appendChild(harness.module, makeXmlCell(harness.document, "request-bed", { garden_bed: "1", label: "North Bed" })); // NEW
    const child = appendChild(bed, makeXmlCell(harness.document, "request-child", { label: "Locked Planting" })); // NEW
    const bob = users.createUser("Bob", "5678", false).user; // NEW
    users.logout(); // NEW
    assert.equal(users.login("Bob", "5678").ok, true); // NEW
    assert.equal(users.canEditCell(child), false); // NEW
    const result = users.requestAccess(child, { requestedPreset: "gardener", note: "Need to tend this bed." }); // NEW
    assert.equal(result.ok, true); // NEW
    assert.equal(result.request.scopeCellId, bed.id); // NEW
    assert.equal(result.request.scopeType, "garden bed"); // NEW
    assert.equal(result.request.requesterUserId, bob.id); // NEW
    assert.equal(result.request.requestedPreset, "gardener"); // NEW
    assert.equal(users._test.readStore().accessRequests.length, 1); // NEW
}); // NEW

test("duplicate pending access request updates level note and timestamp", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const bob = users.createUser("Bob", "5678", false).user; // NEW
    users.logout(); // NEW
    users.login("Bob", "5678"); // NEW
    users.requestAccess(harness.card, { requestedPreset: "visitor", note: "First ask" }); // NEW
    const first = users._test.readStore().accessRequests[0]; // NEW
    users.requestAccess(harness.card, { requestedPreset: "coordinator", note: "Updated ask" }); // NEW
    const store = users._test.readStore(); // NEW
    assert.equal(store.accessRequests.length, 1); // NEW
    assert.equal(store.accessRequests[0].id, first.id); // NEW
    assert.equal(store.accessRequests[0].requesterUserId, bob.id); // NEW
    assert.equal(store.accessRequests[0].requestedPreset, "coordinator"); // NEW
    assert.equal(store.accessRequests[0].note, "Updated ask"); // NEW
    assert.ok(store.accessRequests[0].updatedAt >= first.updatedAt); // NEW
}); // NEW

test("denied access request persists with note and can be reopened", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    users.createUser("Bob", "5678", false); // NEW
    users.logout(); // NEW
    users.login("Bob", "5678"); // NEW
    const requested = users.requestAccess(harness.card, { requestedPreset: "gardener", note: "Need access" }).request; // NEW
    users.logout(); // NEW
    users.login("Alice", "1234"); // NEW
    const denied = users.denyAccessRequest(requested.id, "Not this week."); // NEW
    assert.equal(denied.ok, true); // NEW
    users.logout(); // NEW
    users.login("Bob", "5678"); // NEW
    assert.equal(users.getAccessRequestForCurrentUser(harness.card).status, "denied"); // NEW
    assert.equal(users.getAccessRequestForCurrentUser(harness.card).decisionNote, "Not this week."); // NEW
    const reopened = users.requestAccess(harness.card, { requestedPreset: "coordinator", note: "Updated reason" }); // NEW
    assert.equal(reopened.ok, true); // NEW
    assert.equal(reopened.request.status, "pending"); // NEW
    assert.equal(reopened.request.decisionNote, ""); // NEW
    assert.equal(reopened.request.requestedPreset, "coordinator"); // NEW
}); // NEW

test("approving access request creates grant and removes request", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const bob = users.createUser("Bob", "5678", false).user; // NEW
    users.logout(); // NEW
    users.login("Bob", "5678"); // NEW
    const request = users.requestAccess(harness.card, { requestedPreset: "gardener" }).request; // NEW
    users.logout(); // NEW
    users.login("Alice", "1234"); // NEW
    const approved = users.approveAccessRequest(request.id, { preset: "gardener" }); // NEW
    assert.equal(approved.ok, true); // NEW
    assert.equal(users._test.readStore().accessRequests.length, 0); // NEW
    assert.deepEqual(JSON.parse(harness.module.getAttribute(users.attrs.accessGrants)), [{ userId: bob.id, preset: "gardener", capabilities: ["create_plantings", "edit_task_details", "manage_own_plantings", "move_tasks"] }]); // NEW
}); // NEW

test("approval creates unread requester message and supports read and dismiss lifecycle", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    users.createUser("Bob", "5678", false); // NEW
    users.logout(); // NEW
    users.login("Bob", "5678"); // NEW
    const request = users.requestAccess(harness.card, { requestedPreset: "gardener" }).request; // NEW
    users.logout(); // NEW
    users.login("Alice", "1234"); // NEW
    const approved = users.approveAccessRequest(request.id, { preset: "gardener", decisionNote: "Welcome to the bed." }); // NEW
    assert.equal(approved.ok, true); // NEW
    let store = users._test.readStore(); // NEW
    assert.equal(store.accessRequests.length, 0); // NEW
    assert.equal(store.accessMessages.length, 1); // NEW
    assert.equal(store.accessMessages[0].decision, "approved"); // NEW
    assert.equal(store.accessMessages[0].note, "Welcome to the bed."); // NEW
    users.logout(); // NEW
    users.login("Bob", "5678"); // NEW
    let messages = users.listAccessMessages({ scopeCell: harness.module }); // NEW
    assert.equal(messages.length, 1); // NEW
    assert.equal(messages[0].decision, "approved"); // NEW
    assert.equal(messages[0].reviewerName, "Alice"); // NEW
    assert.equal(messages[0].unread, true); // NEW
    assert.equal(users.unreadAccessMessageCount({ scopeCell: harness.module }), 1); // NEW
    assert.equal(users.markAccessMessageRead(messages[0].id).ok, true); // NEW
    messages = users.listAccessMessages({ scopeCell: harness.module }); // NEW
    assert.equal(messages.length, 1); // NEW
    assert.equal(messages[0].unread, false); // NEW
    assert.equal(users.unreadAccessMessageCount({ scopeCell: harness.module }), 0); // NEW
    assert.equal(users.dismissAccessMessage(messages[0].id).ok, true); // NEW
    assert.equal(users.listAccessMessages({ scopeCell: harness.module }).length, 0); // NEW
    store = users._test.readStore(); // NEW
    assert.equal(store.accessMessages.length, 1); // NEW
    assert.ok(store.accessMessages[0].dismissedAt > 0); // NEW
}); // NEW

test("denial creates requester message while denied request remains reopenable", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    users.createUser("Bob", "5678", false); // NEW
    users.logout(); // NEW
    users.login("Bob", "5678"); // NEW
    const request = users.requestAccess(harness.card, { requestedPreset: "coordinator", note: "Need full access." }).request; // NEW
    users.logout(); // NEW
    users.login("Alice", "1234"); // NEW
    const denied = users.denyAccessRequest(request.id, "Not this season."); // NEW
    assert.equal(denied.ok, true); // NEW
    assert.equal(users._test.readStore().accessRequests.length, 1); // NEW
    users.logout(); // NEW
    users.login("Bob", "5678"); // NEW
    const messages = users.listAccessMessages({ scopeCell: harness.module }); // NEW
    assert.equal(messages.length, 1); // NEW
    assert.equal(messages[0].decision, "denied"); // NEW
    assert.equal(messages[0].preset, "coordinator"); // NEW
    assert.equal(messages[0].note, "Not this season."); // NEW
    assert.equal(users.getAccessRequestForCurrentUser(harness.card).status, "denied"); // NEW
}); // NEW

test("already-granted access request cleanup does not create requester message", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const bob = users.createUser("Bob", "5678", false).user; // NEW
    users.logout(); // NEW
    users.login("Bob", "5678"); // NEW
    const request = users.requestAccess(harness.card, { requestedPreset: "gardener" }).request; // NEW
    users.logout(); // NEW
    users.login("Alice", "1234"); // NEW
    assert.equal(users.setScopeGrant(harness.module, { userId: bob.id, preset: "gardener" }).ok, true); // NEW
    const approved = users.approveAccessRequest(request.id, { preset: "gardener", decisionNote: "Already done." }); // NEW
    assert.equal(approved.ok, true); // NEW
    assert.equal(approved.alreadyGranted, true); // NEW
    const store = users._test.readStore(); // NEW
    assert.equal(store.accessRequests.length, 0); // NEW
    assert.equal(store.accessMessages.length, 0); // NEW
}); // NEW

test("deleted scope response remains visible as unavailable in requester messages", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const bed = appendChild(harness.module, makeXmlCell(harness.document, "message-deleted-bed", { garden_bed: "1", label: "Old Bed" })); // NEW
    const child = appendChild(bed, makeXmlCell(harness.document, "message-deleted-child", { label: "Child" })); // NEW
    users.createUser("Bob", "5678", false); // NEW
    users.logout(); // NEW
    users.login("Bob", "5678"); // NEW
    const request = users.requestAccess(child, { requestedPreset: "gardener" }).request; // NEW
    users.logout(); // NEW
    users.login("Alice", "1234"); // NEW
    assert.equal(users.denyAccessRequest(request.id, "Bed is gone.").ok, true); // NEW
    bed.parent = null; // NEW
    users.logout(); // NEW
    users.login("Bob", "5678"); // NEW
    const messages = users.listAccessMessages({ scopeCell: harness.module }); // NEW
    assert.equal(messages.length, 1); // NEW
    assert.equal(messages[0].scopeLabel, "Old Bed"); // NEW
    assert.equal(messages[0].scopeMissing, true); // NEW
}); // NEW

test("requester access messages are private to the requester", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    users.createUser("Bob", "5678", false); // NEW
    users.createUser("Cara", "9999", false); // NEW
    users.logout(); // NEW
    users.login("Bob", "5678"); // NEW
    const bobRequest = users.requestAccess(harness.card, { requestedPreset: "visitor" }).request; // NEW
    users.logout(); // NEW
    users.login("Cara", "9999"); // NEW
    const caraRequest = users.requestAccess(harness.card, { requestedPreset: "gardener" }).request; // NEW
    users.logout(); // NEW
    users.login("Alice", "1234"); // NEW
    assert.equal(users.denyAccessRequest(bobRequest.id, "No.").ok, true); // NEW
    assert.equal(users.denyAccessRequest(caraRequest.id, "Later.").ok, true); // NEW
    users.logout(); // NEW
    users.login("Bob", "5678"); // NEW
    const bobMessages = users.listAccessMessages({ scopeCell: harness.module }); // NEW
    assert.equal(bobMessages.length, 1); // NEW
    assert.equal(bobMessages[0].preset, "visitor"); // NEW
    users.logout(); // NEW
    users.login("Cara", "9999"); // NEW
    const caraMessages = users.listAccessMessages({ scopeCell: harness.module }); // NEW
    assert.equal(caraMessages.length, 1); // NEW
    assert.equal(caraMessages[0].preset, "gardener"); // NEW
}); // NEW

test("messages dialog renders access request and response sections with response actions", () => { // NEW
    const text = fs.readFileSync(pluginPath, "utf8"); // NEW
    assert.match(text, /requestTitle\.textContent = "Access requests";/); // NEW
    assert.match(text, /responseTitle\.textContent = "Responses";/); // NEW
    assert.match(text, /approveAccessRequest\(request\.id, \{ preset: preset\.value, decisionNote: decisionNote\.value \}\)/); // NEW
    assert.match(text, /const result = markAccessMessageRead\(message\.id\);/); // NEW
    assert.match(text, /const result = dismissAccessMessage\(message\.id\);/); // NEW
}); // NEW

test("incoming access request count is visible only to owner or admin", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const owner = users.createUser("Olive", "1111", false).user; // NEW
    users.setOwner(harness.module, owner.id); // NEW
    users.createUser("Bob", "5678", false); // NEW
    users.createUser("Cara", "9999", false); // NEW
    users.logout(); // NEW
    users.login("Bob", "5678"); // NEW
    const request = users.requestAccess(harness.card, { requestedPreset: "gardener" }); // NEW
    assert.equal(request.ok, true); // NEW
    assert.equal(users.incomingAccessRequestCount({ scopeCell: harness.module }), 0); // NEW
    users.logout(); // NEW
    users.login("Cara", "9999"); // NEW
    assert.equal(users.incomingAccessRequestCount({ scopeCell: harness.module }), 0); // NEW
    users.logout(); // NEW
    users.login("Olive", "1111"); // NEW
    assert.equal(users.incomingAccessRequestCount({ scopeCell: harness.module }), 1); // NEW
    users.logout(); // NEW
    users.login("Alice", "1234"); // NEW
    assert.equal(users.incomingAccessRequestCount({ scopeCell: harness.module }), 1); // NEW
}); // NEW

test("disabled requester and deleted scope access requests cannot be approved", () => { // NEW
    const disabledHarness = loadUsersPlugin(); // NEW
    const disabledUsers = disabledHarness.context.window.Trellis.users; // NEW
    disabledUsers.enableUsers("Alice", "1234"); // NEW
    disabledHarness.module.style = "module=1"; // NEW
    disabledUsers.stampCreatedOwner(disabledHarness.module); // NEW
    const bob = disabledUsers.createUser("Bob", "5678", false).user; // NEW
    disabledUsers.logout(); // NEW
    disabledUsers.login("Bob", "5678"); // NEW
    const disabledRequest = disabledUsers.requestAccess(disabledHarness.card, { requestedPreset: "gardener" }).request; // NEW
    disabledUsers.logout(); // NEW
    disabledUsers.login("Alice", "1234"); // NEW
    assert.equal(disabledUsers.setUserDisabled(bob.id, true).ok, true); // NEW
    const disabledApproval = disabledUsers.approveAccessRequest(disabledRequest.id, { preset: "gardener" }); // NEW
    assert.equal(disabledApproval.ok, false); // NEW
    assert.match(disabledApproval.reason, /disabled|unavailable/); // NEW

    const deletedHarness = loadUsersPlugin(); // NEW
    const deletedUsers = deletedHarness.context.window.Trellis.users; // NEW
    deletedUsers.enableUsers("Alice", "1234"); // NEW
    deletedHarness.module.style = "module=1"; // NEW
    deletedUsers.stampCreatedOwner(deletedHarness.module); // NEW
    const bed = appendChild(deletedHarness.module, makeXmlCell(deletedHarness.document, "deleted-request-bed", { garden_bed: "1" })); // NEW
    const child = appendChild(bed, makeXmlCell(deletedHarness.document, "deleted-request-child", { label: "Child" })); // NEW
    deletedUsers.createUser("Bob", "5678", false); // NEW
    deletedUsers.logout(); // NEW
    deletedUsers.login("Bob", "5678"); // NEW
    const deletedRequest = deletedUsers.requestAccess(child, { requestedPreset: "gardener" }).request; // NEW
    deletedUsers.logout(); // NEW
    deletedUsers.login("Alice", "1234"); // NEW
    bed.parent = null; // NEW
    const deletedApproval = deletedUsers.approveAccessRequest(deletedRequest.id, { preset: "gardener" }); // NEW
    assert.equal(deletedApproval.ok, false); // NEW
    assert.match(deletedApproval.reason, /no longer available/); // NEW
}); // NEW

test("selected access panel shows request access action and requester status", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    users.createUser("Bob", "5678", false); // NEW
    users.logout(); // NEW
    users.login("Bob", "5678"); // NEW
    harness.graph.setSelectionCell(harness.card); // NEW
    harness.actions.trellisUsers.funct(); // NEW
    assert.ok(harness.document.querySelector(".trellis-users-request-access-button")); // NEW
    users.requestAccess(harness.card, { requestedPreset: "gardener" }); // NEW
    users._test.refreshPanel(); // NEW
    assert.match(harness.document.querySelector(".trellis-users-access-request-status").textContent, /pending/i); // NEW
}); // NEW

test("permission diagnostics stay quiet unless explicitly enabled", () => { // NEW
    const calls = []; // NEW
    const fakeConsole = { groupCollapsed() { calls.push("group"); }, log() { calls.push("log"); }, table() { calls.push("table"); }, groupEnd() { calls.push("end"); } }; // NEW
    const harness = loadUsersPlugin({ console: fakeConsole }); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    users.stampCreatedOwner(harness.module); // NEW
    users.createUser("Bob", "5678", false); // NEW
    users.logout(); // NEW
    users.login("Bob", "5678"); // NEW
    harness.model.fireChange({ changes: [{ constructor: { name: "mxGeometryChange" }, cell: harness.card }], undo() {} }); // NEW
    assert.equal(calls.length, 0); // NEW
}); // NEW

test("permission diagnostics do not throw when console is unavailable", () => { // NEW
    const harness = loadUsersPlugin({ console: undefined }); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    users.stampCreatedOwner(harness.module); // NEW
    users.createUser("Bob", "5678", false); // NEW
    users.logout(); // NEW
    users.login("Bob", "5678"); // NEW
    harness.context.window.localStorage.setItem("trellis_users_debug", "1"); // NEW
    assert.doesNotThrow(function () { // NEW
        harness.model.fireChange({ changes: [{ constructor: { name: "mxGeometryChange" }, cell: harness.card }], undo() {} }); // NEW
    }); // NEW
}); // NEW

test("trellis debug surface reports users status and toggles debug flags", () => { // NEW
    const calls = []; // NEW
    const fakeConsole = { groupCollapsed(label) { calls.push(["group", label]); }, log(value) { calls.push(["log", value]); }, groupEnd() { calls.push(["end"]); } }; // NEW
    const harness = loadUsersPlugin({ console: fakeConsole }); // NEW
    const debug = harness.context.window.Trellis.debug; // NEW
    assert.equal(typeof debug.usersStatus, "function"); // NEW
    assert.equal(typeof debug.enable, "function"); // NEW
    assert.equal(typeof debug.disable, "function"); // NEW
    assert.equal(typeof debug.probe, "function"); // NEW
    assert.equal(debug.usersStatus().loaded, true); // NEW
    assert.equal(debug.usersStatus().storage.trellis_users_debug, null); // NEW
    const probe = debug.probe(); // NEW
    assert.equal(probe.usersPluginLoaded, true); // NEW
    assert.equal(probe.bedFitPluginLoaded, false); // NEW
    assert.ok(calls.some(call => call[0] === "group" && call[1] === "[TrellisDebug] probe")); // NEW
    const enabled = debug.enable(); // NEW
    assert.equal(harness.context.window.localStorage.getItem("trellis_users_debug"), "1"); // NEW
    assert.equal(harness.context.window.localStorage.getItem("trellis_bed_fit_debug"), "1"); // NEW
    assert.equal(enabled.windowFlags.users, true); // NEW
    assert.equal(enabled.windowFlags.bedFit, true); // NEW
    const disabled = debug.disable(); // NEW
    assert.equal(harness.context.window.localStorage.getItem("trellis_users_debug"), null); // NEW
    assert.equal(harness.context.window.localStorage.getItem("trellis_bed_fit_debug"), null); // NEW
    assert.equal(disabled.windowFlags.users, false); // NEW
    assert.equal(disabled.windowFlags.bedFit, false); // NEW
}); // NEW

test("admin remains allowed for bed-fit relevant child geometry and style changes", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    const planting = appendChild(harness.module, makeXmlCell(harness.document, "admin-planting", { tiler_group: "1" })); // NEW
    assert.equal(users._test.changeAllowed({ constructor: { name: "mxChildChange" }, child: planting, parent: harness.module }), true); // NEW
    assert.equal(users._test.changeAllowed({ constructor: { name: "mxGeometryChange" }, cell: planting }), true); // NEW
    assert.equal(users._test.changeAllowed({ constructor: { name: "mxStyleChange" }, cell: planting }), true); // NEW
}); // NEW

test("admin planting creation allows generated plant tile churn in the same edit", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    const planting = appendChild(harness.module, makeXmlCell(harness.document, "admin-planting-fit", { tiler_group: "1" })); // NEW
    const generatedTile = makeXmlCell(harness.document, "generated-tile", { plant_tiler: "1", auto: "1", tile_r: "0", tile_c: "0" }); // NEW
    let undone = false; // NEW
    harness.model.fireChange({ // NEW
        changes: [ // NEW
            { constructor: { name: "mxChildChange" }, child: planting, parent: harness.module }, // NEW
            { constructor: { name: "mxChildChange" }, child: generatedTile } // NEW
        ], // NEW
        undo() { undone = true; } // NEW
    }); // NEW
    assert.equal(undone, false); // NEW
}); // NEW

test("gardener grant creates and manages only owned planting groups", () => { // CHANGE
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    assert.deepEqual(Array.from(users._test.normalizeCapabilities(null, "gardener")), ["create_plantings", "edit_task_details", "manage_own_plantings", "move_tasks"]); // CHANGE
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const bed = appendChild(harness.module, makeXmlCell(harness.document, "bed", { garden_bed: "1" })); // NEW
    const board = appendChild(harness.module, makeXmlCell(harness.document, "grower-board", { board_key: "KANBAN_BOARD" })); // NEW
    const lane = appendChild(board, makeXmlCell(harness.document, "grower-lane", { lane_key: "TODO" })); // NEW
    const taskCard = appendChild(lane, makeXmlCell(harness.document, "gardener-task", { kanban_card: "1", title: "Water" })); // CHANGE
    const alicePlanting = appendChild(bed, makeXmlCell(harness.document, "alice-planting", { tiler_group: "1", [users.attrs.owner]: users.getCurrentUser().id })); // NEW
    const bob = users.createUser("Bob", "5678", false).user; // NEW
    const bobLinkedPlanting = appendChild(bed, makeXmlCell(harness.document, "bob-linked-planting", { tiler_group: "1", [users.attrs.owner]: bob.id })); // NEW
    linkCells(bobLinkedPlanting, taskCard); // NEW
    assert.equal(users.setScopeGrant(harness.module, { userId: bob.id, preset: "gardener" }).ok, true); // CHANGE
    users.logout(); // NEW
    users.login("Bob", "5678"); // NEW
    assert.equal(users.canCreatePlanting(bed), true); // NEW
    assert.equal(users.canMoveTask(taskCard), true); // NEW
    assert.equal(users.canEditTaskDetails(taskCard), true); // NEW
    assert.equal(users.canEditCell(bed), false); // NEW
    assert.equal(users._test.changeAllowed({ constructor: { name: "mxCellAttributeChange" }, cell: bed, attribute: "garden_bed" }), false); // NEW
    assert.equal(users._test.changeAllowed({ constructor: { name: "mxCellAttributeChange" }, cell: harness.module, attribute: "label" }), false); // NEW
    assert.equal(users.canManagePlanting(alicePlanting), false); // NEW
    const bobPlanting = appendChild(bed, makeXmlCell(harness.document, "bob-planting", { tiler_group: "1" })); // NEW
    let undone = false; // NEW
    harness.model.fireChange({ changes: [{ constructor: { name: "mxChildChange" }, child: bobPlanting, parent: bed }], undo() { undone = true; } }); // NEW
    assert.equal(undone, false); // NEW
    assert.equal(bobPlanting.getAttribute(users.attrs.owner), bob.id); // NEW
    assert.equal(users.canManagePlanting(bobPlanting), true); // NEW
    assert.equal(users.canManageAccess(bobPlanting), false); // NEW
    assert.equal(users.setOwner(bed, bob.id).ok, false); // NEW
}); // NEW

test("gardener planting creation allows initialization edits and generated plant tile churn", () => { // CHANGE
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const bob = users.createUser("Bob", "5678", false).user; // NEW
    assert.equal(users.setScopeGrant(harness.module, { userId: bob.id, preset: "gardener" }).ok, true); // CHANGE
    users.logout(); // NEW
    assert.equal(users.login("Bob", "5678").ok, true); // NEW
    const planting = appendChild(harness.module, makeXmlCell(harness.document, "bob-planting-fit", { tiler_group: "1" })); // NEW
    const previousValue = planting.value.cloneNode(true); // NEW
    planting.setAttribute("label", "?"); // NEW
    const generatedTile = appendChild(planting, makeXmlCell(harness.document, "bob-generated-tile", { plant_tiler: "1", auto: "1", tile_r: "0", tile_c: "0" })); // CHANGE
    const previousTileValue = generatedTile.value.cloneNode(true); // NEW
    generatedTile.setAttribute("label", "?"); // NEW
    let undone = false; // NEW
    harness.model.fireChange({ // NEW
        changes: [ // NEW
            { constructor: { name: "mxChildChange" }, child: planting, parent: harness.module }, // NEW
            { constructor: { name: "mxValueChange" }, cell: planting, previous: previousValue, value: planting.value }, // NEW
            { constructor: { name: "mxChildChange" }, child: generatedTile, parent: planting }, // CHANGE
            { constructor: { name: "mxGeometryChange" }, cell: generatedTile }, // NEW
            { constructor: { name: "mxValueChange" }, cell: generatedTile, previous: previousTileValue, value: generatedTile.value }, // NEW
            { constructor: { name: "mxStyleChange" }, cell: generatedTile } // NEW
        ], // NEW
        undo() { undone = true; } // NEW
    }); // NEW
    assert.equal(undone, false); // NEW
    assert.equal(planting.getAttribute(users.attrs.owner), bob.id); // NEW
}); // NEW

test("gardener cannot create or delete garden beds in a granted module", () => { // CHANGE
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const bob = users.createUser("Bob", "5678", false).user; // NEW
    assert.equal(users.setScopeGrant(harness.module, { userId: bob.id, preset: "gardener" }).ok, true); // CHANGE
    users.logout(); // NEW
    assert.equal(users.login("Bob", "5678").ok, true); // NEW
    const createdBed = appendChild(harness.module, makeXmlCell(harness.document, "grower-created-bed", { garden_bed: "1" })); // NEW
    let undone = false; // NEW
    harness.model.fireChange({ changes: [{ constructor: { name: "mxChildChange" }, child: createdBed, parent: harness.module }], undo() { undone = true; } }); // NEW
    assert.equal(undone, true); // NEW
    const existingBed = appendChild(harness.module, makeXmlCell(harness.document, "grower-existing-bed", { garden_bed: "1" })); // NEW
    existingBed.parent = null; // NEW
    undone = false; // NEW
    harness.model.fireChange({ changes: [{ constructor: { name: "mxChildChange" }, child: existingBed, previous: harness.module }], undo() { undone = true; } }); // NEW
    assert.equal(undone, true); // NEW
}); // NEW

test("generated plant tile churn still requires a valid planting context", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    const generatedTile = makeXmlCell(harness.document, "orphan-generated-tile", { plant_tiler: "1", auto: "1", tile_r: "0", tile_c: "0" }); // NEW
    let undone = false; // NEW
    harness.model.fireChange({ changes: [{ constructor: { name: "mxChildChange" }, child: generatedTile }], undo() { undone = true; } }); // NEW
    assert.equal(undone, true); // NEW
}); // NEW

test("generated plant tile initialization rejects outside the created planting context", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const existingPlanting = appendChild(harness.module, makeXmlCell(harness.document, "existing-planting", { tiler_group: "1" })); // NEW
    const generatedTile = appendChild(existingPlanting, makeXmlCell(harness.document, "existing-generated-tile", { plant_tiler: "1", auto: "1", tile_r: "0", tile_c: "0" })); // NEW
    const bob = users.createUser("Bob", "5678", false).user; // NEW
    assert.equal(users.setScopeGrant(harness.module, { userId: bob.id, preset: "gardener" }).ok, true); // CHANGE
    users.logout(); // NEW
    assert.equal(users.login("Bob", "5678").ok, true); // NEW
    let undone = false; // NEW
    harness.model.fireChange({ changes: [{ constructor: { name: "mxGeometryChange" }, cell: generatedTile }], undo() { undone = true; } }); // NEW
    assert.equal(undone, true); // NEW
}); // NEW

test("created planting context does not allow manual plant tile initialization", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const bob = users.createUser("Bob", "5678", false).user; // NEW
    assert.equal(users.setScopeGrant(harness.module, { userId: bob.id, preset: "gardener" }).ok, true); // CHANGE
    users.logout(); // NEW
    assert.equal(users.login("Bob", "5678").ok, true); // NEW
    const planting = appendChild(harness.module, makeXmlCell(harness.document, "manual-tile-planting", { tiler_group: "1" })); // NEW
    const manualTile = appendChild(planting, makeXmlCell(harness.document, "manual-child-tile", { plant_tiler: "1", auto: "0" })); // NEW
    let undone = false; // NEW
    harness.model.fireChange({ // NEW
        changes: [ // NEW
            { constructor: { name: "mxChildChange" }, child: planting, parent: harness.module }, // NEW
            { constructor: { name: "mxChildChange" }, child: manualTile, parent: planting }, // NEW
            { constructor: { name: "mxGeometryChange" }, cell: manualTile } // NEW
        ], // NEW
        undo() { undone = true; } // NEW
    }); // NEW
    assert.equal(undone, true); // NEW
}); // NEW

test("planting context does not allow ordinary or manual orphan child changes", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    const ordinary = makeXmlCell(harness.document, "ordinary-orphan", { label: "Ordinary" }); // NEW
    const manualTile = makeXmlCell(harness.document, "manual-tile", { plant_tiler: "1", auto: "0" }); // NEW
    let undone = false; // NEW
    const plantingA = appendChild(harness.module, makeXmlCell(harness.document, "admin-planting-ordinary", { tiler_group: "1" })); // NEW
    harness.model.fireChange({ // NEW
        changes: [ // NEW
            { constructor: { name: "mxChildChange" }, child: plantingA, parent: harness.module }, // NEW
            { constructor: { name: "mxChildChange" }, child: ordinary } // NEW
        ], // NEW
        undo() { undone = true; } // NEW
    }); // NEW
    assert.equal(undone, true); // NEW
    undone = false; // NEW
    const plantingB = appendChild(harness.module, makeXmlCell(harness.document, "admin-planting-manual", { tiler_group: "1" })); // NEW
    harness.model.fireChange({ // NEW
        changes: [ // NEW
            { constructor: { name: "mxChildChange" }, child: plantingB, parent: harness.module }, // NEW
            { constructor: { name: "mxChildChange" }, child: manualTile } // NEW
        ], // NEW
        undo() { undone = true; } // NEW
    }); // NEW
    assert.equal(undone, true); // NEW
}); // NEW

test("owner can transfer ownership to an active user", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const bob = users.createUser("Bob", "5678", false).user; // NEW
    assert.equal(users.setOwner(harness.module, bob.id).ok, true); // NEW
    users.logout(); // NEW
    users.login("Bob", "5678"); // NEW
    assert.equal(users.canManageAccess(harness.module), true); // NEW
    assert.equal(users.canAddCell(harness.module), true); // NEW
}); // NEW

test("regular granted users cannot add delete move reparent or change protected access attributes", () => { // CHANGE
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const bob = users.createUser("Bob", "5678", false).user; // NEW
    users.setAccess(harness.module, { open: false, userIds: [bob.id] }); // NEW
    users.logout(); // NEW
    users.login("Bob", "5678"); // NEW

    let undone = false; // NEW
    const added = appendChild(harness.module, makeXmlCell(harness.document, "added", { label: "Added" })); // NEW
    harness.model.fireChange({ changes: [{ constructor: { name: "mxChildChange" }, child: added, parent: harness.module }], undo() { undone = true; } }); // NEW
    assert.equal(undone, true); // NEW

    undone = false; // NEW
    harness.card.parent = null; // NEW
    harness.model.fireChange({ changes: [{ constructor: { name: "mxChildChange" }, child: harness.card, previous: harness.module }], undo() { undone = true; } }); // NEW
    assert.equal(undone, true); // NEW
    harness.card.parent = harness.module; // NEW

    undone = false; // NEW
    harness.model.fireChange({ changes: [{ constructor: { name: "mxGeometryChange" }, cell: harness.card }], undo() { undone = true; } }); // NEW
    assert.equal(undone, true); // NEW

    undone = false; // NEW
    harness.model.fireChange({ changes: [{ constructor: { name: "mxChildChange" }, child: harness.card, previous: harness.module, parent: harness.module }], undo() { undone = true; } }); // NEW
    assert.equal(undone, true); // NEW

    undone = false; // NEW
    harness.model.fireChange({ changes: [{ constructor: { name: "mxCellAttributeChange" }, cell: harness.module, attribute: users.attrs.owner }], undo() { undone = true; } }); // NEW
    assert.equal(undone, true); // NEW
}); // NEW

test("owner and admin can add delete and move within owned scopes", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    users.stampCreatedOwner(harness.module); // NEW
    let undone = false; // NEW
    const added = appendChild(harness.module, makeXmlCell(harness.document, "owner-added", { label: "Owner Added" })); // NEW
    harness.model.fireChange({ changes: [{ constructor: { name: "mxChildChange" }, child: added, parent: harness.module }], undo() { undone = true; } }); // NEW
    assert.equal(undone, false); // NEW

    undone = false; // NEW
    added.parent = null; // NEW
    harness.model.fireChange({ changes: [{ constructor: { name: "mxChildChange" }, child: added, previous: harness.module }], undo() { undone = true; } }); // NEW
    assert.equal(undone, false); // NEW

    undone = false; // NEW
    harness.card.parent = harness.module; // NEW
    harness.model.fireChange({ changes: [{ constructor: { name: "mxChildChange" }, child: harness.card, previous: harness.module, parent: harness.module }], undo() { undone = true; } }); // NEW
    assert.equal(undone, false); // NEW

    undone = false; // NEW
    harness.model.fireChange({ changes: [{ constructor: { name: "mxGeometryChange" }, cell: harness.card }], undo() { undone = true; } }); // NEW
    assert.equal(undone, false); // NEW
}); // NEW

test("unowned modules are claimed on first allowed edit and only owner or admin can delete modules", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    const bob = users.createUser("Bob", "5678", false).user; // NEW
    users.logout(); // NEW
    users.login("Bob", "5678"); // NEW
    harness.module.style = "module=1"; // NEW
    assert.equal(harness.module.getAttribute(users.attrs.owner), null); // NEW
    let undone = false; // NEW
    harness.model.fireChange({ changes: [{ constructor: { name: "mxCellAttributeChange" }, cell: harness.module, key: "label" }], undo() { undone = true; } }); // NEW
    assert.equal(undone, false); // NEW
    assert.equal(harness.module.getAttribute(users.attrs.owner), bob.id); // NEW
    assert.equal(users.canDeleteCell(harness.module), true); // NEW
    users.logout(); // NEW
    users.login("Alice", "1234"); // NEW
    assert.equal(users.canDeleteCell(harness.module), true); // NEW
    const carol = users.createUser("Carol", "9999", false).user; // NEW
    users.logout(); // NEW
    users.login("Carol", "9999"); // NEW
    assert.equal(users.canDeleteCell(harness.module), false); // NEW
    assert.ok(carol); // NEW
}); // NEW

test("gardener grant allows only owned linked or created manual task edits", () => { // CHANGE
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const board = appendChild(harness.module, makeXmlCell(harness.document, "board", { board_key: "KANBAN_BOARD" })); // NEW
    const lane = appendChild(board, makeXmlCell(harness.document, "lane", { lane_key: "TODO" })); // NEW
    const bob = users.createUser("Bob", "5678", false).user; // NEW
    const bobPlanting = appendChild(harness.module, makeXmlCell(harness.document, "task-bob-planting", { tiler_group: "1", [users.attrs.owner]: bob.id })); // NEW
    const alicePlanting = appendChild(harness.module, makeXmlCell(harness.document, "task-alice-planting", { tiler_group: "1", [users.attrs.owner]: users.getCurrentUser().id })); // NEW
    const ownedLinked = appendChild(lane, makeXmlCell(harness.document, "owned-linked-task", { kanban_card: "1", title: "Water" })); // NEW
    const otherLinked = appendChild(lane, makeXmlCell(harness.document, "other-linked-task", { kanban_card: "1", title: "Weed" })); // NEW
    const createdManual = appendChild(lane, makeXmlCell(harness.document, "created-manual-task", { kanban_card: "1", title: "Manual", [users.attrs.createdBy]: bob.id })); // NEW
    const unownedManual = appendChild(lane, makeXmlCell(harness.document, "unowned-manual-task", { kanban_card: "1", title: "Manual" })); // NEW
    linkCells(bobPlanting, ownedLinked); // NEW
    linkCells(alicePlanting, otherLinked); // NEW
    assert.equal(users.setScopeGrant(board, { userId: bob.id, preset: "gardener" }).ok, true); // CHANGE
    users.logout(); users.login("Bob", "5678"); // NEW
    assert.equal(users.canMoveTask(ownedLinked), true); // CHANGE
    assert.equal(users.canEditTaskDetails(ownedLinked), true); // CHANGE
    assert.equal(users.canMoveTask(otherLinked), false); // NEW
    assert.equal(users.canEditTaskDetails(otherLinked), false); // NEW
    assert.equal(users.canMoveTask(createdManual), true); // NEW
    assert.equal(users.canEditTaskDetails(createdManual), true); // NEW
    assert.equal(users.canMoveTask(unownedManual), false); // NEW
    assert.equal(users.canEditTaskDetails(unownedManual), false); // NEW
    assert.equal(users.canAddCell(board), false); // NEW
    assert.equal(users._test.changeAllowed({ constructor: { name: "mxCellAttributeChange" }, cell: ownedLinked, attribute: "title" }), true); // CHANGE
    assert.equal(users._test.changeAllowed({ constructor: { name: "mxCellAttributeChange" }, cell: otherLinked, attribute: "title" }), false); // NEW
    assert.equal(users._test.changeAllowed({ constructor: { name: "mxCellAttributeChange" }, cell: createdManual, attribute: "title" }), true); // NEW
    assert.equal(users._test.changeAllowed({ constructor: { name: "mxCellAttributeChange" }, cell: ownedLinked, attribute: "task_assignee_role_ids_json" }), false); // CHANGE
    assert.equal(users._test.changeAllowed({ constructor: { name: "mxCellAttributeChange" }, cell: board, attribute: "task_view_mode" }), false); // NEW
    assert.equal(users._test.changeAllowed({ constructor: { name: "mxCellAttributeChange" }, cell: lane, attribute: "lane_key" }), false); // NEW
}); // NEW

test("coordinator grant can manage access but cannot transfer ownership", () => { // CHANGE
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const bob = users.createUser("Bob", "5678", false).user; // NEW
    const carol = users.createUser("Carol", "9999", false).user; // NEW
    assert.equal(users.setScopeGrant(harness.module, { userId: bob.id, preset: "coordinator" }).ok, true); // CHANGE
    users.logout(); users.login("Bob", "5678"); // NEW
    assert.equal(users.canManageAccess(harness.module), true); // NEW
    assert.equal(users._test.changeAllowed({ constructor: { name: "mxCellAttributeChange" }, cell: harness.card, attribute: "label" }), true); // NEW
    assert.equal(users._test.changeAllowed({ constructor: { name: "mxCellAttributeChange" }, cell: harness.module, attribute: users.attrs.owner }), false); // NEW
    assert.equal(users.setScopeGrant(harness.module, { userId: carol.id, preset: "visitor" }).ok, true); // CHANGE
    assert.equal(users.setOwner(harness.module, carol.id).ok, false); // NEW
}); // NEW

test("coordinator preset manages all content and access", () => { // CHANGE
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    assert.deepEqual(Array.from(users._test.normalizeCapabilities(null, "coordinator")), [ // CHANGE
        users.capabilities.createPlantings, // NEW
        users.capabilities.editTaskDetails, // NEW
        users.capabilities.manageAccess, // NEW
        users.capabilities.manageOwnPlantings, // NEW
        users.capabilities.manageScopeContent, // NEW
        users.capabilities.moveTasks // NEW
    ]); // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const board = appendChild(harness.module, makeXmlCell(harness.document, "coordinator-board", { board_key: "KANBAN_BOARD" })); // NEW
    const card = appendChild(board, makeXmlCell(harness.document, "coordinator-card", { kanban_card: "1", title: "Task" })); // NEW
    const bob = users.createUser("Bob", "5678", false).user; // NEW
    assert.equal(users.setScopeGrant(harness.module, { userId: bob.id, preset: "coordinator" }).ok, true); // CHANGE
    users.logout(); // NEW
    assert.equal(users.login("Bob", "5678").ok, true); // NEW
    assert.equal(users.canCreatePlanting(harness.module), true); // NEW
    const alicePlanting = appendChild(harness.module, makeXmlCell(harness.document, "coordinator-alice-planting", { tiler_group: "1", [users.attrs.owner]: users.listUsers().find(user => user.name === "Alice").id })); // NEW
    assert.equal(users.canManagePlanting(alicePlanting), true); // NEW
    assert.equal(users._test.changeAllowed({ constructor: { name: "mxGeometryChange" }, cell: alicePlanting }), true); // NEW
    assert.equal(users.canMoveTask(card), true); // CHANGE
    assert.equal(users.canEditTaskDetails(card), true); // CHANGE
    assert.equal(users.canManageAccess(harness.module), true); // CHANGE
}); // NEW

test("access editor exposes presets without granular capability checkboxes", () => { // CHANGE
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const bob = users.createUser("Bob", "5678", false).user; // NEW
    assert.equal(users.setScopeGrant(harness.module, { userId: bob.id, preset: "visitor" }).ok, true); // CHANGE
    harness.graph.setSelectionCell(harness.module); // NEW
    harness.actions.trellisUsers.funct(); // NEW
    const select = selectByOptionText(harness.document, "Gardener"); // NEW
    assert.ok(select); // NEW
    assert.deepEqual(Array.from(select.options).map(option => option.textContent), ["Visitor", "Gardener", "Coordinator"]); // NEW
    assert.equal(checkboxByLabel(harness.document, "Manage scope content"), null); // CHANGE
    assert.equal(checkboxByLabel(harness.document, "Create plantings"), null); // CHANGE
    assert.equal(checkboxByLabel(harness.document, "Manage access"), null); // CHANGE
}); // NEW

test("child access view shows inherited coordinator without writing grants", () => { // CHANGE
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const child = appendChild(harness.module, makeXmlCell(harness.document, "inherited-child", { label: "Child Cell" })); // NEW
    const bob = users.createUser("Bob", "5678", false).user; // NEW
    assert.equal(users.setScopeGrant(harness.module, { userId: bob.id, preset: "coordinator" }).ok, true); // CHANGE
    const parentGrantsBefore = harness.module.getAttribute(users.attrs.accessGrants); // NEW
    const writesBefore = harness.model.setValueCalls || 0; // NEW
    users.logout(); // NEW
    assert.equal(users.login("Bob", "5678").ok, true); // NEW
    harness.graph.setSelectionCell(child); // NEW
    harness.actions.trellisUsers.funct(); // NEW
    assert.equal(accessRowByUserId(harness.document, bob.id), null); // CHANGE
    assert.match(harness.document.body.textContent, /Coordinator in Module/); // CHANGE
    assert.match(harness.document.body.textContent, /Your effective access: Coordinator/); // NEW
    assert.match(harness.document.body.textContent, /Select a module, garden bed, or task board to manage grants/); // NEW
    assert.equal(child.getAttribute(users.attrs.accessGrants), null); // NEW
    assert.equal(harness.module.getAttribute(users.attrs.accessGrants), parentGrantsBefore); // NEW
    assert.equal(harness.model.setValueCalls || 0, writesBefore); // NEW
}); // NEW

test("ordinary child cells cannot receive direct access grants", () => { // CHANGE
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const child = appendChild(harness.module, makeXmlCell(harness.document, "direct-child-denied", { label: "Child Cell" })); // CHANGE
    const bob = users.createUser("Bob", "5678", false).user; // NEW
    assert.equal(users.setScopeGrant(child, { userId: bob.id, preset: "coordinator" }).ok, false); // CHANGE
    assert.equal(users._test.changeAllowed({ constructor: { name: "mxCellAttributeChange" }, cell: child, attribute: users.attrs.accessGrants }), false); // NEW
    assert.equal(child.getAttribute(users.attrs.accessGrants), null); // CHANGE
}); // NEW

test("direct named child grants remain distinguishable from inherited parent access", () => { // CHANGE
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const bed = appendChild(harness.module, makeXmlCell(harness.document, "direct-and-inherited-bed", { garden_bed: "1", label: "North Bed" })); // CHANGE
    const bob = users.createUser("Bob", "5678", false).user; // NEW
    assert.equal(users.setScopeGrant(harness.module, { userId: bob.id, preset: "coordinator" }).ok, true); // CHANGE
    assert.equal(users.setScopeGrant(bed, { userId: bob.id, preset: "visitor" }).ok, true); // CHANGE
    const parentGrantsBefore = harness.module.getAttribute(users.attrs.accessGrants); // NEW
    harness.graph.setSelectionCell(bed); // CHANGE
    harness.actions.trellisUsers.funct(); // NEW
    const row = accessRowByUserId(harness.document, bob.id); // NEW
    assert.ok(row); // NEW
    assert.match(row.textContent, /Granted/); // NEW
    assert.match(row.textContent, /Coordinator in Module/); // CHANGE
    assert.equal(harness.module.getAttribute(users.attrs.accessGrants), parentGrantsBefore); // NEW
}); // NEW

test("coordinator can create and delete garden beds in a granted module", () => { // CHANGE
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const bob = users.createUser("Bob", "5678", false).user; // NEW
    assert.equal(users.setScopeGrant(harness.module, { userId: bob.id, preset: "coordinator" }).ok, true); // CHANGE
    users.logout(); // NEW
    assert.equal(users.login("Bob", "5678").ok, true); // NEW
    const createdBed = appendChild(harness.module, makeXmlCell(harness.document, "coordinator-created-bed", { garden_bed: "1" })); // CHANGE
    let undone = false; // NEW
    harness.model.fireChange({ changes: [{ constructor: { name: "mxChildChange" }, child: createdBed, parent: harness.module }], undo() { undone = true; } }); // NEW
    assert.equal(undone, false); // NEW
    const existingBed = appendChild(harness.module, makeXmlCell(harness.document, "coordinator-existing-bed", { garden_bed: "1" })); // CHANGE
    existingBed.parent = null; // NEW
    undone = false; // NEW
    harness.model.fireChange({ changes: [{ constructor: { name: "mxChildChange" }, child: existingBed, previous: harness.module }], undo() { undone = true; } }); // NEW
    assert.equal(undone, false); // NEW
}); // NEW

test("linked role cards do not bypass gardener task ownership rules", () => { // CHANGE
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const board = appendChild(harness.module, makeXmlCell(harness.document, "board", { board_key: "KANBAN_BOARD", linkedTo: "role-bob" })); // NEW
    const lane = appendChild(board, makeXmlCell(harness.document, "lane", { lane_key: "TODO" })); // NEW
    const card = appendChild(lane, makeXmlCell(harness.document, "task", { kanban_card: "1", title: "Water" })); // NEW
    const role = appendChild(harness.module, new TestCell("role-bob", makeXmlCell(harness.document, "role-value", { label: "Bob Role", linkedTo: "board" }).value, "shape=swimlane;role_card=1;")); // NEW
    const bob = users.createUser("Bob", "5678", false).user; // NEW
    assert.equal(users.setUserRoleCard(bob.id, role).ok, true); // NEW
    users.logout(); users.login("Bob", "5678"); // NEW
    assert.equal(users.canMoveTask(card), false); // CHANGE
    assert.equal(users.canEditTaskDetails(card), false); // NEW
    const duplicate = appendChild(harness.module, new TestCell("role-bob-2", makeXmlCell(harness.document, "role-value-2", { label: "Bob Role 2", linkedTo: "board", [users.attrs.roleUser]: bob.id }).value, "shape=swimlane;role_card=1;")); // NEW
    assert.ok(duplicate); // NEW
    assert.equal(users.getUserRoleCard(bob.id), null); // NEW
    assert.equal(users.canMoveTask(card), false); // NEW
}); // NEW

test("garden grant creates a garden-scoped role card and links it to garden task boards", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    installGardenRoleModuleApi(harness); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    harness.module.setAttribute("garden_module", "1"); // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const board = appendChild(harness.module, makeXmlCell(harness.document, "garden-board", { board_key: "KANBAN_BOARD" })); // NEW
    const bob = users.createUser("Bob", "5678", false).user; // NEW
    assert.equal(users.setScopeGrant(harness.module, { userId: bob.id, preset: "gardener" }).ok, true); // NEW
    const team = harness.model.getCell(harness.module.getAttribute(users.attrs.gardenTeamModule)); // NEW
    const role = team.children.find(child => String(child.style || "").includes("role_card=1")); // NEW
    assert.ok(role); // NEW
    assert.equal(role.getAttribute(users.attrs.roleUser), bob.id); // NEW
    assert.equal(role.getAttribute(users.attrs.roleGardenModule), harness.module.id); // NEW
    assert.equal(role.getAttribute(users.attrs.roleTeamModule), team.id); // NEW
    assert.equal(roleFieldText(role, "role_name"), "Bob"); // NEW
    assert.equal(roleFieldText(role, "role_title"), "Gardener"); // NEW
    assert.match(board.getAttribute("linkedTo") || "", new RegExp(role.id)); // NEW
    assert.match(role.getAttribute("linkedTo") || "", new RegExp(board.id)); // NEW
}); // NEW

test("user can have separate active role cards in multiple gardens", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    installGardenRoleModuleApi(harness); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    harness.module.setAttribute("garden_module", "1"); // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const secondGarden = appendChild(harness.layer, makeXmlCell(harness.document, "garden-two", { label: "Second Garden", garden_module: "1" })); // NEW
    secondGarden.style = "module=1"; // NEW
    users.stampCreatedOwner(secondGarden); // NEW
    const bob = users.createUser("Bob", "5678", false).user; // NEW
    assert.equal(users.setScopeGrant(harness.module, { userId: bob.id, preset: "gardener" }).ok, true); // NEW
    assert.equal(users.setScopeGrant(secondGarden, { userId: bob.id, preset: "coordinator" }).ok, true); // NEW
    const firstRole = users._test.getUserGardenRoleCard(bob.id, harness.module); // NEW
    const secondRole = users._test.getUserGardenRoleCard(bob.id, secondGarden); // NEW
    assert.ok(firstRole); // NEW
    assert.ok(secondRole); // NEW
    assert.notEqual(firstRole.id, secondRole.id); // NEW
    assert.equal(users.getUserRoleCard(bob.id), null); // NEW
}); // NEW

test("removing garden access unlinks the user but preserves the role card", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    installGardenRoleModuleApi(harness); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    harness.module.setAttribute("garden_module", "1"); // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const bob = users.createUser("Bob", "5678", false).user; // NEW
    users.setScopeGrant(harness.module, { userId: bob.id, preset: "gardener" }); // NEW
    const role = users._test.getUserGardenRoleCard(bob.id, harness.module).cell; // NEW
    const team = harness.model.getCell(harness.module.getAttribute(users.attrs.gardenTeamModule)); // NEW
    assert.equal(users.removeScopeGrant(harness.module, bob.id).ok, true); // NEW
    assert.equal(role.parent !== null, true); // NEW
    assert.equal(role.getAttribute(users.attrs.roleUser), null); // NEW
    assert.equal(role.getAttribute(users.attrs.roleArchivedUser), bob.id); // NEW
    assert.equal(role.getAttribute(users.attrs.roleInactive), "1"); // NEW
    assert.equal(roleFieldText(role, "role_status"), "Inactive - restorable"); // NEW
    assert.equal(role.getAttribute(users.attrs.roleGardenModule), harness.module.id); // NEW
    const archive = JSON.parse(team.getAttribute(users.attrs.teamRoleArchive)); // NEW
    assert.equal(archive.roles[bob.id].roleCardId, role.id); // NEW
    assert.equal(archive.roles[bob.id].preset, "gardener"); // NEW
}); // NEW

test("rechecking garden access restores the archived role card without duplicating profile data in archive", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    installGardenRoleModuleApi(harness); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    harness.module.setAttribute("garden_module", "1"); // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const bob = users.createUser("Bob", "5678", false).user; // NEW
    assert.equal(users.setScopeGrant(harness.module, { userId: bob.id, preset: "gardener" }).ok, true); // NEW
    const team = harness.model.getCell(harness.module.getAttribute(users.attrs.gardenTeamModule)); // NEW
    const role = users._test.getUserGardenRoleCard(bob.id, harness.module).cell; // NEW
    assert.equal(users.removeScopeGrant(harness.module, bob.id).ok, true); // NEW
    const archive = JSON.parse(team.getAttribute(users.attrs.teamRoleArchive)); // NEW
    assert.equal(archive.roles[bob.id].roleCardId, role.id); // NEW
    assert.equal(Object.prototype.hasOwnProperty.call(archive.roles[bob.id], "name"), false); // NEW
    assert.equal(Object.prototype.hasOwnProperty.call(archive.roles[bob.id], "title"), false); // NEW
    assert.equal(Object.prototype.hasOwnProperty.call(archive.roles[bob.id], "contact"), false); // NEW
    assert.equal(harness.moduleMarginCalls.filter(call => call.moduleCell === team).length, 1); // NEW
    assert.equal(users.setScopeGrant(harness.module, { userId: bob.id, preset: "coordinator" }).ok, true); // NEW
    const restored = users._test.getUserGardenRoleCard(bob.id, harness.module).cell; // NEW
    assert.equal(restored.id, role.id); // NEW
    assert.equal(restored.getAttribute(users.attrs.roleUser), bob.id); // NEW
    assert.equal(restored.getAttribute(users.attrs.roleArchivedUser), null); // NEW
    assert.equal(restored.getAttribute(users.attrs.roleInactive), null); // NEW
    assert.equal(roleFieldText(restored, "role_status"), ""); // NEW
    assert.equal(roleFieldText(restored, "role_title"), "Gardener"); // CHANGE
    assert.equal(team.children.filter(child => String(child.style || "").includes("role_card=1")).length, 1); // NEW
    assert.equal(harness.moduleMarginCalls.filter(call => call.moduleCell === team).length, 2); // NEW
}); // NEW

test("admin roster garden access view does not repair missing companion teams", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    installGardenRoleModuleApi(harness); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    harness.module.setAttribute("garden_module", "1"); // NEW
    harness.module.setAttribute("label", "North Garden"); // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const bob = users.createUser("Bob", "5678", false).user; // NEW
    harness.module.setAttribute(users.attrs.accessGrants, JSON.stringify([{ userId: bob.id, preset: "gardener", capabilities: [] }])); // NEW
    harness.actions.trellisUsers.funct(); // NEW
    openGardenAccessPopover(harness.document, bob.id); // NEW
    const row = gardenAccessRow(harness.document, bob.id, harness.module.id); // CHANGE
    assert.ok(row); // NEW
    assert.match(row.textContent, /Missing role/); // NEW
    assert.equal(harness.module.getAttribute(users.attrs.gardenTeamModule), null); // NEW
    assert.equal(harness.model.getCell("team-" + harness.module.id), null); // NEW
}); // NEW

test("admin roster shows one garden access dropdown per user with checkbox rows", () => { // CHANGE
    const harness = loadUsersPlugin(); // NEW
    installGardenRoleModuleApi(harness); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    harness.module.setAttribute("garden_module", "1"); // NEW
    harness.module.setAttribute("label", "North Garden"); // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const bob = users.createUser("Bob", "5678", false).user; // NEW
    users.setScopeGrant(harness.module, { userId: bob.id, preset: "gardener" }); // NEW
    harness.actions.trellisUsers.funct(); // NEW
    const dropdown = harness.document.querySelector('.trellis-users-garden-access-dropdown[data-trellis-users-user-id="' + bob.id + '"]'); // NEW
    assert.ok(dropdown); // NEW
    const button = dropdown.querySelector(".trellis-users-garden-access-button"); // NEW
    assert.ok(button); // NEW
    assert.match(button.textContent, /Garden access \(1\)/); // CHANGE
    assert.equal(button.getAttribute("aria-haspopup"), "dialog"); // NEW
    assert.equal(button.getAttribute("aria-expanded"), "false"); // NEW
    const openDropdown = openGardenAccessPopover(harness.document, bob.id); // NEW
    assert.equal(openDropdown.querySelector(".trellis-users-garden-access-button").getAttribute("aria-expanded"), "true"); // NEW
    assert.ok(openDropdown.querySelector(".trellis-users-garden-access-popover")); // NEW
    const row = gardenAccessRow(harness.document, bob.id, harness.module.id); // CHANGE
    assert.ok(row); // NEW
    assert.match(row.textContent, /North Garden/); // NEW
    assert.match(row.textContent, /Active/); // CHANGE
    assert.equal(row.querySelector('input[type="checkbox"]').checked, true); // NEW
    assert.equal(row.querySelector("select").value, "gardener"); // CHANGE
}); // NEW

test("garden access dropdown checkbox creates archives and restores role cards", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    installGardenRoleModuleApi(harness); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    harness.module.setAttribute("garden_module", "1"); // NEW
    harness.module.setAttribute("label", "North Garden"); // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const bob = users.createUser("Bob", "5678", false).user; // NEW
    harness.actions.trellisUsers.funct(); // NEW
    openGardenAccessPopover(harness.document, bob.id); // NEW
    let row = gardenAccessRow(harness.document, bob.id, harness.module.id); // CHANGE
    let checkbox = row.querySelector('input[type="checkbox"]'); // NEW
    const select = row.querySelector("select"); // NEW
    select.value = "gardener"; // NEW
    checkbox.checked = true; // NEW
    checkbox.dispatchEvent(new harness.context.window.Event("change", { bubbles: true })); // NEW
    assert.deepEqual(JSON.parse(harness.module.getAttribute(users.attrs.accessGrants)).map(grant => ({ userId: grant.userId, preset: grant.preset })), [{ userId: bob.id, preset: "gardener" }]); // NEW
    const team = harness.model.getCell(harness.module.getAttribute(users.attrs.gardenTeamModule)); // NEW
    assert.ok(team); // NEW
    assert.equal(harness.moduleMarginCalls.filter(call => call.moduleCell === team).length, 1); // NEW
    const role = users._test.getUserGardenRoleCard(bob.id, harness.module).cell; // NEW
    assert.ok(role); // NEW
    assert.ok(harness.document.querySelector(".trellis-users-garden-access-popover")); // NEW
    row = gardenAccessRow(harness.document, bob.id, harness.module.id); // CHANGE
    checkbox = row.querySelector('input[type="checkbox"]'); // NEW
    checkbox.checked = false; // NEW
    checkbox.dispatchEvent(new harness.context.window.Event("change", { bubbles: true })); // NEW
    assert.equal(harness.module.getAttribute(users.attrs.accessGrants), null); // NEW
    assert.equal(role.getAttribute(users.attrs.roleUser), null); // NEW
    assert.equal(role.getAttribute(users.attrs.roleInactive), "1"); // NEW
    assert.equal(roleFieldText(role, "role_status"), "Inactive - restorable"); // NEW
    assert.ok(harness.document.querySelector(".trellis-users-garden-access-popover")); // NEW
    row = gardenAccessRow(harness.document, bob.id, harness.module.id); // CHANGE
    assert.match(row.textContent, /Inactive\/restorable/); // NEW
    checkbox = row.querySelector('input[type="checkbox"]'); // NEW
    checkbox.checked = true; // NEW
    checkbox.dispatchEvent(new harness.context.window.Event("change", { bubbles: true })); // NEW
    const restored = users._test.getUserGardenRoleCard(bob.id, harness.module).cell; // NEW
    assert.equal(restored.id, role.id); // NEW
    assert.equal(restored.getAttribute(users.attrs.roleUser), bob.id); // NEW
    assert.equal(roleFieldText(restored, "role_status"), ""); // NEW
    assert.ok(harness.document.querySelector(".trellis-users-garden-access-popover")); // NEW
    assert.equal(harness.moduleMarginCalls.filter(call => call.moduleCell === team).length, 2); // NEW
}); // NEW

test("garden access popover filters by garden name and preserves search after checkbox changes", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    installGardenRoleModuleApi(harness); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    harness.module.setAttribute("garden_module", "1"); // NEW
    harness.module.setAttribute("label", "North Garden"); // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const southGarden = appendChild(harness.layer, makeXmlCell(harness.document, "south-filter-garden", { label: "South Garden", garden_module: "1" })); // NEW
    southGarden.style = "module=1"; // NEW
    users.stampCreatedOwner(southGarden); // NEW
    const bob = users.createUser("Bob", "5678", false).user; // NEW
    harness.actions.trellisUsers.funct(); // NEW
    let dropdown = openGardenAccessPopover(harness.document, bob.id); // NEW
    let search = dropdown.querySelector(".trellis-users-garden-access-search"); // NEW
    search.value = "south"; // NEW
    search.dispatchEvent(new harness.context.window.Event("input", { bubbles: true })); // NEW
    dropdown = harness.document.querySelector('.trellis-users-garden-access-dropdown[data-trellis-users-user-id="' + bob.id + '"]'); // NEW
    search = dropdown.querySelector(".trellis-users-garden-access-search"); // NEW
    assert.equal(search.value, "south"); // NEW
    assert.equal(gardenAccessRow(harness.document, bob.id, harness.module.id), null); // NEW
    const southRow = gardenAccessRow(harness.document, bob.id, southGarden.id); // NEW
    assert.ok(southRow); // NEW
    const checkbox = southRow.querySelector('input[type="checkbox"]'); // NEW
    checkbox.checked = true; // NEW
    checkbox.dispatchEvent(new harness.context.window.Event("change", { bubbles: true })); // NEW
    dropdown = harness.document.querySelector('.trellis-users-garden-access-dropdown[data-trellis-users-user-id="' + bob.id + '"]'); // NEW
    assert.ok(dropdown.querySelector(".trellis-users-garden-access-popover")); // NEW
    assert.equal(dropdown.querySelector(".trellis-users-garden-access-search").value, "south"); // NEW
    assert.ok(gardenAccessRow(harness.document, bob.id, southGarden.id)); // NEW
    assert.equal(gardenAccessRow(harness.document, bob.id, harness.module.id), null); // NEW
}); // NEW

test("restored garden role keeps task assignment ids and relinks boards", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    installGardenRoleModuleApi(harness); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    harness.module.setAttribute("garden_module", "1"); // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const board = appendChild(harness.module, makeXmlCell(harness.document, "assignment-board", { board_key: "KANBAN_BOARD" })); // NEW
    const task = appendChild(board, makeXmlCell(harness.document, "assigned-task", { kanban_card: "1" })); // NEW
    const bob = users.createUser("Bob", "5678", false).user; // NEW
    assert.equal(users.setScopeGrant(harness.module, { userId: bob.id, preset: "gardener" }).ok, true); // NEW
    const role = users._test.getUserGardenRoleCard(bob.id, harness.module).cell; // NEW
    task.setAttribute("task_assignee_role_ids_json", JSON.stringify([role.id])); // NEW
    assert.equal(users.removeScopeGrant(harness.module, bob.id).ok, true); // NEW
    board.setAttribute("linkedTo", ""); // NEW
    role.setAttribute("linkedTo", ""); // NEW
    assert.equal(users.setScopeGrant(harness.module, { userId: bob.id, preset: "gardener" }).ok, true); // NEW
    const restored = users._test.getUserGardenRoleCard(bob.id, harness.module).cell; // NEW
    assert.equal(restored.id, role.id); // NEW
    assert.deepEqual(JSON.parse(task.getAttribute("task_assignee_role_ids_json")), [role.id]); // NEW
    assert.match(board.getAttribute("linkedTo") || "", new RegExp(role.id)); // NEW
    assert.match(role.getAttribute("linkedTo") || "", new RegExp(board.id)); // NEW
}); // NEW

test("garden access dropdown checkboxes keep multiple gardens independent for one user", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    installGardenRoleModuleApi(harness); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    harness.module.setAttribute("garden_module", "1"); // NEW
    harness.module.setAttribute("label", "North Garden"); // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const southGarden = appendChild(harness.layer, makeXmlCell(harness.document, "south-garden", { label: "South Garden", garden_module: "1" })); // NEW
    southGarden.style = "module=1"; // NEW
    users.stampCreatedOwner(southGarden); // NEW
    const bob = users.createUser("Bob", "5678", false).user; // NEW
    harness.actions.trellisUsers.funct(); // NEW
    openGardenAccessPopover(harness.document, bob.id); // NEW
    const setGardenChecked = function (garden, checked, preset) { // NEW
        const row = gardenAccessRow(harness.document, bob.id, garden.id); // CHANGE
        if (preset) row.querySelector("select").value = preset; // NEW
        const checkbox = row.querySelector('input[type="checkbox"]'); // NEW
        checkbox.checked = checked; // NEW
        checkbox.dispatchEvent(new harness.context.window.Event("change", { bubbles: true })); // NEW
    }; // NEW
    setGardenChecked(harness.module, true, "gardener"); // NEW
    setGardenChecked(southGarden, true, "coordinator"); // NEW
    const northRole = users._test.getUserGardenRoleCard(bob.id, harness.module).cell; // NEW
    const southRole = users._test.getUserGardenRoleCard(bob.id, southGarden).cell; // NEW
    assert.notEqual(northRole.id, southRole.id); // NEW
    setGardenChecked(harness.module, false); // NEW
    assert.equal(users._test.getUserGardenRoleCard(bob.id, harness.module), null); // NEW
    assert.equal(northRole.getAttribute(users.attrs.roleInactive), "1"); // NEW
    assert.equal(users._test.getUserGardenRoleCard(bob.id, southGarden).cell.id, southRole.id); // NEW
    assert.equal(southRole.getAttribute(users.attrs.roleUser), bob.id); // NEW
}); // NEW

test("pending invite creates regular pending user grants and email draft", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "swimlane;module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const result = users.createPendingInvite({ email: "Bob@Example.com", scopeCellIds: [harness.module.id], shareInfo: { deviceId: "DEV", folderId: "FOL", folderLabel: "Garden", folderPath: "C:/Garden" } }); // NEW
    assert.equal(result.ok, true); // NEW
    assert.equal(result.invite.email, "bob@example.com"); // NEW
    assert.match(result.emailDraft.body, /DEV/); // NEW
    assert.match(result.emailDraft.body, /FOL/); // NEW
    assert.match(result.emailDraft.body, new RegExp(result.code.replace("-", "\\-"))); // NEW
    const store = users._test.readStore(); // NEW
    assert.equal(store.pendingUsers.length, 1); // NEW
    assert.equal(store.invites.length, 1); // NEW
    assert.equal(store.invites[0].status, "pending"); // NEW
    assert.ok(store.invites[0].expiresAt > Date.now() + 13 * 24 * 60 * 60 * 1000); // NEW
    const grants = JSON.parse(harness.module.getAttribute(users.attrs.accessGrants)); // CHANGE
    assert.deepEqual(grants, [{ userId: store.pendingUsers[0].id, preset: "visitor", capabilities: [] }]); // CHANGE
}); // NEW

test("pending garden invite creates no role card until acceptance", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    installGardenRoleModuleApi(harness); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    harness.module.setAttribute("garden_module", "1"); // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const invite = users.createPendingInvite({ email: "bob@example.com", scopeCellIds: [harness.module.id], preset: "gardener" }); // NEW
    assert.equal(invite.ok, true); // NEW
    assert.equal(harness.model.getCell(harness.module.getAttribute(users.attrs.gardenTeamModule)), null); // NEW
    const accepted = users.acceptInvite({ email: "bob@example.com", code: invite.code, name: "Bob", pin: "5678" }); // NEW
    assert.equal(accepted.ok, true); // NEW
    const role = users._test.getUserGardenRoleCard(accepted.user.id, harness.module); // NEW
    assert.ok(role); // NEW
    assert.equal(roleFieldText(role.cell, "role_title"), "Gardener"); // NEW
}); // NEW

test("duplicate invite email is rejected for pending users", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    assert.equal(users.createPendingInvite({ email: "bob@example.com", scopeCellIds: [harness.module.id] }).ok, true); // NEW
    const duplicate = users.createPendingInvite({ email: "BOB@example.com", scopeCellIds: [harness.module.id] }); // NEW
    assert.equal(duplicate.ok, false); // NEW
    assert.match(duplicate.reason, /already/); // NEW
}); // NEW

test("pending invite stores selected preset capabilities", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const invite = users.createPendingInvite({ email: "gardener@example.com", scopeCellIds: [harness.module.id], preset: "gardener" }); // CHANGE
    assert.equal(invite.ok, true); // NEW
    assert.equal(invite.invite.preset, "gardener"); // CHANGE
    assert.deepEqual(Array.from(invite.invite.capabilities), ["create_plantings", "edit_task_details", "manage_own_plantings", "move_tasks"]); // CHANGE
    assert.deepEqual(JSON.parse(harness.module.getAttribute(users.attrs.accessGrants))[0].capabilities, ["create_plantings", "edit_task_details", "manage_own_plantings", "move_tasks"]); // CHANGE
}); // NEW

test("accept invite activates pending regular user and prevents token reuse", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const invite = users.createPendingInvite({ email: "bob@example.com", scopeCellIds: [harness.module.id] }); // NEW
    users.logout(); // NEW
    const accepted = users.acceptInvite({ email: "bob@example.com", code: invite.code, name: "Bob", pin: "5678" }); // NEW
    assert.equal(accepted.ok, true); // NEW
    assert.equal(users.getCurrentUser().email, "bob@example.com"); // NEW
    assert.equal(users.canEditCell(harness.card), false); // CHANGE
    assert.equal(users.canAddCell(harness.module), false); // NEW
    users.logout(); // NEW
    const reuse = users.acceptInvite({ email: "bob@example.com", code: invite.code, name: "Bob 2", pin: "9999" }); // NEW
    assert.equal(reuse.ok, false); // NEW
    assert.match(reuse.reason, /No active invite/); // NEW
}); // NEW

test("revoking pending invite removes pending grants", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const invite = users.createPendingInvite({ email: "bob@example.com", scopeCellIds: [harness.module.id] }); // NEW
    const pendingId = invite.invite.pendingUserId; // NEW
    assert.match(harness.module.getAttribute(users.attrs.accessGrants), new RegExp(pendingId)); // CHANGE
    assert.equal(users.revokeInvite(invite.invite.id).ok, true); // NEW
    assert.doesNotMatch(harness.module.getAttribute(users.attrs.accessGrants) || "", new RegExp(pendingId)); // CHANGE
    assert.equal(users.acceptInvite({ email: "bob@example.com", code: invite.code, name: "Bob", pin: "5678" }).ok, false); // NEW
}); // NEW

test("resend invite rotates code and expiry", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const invite = users.createPendingInvite({ email: "bob@example.com", scopeCellIds: [harness.module.id] }); // NEW
    const firstHash = users._test.readStore().invites[0].codeHash; // NEW
    const resent = users.resendInvite(invite.invite.id, { deviceId: "NEWDEV" }); // NEW
    assert.equal(resent.ok, true); // NEW
    const next = users._test.readStore().invites[0]; // NEW
    assert.notEqual(next.codeHash, firstHash); // NEW
    assert.notEqual(resent.code, invite.code); // NEW
    assert.match(resent.emailDraft.body, /NEWDEV/); // NEW
}); // NEW

test("regular non-owner cannot invite selected scopes", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    users.createUser("Bob", "5678", false); // NEW
    users.logout(); // NEW
    users.login("Bob", "5678"); // NEW
    const result = users.createPendingInvite({ email: "carol@example.com", scopeCellIds: [harness.module.id] }); // NEW
    assert.equal(result.ok, false); // NEW
    assert.match(result.reason, /own or administer/); // NEW
}); // NEW

test("expired invites are hidden and remove pending grants", () => { // NEW
    const harness = loadUsersPlugin(); // NEW
    const users = harness.context.window.Trellis.users; // NEW
    users.enableUsers("Alice", "1234"); // NEW
    harness.module.style = "module=1"; // NEW
    users.stampCreatedOwner(harness.module); // NEW
    const invite = users.createPendingInvite({ email: "bob@example.com", scopeCellIds: [harness.module.id] }); // NEW
    const store = users._test.readStore(); // NEW
    store.invites[0].expiresAt = Date.now() - 1; // NEW
    users._test.writeStore(store); // NEW
    assert.deepEqual(users.listPendingInvites(), []); // NEW
    assert.doesNotMatch(harness.module.getAttribute(users.attrs.accessGrants) || "", new RegExp(invite.invite.pendingUserId)); // CHANGE
    assert.equal(users.acceptInvite({ email: "bob@example.com", code: invite.code, name: "Bob", pin: "5678" }).ok, false); // NEW
}); // NEW
