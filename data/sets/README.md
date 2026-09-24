# Verified set source audit

Audited 2026-09-23. No set is admitted to the starter catalog from this audit. The
directory intentionally contains no replay bytes or `verified-set` manifest entries.
The application specification requires an independently evidenced contest, ordered
game membership, entrant mapping, complete scoring, and a bounded public asset for
each selected set. Public availability alone does not establish those facts.

| Candidate | Direct check | Missing release evidence |
| --- | --- | --- |
| [Lucky Stats set 5690946](https://luckystats.gg/set/5690946) | The public page identified Aura vs Salt, Adam's Smash Series #190, Grand Final Reset, June 4 2026, and a 0-3 result. Its Download button opened a "Sign in to watch" prompt while signed out (browser check, 2026-09-23). | A no-login, documented canonical asset URL; per-game order and port mapping; publisher use conditions for automated direct acquisition. Do not extract browser cookies or copy an expiring URL. |
| [Summit 11 official dump](https://www.reddit.com/r/SSBM/comments/oozzcb/summit_11_replays_on_slippigg_full_download_link/) | Fizzi's linked [ZIP](https://storage.googleapis.com/slippi.appspot.com/replays/bundles/Summit-11.zip) returned HTTP 200, `application/zip`, and `Content-Length: 208987744` on 2026-09-23. The publisher explicitly said the dump includes everything without filtering. | The 209 MB archive is a whole-event download, not a bounded per-set asset. It includes material requiring classification, so adjacent files cannot establish a complete set. The old [tournament route](https://slippi.gg/tournament/114117) returned a generic Slippi app shell rather than a usable per-set listing. |
| [Nikki's archive](https://www.reddit.com/r/SSBM/comments/1j0dvry/nikkis_slippi_archive_gx2_replays_and_more/) | The maintainer says the archives are free to use except selling access. A [public OneDrive link](https://www.reddit.com/r/SSBM/comments/1u6zlrc/tourney_replays/) is shared by the community. | The linked OneDrive page did not expose an inspectable listing in the web tool. No bounded per-set package, game membership, or authoritative result mapping was verified. The usage statement does not establish third-party organizer rights. |
| [Hotswap / Replay Reporter](https://github.com/jmlee337/hotswap-info) | The producer's workflow explains per-set ZIPs with context and start.gg reporting. | The tooling page is not a public archive. No production package or organizer-backed set was linked or acquired by this audit. |

The next viable admission path is an organizer or publisher providing public,
stable per-set ZIP links with Replay Reporter context or an equivalent ordered
export, plus source terms that permit direct application downloads. Each selected
ZIP still needs SHA-256, size, parser and playback checks and a cross-check of
every scoring game against the recorded tournament result. A set that fails any
check can supply reviewed standalone games, but cannot receive a Verified Set
badge.
