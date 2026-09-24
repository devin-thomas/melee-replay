# Melee Replay

A Windows desktop app for spoiler-safe Melee commentary practice.

## Current build

- Browses 60 standalone games and eleven reviewed tournament sets without showing filenames, winners, scores, or future game details.
- Downloads a selected item on demand from its approved public source, checks source and replay hashes, parses the selected games, and records managed locations locally. Some sets use direct per-game files; others use an approximately 199 MiB publisher archive cached after its first download.
- Imports local `.slp` files or folders by reference. Imported originals are not moved or deleted. Matching bytes in the catalog and local library share one card.
- Imports bounded Replay Reporter ZIP packages as standalone games without revealing package context or claiming unreviewed sets are verified.
- Offers safe search, filters, random unseen selection, and practice history; stores library metadata in a per-user SQLite database.
- Shows aggregate app-owned storage in Setup and clears eligible cached publisher archives without removing playable replays, imported originals, or practice history.
- Plays selected replays in an installed official Slippi Playback Dolphin. It records a start only after playback begins and a completion only after a natural end. Verified sets have observed score, 30-second intermission, Hold, Next, and Stop controls.

The app keeps future set details in the main process. Its practice screen shows only the current game and score earned through watched games.

## Use the Windows app

Run `out/make/squirrel.windows/x64/melee-replay-0.1.0 Setup.exe` to install the local build. The installed app does not need Node.js or Python. Install the official Slippi Launcher playback runtime and provide your own NTSC Melee 1.02 game image. Open Setup to verify both paths; the app detects a compatible local installation or lets you choose each file. Browse, download a set or game, and select **Start practice**. Playback opens in its own Dolphin window while Melee Replay shows the current game and session controls. History is kept across app updates.

The ZIP under `out/make/zip/win32/x64/` is a portable alternative. Replay files, Playback Dolphin, and the game image are not bundled in either artifact.

## Develop on Windows

Requires Node.js and npm for development. Playback uses an installed official Slippi Playback Dolphin and a user-supplied NTSC Melee 1.02 game image; neither is bundled. Setup detects an existing Slippi Launcher playback installation and a compatible image in Dolphin's configured ISO folders, or lets you choose both files. Use Recheck in Setup after changing either file.

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

`node scripts/smoke-packaged.mjs --download` also downloads and parses one standalone starter game through the packaged app. It uses a temporary user profile and writes a screenshot under `output/playwright/`.
`node scripts/smoke-packaged.mjs --download-set` prepares every reviewed set through the packaged app using a shared archive cache.
`node scripts/smoke-packaged.mjs --download-short-set` prepares one reviewed short-format set.
`node scripts/smoke-packaged.mjs --practice-stop` and `--practice-natural` exercise actual packaged playback using one local sample; `--practice-set` exercises intermission controls with a prepared verified set. To reuse an existing disposable profile, set `MELEE_REPLAY_SMOKE_PROFILE` to its absolute path.
`node scripts/smoke-packaged.mjs --practice-set-complete=bo3`, `--practice-set-complete=bo5`, and `--practice-set-complete=long` run complete verified-set playback through the packaged app. They require matching prepared sets in the reusable smoke profile.

## Replay data

The catalog metadata is in [`data/catalog-v1.json`](data/catalog-v1.json). The local 60-file development sample, source provenance, and reproduction command are described in [`data/README.md`](data/README.md). Replay bytes under `data/slp/` and publisher archives under `data/archives/` are ignored by Git and are not included in the application package.

The dataset publisher labels the standalone collection CC0-1.0. Dataset character folders and neighboring timestamps do not establish tournament sets. [`data/sets/README.md`](data/sets/README.md) documents the eleven complete-set reviews and remaining source-use question.

No project source-code license has been selected. The repository intentionally contains no emulator, Nintendo image, or replay bytes.

## Third-party notices

Melee Replay uses the LGPLv3-or-later Slippi JS library. The complete [third-party notices](third-party/NOTICES.md), its LGPLv3 text, the GNU GPLv3 text, and notices for all other packaged production dependencies are included in the Windows build under `resources/third-party/`. The app's About screen opens that file. The packaged Electron runtime also includes its own `LICENSE` and `LICENSES.chromium.html` alongside the executable.

Slippi JS is kept in `resources/app.asar.unpacked/node_modules/@slippi/slippi-js/` so a user can replace it with a compatible modified version. The exact replacement steps are in [third-party/NOTICES.md](third-party/NOTICES.md). No Slippi Playback Dolphin or game image is distributed with the app.
