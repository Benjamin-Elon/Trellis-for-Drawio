import assert from 'node:assert/strict';
import test from 'node:test';
import {
	bumpVersion,
	formatTag,
	isExpectedRemote,
	isValidReleaseVersion,
	normalizeRemoteUrl,
	parseArgs,
} from '../scripts/release-prepare.mjs';

test('validates Trellis release semver strings', () => {
	assert.equal(isValidReleaseVersion('1.0.0'), true);
	assert.equal(isValidReleaseVersion('1.0.0-rc.1'), true);
	assert.equal(isValidReleaseVersion('29.0.3-trellis.1'), true);

	assert.equal(isValidReleaseVersion('v1.0.0'), false);
	assert.equal(isValidReleaseVersion('1.0'), false);
	assert.equal(isValidReleaseVersion('1'), false);
	assert.equal(isValidReleaseVersion('1.0.0-'), false);
});

test('formats release tags from exact versions', () => {
	assert.equal(formatTag('1.0.0'), 'v1.0.0');
	assert.equal(formatTag('1.0.0-rc.1'), 'v1.0.0-rc.1');
	assert.throws(() => formatTag('v1.0.0'), /Invalid release version/);
});

test('computes stable version bumps', () => {
	assert.equal(bumpVersion('1.2.3', 'patch'), '1.2.4');
	assert.equal(bumpVersion('1.2.3', 'minor'), '1.3.0');
	assert.equal(bumpVersion('1.2.3', 'major'), '2.0.0');
	assert.equal(bumpVersion('1.2.3-rc.1', 'patch'), '1.2.4');
	assert.throws(() => bumpVersion('1.2.3', 'rc'), /Unsupported bump/);
});

test('parses release CLI arguments', () => {
	assert.deepEqual(parseArgs(['--dry-run', '1.0.0-rc.1']), {
		dryRun: true,
		help: false,
		bump: null,
		exactVersion: '1.0.0-rc.1',
	});
	assert.deepEqual(parseArgs(['--bump=patch']), {
		dryRun: false,
		help: false,
		bump: 'patch',
		exactVersion: null,
	});
	assert.throws(() => parseArgs(['1.0.0', '--bump', 'patch']), /either an exact version or --bump/);
	assert.throws(() => parseArgs(['--bump', 'rc']), /Unsupported bump/);
	assert.throws(() => parseArgs(['1.0.0', '1.0.1']), /Unexpected argument/);
});

test('normalizes supported GitHub remotes', () => {
	assert.equal(
		normalizeRemoteUrl('git+https://github.com/Benjamin-Elon/Trellis-for-Drawio.git'),
		'github.com/benjamin-elon/trellis-for-drawio',
	);
	assert.equal(
		normalizeRemoteUrl('git@github.com:Benjamin-Elon/Trellis-for-Drawio.git'),
		'github.com/benjamin-elon/trellis-for-drawio',
	);
	assert.equal(isExpectedRemote('https://github.com/Benjamin-Elon/Trellis-for-Drawio.git'), true);
	assert.equal(isExpectedRemote('https://github.com/jgraph/drawio-desktop.git'), false);
});
