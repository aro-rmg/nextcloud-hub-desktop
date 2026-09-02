# Changelog

## 1.5.0

- Cross-platform support: Windows, macOS and Linux builds.
- Repository restructured (`src/main`, `src/preload`, `src/renderer`), build
  configuration moved to `electron-builder.yml`.
- Electron updated to 43 and electron-builder to 26, clearing all reported
  dependency vulnerabilities.
- Fixed two calls broken by newer Electron: the `console-message` signature
  change (screen-share picker) and `clearStorageData` storage names (sign-out).

## 1.4.0

- Calls are intercepted before Talk joins, so no duplicate session is created.
- The call popup advances to the device-check dialog on its own; starting the
  call stays a manual confirmation.
- All Talk matching is structural, with no dependency on interface language.

## 1.3.0

- Talk calls open in a dedicated window containing only the call and its chat.
- The window closes as soon as the call ends.

## 1.2.0

- Multiple servers, each with an isolated session, usable simultaneously.
- Sign out of a server without removing it.

## 1.0.0

- Initial release: the Nextcloud Hub web interface in a standalone window.
