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
            "CREATE INDEX IF NOT EXISTS ix_printing_card_released "
            "ON printing (card_id, released_at)"
        )


def get_session():
    with Session(engine) as session:
        yield session
