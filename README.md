# gladys-eta

[Gladys Assistant](https://gladysassistant.com) external integration for
**ETA** wood and pellet boilers with the **ETAtouch** display, through the
official local **ETAtouch RESTful webservices** (API 1.2, reduced mode
before), **read only**: states, temperatures, pressure, pellet stock and
consumption, counters, active errors and a scene trigger on a new error.
Unofficial, not affiliated with ETA.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

> **Work in progress (milestone 1).** Never tested with a real boiler: tested
> against the recorded answers of a PE-K only.

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (EtaApp) ⇄ src/client.js ⇄ http://<ip>:8080/user/...
                                   ├─ src/catalog.js    discovery: /user/api, /user/menu, varinfo, values
                                   ├─ src/eta.js        the answers (pure), src/xml.js bounded XML reader
                                   ├─ src/devices.js    -> Gladys devices and states (pure)
                                   ├─ src/store.js      /data: last attempt, pause, catalog, errors seen
                                   └─ src/publisher.js  300 states and scene events/min
```

- **Webservices**: GET only (`/user/api`, `/user/menu`, `/user/varinfo/…`,
  `/user/var/…`, `/user/errors`); never a POST of a value nor a PUT of a
  variable set. They have no authentication (the manufacturer's design):
  documented, LAN only.
- **Discovery** (`src/catalog.js`): the API version, the menu (2 MB, 30 s,
  800 objects), then for the variables chosen ("main": a fixed list of
  variable ids, the same on every ETAtouch; "all": every object) varinfo
  (API 1.2) and the value, one request at a time, classified into a kind
  (temperature, pressure, hours, number, text; time slots and times of day
  left out). Bounded to 10 minutes ("partial" past it). Kept in `/data`; read
  again on a Discovery scan (at most every 10 min, at the next cycle) or when
  the "variables" option changes.
- **Cycles**: every interval (60 s by default, 60 to 3600): `/user/errors`,
  then the variables of the features created in Gladys only (300 at most),
  one request at a time. A variable that fails (404, `<error>`, 5xx, broken
  value) misses its value only; the ETAtouch gone (network or timeout twice
  in a row, 429) ends the cycle, and the next one starts after the variable
  it stopped at (no variable starved).
- **Clocks**: the wall clock only dates `/data`; the cycles, pauses and
  freshness run on the monotonic clock. A cycle is dated in `/data` before
  its first request: a restart, the test button or Discovery never read
  sooner than one interval after the last cycle. An unreadable `/data` is
  never written over and costs a full interval before the first read.
- **Devices**: `ext:<selector>:eta:<node>-<fub>` per block of the menu,
  features `…:<fkt>-<io>-<var id>` (the variable's address), plus
  `ext:<selector>:eta:errors` (`alarm`, `error-count`, `last-error`). Every
  feature is read only; temperatures are `temperature-sensor/probe`, pressure
  `pressure-sensor` (bar, Pa), hours `duration` (h); other units in the name
  on `unknown/decimal`. How a variable is read is decided by its Gladys
  feature (address, category, unit), so `/data` never changes it. A
  republished device keeps the features it was created with.
- **Untrusted answers**: bounded size (64 KB, 2 MB for the menu, cut while
  reading), bounded XML (20 000 elements, depth 32, no DOCTYPE, linear),
  attributes without prototype, strict numbers, texts cleaned and cut,
  invalid markers (`xxx`, `---`, empty) never published.
- **Failures**: backoff 1, 2, 5, 10, 15 min (never under the interval); 429:
  pause of Retry-After within 60 s to 6 h; both kept in `/data`.

## Development

```bash
npm install
npm test             # node --test (fake Gladys of the SDK, fake ETAtouch)
npm run lint
npm run format:check
npm run cover        # regenerates cover.png
```

`test/fixtures/pek.json` holds answers recorded by
homeassistant_eta_integration (see `THIRD_PARTY_NOTICES.md`).
`test/kit/clock.mjs` is the shared test kit's clock (virtual clock that moves
at every read, real clock sped up, period measurement).

## Credits

Ported in part from
[Tidone/homeassistant_eta_integration](https://github.com/Tidone/homeassistant_eta_integration)
1.4.2 (MIT): see `THIRD_PARTY_NOTICES.md`. Interface from the manufacturer's
document "ETAtouch RESTful Webservices" 1.2.

## License

Apache-2.0 (see `LICENSE`).
