from sqlmodel import SQLModel


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
