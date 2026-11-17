"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createOwnedCopy,
  deleteManyOwnedCopies,
  deleteOwnedCopy,
  getCardCatalogStatus,
  getCardPrintings,
  getCollection,
  importManaBoxCollection,
  importScryfallPrinting,
  searchCardCatalog,
  startCardCatalogSync,
  updateManyOwnedCopies,
  updateOwnedCopy,
  type BulkCopyUpdateInput,
  type CardCatalogStatus,
  type OwnedCopyInput,
} from "./actions";
import type { Card, OwnedCopy, Printing } from "@/types/card";
import type { ScryfallCard } from "@/types/scryfall";
import {
  parseManaBoxCsv,
  type ManaBoxParseResult,
} from "./manabox-csv";

type CollectionManagerProps = {
  initialCollection: Card[];
};

type CopyDraft = {
  condition: string;
  finish: string;
  language: string;
  purchase_price: string;
  purchase_date: string;
  notes: string;
};

type CopyDefaults = Pick<CopyDraft, "condition" | "finish" | "language">;

type CollectionEntry = {
  card: Card;
  printing: Printing;
};

const conditions = [
  "Near Mint",
  "Lightly Played",
  "Moderately Played",
  "Heavily Played",
  "Damaged",
];
const finishes = ["Nonfoil", "Foil", "Etched", "Paper/Proxy"];
const copyDefaultsStorageKey = "vexing-bauble:copy-defaults";
const standardCopyDefaults: CopyDefaults = {
  condition: "Near Mint",
  finish: "Nonfoil",
  language: "English",
};
const emptyDraft: CopyDraft = {
  ...standardCopyDefaults,
  purchase_price: "",
  purchase_date: "",
  notes: "",
};

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function getScryfallImage(card: ScryfallCard) {
  return (
    card.image_uris?.normal ??
    card.card_faces?.find((face) => face.image_uris?.normal)?.image_uris
      ?.normal
  );
}

function getScryfallThumbnail(card: ScryfallCard) {
  return (
    card.image_uris?.small ??
    card.card_faces?.find((face) => face.image_uris?.small)?.image_uris
      ?.small ??
    getScryfallImage(card)
  );
}

function getSuggestedFinish(card: ScryfallCard) {
  if (card.finishes?.includes("nonfoil")) {
    return "Nonfoil";
  }
  if (card.finishes?.includes("foil")) {
    return "Foil";
  }
  if (card.finishes?.includes("etched")) {
    return "Etched";
  }
  return "Nonfoil";
}

function getDefaultFinish(card: ScryfallCard, defaultFinish: string) {
  if (defaultFinish === "Paper/Proxy" || !card.finishes?.length) {
    return defaultFinish;
  }

  const scryfallFinish = {
    Nonfoil: "nonfoil",
    Foil: "foil",
    Etched: "etched",
  }[defaultFinish];

  return scryfallFinish && card.finishes.includes(scryfallFinish)
    ? defaultFinish
    : getSuggestedFinish(card);
}

function getTodayLocalDate() {
  const today = new Date();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${today.getFullYear()}-${month}-${day}`;
}

function createCopyDraft(defaults: CopyDefaults, finish = defaults.finish): CopyDraft {
  return {
    ...defaults,
    finish,
    purchase_price: "",
    purchase_date: getTodayLocalDate(),
    notes: "",
  };
}

function isCopyDefaults(value: unknown): value is CopyDefaults {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const defaults = value as Record<string, unknown>;
  return (
    typeof defaults.condition === "string" &&
    conditions.includes(defaults.condition) &&
    typeof defaults.finish === "string" &&
    finishes.includes(defaults.finish) &&
    typeof defaults.language === "string" &&
    defaults.language.trim().length > 0
  );
}

function readCopyDefaults() {
  if (typeof window === "undefined") {
    return { defaults: standardCopyDefaults, error: "" };
  }

  try {
    const savedDefaults = window.localStorage.getItem(copyDefaultsStorageKey);
    if (savedDefaults === null) {
      return { defaults: standardCopyDefaults, error: "" };
    }

    const parsedDefaults: unknown = JSON.parse(savedDefaults);
    if (!isCopyDefaults(parsedDefaults)) {
      throw new Error("Saved copy defaults have an invalid format.");
    }

    return { defaults: parsedDefaults, error: "" };
  } catch (error) {
    return {
      defaults: standardCopyDefaults,
      error: `Could not load saved copy defaults. ${getErrorMessage(error)}`,
    };
  }
}

function toCopyInput(draft: CopyDraft): OwnedCopyInput {
  return {
    condition: draft.condition,
    finish: draft.finish,
    language: draft.language,
    purchase_price: draft.purchase_price.trim() || null,
    purchase_date: draft.purchase_date || null,
    notes: draft.notes.trim() || null,
  };
}

function getCopyDraft(copy: OwnedCopy): CopyDraft {
  return {
    condition: copy.condition,
    finish: copy.finish,
    language: copy.language,
    purchase_price: copy.purchase_price?.toString() ?? "",
    purchase_date: copy.purchase_date ?? "",
    notes: copy.notes ?? "",
  };
}

function formatCurrency(value: string | number | null) {
  if (value === null || value === "") {
    return null;
  }

  const amount = Number(value);
  return Number.isFinite(amount)
    ? new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "USD",
      }).format(amount)
    : null;
}

function getForeignLanguages(copies: OwnedCopy[]) {
  return Array.from(
    new Set(
      copies
        .map((copy) => copy.language.trim())
        .filter(
          (language) =>
            language &&
            !["english", "en"].includes(language.toLowerCase())
        )
    )
  );
}

function getLanguageLabel(language: string) {
  const shortNames: Record<string, string> = {
    Arabic: "AR",
    German: "DE",
    Spanish: "ES",
    French: "FR",
    Italian: "IT",
    Japanese: "JP",
    Korean: "KO",
    Portuguese: "PT",
    Russian: "RU",
    "Simplified Chinese": "ZH",
    "Traditional Chinese": "ZH",
  };
  return shortNames[language] ?? language.slice(0, 2).toUpperCase();
}

function CopyFields({
  draft,
  onChange,
}: {
  draft: CopyDraft;
  onChange: (draft: CopyDraft) => void;
}) {
  function update<K extends keyof CopyDraft>(key: K, value: CopyDraft[K]) {
    onChange({ ...draft, [key]: value });
  }

  return (
    <>
      <div className="form-grid">
        <label className="field">
          <span>Condition</span>
          <select
            value={draft.condition}
            onChange={(event) => update("condition", event.target.value)}
          >
            {conditions.map((condition) => (
              <option key={condition}>{condition}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Finish</span>
          <select
            value={draft.finish}
            onChange={(event) => update("finish", event.target.value)}
          >
            {finishes.map((finish) => (
              <option key={finish}>{finish}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Language</span>
          <input
            type="text"
            value={draft.language}
            placeholder="English"
            onChange={(event) => update("language", event.target.value)}
          />
        </label>
        <label className="field">
          <span>Purchase price</span>
          <div className="input-prefix">
            <span>$</span>
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="0.00"
              value={draft.purchase_price}
              onChange={(event) => update("purchase_price", event.target.value)}
            />
          </div>
        </label>
        <label className="field">
          <span>Purchase date</span>
          <input
            type="date"
            value={draft.purchase_date}
            onChange={(event) => update("purchase_date", event.target.value)}
          />
        </label>
      </div>
      <label className="field">
        <span>Notes</span>
        <textarea
          rows={2}
          placeholder="Anything worth remembering?"
          value={draft.notes}
          onChange={(event) => update("notes", event.target.value)}
        />
      </label>
    </>
  );
}

export default function CollectionManager({
  initialCollection,
}: CollectionManagerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchRequestRef = useRef(0);
  const printingsRequestRef = useRef(0);
  const [collection, setCollection] = useState(initialCollection);
  const [searchFilter, setSearchFilter] = useState("");
  const [selectedSet, setSelectedSet] = useState("all");
  const [sortBy, setSortBy] = useState("name");
  const [selectedPrintingIds, setSelectedPrintingIds] = useState<number[]>([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [savedCopyDefaults, setSavedCopyDefaults] = useState(readCopyDefaults);
  const copyDefaults = savedCopyDefaults.defaults;
  const settingsError = savedCopyDefaults.error;
  const [settingsDraft, setSettingsDraft] = useState(copyDefaults);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [importFileName, setImportFileName] = useState("");
  const [importPreview, setImportPreview] = useState<ManaBoxParseResult | null>(
    null
  );
  const [importError, setImportError] = useState("");
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [bulkCondition, setBulkCondition] = useState("");
  const [bulkFinish, setBulkFinish] = useState("");
  const [bulkLanguage, setBulkLanguage] = useState("");
  const [bulkError, setBulkError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [catalogStatus, setCatalogStatus] =
    useState<CardCatalogStatus | null>(null);
  const [catalogPollVersion, setCatalogPollVersion] = useState(0);
  const [searchResults, setSearchResults] = useState<ScryfallCard[]>([]);
  const [selectedSearchCard, setSelectedSearchCard] =
    useState<ScryfallCard | null>(null);
  const [cardPrintings, setCardPrintings] = useState<ScryfallCard[]>([]);
  const [printingQuery, setPrintingQuery] = useState("");
  const [loadingPrintings, setLoadingPrintings] = useState(false);
  const [selectedCard, setSelectedCard] = useState<ScryfallCard | null>(null);
  const [searchError, setSearchError] = useState("");
  const [searching, setSearching] = useState(false);
  const [addDraft, setAddDraft] = useState<CopyDraft>(emptyDraft);
  const [activeEntry, setActiveEntry] = useState<CollectionEntry | null>(null);
  const [editingCopyId, setEditingCopyId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<CopyDraft>(emptyDraft);
  const [dialogError, setDialogError] = useState("");
  const [pageError, setPageError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    let timeoutId: number | undefined;

    async function checkCatalogStatus() {
      try {
        const status = await getCardCatalogStatus();
        if (!active) {
          return;
        }

        setCatalogStatus(status);
        if (
          ["checking", "downloading", "indexing"].includes(status.status) ||
          status.refreshing
        ) {
          timeoutId = window.setTimeout(
            () => void checkCatalogStatus(),
            1500
          );
        }
      } catch (error) {
        if (active) {
          setCatalogStatus({
            status: "error",
            message: "Could not check the local card catalog.",
            error: getErrorMessage(error),
          });
        }
      }
    }

    void checkCatalogStatus();

    return () => {
      active = false;
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [catalogPollVersion]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (
      !isAddOpen ||
      query.length < 2 ||
      catalogStatus?.status !== "ready"
    ) {
      return;
    }

    const requestId = ++searchRequestRef.current;
    const timeoutId = window.setTimeout(async () => {
      try {
        const results = await searchCardCatalog(query);
        if (requestId === searchRequestRef.current) {
          setSearchResults(results.slice(0, 24));
        }
      } catch (error) {
        if (requestId === searchRequestRef.current) {
          setSearchError(getErrorMessage(error));
        }
      } finally {
        if (requestId === searchRequestRef.current) {
          setSearching(false);
        }
      }
    }, 150);

    return () => {
      window.clearTimeout(timeoutId);
      if (requestId === searchRequestRef.current) {
        searchRequestRef.current += 1;
      }
    };
  }, [isAddOpen, searchQuery, catalogStatus?.status]);

  const totalCopies = collection.reduce(
    (total, card) =>
      total +
      card.printings.reduce(
        (printingTotal, printing) => printingTotal + printing.copies.length,
        0
      ),
    0
  );
  const totalPrintings = collection.reduce(
    (total, card) => total + card.printings.length,
    0
  );
  const visiblePrintings = useMemo(() => {
    const terms = printingQuery
      .trim()
      .toLocaleLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    if (terms.length === 0) {
      return cardPrintings;
    }

    return cardPrintings.filter((printing) => {
      const searchableText = [
        printing.name,
        printing.set_name,
        printing.set,
        printing.collector_number,
        `#${printing.collector_number}`,
        printing.released_at,
        ...(printing.finishes ?? []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase();
      return terms.every((term) => searchableText.includes(term));
    });
  }, [cardPrintings, printingQuery]);
  const sets = useMemo(
    () =>
      Array.from(
        new Set(
          collection.flatMap((card) =>
            card.printings.map((printing) => printing.set_code.toUpperCase())
          )
        )
      ).sort(),
    [collection]
  );
  const entries = useMemo(() => {
    const normalizedFilter = searchFilter.trim().toLowerCase();

    return collection
      .flatMap((card) =>
        card.printings.map((printing) => ({ card, printing }))
      )
      .filter(({ card, printing }) => {
        const matchesText =
          !normalizedFilter ||
          [
            card.name,
            card.type_line ?? "",
            printing.set_code,
            printing.collector_number,
          ]
            .join(" ")
            .toLowerCase()
            .includes(normalizedFilter);
        const matchesSet =
          selectedSet === "all" ||
          printing.set_code.toUpperCase() === selectedSet;

        return matchesText && matchesSet;
      })
      .sort((left, right) => {
        if (sortBy === "quantity") {
          return right.printing.copies.length - left.printing.copies.length;
        }
        if (sortBy === "set") {
          return left.printing.set_code.localeCompare(right.printing.set_code);
        }
        return left.card.name.localeCompare(right.card.name);
      });
  }, [collection, searchFilter, selectedSet, sortBy]);
  const selectedEntries = useMemo(
    () =>
      collection
        .flatMap((card) =>
          card.printings.map((printing) => ({ card, printing }))
        )
        .filter(({ printing }) => selectedPrintingIds.includes(printing.id)),
    [collection, selectedPrintingIds]
  );
  const selectedCopyIds = selectedEntries.flatMap(({ printing }) =>
    printing.copies.map((copy) => copy.id)
  );
  const allVisibleSelected =
    entries.length > 0 &&
    entries.every(({ printing }) => selectedPrintingIds.includes(printing.id));

  async function refreshCollection() {
    const updatedCollection = await getCollection();
    setCollection(updatedCollection);
    const printingIds = new Set(
      updatedCollection.flatMap((card) =>
        card.printings.map((printing) => printing.id)
      )
    );
    setSelectedPrintingIds((current) =>
      current.filter((id) => printingIds.has(id))
    );
    return updatedCollection;
  }

  function syncActiveEntry(updatedCollection: Card[], entry: CollectionEntry) {
    const updatedCard = updatedCollection.find((card) => card.id === entry.card.id);
    const updatedPrinting = updatedCard?.printings.find(
      (printing) => printing.id === entry.printing.id
    );

    setActiveEntry(
      updatedCard && updatedPrinting
        ? { card: updatedCard, printing: updatedPrinting }
        : null
    );
  }

  function handleSearchQueryChange(query: string) {
    searchRequestRef.current += 1;
    printingsRequestRef.current += 1;
    setSearchQuery(query);
    setPrintingQuery("");
    setSearchResults([]);
    setSelectedSearchCard(null);
    setCardPrintings([]);
    setSelectedCard(null);
    setLoadingPrintings(false);
    setSearching(query.trim().length >= 2);
    setSearchError("");
  }

  async function handleSelectSearchCard(card: ScryfallCard) {
    setSelectedSearchCard(card);
    setSelectedCard(null);
    setCardPrintings([]);
    setPrintingQuery("");
    setSearchError("");
    const requestId = ++printingsRequestRef.current;

    if (!card.oracle_id) {
      setCardPrintings([card]);
      return;
    }

    setLoadingPrintings(true);
    try {
      const printings = await getCardPrintings(card.oracle_id);
      if (requestId === printingsRequestRef.current) {
        setCardPrintings(
          [...printings].sort((left, right) =>
            (right.released_at ?? "").localeCompare(left.released_at ?? "")
          )
        );
      }
    } catch (error) {
      if (requestId === printingsRequestRef.current) {
        setSearchError(getErrorMessage(error));
      }
    } finally {
      if (requestId === printingsRequestRef.current) {
        setLoadingPrintings(false);
      }
    }
  }

  async function handleCatalogSync() {
    try {
      setCatalogStatus(await startCardCatalogSync());
      setCatalogPollVersion((version) => version + 1);
    } catch (error) {
      setCatalogStatus({
        status: "error",
        message: "Could not start the card catalog sync.",
        error: getErrorMessage(error),
      });
    }
  }

  function returnToSearchResults() {
    printingsRequestRef.current += 1;
    setSelectedSearchCard(null);
    setCardPrintings([]);
    setPrintingQuery("");
    setSelectedCard(null);
    setLoadingPrintings(false);
    setSearchError("");
  }

  function selectPrinting(printing: ScryfallCard) {
    setSelectedCard(printing);
    setAddDraft({
      ...createCopyDraft(
        copyDefaults,
        getDefaultFinish(printing, copyDefaults.finish)
      ),
    });
  }

  async function handleAddCard(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedCard) {
      return;
    }

    setBusy(true);
    setDialogError("");

    try {
      const { printing } = await importScryfallPrinting(selectedCard.id);
      await createOwnedCopy(printing.id, toCopyInput(addDraft));
      await refreshCollection();
      setIsAddOpen(false);
      setSearchQuery("");
      setPrintingQuery("");
      setSearchResults([]);
      setSelectedSearchCard(null);
      setCardPrintings([]);
      setSelectedCard(null);
      setAddDraft(createCopyDraft(copyDefaults));
      setNotice(`${selectedCard.name} was added to your collection.`);
    } catch (error) {
      setDialogError(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleQuickAdd(entry: CollectionEntry | null = activeEntry) {
    if (!entry) {
      return;
    }

    setBusy(true);
    setDialogError("");
    setPageError("");

    try {
      await createOwnedCopy(
        entry.printing.id,
        toCopyInput(createCopyDraft(copyDefaults))
      );
      const updatedCollection = await refreshCollection();
      if (activeEntry) {
        syncActiveEntry(updatedCollection, entry);
      }
      setNotice(`Another ${entry.card.name} was added.`);
    } catch (error) {
      if (activeEntry) {
        setDialogError(getErrorMessage(error));
      } else {
        setPageError(getErrorMessage(error));
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveCopy(
    event: React.FormEvent<HTMLFormElement>,
    copyId: number
  ) {
    event.preventDefault();
    setBusy(true);
    setDialogError("");

    try {
      await updateOwnedCopy(copyId, toCopyInput(editDraft));
      const updatedCollection = await refreshCollection();
      if (activeEntry) {
        syncActiveEntry(updatedCollection, activeEntry);
      }
      setEditingCopyId(null);
      setNotice("Copy details updated.");
    } catch (error) {
      setDialogError(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteCopy(copy: OwnedCopy) {
    if (
      !activeEntry ||
      !window.confirm(`Remove this ${activeEntry.card.name} copy from your collection?`)
    ) {
      return;
    }

    setBusy(true);
    setDialogError("");

    try {
      await deleteOwnedCopy(copy.id);
      const refreshedCollection = await refreshCollection();
      syncActiveEntry(refreshedCollection, activeEntry);
      setNotice("Copy removed from your collection.");
    } catch (error) {
      setDialogError(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function openAddDialog() {
    setNotice("");
    setDialogError("");
    setPageError("");
    setSearchQuery("");
    setPrintingQuery("");
    setSearchResults([]);
    setSelectedSearchCard(null);
    setCardPrintings([]);
    setSelectedCard(null);
    setSearchError("");
    setSearching(false);
    setAddDraft(createCopyDraft(copyDefaults));
    setIsAddOpen(true);
  }

  function openSettingsDialog() {
    setSettingsDraft(copyDefaults);
    setSettingsOpen(true);
  }

  function handleSaveSettings(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const updatedDefaults = {
      ...settingsDraft,
      language: settingsDraft.language.trim(),
    };

    if (!updatedDefaults.language) {
      setSavedCopyDefaults((current) => ({
        ...current,
        error: "Enter a default language.",
      }));
      return;
    }

    try {
      window.localStorage.setItem(
        copyDefaultsStorageKey,
        JSON.stringify(updatedDefaults)
      );
      setSavedCopyDefaults({ defaults: updatedDefaults, error: "" });
      setSettingsDraft(updatedDefaults);
      setSettingsOpen(false);
      setNotice("Copy defaults saved.");
    } catch (error) {
      setSavedCopyDefaults((current) => ({
        ...current,
        error: `Could not save copy defaults. ${getErrorMessage(error)}`,
      }));
    }
  }

  function resetSettingsDraft() {
    setSettingsDraft(standardCopyDefaults);
  }

  function openManageDialog(entry: CollectionEntry) {
    setNotice("");
    setDialogError("");
    setEditingCopyId(null);
    setActiveEntry(entry);
  }

  function togglePrintingSelection(printingId: number) {
    setSelectedPrintingIds((current) =>
      current.includes(printingId)
        ? current.filter((id) => id !== printingId)
        : [...current, printingId]
    );
  }

  function toggleVisibleSelection() {
    const visibleIds = entries.map(({ printing }) => printing.id);
    setSelectedPrintingIds((current) => {
      if (allVisibleSelected) {
        return current.filter((id) => !visibleIds.includes(id));
      }
      return Array.from(new Set([...current, ...visibleIds]));
    });
  }

  function openImportDialog() {
    setNotice("");
    setImportError("");
    setImportPreview(null);
    setImportFileName("");
    setIsImportOpen(true);
  }

  async function handleManaBoxFile(
    event: React.ChangeEvent<HTMLInputElement>
  ) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }

    setImportFileName(file.name);
    setImportError("");

    try {
      setImportPreview(parseManaBoxCsv(await file.text()));
    } catch (error) {
      setImportPreview(null);
      setImportError(getErrorMessage(error));
    }
  }

  async function handleManaBoxImport() {
    if (!importPreview || importPreview.errors.length > 0) {
      return;
    }

    setBusy(true);
    setImportError("");

    try {
      const result = await importManaBoxCollection(importPreview.printings);
      await refreshCollection();
      setIsImportOpen(false);
      setImportPreview(null);
      setImportFileName("");
      setNotice(
        `Imported ${result.copies.toLocaleString()} copies across ${result.printings.toLocaleString()} printings.`
      );
    } catch (error) {
      setImportError(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleBulkEdit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const updates: BulkCopyUpdateInput = {};
    if (bulkCondition) {
      updates.condition = bulkCondition;
    }
    if (bulkFinish) {
      updates.finish = bulkFinish;
    }
    if (bulkLanguage.trim()) {
      updates.language = bulkLanguage.trim();
    }

    if (Object.keys(updates).length === 0) {
      setBulkError("Choose at least one field to update.");
      return;
    }

    setBusy(true);
    setBulkError("");

    try {
      const updatedCopies = await updateManyOwnedCopies(
        selectedCopyIds,
        updates
      );
      await refreshCollection();
      setSelectedPrintingIds([]);
      setBulkEditOpen(false);
      setNotice(`Updated ${updatedCopies.length.toLocaleString()} copies.`);
      setBulkCondition("");
      setBulkFinish("");
      setBulkLanguage("");
    } catch (error) {
      setBulkError(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleBulkDelete() {
    if (selectedCopyIds.length === 0) {
      return;
    }
    const confirmed = window.confirm(
      `Remove ${selectedCopyIds.length} copies from ${selectedEntries.length} selected printings?`
    );
    if (!confirmed) {
      return;
    }

    setBusy(true);
    setPageError("");

    try {
      const result = await deleteManyOwnedCopies(selectedCopyIds);
      await refreshCollection();
      setSelectedPrintingIds([]);
      setNotice(`Removed ${result.deleted.toLocaleString()} copies.`);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <Link className="brand" href="/" aria-label="Vexing Bauble home">
          <span className="brand-mark" aria-hidden="true">
            V
          </span>
          <span>VEXING BAUBLE</span>
        </Link>
        <div className="topbar-note">
          <span className="status-dot" />
          YOUR PERSONAL CARD ARCHIVE
        </div>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">THE BINDER</p>
          <h1>Your collection,<br />beautifully gathered.</h1>
          <p className="hero-description">
            Every printing, every copy, all in one place.
          </p>
        </div>
        <div className="hero-actions">
          <button
            className="secondary-button settings-button"
            onClick={openSettingsDialog}
            disabled={busy}
          >
            Settings
          </button>
          <button
            className="secondary-button import-mana-button"
            onClick={openImportDialog}
            disabled={busy}
          >
            ↑ Import ManaBox CSV
          </button>
          <button
            className="primary-button add-button"
            onClick={openAddDialog}
            disabled={busy}
          >
            <span aria-hidden="true">+</span>
            Add a card
          </button>
        </div>
      </section>

      {catalogStatus &&
        (catalogStatus.status !== "ready" ||
          catalogStatus.refreshing ||
          catalogStatus.error) && (
          <section
            className="catalog-home-warning"
            role="status"
            aria-label="Local card catalog status"
          >
            <div>
              <p className="eyebrow">LOCAL CARD CATALOG</p>
              <strong>
                {catalogStatus.status === "missing"
                  ? "Card search needs an initial download"
                  : catalogStatus.message}
              </strong>
              {catalogStatus.status === "missing" && (
                <p>
                  This one-time download is about 80 MB and may take a few
                  minutes.
                </p>
              )}
              {catalogStatus.error && (
                <p className="catalog-home-error">{catalogStatus.error}</p>
              )}
            </div>
            {(catalogStatus.status === "missing" ||
              catalogStatus.status === "error" ||
              catalogStatus.error) && (
              <button
                type="button"
                className="secondary-button"
                onClick={() => void handleCatalogSync()}
              >
                {catalogStatus.status === "missing"
                  ? "Download catalog"
                  : "Retry catalog sync"}
              </button>
            )}
          </section>
        )}

      <section className="collection-overview" aria-label="Collection overview">
        <div className="overview-copy">
          <span className="overview-label">IN YOUR COLLECTION</span>
          <span className="overview-total">
            {totalCopies.toLocaleString()}{" "}
            <span>{totalCopies === 1 ? "card" : "cards"}</span>
          </span>
        </div>
        <div className="overview-divider" />
        <div className="overview-stat">
          <strong>{collection.length.toLocaleString()}</strong>
          <span>unique cards</span>
        </div>
        <div className="overview-stat">
          <strong>{totalPrintings.toLocaleString()}</strong>
          <span>printings</span>
        </div>
        <span className="overview-decoration" aria-hidden="true">✳</span>
      </section>

      <section className="collection-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">YOUR INVENTORY</p>
            <h2>Cards on the shelf</h2>
          </div>
          <span className="result-count">
            {entries.length} {entries.length === 1 ? "printing" : "printings"}
          </span>
        </div>

        <div className="toolbar">
          <label className="search-field">
            <span aria-hidden="true" className="search-icon">⌕</span>
            <input
              aria-label="Search your collection"
              placeholder="Search cards, sets, collector numbers..."
              value={searchFilter}
              onChange={(event) => setSearchFilter(event.target.value)}
            />
            {searchFilter && (
              <button
                className="clear-search"
                aria-label="Clear search"
                onClick={() => setSearchFilter("")}
              >
                ×
              </button>
            )}
          </label>
          <label className="toolbar-select">
            <span>SET</span>
            <select
              aria-label="Filter by set"
              value={selectedSet}
              onChange={(event) => setSelectedSet(event.target.value)}
            >
              <option value="all">All sets</option>
              {sets.map((set) => (
                <option key={set}>{set}</option>
              ))}
            </select>
          </label>
          <label className="toolbar-select">
            <span>SORT</span>
            <select
              aria-label="Sort collection"
              value={sortBy}
              onChange={(event) => setSortBy(event.target.value)}
            >
              <option value="name">Name</option>
              <option value="set">Set</option>
              <option value="quantity">Quantity</option>
            </select>
          </label>
        </div>

        <div className="selection-toolbar">
          <div className="selection-tools">
            <button
              className={`selection-mode-button${selectionMode ? " active" : ""}`}
              aria-pressed={selectionMode}
              onClick={() => setSelectionMode((current) => !current)}
            >
              <span className="selection-mode-icon" aria-hidden="true">
                {selectionMode ? "✓" : "○"}
              </span>
              {selectionMode ? "Done selecting" : "Select cards"}
            </button>
            <button
              className="text-button"
              onClick={toggleVisibleSelection}
              disabled={entries.length === 0}
            >
              {allVisibleSelected
                ? "Clear filtered selection"
                : `Select all ${entries.length} filtered`}
            </button>
          </div>
          {selectedEntries.length > 0 && (
            <div className="bulk-actions">
              <span>
                {selectedCopyIds.length} copies · {selectedEntries.length} printings selected
              </span>
              <button
                className="secondary-button bulk-edit-button"
                onClick={() => {
                  setBulkError("");
                  setBulkEditOpen(true);
                }}
                disabled={busy || selectedCopyIds.length === 0}
              >
                Edit copies
              </button>
              <button
                className="bulk-delete-button"
                onClick={handleBulkDelete}
                disabled={busy || selectedCopyIds.length === 0}
              >
                Delete copies
              </button>
              <button
                className="text-button clear-selection"
                onClick={() => setSelectedPrintingIds([])}
                disabled={busy}
              >
                Clear
              </button>
            </div>
          )}
        </div>

        {notice && (
          <div className="notice" role="status">
            <span aria-hidden="true">✓</span>
            {notice}
            <button aria-label="Dismiss message" onClick={() => setNotice("")}>
              ×
            </button>
          </div>
        )}
        {pageError && (
          <div className="inline-error page-error" role="alert">
            {pageError}
            <button
              aria-label="Dismiss error"
              onClick={() => setPageError("")}
            >
              ×
            </button>
          </div>
        )}

        {entries.length > 0 ? (
          <div className={`card-grid${selectionMode ? " selection-mode" : ""}`}>
            {entries.map(({ card, printing }) => {
              const imageUrl = printing.image_uri;
              const quantity = printing.copies.length;
              const foreignLanguages = getForeignLanguages(printing.copies);
              const foil = printing.copies.some((copy) =>
                ["foil", "etched"].includes(copy.finish.toLowerCase())
              );
              const isSelected = selectedPrintingIds.includes(printing.id);

              return (
                <article
                  className={`card-item${isSelected ? " selected" : ""}`}
                  key={printing.id}
                >
                  <button
                    className={`card-art-button${foil ? " foil-card" : ""}`}
                    aria-label={
                      selectionMode
                        ? `${isSelected ? "Deselect" : "Select"} ${card.name}`
                        : `View ${card.name} details`
                    }
                    aria-pressed={selectionMode ? isSelected : undefined}
                    onClick={() =>
                      selectionMode
                        ? togglePrintingSelection(printing.id)
                        : openManageDialog({ card, printing })
                    }
                  >
                    {imageUrl ? (
                      <Image
                        className="card-art"
                        src={imageUrl}
                        alt={card.name}
                        width={488}
                        height={680}
                        unoptimized
                      />
                    ) : (
                      <span className="card-placeholder">
                        <span>{card.name.slice(0, 1)}</span>
                        <small>{card.type_line ?? "MAGIC CARD"}</small>
                      </span>
                    )}
                    {foil && (
                      <span className="foil-sheen" aria-hidden="true" />
                    )}
                    <span className="quantity-badge">{quantity}</span>
                    {foreignLanguages.length > 0 && (
                      <span
                        className="language-badge"
                        title={`Owned in ${foreignLanguages.join(", ")}`}
                      >
                        {foreignLanguages.length === 1
                          ? getLanguageLabel(foreignLanguages[0])
                          : `${getLanguageLabel(foreignLanguages[0])}+${foreignLanguages.length - 1}`}
                      </span>
                    )}
                  </button>
                  {selectionMode && (
                    <span
                      className="card-selection-mark"
                      aria-hidden="true"
                    >
                      {isSelected ? "✓" : ""}
                    </span>
                  )}
                </article>
              );
            })}
          </div>
        ) : (
          <div className="empty-state">
            <span className="empty-mark" aria-hidden="true">✳</span>
            <h3>{collection.length ? "No cards match that search" : "A binder full of possibility"}</h3>
            <p>
              {collection.length
                ? "Try a different name, set, or collector number."
                : "Start your collection by adding your first card."}
            </p>
            {collection.length === 0 && (
              <button className="primary-button" onClick={openAddDialog}>
                <span aria-hidden="true">+</span>
                Add your first card
              </button>
            )}
          </div>
        )}
      </section>

      <footer className="page-footer">
        <span>VEXING BAUBLE</span>
        <span>A LITTLE ORDER FOR YOUR MAGIC</span>
      </footer>

      {isImportOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) {
              setIsImportOpen(false);
            }
          }}
        >
          <section
            className="modal import-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-title"
          >
            <div className="modal-header">
              <div>
                <p className="eyebrow">BRING YOUR BINDER OVER</p>
                <h2 id="import-title">Import from ManaBox</h2>
              </div>
              <button
                className="modal-close"
                aria-label="Close"
                onClick={() => setIsImportOpen(false)}
              >
                ×
              </button>
            </div>
            <p className="import-description">
              Choose a ManaBox collection CSV export. We match each row using
              its Scryfall ID and preserve quantity, finish, condition,
              language, purchase price, date, and notes when present. This
              adds to your current collection, so importing the same export
              again will add those copies again.
            </p>
            <div className="file-picker">
              <div className="file-picker-title">
                <span className="file-picker-icon" aria-hidden="true">↑</span>
                <span>
                  <strong>Choose your ManaBox export</strong>
                  <small>CSV file · must include Scryfall ID and Quantity</small>
                </span>
              </div>
              <div className="file-picker-controls">
                <span className="upload-file-name">
                  {importFileName || "No file selected"}
                </span>
                <button
                  type="button"
                  className="file-browse-button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={busy}
                >
                  Browse files
                </button>
              </div>
              <input
                ref={fileInputRef}
                id="manabox-csv-file"
                className="file-input-hidden"
                type="file"
                accept=".csv,text/csv,application/vnd.ms-excel"
                aria-label="Choose ManaBox CSV file"
                onChange={handleManaBoxFile}
                disabled={busy}
              />
            </div>
            {importPreview && (
              <div className="import-preview">
                <div className="import-summary">
                  <strong>{importPreview.totalCopies.toLocaleString()}</strong>
                  <span>
                    copies across {importPreview.printings.length} printings
                  </span>
                </div>
                {importPreview.previewRows.length > 0 && (
                  <div className="preview-table-wrap">
                    <table className="preview-table">
                      <thead>
                        <tr>
                          <th>Card</th>
                          <th>Set</th>
                          <th>Qty</th>
                          <th>Condition · finish · language</th>
                        </tr>
                      </thead>
                      <tbody>
                        {importPreview.previewRows.slice(0, 6).map((row) => (
                          <tr key={`${row.rowNumber}-${row.name}`}>
                            <td>{row.name}</td>
                            <td>{row.setCode || "—"}</td>
                            <td>{row.quantity}</td>
                            <td>
                              {row.condition} · {row.finish} · {row.language}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {importPreview.previewRows.length > 6 && (
                      <p className="preview-more">
                        And {importPreview.previewRows.length - 6} more rows
                      </p>
                    )}
                  </div>
                )}
                {importPreview.errors.length > 0 && (
                  <div className="import-validation" role="alert">
                    <strong>
                      Fix these CSV issues before importing:
                    </strong>
                    <ul>
                      {importPreview.errors.slice(0, 8).map((error) => (
                        <li key={error}>{error}</li>
                      ))}
                    </ul>
                    {importPreview.errors.length > 8 && (
                      <span>
                        And {importPreview.errors.length - 8} more issues.
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
            {busy && isImportOpen && (
              <div className="import-progress" role="status">
                <span className="progress-spinner" aria-hidden="true" />
                <span>
                  <strong>Import in progress</strong>
                  <small>
                    Resolving {importPreview?.printings.length.toLocaleString()} printings and saving {importPreview?.totalCopies.toLocaleString()} copies. Keep this window open.
                  </small>
                </span>
              </div>
            )}
            {importError && (
              <div className="import-error" role="alert">
                <strong>The import could not be completed</strong>
                <p>{importError}</p>
                <small>
                  Check that the backend is running and that the file’s
                  Scryfall IDs are valid, then try again.
                </small>
              </div>
            )}
            <div className="modal-actions">
              <button
                className="secondary-button"
                onClick={() => setIsImportOpen(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                onClick={handleManaBoxImport}
                disabled={
                  busy ||
                  !importPreview ||
                  importPreview.errors.length > 0 ||
                  importPreview.totalCopies === 0
                }
              >
                {busy ? "Importing..." : "Import copies"}
              </button>
            </div>
          </section>
        </div>
      )}

      {bulkEditOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) {
              setBulkEditOpen(false);
            }
          }}
        >
          <section
            className="modal bulk-edit-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="bulk-edit-title"
          >
            <div className="modal-header">
              <div>
                <p className="eyebrow">UPDATE SELECTED COPIES</p>
                <h2 id="bulk-edit-title">Bulk edit</h2>
              </div>
              <button
                className="modal-close"
                aria-label="Close"
                onClick={() => setBulkEditOpen(false)}
              >
                ×
              </button>
            </div>
            <p className="import-description">
              Changes apply to {selectedCopyIds.length} copies across{" "}
              {selectedEntries.length} selected printings. Leave a field
              unchanged to keep its current value.
            </p>
            <form className="bulk-edit-form" onSubmit={handleBulkEdit}>
              <label className="field">
                <span>Language</span>
                <input
                  type="text"
                  placeholder="Leave unchanged"
                  value={bulkLanguage}
                  onChange={(event) => setBulkLanguage(event.target.value)}
                />
              </label>
              <div className="form-grid">
                <label className="field">
                  <span>Condition</span>
                  <select
                    value={bulkCondition}
                    onChange={(event) => setBulkCondition(event.target.value)}
                  >
                    <option value="">Leave unchanged</option>
                    {conditions.map((condition) => (
                      <option key={condition}>{condition}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Finish</span>
                  <select
                    value={bulkFinish}
                    onChange={(event) => setBulkFinish(event.target.value)}
                  >
                    <option value="">Leave unchanged</option>
                    {finishes.map((finish) => (
                      <option key={finish}>{finish}</option>
                    ))}
                  </select>
                </label>
              </div>
              {bulkError && <p className="inline-error">{bulkError}</p>}
              <div className="modal-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setBulkEditOpen(false)}
                  disabled={busy}
                >
                  Cancel
                </button>
                <button
                  className="primary-button"
                  disabled={busy || selectedCopyIds.length === 0}
                >
                  {busy ? "Saving..." : "Update selected copies"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {isAddOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) {
              setIsAddOpen(false);
            }
          }}
        >
          <section className="modal add-modal" role="dialog" aria-modal="true" aria-labelledby="add-title">
            <div className="modal-header">
              <div>
                <p className="eyebrow">GROW YOUR BINDER</p>
                <h2 id="add-title">Add a card</h2>
              </div>
              <button
                className="modal-close"
                aria-label="Close"
                onClick={() => setIsAddOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="modal-search">
              <label className="search-field">
                <span aria-hidden="true" className="search-icon">⌕</span>
                <input
                  autoFocus
                  placeholder="Search card names in the local catalog..."
                  value={searchQuery}
                  onChange={(event) =>
                    handleSearchQueryChange(event.target.value)
                  }
                />
              </label>
            </div>

            <div className="add-modal-content">
            {catalogStatus &&
              (catalogStatus.status !== "ready" ||
                catalogStatus.refreshing ||
                catalogStatus.error) && (
              <div className="catalog-status" role="status">
                <p>{catalogStatus.message}</p>
                {catalogStatus.error && (
                  <p className="inline-error">{catalogStatus.error}</p>
                )}
                {(catalogStatus.status === "missing" ||
                  catalogStatus.status === "error" ||
                  catalogStatus.error) && (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void handleCatalogSync()}
                  >
                    {catalogStatus.status === "missing"
                      ? "Download catalog"
                      : "Retry catalog sync"}
                  </button>
                )}
              </div>
            )}

            {searchError && <p className="inline-error">{searchError}</p>}

            {searching && catalogStatus?.status === "ready" && (
              <p className="search-status" role="status">
                Searching local catalog...
              </p>
            )}

            {catalogStatus?.status === "ready" &&
              searchQuery.trim().length < 2 &&
              !selectedSearchCard && (
                <p className="search-status">
                  Search across{" "}
                  {catalogStatus.card_count?.toLocaleString() ?? "all"} local
                  card identities.
                </p>
              )}

            {catalogStatus?.status === "ready" &&
              !searching &&
              searchQuery.trim().length >= 2 &&
              searchResults.length === 0 &&
              !selectedSearchCard &&
              !searchError && (
                <p className="search-status">No cards found. Try another name.</p>
              )}

            {searchResults.length > 0 &&
              !selectedSearchCard &&
              !selectedCard && (
              <div className="search-results">
                {searchResults.map((result) => {
                  return (
                    <button
                      type="button"
                      className="search-result"
                      key={result.id}
                      onClick={() => void handleSelectSearchCard(result)}
                    >
                      <span className="search-result-copy">
                        <strong>{result.name}</strong>
                        <small>Latest printing · {result.set_name}</small>
                        <small>
                          {result.set.toUpperCase()} · #
                          {result.collector_number}
                          {result.released_at
                            ? ` · ${result.released_at.slice(0, 4)}`
                            : ""}
                        </small>
                      </span>
                      <span className="result-arrow" aria-hidden="true">
                        Choose printing →
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {selectedSearchCard && !selectedCard && (
              <section className="printing-picker" aria-label="Choose a printing">
                <div className="printing-picker-header">
                  <button
                    type="button"
                    className="text-button"
                    onClick={returnToSearchResults}
                  >
                    ← Back to cards
                  </button>
                  <div>
                    <h3>{selectedSearchCard.name}</h3>
                    <p>
                      {loadingPrintings
                        ? "Loading available printings..."
                        : printingQuery.trim()
                          ? `${visiblePrintings.length} of ${cardPrintings.length} printings · newest first`
                          : `${cardPrintings.length} printings · newest first`}
                    </p>
                  </div>
                </div>

                <label className="search-field printing-search-field">
                  <span aria-hidden="true" className="search-icon">⌕</span>
                  <input
                    type="text"
                    aria-label="Filter available printings"
                    placeholder="Search set, collector number, year, or finish..."
                    value={printingQuery}
                    onChange={(event) => setPrintingQuery(event.target.value)}
                  />
                  {printingQuery && (
                    <button
                      type="button"
                      className="clear-search"
                      aria-label="Clear printing search"
                      onClick={() => setPrintingQuery("")}
                    >
                      ×
                    </button>
                  )}
                </label>

                {loadingPrintings && (
                  <p className="search-status" role="status">
                    Loading printings...
                  </p>
                )}

                {!loadingPrintings && cardPrintings.length === 0 && !searchError && (
                  <p className="search-status">
                    No printings were found for this card.
                  </p>
                )}

                {!loadingPrintings &&
                  cardPrintings.length > 0 &&
                  visiblePrintings.length === 0 && (
                    <p className="search-status">
                      No printings match “{printingQuery.trim()}”.
                    </p>
                  )}

                {!loadingPrintings && cardPrintings.length > 0 && (
                  <div className="search-results printing-results">
                    {visiblePrintings.map((printing) => {
                      const thumbnail = getScryfallThumbnail(printing);
                      return (
                        <button
                          type="button"
                          className="search-result printing-result"
                          key={printing.id}
                          onClick={() => selectPrinting(printing)}
                        >
                          {thumbnail ? (
                            <Image
                              className="printing-thumbnail"
                              src={thumbnail}
                              alt=""
                              width={146}
                              height={204}
                              loading="lazy"
                              style={{ width: "100%", height: "auto" }}
                              unoptimized
                            />
                          ) : (
                            <span className="printing-thumbnail-placeholder">
                              Image unavailable
                            </span>
                          )}
                          <span className="search-result-copy">
                            <strong>{printing.set_name}</strong>
                            <small>
                              {printing.set.toUpperCase()} · #
                              {printing.collector_number}
                              {printing.released_at
                                ? ` · ${printing.released_at.slice(0, 4)}`
                                : ""}
                            </small>
                            <small>
                              {printing.finishes?.join(" · ") ?? "Finish unknown"}
                            </small>
                          </span>
                          {printing.id === cardPrintings[0]?.id && (
                            <span className="latest-printing-tag">LATEST</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>
            )}

            {selectedCard && (
              <form className="selected-card-form" onSubmit={handleAddCard}>
                <div className="selected-card">
                  {getScryfallImage(selectedCard) ? (
                    <Image
                      src={getScryfallImage(selectedCard)!}
                      alt=""
                      width={488}
                      height={680}
                      unoptimized
                    />
                  ) : (
                    <span className="search-result-placeholder">✳</span>
                  )}
                  <div>
                    <span className="eyebrow">SELECTED PRINTING</span>
                    <strong>{selectedCard.name}</strong>
                    <span>{selectedCard.set_name}</span>
                    <span>
                      {selectedCard.set.toUpperCase()} · #{selectedCard.collector_number}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setSelectedCard(null)}
                  >
                    Change printing
                  </button>
                </div>
                <CopyFields draft={addDraft} onChange={setAddDraft} />
                {dialogError && <p className="inline-error">{dialogError}</p>}
                <div className="modal-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setIsAddOpen(false)}
                    disabled={busy}
                  >
                    Cancel
                  </button>
                  <button className="primary-button" disabled={busy}>
                    {busy ? "Adding card..." : "Add to collection"}
                  </button>
                </div>
              </form>
            )}
            </div>
          </section>
        </div>
      )}

      {settingsOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setSettingsOpen(false);
            }
          }}
        >
          <section
            className="modal settings-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
          >
            <div className="modal-header">
              <div>
                <p className="eyebrow">COLLECTION PREFERENCES</p>
                <h2 id="settings-title">Default copy settings</h2>
              </div>
              <button
                className="modal-close"
                aria-label="Close settings"
                onClick={() => setSettingsOpen(false)}
              >
                ×
              </button>
            </div>
            <form className="settings-form" onSubmit={handleSaveSettings}>
              <p className="import-description">
                These defaults apply to new copies. The purchase date is set to
                today automatically.
              </p>
              <label className="field">
                <span>Default language</span>
                <input
                  type="text"
                  value={settingsDraft.language}
                  onChange={(event) =>
                    setSettingsDraft({
                      ...settingsDraft,
                      language: event.target.value,
                    })
                  }
                  required
                />
              </label>
              <div className="form-grid">
                <label className="field">
                  <span>Default condition</span>
                  <select
                    value={settingsDraft.condition}
                    onChange={(event) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        condition: event.target.value,
                      })
                    }
                  >
                    {conditions.map((condition) => (
                      <option key={condition}>{condition}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Default finish</span>
                  <select
                    value={settingsDraft.finish}
                    onChange={(event) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        finish: event.target.value,
                      })
                    }
                  >
                    {finishes.map((finish) => (
                      <option key={finish}>{finish}</option>
                    ))}
                  </select>
                </label>
              </div>
              {settingsError && (
                <p className="inline-error" role="alert">
                  {settingsError}
                </p>
              )}
              <div className="modal-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setSettingsOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={resetSettingsDraft}
                >
                  Use standard defaults
                </button>
                <button className="primary-button">Save defaults</button>
              </div>
            </form>
          </section>
        </div>
      )}

      {activeEntry && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) {
              setActiveEntry(null);
            }
          }}
        >
          <section className="modal manage-modal" role="dialog" aria-modal="true" aria-labelledby="manage-title">
            <div className="modal-header">
              <div>
                <p className="eyebrow">
                  {activeEntry.printing.set_code.toUpperCase()} · #
                  {activeEntry.printing.collector_number}
                </p>
                <h2 id="manage-title">{activeEntry.card.name}</h2>
              </div>
              <button
                className="modal-close"
                aria-label="Close"
                onClick={() => setActiveEntry(null)}
              >
                ×
              </button>
            </div>
            <div className="card-detail-overview">
              <div className="card-detail-art">
                {activeEntry.printing.image_uri ? (
                  <Image
                    src={activeEntry.printing.image_uri}
                    alt={activeEntry.card.name}
                    width={488}
                    height={680}
                    unoptimized
                  />
                ) : (
                  <span>{activeEntry.card.name.slice(0, 1)}</span>
                )}
              </div>
              <div className="card-detail-copy">
                <p className="card-detail-type">
                  {activeEntry.card.type_line ?? "Magic card"}
                </p>
                <p className="card-detail-printing">
                  <strong>{activeEntry.printing.set_code.toUpperCase()}</strong>
                  <span>#{activeEntry.printing.collector_number}</span>
                  {activeEntry.printing.rarity && (
                    <span>{activeEntry.printing.rarity}</span>
                  )}
                  {activeEntry.card.mana_cost && (
                    <span>{activeEntry.card.mana_cost}</span>
                  )}
                </p>
                {activeEntry.card.oracle_text && (
                  <p className="oracle-text">{activeEntry.card.oracle_text}</p>
                )}
                <div className="detail-copy-count">
                  <strong>{activeEntry.printing.copies.length}</strong>
                  <span>
                    owned{" "}
                    {activeEntry.printing.copies.length === 1 ? "copy" : "copies"}
                  </span>
                </div>
              </div>
            </div>
            <div className="copies-heading">
              <span>OWNED COPIES</span>
              <button
                className="text-button"
                onClick={() => handleQuickAdd()}
                disabled={busy}
              >
                + Add another
              </button>
            </div>
            {dialogError && <p className="inline-error">{dialogError}</p>}
            <div className="copy-list">
              {activeEntry.printing.copies.map((copy, index) => (
                <article className="copy-record" key={copy.id}>
                  {editingCopyId === copy.id ? (
                    <form
                      className="copy-edit-form"
                      onSubmit={(event) => handleSaveCopy(event, copy.id)}
                    >
                      <div className="copy-edit-heading">
                        <strong>Copy {index + 1}</strong>
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => setEditingCopyId(null)}
                        >
                          Cancel edit
                        </button>
                      </div>
                      <CopyFields draft={editDraft} onChange={setEditDraft} />
                      <button className="primary-button" disabled={busy}>
                        {busy ? "Saving..." : "Save changes"}
                      </button>
                    </form>
                  ) : (
                    <>
                      <div className="copy-record-top">
                        <span className="copy-index">{String(index + 1).padStart(2, "0")}</span>
                        <div className="copy-tags">
                          <span>{copy.condition}</span>
                          <span>{copy.finish}</span>
                          <span>{copy.language}</span>
                        </div>
                        <div className="copy-controls">
                          <button
                            className="icon-button"
                            aria-label={`Edit copy ${index + 1}`}
                            title="Edit copy"
                            onClick={() => {
                              setEditDraft(getCopyDraft(copy));
                              setEditingCopyId(copy.id);
                            }}
                          >
                            Edit
                          </button>
                          <button
                            className="icon-button delete-button"
                            aria-label={`Remove copy ${index + 1}`}
                            title="Remove copy"
                            onClick={() => handleDeleteCopy(copy)}
                            disabled={busy}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                      {(copy.purchase_price || copy.purchase_date || copy.notes) && (
                        <div className="copy-meta">
                          {formatCurrency(copy.purchase_price) && (
                            <span>{formatCurrency(copy.purchase_price)}</span>
                          )}
                          {copy.purchase_date && <span>{copy.purchase_date}</span>}
                          {copy.notes && <span>{copy.notes}</span>}
                        </div>
                      )}
                    </>
                  )}
                </article>
              ))}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
