import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, Depends, HTTPException, Query
from sqlalchemy import text
from sqlmodel import Session, func, select
import httpx

from database import create_db_and_tables, get_session
from models import Binder, Card, Printing, OwnedCopy
from schemas import (
    BinderCreate,
    BinderRead,
    BinderUpdate,
    CardCreate,
    CardRead,
    PrintingCreate,
    PrintingRead,
    OwnedCopyCreate,
    OwnedCopyRead,
    OwnedCopyUpdate,
    BulkCopyDelete,
    BulkCopyUpdate,
    CardCollectionRead,
    ManaBoxImportRequest,
)
from services.scryfall import (
    get_card_by_id,
    get_cards_by_ids,
)
from services.scryfall_catalog import (
    get_catalog_status,
    initialize_catalog_status,
    mark_catalog_sync_starting,
    sync_scryfall_catalog,
)
from services.pricing import current_euro_price, euro_prices_from_scryfall

catalog_sync_task: asyncio.Task[None] | None = None


def start_catalog_sync() -> dict:
    global catalog_sync_task
    if catalog_sync_task is None or catalog_sync_task.done():
        mark_catalog_sync_starting()
        catalog_sync_task = asyncio.create_task(sync_scryfall_catalog())
    return get_catalog_status()


def validate_binder_id(session: Session, binder_id: int | None) -> None:
    if binder_id is not None and session.get(Binder, binder_id) is None:
        raise HTTPException(status_code=404, detail="Binder not found.")


def normalize_binder_name(
    session: Session, name: str, exclude_binder_id: int | None = None
) -> str:
    normalized_name = name.strip()
    if not normalized_name:
        raise HTTPException(status_code=422, detail="Binder name cannot be empty.")

    existing_binder = session.exec(
        select(Binder).where(func.lower(Binder.name) == normalized_name.lower())
    ).first()
    if existing_binder and existing_binder.id != exclude_binder_id:
        raise HTTPException(
            status_code=409, detail="A binder with that name already exists."
        )

    return normalized_name


def get_art_crop_uri(printing: Printing) -> str | None:
    if printing.art_crop_uri:
        return printing.art_crop_uri
    if printing.image_uri and "/normal/" in printing.image_uri:
        return printing.image_uri.replace("/normal/", "/art_crop/", 1)
    return None


def validate_cover_printing_id(
    session: Session, printing_id: int | None
) -> None:
    if printing_id is not None and session.get(Printing, printing_id) is None:
        raise HTTPException(status_code=404, detail="Cover printing not found.")


def serialize_binder(session: Session, binder: Binder) -> BinderRead:
    cover_printing = (
        session.get(Printing, binder.cover_printing_id)
        if binder.cover_printing_id is not None
        else None
    )
    cover_card = (
        session.get(Card, cover_printing.card_id)
        if cover_printing is not None
        else None
    )
    if binder.id is None:
        raise HTTPException(status_code=500, detail="Binder has no database ID.")

    return BinderRead(
        id=binder.id,
        name=binder.name,
        color=binder.color,
        cover_printing_id=binder.cover_printing_id,
        cover_image_uri=get_art_crop_uri(cover_printing)
        if cover_printing is not None
        else None,
        cover_card_name=cover_card.name if cover_card is not None else None,
        cover_set_code=cover_printing.set_code if cover_printing is not None else None,
        cover_collector_number=(
            cover_printing.collector_number if cover_printing is not None else None
        ),
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    create_db_and_tables()
    if initialize_catalog_status():
        start_catalog_sync()

    yield

    if catalog_sync_task and not catalog_sync_task.done():
        catalog_sync_task.cancel()
        try:
            await catalog_sync_task
        except asyncio.CancelledError:
            pass

app = FastAPI(lifespan=lifespan)


# app.get(adress) -> handle GET request to adress
@app.get("/")
def root():
    return {"message": "Hello from my API"}


@app.get("/health")
def health():
    return {"status": "running"}


@app.get("/binders", response_model=list[BinderRead])
def get_binders(session: Session = Depends(get_session)):
    binders = session.exec(select(Binder).order_by(Binder.name)).all()
    return [serialize_binder(session, binder) for binder in binders]


@app.post("/binders", response_model=BinderRead, status_code=201)
def create_binder(
    binder_data: BinderCreate, session: Session = Depends(get_session)
):
    validate_cover_printing_id(session, binder_data.cover_printing_id)
    binder = Binder(
        name=normalize_binder_name(session, binder_data.name),
        color=binder_data.color,
        cover_printing_id=binder_data.cover_printing_id,
    )
    session.add(binder)
    session.commit()
    session.refresh(binder)
    return serialize_binder(session, binder)


@app.put("/binders/{binder_id}", response_model=BinderRead)
def update_binder(
    binder_id: int,
    binder_data: BinderUpdate,
    session: Session = Depends(get_session),
):
    binder = session.get(Binder, binder_id)
    if binder is None:
        raise HTTPException(status_code=404, detail="Binder not found.")

    validate_cover_printing_id(session, binder_data.cover_printing_id)
    binder.name = normalize_binder_name(
        session, binder_data.name, exclude_binder_id=binder_id
    )
    binder.color = binder_data.color
    binder.cover_printing_id = binder_data.cover_printing_id
    session.add(binder)
    session.commit()
    session.refresh(binder)
    return serialize_binder(session, binder)


@app.delete("/binders/{binder_id}")
def delete_binder(binder_id: int, session: Session = Depends(get_session)):
    binder = session.get(Binder, binder_id)
    if binder is None:
        raise HTTPException(status_code=404, detail="Binder not found.")

    copies = session.exec(
        select(OwnedCopy).where(OwnedCopy.binder_id == binder_id)
    ).all()
    for copy in copies:
        copy.binder_id = None
        session.add(copy)

    session.delete(binder)
    session.commit()
    return {"message": "Binder deleted; its copies are now unassigned."}


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


@app.post("/copies/bulk-delete")
def delete_copies(
    request: BulkCopyDelete, session: Session = Depends(get_session)
):
    copy_ids = list(dict.fromkeys(request.copy_ids))
    copies = session.exec(
        select(OwnedCopy).where(OwnedCopy.id.in_(copy_ids))
    ).all()

    if len(copies) != len(copy_ids):
        raise HTTPException(status_code=404, detail="One or more copies were not found.")

    for copy in copies:
        session.delete(copy)

    session.commit()

    return {"deleted": len(copies)}


@app.put("/copies/bulk", response_model=list[OwnedCopyRead])
def update_copies(
    request: BulkCopyUpdate, session: Session = Depends(get_session)
):
    copy_ids = list(dict.fromkeys(request.copy_ids))
    update_data = request.model_dump(
        exclude={"copy_ids"}, exclude_unset=True
    )
    update_data = {
        key: value
        for key, value in update_data.items()
        if value is not None or key == "binder_id"
    }

    if not update_data:
        raise HTTPException(
            status_code=422, detail="Provide at least one field to update."
        )

    if any(isinstance(value, str) and not value.strip() for value in update_data.values()):
        raise HTTPException(
            status_code=422, detail="Updated fields cannot be empty."
        )

    if "binder_id" in update_data:
        validate_binder_id(session, update_data["binder_id"])

    copies = session.exec(
        select(OwnedCopy).where(OwnedCopy.id.in_(copy_ids))
    ).all()

    if len(copies) != len(copy_ids):
        raise HTTPException(status_code=404, detail="One or more copies were not found.")

    for copy in copies:
        for key, value in update_data.items():
            setattr(copy, key, value)
        session.add(copy)

    session.commit()
    for copy in copies:
        session.refresh(copy)

    return copies


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

    validate_binder_id(session, copy_data.binder_id)
    copy_values = copy_data.model_dump()
    if copy_values["purchase_price"] is None:
        copy_values["purchase_price"] = current_euro_price(
            printing, copy_data.finish
        )
    new_copy = OwnedCopy(**copy_values)

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

    update_data = copy_data.model_dump(exclude_unset=True)
    if "binder_id" in update_data:
        validate_binder_id(session, update_data["binder_id"])

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


@app.get("/scryfall/catalog/status")
def scryfall_catalog_status():
    return get_catalog_status()


@app.post("/scryfall/catalog/sync", status_code=202)
def retry_scryfall_catalog_sync():
    return start_catalog_sync()


@app.get("/scryfall/search")
def scryfall_search(
    q: str = Query(min_length=2, max_length=255),
    session: Session = Depends(get_session),
):
    status = get_catalog_status()
    if status["status"] != "ready":
        detail = status.get("error") or status.get("message")
        raise HTTPException(
            status_code=503,
            detail=f"Local card catalog is not ready. {detail}",
        )

    query = q.strip()
    if len(query) < 2:
        raise HTTPException(
            status_code=422,
            detail="Enter at least two characters to search.",
        )

    if len(query) < 3:
        escaped_query = (
            query.replace("\\", "\\\\")
            .replace("%", "\\%")
            .replace("_", "\\_")
        )
        matching_cards = select(Card).where(
            Card.name.collate("NOCASE").like(
                f"{escaped_query}%", escape="\\"
            )
        )
    else:
        escaped_query = query.replace('"', '""')
        match_query = f'"{escaped_query}"'
        matching_card_ids = (
            select(text("rowid"))
            .select_from(text("card_name_search"))
            .where(text("card_name_search MATCH :match_query"))
            .params(match_query=match_query)
        )
        matching_cards = select(Card).where(Card.id.in_(matching_card_ids))

    cards = session.exec(
        matching_cards.order_by(Card.name).limit(24)
    ).all()

    return {
        "data": [
            {
                "id": card.latest_scryfall_id or card.oracle_id,
                "oracle_id": card.oracle_id,
                "name": card.name,
                "set": card.latest_set_code or "",
                "set_name": card.latest_set_name or "",
                "collector_number": card.latest_collector_number or "",
                "rarity": card.latest_rarity or "",
                "released_at": card.latest_released_at,
                "finishes": [
                    finish
                    for finish in (card.latest_finishes or "").split(",")
                    if finish
                ],
            }
            for card in cards
        ]
    }


@app.get("/scryfall/printings/{oracle_id}")
def scryfall_printings(
    oracle_id: str, session: Session = Depends(get_session)
):
    card = session.exec(
        select(Card).where(Card.oracle_id == oracle_id)
    ).first()
    if card is None:
        raise HTTPException(status_code=404, detail="Card not found.")

    printings = session.exec(
        select(Printing)
        .where(Printing.card_id == card.id)
        .order_by(
            Printing.released_at.desc(),
            Printing.set_code,
            Printing.collector_number,
        )
    ).all()

    return {
        "data": [
            {
                "printing_id": printing.id,
                "id": printing.scryfall_id,
                "oracle_id": card.oracle_id,
                "name": card.name,
                "set": printing.set_code,
                "set_name": printing.set_name or printing.set_code.upper(),
                "collector_number": printing.collector_number,
                "rarity": printing.rarity or "",
                "released_at": printing.released_at,
                "finishes": [
                    finish
                    for finish in (printing.finish_options or "").split(",")
                    if finish
                ],
                "image_uris": {
                    size: uri
                    for size, uri in (
                        ("normal", printing.image_uri),
                        ("small", printing.small_image_uri),
                        ("art_crop", get_art_crop_uri(printing)),
                    )
                    if uri
                },
                "prices": {
                    "eur": printing.eur_price,
                    "eur_foil": printing.eur_foil_price,
                    "eur_etched": printing.eur_etched_price,
                },
                "lang": printing.language,
            }
            for printing in printings
        ]
    }


@app.post("/scryfall/import/{scryfall_id}")
async def import_scryfall_printing(
    scryfall_id: str, session: Session = Depends(get_session)
):
    printing = session.exec(
        select(Printing).where(Printing.scryfall_id == scryfall_id)
    ).first()
    if printing is not None:
        card = session.get(Card, printing.card_id)
        if card is None:
            raise HTTPException(
                status_code=500, detail="Printing has no card identity."
            )
        return {
            "message": "Printing already exists.",
            "card_id": card.id,
            "printing": PrintingRead.model_validate(printing),
        }

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

    # Step 4: Extract image information
    image_uris = scryfall_card.get("image_uris", {})

    if not image_uris:
        faces = scryfall_card.get("card_faces", [])

        if faces:
            image_uris = faces[0].get("image_uris", {})

    # Step 5: Create the printing
    printing = Printing(
        card_id=card.id,
        scryfall_id=scryfall_id,
        set_code=scryfall_card["set"],
        collector_number=scryfall_card["collector_number"],
        rarity=scryfall_card.get("rarity"),
        image_uri=image_uris.get("normal"),
        small_image_uri=image_uris.get("small"),
        art_crop_uri=image_uris.get("art_crop"),
        set_name=scryfall_card.get("set_name"),
        released_at=scryfall_card.get("released_at"),
        finish_options=",".join(scryfall_card.get("finishes") or []),
        language=scryfall_card.get("lang"),
        **euro_prices_from_scryfall(scryfall_card),
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
    owned_rows = session.exec(
        select(Card, Printing, OwnedCopy)
        .join(Printing, Printing.card_id == Card.id)
        .join(OwnedCopy, OwnedCopy.printing_id == Printing.id)
        .order_by(
            Card.name,
            Printing.set_code,
            Printing.collector_number,
            OwnedCopy.id,
        )
    ).all()

    collection_by_card: dict[int, dict] = {}
    printings_by_id: dict[int, dict] = {}

    for card, printing, copy in owned_rows:
        if card.id is None or printing.id is None:
            raise HTTPException(
                status_code=500, detail="Collection record has no database ID."
            )

        card_data = collection_by_card.setdefault(
            card.id,
            {
                "id": card.id,
                "oracle_id": card.oracle_id,
                "name": card.name,
                "mana_cost": card.mana_cost,
                "type_line": card.type_line,
                "oracle_text": card.oracle_text,
                "printings": [],
            },
        )
        printing_data = printings_by_id.get(printing.id)
        if printing_data is None:
            printing_data = {
                "id": printing.id,
                "scryfall_id": printing.scryfall_id,
                "set_code": printing.set_code,
                "collector_number": printing.collector_number,
                "rarity": printing.rarity,
                "image_uri": printing.image_uri,
                "eur_price": printing.eur_price,
                "eur_foil_price": printing.eur_foil_price,
                "eur_etched_price": printing.eur_etched_price,
                "copies": [],
            }
            printings_by_id[printing.id] = printing_data
            card_data["printings"].append(printing_data)
        printing_data["copies"].append(copy)

    return list(collection_by_card.values())


@app.post("/collection/import")
async def import_manabox_collection(
    request: ManaBoxImportRequest, session: Session = Depends(get_session)
):
    scryfall_ids = list(
        dict.fromkeys(printing.scryfall_id for printing in request.printings)
    )

    try:
        scryfall_cards, _ = await get_cards_by_ids(scryfall_ids)
    except httpx.HTTPStatusError as error:
        status_code = error.response.status_code
        if status_code == 429:
            detail = "Scryfall rate-limited the bulk lookup. Wait a moment and retry."
        else:
            try:
                response_data = error.response.json()
            except ValueError:
                response_data = {}

            upstream_detail = (
                response_data.get("details", "")
                if isinstance(response_data, dict)
                else ""
            )
            detail = f"Scryfall rejected the bulk lookup (HTTP {status_code})."
            if upstream_detail:
                detail = f"{detail} {upstream_detail}"

        raise HTTPException(
            status_code=502,
            detail=detail,
        )
    except httpx.RequestError:
        raise HTTPException(
            status_code=502,
            detail="Could not connect to Scryfall. Check the backend's internet connection and retry.",
        )

    cards_by_scryfall_id = {
        scryfall_card["id"]: scryfall_card for scryfall_card in scryfall_cards
    }
    missing_ids = [
        scryfall_id
        for scryfall_id in scryfall_ids
        if scryfall_id not in cards_by_scryfall_id
    ]

    if missing_ids:
        raise HTTPException(
            status_code=422,
            detail=f"Scryfall could not find {len(missing_ids)} card IDs in the export. Check the Scryfall ID column and re-export the file.",
        )

    scryfall_by_oracle_id: dict[str, dict] = {}
    for scryfall_card in scryfall_cards:
        oracle_id = scryfall_card.get("oracle_id")
        if not oracle_id:
            raise HTTPException(
                status_code=422,
                detail=f"{scryfall_card['name']} has no Oracle ID and cannot be imported.",
            )
        scryfall_by_oracle_id[oracle_id] = scryfall_card

    oracle_ids = list(scryfall_by_oracle_id)
    cards_by_oracle_id = {
        card.oracle_id: card
        for card in session.exec(
            select(Card).where(Card.oracle_id.in_(oracle_ids))
        ).all()
    }

    for oracle_id, scryfall_card in scryfall_by_oracle_id.items():
        if oracle_id not in cards_by_oracle_id:
            card = Card(
                oracle_id=oracle_id,
                name=scryfall_card["name"],
                mana_cost=scryfall_card.get("mana_cost"),
                type_line=scryfall_card.get("type_line"),
                oracle_text=scryfall_card.get("oracle_text"),
            )
            session.add(card)
            session.flush()
            cards_by_oracle_id[oracle_id] = card

    printings_by_scryfall_id = {
        printing.scryfall_id: printing
        for printing in session.exec(
            select(Printing).where(Printing.scryfall_id.in_(scryfall_ids))
        ).all()
    }
    new_printings = []

    for scryfall_id, scryfall_card in cards_by_scryfall_id.items():
        printing = printings_by_scryfall_id.get(scryfall_id)
        if printing is None:
            oracle_id = scryfall_card["oracle_id"]
            card = cards_by_oracle_id[oracle_id]
            if card.id is None:
                raise HTTPException(
                    status_code=500,
                    detail="Could not create card identity.",
                )

            image_uris = scryfall_card.get("image_uris") or {}
            if not image_uris:
                faces = scryfall_card.get("card_faces", [])
                if faces:
                    image_uris = faces[0].get("image_uris") or {}

            printing = Printing(
                card_id=card.id,
                scryfall_id=scryfall_id,
                set_code=scryfall_card["set"],
                collector_number=scryfall_card["collector_number"],
                rarity=scryfall_card.get("rarity"),
                image_uri=image_uris.get("normal"),
                small_image_uri=image_uris.get("small"),
                art_crop_uri=image_uris.get("art_crop"),
                set_name=scryfall_card.get("set_name"),
                released_at=scryfall_card.get("released_at"),
                finish_options=",".join(scryfall_card.get("finishes") or []),
                language=scryfall_card.get("lang"),
            )
            new_printings.append(printing)

        for field, value in euro_prices_from_scryfall(scryfall_card).items():
            setattr(printing, field, value)
        session.add(printing)

    session.flush()
    for printing in new_printings:
        printings_by_scryfall_id[printing.scryfall_id] = printing

    new_copies = []
    for import_printing in request.printings:
        printing = printings_by_scryfall_id[import_printing.scryfall_id]
        if printing.id is None:
            raise HTTPException(
                status_code=500, detail="Could not create card printing."
            )

        for copy_data in import_printing.copies:
            validate_binder_id(session, copy_data.binder_id)
            copy_values = copy_data.model_dump(exclude={"quantity"})
            if copy_values["purchase_price"] is None:
                copy_values["purchase_price"] = current_euro_price(
                    printing, copy_data.finish
                )
            new_copies.extend(
                OwnedCopy(printing_id=printing.id, **copy_values)
                for _ in range(copy_data.quantity)
            )

    session.add_all(new_copies)
    session.commit()

    return {
        "message": "ManaBox collection imported.",
        "printings": len(scryfall_ids),
        "copies": len(new_copies),
    }
