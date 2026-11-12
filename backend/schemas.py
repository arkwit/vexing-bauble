from datetime import date
from decimal import Decimal

from sqlmodel import SQLModel, Field


class CardCreate(SQLModel):
    oracle_id: str
    name: str
    mana_cost: str | None = None
    type_line: str | None = None
    oracle_text: str | None = None


class CardRead(SQLModel):
    id: int
    oracle_id: str
    name: str
    mana_cost: str | None = None
    type_line: str | None = None
    oracle_text: str | None = None


class PrintingCreate(SQLModel):
    card_id: int
    scryfall_id: str
    set_code: str
    collector_number: str
    rarity: str | None = None
    image_uri: str | None = None


class PrintingRead(SQLModel):
    id: int
    card_id: int
    scryfall_id: str
    set_code: str
    collector_number: str
    rarity: str | None = None
    image_uri: str | None = None


class OwnedCopyCreate(SQLModel):
    printing_id: int
    condition: str
    finish: str
    language: str = "English"
    purchase_price: Decimal | None = None
    purchase_date: date | None = None
    notes: str | None = None


class OwnedCopyRead(SQLModel):
    id: int
    printing_id: int
    condition: str
    finish: str
    language: str
    purchase_price: Decimal | None = None
    purchase_date: date | None = None
    notes: str | None = None


class OwnedCopyUpdate(SQLModel):
    condition: str
    finish: str
    language: str
    purchase_price: Decimal | None = None
    purchase_date: date | None = None
    notes: str | None = None


class PrintingCollectionRead(SQLModel):
    id: int
    scryfall_id: str
    set_code: str
    collector_number: str
    rarity: str | None = None
    image_uri: str | None = None

    copies: list[OwnedCopyRead] = Field(default_factory=list)


class CardCollectionRead(SQLModel):
    id: int
    oracle_id: str
    name: str
    mana_cost: str | None = None
    type_line: str | None = None
    oracle_text: str | None = None

    printings: list[PrintingCollectionRead] = Field(default_factory=list)
