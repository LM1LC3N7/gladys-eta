# TODO — ETA v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Status

- [x] **Milestone 1 — core, read only** (2026-10-27): ETAtouch RESTful
      webservices (API 1.2, reduced mode before), discovery of the menu
      ("main" values by id, or "all"), one device per block, cycles reading
      only the created features, errors device and `eta_error` scene
      trigger, careful reads (one request at a time, interval kept across
      restarts, button and Discovery), backoff and 429 pause in `/data`,
      badges, test button, en/fr, docs, cover. Tested against the recorded
      answers of a PE-K (reference fixtures) only, Node 22 and 24.
- [x] **Review r1 fixes** (2026-10-27, review of 93325eb): getConfig() retried
      without end with a status; the error list read apart (its failure never
      stops the values); numbers only when strValue shows the same number
      (texts, time slots never 0), unit checked for "number" too (catalog,
      else the name suffix); lifetime counters never 0 nor going back; status
      when every variable fails; menu over the element limit = "too large";
      Retry-After against the Date header; response uri checked; gap counted
      from the end of the previous request; docs (identity, /data not
      writable, errors coming back, menu limits); tests for the bounds.
- [ ] **Review r2**.
- [ ] **Milestone 2 — real boiler**: run against a real ETAtouch (see "To
      check"), complete the main ids (buffer tank, solar, room temperature).
- [ ] **Milestone 3 — commands?** Only if Louis wants them, behind an option
      off by default, never as a switch (see "Commands, not in v1").
- [ ] **Milestone 4 — first release**: Docker image, Release workflow, topic,
      GHCR package public.

## To check on a real boiler

- The answer of a disabled LAN access (connection refused? 403?), of an
  unknown variable (404 or `<eta><error>`?).
- How long `/user/menu` and one `/user/var` take, and whether 100 ms between
  two requests is gentle enough for weeks (the reference sends 5 in
  parallel).
- The main ids on other boilers (PU, SH, HACK, buffer tank `Puffer`, solar,
  room sensors) and their units (`s` for the hours on every firmware?).
- `/user/errors` with errors present: `priority` values in German and
  English, `time` always given?
- The answer of an API 1.1 ETAtouch to `/user/api` (reduced mode).

## Commands, not in v1

The API can write (`POST /user/var/<uri>` with the raw value; time slots
with `begin`/`end`). The writable variables of a PE-K include the boiler's
on/off button (`12080`), the de-ashing button (`12112`), "charge hot water
now" (`12134`), the circuits' mode buttons (`12125`, `12126`, `12230`,
`12218`, `12231`), setpoints and many installer parameters (burner lock,
calibration, sensor types). A v2 would have to: allow only a short list by
id, behind an option off by default (the stop never blocked), never as a
switch, bounds from varinfo and our own (hot water 55 °C by default, 60 °C
at most on the value written), success only after a read back showing the
value, one request at a time with the reads.

## Decisions

- **Not a duplicate** (lot 17, line 3 of `_lots/lot17/proposition.md`):
  "absent du suivi"; the reservation checks are the main session's.
- **Reference reused: Tidone/homeassistant_eta_integration 1.4.2** (MIT,
  LICENSE in the name of Joakim Sørensen @ludeeus, the template's author,
  quoted as is), cloned read only in `~/code/ref/lot17/homeassistant_eta_integration`
  (commit 003aaff). Python: ported, credited in the README and
  `THIRD_PARTY_NOTICES.md` (full MIT notice). Its recorded answers of a PE-K
  are the test fixture (`test/fixtures/pek.json`, a subset, unchanged). The
  interface itself was read in the manufacturer's document "ETAtouch RESTful
  Webservices" 1.2 (downloaded from meineta.at to
  `~/code/ref/lot17/eta-doc/eta-rest-v1.2.pdf`). Only runtime dependency:
  the SDK (no XML library: a bounded reader in `src/xml.js`).
- **Neighbour modules**: gladys-oekofen (pellet boiler, local, read only)
  for the structure (app, client, http, store, publisher, handlers) and
  gladys-ta-cmi (frozen feature shapes read from Gladys); clock rules of
  gladys-iskra 7ea6ab1 and the fiche.
- **Read only (v1)**: an ETA boiler is a flame appliance; the API writes
  without any authentication; every writable variable is an installer
  setting or a command whose effect was never seen. Every feature
  `read_only`, `onSetValue` refuses every command (nothing sent), no
  switch, no thermostat, no scene action, no boolean option, GET only (even
  the variable sets of `/user/vars`, which are created by a PUT, are not
  used).
- **No password**: the API has none; the docs and the config screen say it
  plainly and ask to keep port 8080 on the LAN. The address field refuses a
  path, credentials, control characters, broadcast, multicast and the
  unspecified addresses.
- **Variables**: "main" = a fixed set of variable ids (`MAIN_VARIABLES`,
  `/<node>/<fub>/0/0/<id>`), the same ids on every ETAtouch (the document's
  12153 "Full load hours" is the PE-K's); "all" = every object of the menu
  (800 at most, 400 features, 10 min). Only the features created in Gladys
  are read in a cycle (300 at most): "all" costs nothing until devices are
  added.
- **Kinds** (reference): text when varinfo says TEXT (reduced mode: a text
  offset and no unit); the unit of the value wins over varinfo's; °C ->
  `temperature-sensor/probe` (-100..1500), bar and Pa -> `pressure-sensor`,
  s -> `duration` in hours, the reference's float units and kWh, MWh, K, l/h,
  min, h -> `unknown/decimal` with the unit in the name; unitless DEFAULT
  numbers -> `unknown/decimal`; time slots, times of day, dates -> left out.
  A value whose unit is no longer the feature's gets no state. kW/kWh are
  never energy features (heat, not electricity).
- **Invalid values** (reference): strValue `xxx`, `---`, `--`, `-` or empty =
  no state, never 0; numbers strict (raw must be a decimal number, scale a
  positive integer). A number is published only when strValue shows the same
  number (`-12,5`, `12.5`, for seconds `6940h 41m` / `2m 15,0s`) within its
  rounding; when the raw value lost digits (`2.49865e+07`) the number shown
  is kept (review r1, minor 7). The unit of a "number" feature is the
  catalog's, else the suffix of its name; a feature renamed without a
  catalog only reads unitless values.
- **Lifetime counters** (12016, 12153, 12017, 12018 and kWh/MWh numbers):
  never 0, never below the highest value of this run or the one Gladys
  holds (counters reset by design, "since the service", are not in the list).
- **External ids**: `ext:<selector>:eta:<node>-<fub>` and
  `:<fkt>-<io>-<var id>`; errors device `ext:<selector>:eta:errors`
  (`alarm`, `error-count`, `last-error`). The ETAtouch has no serial number
  in the API (the boiler's is a variable, not read); one integration reads
  one ETAtouch; an IP change keeps the devices; another ETAtouch at a new
  address gets a new catalog and memory (keyed by a hash of address and
  port).
- **How a variable is read** is decided by its Gladys feature (address in
  the external id, category, unit), never by `/data`: a lost or unreadable
  `/data` changes nothing for the created devices; a republished device
  keeps every created feature (shape copied from `gladys.devices`).
- **Careful reads**: one request at a time (queue), 100 ms after the end of the previous one, 10 s
  timeout (30 s for the menu), `Connection: close`, no pipelining. A cycle
  starts at most once per interval, dated (`begin`) in memory and in `/data`
  before its first request; the test button and Discovery never start one
  sooner (they wait for max(30 s, interval) since the last attempt); a
  restart waits for the rest of the interval (a date in the future, or an
  unreadable `/data`: a full interval). A failed save of `/data` is logged
  once and does not stop the reads (read only: nothing sensitive depends on
  it). A new address or port is another ETAtouch: its first read is at once.
- **Failures**: backoff 1, 2, 5, 10, 15 min, never under the interval; 429:
  Retry-After within 60 s to 6 h (5 min when absent), for every path; both in
  `/data`, capped when read back. 401/403 are `forbidden` (LAN access off),
  404 on a resource `not_found`: a backoff, never a stop (no credentials to
  refuse).
- **Clocks**: `now` (wall) only for `/data` dates and Retry-After dates;
  `monotonic` for the cycles, pauses, cooldowns, freshness and the state
  limits of the publisher; one read of the clock per decision (`dueAt(mono)`).
- **Errors and scene trigger**: key `block|time|msg`; keys seen kept in
  `/data` (200); a key never seen fires, one that stays or comes back does
  not; the very first read without memory only learns; 5 events per read at
  most.
- **Freshness**: a device created gets the values of the last two intervals
  at most, never older; a reconnection to Gladys resends status, Discovery
  and badges and reads nothing.
- **The test button** answers within 90 s (the action's timeout is 120 s); a
  long first discovery goes on after it.
- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (the template's 1.0.0 had to be
  replaced); the first patch release gives 0.1.1. SDK `^0.16.0` (the latest,
  checked on the registry on 2026-10-27).
- **Manifest**: `gladys_version >=5.1.0` (scene trigger), category
  `climate`, no `keywords`/`countries`.
- **LICENSE**: the standard Apache-2.0 text (appendix placeholder, no
  personal name); `THIRD_PARTY_NOTICES.md` with the full MIT notice; both
  copied into the image.
- **Cover**: `cover.png` 800×534 generated by `scripts/cover.mjs` (plain
  Node).
- **Template demo files removed** (devices, scenes, widgets, weather and
  their tests).
