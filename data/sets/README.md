# Tournament set source review

The [official Smash Summit 11 replay archive](https://storage.googleapis.com/slippi.appspot.com/replays/bundles/Summit-11.zip)
is public and downloadable without an account. Its publisher [announced the
archive](https://www.reddit.com/r/SSBM/comments/oozzcb/) and noted that it is an
unfiltered event dump. We inspected the original ZIP rather than treating
adjacent files as a set.

Grand Finals material has now been cross-checked against an [independent
game-by-game bracket record](https://www.reddit.com/r/smashbros/comments/on64vr/)
and the [publisher's match video](https://www.youtube.com/watch?v=P4gNB3Cfai4).
The backstage `summit11-records.json` records exact ZIP and member hashes,
ordered membership, parsed endings, and source evidence. It contains results;
do not display it in the app's browse or pre-play views. Only one contest is
shown as a catalog item, so the browse list does not disclose later bracket
progression. Nearby warmup and no-contest files are excluded.
`review_summit11.py` reproduces the byte and
parser review from the original archive in `data/archives/`.

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
