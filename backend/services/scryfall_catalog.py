import gzip
import json
import logging
import tempfile
from pathlib import Path
from typing import Any

import httpx
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import Session, func, select

from database import engine
from models import Card, Printing, ScryfallCatalogState
from services.pricing import PRICE_DATA_VERSION, euro_prices_from_scryfall

BASE_URL = "https://api.scryfall.com"
HEADERS = {"User-Agent": "Vexing-Bauble/0.1", "Accept": "application/json"}
logger = logging.getLogger(__name__)

_catalog_status: dict[str, Any] = {
    "status": "missing",
    "message": "The local card catalog has not been downloaded yet.",
}


def get_catalog_status() -> dict[str, Any]:
    return dict(_catalog_status)


def mark_catalog_sync_starting() -> None:
    if _catalog_status.get("status") == "ready":
        _set_catalog_status(
            "ready",
            "Refreshing the local card catalog in the background.",
            updated_at=_catalog_status.get("updated_at"),
            card_count=_catalog_status.get("card_count"),
            refreshing=True,
        )
    else:
        _set_catalog_status(
            "checking", "Checking Scryfall catalog version."
        )


def _set_catalog_status(
    status: str, message: str, **details: Any
) -> None:
    _catalog_status.clear()
    _catalog_status.update(
        {"status": status, "message": message, **details}
    )


def initialize_catalog_status() -> bool:
    with Session(engine) as session:
        saved_state = session.get(ScryfallCatalogState, 1)
        card_count = session.exec(select(func.count(Card.id))).one()

    if saved_state and card_count > 0:
        _set_catalog_status(
            "ready",
            "Local card catalog is ready.",
            updated_at=saved_state.bulk_updated_at,
            card_count=card_count,
            refreshing=False,
        )
        return True

    _set_catalog_status(
        "missing",
        "The local card catalog has not been downloaded yet.",
    )
    return False


def _image_uri(card_data: dict[str, Any], size: str = "normal") -> str | None:
    image_uris = card_data.get("image_uris") or {}
    if not image_uris:
        faces = card_data.get("card_faces") or []
        if faces:
            image_uris = faces[0].get("image_uris") or {}
    return image_uris.get(size)


def _set_latest_card_data(card: Card, card_data: dict[str, Any]) -> None:
    release_date = card_data.get("released_at") or ""
    latest_key = (
        card.latest_released_at or "",
        card.latest_set_code or "",
        card.latest_collector_number or "",
    )
    candidate_key = (
        release_date,
        card_data.get("set") or "",
        card_data.get("collector_number") or "",
    )
    if candidate_key < latest_key:
        return

    card.name = card_data["name"]
    card.mana_cost = card_data.get("mana_cost")
    card.type_line = card_data.get("type_line")
    card.oracle_text = card_data.get("oracle_text")
    card.latest_scryfall_id = card_data["id"]
    card.latest_set_code = card_data.get("set")
    card.latest_set_name = card_data.get("set_name")
    card.latest_collector_number = card_data.get("collector_number")
    card.latest_rarity = card_data.get("rarity")
    card.latest_released_at = release_date or None
    card.latest_finishes = ",".join(card_data.get("finishes") or [])


def _upsert_catalog_batch(card_data_batch: list[dict[str, Any]]) -> None:
    oracle_ids = {
        card_data["oracle_id"]
        for card_data in card_data_batch
        if card_data.get("oracle_id") and card_data.get("id")
    }
    if not oracle_ids:
        return

    with Session(engine) as session:
        cards_by_oracle_id = {
            card.oracle_id: card
            for card in session.exec(
                select(Card).where(Card.oracle_id.in_(oracle_ids))
            ).all()
        }

        for card_data in card_data_batch:
            oracle_id = card_data.get("oracle_id")
            if not oracle_id or not card_data.get("id"):
                continue

            card = cards_by_oracle_id.get(oracle_id)
            if card is None:
                card = Card(oracle_id=oracle_id, name=card_data["name"])
                cards_by_oracle_id[oracle_id] = card
            _set_latest_card_data(card, card_data)
            session.add(card)

        session.flush()

        scryfall_ids = [
            card_data["id"]
            for card_data in card_data_batch
            if card_data.get("oracle_id") and card_data.get("id")
        ]
        printings_by_scryfall_id = {
            printing.scryfall_id: printing
            for printing in session.exec(
                select(Printing).where(Printing.scryfall_id.in_(scryfall_ids))
            ).all()
        }

        for card_data in card_data_batch:
            oracle_id = card_data.get("oracle_id")
            scryfall_id = card_data.get("id")
            if not oracle_id or not scryfall_id:
                continue

            card = cards_by_oracle_id[oracle_id]
            if card.id is None:
                raise ValueError(f"Could not create card identity {oracle_id}.")

            printing = printings_by_scryfall_id.get(scryfall_id)
            if printing is None:
                printing = Printing(
                    card_id=card.id,
                    scryfall_id=scryfall_id,
                    set_code=card_data["set"],
                    collector_number=card_data["collector_number"],
                )

            printing.set_name = card_data.get("set_name")
            printing.released_at = card_data.get("released_at")
            printing.rarity = card_data.get("rarity")
            printing.image_uri = _image_uri(card_data)
            printing.small_image_uri = _image_uri(card_data, "small")
            printing.art_crop_uri = _image_uri(card_data, "art_crop")
            printing.finish_options = ",".join(card_data.get("finishes") or [])
            printing.language = card_data.get("lang")
            for field, value in euro_prices_from_scryfall(card_data).items():
                setattr(printing, field, value)
            session.add(printing)

        session.commit()


async def sync_scryfall_catalog() -> None:
    cached_catalog = False

    try:
        with Session(engine) as session:
            saved_state = session.get(ScryfallCatalogState, 1)
            card_count = session.exec(select(func.count(Card.id))).one()
            cached_catalog = bool(saved_state and card_count > 0)
            if cached_catalog:
                _set_catalog_status(
                    "ready",
                    "Local card catalog is ready.",
                    updated_at=saved_state.bulk_updated_at,
                    card_count=card_count,
                    refreshing=True,
                )
            else:
                _set_catalog_status(
                    "checking", "Checking Scryfall catalog version."
                )

        timeout = httpx.Timeout(300.0, connect=15.0)
        async with httpx.AsyncClient(
            headers=HEADERS, timeout=timeout
        ) as client:
            response = await client.get(f"{BASE_URL}/bulk-data")
            response.raise_for_status()
            bulk_items = response.json().get("data", [])
            bulk_data = next(
                (
                    item
                    for item in bulk_items
                    if item.get("type") == "default_cards"
                ),
                None,
            )
            if not bulk_data:
                raise ValueError("Scryfall did not provide the default cards catalog.")

            bulk_updated_at = bulk_data.get("updated_at")
            download_uri = (
                bulk_data.get("jsonl_download_uri")
                or bulk_data.get("download_uri")
            )
            if not bulk_updated_at or not download_uri:
                raise ValueError("Scryfall catalog metadata is incomplete.")

            if (
                saved_state
                and saved_state.bulk_updated_at == bulk_updated_at
                and saved_state.price_data_version >= PRICE_DATA_VERSION
                and card_count > 0
            ):
                _set_catalog_status(
                    "ready",
                    "Local card catalog is up to date.",
                    updated_at=bulk_updated_at,
                    card_count=card_count,
                    refreshing=False,
                )
                return

            if cached_catalog:
                _set_catalog_status(
                    "ready",
                    "Refreshing the local card catalog in the background.",
                    updated_at=saved_state.bulk_updated_at,
                    card_count=card_count,
                    refreshing=True,
                )
            else:
                _set_catalog_status(
                    "downloading",
                    "Downloading the Scryfall card catalog for local search.",
                )
            with tempfile.TemporaryDirectory(
                prefix="vexing-bauble-catalog-"
            ) as temporary_directory:
                archive_path = Path(temporary_directory) / "default-cards.jsonl.gz"
                async with client.stream("GET", download_uri) as download:
                    download.raise_for_status()
                    with archive_path.open("wb") as archive:
                        async for chunk in download.aiter_raw():
                            archive.write(chunk)

                if not cached_catalog:
                    _set_catalog_status(
                        "indexing",
                        "Indexing cards and printings in the local database.",
                    )
                processed = 0
                batch: list[dict[str, Any]] = []
                with gzip.open(archive_path, "rt", encoding="utf-8") as source:
                    for line in source:
                        card_data = json.loads(line)
                        if not isinstance(card_data, dict):
                            continue
                        batch.append(card_data)
                        if len(batch) == 500:
                            _upsert_catalog_batch(batch)
                            processed += len(batch)
                            batch.clear()

                if batch:
                    _upsert_catalog_batch(batch)
                    processed += len(batch)

            with Session(engine) as session:
                state = session.get(ScryfallCatalogState, 1)
                if state is None:
                    state = ScryfallCatalogState(
                        id=1,
                        bulk_updated_at=bulk_updated_at,
                        price_data_version=PRICE_DATA_VERSION,
                    )
                else:
                    state.bulk_updated_at = bulk_updated_at
                    state.price_data_version = PRICE_DATA_VERSION
                session.add(state)
                session.commit()
                card_count = session.exec(
                    select(func.count(Card.id))
                ).one()

            _set_catalog_status(
                "ready",
                "Local card catalog is ready.",
                updated_at=bulk_updated_at,
                card_count=card_count,
                printings_processed=processed,
                refreshing=False,
            )
    except (
        httpx.HTTPError,
        OSError,
        ValueError,
        KeyError,
        TypeError,
        SQLAlchemyError,
    ) as error:
        logger.exception("Could not synchronize the Scryfall card catalog.")
        if cached_catalog:
            _set_catalog_status(
                "ready",
                "Local catalog is available, but its update failed.",
                updated_at=saved_state.bulk_updated_at,
                card_count=card_count,
                error=str(error),
                refreshing=False,
            )
        else:
            _set_catalog_status(
                "error",
                "Could not synchronize the Scryfall card catalog.",
                error=str(error),
            )
