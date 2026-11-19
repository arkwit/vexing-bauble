from sqlmodel import SQLModel, Field
from datetime import date
from decimal import Decimal


class Card(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)

    oracle_id: str = Field(unique=True, index=True)
    name: str = Field(index=True)
    mana_cost: str | None = None
    type_line: str | None = None
    oracle_text: str | None = None
    latest_scryfall_id: str | None = None
    latest_set_code: str | None = None
    latest_set_name: str | None = None
    latest_collector_number: str | None = None
    latest_rarity: str | None = None
    latest_released_at: str | None = None
    latest_finishes: str | None = None


class Printing(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)

    card_id: int = Field(foreign_key="card.id")

    scryfall_id: str = Field(unique=True, index=True)
    set_code: str
    collector_number: str
    rarity: str | None = None
    image_uri: str | None = None
    small_image_uri: str | None = None
    art_crop_uri: str | None = None
    set_name: str | None = None
    released_at: str | None = None
    finish_options: str | None = None
    language: str | None = None
    eur_price: Decimal | None = None
    eur_foil_price: Decimal | None = None
    eur_etched_price: Decimal | None = None


class ScryfallCatalogState(SQLModel, table=True):
    id: int = Field(default=1, primary_key=True)
    bulk_updated_at: str
    price_data_version: int = 0


class Binder(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(index=True, unique=True, max_length=80)
    color: str = "#5b9465"
    cover_printing_id: int | None = Field(
        default=None, foreign_key="printing.id"
    )


class OwnedCopy(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)

    printing_id: int = Field(foreign_key="printing.id")
    binder_id: int | None = Field(default=None, foreign_key="binder.id", index=True)

    condition: str
    finish: str
    language: str = "English"

    purchase_price: Decimal | None = None
    purchase_date: date | None = None
    notes: str | None = None
