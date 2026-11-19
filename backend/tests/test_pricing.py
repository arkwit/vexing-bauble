import sqlite3
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from pydantic import ValidationError

import database
from main import (
    create_binder,
    create_copy,
    delete_binder,
    get_art_crop_uri,
    scryfall_search,
    update_binder,
    update_copy,
    update_copies,
)
from models import Binder, Card, Printing
from schemas import (
    BinderCreate,
    BinderUpdate,
    BulkCopyUpdate,
    OwnedCopyCreate,
    OwnedCopyUpdate,
)
from sqlmodel import Session, SQLModel, create_engine
from services.pricing import current_euro_price, euro_prices_from_scryfall


class CopyPriceDefaultTests(unittest.TestCase):
    def test_create_copy_defaults_to_finish_market_price(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            engine = create_engine(
                f"sqlite:///{Path(temporary_directory) / 'collection.db'}"
            )
            try:
                SQLModel.metadata.create_all(engine)
                with Session(engine) as session:
                    card = Card(oracle_id="test-oracle-id", name="Test Card")
                    session.add(card)
                    session.flush()
                    assert card.id is not None
                    printing = Printing(
                        card_id=card.id,
                        scryfall_id="test-scryfall-id",
                        set_code="tst",
                        collector_number="1",
                        eur_price=Decimal("1.25"),
                        eur_foil_price=Decimal("3.40"),
                    )
                    session.add(printing)
                    session.flush()
                    assert printing.id is not None

                    copy = create_copy(
                        printing.id,
                        OwnedCopyCreate(
                            printing_id=printing.id,
                            condition="Near Mint",
                            finish="Foil",
                        ),
                        session,
                    )

                    self.assertEqual(copy.purchase_price, Decimal("3.40"))
            finally:
                engine.dispose()


class BinderTests(unittest.TestCase):
    def test_copy_binder_assignment_and_delete_preserve_copies(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            engine = create_engine(
                f"sqlite:///{Path(temporary_directory) / 'collection.db'}"
            )
            try:
                SQLModel.metadata.create_all(engine)
                with Session(engine) as session:
                    card = Card(oracle_id="test-oracle-id", name="Test Card")
                    session.add(card)
                    session.flush()
                    assert card.id is not None
                    printing = Printing(
                        card_id=card.id,
                        scryfall_id="test-scryfall-id",
                        set_code="tst",
                        collector_number="1",
                        art_crop_uri="https://cards.scryfall.io/art_crop/test.jpg",
                    )
                    self.assertEqual(
                        get_art_crop_uri(
                            Printing(
                                card_id=card.id,
                                scryfall_id="legacy-art",
                                set_code="tst",
                                collector_number="2",
                                image_uri=(
                                    "https://cards.scryfall.io/normal/front/a/b/test.jpg"
                                ),
                            )
                        ),
                        "https://cards.scryfall.io/art_crop/front/a/b/test.jpg",
                    )
                    session.add(printing)
                    session.flush()
                    assert printing.id is not None

                    binder = create_binder(
                        BinderCreate(
                            name=" Trade Binder ",
                            color="#204060",
                            cover_printing_id=printing.id,
                        ),
                        session,
                    )
                    self.assertEqual(binder.name, "Trade Binder")
                    self.assertEqual(binder.color, "#204060")
                    self.assertEqual(
                        binder.cover_image_uri,
                        "https://cards.scryfall.io/art_crop/test.jpg",
                    )
                    with self.assertRaises(HTTPException) as duplicate_error:
                        create_binder(BinderCreate(name="trade binder"), session)
                    self.assertEqual(duplicate_error.exception.status_code, 409)
                    with self.assertRaises(ValidationError):
                        BinderCreate(name="Invalid color", color="#123")

                    with self.assertRaises(HTTPException) as missing_binder_error:
                        create_copy(
                            printing.id,
                            OwnedCopyCreate(
                                printing_id=printing.id,
                                condition="Near Mint",
                                finish="Nonfoil",
                                binder_id=999,
                            ),
                            session,
                        )
                    self.assertEqual(missing_binder_error.exception.status_code, 404)

                    copy = create_copy(
                        printing.id,
                        OwnedCopyCreate(
                            printing_id=printing.id,
                            condition="Near Mint",
                            finish="Nonfoil",
                            binder_id=binder.id,
                        ),
                        session,
                    )
                    self.assertEqual(copy.binder_id, binder.id)

                    binder = update_binder(
                        binder.id,
                        BinderUpdate(
                            name="Collection",
                            color="#406020",
                            cover_printing_id=printing.id,
                        ),
                        session,
                    )
                    self.assertEqual(binder.name, "Collection")
                    self.assertEqual(binder.color, "#406020")
                    self.assertEqual(binder.cover_printing_id, printing.id)

                    update_copies(
                        BulkCopyUpdate(
                            copy_ids=[copy.id],
                            binder_id=None,
                        ),
                        session,
                    )
                    session.refresh(copy)
                    self.assertIsNone(copy.binder_id)

                    update_copy(
                        copy.id,
                        OwnedCopyUpdate(
                            condition="Near Mint",
                            finish="Nonfoil",
                            language="English",
                            binder_id=binder.id,
                        ),
                        session,
                    )
                    delete_binder(binder.id, session)
                    session.refresh(copy)

                    self.assertIsNone(copy.binder_id)
                    self.assertIsNone(session.get(Binder, binder.id))
            finally:
                engine.dispose()


class DatabaseMigrationTests(unittest.TestCase):
    def test_legacy_schema_migrations_are_added_idempotently(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            database_path = Path(temporary_directory) / "legacy.db"
            with sqlite3.connect(database_path) as connection:
                connection.executescript(
                    """
                    CREATE TABLE card (id INTEGER PRIMARY KEY, name TEXT);
                    INSERT INTO card (id, name) VALUES (1, 'Legacy Card');
                    CREATE TABLE printing (
                        id INTEGER PRIMARY KEY,
                        card_id INTEGER,
                        released_at TEXT
                    );
                    CREATE TABLE binder (
                        id INTEGER PRIMARY KEY,
                        name TEXT UNIQUE
                    );
                    INSERT INTO binder (id, name) VALUES (1, 'Legacy binder');
                    CREATE TABLE scryfallcatalogstate (
                        id INTEGER PRIMARY KEY,
                        bulk_updated_at TEXT
                    );
                    CREATE TABLE ownedcopy (
                        id INTEGER PRIMARY KEY,
                        printing_id INTEGER,
                        condition TEXT,
                        finish TEXT,
                        language TEXT,
                        purchase_price NUMERIC,
                        purchase_date TEXT,
                        notes TEXT
                    );
                    INSERT INTO ownedcopy (
                        id, printing_id, condition, finish, language
                    ) VALUES (1, 1, 'Near Mint', 'Nonfoil', 'English');
                    """
                )

            engine = create_engine(f"sqlite:///{database_path}")
            try:
                with patch.object(database, "engine", engine):
                    database.create_db_and_tables()
                    database.create_db_and_tables()

                with engine.connect() as connection:
                    printing_columns = {
                        row[1]
                        for row in connection.exec_driver_sql(
                            "PRAGMA table_info(printing)"
                        )
                    }
                    catalog_state_columns = {
                        row[1]
                        for row in connection.exec_driver_sql(
                            "PRAGMA table_info(scryfallcatalogstate)"
                        )
                    }
                    binder_columns = {
                        row[1]
                        for row in connection.exec_driver_sql(
                            "PRAGMA table_info(binder)"
                        )
                    }
                    ownedcopy_columns = {
                        row[1]
                        for row in connection.exec_driver_sql(
                            "PRAGMA table_info(ownedcopy)"
                        )
                    }
                    binder_foreign_keys = connection.exec_driver_sql(
                        "PRAGMA foreign_key_list(binder)"
                    ).fetchall()
                    ownedcopy_foreign_keys = connection.exec_driver_sql(
                        "PRAGMA foreign_key_list(ownedcopy)"
                    ).fetchall()
                    ownedcopy_indexes = {
                        row[1]
                        for row in connection.exec_driver_sql(
                            "PRAGMA index_list(ownedcopy)"
                        )
                    }
                    migrated_binder_id = connection.exec_driver_sql(
                        "SELECT binder_id FROM ownedcopy WHERE id = 1"
                    ).scalar_one()
                    migrated_binder_color = connection.exec_driver_sql(
                        "SELECT color FROM binder WHERE id = 1"
                    ).scalar_one()
                    migrated_search_rows = connection.exec_driver_sql(
                        "SELECT rowid FROM card_name_search "
                        "WHERE card_name_search MATCH '\"legacy\"'"
                    ).fetchall()
            finally:
                engine.dispose()

        self.assertTrue(
            {
                "eur_price",
                "eur_foil_price",
                "eur_etched_price",
            }.issubset(printing_columns)
        )
        self.assertIn("price_data_version", catalog_state_columns)
        self.assertIn("art_crop_uri", printing_columns)
        self.assertTrue({"color", "cover_printing_id"}.issubset(binder_columns))
        self.assertEqual(migrated_binder_color, "#5b9465")
        self.assertTrue(
            any(
                row[2] == "printing" and row[3] == "cover_printing_id"
                for row in binder_foreign_keys
            )
        )
        self.assertIn("binder_id", ownedcopy_columns)
        self.assertIsNone(migrated_binder_id)
        self.assertEqual([row[0] for row in migrated_search_rows], [1])
        self.assertIn(
            "ix_ownedcopy_binder_id",
            ownedcopy_indexes,
        )
        self.assertTrue(
            any(row[2] == "binder" and row[3] == "binder_id" for row in ownedcopy_foreign_keys)
        )


class CardCatalogSearchTests(unittest.TestCase):
    def test_search_uses_local_index_for_substring_and_short_prefix_queries(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            engine = create_engine(
                f"sqlite:///{Path(temporary_directory) / 'collection.db'}"
            )
            try:
                with patch.object(database, "engine", engine):
                    database.create_db_and_tables()

                with Session(engine) as session:
                    session.add_all(
                        [
                            Card(
                                oracle_id="lightning-bolt",
                                name="Lightning Bolt",
                            ),
                            Card(
                                oracle_id="bolt-bend",
                                name="Bolt Bend",
                            ),
                        ]
                    )
                    session.commit()

                    with patch(
                        "main.get_catalog_status",
                        return_value={"status": "ready"},
                    ):
                        substring_results = scryfall_search("bolt", session)
                        prefix_results = scryfall_search("li", session)

                self.assertEqual(
                    {"Bolt Bend", "Lightning Bolt"},
                    {card["name"] for card in substring_results["data"]},
                )
                self.assertEqual(
                    ["Lightning Bolt"],
                    [card["name"] for card in prefix_results["data"]],
                )

                with engine.connect() as connection:
                    query_plan = connection.exec_driver_sql(
                        "EXPLAIN QUERY PLAN "
                        "SELECT rowid FROM card_name_search "
                        "WHERE card_name_search MATCH '\"bolt\"'"
                    ).fetchall()
                    prefix_query_plan = connection.exec_driver_sql(
                        "EXPLAIN QUERY PLAN "
                        "SELECT id FROM card "
                        "WHERE name COLLATE NOCASE LIKE ? ESCAPE '\\'",
                        ("li%",),
                    ).fetchall()
                self.assertTrue(
                    any("VIRTUAL TABLE INDEX" in row[3] for row in query_plan)
                )
                self.assertTrue(
                    any(
                        "ix_card_name_nocase" in row[3]
                        for row in prefix_query_plan
                    )
                )
            finally:
                engine.dispose()


class PricingTests(unittest.TestCase):
    def test_scryfall_euro_prices_are_parsed_as_decimals(self):
        prices = euro_prices_from_scryfall(
            {
                "prices": {
                    "eur": "1.25",
                    "eur_foil": "3.40",
                    "eur_etched": None,
                }
            }
        )

        self.assertEqual(
            prices,
            {
                "eur_price": Decimal("1.25"),
                "eur_foil_price": Decimal("3.40"),
                "eur_etched_price": None,
            },
        )

    def test_current_price_uses_the_copy_finish(self):
        printing = Printing(
            card_id=1,
            scryfall_id="test-id",
            set_code="tst",
            collector_number="1",
            eur_price=Decimal("1.25"),
            eur_foil_price=Decimal("3.40"),
            eur_etched_price=Decimal("4.50"),
        )

        self.assertEqual(current_euro_price(printing, "Nonfoil"), Decimal("1.25"))
        self.assertEqual(current_euro_price(printing, "Foil"), Decimal("3.40"))
        self.assertEqual(current_euro_price(printing, "Etched"), Decimal("4.50"))

    def test_paper_proxy_is_zero_and_missing_market_price_is_none(self):
        printing = Printing(
            card_id=1,
            scryfall_id="test-id",
            set_code="tst",
            collector_number="1",
        )

        self.assertEqual(current_euro_price(printing, "Paper/Proxy"), Decimal("0"))
        self.assertIsNone(current_euro_price(printing, "Foil"))


if __name__ == "__main__":
    unittest.main()
