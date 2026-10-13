## setupNotes

Everything is in /tmp/zoom-probe. Main helper: probe.js (launch, dump and settle helpers; it also runs the three initial URLs). Follow-up scripts are probe2.js to probe13.js, plus clicktest.js and devtest.js. playwright-core version is 1.64.0. Chrome is 155.0.8059.39, launched from /usr/bin/google-chrome-stable.

Launch details:
- Xvfb :97 -screen 0 1280x720x24 -nolisten tcp.
- No pulseaudio was running, so I started one with `pulseaudio --start --exit-idle-time=-1` (PID 94493). I left it running because it was not on the cleanup list.
- `pactl load-module module-null-sink sink_name=probe_sink` returned module index 19.
- Chrome was launched exactly as specified: chromium.launch({executablePath, headless:false, ignoreDefaultArgs:['--enable-automation'], args:[--lang=en-US, --disable-blink-features=AutomationControlled, --use-fake-ui-for-media-stream, --autoplay-policy=no-user-gesture-required, --no-first-run, --no-default-browser-check, --window-size=1280,720]}), with env PULSE_SINK=probe_sink. The context used locale 'en-US' and viewport null.
- Result: innerWidth x innerHeight = 1279x632, outer 1279x719. The window sits at screenX/screenY 10,10, so its bottom 9px is off the 720px screen. Adding --window-position=0,0 would fix this.

navigator checks (on an https page):
- navigator.webdriver = false.
- UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36".
- userAgentData brands: Google Chrome 155, Chromium 155, "Not(A:Brand" 24. Platform "Linux", mobile false. Full version 155.0.8059.39.
- languages ["en-US"], plugins.length 5, window.chrome is an object, hardwareConcurrency 10.
- On about:blank, userAgentData was null because it is not a secure context.

Problems found:
1. On zoom.us/j/<id>, the page automatically tries to open the zoommtg:// app link. Chrome then shows a native "Open xdg-open?" dialog ("https://zoom.us wants to open this application", buttons Cancel and "Open xdg-open", with an "Always allow zoom.us..." checkbox). This dialog is part of Chrome itself, not the page. It does not appear in page.screenshot(), but it does appear in an X capture (ffmpeg -f x11grab). While it is open, every trusted CDP mouse and keyboard event is silently dropped. page.click() reports success but nothing happens, and a window-level listener records no clicks. Running `xdotool key Escape` (xdotool is at /usr/bin/xdotool) cancels it and input works again. JS el.click() still works while the dialog is open. Also, on /j/ pages, page.waitForURL with the default waitUntil 'load' timed out, while waitUntil 'commit' worked. The simplest fix is to skip zoom.us/j and open https://app.zoom.us/wc/<id>/join?pwd=<pwd> directly.
2. No microphone with only the null sink. Chrome ignores PulseAudio monitor sources, so getUserMedia({audio}) fails with NotFoundError. Zoom then shows "Your browser is preventing access to your microphone..." on the pre-join screen and "Cannot detect your microphone..." in the meeting. Adding `pactl load-module module-remap-source master=probe_sink.monitor source_name=probe_mic` gives Chrome an audio input ("Remapped Monitor of Null Output"). With it, Zoom joined computer audio automatically: the footer button had aria-label "mute my microphone" and text "Mute". I loaded this module only temporarily (indexes 20, 21, 22) and unloaded it each time.
3. No camera: video getUserMedia fails with NotFoundError, because --use-fake-device-for-media-stream was not set and there is no v4l2loopback device. Zoom shows "Enable camera access in your browser's address bar and refresh the page." on pre-join and "Cannot detect your camera, please check the device and connection and try again." in the meeting.

Invalid meeting id: there is no pre-join screen at all. Zoom's server returns the error page directly ("This meeting link is invalid (3,001)"), so step 4 (type a name, click Join) cannot be done with 84512345678. To get real pre-join and in-meeting DOM, I used Zoom's own public test meeting. I opened https://zoom.us/test, clicked a#btnJoinTest, and it went to https://zoom.us/j/<11-digit id>?pwd=<pwd>; each click creates a new meeting id. I then opened the web client and joined as "Probe Bot". Joining worked. The Leave flow was not captured: clicking button[aria-label="Leave"] produced no visible confirmation within 6s.

Cleanup:
- All browsers closed in finally blocks; no Chrome processes remain.
- Xvfb :97 killed. Avoid `pkill -f 'Xvfb :97'`: it also matched the calling shell, which exited with code 144, though Xvfb did die.
- Null sink module 19 unloaded. PulseAudio then created its own auto_null "Dummy Output" sink (module 23); that is PulseAudio's doing, not mine.

## pageStructure

The structure depends on the URL:

A) https://app.zoom.us/wc/<id>/join?fromPWA=1 (and every "Join from browser" redirect, which adds fromPWA=1). This is a page wrapper with the actual client in an iframe:
- Top frame: origin https://app.zoom.us, title "Zoom". It contains only button.pwa-webclient__back ("Back") and <iframe id="webclient" name="webclient" class="pwa-webclient__iframe" role="presentation" src="https://app.zoom.us/wc/<id>/join?...&from=pwa">, plus many hidden input#gtm_* tracking fields (for example gtm_pageName=pwa, gtm_userCountry=DE).
- Inside the iframe the URL is https://app.zoom.us/wc/<id>/join?...&from=pwa, and for valid meetings also &wpk=wcpk{0}&&&&wcpk<hex>. pwd is removed from the iframe URL and exchanged for wpk.
- Everything else lives inside frame name="webclient": the pre-join form, the error page, the in-meeting UI, the cookie banner, and two Google reCAPTCHA Enterprise frames. Those are invisible, frame name "a-<random>", src https://www.google.com/recaptcha/enterprise/anchor?ar=1&k=6Lf2C54aAAAAAOOpnJT1sg39rowHN362Zj2QSyls&...&size=invisible.
- In the meeting, the iframe also gets iframe#WHITEBOARD_DASHBOARD.whiteboard-dashboard-iframe (name WHITEBOARD_DASHBOARD, src https://app.zoom.us/wb/embed/dashboard?clientType=pwa&...).
- The iframe title is "Zoom meeting on web" on pre-join, then "Test Zoom Meeting" (the meeting topic) once joined, or "Error - Zoom" on the error page.

B) https://app.zoom.us/wc/join/<id> and https://app.zoom.us/wc/<id>/join without fromPWA. There is no iframe. Server redirect: /wc/join/<id> goes to /wc/<id>/join?_x_zm_rtaid=...&_x_zm_rhtaid=... For a valid meeting it becomes /wc/<id>/join?wpk=...&_x_zm_rtaid=... with pwd removed. #input-for-name and button.preview-join-button are in the top frame (checked on the test meeting). There is no Back button, and the title is "Zoom meeting on web". For an invalid id this URL renders the full zoom.us site header and footer around the error.

C) https://zoom.us/j/<id> redirects to the same URL with #success. Title "Join from Zoom Workplace app - Zoom". There is a single top frame plus an about:blank iframe; no iframe holds the meeting. It always triggers the native "Open xdg-open?" dialog. Clicking "Join from browser" goes to https://app.zoom.us/wc/join/<id>?ref_from=launch&fromPWA=1[&pwd=..]&_x_zm_rtaid=..., then /wc/<id>/join?ref_from=launch&...&fromPWA=1, which is layout A with iframe#webclient. No popup or new tab opens.

D) https://zoom.us/test: top frame only. a#btnJoinTest goes to zoom.us/j/<testid>?pwd=<pwd>, which is layout C.

Server-reported web client build: SB.version '26.9.68541'; input#cdn_path value https://st1.zoom.us/web_client/7.2.0.2.12855.

## observedSelectors

COOKIE BANNER (OneTrust; same ids on zoom.us, the invalid-id error page and zoom.us/test). Container: div.ot-sdk-container[role=alertdialog][aria-label=Privacy] inside #onetrust-banner-sdk (class "otCenterRounded default ot-wo-title vertical-align-content ot-buttons-fw").
- Buttons: button#onetrust-reject-all-handler "Decline Cookies" (shown uppercase), button#onetrust-accept-btn-handler "Accept Cookies", button#onetrust-pc-btn-handler.cookie-setting-link "COOKIES SETTINGS", button.onetrust-close-btn-handler.onetrust-close-btn-ui.banner-close-button.ot-close-icon[aria-label=Close].
- Hidden preference center: div#onetrust-pc-sdk.otPcCenter.ot-hide[role=alertdialog][aria-label="Cookie Preference Center"], with button#accept-recommended-btn-handler and button.save-preference-btn-handler "Confirm My Choices".
- Declining sets cookies OptanonAlertBoxClosed and OptanonConsent. Declining on zoom.us also suppressed the banner on app.zoom.us.
- Where it appears: in a fresh context it was shown inside iframe#webclient on the invalid-id error page. It did NOT appear on the valid pre-join screen (fresh context, waited 11s). There were no separate terms dialogs; terms are only inline text.

zoom.us/j/<id> LAUNCH PAGE:
- button.zoom-button.zoom-button--lg.zoom-button--primary.g7nkJFrV.zoom-popover__trigger "Join from Zoom Workplace app"
- button.zoom-button.zoom-button--lg.zoom-button--secondary.g7nkJFrV "Join from browser". This is a button, not a link; g7nkJFrV is a hashed class. Use text matching.
- a[role=button] "Download Now"
- div.zoom-popover[role=dialog][aria-label="Did not open Zoom Workplace app?"], with close button.zoom-button.zoom-button--md.zoom-button--tertiary.zoom-button__icon.zoom-button--tertiary-icon.zoom-popover--closable[aria-label="Close this popover"]
- div.livesdk__invitation[role=button][aria-label="Open chat dialog"] (support chat bubble)
- Native Chrome dialog, NOT in the DOM: "Open xdg-open?" with Cancel / "Open xdg-open".

zoom.us/test: a#btnJoinTest.btn.btn-primary.submit.join.user[role=button][href="javascript:;"] "Join".

PRE-JOIN (inside iframe#webclient when fromPWA=1, otherwise top frame). Root is div.preview-root[role=presentation].
- button.btn-back-pwa "Back" (PWA only)
- div.preview-new-flow.preview > div.preview-new-flow-content
- Video preview: div#preview-av-video.preview-video.preview-video-resizable
- Device error banner: div.preview-error.preview-video__error > span.preview-error-text. Texts seen: "Your browser is preventing access to your microphone. Learn how to allow access to your microphone." and "Enable camera access in your browser's address bar and refresh the page.Learn more".
- Mic: button#preview-audio-control-button.preview-video__control-button[aria-label=Mute] "Mute"
- Camera: button#preview-video-control-button.preview-video__control-button[aria-label="Stop Video"] "Stop Video"
- button.preview__toggle[aria-label="More video controls"]
- Form: div.preview-meeting-info > div.preview-meeting-info__title "Enter Meeting Info"; label.preview-meeting-info__field-title[for=input-for-name] "Your Name"
- Name input: input#input-for-name[type=text][autocomplete=off][required][maxlength=128][aria-describedby=error-for-name]. It has no placeholder, aria-label or name attribute.
- Hidden reCAPTCHA: div.CaptchaContainer > div#invisibleGRecaptchaEle > div.grecaptcha-badge (visibility hidden) > iframe[title=reCAPTCHA], plus textarea#g-recaptcha-response.g-recaptcha-response
- div.zm-checkbox.preview-remember-name[role=checkbox][aria-checked=false] "Remember my name for future meetings"
- Join button: button[type=button].zm-btn.preview-join-button. While the name is empty it also has classes disabled and zm-btn--disabled and tabindex=-1, i.e. class "zm-btn preview-join-button disabled zm-btn__outline--blue zm-btn--disabled". After typing it is "zm-btn preview-join-button zm-btn__outline--blue". Contains span.loading.
- div.preview-agreement with a.wc-link2 "Terms of Service" and "Privacy Statement"; div.recaptcha_tos.
- Both typing (pressSequentially) and locator.fill() enabled the Join button.

IN MEETING (about 2s after Join; iframe title becomes the meeting topic). Root ids: #root, #meeting-app, #wc-content, #wc-container-left, #wc-container-right, #sharee-container, #video-share-layout.
- Header: button#meeting-info-indication.meeting-info-icon__button-wrap[aria-label="Meeting information"] (text = topic, e.g. "Test Zoom Meeting"); button#meeting-info-encryption-indication[aria-label="Encryption information"]; button.switch-to-native-button[aria-label="Switch to Zoom Workplace Client"]; button.full-screen-widget__button[aria-label=View].
- Footer: footer#wc-footer.footer.main-footer.footer--desktop-layout.footer__hidable. It auto-hides (adds footer__hidden). While hidden, Playwright reported the Leave button "outside of the viewport". Footer bar is div#foot-bar.footer__inner.
- Audio button: button.footer-button-base__button.join-audio-container__btn. Its aria-label is "audio" with text "Audio" (shown as "Join Audio" at first) when there is no mic. With a mic it is aria-label "mute my microphone", text "Mute".
- #audioOptionMenu button[aria-label="More audio controls"]
- Video: button.send-video-container__btn[aria-label=Video] (has send-video-container--disabled and is disabled before the camera check); #videoOptionMenu
- Participants: button.footer-button__button[aria-label="open the participants list pane,[1] particpants"] (Zoom's own typo "particpants"), text "1 Participants"; button.footer-participants-button__toggle-button[aria-label="Participants Settings"]
- Chat: button[aria-label="open the chat panel"] "Chat"; button.footer-chat-button__settings-toggle-button[aria-label="Chat Settings"]
- button[aria-label=React]; button.sharing-entry-button-container[aria-label=Share]
- More: button.more-button__dropdown-toggle.dropdown-toggle[aria-label="More meeting control "] (note the trailing space)
- Leave: button.footer-button-base__button.footer-button__button[aria-label=Leave] "Leave"
- Toasts: #notificationManager.notification-manager > div.notification-message-wrap > span.notification-message-wrap__txt; close is i.notification-message-wrap__close[role=button][aria-label=close]. Texts: "For a better meeting experience, enable the option 'Use graphics/hardware acceleration' under browser system settings.", "Cannot detect your microphone, please check the device and connection and try again.", "Cannot detect your camera, ...".
- "Introducing My Notes" popover with button.zm-btn.zm-btn--primary "Got it".
- Test meetings only: modal div.test-meeting-modal-inner, close button.test-meeting-close[aria-label=close], title div.step-title "Do you see yourself?", react-select input#react-select-2-input, buttons zmu-btn "No, Try Another Camera" and zmu-btn--primary "Yes".
- Also present: div.sharer-controlbar-container__main-area[role=dialog] (hidden sharing bar) and a hidden ReactModal "Whiteboard dashboard".

## errorScreens

For an invalid meeting id (84512345678), Zoom's server renders the error page immediately. No pre-join, name input or Join button is ever shown, so there was nothing to type into or click. The same result came from all three entry points:
- app.zoom.us/wc/84512345678/join?fromPWA=1: error inside iframe#webclient.
- app.zoom.us/wc/join/84512345678: redirects to /wc/84512345678/join?_x_zm_rtaid=..., error in the top frame with the full zoom.us site header and footer.
- zoom.us/j/84512345678, then "Join from browser": goes to /wc/84512345678/join?ref_from=launch&...&fromPWA=1, error inside iframe#webclient.

Error DOM, in the webclient frame or top frame; document.title is "Error - Zoom":
<div id="content" class="main-content"><div id="notice-slot"></div><div class="mini-layout" id="global-error"><div class="mini-layout-body"><div class="page-header"></div><div class="box"><span class="error-message">This meeting link is invalid (3,001)</span></div></div></div></div>

Suggested selector: #global-error .error-message. Its exact text is "This meeting link is invalid (3,001)"; the raw HTML has line breaks between "invalid" and "(3,001)", so normalize whitespace before matching. The same page also has hidden leftovers such as button#scheduleMtg "Start a New Meeting" and div#video_dialog[role=alertdialog]. In the PWA layout the top frame shows only button.pwa-webclient__back "Back".

On the valid test meeting, clicking Join made no navigation; the in-meeting UI rendered in the same frame within about 2s (footer#wc-footer attached). There was no waiting room and no passcode prompt (pwd was in the URL). There was no error text, only the device toasts listed in observedSelectors.

## captchaOrBlock

I saw no visible captcha, sign-in wall or bot block in any run. Zoom loads invisible Google reCAPTCHA Enterprise (site key 6Lf2C54aAAAAAOOpnJT1sg39rowHN362Zj2QSyls, size=invisible, badge hidden) on the pre-join screen, and the "Zoom is protected by reCAPTCHA" notice is shown. No challenge frame (recaptcha bframe) ever appeared. Four joins as "Probe Bot" into Zoom test meetings, from this German IP (gtm_userCountry=DE), went straight into the meeting with no sign-in prompt. The flags gave navigator.webdriver=false.

The only real blocker is the native "Open xdg-open?" dialog on zoom.us/j pages. It silently blocks all trusted input to the tab until it is dismissed (xdotool key Escape) or avoided by opening app.zoom.us/wc/... directly.

## artifacts

```json
[
  "/tmp/zoom-probe/probe.js",
  "/tmp/zoom-probe/probe7.js",
  "/tmp/zoom-probe/probe10.js",
  "/tmp/zoom-probe/probe11.js",
  "/tmp/zoom-probe/probe13.js",
  "/tmp/zoom-probe/devtest.js",
  "/tmp/zoom-probe/out/probe.log",
  "/tmp/zoom-probe/out/navigator.json",
  "/tmp/zoom-probe/out/navigator_https.json",
  "/tmp/zoom-probe/out/wc_pwa_01_initial.json",
  "/tmp/zoom-probe/out/wc_pwa_01_initial.png",
  "/tmp/zoom-probe/out/wc_pwa_01_initial.frame-webclient.html",
  "/tmp/zoom-probe/out/wc_join_01_initial.json",
  "/tmp/zoom-probe/out/wc_join_01_initial.png",
  "/tmp/zoom-probe/out/zoom_j_01_initial.json",
  "/tmp/zoom-probe/out/zoom_j_01_initial.png",
  "/tmp/zoom-probe/out/X_zoom_j_display.png",
  "/tmp/zoom-probe/out/zoom_j_07_after_join_from_browser.json",
  "/tmp/zoom-probe/out/zoom_j_07_after_join_from_browser.frame-webclient.html",
  "/tmp/zoom-probe/out/X_zoom_j_after_join_from_browser_settled.png",
  "/tmp/zoom-probe/out/test_01_initial.json",
  "/tmp/zoom-probe/out/test_03_prejoin.json",
  "/tmp/zoom-probe/out/X_test_03_prejoin.png",
  "/tmp/zoom-probe/out/test_04_prejoin_name_typed.json",
  "/tmp/zoom-probe/out/X_test_04_name_typed.png",
  "/tmp/zoom-probe/out/prejoin_form_outer.html",
  "/tmp/zoom-probe/out/prejoin_preview_outer.html",
  "/tmp/zoom-probe/out/test_05_after_join_03s.json",
  "/tmp/zoom-probe/out/test_05_after_join_26s.json",
  "/tmp/zoom-probe/out/X_test_05_after_join_03s.png",
  "/tmp/zoom-probe/out/X_test_05_after_join_26s.png",
  "/tmp/zoom-probe/out/direct_01_prejoin_fresh.json",
  "/tmp/zoom-probe/out/X_direct_01_prejoin_fresh.png",
  "/tmp/zoom-probe/out/direct_03_in_meeting_12s.json",
  "/tmp/zoom-probe/out/X_direct_03_in_meeting_12s.png",
  "/tmp/zoom-probe/out/in_meeting_snippets.json",
  "/tmp/zoom-probe/out/camera_test_dialog_outer.json",
  "/tmp/zoom-probe/out/leave_02_leave_menu.json",
  "/tmp/zoom-probe/out/X_leave_02_leave_menu.png",
  "/tmp/zoom-probe/out/valid_nopwa_wcjoin.json",
  "/tmp/zoom-probe/out/valid_nopwa_wcjoin.png"
]
```
