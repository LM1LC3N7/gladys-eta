# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for ETA wood and pellet boilers,
read only, through the local ETAtouch RESTful webservices: a Node.js service
(Node 22+, ESM, no build step) that runs in its own sandboxed Docker container
and talks to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.
`TODO.md` holds the status, the decisions and the notes on commands.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "errors"  # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run cover                             # regenerates cover.png
npx github:GladysAssistant/integration-store .   # store admission checks
```

## Architecture

```
index.js                          SDK wiring only
src/handlers.js                   SDK handlers -> EtaApp (shared with the tests)
src/app.js                        lifecycle, cycles, failures, errors, devices, badges
src/catalog.js                    discovery: API version, menu, varinfo, values
src/client.js                     one GET at a time, 100 ms apart, statuses
src/http.js                       bounded GET, errors without the address
src/xml.js                        bounded, linear XML reader (no dependency)
src/eta.js                        the answers: menu, values, varinfo, errors (pure)
src/devices.js                    variables -> Gladys devices and states (pure)
src/config.js                     config_schema normalized (address checks)
src/store.js                      /data: last attempt, pause, catalog, errors seen
src/publisher.js                  states and scene events within Gladys' limits
gladys-assistant-integration.json manifest
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, SDK's fake Gladys, fake ETAtouch, test/kit clocks
```

## Rules

- **Read only.** GET only, no feature writable, `onSetValue` refuses every
  command, no switch or thermostat. Commands would go behind an option off
  by default, the stop never blocked (see `TODO.md`).
- **No password on the device side**: say it in the docs; keep the address
  checks (no path, broadcast, multicast, unspecified).
- **The answers are untrusted.** Bounded size and XML, own attributes only,
  strict numbers, invalid markers never published, linear parsing.
- **Careful reads.** One request at a time; one cycle per interval whatever
  asks for it (dated in `/data` before its first request); backoff and 429
  pause in `/data`.
- **Two clocks.** Wall clock for `/data` only; decisions on the monotonic
  clock, read once per decision.
- **External ids are forever.** `ext:<selector>:eta:<node>-<fub>` and
  `:<fkt>-<io>-<var id>`, `ext:<selector>:eta:errors` and its roles. A
  republished device never loses a feature.
- **The container rootfs is read-only.** Write only under `/data`.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md`. Never write a version heading.
- **User-facing text** is bilingual (English and French), docs kept in sync.
- **Files** are UTF-8 without BOM (`test/encoding.test.js`).
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network (loopback only).
