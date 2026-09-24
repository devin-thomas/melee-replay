"""Rebuild the private-result evidence for selected sets in the official archive.

Requires py-slippi==1.6.2 and the original, unmodified Summit-11.zip under
data/archives/. The generated JSON is backstage catalog input, not UI copy.
"""

from __future__ import annotations

import hashlib
import io
import json
import uuid
import zipfile
from pathlib import Path

import slippi


ROOT = Path(__file__).resolve().parent.parent
ARCHIVE = ROOT / "archives" / "Summit-11.zip"
OUTPUT = Path(__file__).with_name("summit11-records.json")
ARCHIVE_URL = "https://storage.googleapis.com/slippi.appspot.com/replays/bundles/Summit-11.zip"
BRACKET_URL = "https://www.reddit.com/r/smashbros/comments/on64vr/"
VOD_URL = "https://www.youtube.com/watch?v=P4gNB3Cfai4"
PUBLISHER_POST = "https://www.reddit.com/r/SSBM/comments/oozzcb/"
ARCHIVE_SHA256 = "3831c276c2c5e4492ea955abf1ee080667d2c7252afb8771e2e97659d989f7c4"
ARCHIVE_BYTES = 208987744
REVIEWED_FACTS_SHA256 = "c8b185bf9da506a833f972b94a0c0aa626cd6ef7e4d45e6fbc0c672ef4d0af74"
SOURCE_ID = "slippi-official-summit-11"
REVIEWED_AT = "2026-09-24T04:59:46.689Z"
NAMESPACE = uuid.UUID("f8cbf661-8ead-491b-b637-e869300b69f5")


def opaque_id(kind: str, key: str) -> str:
    return str(uuid.uuid5(NAMESPACE, f"{SOURCE_ID}:{kind}:{key}"))


def archive_hash() -> str:
    digest = hashlib.sha256()
    with ARCHIVE.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    if ARCHIVE.stat().st_size != ARCHIVE_BYTES or archive_hash() != ARCHIVE_SHA256:
        raise ValueError("The official archive has changed; review it again")
    reviewed_at = REVIEWED_AT
    source = {
        "sourceId": SOURCE_ID,
        "publisher": "Project Slippi / Fizzi",
        "evidenceUrls": [PUBLISHER_POST, ARCHIVE_URL, BRACKET_URL, VOD_URL],
        "accessConditions": "The publisher's original event archive was publicly downloadable without an account during review.",
        "useConditions": "The application downloads from the original publisher URL and does not redistribute replay bytes. No explicit replay redistribution license was identified; release permission review remains open.",
        "reviewedAt": reviewed_at,
        "auditReference": "data/sets/summit11-records.json: exact archive and member hashes, parsed game endings, stage/order and result cross-check.",
        "downloadScopes": [{"origin": "https://storage.googleapis.com", "pathPrefix": "/slippi.appspot.com/replays/bundles/"}],
        "redirectScopes": [],
        "eligibility": "eligible",
    }
    asset_id = opaque_id("asset", ARCHIVE_SHA256)
    asset = {
        "assetId": asset_id,
        "sourceId": SOURCE_ID,
        "format": "zip",
        "fetchUrl": ARCHIVE_URL,
        "sha256": ARCHIVE_SHA256,
        "byteSize": ARCHIVE_BYTES,
    }
    candidates = []
    with zipfile.ZipFile(ARCHIVE) as bundle:
        for member in sorted(bundle.namelist()):
            if not member.startswith("Day 3/") or not member.endswith(".slp"):
                continue
            content = bundle.read(member)
            game = slippi.Game(io.BytesIO(content))
            players = game.start.players
            if (players[0] is None or players[1] is None or any(players[2:])
                    or [player.character.name for player in players[:2]] != ["MARTH", "FOX"]
                    or game.end is None or game.end.method.name != "GAME"):
                continue
            final = game.frames[-1].ports
            stocks = [final[index].leader.post.stocks for index in (0, 1)]
            if stocks.count(0) != 1 or max(stocks) == 0:
                continue
            candidates.append((member, content, game.start.stage.name, stocks))
    # The preceding same-matchup warmup is excluded by the independent bracket's
    # two consecutive best-of-five records and exact game-stage sequence.
    selected = candidates[-10:]
    if len(selected) != 10:
        raise ValueError("Expected selected Grand Finals material is missing")
    facts = [(stage, int(stocks[1] > 0)) for _, _, stage, stocks in selected]
    facts_hash = hashlib.sha256(json.dumps(facts, separators=(",", ":")).encode()).hexdigest()
    if facts_hash != REVIEWED_FACTS_SHA256:
        raise ValueError("Selected games no longer match the reviewed bracket cross-check")

    replays = []
    items = []
    for set_index in range(2):
        segments = []
        for order, (member, content, stage, stocks) in enumerate(selected[set_index * 5:(set_index + 1) * 5], 1):
            digest = hashlib.sha256(content).hexdigest()
            replay_id = opaque_id("replay", digest)
            replays.append({
                "replayId": replay_id,
                "assetId": asset_id,
                "zipEntryPath": member,
                "sha256": digest,
                "byteSize": len(content),
                "formatEvidence": "Parsed .slp with two human singles players, complete GAME ending, final stock state and reviewed stage.",
                "participants": {"player1": "Zain", "player2": "Mang0"},
                "sourceIdentity": f"{ARCHIVE_URL}#{member}",
                "aliases": [member],
            })
            segments.append({
                "replayId": replay_id,
                "order": order,
                "group": "main",
                "player1Entrant": "A",
                "player2Entrant": "B",
                "scoreEffect": "entrantA" if stocks[0] > 0 else "entrantB",
            })
        score_a = sum(segment["scoreEffect"] == "entrantA" for segment in segments)
        score_b = sum(segment["scoreEffect"] == "entrantB" for segment in segments)
        if sorted((score_a, score_b)) != [2, 3]:
            raise ValueError("Selected set does not match its independent bracket result")
        items.append({
            "itemId": opaque_id("item", f"grand-finals-{set_index + 1}"),
            "kind": "set",
            "sourceSetIdentity": f"Smash Summit 11 Grand Finals set {set_index + 1}",
            "eventContext": "Smash Summit 11 - Grand Finals",
            "entrantA": "Zain",
            "entrantB": "Mang0",
            "bestOf": 5,
            "completionRule": "target-wins",
            "segments": segments,
            "verification": {
                "method": "reviewed-source-crosscheck",
                "sourceReferences": [PUBLISHER_POST, ARCHIVE_URL, BRACKET_URL, VOD_URL],
                "reviewer": "Melee Replay curation",
                "verifiedAt": reviewed_at,
                "manifestRevision": "filled-by-catalog-builder",
                "orderedAssetHashes": [replay["sha256"] for replay in replays[-5:]],
                "completenessEvidence": "The publisher's archive supplies these ordered game files; their stages and scoring outcomes match both independent bracket rows. Adjacent warmup and no-contest material is excluded.",
                "decisions": "Two bracket contests are represented separately. Only the cross-checked scoring games are admitted; no file proximity alone creates set membership.",
            },
            "sourceResult": {"entrantA": score_a, "entrantB": score_b},
        })
    OUTPUT.write_text(json.dumps({"source": source, "asset": asset,
                                  "replays": replays, "items": items}, indent=2) + "\n", encoding="utf-8")
    print("Reviewed official archive and wrote backstage set evidence.")


if __name__ == "__main__":
    main()
