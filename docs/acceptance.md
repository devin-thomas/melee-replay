# Windows acceptance, 2026-09-24

This log records spoiler-free evidence for the local Windows 0.1.0 build. It does
not publish replay names, filenames, results, scores, or future game counts.

| Contract | Evidence |
| --- | --- |
| AC-01 | Packaged browse and Setup opened with 71 real catalog cards; Setup recheck detected the installed playback runtime and compatible local image. Clean Windows Sandbox installed and opened the app without Node or Python. |
| AC-02 | Packaged standalone and both represented verified-set formats reached natural completion. Packaged local-folder and Replay Reporter ZIP imports succeeded. |
| AC-03 | Synthetic same-prefix tests compare complete pre-reveal browse/session projections and the controller's opening state with different hidden suffixes. Later missing data fails only when it becomes current. |
| AC-04 | Shared cards and preload session views omit future count, duration, member list, terminal frame, and per-item byte totals; the renderer uses those projections. |
| AC-05 | Catalog opening-character mapping has a regression test; later switches do not change pre-play filters. |
| AC-06 | Exact-hash review scripts and records distinguish publisher material from adjacent unreviewed files. |
| AC-07 | Review scripts pin ordered members and entrant-to-port mapping; character mapping has a regression test. |
| AC-08 | Session-state tests cover non-scoring segments and terminal rules. |
| AC-09 | Library tests cover reference import, remove-from-index, relink, preserved original bytes, history, and cache cleanup. |
| AC-10 | Catalog tests cover selected-only extraction, verification, and invalid bytes; packaged downloads validated selected sets. |
| AC-11 | Library tests cover exact duplicates and changed bytes at a prior path. |
| AC-12 | Session/library tests cover shared exposure across standalone and containing set. |
| AC-13 | Live Playback Dolphin and packaged smoke distinguish launch request from confirmed start. |
| AC-14 | Live adapter test and packaged Stop smoke reject early completion; natural terminal-frame and end observations are required. |
| AC-15 | Session-state tests cover countdown/Hold/Next races; packaged set smoke exercised Hold, Next, and Stop. |
| AC-16 | Controller tests cover missing later data without false score or exposure; suspend/failure transitions are in the session tests. |
| AC-17 | Packaged full-set smoke ended in the completed phase with saved history and no extra launch. |
| AC-18 | Packaged repeat smoke checks a fresh reveal state and preservation of the completed attempt after stopping the repeat. |
| AC-19 | Library startup recheck and relink tests preserve identity/history; Setup and library show repair controls. |
| AC-20 | SQLite migration, backup, crash recovery, and changed-file tests passed. |
| AC-21 | Main-frame IPC checks, allowlisted paths/URLs, browser sandbox/CSP, and no renderer Node integration were reviewed in source. |
| AC-22 | Reporter ZIP tests cover traversal, symlink/reparse, duplicate paths, size limits, and safe cleanup. |
| AC-23 | Local OBS capture verified normal gameplay and application audio with a stable neutral capture title through transitions. |
| AC-24 | Packaged parser/ENet/SQLite smoke passed; isolated Windows Sandbox install and update retained a SQLite history row with no Node or Python. |
| AC-25 | Native keyboard controls and `aria-live` practice status are present; packaged browser automation used role-based controls and safe projections. |
| AC-26 | Acquisition has explicit cancelled, unavailable, network, integrity, and storage errors; approved source scopes and no fallback endpoint are enforced. |
| AC-27 | The catalog contains eleven reviewed complete sets and 60 standalone games; hashes, parser evidence, and packaged playback were checked. |

The CATALOG-LIVE gate used publisher-hosted replay bytes and verified hashes.
The PLAYBACK-WINDOWS gate used the installed official Playback Dolphin for
natural completion, early stop, and intermission controls. The PACKAGE-WINDOWS
gate used the Squirrel installer and synthetic update in a clean Windows
Sandbox, plus packaged replay and OBS runs on the host. The Sandbox evidence is
in ignored `output/installer-acceptance/`; OBS evidence is in ignored
`output/obs-acceptance/`. Source replay bytes and game images are not bundled.
