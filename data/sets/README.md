# Tournament set source review

The [official Smash Summit 11 replay archive](https://storage.googleapis.com/slippi.appspot.com/replays/bundles/Summit-11.zip)
is public and downloadable without an account. Its publisher [announced the
archive](https://www.reddit.com/r/SSBM/comments/oozzcb/) and noted that it is an
unfiltered event dump. We inspected the original ZIP rather than treating
adjacent files as a set.

Grand Finals material has been cross-checked against an [independent
game-by-game bracket record](https://www.reddit.com/r/smashbros/comments/on64vr/)
and the [publisher's match video](https://www.youtube.com/watch?v=P4gNB3Cfai4).
Eight early pool matchups were checked against the organizer videos and
independent match records linked in `summit11-pool-selections.json`. The pool
matchups cover distinct entrants, so listing them together does not reveal
progression between those matches. The replay windows match the independent
records' ordered stages and terminal set scores. `summit11-records.json` and
`summit11-pool-records.json` record exact ZIP and member hashes, ordered
membership, parsed endings, and source evidence. These backstage files contain
results; do not display them in the app's browse or pre-play views. Only the
first Grand Finals contest is published, so the browse list does not disclose
the later contest. Nearby warmups and unrelated files are excluded.
`review_summit11.py` and `review_summit11_pools.py` reproduce the byte and
parser checks from the original archive in `data/archives/`.

The app fetches the publisher's original event ZIP on demand, verifies its
whole-file hash, and extracts only the selected set members by exact path and
hash. The archive is larger than a per-set package, so the first selection
requires an approximately 199 MiB download; later selections reuse the local
verified archive. Replay bytes are not committed or bundled. No explicit
redistribution license was found for the archive, and permission/compliance
review remains open before a public release.

Other checked sources remain useful candidates: [Lucky Stats](https://luckystats.gg/set/5690946)
has public set pages but its replay download required sign-in during review;
[Nikki's archive](https://www.reddit.com/r/SSBM/comments/1j0dvry/) exposes
public event dumps but not an inspectable per-set listing through the tested
route; [Hotswap/Replay Reporter](https://github.com/jmlee337/hotswap-info)
describes per-set exports but did not itself provide a public replay pack.

[Ausmash's public tournament result page](https://ausmash.com.au/results/19383/meleevac-17-swagman-post-okran-loss-7325)
also identifies two complete best-of-three Melee sets with explicit ordered
per-game Slippi links. `ausmash-19383-selections.json` pins the match rows and
four direct-file URLs. `review_ausmash_19383.py` rechecks those rows against the
publisher page, downloads the exact files when called with `--fetch`, verifies
their hashes and sizes, parses each complete singles ending, and checks the
source bracket score. Its backstage output is `ausmash-19383-records.json`.
The app downloads only the selected individual files from the original host.
[Ausmash's terms](https://ausmash.com.au/terms) do not state a replay
redistribution license; replay bytes remain unbundled and uncommitted.
