# Stream Frame launcher for Steam Frame: feasibility and plan

## Context

Goal: watch Netflix, HBO Max, Hulu and Disney+ standalone on the Valve Steam Frame (shipped 18 Sep 2026, Snapdragon 8 Gen 3, SteamOS 0.3.0 on ARM64, SteamVR as the on-device runtime), on a cinema-sized virtual screen, either in a dark virtual space or over colour passthrough via the $149 Arcturus Vision camera.

Decision taken with the user (28 Sep 2026): **build a launcher only**. No custom OpenXR renderer or 3D cinema hall. The product installs Google Chrome for ARM64 Linux (the only legal Widevine path on this device), provisions a cinema-tuned profile, and opens the services as their own panel that Valve's SteamVR dashboard can float, curve, resize, or show on the Theater Screen with passthrough behind it. Hardware available: Steam Frame + Arcturus camera.

The workspace `/Users/sebastienbock/claude-workspace/stream_frame` is empty. This plan creates the project from scratch.

## Feasibility summary (research 28 Sep 2026)

**Why a browser and nothing else.** Every no-browser route is closed:

| Route | Verdict | Reason |
|---|---|---|
| Google Cast / DIAL receiver on the headset | Not feasible | Receivers need Google-signed device certificates; Netflix's DIAL launch requires Netflix's own certified TV app (MDX protocol). Netflix removed casting to most devices in Dec 2025. Open-source receivers only work with extracted keys. |
| Phone mirroring, AirPlay | Not feasible | FLAG_SECURE blacks out Android capture; Netflix dropped AirPlay in 2019; Disney+/Max/Hulu AirPlay needs FairPlay-licensed receivers. |
| Android apps via Waydroid or Valve's Lepton | Not viable | Lepton is games-only with no Play Services or Widevine; Waydroid Widevine on ARM64 is broken and unlicensed. |
| Native certified app | Out of our hands | Needs the services to partner with Valve. |
| PC streaming | Off-target | Needs a PC. |

**Why it works now.** Google ships official Chrome for ARM64 Linux (stable since late July 2026, v150+) with a native Widevine CDM bundled. Flathub's community `com.google.Chrome` wrapper lists aarch64 and repackages Google's arm64 .deb (v154 as of Sep 2026). Linux has no Verified Media Path, so nothing blocks it. The Frame's stock browser is Flathub **Chromium**, which has **no Widevine**, so the four services fail out of the box; that is the gap this launcher closes.

**Quality ceiling (Widevine L3 on Linux, applies to any solution on this device):**

| Service | Expected max in Linux Chrome | Confidence |
|---|---|---|
| Netflix | 720p default; 1080p with the "New Netflix 1080p" Web Store extension (`mdlbikciddolbenfkgggdegphnhmnfcg`, updated Apr 2026). Netflix's help page now lists Linux Chrome at 1080p. | High |
| Disney+ | 480p, reportedly enforced for Linux browsers | Medium |
| HBO Max | Unknown; blocked Linux in 2020, reports contradictory | Low |
| Hulu | Generally works, cap unconfirmed | Low |
| Apple TV+ (tv.apple.com) | Plays in Chrome via Widevine L3, reportedly 480p to 720p | Medium |
| Prime Video | Plays, about 480p to 540p SD | Medium |
| YouTube | No DRM for normal videos; full resolution. Movies/YouTube TV use Widevine L3 | High |
| 4K / HDR | Not possible on any DRM service | High |

A ChromeOS user-agent may lift some caps. It is a ToS grey area; ship it as an off-by-default experiment only if Phase 0 shows a real gain.

**How the built-in "theatre" already behaves (verified by community field notes on SteamOS 0.3.0):**

- gamescope runs with `--backend openvr --virtual-connector-strategy PerAppId --nested-width 1280 --nested-height 720 --vr-overlay-physical-width 2.67`. Every Steam app id becomes its own SteamVR overlay panel `valve.steam.desktopgame.<appid>`. A non-Steam shortcut launched from the library gets a panel like any game.
- The SteamVR dashboard offers per panel: Float in World, Move, Size, Toggle Curvature, dock on a controller, **View in Theater**, Multitasking View. Passthrough can be the background (colour with Arcturus, which replaces system passthrough everywhere).
- Panels render at gamescope's nested size, **1280×720 by default**. Whether Steam's per-app resolution property raises this on the Frame is the single most important unknown for picture quality, because a 1080p Netflix stream would otherwise be downscaled to 720p. Phase 0 spike.
- Steam preloads `gameoverlayrenderer.so` via `LD_PRELOAD` into everything it launches; it segfaults Chromium's zygote. The launcher must strip it (proven fix from the chromium-webxr-steam-frame project).
- Chromium must run with `--ozone-platform=x11` so its window lands on gamescope's `:0` display and gets a panel.
- Two verified ways to register a library entry without Steamworks: the Steam client's DevTools port (`127.0.0.1:8080`, page `SharedJSContext`, `SteamClient.Apps.AddShortcut`), or Valve's devkit `steam-client-create-shortcut` over `~/.steam/steam.pipe`.
- `/` is read-only (10 GB); `/home` is 929 GB. `flatpak`, `python3`, `rsync`, `xprop`, `xwininfo` are on the image. Flathub is a system remote; `--user` installs work over SSH. `steamos` is in the `input` group, so `/dev/uinput` is usable without sudo (for later controller-to-media-key work).
- Developer Mode gives SSH. Battery is 1 to 1.5 h in reviews; Chrome on Linux ARM64 software-decodes video, so long films want the charger.

## Product definition

"Stream Frame" is a Steam-library entry on the Frame. Launching it opens Chrome with a dedicated profile on a **start page** where the user picks a streaming service; the tile opens that service's homepage in the same window. Supported services and their homepages:

| Tile | Opens |
|---|---|
| Netflix | https://www.netflix.com/browse |
| HBO Max | https://www.max.com/ (redirects to hbomax.com in some regions; follow whatever the service redirects to) |
| Hulu | https://www.hulu.com/hub/home |
| Disney+ | https://www.disneyplus.com/home |
| Apple TV+ | https://tv.apple.com/ |
| Prime Video | https://www.primevideo.com/ (or amazon.com/gp/video in the US) |
| YouTube | https://www.youtube.com/ |

**Start page design.** A dark grid of thumbnail tiles, each showing the service's logo on its brand colour, large enough to hit with a laser pointer. Clicking a tile navigates the same tab to that service's homepage. A gear icon in the corner opens **Configuration**, a panel on the same page where the user can:

- reorder tiles (move up/down buttons, plus drag-and-drop for a mouse or laser pointer),
- show or hide any tile,
- add a new tile for a service that is not listed (name, homepage URL, optional logo URL; if no logo is given, the page fetches the site's icon and falls back to a monogram on a generated colour),
- edit or remove tiles they added, and reset to the default seven.

Configuration has a second tab, **Controls**, where the user maps controller buttons to actions:

- a list of actions (play/pause, seek back, seek forward, volume up/down, mute, fullscreen, Home), each with a "Press a button" capture field: the page records the next gamepad button or key the controller produces, shows its name, and lets the user clear it or assign a second button,
- a live indicator showing which buttons are currently being received, so the user can see whether the controller is in gamepad or keyboard mode,
- seek step (5/10/30 s), volume step, and the Home confirmation toggle (confirm on, or immediate),
- reset to defaults.

Both tabs save to `chrome.storage.local` inside the helper extension, which lives in the dedicated Chrome profile and therefore persists across launches and reboots. `extension/services.json` holds only the defaults. Logos for the seven built-ins are bundled SVGs under `extension/logos/` (brand marks are trademarks; bundle simple monochrome marks from the CC0 Simple Icons set where available, else a wordmark, and say so in the README). The same seven services are seeded as bookmarks on Chrome's bookmark bar as a shortcut between services; the start page configuration is the source of truth for tiles, and a "Home" bookmark returns to it. The user floats or theatre-docks the panel with Valve's dashboard controls, and picks passthrough or the dark home space in SteamVR settings. **Full-screen service pages.** Chrome starts with `--start-fullscreen`, so the window has no tab strip or address bar and the page fills the entire panel. Tiles navigate the same window, so the service homepage opens full screen; the service's own player fullscreen button then works as usual. Because there is no address bar, a bundled companion extension injects a small Home button (bottom corner, fades out after a few seconds, reappears on pointer movement) that returns to the start page; Alt+Left via the SteamVR keyboard remains as a fallback. Phase 0 also checks whether SteamVR remembers a panel's dock state (Theater / floating) between launches, so a user who once chose "View in Theater" gets it again automatically; if not, the README documents the one-time dashboard step.

**Controller mapping.** Valve documents that in non-VR apps the Frame controllers "take full advantage of Steam Input, showing up as either a generic gamepad or keyboard/mouse depending on the configured bindings". The laser pointer remains SteamVR's own mouse. So the page inside the panel sees controller buttons either as Gamepad API buttons or as key presses, and the helper extension handles both:

- Actions: play/pause, seek back 10 s, seek forward 10 s, volume up, volume down, mute, toggle fullscreen, Home. Actions act on the page's `<video>` element (works on DRM video too) with a per-service fallback to the site's own shortcut key where the video element is not directly controllable.
- Default mapping (gamepad mode): A = play/pause, left/right on the d-pad or stick = seek, up/down = volume, Y = mute, X = fullscreen, Menu/Start = Home. In keyboard mode the same defaults map to Space, arrows, M, F, and Escape held.
- Home asks for confirmation: an in-page overlay "Return to Stream Frame home?" with Yes/No buttons clickable by laser, or press the same button again within 3 s to confirm; anything else dismisses. Actions are ignored while a text field has focus so typing is never hijacked.
- The Steam Input layout for the shortcut decides which mode the page sees. Phase 0 (S6) checks whether a default layout can be shipped with the shortcut; if not, the README gives the one-time steps in Steam's controller settings, and the mapper works with whatever the user picks because it captures raw events.
- Fallback if the panel receives no button events at all: a small OpenVR overlay helper (python + ctypes against the on-device `libopenvr_api.so`) reads controller actions through IVRInput and injects keys through `/dev/uinput`, which the `steamos` user can open without sudo. Only built if S6 forces it.

**Login persistence.** Chrome runs with a dedicated, persistent `--user-data-dir` under `~/.local/share/stream-frame/profile`. Cookies and session tokens persist there exactly as in desktop Chrome, so logins survive relaunches and reboots. Session lifetime is then up to each service (Netflix and Disney+ keep sessions for months; Prime Video and Apple TV+ re-prompt more often). The profile is removed only by `uninstall.sh --purge` or a factory "Erase User Data". `--password-store=basic` is required because the Frame has no keyring; it means Chrome-saved passwords are weakly encrypted on disk, so the README recommends staying logged in via cookies rather than saving passwords. The launcher never bundles Chrome or Widevine; it installs Chrome from Flathub on first run.

Out of scope: custom 3D environment, custom rendering, Steam store release, any Cast/AirPlay receiver, UA spoofing by default. Plex, Jellyfin and local files are not on the start page; they can be added later as optional tiles configured in `config.env`.

## Architecture

```
Steam library shortcut "Stream Frame"  (added via DevTools port; devkit create-shortcut as fallback)
        │ launches
        ▼
bin/stream-frame  (bash)
  1. strip gameoverlayrenderer.so from LD_PRELOAD
  2. ensure Chrome present (flatpak com.google.Chrome, else ~/.local/share/stream-frame/chrome from Google's arm64 .deb)
  3. seed profile on first run: Preferences (bookmark bar on, dark theme, no first-run), Bookmarks (service tiles),
     External Extensions/<id>.json for the Netflix 1080p extension (Web Store update URL, silent on Linux)
  4. exec chrome --ozone-platform=x11 --user-data-dir=<profile> --no-first-run --no-default-browser-check
        --password-store=basic --start-fullscreen [--user-agent=<CrOS> if experiment enabled]
        file://<install>/web/boot.html   (redirects to chrome-extension://<id>/home.html)
     (--start-fullscreen: no tab strip or address bar, the page fills the whole panel; the start page and every
      service page share that one fullscreen window, so a tile click lands directly on a full-screen service page)
  5. companion extension "Stream Frame Helper" (ours, MV3), installed silently via External Extensions from a local
     .crx (allowed on Linux). It hosts the start page and Configuration (chrome-extension://<id>/home.html, so tiles
     and key mapping share chrome.storage.local), injects a small auto-hiding Home button on every page, and runs the
     controller mapper: a content script listens for keyboard events and polls the Gamepad API (both are how Steam
     Input presents the Frame controllers to a flat app) and maps buttons to player actions
        │
        ▼
Frame controllers → Steam Input (gamepad or keyboard/mouse emulation, per the shortcut's controller layout)
        → key/gamepad events in the page → helper extension → action on the page's <video> (play/pause, seek,
          volume, mute, fullscreen) or Home (with confirmation)
        │
        ▼
Chrome window on gamescope :0  →  SteamVR panel valve.steam.desktopgame.<appid>
        →  user docks it: Float in World / View in Theater, curvature, size; passthrough or home behind it
```

Everything lives in the user's home. Nothing needs sudo. Config in `~/.config/stream-frame/config.env` (backend, UA experiment, start page, window size).

## Repository layout (to create)

```
stream_frame/
  README.md                     # what it does, quality caveats, install, uninstall
  install.sh                    # run on the Frame (SSH or Konsole): installs Chrome, copies files, seeds profile, adds shortcut + .desktop
  uninstall.sh
  bin/stream-frame              # launcher (bash), see above
  lib/steam-shortcut.py         # DevTools-port shortcut add/update/remove (rewrite of the chromium-webxr-steam-frame script, stdlib only, BSD-style upstream, keep attribution)
  lib/chrome-backend.sh         # detect/install flatpak or extracted .deb; print the command to exec
  lib/profile-seed/
    Preferences.json            # bookmark bar, dark mode, homepage, no promos
    Bookmarks.json              # service bookmarks
    external-extensions/mdlbikciddolbenfkgggdegphnhmnfcg.json
  extension/                    # "Stream Frame Helper" MV3 extension (no framework, no build step)
    manifest.json               # fixed "key" so the extension id is stable; content script on <all_urls>; storage permission
    home.html, home.css, home.js  # start page: tile grid + gear icon + Configuration (Tiles tab, Controls tab); Widevine self-check
    services.json               # the seven defaults: id, name, homepage URL, brand colour, logo file; also read by install.sh to seed bookmarks
    logos/*.svg                 # bundled logos for the defaults (Simple Icons CC0 marks or wordmarks); custom tiles fetch the site icon at runtime with a monogram fallback
    content.js                  # Home button overlay (closed shadow root), controller mapper (keyboard + Gamepad API), action dispatcher on <video>, Home confirmation overlay
    actions.js                  # per-service quirks table: how to find the video element / native shortcut fallback for Netflix, Max, Hulu, Disney+, Apple TV+, Prime Video, YouTube
  extension/build-crx.sh        # packs extension/ into stream-frame-helper.crx with the project key (private key kept out of git); install.sh writes External Extensions/<id>.json with external_crx + external_version
  web/boot.html                 # tiny file:// page Chrome starts on: redirects to chrome-extension://<id>/home.html, or shows "helper extension missing, re-run install.sh"
  input/stream-frame.vdf        # (if S6 allows) default Steam Input layout for the shortcut, gamepad mode with Menu → Home button
  assets/icon.png
  tools/frame-shot.sh           # capture the headset view for verification (OpenVR IVRScreenshots via python ctypes, pattern from frame-control, MIT)
  docs/plan.md                  # this plan
  docs/spikes/                  # S1..S6 results
  docs/quality.md               # per-service resolution table, measured
```

## Phases

### Phase 0: on-device spikes (2 to 3 days, Frame + Arcturus + service accounts)

Each spike writes `docs/spikes/S<n>.md` with a go/no-go.

- **S1 Chrome + DRM baseline.** `flatpak install --user flathub com.google.Chrome` over SSH. Launch from KDE desktop panel. For each of the seven services (Netflix, HBO Max, Hulu, Disney+, Apple TV+, Prime Video, YouTube): plays or not, max resolution (Netflix `Ctrl+Alt+Shift+D`), with and without the 1080p extension, with and without a ChromeOS UA. Record CPU and battery for 30 min of 1080p. Confirm `chrome://components` shows the arm64 Widevine. Decides the service table and the UA experiment.
- **S2 Panel + Theater.** Register a test shortcut through the DevTools port that runs Chrome with `--ozone-platform=x11` and stripped LD_PRELOAD. Confirm it appears as its own panel, laser pointer and SteamVR keyboard work, audio plays, and View in Theater plus passthrough background (Arcturus colour) work. Check whether `flatpak run` honours the x11 flag and `DISPLAY=:0` from a Steam launch; fallback is the extracted .deb.
- **S3 Panel resolution.** `DISPLAY=:0 xrandr` and Steam's Properties for the shortcut: can the panel be raised from 1280×720 to 1920×1080? Try Steam's per-app resolution setting and gamescope mode-control atoms. If stuck at 720p, document it as the ceiling and consider `--force-device-scale-factor` for readable UI.
- **S4 Provisioning.** External Extensions JSON under the custom `--user-data-dir` installs the 1080p extension silently from the Web Store, and our helper extension from a local `.crx` (`external_crx` + `external_version`); seeded Bookmarks and Preferences survive first launch; profile persists logins across launches and reboots. Also confirm `--start-fullscreen` inside a gamescope panel gives a chromeless window and that the Home button overlay shows on netflix.com and the others (some sites use aggressive z-index or CSP; the overlay uses a closed shadow root and max z-index).
- **S6 Controller events in the panel.** With the shortcut running, press each controller button and log what a test page receives: `keydown` codes, Gamepad API button indices, or nothing, under the default layout and under Steam's "Gamepad" and "Keyboard and Mouse" templates. Check whether `video.play()`/`pause()` from a content script works on Netflix and Disney+ (DRM video elements). Try to place a controller layout for the shortcut (Steam's `controller_config` folders or the DevTools `SteamClient.Input` API) so a default ships with `install.sh`. Decides the default mapping mode and whether the OpenVR+uinput fallback is needed.
- **S5 Dock memory.** Launch the shortcut, choose View in Theater, close, relaunch: does SteamVR restore the Theater dock? Same for a floated, curved panel. Result goes in the README either way.

### Phase 1: launcher MVP (about 1 week)

- `install.sh`: arch check, Chrome install (Flatpak, .deb fallback), copy files to `~/.local/share/stream-frame`, seed profile, `.desktop` entry, Steam shortcut with icon, idempotent re-runs.
- `bin/stream-frame`: LD_PRELOAD strip, backend detection, config file, exec Chrome with the flag set from S2/S3.
- Start page: logo thumbnail tiles for the seven defaults, generated from `services.json` merged with the saved configuration; each opens the service homepage in the same tab; big hit targets and a focus ring for laser-pointer use; Widevine self-check with a clear message if Chrome or the CDM is missing. Chrome's `--homepage` and new-tab point back to the start page, and the bookmark bar carries the same seven services plus Home.
- Full-screen launch: `--start-fullscreen`, verified in S4; helper extension with the auto-hiding Home button, packed by `extension/build-crx.sh` and installed by `install.sh`; the start page hides the Home button on itself.
- Controller mapper in the helper extension: keyboard and Gamepad API listeners, action dispatcher on `<video>` with the per-service quirks table, default mapping from S6, Home with confirmation overlay, ignore while typing.
- Configuration panel behind the gear icon (Tiles tab and Controls tab, the latter with press-to-capture fields and a live button indicator): reorder (up/down buttons and drag-and-drop), show/hide toggles, add tile (name, URL, optional logo URL, icon auto-fetch with monogram fallback), edit/remove custom tiles, reset to defaults. Saved to `chrome.storage.local`; a hidden default tile stays in the list so it can be shown again. Input validation: URL must be http(s); names trimmed and de-duplicated.
- `uninstall.sh`: remove shortcut (DevTools port), files, optionally the profile and the Flatpak.
- README with the honest quality table from S1.

### Phase 2: comfort features (as needed)

- OpenVR overlay + uinput input helper, only if S6 shows the panel receives no controller button events.
- Haptic tick on action (if the Gamepad API exposes vibration actuators through Steam Input).
- UA experiment toggle in config, off by default, with a note on ToS.
- Optional extra tiles (Plex, Jellyfin, local files) configured in `config.env`, off by default.
- Battery-saver preset (720p cap via the extension's settings).

## Risks

- **720p panel ceiling** if S3 finds no way to raise the nested resolution. Mitigation: document it; the Theater Screen is still large, and Netflix 720p at that size is acceptable to many. Possible later fix: a Valve setting or gamescope update.
- **Services blocking Linux or the arm64 UA** at any time. Mitigation: Chrome updates through Flatpak; keep the launcher browser-agnostic so Firefox can be swapped in once Mozilla ships arm64 Widevine (bug 1612995, still open).
- **Flatpak sandbox vs gamescope**: if the Flatpak cannot reach `:0` or breaks input, fall back to the extracted .deb in `~/.local/share`.
- **Steam UI changes** to the DevTools shortcut API. Mitigation: devkit `create-shortcut` fallback and the manual "Add a Non-Steam Game" instructions.
- **Disney+ at 480p** is a poor experience and not fixable on Linux. State it up front.

## Verification

- Phase 0 exit: Netflix and at least one other service play inside a Steam-launched panel on the Frame, with audio and pointer input, and a measured resolution table for all seven services exists in `docs/quality.md`. Theater Screen with Arcturus colour passthrough behind the panel confirmed with a headset screenshot.
- Phase 1 exit: fresh Frame (or wiped `~/.local/share/stream-frame`) → run `install.sh` over SSH → "Stream Frame" appears in the library without restarting Steam → launch → start page shows seven logo tiles, no tab strip or address bar visible → each tile opens the right homepage filling the whole panel → the Home button appears on pointer movement and returns to the start page → in Netflix playback: A pauses and resumes, d-pad seeks, Menu shows the Home confirmation, pressing again returns home, pressing anything else dismisses → in Configuration › Controls, remap play/pause to another button by pressing it, relaunch, mapping persisted → typing in the Netflix search box with mapped keys does not trigger actions → gear icon: hide Hulu, move YouTube first, add a custom tile (e.g. a Jellyfin server), relaunch and confirm the layout persisted, reset to defaults → Netflix login with the SteamVR keyboard → 30 min playback with no crash → relaunch keeps the login → reboot the headset, relaunch, still logged in → `uninstall.sh` leaves no shortcut or files (profile kept unless `--purge`).
- Start page and Configuration can be developed and tested in desktop Chrome on the Mac by loading `extension/` unpacked (Chromium or Chrome for Testing, since branded Chrome 137+ ignores `--load-extension`; the chrome://extensions "Load unpacked" button still works everywhere); the mapper can be exercised with any USB or Bluetooth gamepad. No build step.
- Headset-view captures for the README via `tools/frame-shot.sh`; SteamVR standby can be lifted with `vrcmd --set-settings-bool power.pauseCompositorOnStandby 0` for remote testing.
- ShellCheck on all scripts; a dry-run mode for `install.sh` on a non-Frame machine.

## Key references

- Chrome arm64 Linux + Widevine: https://www.omgubuntu.co.uk/2026/07/chrome-arm64-linux-available
- Flathub Chrome wrapper (aarch64, extra-data from Google's arm64 .deb): https://github.com/flathub/com.google.Chrome
- Panels, gamescope flags, dashboard docking, uinput, DevTools port (field notes, MIT): https://github.com/saphid/frame-control/blob/main/docs/panels.md and docs/how-the-frame-works.md
- LD_PRELOAD fix, x11 ozone, DevTools shortcut script: https://github.com/saphid/chromium-webxr-steam-frame (frame/chromium-xr, frame/steam-shortcut.py, docs/technical-notes.md)
- Valve devkit shortcut path: https://partner.steamgames.com/doc/steamhardware/steamframe/loadgames
- Theater Screen with passthrough: https://roadtovr.com/valve-steam-frame-review/
- Arcturus camera: https://www.uploadvr.com/steam-frame-arcturus-vision-camera-color-passthrough/
- External extensions on Linux: https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions
- Chrome 137 `--load-extension` removal: https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY
- Netflix cast removal: https://9to5google.com/2025/12/01/netflix-google-cast-support-removed/
