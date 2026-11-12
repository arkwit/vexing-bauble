from contextlib import asynccontextmanager

from fastapi import FastAPI, Depends, HTTPException, Query
from sqlmodel import Session, select
import httpx

from database import create_db_and_tables, get_session
from models import Card, Printing, OwnedCopy
from schemas import (
    CardCreate,
    CardRead,
    PrintingCreate,
    PrintingRead,
    OwnedCopyCreate,
    OwnedCopyRead,
    OwnedCopyUpdate,
    CardCollectionRead,
)
from services.scryfall import search_cards, get_card_by_id


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


@app.get("/printings", response_model=list[PrintingRead])
def get_printings(session: Session = Depends(get_session)):
    statement = select(Printing)
    printings = session.exec(statement).all()

    return printings


@app.get("/cards/{card_id}/printings", response_model=list[PrintingRead])
def get_card_printings(card_id: int, session: Session = Depends(get_session)):

    card = session.get(Card, card_id)

    if card is None:
        raise HTTPException(status_code=404, detail="Card not found.")

    statement = select(Printing).where(Printing.card_id == card_id)

    return session.exec(statement).all()


@app.post("/printings", response_model=PrintingRead)
def create_printing(
    printing_data: PrintingCreate, session: Session = Depends(get_session)
):

    # Check whether the referenced card exists
    card = session.get(Card, printing_data.card_id)

    if card is None:
        raise HTTPException(status_code=404, detail="Card not found.")

    # Check for duplicate Scryfall IDs
    existing = session.exec(
        select(Printing).where(
            Printing.scryfall_id == printing_data.scryfall_id
        )
    ).first()

    if existing:
        raise HTTPException(
            status_code=409, detail="This printing already exists."
        )

    new_printing = Printing(**printing_data.model_dump())

    session.add(new_printing)
    session.commit()
    session.refresh(new_printing)

    return new_printing


# Retrieve all physical copies
@app.get("/copies", response_model=list[OwnedCopyRead])
def get_copies(session: Session = Depends(get_session)):

    statement = select(OwnedCopy)

    return session.exec(statement).all()


# Retrieve a specific physical copy
@app.get("/copies/{copy_id}", response_model=OwnedCopyRead)
def get_copy(copy_id: int, session: Session = Depends(get_session)):

    copy = session.get(OwnedCopy, copy_id)

    if copy is None:
        raise HTTPException(status_code=404, detail="Copy not found.")

    return copy


# Retrieve all physical copies of a printing
@app.get("/printings/{printing_id}/copies", response_model=list[OwnedCopyRead])
def get_printing_copies(
    printing_id: int, session: Session = Depends(get_session)
):

    printing = session.get(Printing, printing_id)

    if printing is None:
        raise HTTPException(status_code=404, detail="Printing not found.")

    statement = select(OwnedCopy).where(OwnedCopy.printing_id == printing_id)

    return session.exec(statement).all()


# Create a physical copy
@app.post("/printings/{printing_id}/copies", response_model=OwnedCopyRead)
def create_copy(
    printing_id: int,
    copy_data: OwnedCopyCreate,
    session: Session = Depends(get_session),
):

    printing = session.get(Printing, printing_id)

    if printing is None:
        raise HTTPException(status_code=404, detail="Printing not found.")

    if copy_data.printing_id != printing_id:
        raise HTTPException(
            status_code=400, detail="Printing ID does not match the URL."
        )

    new_copy = OwnedCopy(**copy_data.model_dump())

    session.add(new_copy)
    session.commit()
    session.refresh(new_copy)

    return new_copy


# Update a physical copy
@app.put("/copies/{copy_id}", response_model=OwnedCopyRead)
def update_copy(
    copy_id: int,
    copy_data: OwnedCopyUpdate,
    session: Session = Depends(get_session),
):

    existing_copy = session.get(OwnedCopy, copy_id)

    if existing_copy is None:
        raise HTTPException(status_code=404, detail="Copy not found.")

    update_data = copy_data.model_dump()

    for key, value in update_data.items():
        setattr(existing_copy, key, value)

    session.add(existing_copy)
    session.commit()
    session.refresh(existing_copy)

    return existing_copy


# Delete a physical copy
@app.delete("/copies/{copy_id}")
def delete_copy(copy_id: int, session: Session = Depends(get_session)):

    existing_copy = session.get(OwnedCopy, copy_id)

    if existing_copy is None:
        raise HTTPException(status_code=404, detail="Copy not found.")

    session.delete(existing_copy)
    session.commit()

    return {"message": "Copy successfully deleted."}


@app.get("/scryfall/search")
async def scryfall_search(q: str = Query(min_length=1, max_length=255)):

    try:
        results = await search_cards(q)

        return results

    except httpx.HTTPStatusError as error:

        if error.response.status_code == 404:
            return {"data": [], "total_cards": 0}

        raise HTTPException(
            status_code=502,
            detail="Scryfall returned an unsuccessful response.",
        )

    except httpx.RequestError:

        raise HTTPException(
            status_code=502, detail="Could not connect to Scryfall."
        )


@app.post("/scryfall/import/{scryfall_id}")
async def import_scryfall_printing(
    scryfall_id: str, session: Session = Depends(get_session)
):

    # Step 1: Retrieve the printing from Scryfall
    try:
        scryfall_card = await get_card_by_id(scryfall_id)

    except httpx.HTTPStatusError as error:

        if error.response.status_code == 404:
            raise HTTPException(
                status_code=404, detail="Printing not found on Scryfall."
            )

        raise HTTPException(
            status_code=502,
            detail="Scryfall returned an unsuccessful response.",
        )

    except httpx.RequestError:

        raise HTTPException(
            status_code=502, detail="Could not connect to Scryfall."
        )

    # Step 2: Extract the card identity
    oracle_id = scryfall_card.get("oracle_id")

    if not oracle_id:
        raise HTTPException(
            status_code=422, detail="This Scryfall object has no Oracle ID."
        )

    # Step 3: Find or create the card identity
    card = session.exec(
        select(Card).where(Card.oracle_id == oracle_id)
    ).first()

    if card is None:

        card = Card(
            oracle_id=oracle_id,
            name=scryfall_card["name"],
            mana_cost=scryfall_card.get("mana_cost"),
            type_line=scryfall_card.get("type_line"),
            oracle_text=scryfall_card.get("oracle_text"),
        )

        session.add(card)
        session.commit()
        session.refresh(card)

    # Step 4: Check whether the printing already exists
    printing = session.exec(
        select(Printing).where(Printing.scryfall_id == scryfall_id)
    ).first()

    if printing is not None:
        return {
            "message": "Printing already exists.",
            "card_id": card.id,
            "printing": PrintingRead.model_validate(printing),
        }

    # Step 5: Extract image information
    image_uris = scryfall_card.get("image_uris", {})

    if not image_uris:
        faces = scryfall_card.get("card_faces", [])

        if faces:
            image_uris = faces[0].get("image_uris", {})

    # Step 6: Create the printing
    printing = Printing(
        card_id=card.id,
        scryfall_id=scryfall_id,
        set_code=scryfall_card["set"],
        collector_number=scryfall_card["collector_number"],
        rarity=scryfall_card.get("rarity"),
        image_uri=image_uris.get("normal"),
    )

    session.add(printing)
    session.commit()
    session.refresh(printing)

    return {
        "message": "Printing successfully imported.",
        "card_id": card.id,
        "printing": PrintingRead.model_validate(printing),
    }


@app.get("/collection", response_model=list[CardCollectionRead])
def get_collection(session: Session = Depends(get_session)):

    # Retrieve all database records
    cards = session.exec(select(Card)).all()
    printings = session.exec(select(Printing)).all()
    copies = session.exec(select(OwnedCopy)).all()

    # Group copies by printing ID
    copies_by_printing = {}

    for copy in copies:
        copies_by_printing.setdefault(copy.printing_id, []).append(copy)

    # Group printings by card ID
    printings_by_card = {}

    for printing in printings:

        printing_copies = copies_by_printing.get(printing.id, [])

        # Only include printings that you actually own
        if not printing_copies:
            continue

        printing_data = {
            "id": printing.id,
            "scryfall_id": printing.scryfall_id,
            "set_code": printing.set_code,
            "collector_number": printing.collector_number,
            "rarity": printing.rarity,
            "image_uri": printing.image_uri,
            "copies": printing_copies,
        }

        printings_by_card.setdefault(printing.card_id, []).append(
            printing_data
        )

    # Construct the final collection
    collection = []

    for card in cards:

        card_printings = printings_by_card.get(card.id, [])

        # Only include cards that you actually own
        if not card_printings:
            continue

        collection.append(
            {
                "id": card.id,
                "oracle_id": card.oracle_id,
                "name": card.name,
                "mana_cost": card.mana_cost,
                "type_line": card.type_line,
                "oracle_text": card.oracle_text,
                "printings": card_printings,
            }
        )

    return collection
