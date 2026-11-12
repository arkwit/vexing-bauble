import httpx

BASE_URL = "https://api.scryfall.com"

HEADERS = {"User-Agent": "Vexing-Bauble/0.1", "Accept": "application/json"}


async def search_cards(query: str):
    """
    Search Scryfall for card printings.
    """

    async with httpx.AsyncClient(headers=HEADERS, timeout=15.0) as client:

        response = await client.get(
            f"{BASE_URL}/cards/search", params={"q": query, "unique": "prints"}
        )

        response.raise_for_status()

        return response.json()


async def get_card_by_id(scryfall_id: str):
    """
    Retrieve one specific card printing from Scryfall.
    """

    async with httpx.AsyncClient(headers=HEADERS, timeout=15.0) as client:

        response = await client.get(f"{BASE_URL}/cards/{scryfall_id}")

        response.raise_for_status()

        return response.json()
