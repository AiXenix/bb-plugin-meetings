// Account sessions stay in platform profiles; meeting workers copy them into
// their own disposable profile and never clear an authenticated session.
export const ACCOUNT_LABELS = Object.freeze({ zoom: "Zoom", meet: "Google Meet", telemost: "Яндекс Телемост", jitsi: "Jitsi Meet" });
export const LOGIN_URLS = Object.freeze({
  zoom: "https://zoom.us/signin",
  meet: "https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fmeet.google.com%2F",
  telemost: "https://passport.yandex.ru/auth?retpath=https%3A%2F%2Ftelemost.yandex.ru%2F",
});

export function profileFor(config) {
  return config.browserProfileDir || (config.platform === "zoom" || config.platform === "mock" ? config.zoomProfileDir : null) || null;
}

export function sessionReady(platform, currentUrl, cookies) {
  let url;
  try { url = new URL(currentUrl); } catch { return false; }
  if (!Array.isArray(cookies)) return false;
  const names = new Set(cookies.filter(cookie => cookie.value && (cookie.expires === undefined || cookie.expires === -1 || cookie.expires * 1000 > Date.now())).map(cookie => cookie.name));
  if (platform === "zoom") {
    return /(^|\.)zoom\.(us|com)$/i.test(url.hostname)
      && !/^\/(signin|signup|login|oauth|saml|google_oauth|apple_oauth|facebook_oauth|sso)(?:\/|$)/i.test(url.pathname)
      && ["zm_aid", "_zm_ssid", "zm_haid"].some(name => names.has(name));
  }
  if (platform === "meet") {
    return url.hostname === "meet.google.com" && ["SID", "__Secure-1PSID", "__Secure-3PSID"].some(name => names.has(name));
  }
  if (platform === "telemost") {
    return /^telemost\.(?:360\.)?yandex\.(?:ru|com|com\.tr|kz|by|uz)$/i.test(url.hostname)
      && ["Session_id", "sessionid2"].some(name => names.has(name));
  }
  return false;
}
