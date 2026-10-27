# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported from the project below, and its tests use answers
recorded by that project. The ported parts were rewritten in JavaScript; they
are changed from the original (another language, another structure, only what
this integration needs, read only). None of the original code is copied as is.

## homeassistant_eta_integration

- Project:
  [Tidone/homeassistant_eta_integration](https://github.com/Tidone/homeassistant_eta_integration),
  version 1.4.2 (2026-03-16; commit 003aaff of 2026-10-05), the Home
  Assistant custom integration for ETA boilers through the ETAtouch RESTful
  webservices, by Tidone and its contributors.
- Copyright: the project's `LICENSE` file names "Joakim Sørensen @ludeeus"
  (the author of the template the project started from), reproduced as is
  below.
- What is ported (in `src/eta.js`, `src/devices.js` and `src/catalog.js`):
  the discovery of the variables from `/user/menu`, the choice between the
  API 1.2 discovery (`/user/varinfo`) and the older one from the version of
  `/user/api`, the reading of a value (raw value divided by `scaleFactor`,
  `decPlaces` ignored so as not to lose precision), the markers of a value
  the boiler does not have (`xxx`, `---`, empty), the kinds of variables
  (text, numbers by unit, time slots left out), the unit of the value
  preferred to the unit of varinfo, the list of units read as numbers, the
  reading of `/user/errors`.
- Test data: `test/fixtures/pek.json` holds a subset of the answers of the
  project's `tests/fixtures/api_endpoint_data.json` (a real ETA PE-K with
  its heating circuits, API 1.2): the menu and the answers of about forty
  variables, unchanged.
- Changes: rewritten in JavaScript for a Gladys external integration; read
  only (the reference's switches, writable numbers, time slots and services
  are not ported); one request at a time instead of parallel requests; the
  answers are read with size and time limits and parsed as untrusted XML
  (no dependency); default selection of the variables by their ids; no Home
  Assistant code.
- Licence:

```
MIT License

Copyright (c) 2020 Joakim Sørensen @ludeeus

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## ETAtouch RESTful Webservices (document)

The resources, their XML answers and the meaning of their attributes come
from the manufacturer's public document "ETAtouch RESTful Webservices",
version 1.2 (2019-11-11, meineta.at). No part of it is copied; ETA is a
trademark of its owner, used to name the boilers this integration reads.
