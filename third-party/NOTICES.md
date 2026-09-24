# Third-party notices

Melee Replay uses @slippi/slippi-js 9.1.3, licensed under LGPL-3.0-or-later. Its use and the library itself are covered by the GNU Lesser General Public License. The library license is in `licenses/slippi-slippi-js-9.1.3.txt`; the accompanying GNU GPL version 3 is in `GPL-3.0.txt`. Copyright belongs to the Slippi JS contributors.

The app loads Slippi JS as an external Node module. It is kept unpacked so you can replace it with a compatible modified version:

1. Close Melee Replay.
2. In the installed app folder, open `resources/app.asar.unpacked/node_modules/@slippi/slippi-js/`.
3. Obtain or build a compatible version from <https://github.com/project-slippi/slippi-js>. Replace the files in that directory, preserving `package.json` and the `dist/node` entry points. Keep a copy of the original directory if you may want to restore it.
4. Start Melee Replay again. The application loads the replacement from that directory without rebuilding the app.

This app does not restrict reverse engineering for debugging changes to Slippi JS. The project source is at <https://github.com/devin-thomas/melee-replay>. Slippi JS source is at <https://github.com/project-slippi/slippi-js>. No Slippi Playback Dolphin binary is bundled.

The packaged Electron runtime supplies its own `LICENSE` and `LICENSES.chromium.html` alongside the executable. The app also embeds the DM Sans and Space Grotesk fonts under OFL-1.1; their complete notices are listed below.

## Production packages

| Package | Version | License | Notice |
| --- | --- | --- | --- |
| @fontsource/dm-sans | 5.3.0 | OFL-1.1 | [fontsource-dm-sans-5.3.0.txt](licenses/fontsource-dm-sans-5.3.0.txt) |
| @fontsource/space-grotesk | 5.3.0 | OFL-1.1 | [fontsource-space-grotesk-5.3.0.txt](licenses/fontsource-space-grotesk-5.3.0.txt) |
| @shelacek/ubjson | 1.1.1 | MIT | [shelacek-ubjson-1.1.1.txt](licenses/shelacek-ubjson-1.1.1.txt) |
| @slippi/slippi-js | 9.1.3 | LGPL-3.0-or-later | [slippi-slippi-js-9.1.3.txt](licenses/slippi-slippi-js-9.1.3.txt) |
| backoff | 2.5.0 | MIT | [backoff-2.5.0.txt](licenses/backoff-2.5.0.txt) |
| better-sqlite3 | 13.0.3 | MIT | [better-sqlite3-13.0.3.txt](licenses/better-sqlite3-13.0.3.txt) |
| date-fns | 3.6.0 | MIT | [date-fns-3.6.0.txt](licenses/date-fns-3.6.0.txt) |
| debug | 2.6.9 | MIT | [debug-2.6.9.txt](licenses/debug-2.6.9.txt) |
| electron-squirrel-startup | 1.0.1 | Apache-2.0 | [electron-squirrel-startup-1.0.1.txt](licenses/electron-squirrel-startup-1.0.1.txt) |
| enet | v0.2.9 | MIT | [enet-v0.2.9.txt](licenses/enet-v0.2.9.txt) |
| iconv-cp932 | 1.2.2 | MIT | [iconv-cp932-1.2.2.txt](licenses/iconv-cp932-1.2.2.txt) |
| ms | 2.0.0 | MIT | [ms-2.0.0.txt](licenses/ms-2.0.0.txt) |
| node-addon-api | 8.9.2 | MIT | [node-addon-api-8.9.2.txt](licenses/node-addon-api-8.9.2.txt) |
| pend | 1.2.0 | MIT | [pend-1.2.0.txt](licenses/pend-1.2.0.txt) |
| precond | 0.2.3 | MIT (source notice) | [precond-0.2.3.txt](licenses/precond-0.2.3.txt) |
| react | 19.3.0 | MIT | [react-19.3.0.txt](licenses/react-19.3.0.txt) |
| react-dom | 19.3.0 | MIT | [react-dom-19.3.0.txt](licenses/react-dom-19.3.0.txt) |
| reconnect-core | 1.3.0 | MIT | [reconnect-core-1.3.0.txt](licenses/reconnect-core-1.3.0.txt) |
| scheduler | 0.28.0 | MIT | [scheduler-0.28.0.txt](licenses/scheduler-0.28.0.txt) |
| semver | 7.8.5 | ISC | [semver-7.8.5.txt](licenses/semver-7.8.5.txt) |
| ws | 8.21.3 | MIT | [ws-8.21.3.txt](licenses/ws-8.21.3.txt) |
| yauzl | 3.4.0 | MIT | [yauzl-3.4.0.txt](licenses/yauzl-3.4.0.txt) |

Notices are generated from the installed production dependency tree. Run `node scripts/generate-third-party-notices.mjs` after changing dependencies and review the resulting files before distributing a build.
