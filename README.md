The backend is started by loading `.venv/bin/activate` and then `fastapi run` in the backend folder.
The frontent is started by `npm run dev`

## Local card catalog

The first catalog download is started with the **Download card catalog** button
on a collection page. It downloads Scryfall's Default Cards bulk data
and syncs card identities and printings into the local SQLite database. This
one-time download is about 80 MB and can take a while. Later backend starts
check for updates in the background. Searches and printing selection use the
local database rather than making Scryfall requests while typing. Card-name
searches use a SQLite trigram index for fast substring matches.
The printing chooser can be filtered by set, collector number, release year,
and finish.

ManaBox CSV imports use the `Added` column as the purchase date when a
dedicated purchase-date column is not present. Collection sorting includes the
most recent copy purchase date and the average recorded purchase price per
copy; printings without the corresponding purchase data sort last. Choose a
sort key and direction separately; changing the key selects its conventional
default direction, which can then be changed independently.

Printing EUR prices are synced from Scryfall's nonfoil, foil, and etched price
fields with catalog updates. The collection shows average current value and
average price change per owned copy, based on each copy's finish; proxies and
paper copies are valued at €0. Price changes treat missing purchase prices as
zero, while relative change uses the recorded purchase cost as its baseline.
When no purchase price is entered for a new copy or ManaBox import, the current
finish price is used when available. Purchase prices are treated as EUR;
ManaBox rows with a non-EUR purchase-price currency are rejected during CSV
validation.

## Binders

Each physical copy can be assigned to at most one binder. The dashboard shows
the portfolio chart and binder overview; use the side menu to open All
collection, Unassigned, or an individual binder. Collection pages contain the
card list, ManaBox import, and card-addition features. Copies can be assigned
while adding or editing them, or reassigned in bulk. Deleting a binder
preserves its copies and moves them to Unassigned.
Binders can have a custom color and a cover chosen by searching for a card and
selecting one of its printings; the cover uses the printing's artwork crop.
The dashboard shows total current EUR value, collection change and copy count
in a color-coded donut chart. Binder cards show each binder's copy count,
current value and change; copies without a recorded purchase price are omitted
from the dashboard's change calculation.

## New-copy defaults

Use **Settings** on a collection page to set the default language, condition,
and finish for new copies. These preferences are saved in the current browser.
New copies use the current local date as their purchase-date default.
