// Init script: keep Zoom pages from handing off to the desktop app. A
// zoommtg:// launch makes Chrome show a native "Open xdg-open?" dialog that
// silently swallows every trusted input event (docs/dev/research-zoom-probe.md).
// location.href assignments cannot be intercepted here; the bot also blocks the
// schemes in the profile and dismisses the dialog with xdotool as a fallback.
(() => {
  const KEY = Symbol.for("mtg.schemeGuard");
  if (window[KEY]) return;
  Object.defineProperty(window, KEY, { value: true, enumerable: false });
  const BLOCKED = /^\s*(zoommtg|zoomus|zoomusm):/i;
  const blocked = (value) => {
    try {
      return BLOCKED.test(String(value instanceof URL ? value.href : value ?? ""));
    } catch {
      return false;
    }
  };

  const originalOpen = window.open;
  window.open = function open(url, ...rest) {
    if (blocked(url)) return null;
    return originalOpen.call(this, url, ...rest);
  };

  const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "src");
  if (srcDescriptor && srcDescriptor.set) {
    Object.defineProperty(HTMLIFrameElement.prototype, "src", {
      ...srcDescriptor,
      set(value) {
        if (blocked(value)) return;
        srcDescriptor.set.call(this, value);
      },
    });
  }

  const originalSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function setAttribute(name, value) {
    if (this instanceof HTMLIFrameElement && String(name).toLowerCase() === "src" && blocked(value)) return undefined;
    return originalSetAttribute.call(this, name, value);
  };

  const originalClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function click() {
    if (blocked(this.getAttribute("href"))) return undefined;
    return originalClick.call(this);
  };

  document.addEventListener(
    "click",
    (event) => {
      const anchor = event.target && event.target.closest ? event.target.closest("a[href]") : null;
      if (anchor && blocked(anchor.getAttribute("href"))) event.preventDefault();
    },
    true,
  );
})();
