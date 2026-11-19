from decimal import Decimal
from typing import Any

from models import Printing

PRICE_DATA_VERSION = 1


def euro_prices_from_scryfall(card_data: dict[str, Any]) -> dict[str, Decimal | None]:
    prices = card_data.get("prices") or {}
    return {
        "eur_price": _parse_euro_price(prices.get("eur")),
        "eur_foil_price": _parse_euro_price(prices.get("eur_foil")),
        "eur_etched_price": _parse_euro_price(prices.get("eur_etched")),
    }


def current_euro_price(printing: Printing, finish: str) -> Decimal | None:
    normalized_finish = finish.strip().lower()
    if normalized_finish in {"paper", "proxy", "paper/proxy"}:
        return Decimal("0")
    if normalized_finish == "foil":
        return printing.eur_foil_price
    if normalized_finish == "etched":
        return printing.eur_etched_price
    return printing.eur_price


def _parse_euro_price(value: Any) -> Decimal | None:
    return None if value is None else Decimal(str(value))
