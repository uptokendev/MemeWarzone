import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { patchCertificationSource, planCertificationPrestate } from './rh46630-native-lifecycle-runner.mjs';

test('fresh fail-closed staging prestate enables live exactly once', () => {
  assert.deepEqual(
    planCertificationPrestate({ factoryLive: false, createPaused: true, globalPaused: true }),
    {
      initialLive: false,
      enableLive: true,
      openCreateForCertification: true,
      openGlobalForCertificationCreate: true,
      restoreCreatePaused: true,
      restoreGlobalPaused: true,
      expectedFinalLive: true,
    }
  );
});

test('already-live fail-closed staging prestate skips one-way enableLive', () => {
  assert.deepEqual(
    planCertificationPrestate({ factoryLive: true, createPaused: true, globalPaused: true }),
    {
      initialLive: true,
      enableLive: false,
      openCreateForCertification: true,
      openGlobalForCertificationCreate: true,
      restoreCreatePaused: true,
      restoreGlobalPaused: true,
      expectedFinalLive: true,
    }
  );
});

test('certification rejects any initial state that is not fail closed', () => {
  assert.throws(
    () => planCertificationPrestate({ factoryLive: true, createPaused: false, globalPaused: true }),
    /FACTORY_NOT_INITIAL_CREATE_PAUSED/
  );
  assert.throws(
    () => planCertificationPrestate({ factoryLive: true, createPaused: true, globalPaused: false }),
    /FACTORY_NOT_INITIAL_GLOBAL_PAUSED/
  );
});

test('runtime patch opens only the CREATE window and restores both pause gates', () => {
  const source = fs.readFileSync(new URL('./rh46630-native-lifecycle-certification.mjs', import.meta.url), 'utf8');
  const patched = patchCertificationSource(source);

  assert.doesNotMatch(patched, /FACTORY_NOT_INITIAL_FAIL_CLOSED_LIVE_FALSE/);
  assert.match(patched, /if \(prestatePlan\.enableLive\).*factory\.enableLive\(\)/s);
  assert.match(patched, /factory\.setCreatePaused\(false\).*openCreateForCertification/s);
  assert.match(patched, /factory\.setGlobalPaused\(false\).*openGlobalForCertificationCreate/s);
  assert.match(patched, /createWindowClose=await restoreFactoryFailClosed\('closeAfterCreate'\)/);
  assert.match(patched, /factory\.setGlobalPaused\(true\)/);
  assert.match(patched, /factory\.setCreatePaused\(true\)/);
  assert.match(patched, /postState\.factoryLive===true&&postState\.createPaused&&postState\.globalPaused/);
  assert.match(patched, /await restoreFactoryFailClosed\('failureCleanup'\)/);
  assert.match(patched, /PRODUCTION_4663_FORBIDDEN/);
});
