## urlFormats

## Target URL used by bots (2026 consensus)
Most bots navigate to the React web client: **`https://app.zoom.us/wc/<MEETING_ID>/join?pwd=<PWD>`**
- Vexa `core/meetings/modules/join/src/zoom/join.ts` (`buildZoomWebClientUrl`, HEAD 2026-10-09)
- Meeting-BaaS `src/urlParser/zoomUrlParser.ts` (2026-08/09)
- ft-prince/MeetBot `zoomBot.ts` (2026-08). It says this is "Navigating straight to app.zoom.us avoids the redirect that previously raced the pre-join detection".
- meetron `zoomDirectWebClientUrl` (2026-09)
- invest-meet-bot (2026-08)
- AWS LMA uses `https://zoom.us/wc/<id>/join` (2026-08), which redirects to the same client.

## Mapping table
| Input form | What to do | Source |
|---|---|---|
| `https://zoom.us/j/<id>?pwd=<enc>`, `https://us02web.zoom.us/j/<id>?pwd=…`, `https://<tenant>.zoom.us/j/<id>` | Rewrite to `https://app.zoom.us/wc/<id>/join?pwd=<enc>`. Only do this when the host is exactly `zoom.us` or ends with `.zoom.us`; do not use a substring check. Keep `pwd` verbatim: it is an encoded passcode, often ending in `.1`. Attendee sanitizes it with `^[A-Za-z0-9]+(\.\d+)?`. Some portals send `?password=` instead (Meeting-BaaS). Strip `ref_from=launch` (invest-meet-bot: otherwise "Zoom waits for a desktop app launch postMessage"). | Vexa, Meeting-BaaS, attendee `bots/meeting_url_utils.py` (2026-10) |
| `https://app.zoom.us/wc/<id>/join?pwd=…` (React client) | Use as-is. Pre-join page has `#input-for-name` and `button.preview-join-button`. | Vexa selectors.ts |
| `https://<host>/wc/join/<id>?pwd=…` (**classic** client) | Accepted. Its pre-join page has `#inputname` (placeholder "Your Name") and `#joinBtn`. A OneTrust banner can overlay it, and a Google reCAPTCHA can gate it. Vexa notes that "Zoom redirects guest joins to the classic client for some meetings", so match both clients. recall.ai's demo builds `${host}/wc/join/${id}?${query}&prefer=1&browser=1`. joinly and screenapp (as fallback) replace `/j/` with `/wc/join/`. | Vexa (2026-10), recallai/zoom-meeting-bot `utils.js` (2025-11), joinly `zoom.py` (2026-09), screenappai `ZoomBot.ts` (2026-08) |
| `…/wc/<id>/join?fromPWA=1&pwd=…` | Loads a PWA shell; the meeting UI lives in an iframe (`.pwa-webclient__iframe` / `iframe#webclient`), so every selector must run inside the frame. openclaw always resolves `document.querySelector('#webclient')?.contentDocument \|\| document`. | meetingbot `src/bots/zoom/src/bot.ts` (2025-10), meeboter (2026-02), screenapp, openclaw (2026-10) |
| `/s/<id>` (host start link) | Parse the ID (regex `/(?:j\|s\|wc\|wc\/join)\/(\d{8,})/`) and join through `/wc/<id>/join`. A start link needs host auth. | Meeting-BaaS |
| `/w/<id>?tk=<registrant token>` (webinar / registration) | **Navigate as-is; never rewrite.** `tk` is a credential: upgrade http→https on canonical hosts. Meeting-BaaS saw 136 of 148 join failures in prod (2026-08-03) because rewriting dropped `tk` and landed on the registration wall. Zoom shows a "Launching…" page; click "Join from your browser" and wait for `**/wc/**` (lands at `app.zoom.us/wc/<id>/join?ref_from=launch&tk=…`). | Meeting-BaaS, invest-meet-bot `zoom.py` |
| Redirect to `https://<x>.zoom.us/webinar/register/<WN_…>` | Registration is required, so no name input will ever render. Treat as terminal. Match on parsed host + path. | Meeting-BaaS `parseZoomRegistrationUrl` |
| `https://events.zoom.us/ejl/…` (Zoom Events) | Use as-is; the page redirects itself to the web client. | Vexa, Meeting-BaaS |
| `zoom.com` / `*.zoom.com` | Change the host to `zoom.us` / `*.zoom.us`, then apply the rules above. | attendee `meeting_url_utils.py` |
| `zoommtg://zoom.us/join?confno=<id>&pwd=<pwd>`, `zoomus://`, `zoomusm://` | Take `confno` and `pwd` and build the `/wc/` URL. Also **block these schemes inside the browser** so the "open Zoom app" handoff never fires: recall uses `context.route('zoommtg://*', r => r.abort())`; meetron uses an init-script guard that patches `HTMLIFrameElement.src`, `setAttribute`, anchor `click` and `window.open`; screenapp uses `page.route('**/*.exe')` to swallow "Download Now". | recall, meetron (2026-09), screenapp |
| `https://zoom.us/my/<vanity>` (personal link) | None of the repos parse this. Either fetch it and follow the redirect to `/j/<id>`, or navigate as-is and use the launch-page fallback below. **Unverified.** | — |
| White-label portals (e.g. `zoom-lfx.platform.linuxfoundation.org/meeting/<id>?password=…`) | Navigate the original URL. Wait up to 5 min for the Zoom name input (a human can click through the portal over VNC). | Vexa, Meeting-BaaS |
| ZoomGov (`*.zoomgov.com`) | ft-prince treats `zoomgov.com` as Zoom. recall.ai lists Zoom Gov as unsupported (public third-party apps aren't allowed). The `/wc/` path on zoomgov is unverified. | ft-prince, docs.recall.ai |
| Bare meeting ID + passcode | Build `https://app.zoom.us/wc/<id without spaces/dashes>/join?pwd=<urlencoded passcode>`. If `#input-for-pwd` still appears, type the numeric passcode there. | invest-meet-bot `build_url_from_id` |
| `/j/` with no digits (truncated invite) | Terminal "invalid URL". Don't retry. | Meeting-BaaS |

**ID format:** 9–11 digits (openclaw regex `^\/j\/(\d{9,11})\/?$`; Meeting-BaaS uses `\d{8,}`).

**Launch-page fallback** (if you navigate `zoom.us/j/<id>` directly, or the `/wc/` URL fails):
- Buttons: "Launch Meeting", "Download Now" (`getByRole('button', {name:/Download Now/i})`).
- Link: `a:has-text("Join from your browser")`, also "Join from Your Browser", "Join from browser", or `a.wc-interactive`.
- meetron appends `#success` to the invite URL to mark the native-app step as done.
- Sources: screenapp, invest-meet-bot, meetron.

## joinFlow

Assume Chrome is started with `--lang=en-US` (Vexa and Meeting-BaaS also pass `--accept-lang=en-US,en` and a Playwright context `locale: 'en-US'`). Steps are in order. Each step lists the variants, newest first.

### 0. Context setup (before `goto`)
- **Permissions:** `context.grantPermissions(['microphone','camera'], {origin:'https://app.zoom.us'})` (Meeting-BaaS 2026-09, screenapp, recall). Chrome flag `--use-fake-ui-for-media-stream` auto-accepts the native prompt (Vexa `JOIN_BROWSER_ARGS`).
- **Fake devices:**
  - Vexa uses `--use-file-for-fake-video-capture=/dev/null`.
  - screenapp deliberately does not use `--use-fake-device-for-media-stream` for Zoom; it expects the "Cannot detect your camera/microphone" toasts instead.
  - Real audio needs a PulseAudio virtual source/sink.
- **Init scripts** that must run before the page builds its RTCPeerConnections or Worker (`addInitScript`): the WebRTC per-track hook (Vexa) and the Worker frame tap (Meeting-BaaS). See activeSpeaker.

### 1. Navigate and handle "host not started / invalid"
- `page.goto(url, {waitUntil:'domcontentloaded', timeout:60000})`. Don't use `networkidle`: Zoom keeps sockets open forever (invest-meet-bot).
- If `document.title === 'Error - Zoom'` and the body contains "This meeting link is invalid (3,001)", Vexa and Meeting-BaaS treat it as **host not started yet**. They retry `goto` every 15 s for up to 10 min, then report `WaitingForHostTimeout`. The same 3,001 page also appears for genuinely invalid IDs.

### 2. Fail-fast checks on the loaded page (lower-cased body text)
- **Sign-in walls:**
  - "sign in to join this meeting", "only authenticated users can join", "this meeting requires authentication", "authentication is required" (Vexa join.ts; Meeting-BaaS `zoom-state-config.ts`).
  - LMA reads `#prompt` for the text "Sign in to join this meeting".
  - Meeting-SDK page variants (attendee): "The host requires authentication on the commercial Zoom platform to join this meeting", or `button.login-btn-zoom` with text "Sign in Zoom".
- **Anti-bot wall:** "We detected you may be a bot", "Automated bots aren't allowed" (watch for the curly-apostrophe variant `aren’t`), "must use Zoom RTMS". See antiBot.
- **Webinar registration:** URL path is `/webinar/register/`.

### 3. Cookie banner (OneTrust)
- Selectors: `#onetrust-accept-btn-handler`, then fall back to `#onetrust-reject-all-handler` (Vexa, Meeting-BaaS, meetingbot, meeboter, NagiPoly). screenapp uses `button` with text "Accept Cookies".
- On the **classic** client this banner covers the name field and intercepts pointer events (`elementFromPoint` returns `#onetrust-reject-all-handler`), so Join never enables.
- joinly runs background clicks for buttons with the text "accept cookies" and "i agree".

### 4. Terms / disclaimer gates
- `#wc_agree1` ("I Agree" to the TOS; meetingbot 2025-10, meeboter, NagiPoly).
- `#disclaimer_agree` (custom admin disclaimer; Meeting-BaaS 2026-09).
- Generic in-page consent: `getByRole('button', {name: /^\s*(i\s+)?(agree|accept|continue|got it|i understand)\s*$/i})`, skipping anything inside `#onetrust-banner-sdk, #onetrust-consent-sdk, [id*=onetrust]`.
- Re-check every admission poll (Meeting-BaaS `dismissDisclaimer`).

### 5. Zoom's own media-permission modal (up to 2 times: camera+mic, then mic only)
- Click **`button:has-text("Allow")`** (Vexa and Meeting-BaaS, 2026). Vexa: "ALL bots must click Allow… without it Zoom never creates `<audio>` elements".
- Other labels for the same modal: `getByRole('button',{name:/Use microphone and camera/i})` (meetron 2026-09); `usermedia.pepc-permission-dialog__permission-button[type*="microphone"]` inside `.pepc-permission-dialog` (Chrome's in-page `<permission>` element; openclaw 2026-10).
- Last resort: `button:has-text("Continue without microphone and camera")` or the text "continue without audio or video" (openclaw observe-only mode). This can leave you with no audio channel.
- screenapp (no fake devices) instead closes the toasts that start with "Cannot detect your camera" / "Cannot detect your microphone" via `getByLabel('close')`.

### 6. Wait for the pre-join card
- Selector: `#input-for-name, #inputname, input[placeholder="Your Name" i]`. React client uses `#input-for-name`; classic uses `#inputname`.
- Loading copy that means "still loading" (Meeting-BaaS `zoom-loading-stall.ts`): "Joining Meeting…", "Connecting to the meeting", "connecting...", "loading...", "preparing the meeting", "your meeting is loading".
- Loading nodes: `.loading-layer`, `.zm-loading`, `.preview-loading`, `#zmmtg-root > .loading`.
- Meeting-BaaS reloads after 25 s with no DOM change (max 2 reloads).

### 7. Passcode (only if the field renders despite `?pwd=`)
- Field:
  - `#input-for-pwd` (React; meetron and LMA)
  - `#input-for-passcode`, `#inputpasscode`, `#inputpwd`
  - `input[placeholder*="passcode" i]`, `input[placeholder*="password" i]`, `input[type="password"]` (Meeting-BaaS / Vexa)
- Error markers: `#error-for-pwd` / `#error-for-passcode`, `aria-invalid="true"` on the input, or text matching `/(incorrect|invalid|wrong)…(passcode|password)/`.
- Personal Meeting Rooms and passcode-less meetings skip this field (LMA).

### 8. Name — must be real keystrokes

> **Superseded on 2026-10-13 (live tests on this machine):** per-key CDP typing hit Zoom's "Automated bots aren't allowed" wall in 3 of 3 runs, while `locator.fill()` got in about 9 of 10 joins. The bot uses fill() first and humanized typing only as a fallback (DESIGN §6.1). Also, `--in-process-gpu` crashes Chrome 155 at start here (SIGTRAP), so the bot does not use it.
1. Click the field.
2. `fill('')`.
3. `page.keyboard.type(name, {delay:30})`.

Vexa (observed 2026-04-26): a synthetic native-setter plus input event leaves the Join button disabled (`zm-btn preview-join-button disabled`), and Playwright then fails on "`.preview-meeting-info` intercepts pointer events". Meeting-BaaS uses the same "humanType" approach.

Optional: uncheck "Remember my name for future meetings" (`input[type=checkbox]` / `label:has-text("Remember my name")`; meetron, invest-meet-bot).

### 9. Preview mic and camera
- Mic: `#preview-audio-control-button`. `aria-label="Mute"` means the mic is live (click to mute); `"Unmute"` means already muted.
- Video: `#preview-video-control-button`. `aria-label="Stop Video"` means the camera is on; `"Start Video"` means off.
- Class variants: `.preview-audio-control__btn--unmuted`, `.preview-video-control__btn--on` (ft-prince).
- Icon variants: `svg.SvgAudioMute` (LMA treats it as "audio is unmuted") vs `svg.SvgAudioUnmute`; `svg.SvgVideoOn` / `svg.SvgVideoOff` (LMA 2026-08).
- Device menu: `button[aria-label="More audio controls" i]` with options `a[role="button"][aria-label^="Select a microphone" i]` (openclaw, meetron).
- **Caveat (Meeting-BaaS 2026-07):** "Zoom's web client resets device state on join". Re-assert mute after admission (step 13).

### 10. Click Join
- Selector: `button.preview-join-button, #joinBtn` (classic shows text "Join").
- First wait until it is enabled: `waitForFunction(() => btn && !btn.classList.contains('disabled') && !btn.disabled)`. React enables it about 1–2 s after a valid name.
- How to click (the repos disagree):
  - **Meeting-BaaS (2026-07-14 commit "click Join through Playwright, not the DOM — a DOM click is untrusted"):** humanized real mouse, then `click({force:true})`, then a DOM `.click()` as the last resort.
  - **Vexa:** DOM `btn.click()` to bypass the `.preview-meeting-info` overlay, falling back to `click({force:true})`.
  - For a real Chrome bot, prefer a trusted mouse click first.
- Before the click, if the classic client shows `iframe[src*="recaptcha"]`, only a human can pass it (Vexa holds the page for 15 min for a noVNC user).

### 11. Admission poll (every 2 s; order matters)
1. Scan for the anti-bot wall and captcha.
2. Scan for passcode errors.
3. Scan for denial/ended texts.
4. Check **waiting-room text first**: Zoom renders the waiting room inside `.meeting-app`, and the mic-preview `<audio>` stays live, so those two checks false-positive.
5. Check in-meeting markers. Primary: `button[aria-label="Leave"]`. Also `.single-main-container__video-frame`, `.single-suspension-container__video-frame`, `#video-share-layout video-player` (visible).
6. Only use the live-`<audio>` fallback when there are no pre-join controls.

See stateMarkers. Meeting-BaaS also exits the loop if the client never loads ("Joining Meeting…" spinner stall).

### 12. Join computer audio (post-admission)
- On current builds audio **auto-joins** (Vexa `prepare.ts`, v0.10.6). Check this first: `document.querySelectorAll('audio')` with `!paused && srcObject instanceof MediaStream && track.readyState==='live'`.
- Otherwise, dialog buttons: `button:has-text("Join with Computer Audio")`, `"Join Audio by Computer"`, `"Computer Audio"`, `"Join Computer Audio"`, `.join-audio-by-voip__join-btn`, `button.join-audio-by-computer`.
- Or the footer toggle `button.join-audio-container__btn` (class `footer-button-base__button ax-outline join-audio-container__btn`):
  - `aria-label` containing "join audio" or equal to "audio" means audio isn't connected yet: click it and expect the dialog.
  - `"Mute"`/`"Unmute"` (newer: "mute my microphone"/"unmute my microphone") means audio is already joined.
- Floating banner: `button:has-text("Join Audio")`.
- Vexa escalates `audio_join_failed` because without computer audio no `<audio>` elements exist and capture is silent.

### 13. Post-join hygiene
- **Re-mute** with an in-page click, repeated until the label reads "unmute…": `#foot-bar [aria-label*="mute" i], #wc-footer [aria-label*="mute" i], .footer [aria-label*="mute" i]`. Labels: "mute my microphone" when live, "unmute my microphone" when muted (Meeting-BaaS `ensureMuted`).
- **Camera off:** `button.send-video-container__btn`, `aria-label` "Stop Video" → click (Vexa).
- **Dismiss popups**, polled every 2–3 s (Vexa `dismissZoomPopups`):
  - `.zm-modal button:has-text("OK")` (AI Companion notice)
  - `.relative-tooltip button:has-text("Got it")` ("chatting as guest")
  - `.settings-feature-tips button:has-text("OK")`
  - `.ReactModal__Content button:has-text("OK"|"Got it")`
  - `[role="presentation"] button:has-text("OK")`
  - `.zm-modal:has-text("mic is muted")` with OK / Got it / Dismiss / Continue
  - The "Use graphics/hardware acceleration" toast: click its `[aria-label*="close" i]`, never "Learn more"
  - `button[aria-label="Close notification"]`
- **Recording / transcription / consent modals:**
  - NagiPoly: `.zm-modal-body-title` text "This meeting is being transcribed." then button "OK".
  - LMA: auto-dismisses any visible `.zm-modal, .zm-modal-legacy, [role="alertdialog"], .ReactModal__Content, .recording-disclaimer-dialog` whose text contains recording / consent / recorded / language interpretation / translation / request language / by joining / acknowledg. It clicks `.zm-modal-footer-default-actions button.zm-btn--primary`, `button.zm-btn--primary`, `button.zm-btn-legacy.zm-btn--primary` or `button.zm-btn__outline--blue`, or a button whose text is got it / i agree / ok / okay / continue / accept / consent / agree / close / dismiss.
  - Never click "Leave Meeting" in such a modal.
- **Optional:**
  - Speaker view: NagiPoly clicks `span` "View" then `a` "Speaker View".
  - Keep the footer visible: `#moreButton` → `a[aria-label="Settings"]` → toggle `div` text "Always show meeting controls" (`aria-checked`) → close `button.zm-btn.settings-dialog__close` (NagiPoly). joinly instead clicks the page centre `page.mouse.click(640,360)` before each toolbar action.
  - Keep the participants panel open for the roster (Meeting-BaaS).

## stateMarkers

Use `document.body.innerText` (lower-cased substring match) plus the selectors below. Sources in brackets with last-change date.

### Waiting room (admitted later by host) — no unique CSS class, text only
- "Please wait, the meeting host will let you in soon." [Vexa 2026-10, Meeting-BaaS 2026-09, eliza]
- "Host has joined. We've let them know you're here" [Vexa, live 2026-04-26]. joinly also accepts `span >> text=/we've let them know you're here/i`.
- Short forms: "will let you in", "admitted shortly", "waiting room" / "Waiting Room", "Host has joined" [Meeting-BaaS `zoom-lobby.ts`: these mean `waiting_for_admission`]
- Newer copy variants [openclaw 2026-10]: "someone will let you in shortly", "waiting for someone to let you in", "when someone admits you", "you're in the lobby", "we've let people in the meeting know you're waiting". It also tries class selectors `.waiting-room-container, [class*="waiting-room"], [class*="waitingRoom"]` (unverified).
- "host has been notified" [meetron]
- `text=/waiting for the host|host has joined|will let you in soon/i` [recall]

### Waiting for host to start
- "Waiting for the host to start this meeting" / "…the meeting" [Vexa, Meeting-BaaS: `host_not_started`]
- XPath `//*[contains(text(),"host to start the meeting")]` [attendee]
- "host has another meeting" (host is busy in another meeting) [ft-prince 2026-08]
- Before any of these, `title === "Error - Zoom"` plus "This meeting link is invalid (3,001)" (see invalid ID).
- Meeting-BaaS rule: once the lobby has shown "host has joined", it never goes back to host-not-started.

### Joining / loading (not yet a state)
- Text: "Joining Meeting…", "joining the meeting", "connecting to the meeting", "preparing the meeting", "your meeting is loading" [Meeting-BaaS]
- Nodes: `.loading-layer`, `.zm-loading`, `.preview-loading`, `#zmmtg-root > .loading`. Zoom mounts an empty `#video-share-layout video-player` behind the "Joining Meeting…" overlay, so check the loading copy before the in-meeting markers.

### In meeting (admitted)
- Primary: **`button[aria-label="Leave"]`**. Class `footer-button-base__button ax-outline footer-button__button`, inside `[footer-section="right"]` [Vexa, Meeting-BaaS, meetingbot]. It never renders in pre-join or waiting room, but the footer auto-hides, so use visibility plus a 3-miss debounce.
- Non-hiding alternatives [Meeting-BaaS `inMeetingPattern`, checkVisibility]: `.single-main-container__video-frame`, `.single-suspension-container__video-frame`, `#video-share-layout video-player`.
- Others:
  - `button[aria-label*="mute my microphone" i]` [recall: treated as in-call]
  - `svg.SvgShare` (share icon in the footer) [NagiPoly]
  - `#foot-bar`, `#wc-footer`, `.footer__inner`, `[class*="footer-button"]`, `[class*="meeting-client"]`, `[class*="speaker-view"]`, `[class*="gallery-video"]`, `[class*="sharee-container"]`, with no `#input-for-pwd` or `button.preview-join-button` present [LMA 2026-08]
  - `.meeting-app` / `#meeting-app` (**also present in the waiting room**)
  - Meeting-SDK page only: `div[aria-label='More meeting control ']` (note the trailing space) [attendee]
- Weak fallback: live remote `<audio>` elements with no pre-join controls and no text "enter meeting info" / "meeting passcode" [Vexa]

### Meeting ended by host
- Modal: `.zm-modal-body-title` with text "This meeting has been ended by host" [Vexa, openclaw]
- `div[aria-label="Meeting is end now"]` with OK button `button.zm-btn.zm-btn-legacy.zm-btn--primary.zm-btn__outline--blue` [meetingbot, screenapp 2026-08, NagiPoly 2026-09, meeboter]
- LMA: any `button.zm-btn.zm-btn-legacy.zm-btn--primary.zm-btn__outline--blue` inside `.zm-modal, .zm-modal-legacy, .ReactModal__Content` whose text includes "meeting has been ended", "meeting has ended" or "meeting is end".
- Text variants: "host ended the meeting", "ended by the host", "meeting has ended", "the host has ended the meeting", "this meeting has ended", "you have left the meeting" [Vexa, ft-prince, meter]
- **Scope these phrases to modal containers** (`.zm-modal, [class*="meeting-ended"], [class*="ended-meeting"], [class*="end-screen"], [class*="leave-page"]`). Meeting-BaaS (2026-08 incident): chat text containing "removed from the meeting" killed bots, so exclude `[aria-label="Chat Message List"]`, `.chat-virtuoso-wrapper`, `#chat-list-content`, `.chat-container__chat-list`, `#chat`, `.chat-container`, `.chat-rtf-box__editor-outer`, `[class*="new-chat"]`.
- Indirect signals:
  - Leave button missing 3 times in a row (more than 20 s after join) [Vexa, Meeting-BaaS]
  - Navigation off the zoom domains (`/zoom\.(us|com|eu|com\.cn|com\.br|com\.au|de|fr|jp|ca|co\.uk)\b/`) or to `/signin` / `/login`
  - Title `Error - Zoom`, empty, `Zoom`, `Join a Meeting - Zoom` or `Join Meeting - Zoom` [Vexa]
  - Landing on `app.zoom.us/wc` [openclaw]
  - Page frozen for 20 s [Meeting-BaaS]
  - Ignore audio-init redirects to `/wc/<id>/join`, `/wc/<id>/start`, `/wc-loading/`, `/wc/<id>/videomeeting` during the first 20 s [Vexa]
- SDK codes: 4004 MEETING_ENDED, 4001 DISCONNECT.

### Removed by host
- "You have been removed" [screenapp `ZOOM_REQUEST_DENIED`, recall `text=/you have been removed/i`, Vexa]
- `div[aria-label="You have been removed"]` [NagiPoly]
- Text variants: "removed from the meeting", "the host (has) removed you", "removed you from the meeting" [milo-ai regex]
- SDK: 3009 BE_REMOVED; reason code KICK_OUT_FROM_WAITING_ROOM = 7 [attendee].

### Invalid meeting ID / link
- `title "Error - Zoom"` plus "This meeting link is invalid (3,001)". Ambiguous with "not started" [Vexa, Meeting-BaaS]
- "invalid meeting id", "meeting id is not valid", "meeting does not exist" [ft-prince, milo-ai]
- SDK: 3001 / 3610 ERROR_NOT_EXIST. joinly raises if `get_by_text("invalid")` is visible after load.

### Wrong passcode
- "Passcode wrong" [attendee SDK page]
- "incorrect password" [joinly], "incorrect passcode", "invalid passcode", "wrong passcode"
- Regex `/(incorrect|invalid|wrong)[\s\S]{0,32}(passcode|password)/i`; `#error-for-pwd`; `aria-invalid="true"` on the passcode input [Meeting-BaaS]
- Passcode required with none supplied: the passcode field is present and Join stays disabled.
- SDK: 3004.

### Sign-in required
- "Sign in to join this meeting" (in `#prompt`) [LMA]
- "only authenticated users can join", "this meeting requires authentication", "authentication is required" [Vexa, Meeting-BaaS → LoginRequired]
- "This meeting is for authorized attendees only" / "authorized attendees only" [ft-prince, openclaw, milo-ai]
- "verify your email", "enter the code sent to" [openclaw]
- "The host requires authentication on the commercial Zoom platform to join this meeting", `button.login-btn-zoom` "Sign in Zoom" [attendee]
- Signals: `a[href*="/signin"]`, `button[aria-label*="sign in" i]`; URL redirect to `/signin`
- SDK: 3100 LOGIN_REQUIRED.

### Captcha / anti-bot
- Bot wall: "We detected you may be a bot. Automated bots aren't allowed to join this meeting or webinar and must use Zoom RTMS. … Sign in to join". Meeting-BaaS deliberately excludes the bare "sign in to join" from wall detection.
- Zoom smart captcha: `.component_smart_captcha`, `.CaptchaContainer`, `input[placeholder*="captcha" i]` (require `offsetParent !== null`), text "Type the characters you see" [Meeting-BaaS 2026-07]
- Classic-client Google reCAPTCHA: `iframe[src*="recaptcha"]` [Vexa]
- Generic: `iframe[title*="captcha" i]`, `.g-recaptcha`, `[data-sitekey]`, `[class*="captcha" i]`; text "complete the captcha", "security check", "verify you're human" [openclaw]; "not a robot", "unusual traffic" [milo-ai]
- Web SDK: `button` containing "check captcha" [attendee]

### Meeting locked / full / browser join disabled
- "meeting is locked" [ft-prince]
- SDK codes: 4006 MEETING_LOCKED, 4005 MEETING_CAPACITY_REACHED ("Meeting is full"; exact web-client copy unverified)
- 3603 NOT_SUPPORT_WEBCLIENT, 3611 "Can't join from a browser; use the desktop or mobile app"
- milo-ai regex: "joining from (a )?browser is (disabled|not allowed)", "host disabled.*browser"
- attendee: "Your network connection has timed out or your organization has disabled access to Zoom from the browser"

### Registration required
- Redirect to `/webinar/register/…`; SDK 3099.

### Alone in meeting
- See participants: counter `.footer-button__number-counter` ≤ 1, or roster/attendee count.
- milo-ai has unverified text regexes: "you're the only one here", "you are the only one in this meeting", "no one else is in this meeting".

## leaveFlow

### Recommended sequence (Vexa `leave.ts` 2026-10, Meeting-BaaS `closeMeeting` 2026-09)
1. Run the popup sweep (`dismissZoomPopups`) so AI Companion or feedback modals don't block the leave dialog.
2. **Leave button.** Click it with an in-page DOM click: the footer auto-hides, and Meeting-BaaS also sets it to `opacity:0`, so a Playwright click fails its actionability check. Try in order:
   - `[footer-section="right"] button[aria-label="Leave"]`
   - `button[aria-label="Leave"]`
   - `button[aria-label*="Leave"]`
   - Older or classic variants: `.footer__leave-btn` (ft-prince, milo-ai), `.footer-button__button:has-text("Leave")`, `.zm-btn:has-text("Leave")`
   - Webinar: `button[aria-label*="Leave Webinar" i]`, `button:has-text("Leave Webinar")`, `.webinar-footer__leave-btn` (invest-meet-bot)
   - If you use Playwright clicks (joinly), first show the toolbar with `page.mouse.click(640,360)` or a mouse move, then `getByRole('button', {name:/leave/i})`.
3. Wait about 500 ms for the confirm popover, then click **"Leave Meeting"**:
   - `button.leave-meeting-options__btn--danger` (Vexa: "aria-label is empty so text-based selectors are unreliable; use the CSS class")
   - Then `button.leave-meeting-options__btn`, `button.zm-btn--danger[aria-label*="Leave"]`, `button[aria-label="Leave Meeting" i]` (openclaw), `button:has-text("Leave Meeting")` (joinly, invest-meet-bot), `getByRole('button',{name:/^leave meeting$/i})`.
   - **Do NOT press Enter**: it cancels the dialog (Vexa).
   - If the bot is host, the popover also shows "End Meeting for All" (`button:has-text("End for All")`). Never click it.
4. Wait about 2.5 s so the WebRTC peer really disconnects (Vexa raised this from 1.5 s). Otherwise the bot lingers as a ghost participant for 30–60 s.
5. **Fallback** if any selector misses: `page.goto('about:blank')` (or close the page or context) to tear down the media connection. Bound the whole leave with a timeout of about 5 s (Meeting-BaaS uses `Promise.race` with `sleep(5000)`).
6. **Leaving while still in the waiting room / pre-admission:**
   - Meeting-SDK page: `button.leave-btn` ("Cancel join"; attendee).
   - Web client: the same "Leave" text button if present, otherwise navigate away (Vexa notes Zoom has no reliable pre-admit cancel).

### Post-leave markers (to confirm)
- `.zm-modal-body-title` text "you left the meeting" / "meeting has ended" (openclaw)
- URL `app.zoom.us/wc` (web client home) or a redirect off-domain / to the sign-in page
- Unverified class candidates: `.meeting-ended`, `.post-meeting`, `.leave-meeting-page` (openclaw)
- Meeting-SDK path: `ZoomMtg.leaveMeeting({})` with `leaveUrl` redirect (attendee)

## participants

### A. Participant count without opening the panel (footer)
- **Counter:** the participants footer button contains `<span class="footer-button__number-counter"><span>N</span></span>`, with label span `.footer-button-base__button-label` = "Participants". Source: real Zoom DOM snapshot, TG3R-IMM `rename-overlay` (2025-06).
- **LMA (2026-08):**
  - Reads `parseInt(document.querySelector('.footer-button__number-counter').textContent)`.
  - A MutationObserver (characterData, subtree) watches for changes.
  - A 30 s watchdog leaves when the count is ≤ 1 for 2 polls ("alone").
  - If the counter element is missing for 2 polls, it treats the bot as removed.
  - milo-ai also uses `[class*="number-counter"]`.
- **Participants button:**
  - aria-label "open the participants list pane" (guest) / "close the … list pane". Host sees "manage participants": "close the manage participants list pane" in the snapshot.
  - Selectors: `button[aria-label*="participants list"]` (Vexa/eliza), `button[aria-label*="open the participants list pane"]` (Meeting-BaaS), `getByRole('button',{name:'open the participants list'})` (recall says double-click it because "it doesn't open on the first click").
  - Other variants: `button[aria-label*="manage participants" i]`, `[feature-type="participant"]` (a div; NagiPoly, ft-prince), `.footer-button__participants-icon` (old), `.footer-button-base__button[aria-label*="participants" i]`.
- **Count parsing variants:**
  - eliza (2026-10): regex `\d+` on the participants button **aria-label**; alone if ≤ 1, since the count includes the bot.
  - screenapp (2026-08): the first `button` whose `innerText` starts with digits, e.g. "3\nParticipants"; while waiting it also parses `#wc-footer` innerText "N participants".
  - invest-meet-bot: `#footer-participants-count, .footer-button__number, button[aria-label*="participants"]` (partly unverified).

### B. Roster (participants panel, right dock)
DOM structure from the TG3R snapshot (2025-06), consistent with joinly (2026-09), recall (2025-11), NagiPoly (2026-09) and Meeting-BaaS (2026-07):
```
#wc-container-right
  .participants-section-container
    .participants-header__header > .participants-header__title  -> "Participants (42)"
    .participants-search-box__input[placeholder="Find a participant"]
    div[role=listbox].participants-wrapper
      #participants-ul.participants-list-container[role=list][aria-label="participants"]  (ReactVirtualized__Grid ReactVirtualized__List)
        .ReactVirtualized__Grid__innerScrollContainer[role=rowgroup]
          .participants-item-position
            div[role=application].item-pos.participants-li#participants-list-<n>
               aria-label="<Name> (Host, me) computer audio unmuted video on"   (also "no audio connected video off", "computer audio muted")
              .participants-item__item-layout
                .participants-item__avatar  (img with src, or initials div)
                .participants-item__name-section
                   span.participants-item__display-name  -> "Moses Grady"
                   span.participants-item__name-label    -> "(Host, me)" / "(Co-host)" / "(Guest)"
                .participants-item__right-section--icons
                   .participants-icon__icon-box svg.lazy-svg-icon__icon.lazy-icon-icons/participants-list/{audio-muted|audio-unmuted-N|video-on|video-off}
```

**Readers:**
- joinly: `div[role="list"][aria-label^="participants" i]` → items `div.participants-li`. It splits the `aria-label` on "," (first part is the name, the rest are info).
- recall: `.participants-item__item-layout` → `.participants-item__display-name`. It maps avatar `img.src` or initials to the name, used to resolve caption speakers.
- Meeting-BaaS `ROSTER_NAME_SELECTORS`:
  - `.participants-item__display-name`
  - `[class*="participants-item"] [class*="display-name"]`
  - `[class*="participants-li"] [class*="display-name"]`
  - `#participants-ul [class*="display-name"]`
  - `[class*="participants-item"] [class*="name"]`
  - It strips `\s*\((host|guest|me|co-host)[^)]*\)`.
- Meeting-BaaS keeps the panel **open but moved off-screen** with CSS (`position:fixed; left:-100000px; opacity:0`) so it never shows in the recording. It re-opens the panel every 1.5 s if the roster becomes unreadable, because **Zoom closes the pane when a screen share starts**, and it caches the last roster.

**Caveat:** the list is **virtualized** (ReactVirtualized), so only visible rows are in the DOM. Large meetings need scrolling or a store-based roster.

### C. Roster from tiles (no panel)
- `document.querySelectorAll('.video-avatar__avatar-footer span')` gives the names of rendered tiles (eliza and Vexa fallback). Gallery view shows more names, but only the rendered page.
- LMA extension fallbacks: `.video-avatar__avatar-footer span[role="none"]`, `.video-avatar__avatar-name`, `.video-avatar__avatar-img[alt]`.
- NagiPoly: `div[@class='participants-item-position']` count < 3 starts a 120 s exit timer.

### D. Non-DOM rosters (robust to class churn)
- **Redux store** (jmandel/meter 2026-04; attendee interceptor 2026-10):
  - Find the store by walking React fibers from `#root` / `#meeting-app`: `node['__reactContainer$…']` or `__reactFiber$…`, then BFS for `fiber.memoizedProps.store` (or `.value.store`) where `getState().meeting` exists.
  - `getState().attendeesList.attendeesList[]` holds `{userId, displayName, isHost, bCoHost, isGuest, muted, bVideoOn, audio, audioConnectionStatus, lastSpokenTime, userGUID, strConfUserID, zoomID, participantId, userRole}`.
  - Count = its length. Subscribe with `store.subscribe`.
- **Signaling frames** (Meeting-BaaS 2026-07): wrap `window.Worker`, because Zoom's RWG socket lives in a Web Worker and posts `{type:'message', data:'<json>'}` to the page. Opcode `7937` = roster: `body.add[]` of `{id, dn2 (base64 name), bBotUser,…}`; `body.remove` / `body.update` are maps keyed by id.

### Alone-in-meeting policies seen
- **LMA:** counter ≤ 1 for 2×30 s.
- **screenapp:** count ≤ 1 after another participant was seen, then wait `loneParticipantExitDelayMs`; or never-joined grace `activateInactivityDetectionAfterMinutes`; plus a mixed-audio silence detector.
- **eliza:** separate `noOneJoinedTimeoutMs` / `everyoneLeftTimeoutMs`.
- **Vexa (2026-10):** no DOM count. Remote-audio silence window (default 10 min, `max_time_left_alone`) with a guard that tells "deaf capture" apart from an empty room.
- **Meeting-BaaS (2026-09):** explicitly **opts Zoom out** of count-based aloneness because its speaker-derived count "doesn't mean what it says"; it relies on silence.

## activeSpeaker

There are four families of signals. Use at least two together, and always drop the bot's own name: tiles flicker, and Zoom can promote the bot itself when its mic leaks.

## 1. DOM: speaker / gallery tiles (classes, newest first)
**Name inside any tile:** `.video-avatar__avatar-footer` → its `span` (often `span[role="none"]`).
- Vexa found that `.video-avatar__avatar-name` "doesn't exist" (2026). Others still list it as a fallback, along with `.video-avatar__avatar-img[alt]`.
- Collapse whitespace before comparing names.
- Each tile wraps a custom element **`<video-player node-id="…">`** inside **`#video-share-layout`** (Meeting-BaaS).

**Vexa `zoom-capture/src/zoom-speakers.ts` (2026-08-31, live-verified):**
- `.speaker-active-container__video-frame`
- `.speaker-bar-container__video-frame--active`
- `[class*="single-"][class*="-container__video-frame"]`

Vexa's comment: "The old speaker-active-/speaker-bar- classes above are gone from the DOM". In speaker view Zoom renders one large tile that follows the dominant speaker. Its wrapper prefix drifts between `single-main-container…` and `single-suspension-container…`, both seen within one meeting.

**Meeting-BaaS `speakersObserver.ts` / `htmlCleaner.ts` (2026-07-16/21), `WINNER_TIERS`:**
1. `.speaker-bar-container__video-frame--active`: "Zoom's real 'talking now' marker"
2. `.speaker-active-container__video-frame`: "can be a fixed/pinned main tile that never tracks the speaker"
3. `.single-main-container__video-frame`: speaker-view main tile; stays valid during a share, where the shared screen is `#sharee-container .sharee-container__canvas`
4. `.single-suspension-container__video-frame`: the floating tile in share or camera-off layouts
5. `.gallery-video-container__video-frame--active`: **gallery view** active frame (green border)

They skip the bot's own tile and footerless tiles (the self-preview), and require `video-player` inside the frame.

**LMA bot (2026-08):**
- `.single-main-container__video-frame .video-avatar__avatar-footer span`
- `.single-suspension-container__video-frame .video-avatar__avatar-footer span`
- `.video-avatar__avatar-footer span[role="none"]`

A MutationObserver on `.meeting-app` (childList, subtree, characterData, attributes on `style`) drives it. If there are no speaker events for 60 s while attendees > 1, it asks an LLM for a new selector.

**LMA extension (2025):** MutationSummary on `.speaker-active-container__video-frame`, `.speaker-bar-container__video-frame--active`, `.gallery-video-container__video-frame--active`. A newly added node means a speaker change.

**jmandel/meter (2026-04), visible-element pick:**
- Main: `.single-main-container__video-frame`, `.single-main-container__main-view`, `.speaker-active-container__wrap`, `.speaker-active-container__video-frame`, `[class*='video-frame--active']`, `[class*='active-speaker']`
- Share: `.single-suspension-container__video-frame`, `.suspension-window-container .video-avatar__avatar`, `.suspension-window-container`
- Note: during a share, main-tile placeholders exist with zero height. Use `getBoundingClientRect` width/height > 0.

**Older or other repos:**
- joinly (2026-09): `div.speaker-active-container__video-frame span`, `div.speaker-bar-container__video-frame--active span`, `div.speaker-bar-container__video-frame span`, with a MutationObserver on `document` (`attributeFilter:['class']`).
- NagiPoly: XPath `//div[@class='speaker-active-container__video-frame']//div[@class='video-avatar__avatar-footer']//span`. Use "Remove Pin" to unpin first, since a pinned tile doesn't follow the speaker.
- ft-prince: `.speaker-bar__display-name`.
- milo-ai (unverified): `[class*="video-avatar__avatar"][class*="active"]`.
- Muted indicator inside a tile footer: `.video-avatar__avatar-footer--view-mute-computer` (LMA extension).

**Caveats:**
- Zoom's spotlight is a **sticky dominant-speaker** signal. It lags, holds the wrong person during a screen share, and flickers on coughs.
- Meeting-BaaS: "Zoom's web DOM has no per-tile speaking flag". They gate `isSpeaking` on the real audio level.
- Pinned or spotlighted tiles don't track the speaker.
- Speaker-view main-tile tracking is the most consistent across repos. Gallery view needs the `--active` frame class.

**Debounce recipes:**
- Vexa: 250 ms poll, a change must hold for 2 polls, 2 s heartbeat re-emit.
- Meeting-BaaS: 100 ms poll × 2 confirms (about 200 ms switch, to stop word bleed), 2 s heartbeat.
- eliza: 2 s poll × 2 votes.

**Self-diagnostics:** Vexa `getState()` and Meeting-BaaS `dumpDomForensics` list every `.video-avatar__avatar-footer` with its ancestor class chain, plus classes matching `/speak|talk|active|audio|volume|voice/i`. Run this live to find the current lit-tile class when Zoom renames.

## 2. DOM: participants panel / footer / captions
- **Participants panel mic icon:** class `lazy-svg-icon__icon lazy-icon-icons/participants-list/audio-unmuted-1` vs `…/audio-muted`, inside `.participants-icon__icon-box` (TG3R 2025-06 snapshot). The numeric suffix looks like an animated level frame that changes while a person talks. This is **unverified**; observe `class` mutations on those `svg`s.
- **Row `aria-label`** ("… computer audio unmuted …") gives mute state only, not speaking.
- **Own mic level** (to suppress self-attribution): `.audio-level-indicator` `style.height` > 5px means the bot is talking (LMA).
- **Footer button label text:** `.footer-button-base__button-label` = "Unmute" means you are muted (LMA extension).
- **aria-live regions:** none of the studied repos found an aria-live/`role=status` region announcing the active speaker. Treat as not available.
- **Live captions** (needs host to allow captions; gives speaker per caption line):
  - Enable: More (`button.more-button`, `.footer-more-button button`, `#moreButton`, or `getByRole('button',{name:'More',exact:true})` double-click) → `a[aria-label="Captions"]` → `a[aria-label*="Show Captions" i]` / "Your caption settings grouping Show Captions" → maybe "Save" in the caption-language modal → OK.
  - Toast: `/you have (enabled|turned on) live (captions?|transcription)/i`.
  - Containers: `#live-transcription-subtitle`, `.live-transcription-subtitle__box`. Lines: `.live-transcription-subtitle__item` / `.live-transcription-subtitle__text`.
  - Speaker: `.zmu-data-selector-item__icon` or `.zmu-caption-speaker-icon`, which is an `img` (match `src` against participants-panel avatars) or initials text; also `.live-transcription-subtitle__speaker`.
  - Sources: recall 2025-11, openclaw 2026-10, NagiPoly, attendee.

## 3. Zoom's in-page state (no CSS dependency)
**Redux store** (jmandel/meter 2026-04, attendee 2026-10; locate it as described under participants):
- `state.audio.asnIds`: active-speaker node ids. Map them through `attendeesList.attendeesList[].userId` → `displayName`.
- `state.video.currentSpeakerActiveVideo`, `currentMultiSpeakerActiveVideo`, `activeSpeakerList`, `currentRenderVideo`, `currentSuspensionAllVideos`: items carry `user.displayName` or `displayName`.
- Fallback: the attendee with the highest `lastSpokenTime`.
- Captions: `state.newLiveTranscription.newLTMessage` (map msgId → `{user.userId, text, done}`).
- Chat: `state.newChat.meetingChat`.

**Signaling frames via a `window.Worker` wrapper** (Meeting-BaaS `network-interception/browser-bundle.ts`, 2026-07-30):
- Opcode **12033** has `body.asn1`, `asn2`, …: speaking node ids. There can be several when people overlap. An empty body means silence.
- Opcode **8005** has `{nUserID, nLevel, mediaType}`, a per-user audio level. Only trust it once it has been seen both zero and non-zero.
- Opcode **7937** is the roster with base64 `dn2` names.
- Shared-screen `activeNodeID` is the active *sharer*, not the speaker.
- Match on **field names, not opcode numbers**; they differ between builds.
- Meeting-BaaS saw zero frames through WebSocket/RTCPeerConnection hooks but about 5,315 through the Worker.
- Wrapped globals must keep a native-looking `toString`.

## 4. Audio-side correlation
**Vexa (2026-08, Chrome):**
- Zoom delivers **one stable WebRTC audio track per participant**, observed live as "5 streams for 5 speakers, 0 remaps".
- An `RTCPeerConnection` `track`/`ontrack` hook (`installRemoteAudioHook`) mirrors each track into a hidden `<audio data-vexa-injected>`.
- Per-track energy is voted against the DOM-lit name (`createTrackNameResolver`: vote/argmax, margin 3, 1:1 by identity, idle release after 8 s, self-exclusion, otherwise "Speaker A/B/C").
- WebRTC `getStats()` `inbound-rtp` gives `audioLevel` per receiver/SSRC (Vexa `observe.ts`).

**Meeting-BaaS (Firefox/stealthfox):** saw no RTC receivers (`recv=0`). It treats Zoom audio as **mixed** (PulseAudio capture) and does temporal attribution.

**Recommendation:** in real Chrome, first verify whether `ontrack` fires per participant. If it does, per-track energy plus DOM/Redux name voting is the most accurate.

## chat

### Open the chat panel
- **Button:** `button[aria-label="open the chat panel"]` (exact match). When the panel is open the label becomes "close the chat panel", so the button is a **toggle**. Check whether the input is already visible before clicking (LMA, Meeting-BaaS).
  - Fallback: any button whose aria-label contains "chat" but **not** "setting". A plain substring match hits "Chat Settings" first (Meeting-BaaS).
  - Old variants: `button[aria-label*="chat panel"]`, `.footer-button__chat-icon`, `button[class*="chat-btn"]`.
  - On narrow windows chat may sit under More (`button.more-button` / `#moreButton`).
- **Panel containers:** `#chat-container`, `.chat-container`, `#wc-container-right`.

### Input (TipTap / ProseMirror contenteditable since about 2026)
- `div.tiptap.ProseMirror[contenteditable="true"]`, `div.ProseMirror[contenteditable="true"]`, `div.chat-rtf-box__editor[contenteditable="true"]`
- `.chat-rtf-box__editor-outer [contenteditable="true"]` (live-verified chain: `.chat-rtf-box__editor-outer > .chat-rtf-box__editor-wrapper > ._rtfEditor_* > div[contenteditable]`, Vexa v0.10.6 2026-05)
- Empty-state paragraph: `p[data-placeholder="Type message here ..."]` (LMA 2026-08)
- Legacy: `textarea.chat-box__chat-textarea`, `textarea[aria-label*="chat" i]`, `textarea[placeholder*="message" i]` (visualsprint: `get_by_placeholder("Type message here")`)
- **Visibility check:** use `el.getClientRects().length > 0`, not `offsetParent`. The chat panel is `position:fixed`, so `offsetParent` is null (Meeting-BaaS).

### Send
- **Meeting-BaaS (2026-09):**
  1. Focus the editor via JS (`el.focus()`; a real click fails if the dock is off-screen).
  2. `page.keyboard.insertText(message)`, a single atomic ProseMirror transaction. Per-key `keyboard.type` "races that pipeline… characters get dropped or reordered".
  3. `page.keyboard.press('Enter')`.
- **Alternatives:**
  - Send button `button[aria-label="send"]`, `button[class*="chat-rtf-box__send"]` / `.chat-rtf-box__send` (Vexa)
  - joinly: `div[contenteditable='true']` → `fill(message)` → Enter (max 1024 chars)
  - LMA extension: set `.chat-rtf-box__editor-outer p` `innerText`, then click `.chat-rtf-box__send` after 250 ms
- **Recipient** defaults to "Everyone". The host can restrict guest chat. Guests may first see a "chatting as guest" tooltip: `.relative-tooltip button:has-text("Got it")`.

### Read incoming messages (keep the panel open)
- **Container:** `div[role="application"][aria-label="Chat Message List"]` (joinly, LMA, Meeting-BaaS). Fallbacks: `.chat-virtuoso-wrapper`, `#chat-list-content`, `.chat-list-content`, `.chat-container__chat-list`, `[class*="chat-list"]`.
- **Rows:**
  - `[role="row"][aria-label]`, `div[id^="chat-message-content"]` (aria-label), `[id^="chat-message-"]`, `.new-chat-message__container` (role="row"), `[class*="chat-item-container"]`, virtualized `div[data-index]`
  - **Row aria-label formats:**
    - 2026: `"<Sender> to <Everyone|Name>, 10:42 AM, <text>"`
    - Older: `"<Sender> to Everyone: <text>"`
    - LMA regex: `/^([^,:]+?)\s+to\s+[^,:]+?(?:\s*:\s*|,\s*\d{1,2}:\d{2}(?:\s*[AP]M)?\s*,\s*)/i`
    - joinly splits on "," into sender, time, text.
- **Parts:**
  - Sender: `.chat-item__sender` / `[class*="chat-item__sender"]`. Sender headers are grouped, so climb the ancestors.
  - Receiver: `[class*="chat-item__receiver"]`
  - Text: `.new-chat-message__text-box`, `.chat-rtf-box__display`, `[class*="message__text"]`
  - Time: `[class*="time-stamp"]`
- **Own messages:** aria-label starts with "You to Everyone", or sender "You". Filter them out.
- **Store alternative:** Redux `state.newChat.meetingChat` (meter).
- **Re-open watchdog:** Zoom closes the panel on click-away or share. Vexa checks every 5 s whether the button aria-label contains "open" and re-opens.
- **Never treat chat text as a meeting-end signal** (see stateMarkers).

## antiBot

### What Zoom does (2026)
- **Built-in bot protection is always on.** Zoom KB0088381: the Zoom Web App "automatically identifies and intercepts automated or suspicious participants", it is enabled for all accounts and **can't be turned off**, and a flagged real user "can still sign in and join".
  - "Official" bot paths: Marketplace Meeting SDK and RTMS.
  - "Unofficial": automated use of the Native or Web apps.
  - Host-side controls: Require sign-in (optionally Web App only), block domains, waiting room, bot-blocking dashboard.
- **Wall text** (after Join, sometimes before): "We detected you may be a bot. Automated bots aren't allowed to join this meeting or webinar and must use Zoom RTMS. … Sign in to join" plus reCAPTCHA. Seen by Vexa (2026) and Meeting-BaaS (2026-07+).
- **Is the wall keyed to the meeting or to the IP? The sources disagree:**
  - **Vexa:** "Verified identical from datacenter AND residential IPs on the same meeting → it is the meeting/account anti-bot setting, NOT IP reputation". It fails fast with `zoom_requires_rtms`.
  - **Meeting-BaaS:** "Zoom walls 93% of proxy-less joins (14 days of prod)". It retries the wall and the smart-captcha on a fresh residential exit IP / ASN and logs wall phase, exit country and ASN.
  - Plan for both cases.
- **Other gates:**
  - Zoom smart captcha "Type the characters you see" (`.component_smart_captcha`, `.CaptchaContainer`), which is IP-reputation driven (Meeting-BaaS).
  - Classic-client Google reCAPTCHA gating `#joinBtn` (Vexa holds the browser up to 15 min for a human over noVNC).
  - Web Meeting SDK "Check Captcha" (attendee).
  - "Only authenticated users can join".
- **Meeting SDK alternative:** from **March 2, 2026**, apps joining meetings outside their account must be authorized with ZAK or OBF tokens, or use RTMS (developers.zoom.us error-codes page). The web client is the only path that needs no Zoom app.

### Browser setup used by working bots
**Vexa `JOIN_BROWSER_ARGS` (2026-07):**
- `--incognito --no-sandbox --disable-setuid-sandbox --disable-features=IsolateOrigins,site-per-process --disable-infobars --disable-gpu --in-process-gpu --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required --use-file-for-fake-video-capture=/dev/null --disable-blink-features=AutomationControlled --disable-features=VizDisplayCompositor --disable-site-isolation-trials --lang=en-US --accept-lang=en-US,en`
- `ignoreDefaultArgs:['--enable-automation']`, `headless:false` under Xvfb (VNC), `viewport:null`, `locale:'en-US'`.
- **Avoid** `--ignore-certificate-errors`, `--disable-web-security` and `--allow-running-insecure-content`: "detectable by … bot-detection".
- `--in-process-gpu`: without it, Zoom's SwiftShader WebGL plus software video decode used about 357% CPU per bot (measured 2026-04-27).
- Vexa's persistent context also applies `puppeteer-extra-plugin-stealth` and an init script that spoofs the WebGL `UNMASKED_VENDOR/RENDERER` (Intel/Mesa instead of SwiftShader), `navigator.deviceMemory` and `chrome.runtime`.

**Meeting-BaaS (2026-07..09):**
- Chromium path: CloakBrowser (patched Chromium) with a single `--disable-blink-features=AutomationControlled,TrustedDOMTypes`.
  - Chromium keeps one value per switch, so repeated `--disable-features` flags silently override each other.
  - `--lang=en-US --accept-lang=en-US,en`, PulseAudio flags, `--autoplay-policy=no-user-gesture-required`, `--disable-gpu-compositing --in-process-gpu --enable-unsafe-swiftshader`.
- For **Zoom** they default to **stealthfox (patched Firefox)**, explicitly because of the wall: "Zoom's anti-bot wall is the reason stealthfox exists". They refuse to fall back silently.
- Residential proxy only for the hosts that make the join decision: `app.zoom.us`, `zoom.us`, `www.zoom.us`, `events.zoom.us`. Media/CDN hosts (`us04st1.zoom.us`, `*rwg*.zoom.us`, …) go direct; `us04st1` alone was 92% of proxy bytes.
- Timezone aligned to the exit IP's geo, while UI locale stays en-US ("A UTC clock on a non-UTC egress IP is the stronger bot tell").
- Trusted humanized mouse for Join (`isTrusted`; a DOM click is "a free tell"), real keystrokes for the name, and `grantPermissions` (Chromium only).

**screenapp (2026-08):** `playwright-extra` + stealth (minus the `iframe.contentWindow` and `media.codecs` evasions), `ignoreDefaultArgs:['--mute-audio']`, `--auto-accept-this-tab-capture`, `--enable-usermedia-screen-capturing`, 1280×720.

**ft-prince (2026-08):** `channel:'chrome'` (real Google Chrome), `ignoreDefaultArgs:['--enable-automation']`, `--disable-blink-features=AutomationControlled`, and a **saved signed-in Chrome profile** when available (`npx tsx scripts/zoom-login.ts`).

**recall (2025):** `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`, a headed-matching UA in headless mode, and `context.route('zoommtg://*', abort)`.

### Signed-in bots (the mitigation Zoom itself suggests)
- **LMA (2026-08):** signs into a stored Zoom account in a persistent profile, then joins `https://zoom.us/wc/<id>/join`, overwriting the prefilled display name. Comment: guest join "joins far less reliably".
  - Detect login by cookies `zm_aid`, `_zm_ssid` or `zm_haid` on zoom.us/app.zoom.us (not `cred` / `_zm_mtk_guid`, which are set before login).
  - Vexa warns that an anonymous `_zm_ssid` is set as soon as the sign-in page loads, so instead confirm the URL has left `/signin`.
  - Captcha, 2FA and SSO during sign-in go to a human over VNC. Signing into the same account in many places can trigger the captcha.
- **Vexa "authenticated mode"** (2026) is an experiment to see whether a signed-in persistent context clears the "sign in to join / use RTMS" wall.

### Other practical notes
- Run headed under Xvfb with PulseAudio, not headless.
- With a stealth/anti-detect browser, `exposeFunction` bindings may not be visible to init scripts. Meeting-BaaS drains a `window.__zoomSpeakerQueue` via `evaluate`.
- Firefox ignores `bypassCSP` on Zoom ("blocked by CSP"); in Chrome use the `bypassCSP: true` context option or isolated-world reads.
- Keep the UI English: selectors depend on English aria-labels ("Leave", "open the chat panel", "mute my microphone").
- Fail fast and classify outcomes instead of looping: wall, captcha, login-required, registration, passcode, loading-stall.

## limits

### Meeting duration (set by the host's plan)
- **Basic (free) host: 40 minutes per meeting, including 1:1.** 1:1 meetings were unlimited before 2022. A countdown warning appears near the end, then the meeting closes for everyone. The host can restart with the same link (no daily cap), so the bot must detect the end and rejoin if needed.
- **Pro / Business: up to 30 hours per meeting.** Recording length is capped by the meeting itself.
- Source: usecarly.com "Zoom time limit"; tldv and temperstack pricing pages agree on 40 min / 100 participants for Basic.
- **Your bot's own caps:**
  - Vexa: `max_bot_time`, `max_wait_for_admission`, `max_time_left_alone` (default silence window 10 min).
  - Meeting-BaaS: `waiting_room_timeout` default 600 s; host-not-started retry up to 10 min.
  - attendee: `waiting_room_timeout_seconds`, `wait_for_host_to_start_meeting_timeout_seconds`.

### Participants
- Basic and Pro: 100 participants. Business: 300+ (more with Large Meeting add-ons).
- **The bot uses one seat.**
- A full meeting gives SDK error **4005 MEETING_CAPACITY_REACHED**; a locked meeting gives **4006 MEETING_LOCKED**.
- The participants panel DOM is virtualized: only visible rows render.

### Admission and host gates
- Waiting room means a human must admit the bot. Signed-in users can be auto-admitted while guests wait (Zoom KB).
- If "join before host" is off, the bot waits with "Waiting for the host to start this meeting" (or gets the 3,001 error page).
- "Require sign-in", domain allow-lists, registration-required webinars (`/webinar/register/`), and "authorized attendees only" all block guest bots.
- Hosts may disable joining from the browser: SDK 3603 / 3611 "use the desktop or mobile app".
- Zoom Events, Webinar Q&A, interpretation channels, Zoom Gov and VDI are not supported, or only partly (recall.ai Zoom overview, updated 2026-09-19).
- Breakout rooms: the bot stays in the main room unless it is assigned and accepts.

### Platform constraints
- The Web App's built-in bot protection cannot be disabled by the host (Zoom KB0088381). Expect a share of joins to hit walls or captchas.
- The Meeting SDK path needs ZAK/OBF authorization for external meetings since 2026-03-02.
- Free meetings also limit some features. For example, live captions must be enabled by the host or account for caption-based attribution.

### Resource limits observed
- Zoom Web is the heaviest client: about 357% CPU in the gpu-process without `--in-process-gpu` (Vexa 2026-04-27), and about 500 MB RAM per bot (recall.ai blog).
- Meeting-BaaS gives Zoom 40–60 s "page slow but alive" windows.

### Audio-specific
- Without "Allow" on Zoom's media modal and computer audio joined, no remote `<audio>`/tracks exist and the recording is silent (Vexa).
- Zoom culls inactive speakers' streams. Vexa saw a bounded pool of about 6 streams over 17 minutes; streams appear when a person first speaks.

## sources

```json
[
  "https://github.com/Vexa-ai/vexa/blob/main/core/meetings/modules/join/src/zoom/selectors.ts",
  "https://github.com/Vexa-ai/vexa/blob/main/core/meetings/modules/join/src/zoom/join.ts",
  "https://github.com/Vexa-ai/vexa/blob/main/core/meetings/modules/join/src/zoom/admission.ts",
  "https://github.com/Vexa-ai/vexa/blob/main/core/meetings/modules/join/src/zoom/leave.ts",
  "https://github.com/Vexa-ai/vexa/blob/main/core/meetings/modules/join/src/zoom/removal.ts",
  "https://github.com/Vexa-ai/vexa/blob/main/core/meetings/modules/zoom-capture/src/zoom-speakers.ts",
  "https://github.com/Vexa-ai/vexa/blob/main/core/meetings/modules/zoom-capture/src/zoom-chat.ts",
  "https://github.com/Vexa-ai/vexa/blob/main/core/meetings/modules/zoom-capture/src/track-name-resolver.ts",
  "https://github.com/Vexa-ai/vexa/blob/main/core/meetings/modules/join/src/browser-args.ts",
  "https://github.com/Vexa-ai/vexa/blob/main/core/meetings/modules/mixed-capture-core/src/webrtc-audio-hook.ts",
  "https://github.com/Vexa-ai/vexa/blob/main/core/meetings/modules/remote-browser/src/browser.ts",
  "https://github.com/Vexa-ai/vexa/blob/main/core/meetings/services/bot/src/aloneness.ts",
  "https://github.com/Vexa-ai/vexa/blob/vexa-0.10.6/services/vexa-bot/core/src/platforms/zoom/web/selectors.ts",
  "https://github.com/Vexa-ai/vexa/blob/vexa-0.10.6/services/vexa-bot/core/src/platforms/zoom/web/prepare.ts",
  "https://github.com/Vexa-ai/vexa/blob/vexa-0.10.6/services/vexa-bot/core/src/platforms/zoom/web/recording.ts",
  "https://github.com/Vexa-ai/vexa/blob/vexa-0.10.6/services/vexa-bot/core/src/platforms/zoom/web/observe.ts",
  "https://github.com/Vexa-ai/vexa/blob/vexa-0.10.6/services/vexa-bot/core/src/services/chat.ts",
  "https://github.com/Vexa-ai/vexa/blob/vexa-0.10.6/services/vexa-bot/core/src/services/speaker-identity.ts",
  "https://github.com/Vexa-ai/vexa/blob/vexa-0.10.6/tests3/releases/260426-zoom/audio-research.md",
  "https://github.com/Meeting-BaaS/meet-teams-bot/blob/main/src/meeting/zoom.ts",
  "https://github.com/Meeting-BaaS/meet-teams-bot/blob/main/src/meeting/zoom-state-config.ts",
  "https://github.com/Meeting-BaaS/meet-teams-bot/blob/main/src/meeting/zoom-lobby.ts",
  "https://github.com/Meeting-BaaS/meet-teams-bot/blob/main/src/meeting/zoom-passcode.ts",
  "https://github.com/Meeting-BaaS/meet-teams-bot/blob/main/src/meeting/zoom-loading-stall.ts",
  "https://github.com/Meeting-BaaS/meet-teams-bot/blob/main/src/meeting/zoom/speakersObserver.ts",
  "https://github.com/Meeting-BaaS/meet-teams-bot/blob/main/src/meeting/zoom/htmlCleaner.ts",
  "https://github.com/Meeting-BaaS/meet-teams-bot/blob/main/src/meeting/zoom/chat-selectors.ts",
  "https://github.com/Meeting-BaaS/meet-teams-bot/blob/main/src/meeting/zoom/chatObserver.ts",
  "https://github.com/Meeting-BaaS/meet-teams-bot/blob/main/src/meeting/zoom/network-interception/browser-bundle.ts",
  "https://github.com/Meeting-BaaS/meet-teams-bot/blob/main/src/chat-manager.ts",
  "https://github.com/Meeting-BaaS/meet-teams-bot/blob/main/src/urlParser/zoomUrlParser.ts",
  "https://github.com/Meeting-BaaS/meet-teams-bot/blob/main/src/browser/browser.ts",
  "https://github.com/Meeting-BaaS/meet-teams-bot/blob/main/src/browser/browser-session.ts",
  "https://github.com/Meeting-BaaS/meet-teams-bot/blob/main/src/state-machine/states/recording-state.ts",
  "https://github.com/screenappai/meeting-bot/blob/main/src/bots/ZoomBot.ts",
  "https://github.com/screenappai/meeting-bot/blob/main/src/tasks/RecordingTask.ts",
  "https://github.com/screenappai/meeting-bot/blob/main/src/lib/chromium.ts",
  "https://github.com/screenappai/meeting-bot/blob/main/src/constants/index.ts",
  "https://github.com/meetingbot/meetingbot/blob/main/src/bots/zoom/src/bot.ts",
  "https://github.com/noah-duncan/attendee/blob/main/bots/zoom_web_bot_adapter/zoom_web_ui_methods.py",
  "https://github.com/noah-duncan/attendee/blob/main/bots/zoom_web_bot_adapter/zoom_web_chromedriver_page.js",
  "https://github.com/noah-duncan/attendee/blob/main/bots/zoom_web_bot_adapter/zoom_web_redux_interceptor.js",
  "https://github.com/noah-duncan/attendee/blob/main/bots/meeting_url_utils.py",
  "https://github.com/joinly-ai/joinly/blob/main/joinly/providers/browser/platforms/zoom.py",
  "https://github.com/recallai/zoom-meeting-bot/blob/main/src/bot/zoom_bot.js",
  "https://github.com/recallai/zoom-meeting-bot/blob/main/src/bot/browser_utils.js",
  "https://github.com/recallai/zoom-meeting-bot/blob/main/src/bot/utils.js",
  "https://github.com/openclaw/openclaw/blob/main/extensions/zoom-meetings/src/transports/zoom-meetings-selectors.ts",
  "https://github.com/openclaw/openclaw/blob/main/extensions/zoom-meetings/src/transports/zoom-meetings-status-prejoin-source.ts",
  "https://github.com/openclaw/openclaw/blob/main/extensions/zoom-meetings/src/transports/zoom-meetings-page-scripts.ts",
  "https://github.com/openclaw/openclaw/blob/main/extensions/zoom-meetings/src/transports/zoom-meetings-urls.ts",
  "https://github.com/elizaOS/eliza/blob/develop/plugins/plugin-meetings/src/platforms/zoom/strategies.ts",
  "https://github.com/elizaOS/eliza/blob/develop/plugins/plugin-meetings/src/platforms/zoom/page-state.ts",
  "https://github.com/aws-samples/amazon-transcribe-live-meeting-assistant/blob/main/lma-virtual-participant-stack/backend/src/zoom.ts",
  "https://github.com/aws-samples/amazon-transcribe-live-meeting-assistant/blob/main/lma-browser-extension-stack/public/content_scripts/providers/zoom.js",
  "https://github.com/jmandel/meter/blob/main/src/bootstrap.ts",
  "https://github.com/bb8ad8/meetron/blob/main/scripts/prepare-zoom.mjs",
  "https://github.com/bb8ad8/meetron/blob/main/src/providers/zoom-web/zoom-web-provider.mjs",
  "https://github.com/ft-prince/MeetBot/blob/main/backend/src/bot/zoomBot.ts",
  "https://github.com/NagiPoly/webrtc-meeting-bot/blob/main/src/meeting/zoombot.py",
  "https://github.com/affan4321/milo-ai/blob/main/apps/bot/src/platforms/zoom-selectors.ts",
  "https://github.com/sidhyaashu/invest-meet-bot/blob/main/src/platforms/zoom.py",
  "https://github.com/sidhyaashu/invest-meet-bot/blob/main/src/monitors/zoom_aloneness.py",
  "https://github.com/Payme-Works/meeboter/blob/main/apps/bots/providers/zoom/src/selectors.ts",
  "https://github.com/TG3R-IMM/fjn1/blob/main/rename-overlay",
  "https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0088381",
  "https://developers.zoom.us/docs/meeting-sdk/web/error-codes/",
  "https://docs.recall.ai/docs/zoom-overview",
  "https://www.recall.ai/blog/how-to-build-a-zoom-bot-a-guide-for-developers",
  "https://www.usecarly.com/blog/zoom-time-limit/"
]
```
