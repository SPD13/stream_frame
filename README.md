# Stream Frame

Watch Netflix, HBO Max, Hulu, Disney+, Apple TV+, Prime Video and YouTube standalone on the
**Valve Steam Frame**, on a cinema-sized SteamVR panel, in the dark home space or over colour
passthrough.

Stream Frame is a launcher, not a player. It installs Google Chrome for ARM64 Linux (the only
browser on the Frame with Widevine DRM), gives it a dedicated profile tuned for a headset, and
adds a **Stream Frame** entry to your Steam library. Launch it and Chrome opens full screen on a
start page of service tiles. SteamVR's dashboard does the rest: *View in Theater*, *Float in
World*, curvature, size, passthrough behind it.

> **Status:** the code is complete and tested on a Mac, but has **not yet been run on a Steam
> Frame**. The on-device checks in [`docs/spikes/`](docs/spikes/README.md) verify the assumptions
> it rests on (extension provisioning, panel mapping, controller events, resolution). Expect
> adjustments after the first on-device run.

**Contents:** [Picture quality](#picture-quality-read-this-first) ·
[Requirements](#requirements) · [Build](#build) · [Install on the Steam Frame](#install-on-the-steam-frame) ·
[Update and uninstall](#update-and-uninstall) · [Use](#use) · [Troubleshooting](#troubleshooting) ·
[Develop and test on a computer](#develop-and-test-on-a-computer) · [How it works](#how-it-works)

## Picture quality: read this first

Linux Chrome gets Widevine L3 only, so every service caps its resolution. This applies to any
browser-based solution on the Frame:

| Service | Expected maximum |
|---|---|
| Netflix | 720p; 1080p with the *New Netflix 1080p* extension (installed automatically) |
| HBO Max | unknown; historically blocked Linux, reports contradictory |
| Hulu | plays; cap unconfirmed |
| Disney+ | **480p**, enforced for Linux browsers; not fixable |
| Apple TV+ | 480p to 720p |
| Prime Video | 480p to 540p |
| YouTube | full resolution (no DRM on normal videos) |

No 4K, no HDR. The SteamVR panel is 1280×720 by default, so anything above 720p is downscaled
unless spike S3 finds a way to raise it. Measured results will land in
[`docs/quality.md`](docs/quality.md).

Chrome decodes video in software on the Frame's ARM64 CPU. Battery life is 1 to 1.5 hours;
plug in the charger for a film.

## Requirements

**Steam Frame** (SteamOS 0.3.0 or later):

- Developer Mode enabled, for SSH access.
- Internet access (the installer downloads Google Chrome from Flathub or Google).
- About 1 GB free in `/home` for Chrome and the profile. Nothing is written to the read-only `/`.

**Build machine** (macOS or Linux), from which you build the helper extension and copy the
project to the Frame:

| Tool | Needed for |
|---|---|
| `git` | getting the source |
| `python3` (3.9+) and `openssl` | building and signing the helper extension (`extension/build-crx.sh`) |
| `ssh` and `rsync` | copying the project to the Frame |
| Pillow (`pip install pillow`) | *optional:* re-rendering the service tiles |
| Node.js 22+ | *optional:* the automated end-to-end test |
| ShellCheck | *optional:* linting the shell scripts |

## Build

Stream Frame has no compile step. The only build artefact is the **helper extension package**,
`dist/stream-frame-helper.crx`, which the installer registers with Chrome on the Frame.

### 1. Get the source

```sh
git clone https://github.com/SPD13/stream_frame.git
cd stream_frame
```

### 2. Put the signing key in place

The `.crx` is signed with an RSA key, and the key determines the extension id,
`cjgndomenjkjikknkabepmobpflkbchl`. The start page URL, the boot page and the profile all refer to
that id. The private key lives at `extension/key.pem` and is **never committed** (see
`.gitignore`); keep a backup outside the repository, for example in a password manager.

- **You are the maintainer:** copy your backed-up key to `extension/key.pem`
  (`chmod 600 extension/key.pem`).
- **You are building your own fork:** generate a new key. This rewrites the `"key"` field in
  `extension/manifest.json` and gives your build a **different extension id**. The installer and
  launcher derive the id from the manifest, so everything keeps working:

  ```sh
  extension/build-crx.sh --new-key
  ```

  Commit the changed `manifest.json` only if the fork should keep that id for good.

### 3. Build the extension package

```sh
extension/build-crx.sh
# build-crx: wrote dist/stream-frame-helper.crx (id cjgndomenjkjikknkabepmobpflkbchl, version 1.0.0)
```

The script zips `extension/` (skipping the key and itself), signs it in the CRX3 format with
`openssl`, and refuses to build if the key does not match the manifest. Bump `"version"` in
`extension/manifest.json` whenever you ship a change, so Chrome on the Frame picks up the update.

`install.sh` rebuilds the package automatically when it finds `extension/key.pem`, so on the
build machine this step mostly matters when you want to check the package before copying it.

### 4. Optional: regenerate artwork

The service tiles in `extension/logos/*.png` are rendered from the source icons in
`assets/raw_icons/`. After replacing a source icon:

```sh
python3 -m pip install pillow        # once; a virtualenv is fine
python3 tools/make-tiles.py          # writes extension/logos/<service>.png (960×540)
```

Per-service background colour, fit mode and scale are listed at the top of
`tools/make-tiles.py`. The app icon (`assets/icon.png`, `extension/icons/icon128.png`) is drawn by
`python3 tools/make-icon.py` (stdlib only).

### 5. Optional: verify before deploying

```sh
shellcheck -x install.sh uninstall.sh bin/stream-frame lib/*.sh tools/*.sh extension/build-crx.sh
./install.sh --dry-run               # prints every install step; safe on any machine
```

For the automated browser test, see [Develop and test on a computer](#develop-and-test-on-a-computer).

## Install on the Steam Frame

### 1. Enable SSH on the Frame

1. In the headset: **Settings → System → Developer Mode**, turn it on.
2. Switch to desktop mode, open **Konsole**, and set a password for the `steamos` user (SSH
   needs one):

   ```sh
   passwd
   ```

3. If SSH is not already running, start it and keep it enabled across reboots:

   ```sh
   sudo systemctl enable --now sshd
   ```

4. Note the headset's IP address: **Settings → Internet →** your network. Below it is written
   `<frame-ip>`.

Check from the build machine that you can log in:

```sh
ssh steamos@<frame-ip>
```

Menu names on the Frame may differ slightly from the above; the goal is simply SSH access as
the `steamos` user.

### 2. Copy the project to the Frame

From the repository folder on the build machine, after [building](#build) the extension package:

```sh
rsync -av --exclude '.git' --exclude 'extension/key.pem' --exclude 'tests/out' --exclude '.DS_Store' \
  ./ steamos@<frame-ip>:stream_frame/
```

This copies `dist/stream-frame-helper.crx` along with the sources. The private signing key stays
on the build machine.

> Cloning with `git` directly on the Frame also works, but `dist/` is not in the repository:
> copy the package over separately with
> `scp dist/stream-frame-helper.crx steamos@<frame-ip>:stream_frame/dist/`.

### 3. Run the installer

```sh
ssh steamos@<frame-ip>
cd stream_frame
./install.sh --dry-run     # optional: shows every step without changing anything
./install.sh
```

No sudo is needed. The installer:

1. **Installs Google Chrome**, from Flathub (`com.google.Chrome`, as a `--user` install), or from
   Google's arm64 `.deb` extracted into `~/.local/share/stream-frame/chrome` if Flatpak fails.
   It grants the Flatpak access to `~/.local/share/stream-frame`.
2. **Copies Stream Frame** to `~/.local/share/stream-frame` (launcher, libraries, extension, boot
   page, icon, and the extension package into `dist/`).
3. **Seeds a dedicated Chrome profile** at `~/.local/share/stream-frame/profile`: no first-run
   screens, password saving off, bookmarks for the services, and two extensions registered to
   install on first launch: the Stream Frame Helper (from the local `.crx`) and *New Netflix
   1080p* (from the Chrome Web Store).
4. **Creates the settings file** `~/.config/stream-frame/config.env` if there is none.
5. **Adds a desktop entry** (`~/.local/share/applications/stream-frame.desktop`).
6. **Adds the Stream Frame shortcut to the Steam library** through the Steam client's local
   DevTools port, without restarting Steam.

Installer options:

| Option | Effect |
|---|---|
| `--backend=flatpak` / `--backend=deb` | force a Chrome backend (default: Flatpak, `.deb` as fallback) |
| `--no-shortcut` | do not add the Steam library shortcut |
| `--no-netflix-1080p` | do not register the *New Netflix 1080p* extension |
| `--enable-cef-debugging` | if Steam's DevTools port is closed, enable it (then restart Steam and re-run) |
| `--dry-run` | print what would be done; runs on any machine |
| `--force` | skip the aarch64 architecture check |

**If the library shortcut could not be added**, the installer says so. Either re-run with
`--enable-cef-debugging`, restart Steam and run `./install.sh` again, or add it by hand: desktop
mode → Steam → **Games → Add a Non-Steam Game to My Library → Browse** →
`~/.local/share/stream-frame/bin/stream-frame`, then rename the entry "Stream Frame".

### 4. First launch

1. In the headset, open **Stream Frame** from the Steam library. Chrome opens full screen on the
   start page, as its own SteamVR panel.
2. Open the SteamVR dashboard on that panel and choose **View in Theater** or **Float in World**;
   curvature and size are there too.
3. Choose passthrough (colour with the Arcturus camera) or the dark home space in SteamVR
   settings.
4. Pick a service and log in with the SteamVR keyboard. Logins persist across relaunches and
   reboots.

## Update and uninstall

**Update:** close Stream Frame, bump `"version"` in `extension/manifest.json` if the extension
changed, then repeat [copy](#2-copy-the-project-to-the-frame) and `./install.sh`. Logins, tiles
and button mappings are kept.

**Uninstall** (on the Frame):

```sh
~/.local/share/stream-frame/uninstall.sh                  # keeps the profile (logins, tiles, mapping)
~/.local/share/stream-frame/uninstall.sh --purge          # deletes everything, including logins
~/.local/share/stream-frame/uninstall.sh --remove-chrome  # also removes the Chrome Flatpak
```

`--dry-run` shows what would be removed.

## Use

- **Start page:** point at a tile and click, or use the d-pad and A. The service opens full
  screen in the same window.
- **Home button:** a round button in the bottom-left corner of every page. It appears when you
  move the pointer and fades after 3 seconds. Alt+Left on the SteamVR keyboard also goes back.
- **Logins** persist in the dedicated profile for as long as each service keeps its session.
  Chrome runs with `--password-store=basic` because the Frame has no keyring, so saved passwords
  would be weakly encrypted: stay logged in rather than letting Chrome save passwords (password
  saving is off by default).

### Controller

The Frame's controllers reach a non-VR app through Steam Input, either as a gamepad or as
keyboard/mouse, depending on the shortcut's controller layout. The helper extension listens to
both:

| Action | Gamepad | Keyboard mode |
|---|---|---|
| Play / pause | A | Space |
| Seek back / forward | D-pad or left stick ← / → | ← / → |
| Volume up / down | D-pad or left stick ↑ / ↓ | ↑ / ↓ |
| Mute | Y | M |
| Fullscreen | X | F |
| Home | Menu | Escape (hold) |

Home asks *Return to Stream Frame home?*: press the same button again within 3 seconds, or click
Yes; anything else cancels. Mapped keys are ignored while a text field has focus, so typing in a
search box is never hijacked.

### Configuration

The gear icon on the start page opens **Configuration**:

- **Tiles:** reorder (drag rows, or ▲ ▼), show or hide, add a tile for any site (name, URL,
  optional logo URL), edit or remove your own tiles, reset to the default seven.
- **Controls:** click **+ Assign** and press a controller button or key to map it (up to four per
  action; assigning a button moves it from any other action). The *Receiving* strip shows what
  the page receives and whether the controller is in gamepad or keyboard mode. Also: seek step
  (5/10/30 s), volume step, Home confirmation on or off, reset to defaults.

Both are saved in the profile (`chrome.storage.local`) and survive relaunches and reboots.

### Launcher settings

`~/.config/stream-frame/config.env` (documented in
[`lib/config.env.example`](lib/config.env.example)):

| Setting | Default | Meaning |
|---|---|---|
| `CHROME_BACKEND` | `auto` | `flatpak`, `deb`, or `auto` (Flatpak if installed) |
| `WINDOW_SIZE` | `1280,720` | Chrome window size; matches the default panel size |
| `SCALE_FACTOR` | empty | UI scale, e.g. `1.25` for larger text |
| `START_URL` | empty | start somewhere other than the start page |
| `UA_EXPERIMENT` | `0` | `1` presents a ChromeOS user agent (ToS grey area) |
| `TAG_WINDOW` | `auto` | set the panel mapping property if gamescope did not; `0` never |
| `EXTRA_FLAGS` | empty | extra Chrome flags |

## Troubleshooting

| Symptom | What to do |
|---|---|
| Nothing happens when launching | Read `~/.local/state/stream-frame/launcher.log`. |
| Chrome does not appear, or has no panel of its own | Re-install with `./install.sh --backend=deb` to use Google's own Chrome instead of the Flatpak. |
| "Stream Frame Helper is not installed" | Re-run `./install.sh`. If Chrome showed a "New extension added" notice, choose *Enable*. Otherwise open `chrome://extensions`, turn on *Developer mode*, *Load unpacked* → `~/.local/share/stream-frame/extension`. |
| Red "Widevine DRM is not available" banner | Chrome is missing or the DRM component is not loaded yet: open `chrome://components`, update *Widevine Content Decryption Module*, relaunch. Chromium does not work; it has no Widevine. |
| Shortcut missing from the library | See [Run the installer](#3-run-the-installer) for `--enable-cef-debugging` or adding it by hand. |
| Controller buttons do nothing | Open the gear icon → Controls: the *Receiving* strip shows whether any input reaches the page. Change the shortcut's controller layout in Steam (gamepad or keyboard/mouse). |
| Headset screenshot for a bug report | From the build machine: `tools/frame-shot.sh steamos@<frame-ip>`. |

## Develop and test on a computer

Everything that runs in the browser (start page, Configuration, Home button, controller mapping,
and real DRM playback) can be tested in desktop Google Chrome. Use a **separate profile**: the
extension replaces the new-tab page, and a separate profile keeps that out of your everyday
browser.

1. Open Chrome with a dedicated profile, at the panel's size (macOS shown; on Linux call
   `google-chrome` with the same flags):

   ```sh
   open -na "Google Chrome" --args --user-data-dir="$HOME/.stream-frame-dev" \
     --window-size=1280,720 --no-first-run chrome://extensions
   ```

2. Turn on **Developer mode** (top right), click **Load unpacked**, and select the repository's
   **`extension`** folder (the one containing `manifest.json`, not the repository root).
3. Later sessions can open the start page directly (add `--start-fullscreen` for the chromeless
   look):

   ```sh
   open -na "Google Chrome" --args --user-data-dir="$HOME/.stream-frame-dev" \
     --window-size=1280,720 chrome-extension://cjgndomenjkjikknkabepmobpflkbchl/home.html
   ```

4. After editing the code, click the reload arrow on the extension's card in
   `chrome://extensions`, then reload the page.

Any USB or Bluetooth gamepad exercises the controller mapper: press a button, then watch the
Controls tab's *Receiving* strip. Picture quality on a desktop is higher than on the Frame, so
do not judge resolution there.

### Automated end-to-end test

`tests/e2e.mjs` drives the extension in **Chrome for Testing** over the DevTools protocol (branded
Chrome 137+ ignores `--load-extension`). It checks the boot redirect, the start page and tiles,
Configuration (tiles and controls), persistence, the keyboard mapper on a local video page,
fullscreen, typing protection, and the Home confirmation and button: 36 checks.

```sh
npx @puppeteer/browsers install chrome@stable            # prints the Chrome for Testing path
CHROME=/path/to/chrome-for-testing node tests/e2e.mjs    # Node 22+
```

Screenshots are saved in `tests/out/`. Gamepad input is not simulated, and Chrome for Testing has
no Widevine, so use desktop Chrome for real playback.

## How it works

```
Steam library shortcut "Stream Frame"
  → bin/stream-frame: strips gameoverlayrenderer.so from LD_PRELOAD (it crashes Chrome),
    picks the Chrome backend, execs Chrome with --ozone-platform=x11 on gamescope's :0,
    --user-data-dir=~/.local/share/stream-frame/profile, --start-fullscreen, --password-store=basic
  → web/boot.html → chrome-extension://<id>/home.html (start page, from the helper extension)
  → gamescope gives the window its own SteamVR panel: valve.steam.desktopgame.<appid>
    (lib/tag-window.sh sets STEAM_GAME on the window if gamescope did not map it itself)
```

| Path | What |
|---|---|
| `install.sh`, `uninstall.sh` | install / remove; `--dry-run` works anywhere |
| `bin/stream-frame` | launcher; `--print-command` shows the Chrome command line |
| `lib/chrome-backend.sh` | Flatpak / `.deb` detection and install |
| `lib/steam-shortcut.py` | library shortcut through Steam's DevTools port (stdlib WebSocket client) |
| `lib/seed-profile.py`, `lib/profile-seed/` | Preferences, Bookmarks, External Extensions |
| `lib/tag-window.sh` | STEAM_GAME fallback for panel mapping |
| `lib/config.env.example` | launcher settings template |
| `extension/` | *Stream Frame Helper* (Manifest V3, no build step): start page, Configuration, Home button, controller mapper |
| `extension/actions.js` | per-service quirks (Netflix goes through its player API via `bridge-netflix.js`) |
| `extension/build-crx.sh` | packs and signs the `.crx` |
| `web/boot.html` | first page; redirects to the start page or explains how to fix a missing helper |
| `assets/raw_icons/`, `tools/make-tiles.py` | source icons and the tile renderer |
| `tools/make-icon.py` | app icon renderer |
| `tools/frame-shot.sh` | headset-view screenshot over SSH (OpenVR IVRScreenshots) |
| `tests/` | end-to-end test and its local player page |
| `input/` | placeholder for a default Steam Input layout (pending spike S6) |
| `docs/plan.md`, `docs/spikes/`, `docs/quality.md` | plan, on-device spike worksheets, measured quality |

## Logos and trademarks

Netflix, HBO Max, Hulu, Disney+, Apple TV+, Prime Video and YouTube are trademarks of their
owners; Stream Frame is not affiliated with them or with Valve.

The built-in tiles in `extension/logos/*.png` are rendered from the icons in `assets/raw_icons/`.
Tiles you add yourself use the logo URL you give; without one, the start page uses the site's own
icon (`/apple-touch-icon.png`, then `/favicon.ico`) on a light plate, and a monogram if the site
serves neither.

## Credits

- Panel, gamescope, DevTools-port and uinput field notes: [saphid/frame-control](https://github.com/saphid/frame-control) (MIT).
- LD_PRELOAD fix, x11 ozone flag and the DevTools shortcut approach:
  [saphid/chromium-webxr-steam-frame](https://github.com/saphid/chromium-webxr-steam-frame); `lib/steam-shortcut.py` is a rewrite of its `frame/steam-shortcut.py`.
