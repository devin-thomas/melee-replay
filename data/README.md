# Local replay sample

`replay-batch.json` records 60 individual Slippi games from the public
[`erickfm/slippi-public-dataset-v3.7`](https://huggingface.co/datasets/erickfm/slippi-public-dataset-v3.7)
dataset at revision `c82be5f6e43f3388555cfe0cf8652580601f396d`.
The dataset publisher labels the collection [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/)
and attributes the original compilation to altf4, with contributions from
nikki and yashichi. Each manifest record retains its original path, canonical
revision-pinned download URL, LFS SHA-256, byte size, and parse evidence.
`catalog-v1.json` maps the same records into the app's `curated-v1` schema as
60 standalone practice items with neutral player labels, alongside one reviewed
complete-set item from the [official Summit 11 archive](sets/README.md). Its opaque IDs are
stable for each replay hash. `openingCharacters` records the two characters
visible from the current game's start without inferring player identities.

The Hugging Face sample is **standalone games only**. Character folders can
duplicate files and do not establish tournament set identity, game order, or
completeness. Set provenance is reviewed separately under `sets/`. None of
these files has been tested in a Playback Dolphin session, so catalog
validation is not Windows playback acceptance.

The replay bytes are kept locally under `slp/` and excluded from Git. To
recreate the same sample on this machine or another Windows development host:

```powershell
python -m pip install requests py-slippi==1.6.2
python data/acquire_replays.py
python data/build_catalog.py
npx vitest run data/catalog-v1.test.ts
```

To reproduce the set review, place the publisher's original archive at
`data/archives/Summit-11.zip`, install `py-slippi==1.6.2`, and run
`python data/sets/review_summit11.py` before rebuilding the catalog. The
archive and extracted replay bytes are ignored by Git.

The script fetches a bounded selection from 12 character folders, checks each
file against the publisher's LFS hash and size, parses start/end/metadata,
and admits only full-length, two-human, non-team games with a `GAME` ending.
It stores files by hash so source filenames are never needed for playback.
The canonical fetch URLs are pinned to the dataset revision. When checked,
they redirected to `https://us.aws.cdn.hf.co/xet-bridge-us/` with temporary
signed query parameters. Those temporary URLs are not stored in the catalog.
