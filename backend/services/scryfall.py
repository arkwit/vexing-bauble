from typing import Any

import httpx

BASE_URL = "https://api.scryfall.com"
HEADERS = {"User-Agent": "Vexing-Bauble/0.1", "Accept": "application/json"}


async def get_card_by_id(scryfall_id: str):
    """
    Retrieve one specific card printing from Scryfall.
    """

    async with httpx.AsyncClient(headers=HEADERS, timeout=15.0) as client:

        response = await client.get(f"{BASE_URL}/cards/{scryfall_id}")

        response.raise_for_status()

        return response.json()


async def get_cards_by_ids(
    scryfall_ids: list[str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    cards: list[dict[str, Any]] = []
    not_found: list[dict[str, Any]] = []

    async with httpx.AsyncClient(headers=HEADERS, timeout=15.0) as client:
        for start in range(0, len(scryfall_ids), 75):
            batch = scryfall_ids[start : start + 75]
            response = await client.post(
                f"{BASE_URL}/cards/collection",
                json={
                    "identifiers": [{"id": scryfall_id} for scryfall_id in batch]
                },
            )
            response.raise_for_status()
            result = response.json()
            cards.extend(result.get("data", []))
            not_found.extend(result.get("not_found", []))

    return cards, not_found
