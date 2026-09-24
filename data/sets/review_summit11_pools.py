"""Rebuild reviewed pool-set evidence from the pinned official Summit archive."""

from __future__ import annotations

import hashlib
import io
import json
import re
import unicodedata
import zipfile
from pathlib import Path

import slippi

from review_summit11 import ARCHIVE, ARCHIVE_BYTES, ARCHIVE_SHA256, ARCHIVE_URL
from review_summit11 import PUBLISHER_POST, SOURCE_ID, archive_hash, opaque_id
from character_metadata import entrant_ordered_characters


DIRECTORY = Path(__file__).parent
SELECTIONS = DIRECTORY / "summit11-pool-selections.json"
OUTPUT = DIRECTORY / "summit11-pool-records.json"
BASE_RECORDS = DIRECTORY / "summit11-records.json"
REVIEWED_AT = "2026-09-24T05:25:00.000Z"


def facts_hash(value: object) -> str:
    return hashlib.sha256(json.dumps(value, separators=(",", ":")).encode()).hexdigest()


def stage_key(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value)
    key = re.sub(r"[^a-z0-9]", "", normalized.casefold())
    return "dreamland64" if key == "dreamlandn64" else key


def main() -> None:
    if ARCHIVE.stat().st_size != ARCHIVE_BYTES or archive_hash() != ARCHIVE_SHA256:
        raise ValueError("The official archive has changed; review it again")
    base = json.loads(BASE_RECORDS.read_text(encoding="utf-8"))
    selections = json.loads(SELECTIONS.read_text(encoding="utf-8"))
    if len(selections) != 8:
        raise ValueError("Expected eight independently reviewed pool selections")
    source = dict(base["source"])
    source["evidenceUrls"] = [reference for selected in selections for reference in
                              (selected["sourceThread"], selected["organizerVideo"])]
    source["reviewedAt"] = REVIEWED_AT
    source["auditReference"] = "data/sets/summit11-pool-records.json: pinned ZIP and replay hashes, complete game endings, ordered stage and set-score source comparison."
    asset = base["asset"]
    if asset["sourceId"] != SOURCE_ID or asset["fetchUrl"] != ARCHIVE_URL:
        raise ValueError("Pinned pool selections reference a different archive")

    all_members: set[str] = set()
    replays = []
    items = []
    with zipfile.ZipFile(ARCHIVE) as bundle:
        for selected in selections:
            members = selected["memberPaths"]
            if not members or any(member in all_members or not member.startswith("Day 2/")
                                  or not member.endswith(".slp") for member in members):
                raise ValueError("Pool selection has duplicate or invalid members")
            all_members.update(members)
            entrant_a_port = selected["entrantAPort"]
            segment_rows = []
            stages = []
            score = [0, 0]
            for order, member in enumerate(members, 1):
                content = bundle.read(member)
                game = slippi.Game(io.BytesIO(content))
                if game.end is None or game.end.method.name != "GAME":
                    raise ValueError("Selected pool replay is incomplete")
                active_ports = [port for port, player in enumerate(game.start.players)
                                if player is not None]
                if len(active_ports) != 2 or entrant_a_port not in active_ports:
                    raise ValueError("Selected pool replay is not two-player singles")
                if order == 1 and game.start.players[entrant_a_port].character.name != selected["entrantAOpeningCharacter"]:
                    raise ValueError("Entrant identity disagrees with reviewed opening character")
                final = next((frame.ports for frame in reversed(game.frames)
                              if all(frame.ports[port] is not None and
                                     frame.ports[port].leader.post is not None
                                     for port in active_ports)), None)
                if final is None:
                    raise ValueError("Selected pool replay lacks terminal stock data")
                stocks = [final[port].leader.post.stocks for port in active_ports]
                if stocks.count(0) != 1 or max(stocks) == 0:
                    raise ValueError("Selected pool replay has ambiguous terminal result")
                winner_port = active_ports[0 if stocks[0] > 0 else 1]
                winner_side = 0 if winner_port == entrant_a_port else 1
                score[winner_side] += 1
                stages.append(stage_key(game.start.stage.name))
                digest = hashlib.sha256(content).hexdigest()
                replay_id = opaque_id("replay", digest)
                replays.append({
                    "replayId": replay_id,
                    "assetId": asset["assetId"],
                    "zipEntryPath": member,
                    "sha256": digest,
                    "byteSize": len(content),
                    "formatEvidence": "Parsed .slp with two singles players, complete GAME ending, unambiguous terminal stocks and source-matched stage.",
                    "participants": {"player1": selected["entrantA"] if active_ports[0] == entrant_a_port else selected["entrantB"],
                                     "player2": selected["entrantB"] if active_ports[0] == entrant_a_port else selected["entrantA"]},
                    "sourceIdentity": f"{ARCHIVE_URL}#{member}",
                    "aliases": [member],
                })
                segment_rows.append({
                    "replayId": replay_id,
                    "order": order,
                    "group": "main",
                    "player1Entrant": "A" if active_ports[0] == entrant_a_port else "B",
                    "player2Entrant": "B" if active_ports[0] == entrant_a_port else "A",
                    "openingCharacters": entrant_ordered_characters(
                        game.start.players, entrant_a_port,
                        active_ports[0] if active_ports[1] == entrant_a_port else active_ports[1]),
                    "scoreEffect": "entrantA" if winner_side == 0 else "entrantB",
                })
            if facts_hash(stages) != selected["stageSequenceSha256"] or facts_hash(score) != selected["sourceScoreSha256"]:
                raise ValueError("Selected pool games disagree with independent source review")
            target = max(score)
            if target not in (2, 3) or score[0] == score[1]:
                raise ValueError("Selected pool set lacks a valid terminal score")
            best_of = 3 if target == 2 else 5
            if any(max(sum(row["scoreEffect"] == side for row in segment_rows[:index])
                       for side in ("entrantA", "entrantB")) >= target
                   for index in range(1, len(segment_rows))):
                raise ValueError("Selected pool set continues after its terminal game")
            item_id = opaque_id("item", f"summit11-pool-{selected['sourceThread'].rsplit('/', 1)[-1]}")
            items.append({
                "itemId": item_id,
                "kind": "set",
                "sourceSetIdentity": f"Smash Summit 11 Group {selected['pool']} Pools: {selected['entrantA']} vs {selected['entrantB']}",
                "eventContext": f"Smash Summit 11 - Group {selected['pool']} Pools",
                "entrantA": selected["entrantA"],
                "entrantB": selected["entrantB"],
                "bestOf": best_of,
                "completionRule": "target-wins",
                "segments": segment_rows,
                "verification": {
                    "method": "reviewed-source-crosscheck",
                    "sourceReferences": [PUBLISHER_POST, ARCHIVE_URL,
                                         selected["sourceThread"], selected["organizerVideo"]],
                    "reviewer": "Melee Replay curation",
                    "verifiedAt": REVIEWED_AT,
                    "manifestRevision": "filled-by-catalog-builder",
                    "orderedAssetHashes": [replay["sha256"] for replay in replays[-len(members):]],
                    "completenessEvidence": "Ordered replay stages and terminal set score match the independent match record; the organizer video identifies the entrants and pool. Every selected archive member has a complete GAME ending and unambiguous terminal stocks.",
                    "decisions": "Only the source-matched archive window is admitted. Entrant assignment follows the organizer video opening character; nearby warmups and unrelated games are excluded.",
                },
                "sourceResult": {"entrantA": score[0], "entrantB": score[1]},
            })
    OUTPUT.write_text(json.dumps({"source": source, "asset": asset, "replays": replays,
                                  "items": items, "catalogItemIds": [item["itemId"] for item in items]},
                                 indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    print("Reviewed official archive and wrote pool-set evidence.")


if __name__ == "__main__":
    main()
