# Nextcloud Hub Desktop

An unofficial desktop client that runs the complete Nextcloud Hub web interface
in its own window, with Talk calls detached into a separate popup.

Nothing is reimplemented. The app loads your instance as-is, so Files, Talk,
Calendar, Contacts, Mail, Deck and Office all behave exactly as in a browser.

Windows, macOS and Linux.

## Why

**Talk takes over the page during a call.** You cannot open Files or Calendar
without dropping the call. This client moves the call into its own window and
leaves the main one free.

## Install

```sh
npm install
npm start                # run it
npm run dist             # package for the current platform
```

`npm run dist:win`, `dist:mac` and `dist:linux` target a specific platform.
Artifacts land in `dist/`: NSIS installer and portable `.exe` on Windows,
`.dmg` and `.zip` on macOS, AppImage, `.deb` and `.rpm` on Linux.

Requires Node.js 20 or later. Builds are unsigned, so Windows SmartScreen and
macOS Gatekeeper will warn on first launch.

## Use

On first launch, add your server address. The app checks `/status.php` before
saving. Sessions persist across restarts.

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd+Shift+S` | Manage servers |
| `Ctrl/Cmd+Shift+1..9` | Switch server |
| `Alt+Left` / `Alt+Right` / `Alt+Home` | Back / Forward / Home |
| `Ctrl/Cmd+R` | Reload |
| `Ctrl/Cmd+N` | New window |

In the server manager, **Sign out** clears one server's session and returns to
its login page; **Remove** drops the server entirely. Neither affects the others.

## How calls work

When you press Join, the click is stopped before Talk acts on it, so no call
starts in the main window. The main window leaves the conversation, then a popup
opens on it and advances to Talk's device-check dialog. You confirm there to
start the call. When the call ends, the popup closes and the main window stays
where it is.

This sequencing is not cosmetic. Talk grants one session per conversation per
login, and both windows share a cookie jar, so two windows on the same
conversation make Talk invalidate one with *Duplicate session*. Only the popup
ever joins.

Because the popup owns the conversation during a call, the chat lives there
rather than in the main window.

## Configuration

`config.json`, reachable from **File > Open configuration file**:

| Key | Default | Effect |
|---|---|---|
| `interceptCallStart` | `true` | stop calls starting in the main window |
| `autoJoinInCallWindow` | `true` | popup advances to the device dialog |
| `confirmDeviceDialog` | `false` | popup also confirms, starting the call |
| `mainWindowAfterDetach` | `talk-list` | `talk-list`, `dashboard`, `files`, `stay` |
| `returnToConversationOnCallEnd` | `false` | reopen the conversation afterwards |
| `minimalCallWindow` | `true` | strip Hub chrome from the popup |
| `callWindowBackground` | `#f5f5f5` | set dark if your theme is dark |
| `minimizeToTray` | `true` | closing hides instead of quitting |

Each server entry also takes `additionalHosts`, needed when Collabora, the Talk
signalling server or Jitsi run on a separate subdomain, and
`allowInsecureCertificates` for self-signed setups.

## Layout

```
src/
├── main/         main process: windows, routing, permissions, menu, tray
├── preload/      bridges, including the Talk observer (talk-bridge.js)
└── renderer/     server manager and error pages
```

Two preloads exist on purpose. `preload/nextcloud.js` requires a relative
module, which a sandboxed preload cannot do, so its windows set
`sandbox: false`. Local pages may run sandboxed and load `preload/local.js`,
which requires nothing but `electron`.

`contextIsolation` is on, `nodeIntegration` off, `webview` blocked. Media
permissions are granted only to the declared hosts of the server owning that
window.

## Limitations

- **Talk internals are not a public API.** Call detection uses Talk's Vuex store
  and its `join-call` / `leave-call` classes. Everything version-sensitive lives
  in `SELECTORS` at the top of `src/preload/talk-bridge.js`. Nothing matches
  visible text, so interface language does not matter.
- **The popup layout is CSS over Talk's markup.** Set `minimalCallWindow: false`
  to keep the full interface if a Talk release breaks it.
- **Electron API drift.** `console-message` changed signature in Electron 37 and
  `clearStorageData` changed its arguments. Re-test screen sharing and sign-out
  after a major Electron bump.
- TURN and signalling errors in the console come from your instance's WebRTC
  configuration, not from this client.
- No auto-update.
