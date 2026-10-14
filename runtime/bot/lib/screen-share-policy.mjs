// A recorder can receive a participant's shared screen, but cannot publish its
// own desktop. Install before page scripts in every browser frame. Camera and
// microphone APIs retain their original descriptors and implementations.
export const SCREEN_SHARE_POLICY_AUDIT_KEY = 'AiXenix.notetaker.screenSharePolicy';

function installNoOutgoingScreenShare() {
  const key = Symbol.for('AiXenix.notetaker.screenSharePolicy');
  let audit = globalThis[key];
  if (!audit) {
    audit = { version: 1, installed: false, blockedCalls: 0, status: 'unsupported' };
    Object.defineProperty(globalThis, key, { value: audit, enumerable: false });
  }
  const devices = globalThis.navigator?.mediaDevices;
  if (!devices) return;
  let owner = devices;
  let descriptor;
  while (owner && !(descriptor = Object.getOwnPropertyDescriptor(owner, 'getDisplayMedia'))) {
    owner = Object.getPrototypeOf(owner);
  }
  if (!descriptor) return;
  const current = devices.getDisplayMedia;
  if (typeof current !== 'function') return;
  if (current === audit.guard) return;

  function getDisplayMedia() {
    audit.blockedCalls += 1;
    const message = 'This recording bot does not publish its screen.';
    const error = typeof DOMException === 'function'
      ? new DOMException(message, 'NotAllowedError')
      : Object.assign(new Error(message), { name: 'NotAllowedError' });
    return Promise.reject(error);
  }
  // Preserve capability detection and normal function metadata. The original
  // native function is never retained on a readable audit property or called.
  for (const property of ['name', 'length']) {
    const meta = Object.getOwnPropertyDescriptor(current, property);
    if (meta) Object.defineProperty(getDisplayMedia, property, meta);
  }
  const replacement = 'value' in descriptor
    ? { ...descriptor, value: getDisplayMedia }
    : { ...descriptor, get() { return getDisplayMedia; } };
  audit.installed = false;
  try {
    Object.defineProperty(owner, 'getDisplayMedia', replacement);
  } catch {
    // A platform with a locked implementation cannot satisfy the recorder
    // policy. Do not silently claim installation or expose a working fallback.
    audit.status = 'installation_failed';
    throw new Error('Recording bot screen-share policy could not be installed.');
  }
  Object.defineProperty(audit, 'guard', { value: getDisplayMedia, configurable: true });
  audit.installed = true;
  audit.status = 'blocked';
}

export const NO_OUTGOING_SCREEN_SHARE_SCRIPT = `(${installNoOutgoingScreenShare.toString()})();`;
