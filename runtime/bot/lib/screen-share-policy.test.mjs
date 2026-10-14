import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { NO_OUTGOING_SCREEN_SHARE_SCRIPT, SCREEN_SHARE_POLICY_AUDIT_KEY } from './screen-share-policy.mjs';

function realm({ inherited = true, accessor = false } = {}) {
  const context = vm.createContext({ DOMException });
  vm.runInContext(`
    globalThis.nativeCalls = 0;
    globalThis.userMediaCalls = 0;
    globalThis.cameraStream = {kind: 'camera-and-microphone', getTracks() { return ['camera', 'microphone']; }};
    globalThis.remoteStream = {kind: 'participant-shared-screen', getTracks() { return ['remote-screen']; }};
    globalThis.nativeDisplay = function getDisplayMedia(constraints) { nativeCalls++; return Promise.resolve({kind: 'own-screen'}); };
    globalThis.nativeUserMedia = function getUserMedia(constraints) { userMediaCalls++; return Promise.resolve(cameraStream); };
    globalThis.owner = ${inherited ? '{}' : 'Object.create(null)'};
    Object.defineProperty(owner, 'getDisplayMedia', {
      ${accessor ? 'get() { return nativeDisplay; },' : 'value: nativeDisplay, writable: true,'}
      configurable: true, enumerable: true
    });
    Object.defineProperty(owner, 'getUserMedia', {value: nativeUserMedia, configurable: true, enumerable: true, writable: true});
    globalThis.devices = ${inherited ? 'Object.create(owner)' : 'owner'};
    globalThis.navigator = Object.create({mediaDevices: devices});
    globalThis.beforeDescriptor = Object.getOwnPropertyDescriptor(owner, 'getDisplayMedia');
  `, context);
  return context;
}

function install(context) { vm.runInContext(NO_OUTGOING_SCREEN_SHARE_SCRIPT, context); }
function audit(context) { return vm.runInContext(`globalThis[Symbol.for(${JSON.stringify(SCREEN_SHARE_POLICY_AUDIT_KEY)})]`, context); }

test('inherited API stays discoverable with its descriptor and function metadata', async () => {
  const context = realm();
  install(context);
  assert.equal(vm.runInContext(`'mediaDevices' in navigator && 'getDisplayMedia' in navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function'`, context), true);
  assert.equal(vm.runInContext(`Object.hasOwn(navigator, 'mediaDevices') || Object.hasOwn(devices, 'getDisplayMedia')`, context), false);
  assert.equal(vm.runInContext(`devices.getDisplayMedia.name`, context), 'getDisplayMedia');
  assert.equal(vm.runInContext(`devices.getDisplayMedia.length`, context), 1);
  const before = vm.runInContext('beforeDescriptor', context);
  const after = vm.runInContext(`Object.getOwnPropertyDescriptor(owner, 'getDisplayMedia')`, context);
  for (const property of ['enumerable', 'configurable', 'writable']) assert.equal(after[property], before[property]);
  assert.notEqual(after.value, before.value);
  assert.equal(audit(context).installed, true);
  assert.equal(vm.runInContext(`Object.getOwnPropertyDescriptor(globalThis, Symbol.for(${JSON.stringify(SCREEN_SHARE_POLICY_AUDIT_KEY)})).enumerable`, context), false);
});

test('every attempted capture rejects asynchronously without reading constraints or calling native', async () => {
  const context = realm();
  install(context);
  const attempt = vm.runInContext(`navigator.mediaDevices.getDisplayMedia(Object.defineProperty({}, 'video', {get() { throw new Error('must not inspect screen constraints'); }}))`, context);
  assert.equal(typeof attempt.then, 'function');
  await assert.rejects(attempt, error => error instanceof DOMException && error.name === 'NotAllowedError');
  await assert.rejects(vm.runInContext('devices.getDisplayMedia.call(null)', context), { name: 'NotAllowedError' });
  assert.equal(vm.runInContext('nativeCalls', context), 0);
  assert.equal(audit(context).blockedCalls, 2);
});

test('getUserMedia, camera, microphone and received remote streams are untouched', async () => {
  const context = realm();
  install(context);
  assert.equal(vm.runInContext('devices.getUserMedia === nativeUserMedia', context), true);
  const stream = await vm.runInContext('navigator.mediaDevices.getUserMedia({video: true, audio: true})', context);
  assert.equal(stream, vm.runInContext('cameraStream', context));
  assert.equal(vm.runInContext('userMediaCalls', context), 1);
  assert.equal(vm.runInContext('remoteStream.kind', context), 'participant-shared-screen');
  assert.equal(vm.runInContext('remoteStream.getTracks()[0]', context), 'remote-screen');
});

test('repeated initialization preserves the same guard and accumulated audit', async () => {
  const context = realm();
  install(context);
  const first = vm.runInContext('devices.getDisplayMedia', context);
  await assert.rejects(vm.runInContext('devices.getDisplayMedia()', context), { name: 'NotAllowedError' });
  install(context);
  assert.equal(vm.runInContext('devices.getDisplayMedia', context), first);
  assert.equal(audit(context).blockedCalls, 1);
  assert.equal(vm.runInContext('nativeCalls', context), 0);
});

test('reinstallation after an API replacement blocks it and retains audit counts', async () => {
  const context = realm();
  install(context);
  await assert.rejects(vm.runInContext('devices.getDisplayMedia()', context), { name: 'NotAllowedError' });
  vm.runInContext('owner.getDisplayMedia = nativeDisplay;', context);
  install(context);
  await assert.rejects(vm.runInContext('devices.getDisplayMedia()', context), { name: 'NotAllowedError' });
  assert.equal(audit(context).blockedCalls, 2);
  assert.equal(audit(context).installed, true);
  assert.equal(vm.runInContext('nativeCalls', context), 0);
});

test('absent navigator, mediaDevices or display capability adds no fake API', () => {
  for (const setup of ['', 'globalThis.navigator = {};', 'globalThis.navigator = {mediaDevices: {getUserMedia() {}}};']) {
    const context = vm.createContext({ DOMException });
    vm.runInContext(setup, context);
    install(context);
    install(context);
    assert.equal(audit(context).installed, false);
    assert.equal(audit(context).blockedCalls, 0);
    assert.equal(vm.runInContext('typeof globalThis.navigator?.mediaDevices?.getDisplayMedia', context), 'undefined');
  }
});

test('separate top-level and iframe realms both block without sharing counters', async () => {
  const top = realm();
  const iframe = realm({ inherited: false });
  install(top);
  install(iframe);
  for (const context of [top, iframe]) {
    await assert.rejects(vm.runInContext('navigator.mediaDevices.getDisplayMedia({video: true})', context), { name: 'NotAllowedError' });
    assert.equal(vm.runInContext('nativeCalls', context), 0);
    assert.equal(audit(context).blockedCalls, 1);
  }
  await assert.rejects(vm.runInContext('devices.getDisplayMedia()', top), { name: 'NotAllowedError' });
  assert.equal(audit(top).blockedCalls, 2);
  assert.equal(audit(iframe).blockedCalls, 1);
});

test('accessor capability retains descriptor flags and getUserMedia', async () => {
  const context = realm({ accessor: true });
  install(context);
  const after = vm.runInContext(`Object.getOwnPropertyDescriptor(owner, 'getDisplayMedia')`, context);
  assert.equal(after.enumerable, true);
  assert.equal(after.configurable, true);
  assert.equal('value' in after, false);
  assert.equal(vm.runInContext('devices.getUserMedia === nativeUserMedia', context), true);
  await assert.rejects(vm.runInContext('devices.getDisplayMedia()', context), { name: 'NotAllowedError' });
  assert.equal(vm.runInContext('nativeCalls', context), 0);
});

test('a locked implementation never produces a false installed report', () => {
  const context = realm({ inherited: false });
  vm.runInContext(`Object.defineProperty(owner, 'getDisplayMedia', {writable: false, configurable: false});`, context);
  assert.throws(() => install(context), /could not be installed/);
  assert.equal(audit(context).installed, false);
  assert.equal(audit(context).status, 'installation_failed');
  assert.equal(vm.runInContext('nativeCalls', context), 0);
});
