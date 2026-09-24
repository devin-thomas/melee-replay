"""Rebuild backstage evidence for exact per-set links on an Ausmash result page.

Requires requests, beautifulsoup4, py-slippi==1.6.2 and the four source .slp
files in data/archives/ausmash-19383/. Pass --fetch to retrieve them with curl.
"""

from __future__ import annotations

import hashlib
import io
import json
import subprocess
import sys
import uuid
from pathlib import Path
from urllib.parse import urlparse

import requests
import slippi
from bs4 import BeautifulSoup

from character_metadata import entrant_ordered_characters
from review_summit11 import NAMESPACE


DIRECTORY = Path(__file__).parent
SELECTIONS = DIRECTORY / "ausmash-19383-selections.json"
OUTPUT = DIRECTORY / "ausmash-19383-records.json"
ARCHIVE = DIRECTORY.parent / "archives" / "ausmash-19383"
SOURCE_ID = "ausmash-public-results"
HOST = "ausmashstorage.blob.core.windows.net"


def opaque_id(kind: str, key: str) -> str:
    return str(uuid.uuid5(NAMESPACE, f"{SOURCE_ID}:{kind}:{key}"))


def source_rows(page: str) -> dict[tuple[str, str, str], tuple[tuple[int, int], list[str]]]:
    rows = {}
    soup = BeautifulSoup(page, "html.parser")
    for row in soup.select("tr.match-history__item"):
        cells = row.find_all("td", recursive=False)
        if len(cells) != 4:
            continue
        players = [cell.get_text(" ", strip=True) for cell in cells if "match-history__item__player" in cell.get("class", [])]
        score = cells[2].get_text(" ", strip=True)
        if len(players) != 2 or " - " not in score:
            continue
        following = row.find_next_sibling("tr")
        links = [] if following is None else [link["href"].split("path=", 1)[1]
            for link in following.find_all("a", href=True)
            if link["href"].startswith("slippi://play?path=")]
        if not links:
            continue
        key = (cells[0].get_text(" ", strip=True), players[0], players[1])
        if key in rows:
            raise ValueError("The event page has an ambiguous match row")
        left, right = score.split(" - ", 1)
        rows[key] = ((int(left), int(right)), links)
    return rows


def replay_bytes(record: dict, fetch: bool) -> bytes:
    url = record["url"]
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != HOST or not parsed.path.startswith("/ausmash-content/"):
        raise ValueError("Replay link is outside the reviewed publisher scope")
    path = ARCHIVE / record["localFile"]
    if path.parent != ARCHIVE or path.suffix != ".slp":
        raise ValueError("Invalid local replay path")
    if fetch:
        ARCHIVE.mkdir(parents=True, exist_ok=True)
        subprocess.run(["curl.exe", "--fail", "--location", "--silent", "--show-error",
                        "--max-time", "90", "--output", str(path), url], check=True)
    content = path.read_bytes()
    if len(content) != record["byteSize"] or hashlib.sha256(content).hexdigest() != record["sha256"]:
        raise ValueError("Publisher replay bytes differ from the pinned review")
    return content


def main() -> None:
    selections = json.loads(SELECTIONS.read_text(encoding="utf-8"))
    response = requests.get(selections["eventPage"], timeout=30)
    response.raise_for_status()
    rows = source_rows(response.text)
    assets = []
    replays = []
    items = []
    seen_urls = set()
    for selected in selections["sets"]:
        key = (selected["round"], selected["entrantA"], selected["entrantB"])
        row_score, row_links = rows[key]
        games = selected["games"]
        if row_score != tuple(selected["sourceScore"]) or row_links != [game["url"] for game in games]:
            raise ValueError("The event's ordered game links or match result changed")
        if len(games) not in (2, 3) or max(row_score) != 2 or min(row_score) == 2:
            raise ValueError("The selected match is not a complete best-of-three")
        segments = []
        score = [0, 0]
        for order, record in enumerate(games, 1):
            if record["url"] in seen_urls:
                raise ValueError("Selected matches overlap on a replay link")
            seen_urls.add(record["url"])
            content = replay_bytes(record, "--fetch" in sys.argv)
            game = slippi.Game(io.BytesIO(content))
            ports = [port for port, player in enumerate(game.start.players) if player is not None]
            if (len(ports) != 2 or game.start.is_teams or game.end is None
                    or game.end.method.name != "GAME"
                    or any(game.start.players[port].type.name != "HUMAN" for port in ports)):
                raise ValueError("Selected replay is not a complete human singles game")
            character_ports = {game.start.players[port].character.name: port for port in ports}
            if set(character_ports) != {selected["entrantACharacter"], selected["entrantBCharacter"]}:
                raise ValueError("Replay opening characters disagree with the publisher row")
            entrant_a_port = character_ports[selected["entrantACharacter"]]
            entrant_b_port = character_ports[selected["entrantBCharacter"]]
            final = next((frame.ports for frame in reversed(game.frames)
                          if all(frame.ports[port] is not None and
                                 frame.ports[port].leader.post is not None for port in ports)), None)
            if final is None:
                raise ValueError("Replay has no terminal stock state")
            stocks_a = final[entrant_a_port].leader.post.stocks
            stocks_b = final[entrant_b_port].leader.post.stocks
            if (stocks_a == 0) == (stocks_b == 0):
                raise ValueError("Replay terminal result is ambiguous")
            winner = 0 if stocks_a > 0 else 1
            score[winner] += 1
            digest = record["sha256"]
            asset_id = opaque_id("asset", digest)
            replay_id = opaque_id("replay", digest)
            assets.append({
                "assetId": asset_id,
                "sourceId": SOURCE_ID,
                "format": "slp",
                "fetchUrl": record["url"],
                "sha256": digest,
                "byteSize": record["byteSize"],
            })
            replays.append({
                "replayId": replay_id,
                "assetId": asset_id,
                "sha256": digest,
                "byteSize": record["byteSize"],
                "formatEvidence": "Publisher-linked .slp parsed as a complete human singles GAME with unambiguous terminal stocks.",
                "participants": {
                    "player1": selected["entrantA"] if ports[0] == entrant_a_port else selected["entrantB"],
                    "player2": selected["entrantA"] if ports[1] == entrant_a_port else selected["entrantB"],
                },
                "sourceIdentity": record["url"],
                "aliases": [record["url"]],
            })
            segments.append({
                "replayId": replay_id,
                "order": order,
                "group": "main",
                "player1Entrant": "A" if ports[0] == entrant_a_port else "B",
                "player2Entrant": "A" if ports[1] == entrant_a_port else "B",
                "openingCharacters": entrant_ordered_characters(game.start.players, entrant_a_port, entrant_b_port),
                "scoreEffect": "entrantA" if winner == 0 else "entrantB",
            })
        if tuple(score) != row_score:
            raise ValueError("Replay results disagree with the publisher's match result")
        if any(sum(segment["scoreEffect"] == side for segment in segments[:index]) >= 2
               for index in range(1, len(segments)) for side in ("entrantA", "entrantB")):
            raise ValueError("Source continues after the terminal game")
        item_id = opaque_id("item", f"19383:{selected['round']}:{selected['entrantA']}:{selected['entrantB']}")
        items.append({
            "itemId": item_id,
            "kind": "set",
            "sourceSetIdentity": f"Ausmash event 19383: {selected['round']} {selected['entrantA']} vs {selected['entrantB']}",
            "eventContext": selections["eventName"],
            "entrantA": selected["entrantA"],
            "entrantB": selected["entrantB"],
            "bestOf": 3,
            "completionRule": "target-wins",
            "segments": segments,
            "verification": {
                "method": "reviewed-source-crosscheck",
                "sourceReferences": [selections["eventPage"], selections["termsPage"],
                                     *[game["url"] for game in games]],
                "reviewer": "Melee Replay curation",
                "verifiedAt": selections["reviewedAt"],
                "manifestRevision": "filled-by-catalog-builder",
                "orderedAssetHashes": [game["sha256"] for game in games],
                "completenessEvidence": "The publisher's bracket row gives the set score and exactly ordered per-game Slippi links; every linked game was downloaded, hashed, parsed to a complete ending, and its terminal score agreed with that row.",
                "decisions": "Membership and chronology come from the publisher's Game 1/2/3 links in the same bracket row, not file proximity or timestamps.",
            },
            "sourceResult": {"entrantA": score[0], "entrantB": score[1]},
        })
    source = {
        "sourceId": SOURCE_ID,
        "publisher": "Ausmash tournament results",
        "evidenceUrls": [selections["eventPage"], selections["termsPage"]],
        "accessConditions": "The publisher exposes direct ordered replay links on its public bracket page; no account was required during review.",
        "useConditions": "The app fetches individual replay files from the publisher's storage and does not redistribute them. Ausmash terms do not state a replay redistribution license.",
        "reviewedAt": selections["reviewedAt"],
        "auditReference": "data/sets/ausmash-19383-records.json: pinned direct-file hashes and per-match ordered link, game ending and bracket-result cross-check.",
        "downloadScopes": [{"origin": "https://ausmashstorage.blob.core.windows.net",
                            "pathPrefix": "/ausmash-content/"}],
        "redirectScopes": [],
        "eligibility": "eligible",
    }
    OUTPUT.write_text(json.dumps({"source": source, "assets": assets, "replays": replays,
                                  "items": items, "catalogItemIds": [item["itemId"] for item in items]},
                                 indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    print("Reviewed publisher-linked best-of-three sets and wrote backstage evidence.")


if __name__ == "__main__":
    main()
