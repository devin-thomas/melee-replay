# Melee Replay

A Windows desktop app in progress for spoiler-safe Melee commentary practice.

## Current build

- Browses a reviewed 60-game **standalone** starter catalog without showing filenames, winners, scores, or game duration.
- Downloads a selected game on demand from a revision-pinned public source through an approved redirect, checks its size and SHA-256, parses it, and records the managed location locally.
- Imports local `.slp` files or folders by reference. Imported originals are not moved or deleted. Matching bytes in the catalog and local library share one card.
- Offers safe search, filters, and random unseen selection; stores library metadata in a per-user SQLite database.

The Practice action is disabled until the official Slippi Playback Dolphin adapter and natural-completion checks are implemented. The catalog contains no verified complete sets yet. A working development build is **not** a V1 release.

## Develop on Windows

Requires Node.js and npm. The app uses an installed official Slippi Playback Dolphin and a user-supplied game image for future playback; neither is bundled.

```powershell
npm install
npm run typecheck
npm test
npm start
```

Package and smoke-check the Windows x64 build:

```powershell
npm run package
node scripts/smoke-packaged.mjs
```

`node scripts/smoke-packaged.mjs --download` also downloads and parses one starter game through the packaged app. It uses a temporary user profile and writes a screenshot under `output/playwright/`.

## Replay data

The catalog metadata is in [`data/catalog-v1.json`](data/catalog-v1.json). The local 60-file development sample, source provenance, and reproduction command are described in [`data/README.md`](data/README.md). Replay bytes under `data/slp/` are ignored by Git and are not included in the application package. The app downloads only the selected game.

The dataset publisher labels the source collection CC0-1.0. Dataset character folders and neighboring timestamps do not establish tournament sets. [`data/sets/README.md`](data/sets/README.md) records attempted set sources and why none is currently admitted as verified.

No project source-code license has been selected. Before a public release, the app still needs verified complete sets, installed-runtime playback and interruption testing, packaged-native-module and OBS checks, and dependency/provider license review.
