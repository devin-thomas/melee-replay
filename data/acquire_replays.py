"""Acquire a small, reproducible local sample of public Slippi replays.

The source's character folders duplicate games, so byte hashes define identity.
This is standalone practice material, not evidence of complete tournament sets.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

import requests
from slippi.parse import ParseEvent, parse


ROOT = Path(__file__).resolve().parent
REPLAYS = ROOT / "slp"
MANIFEST = ROOT / "replay-batch.json"
DATASET = "erickfm/slippi-public-dataset-v3.7"
REVISION = "c82be5f6e43f3388555cfe0cf8652580601f396d"
API = f"https://huggingface.co/api/datasets/{DATASET}/tree/{REVISION}"
CHARACTERS = (
    "FOX", "FALCO", "MARTH", "CPTFALCON", "ZELDA_SHEIK", "PEACH",
    "JIGGLYPUFF", "SAMUS", "GANONDORF", "ICE_CLIMBERS", "YOSHI", "BOWSER",
)
PER_CHARACTER = 5
# These files parse but the replay marks the ending NO_CONTEST.
KNOWN_REJECTED = {
    "3faddfbec63e30746c66419a9d8664675997e644e16bc382897733b4fcc9b3bf",
    "50095fc051eda51623dfcab746528501a50a80f49b0a8aa690878d60db4eaef1",
    "0032381924d8d89738d892c2257a7727680f03b6b2bf6bd418fd37cd5e0296d3",
    "a2b20a491e5d475ffe39acdab095ce3009a35cdcf2bbb2c024b237203a8769a8",
    "e9c68977855089d43e00f565a5b317124cef1a43b6116671cde34acdeff167f9",
    "3b765b2e00f18c1a119b7bf4269872b582f9b9f7562062db1888842f8ac0ffb9",
}


def choose_files() -> dict[str, list[dict]]:
    candidates = {}
    for character in CHARACTERS:
        response = requests.get(
            f"{API}/{character}", params={"recursive": "true", "expand": "true"}, timeout=30
        )
        response.raise_for_status()
        entries = response.json()
        valid = [
            entry for entry in entries
            if entry.get("type") == "file"
            and entry["path"].lower().endswith(".slp")
            and 750_000 <= entry.get("size", 0) <= 4_000_000
            and len(entry.get("lfs", {}).get("oid", "")) == 64
            and entry["lfs"]["oid"] not in KNOWN_REJECTED
        ]
        # Stable hash-order sampling avoids a bias toward adjacent timestamps.
        valid.sort(key=lambda entry: hashlib.sha256(entry["path"].encode()).digest())
        if len(valid) < PER_CHARACTER:
            raise RuntimeError(f"Only {len(valid)} eligible files for {character}")
        candidates[character] = [
            {"sampleCharacter": character, **entry} for entry in valid
        ]
    return candidates


def acquire(entry: dict) -> dict:
    expected_hash = entry["lfs"]["oid"]
    expected_size = entry["size"]
    target = REPLAYS / f"{expected_hash}.slp"
    url = f"https://huggingface.co/datasets/{DATASET}/resolve/{REVISION}/{quote(entry['path'], safe='/')}"

    if not target.exists():
        temporary = target.with_suffix(".part")
        for attempt in range(3):
            try:
                digest = hashlib.sha256()
                size = 0
                with requests.get(url, stream=True, timeout=(15, 90)) as response:
                    response.raise_for_status()
                    with temporary.open("wb") as output:
                        for chunk in response.iter_content(1024 * 1024):
                            if chunk:
                                output.write(chunk)
                                digest.update(chunk)
                                size += len(chunk)
                if size != expected_size or digest.hexdigest() != expected_hash:
                    raise ValueError(f"size/hash mismatch for {entry['path']}")
                temporary.replace(target)
                break
            except (requests.RequestException, OSError):
                temporary.unlink(missing_ok=True)
                if attempt == 2:
                    raise

    size = target.stat().st_size
    with target.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    if size != expected_size or digest != expected_hash:
        raise ValueError(f"local size/hash mismatch for {target}")

    parsed = {}
    parse(str(target), {
        ParseEvent.START: lambda value: parsed.update(start=value),
        ParseEvent.END: lambda value: parsed.update(end=value),
        ParseEvent.METADATA: lambda value: parsed.update(metadata=value),
    })
    start = parsed.get("start")
    end = parsed.get("end")
    metadata = parsed.get("metadata")
    if not start or not end or not metadata:
        raise ValueError(f"missing game start/end/metadata: {target}")
    if start.is_teams:
        raise ValueError(f"teams replay: {target}")
    players = [player for player in start.players if player is not None]
    if len(players) != 2 or any(player.type.name != "HUMAN" for player in players) or metadata.duration < 1800:
        raise ValueError(f"not a full-length singles game: {target}")
    if end.method.name != "GAME":
        raise ValueError(f"replay did not end as a game: {target}")

    return {
        "replayId": f"slippi-public-v3-{expected_hash}",
        "sampleCharacter": entry["sampleCharacter"],
        "sourcePath": entry["path"],
        "sourceUrl": url,
        "localPath": f"slp/{expected_hash}.slp",
        "sha256": expected_hash,
        "byteSize": size,
        "durationFrames": metadata.duration,
        "stage": start.stage.name,
        "characters": [player.character.name for player in players],
        "slippiVersion": str(start.slippi.version),
        "endMethod": end.method.name,
        "verification": "LFS SHA-256 and size matched downloaded bytes; py-slippi parsed start, GAME end, metadata, two human players",
    }


def main() -> None:
    REPLAYS.mkdir(exist_ok=True)
    candidates = choose_files()
    records = []
    seen = set()
    rejected = set(KNOWN_REJECTED)
    for character, entries in candidates.items():
        accepted = 0
        for entry in entries:
            digest = entry["lfs"]["oid"]
            if digest in seen:
                continue
            try:
                record = acquire(entry)
            except ValueError as error:
                rejected.add(digest)
                print(f"Rejected {digest[:12]}: {error}", flush=True)
                continue
            seen.add(digest)
            records.append(record)
            accepted += 1
            print(f"Validated {len(records)}/{len(CHARACTERS) * PER_CHARACTER}: {digest[:12]}", flush=True)
            if accepted == PER_CHARACTER:
                break
        if accepted != PER_CHARACTER:
            raise RuntimeError(f"Only {accepted} valid replays for {character}")

    for digest in rejected:
        target = REPLAYS / f"{digest}.slp"
        if target.parent.resolve() != REPLAYS.resolve():
            raise RuntimeError(f"Refusing to remove file outside replay directory: {target}")
        target.unlink(missing_ok=True)

    records.sort(key=lambda record: (record["sampleCharacter"], record["sha256"]))
    manifest = {
        "schemaVersion": 1,
        "purpose": "Standalone replay development sample; no verified-set claims",
        "sampledAt": datetime.now(timezone.utc).isoformat(),
        "source": {
            "dataset": DATASET,
            "revision": REVISION,
            "cardUrl": f"https://huggingface.co/datasets/{DATASET}",
            "licenseLabel": "CC0-1.0",
            "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
            "licenseEvidence": "Dataset card labels collection CC0-1.0 and attributes original compilation to altf4 with contributions from nikki and yashichi.",
            "access": "Public individual files at canonical Hugging Face resolve URLs; redirects may point to temporary CDN locations.",
        },
        "replays": records,
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {MANIFEST} with {len(records)} replays", flush=True)


if __name__ == "__main__":
    main()
