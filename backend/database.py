from sqlmodel import SQLModel, create_engine, Session

DATABASE_URL = "sqlite:///./collection.db"

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})


def create_db_and_tables():
    SQLModel.metadata.create_all(engine)

    column_additions = {
        "card": {
            "latest_scryfall_id": "TEXT",
            "latest_set_code": "TEXT",
            "latest_set_name": "TEXT",
            "latest_collector_number": "TEXT",
            "latest_rarity": "TEXT",
            "latest_released_at": "TEXT",
            "latest_finishes": "TEXT",
        },
        "printing": {
            "set_name": "TEXT",
            "released_at": "TEXT",
            "finish_options": "TEXT",
            "language": "TEXT",
            "small_image_uri": "TEXT",
            "art_crop_uri": "TEXT",
            "eur_price": "NUMERIC",
            "eur_foil_price": "NUMERIC",
            "eur_etched_price": "NUMERIC",
        },
        "scryfallcatalogstate": {
            "price_data_version": "INTEGER NOT NULL DEFAULT 0",
        },
        "ownedcopy": {
            "binder_id": "INTEGER REFERENCES binder(id)",
        },
        "binder": {
            "color": "TEXT NOT NULL DEFAULT '#5b9465'",
            "cover_printing_id": "INTEGER REFERENCES printing(id)",
        },
    }

    with engine.begin() as connection:
        for table_name, columns in column_additions.items():
            existing_columns = {
                row[1]
                for row in connection.exec_driver_sql(
                    f"PRAGMA table_info({table_name})"
                )
            }
            for column_name, column_type in columns.items():
                if column_name not in existing_columns:
                    connection.exec_driver_sql(
                        f"ALTER TABLE {table_name} "
                        f"ADD COLUMN {column_name} {column_type}"
                    )

        connection.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_card_name ON card (name)"
        )
        connection.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_card_name_nocase "
            "ON card (name COLLATE NOCASE)"
        )
        connection.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_printing_card_released "
            "ON printing (card_id, released_at)"
        )
        connection.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_ownedcopy_binder_id "
            "ON ownedcopy (binder_id)"
        )

        search_index_exists = connection.exec_driver_sql(
            "SELECT 1 FROM sqlite_master "
            "WHERE type = 'table' AND name = 'card_name_search'"
        ).first() is not None
        connection.exec_driver_sql(
            "CREATE VIRTUAL TABLE IF NOT EXISTS card_name_search USING "
            "fts5(name, content='card', content_rowid='id', tokenize='trigram')"
        )
        if not search_index_exists:
            connection.exec_driver_sql(
                "INSERT INTO card_name_search(card_name_search) VALUES ('rebuild')"
            )
        connection.exec_driver_sql(
            "CREATE TRIGGER IF NOT EXISTS card_name_search_insert "
            "AFTER INSERT ON card BEGIN "
            "INSERT INTO card_name_search(rowid, name) "
            "VALUES (new.id, new.name); END"
        )
        connection.exec_driver_sql(
            "CREATE TRIGGER IF NOT EXISTS card_name_search_delete "
            "AFTER DELETE ON card BEGIN "
            "INSERT INTO card_name_search(card_name_search, rowid, name) "
            "VALUES ('delete', old.id, old.name); END"
        )
        connection.exec_driver_sql(
            "CREATE TRIGGER IF NOT EXISTS card_name_search_update "
            "AFTER UPDATE OF name ON card BEGIN "
            "INSERT INTO card_name_search(card_name_search, rowid, name) "
            "VALUES ('delete', old.id, old.name); "
            "INSERT INTO card_name_search(rowid, name) "
            "VALUES (new.id, new.name); END"
        )


def get_session():
    with Session(engine) as session:
        yield session
