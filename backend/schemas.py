from datetime import date
from decimal import Decimal
import re

from pydantic import field_validator
from sqlmodel import SQLModel, Field


class BinderCreate(SQLModel):
    name: str = Field(min_length=1, max_length=80)
    color: str = Field(default="#5b9465", min_length=7, max_length=7)
    cover_printing_id: int | None = None

    @field_validator("color")
    @classmethod
    def validate_color(cls, value: str) -> str:
        if re.fullmatch(r"#[0-9A-Fa-f]{6}", value) is None:
            raise ValueError("Color must be a six-digit hexadecimal value.")
        return value.lower()


class BinderUpdate(BinderCreate):
    pass


class BinderRead(SQLModel):
    id: int
    name: str
    color: str
    cover_printing_id: int | None = None
    cover_image_uri: str | None = None
    cover_card_name: str | None = None
    cover_set_code: str | None = None
    cover_collector_number: str | None = None


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
    art_crop_uri: str | None = None
    eur_price: Decimal | None = None
    eur_foil_price: Decimal | None = None
    eur_etched_price: Decimal | None = None


class PrintingRead(SQLModel):
    id: int
    card_id: int
    scryfall_id: str
    set_code: str
    collector_number: str
    rarity: str | None = None
    image_uri: str | None = None
    art_crop_uri: str | None = None
    eur_price: Decimal | None = None
    eur_foil_price: Decimal | None = None
    eur_etched_price: Decimal | None = None


class OwnedCopyDetails(SQLModel):
    condition: str
    finish: str
    language: str = "English"
    binder_id: int | None = None
    purchase_price: Decimal | None = None
    purchase_date: date | None = None
    notes: str | None = None


class OwnedCopyCreate(OwnedCopyDetails):
    printing_id: int


class ManaBoxCopyImport(OwnedCopyDetails):
    quantity: int = Field(default=1, ge=1)


class ManaBoxPrintingImport(SQLModel):
    scryfall_id: str
    copies: list[ManaBoxCopyImport] = Field(min_length=1)


class ManaBoxImportRequest(SQLModel):
    printings: list[ManaBoxPrintingImport] = Field(min_length=1)


class OwnedCopyRead(SQLModel):
    id: int
    printing_id: int
    binder_id: int | None = None
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
    binder_id: int | None = None
    purchase_price: Decimal | None = None
    purchase_date: date | None = None
    notes: str | None = None


class BulkCopyUpdate(SQLModel):
    copy_ids: list[int] = Field(min_length=1)
    binder_id: int | None = None
    condition: str | None = None
    finish: str | None = None
    language: str | None = None


class BulkCopyDelete(SQLModel):
    copy_ids: list[int] = Field(min_length=1)


class PrintingCollectionRead(SQLModel):
    id: int
    scryfall_id: str
    set_code: str
    collector_number: str
    rarity: str | None = None
    image_uri: str | None = None
    eur_price: Decimal | None = None
    eur_foil_price: Decimal | None = None
    eur_etched_price: Decimal | None = None

    copies: list[OwnedCopyRead] = Field(default_factory=list)


class CardCollectionRead(SQLModel):
    id: int
    oracle_id: str
    name: str
    mana_cost: str | None = None
    type_line: str | None = None
    oracle_text: str | None = None

    printings: list[PrintingCollectionRead] = Field(default_factory=list)
