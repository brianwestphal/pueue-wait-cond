# Changelog

## 0.2.0 — 2026-08-10

Getting more production ready

Releases are cut with `npm run release` (see [docs/requirements/05-packaging.md](docs/requirements/05-packaging.md)),
which prepends an entry here and tags `v{version}`. CI publishes from the tag.

## 0.1.1 — unreleased

- `--task-grace <SECONDS|forever>` (default `5`): a named task id that pueue has
  never heard of now gives up with exit `7` instead of waiting forever. Covers
  the `pueue add` → wait race without turning a typo into a hang.
- `--json`: emit one machine-readable result object on stdout instead of
  progress lines. Errors are reported as JSON too.
- New exit code `7` (`UNKNOWN_TASKS`).
- Declared `"os": ["darwin", "linux"]`, so `npm install` refuses on Windows
  rather than failing later at the first condition.
- Added `repository`, `bugs`, `homepage` and `author` metadata.
- Documented that `--until` / `--while` accept inline shell commands, not just
  script paths.
- README: how to install pueue on macOS and Linux.

## 0.1.0 — 2026-08-08

- Initial release: `pueue wait` parity plus `--timeout`, `--until` and
  `--while`.
