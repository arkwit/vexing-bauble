from contextlib import asynccontextmanager

from fastapi import FastAPI, Depends, HTTPException
from sqlmodel import Session, select

from database import create_db_and_tables, get_session
from models import Card
from schemas import CardCreate, CardRead


@asynccontextmanager
async def lifespan(app: FastAPI):
    create_db_and_tables()

    yield


app = FastAPI(lifespan=lifespan)


# app.get(adress) -> handle GET request to adress
@app.get("/")
def root():
    return {"message": "Hello from my API"}


@app.get("/health")
def health():
    return {"status": "running"}


@app.get("/cards", response_model=list[CardRead])
def get_cards(session: Session = Depends(get_session)):
    statement = select(Card)
    cards = session.exec(statement).all()

    return cards


@app.post("/cards", response_model=CardRead)
def create_card(
    card_data: CardCreate, session: Session = Depends(get_session)
):
    existing_card = session.exec(
        select(Card).where(Card.oracle_id == card_data.oracle_id)
    ).first()

    if existing_card:
        raise HTTPException(
            status_code=409, detail="This card already exists."
        )

    # convert to db object
    new_card = Card(**card_data.model_dump())

    # add to db session
    session.add(new_card)

    # save changes
    session.commit()

    # refresh to get id
    session.refresh(new_card)

    return new_card
