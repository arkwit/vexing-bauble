The backend is started by loading `.venv/bin/activate` and then `fastapi run` in the backend folder.
The frontent is started by `npm run dev`

## Local card catalog

The first catalog download is started with the **Download card catalog** button
on the collection home screen. It downloads Scryfall's Default Cards bulk data
and syncs card identities and printings into the local SQLite database. This
one-time download is about 80 MB and can take a while. Later backend starts
check for updates in the background. Searches and printing selection use the
local database rather than making Scryfall requests while typing.
The printing chooser can be filtered by set, collector number, release year,
and finish.

## New-copy defaults

Use **Settings** on the collection home screen to set the default language,
condition, and finish for new copies. These preferences are saved in the current
browser. New copies use the current local date as their purchase-date default.
