const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');
const bundledFiles = [
	'drawio/src/main/webapp/js/app.min.js',
	'drawio/src/main/webapp/js/integrate.min.js',
];

function readBundledFile(fileName) {
	return fs.readFileSync(path.join(projectRoot, fileName), 'utf8');
}

test('production Electron bootstrap loads desktop hooks before App.main', () => {
	const source = readBundledFile('drawio/src/main/webapp/js/bootstrap.js');
	const electronBranch = source.substring(source.indexOf('if (mxIsElectron)'));
	const electronAppLoad = electronBranch.indexOf("mxscript('js/diagramly/ElectronApp.js'");
	const readyGate = electronBranch.indexOf('mxScriptsLoaded = true;');

	// Trellis packages app.min.js directly, so ElectronApp.js must patch desktop methods before App.main builds menus.
	assert.notEqual(electronAppLoad, -1, 'bootstrap should load ElectronApp.js in packaged Electron mode');
	assert.notEqual(readyGate, -1, 'bootstrap should still mark scripts loaded in packaged Electron mode');
	assert.ok(electronAppLoad < readyGate, 'ElectronApp.js should load before App.main can run');
});

test('bundled desktop update menu action falls back to Electron IPC', () => {
	for (const fileName of bundledFiles) {
		const source = readBundledFile(fileName);

		// Trellis ships these minified upstream files directly, so the menu action must not depend on an omitted prototype method.
		assert.match(source, /update IPC fallback/, `${fileName} should document the Trellis update fallback`);
		assert.match(source, /electron\.sendMessage\("checkForUpdates"\)/, `${fileName} should send update checks through Electron IPC`);
		assert.doesNotMatch(source, /addAction\("check4Updates",function\(\)\{[a-z]\.checkForUpdates\(\)\}\)/, `${fileName} should not call checkForUpdates without a fallback`);
	}
});
