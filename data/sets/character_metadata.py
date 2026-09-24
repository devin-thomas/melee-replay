"""Display labels for opening characters recorded in verified replay evidence."""


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


def entrant_ordered_characters(players: list, entrant_a_port: int, entrant_b_port: int) -> list[str]:
    """Keep display order fixed to entrant A/B when replay player ports vary."""
    return [character_label(players[entrant_a_port].character.name),
            character_label(players[entrant_b_port].character.name)]
