# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-10-27

### Added

- ETA wood and pellet boilers through the local ETAtouch RESTful webservices,
  read only: one device per block of the menu (boiler, heating circuits, hot
  water, extraction...), about thirty main values or every readable value,
  temperatures, pressure, pellet stock and consumption, counters, states.
- An "ETA errors" device (active error, count, last error) and the scene
  trigger "ETA boiler error" on a new active error.
- Reduced mode for ETAtouch firmware older than API 1.2 (no varinfo).
- Careful reads: one request at a time, one cycle per interval (60 s by
  default), never sooner after a restart, the test button or Discovery;
  backoff and 429 pause kept in `/data`.

[Unreleased]: https://github.com/LM1LC3N7/gladys-eta/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-eta/releases/tag/v0.1.1
