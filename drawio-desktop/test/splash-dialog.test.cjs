const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const projectRoot = path.resolve(__dirname, "..");
const dialogsPath = path.join(projectRoot, "drawio/src/main/webapp/js/diagramly/Dialogs.js");
const appPath = path.join(projectRoot, "drawio/src/main/webapp/js/diagramly/App.js");
const bundledPath = path.join(projectRoot, "drawio/src/main/webapp/js/app.min.js");
const wizardStorageKey = "trellis.licenseWizard.v2";

function loadSplashDialog(options = {}) {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.test/" });
    const timers = [];

    dom.window.setTimeout = function (callback, delay) {
        const id = timers.length + 1;
        timers.push({ id, callback, delay, cleared: false });
        return id;
    };
    dom.window.clearTimeout = function (id) {
        const timer = timers.find((entry) => entry.id === id);

        if (timer != null) {
            timer.cleared = true;
        }
    };

    if (options.savedRecord) {
        dom.window.localStorage.setItem(wizardStorageKey, JSON.stringify(options.savedRecord));
    }

    if (options.oldChoice) {
        dom.window.localStorage.setItem("trellis.licenseNotice.v1", JSON.stringify({ choice: options.oldChoice, version: "1" }));
    }

    const actions = {
        new: { funct() {} },
        open: { funct() {} }
    };
    const context = {
        window: dom.window,
        document: dom.window.document,
        localStorage: dom.window.localStorage,
        JSON,
        Date,
        console,
        IMAGE_PATH: "images",
        urlParams: {},
        mxClient: { IS_CHROMEAPP: false },
        mxImage: function (src, width, height) { // NEW
            return { src, width, height }; // NEW
        }, // NEW
        EditorUi: { isElectronApp: true },
        App: {
            MODE_GOOGLE: "google",
            MODE_DROPBOX: "dropbox",
            MODE_ONEDRIVE: "onedrive",
            MODE_GITHUB: "github",
            MODE_GITLAB: "gitlab",
            MODE_BROWSER: "browser",
            MODE_TRELLO: "trello",
            MODE_DEVICE: "device"
        },
        mxResources: {
            get(key) {
                return {
                    createNewDiagram: "Create New Diagram",
                    openExistingDiagram: "Open Existing Diagram",
                    device: "Device"
                }[key] || key;
            }
        },
        mxUtils: {
            write(node, value) {
                node.appendChild(dom.window.document.createTextNode(String(value)));
            },
            br(node) {
                node.appendChild(dom.window.document.createElement("br"));
            },
            button(label, callback) {
                const button = dom.window.document.createElement("button");
                button.textContent = label;
                button.addEventListener("click", callback);
                return button;
            },
            trim(value) {
                return String(value).trim();
            }
        },
        mxEvent: {
            addListener(node, eventName, callback) {
                node.addEventListener(eventName, callback);
            },
            consume(evt) {
                if (evt != null && evt.preventDefault != null) {
                    evt.preventDefault();
                }
            }
        }
    };

    vm.runInNewContext(fs.readFileSync(dialogsPath, "utf8"), context, { filename: dialogsPath });
    const editorUi = {
        mode: context.App.MODE_DEVICE,
        addLanguageMenu() {
            return null;
        },
        actions: {
            get(id) {
                return actions[id];
            }
        },
        hideDialog() {},
        openLink() {}
    };
    const dialog = new context.SplashDialog(editorUi);
    return { dom, dialog, timers };
}

function findButton(root, label) {
    return Array.from(root.querySelectorAll("button")).find((button) => button.textContent.includes(label));
}

function completeVisibleOath(dom, dialog) {
    const playButton = findButton(dialog.container, "Play Oath Aloud");

    playButton.click();
    playButton.click();
    playButton.click();

    const overrideButton = findButton(dialog.container, "Manual audio override");
    assert.equal(overrideButton.style.display, "");
    overrideButton.click();

    const inputs = dialog.container.querySelectorAll("input");
    inputs[0].value = "Test User";
    inputs[1].value = "test@example.com";
    inputs[2].value = "Test User";
    inputs[3].checked = true;

    findButton(dialog.container, "I Affirm the Oath").click();
}

test("SplashDialog renders the usage wizard and hides diagram actions before oath completion", () => {
    const { dialog, timers } = loadSplashDialog();
    const text = dialog.container.textContent;

    assert.match(text, /Choose your path/);
    assert.match(text, /Personal \/ Noncommercial/);
    assert.match(text, /Education \/ Nonprofit \/ Public-interest/);
    assert.match(text, /Commercial \/ Client \/ Company/);
    assert.match(text, /Not sure/);
    assert.equal(dialog.container.querySelector(".trellis-splash-actions").style.display, "none");
    assert.equal(dialog.isTrellisLicenseWizardComplete(), false);
    assert.equal(timers.length, 0);
});

test("Commercial path shows contact guidance and the Grand Oath gate", () => {
    const { dialog } = loadSplashDialog();

    findButton(dialog.container, "Commercial / Client / Company").click();

    assert.match(dialog.container.textContent, /Contact before relying on commercial permission/);
    assert.match(dialog.container.textContent, /Placeholder Contact Name/);
    assert.match(dialog.container.textContent, /The Grand Oath of Paying Attention/);
    assert.ok(findButton(dialog.container, "Play Oath Aloud"));
    assert.ok(findButton(dialog.container, "I Affirm the Oath"));
});

test("Oath completion stores the wizard record and reveals actions after two seconds", () => {
    const { dom, dialog, timers } = loadSplashDialog();
    const actions = dialog.container.querySelector(".trellis-splash-actions");

    findButton(dialog.container, "Commercial / Client / Company").click();
    completeVisibleOath(dom, dialog);

    const record = JSON.parse(dom.window.localStorage.getItem(wizardStorageKey));
    assert.equal(record.path, "commercial");
    assert.equal(record.contactGuidance, true);
    assert.equal(record.name, "Test User");
    assert.equal(record.email, "test@example.com");
    assert.equal(record.signature, "Test User");
    assert.equal(record.version, "2");
    assert.equal(dialog.isTrellisLicenseWizardComplete(), true);
    assert.equal(actions.style.display, "none");
    assert.equal(timers.at(-1).delay, 2000);

    timers.at(-1).callback();
    assert.equal(actions.style.display, "");
});

test("Saved wizard records show summary, contact guidance, Change license, and delayed actions", () => {
    const savedRecord = {
        path: "unsure",
        contactGuidance: true,
        name: "Saved User",
        email: "saved@example.com",
        signature: "Saved User",
        oathCompletedAt: "2026-07-03T00:00:00.000Z",
        version: "2"
    };
    const { dom, dialog, timers } = loadSplashDialog({ savedRecord });
    const actions = dialog.container.querySelector(".trellis-splash-actions");

    assert.match(dialog.container.textContent, /Saved license path/);
    assert.match(dialog.container.textContent, /Placeholder Contact Name/);
    assert.equal(dialog.isTrellisLicenseWizardComplete(), true);
    assert.equal(actions.style.display, "none");
    assert.equal(timers[0].delay, 2000);

    timers[0].callback();
    assert.equal(actions.style.display, "");

    findButton(dialog.container, "Change license").click();
    assert.equal(dom.window.localStorage.getItem(wizardStorageKey), null);
    assert.match(dialog.container.textContent, /Choose your path/);
    assert.equal(actions.style.display, "none");
    assert.equal(dialog.isTrellisLicenseWizardComplete(), false);
});

test("SplashDialog ignores old v1 license acknowledgements", () => {
    const { dialog, timers } = loadSplashDialog({ oldChoice: "community" });

    assert.match(dialog.container.textContent, /Choose your path/);
    assert.equal(dialog.container.querySelector(".trellis-splash-actions").style.display, "none");
    assert.equal(dialog.isTrellisLicenseWizardComplete(), false);
    assert.equal(timers.length, 0);
});

test("SplashDialog source and bundle use oath wizard storage, close hook, and expanded dimensions", () => {
    const appSource = fs.readFileSync(appPath, "utf8");
    const bundledSource = fs.readFileSync(bundledPath, "utf8");
    const dialogSource = fs.readFileSync(dialogsPath, "utf8");

    assert.match(dialogSource, /trellis\.licenseWizard\.v/);
    assert.match(dialogSource, /isTrellisLicenseWizardComplete/);
    assert.match(dialogSource, /I Affirm the Oath/);
    assert.match(appSource, /showDialog\(dlg\.container, 760, 720/);
    assert.match(appSource, /showTrellisExitMessage/);
    assert.match(bundledSource, /trellis\.licenseWizard\.v/);
    assert.match(bundledSource, /isTrellisLicenseWizardComplete/);
    assert.match(bundledSource, /showDialog\(p\.container,760,720/);
});
