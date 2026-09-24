"""Build the standalone-only curated-v1 catalog from the validated replay batch."""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "replay-batch.json"
OUTPUT = ROOT / "catalog-v1.json"
SOURCE_ID = "huggingface-slippi-public-v3.7"
NAMESPACE = uuid.UUID("f8cbf661-8ead-491b-b637-e869300b69f5")


def opaque_id(kind: str, digest: str) -> str:
    return str(uuid.uuid5(NAMESPACE, f"{SOURCE_ID}:{kind}:{digest}"))


def character_label(value: str) -> str:
    special = {
        "CPTFALCON": "Captain Falcon",
        "DK": "Donkey Kong",
        "DOC": "Dr. Mario",
        "GAMEANDWATCH": "Mr. Game & Watch",
        "ICE_CLIMBERS": "Ice Climbers",
        "JIGGLYPUFF": "Jigglypuff",
        "ZELDA_SHEIK": "Zelda/Sheik",
    }
    return special.get(value, value.replace("_", " ").title())


def main() -> None:
    batch = json.loads(SOURCE.read_text(encoding="utf-8"))
    source = batch["source"]
    revision = source["revision"]
    records = sorted(batch["replays"], key=lambda record: record["sha256"])
    if len(records) != 60 or len({record["sha256"] for record in records}) != len(records):
        raise ValueError("Expected 60 unique verified replays")
    if any(record["endMethod"] != "GAME" for record in records):
        raise ValueError("Batch contains a non-game ending")

    generated_at = datetime.fromisoformat(batch["sampledAt"]).astimezone(timezone.utc)
    timestamp = generated_at.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    content_key = revision + "\n" + "\n".join(record["sha256"] for record in records)
    catalog_revision = "hf-v3-standalone-" + hashlib.sha256(content_key.encode()).hexdigest()[:16]
    download_scope = {
        "origin": "https://huggingface.co",
        "pathPrefix": f"/datasets/{source['dataset']}/resolve/{revision}/",
    }
    redirect_scope = {"origin": "https://us.aws.cdn.hf.co", "pathPrefix": "/xet-bridge-us/"}
    catalog = {
        "schemaVersion": 1,
        "catalogRevision": catalog_revision,
        "generatedAt": timestamp,
        "sources": [{
            "sourceId": SOURCE_ID,
            "publisher": "erickfm, Hugging Face mirror of altf4's public Slippi dataset",
            "evidenceUrls": [
                source["cardUrl"],
                f"https://huggingface.co/datasets/{source['dataset']}/tree/{revision}",
                source["licenseUrl"],
            ],
            "accessConditions": "Public individual replay downloads through revision-pinned Hugging Face resolve URLs; no account was required during review.",
            "useConditions": "The dataset card labels the replay collection CC0-1.0, credits altf4 with contributions from nikki and yashichi, and permits use. This is the publisher's stated license for replay data, not a license for Nintendo game assets.",
            "reviewedAt": timestamp,
            "auditReference": "data/replay-batch.json: local SHA-256, byte size, and py-slippi 1.6.2 game-end validation; standalone classification only.",
            "downloadScopes": [download_scope],
            "redirectScopes": [redirect_scope],
            "eligibility": "eligible",
        }],
        "assets": [],
        "replays": [],
        "items": [],
    }

    for record in records:
        digest = record["sha256"]
        asset_id = opaque_id("asset", digest)
        replay_id = opaque_id("replay", digest)
        item_id = opaque_id("item", digest)
        catalog["assets"].append({
            "assetId": asset_id,
            "sourceId": SOURCE_ID,
            "format": "slp",
            "fetchUrl": record["sourceUrl"],
            "sha256": digest,
            "byteSize": record["byteSize"],
            "objectRevision": revision,
        })
        catalog["replays"].append({
            "replayId": replay_id,
            "assetId": asset_id,
            "sha256": digest,
            "byteSize": record["byteSize"],
            "formatEvidence": "Slippi 2.0.1 .slp; py-slippi 1.6.2 parsed start, GAME end, and metadata; two human players, non-team.",
            "participants": {"player1": "Unknown Player 1", "player2": "Unknown Player 2"},
            "sourceIdentity": f"{source['dataset']}@{revision}:{record['sourcePath']}",
            "aliases": [record["sourcePath"]],
        })
        first, second = map(character_label, record["characters"])
        catalog["items"].append({
            "itemId": item_id,
            "kind": "standalone",
            "replayId": replay_id,
            "openingCharacters": [first, second],
            "safeContext": f"Standalone game: {first} vs {second}",
            "provenance": "erickfm's CC0-labeled Slippi Public Dataset v3.7; original compilation by altf4 with nikki and yashichi. Set identity and completeness unverified.",
        })

    OUTPUT.write_text(json.dumps(catalog, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    print(f"Wrote {OUTPUT}: {len(catalog['items'])} standalone items ({catalog_revision})")


if __name__ == "__main__":
    main()
