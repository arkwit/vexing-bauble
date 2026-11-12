from sqlmodel import SQLModel, Field
from datetime import date
from decimal import Decimal


class Card(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)

    oracle_id: str = Field(unique=True, index=True)
    name: str
    mana_cost: str | None = None
    type_line: str | None = None
    oracle_text: str | None = None


class Printing(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)

    card_id: int = Field(foreign_key="card.id")

    scryfall_id: str = Field(unique=True, index=True)
    set_code: str
    collector_number: str
    rarity: str | None = None
    image_uri: str | None = None


class OwnedCopy(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)

    printing_id: int = Field(foreign_key="printing.id")

    condition: str
    finish: str
    language: str = "English"

    purchase_price: Decimal | None = None
    purchase_date: date | None = None
    notes: str | None = None
