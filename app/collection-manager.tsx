"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createBinder,
  createOwnedCopy,
  deleteBinder,
  deleteManyOwnedCopies,
  deleteOwnedCopy,
  getCardCatalogStatus,
  getCardPrintings,
  getCollection,
  importManaBoxCollection,
  importScryfallPrinting,
  searchCardCatalog,
  startCardCatalogSync,
  updateBinder,
  updateManyOwnedCopies,
  updateOwnedCopy,
  type Binder,
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
  initialBinders: Binder[];
  initialBinderView: string;
};

type CopyDraft = {
  binder_id: string;
  condition: string;
  finish: string;
  language: string;
  purchase_price: string;
  purchase_date: string;
  notes: string;
};

type CopyDefaults = Pick<CopyDraft, "condition" | "finish" | "language">;
type SortDirection = "asc" | "desc";
type BinderDraft = {
  name: string;
  color: string;
  cover_printing_id: number | null;
  cover_image_uri: string | null;
  cover_card_name: string | null;
  cover_set_code: string | null;
  cover_collector_number: string | null;
};
type EuroPrices = {
  eur?: number | string | null;
  eur_foil?: number | string | null;
  eur_etched?: number | string | null;
};
type PrintingValuation = {
  currentValue: number | null;
  absoluteChange: number | null;
  relativeChange: number | null;
};

type CollectionEntry = {
  card: Card;
  printing: Printing;
};

type PortfolioSegment = {
  key: string;
  label: string;
  color: string;
  copies: number;
  value: number;
  absoluteChange: number | null;
  relativeChange: number | null;
  unpricedCopies: number;
  percentage: number;
};

type PortfolioTotals = {
  copies: number;
  value: number;
  absoluteChange: number;
  purchaseTotal: number;
  comparableCopies: number;
  unpricedCopies: number;
};

const defaultBinderColor = "#5b9465";
const emptyBinderDraft: BinderDraft = {
  name: "",
  color: defaultBinderColor,
  cover_printing_id: null,
  cover_image_uri: null,
  cover_card_name: null,
  cover_set_code: null,
  cover_collector_number: null,
};

function filterCollectionByBinder(collection: Card[], binderView: string) {
  if (binderView === "all") {
    return collection;
  }

  const binderId =
    binderView === "unassigned"
      ? null
      : Number(binderView.slice("binder:".length));
  if (binderView !== "unassigned" && !Number.isInteger(binderId)) {
    return [];
  }

  return collection.flatMap((card) => {
    const printings = card.printings.flatMap((printing) => {
      const copies = printing.copies.filter(
        (copy) => (copy.binder_id ?? null) === binderId
      );
      return copies.length > 0 ? [{ ...printing, copies }] : [];
    });
    return printings.length > 0 ? [{ ...card, printings }] : [];
  });
}

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
  binder_id: "",
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

function getCurrentEuroPrice(finish: string, prices?: EuroPrices) {
  const normalizedFinish = finish.trim().toLowerCase();
  if (["paper", "proxy", "paper/proxy"].includes(normalizedFinish)) {
    return 0;
  }

  const price =
    normalizedFinish === "foil"
      ? prices?.eur_foil
      : normalizedFinish === "etched"
        ? prices?.eur_etched
        : prices?.eur;
  if (price === null || price === undefined) {
    return null;
  }

  const amount = Number(price);
  return Number.isFinite(amount) ? amount : null;
}

function getScryfallCurrentEuroPrice(card: ScryfallCard, finish: string) {
  return getCurrentEuroPrice(finish, card.prices);
}

function getPrintingValuation(printing: Printing): PrintingValuation {
  const pricedCopies = printing.copies.flatMap((copy) => {
    const currentPrice = getCurrentEuroPrice(copy.finish, {
      eur: printing.eur_price,
      eur_foil: printing.eur_foil_price,
      eur_etched: printing.eur_etched_price,
    });
    if (currentPrice === null) {
      return [];
    }

    const recordedPurchasePrice =
      copy.purchase_price === null ? 0 : Number(copy.purchase_price);
    return [
      {
        currentPrice,
        purchasePrice: Number.isFinite(recordedPurchasePrice)
          ? recordedPurchasePrice
          : 0,
        hasPurchasePrice: copy.purchase_price !== null,
      },
    ];
  });

  if (pricedCopies.length === 0) {
    return {
      currentValue: null,
      absoluteChange: null,
      relativeChange: null,
    };
  }

  const currentTotal = pricedCopies.reduce(
    (total, copy) => total + copy.currentPrice,
    0
  );
  const purchaseTotal = pricedCopies.reduce(
    (total, copy) => total + copy.purchasePrice,
    0
  );
  const recordedPurchaseTotal = pricedCopies.reduce(
    (total, copy) =>
      total + (copy.hasPurchasePrice ? copy.purchasePrice : 0),
    0
  );
  const changeTotal = currentTotal - purchaseTotal;

  return {
    currentValue: currentTotal / pricedCopies.length,
    absoluteChange: changeTotal / pricedCopies.length,
    relativeChange:
      recordedPurchaseTotal > 0
        ? (changeTotal / recordedPurchaseTotal) * 100
        : null,
  };
}

function getPortfolioValue(
  collection: Card[],
  binders: Binder[]
): {
  total: number;
  totalCopies: number;
  absoluteChange: number | null;
  relativeChange: number | null;
  unpricedCopies: number;
  segments: PortfolioSegment[];
} {
  const createTotals = (): PortfolioTotals => ({
    copies: 0,
    value: 0,
    absoluteChange: 0,
    purchaseTotal: 0,
    comparableCopies: 0,
    unpricedCopies: 0,
  });
  const binderTotals = new Map<number, PortfolioTotals>();
  const binderSegments = binders.map((binder) => {
    const totals = createTotals();
    binderTotals.set(binder.id, totals);
    return {
      key: `binder:${binder.id}`,
      label: binder.name,
      color: binder.color,
      totals,
    };
  });
  const unassignedTotals = createTotals();
  let totalCopies = 0;
  let total = 0;
  let unpricedCopies = 0;

  for (const card of collection) {
    for (const printing of card.printings) {
      for (const copy of printing.copies) {
        const segment =
          copy.binder_id === null
            ? unassignedTotals
            : (binderTotals.get(copy.binder_id) ?? unassignedTotals);
        const value = getCurrentEuroPrice(copy.finish, {
          eur: printing.eur_price,
          eur_foil: printing.eur_foil_price,
          eur_etched: printing.eur_etched_price,
        });

        totalCopies += 1;
        segment.copies += 1;
        if (value === null) {
          unpricedCopies += 1;
          segment.unpricedCopies += 1;
          continue;
        }

        total += value;
        segment.value += value;
        if (copy.purchase_price === null) {
          continue;
        }

        const purchasePrice = Number(copy.purchase_price);
        if (!Number.isFinite(purchasePrice)) {
          continue;
        }
        segment.absoluteChange += value - purchasePrice;
        segment.purchaseTotal += purchasePrice;
        segment.comparableCopies += 1;
      }
    }
  }

  const totals = [...binderTotals.values(), unassignedTotals];
  const comparableCopies = totals.reduce(
    (count, segment) => count + segment.comparableCopies,
    0
  );
  const absoluteChange =
    comparableCopies > 0
      ? totals.reduce((change, segment) => change + segment.absoluteChange, 0)
      : null;
  const purchaseTotal = totals.reduce(
    (value, segment) => value + segment.purchaseTotal,
    0
  );
  const segments = [
    ...binderSegments.map(({ key, label, color, totals: segmentTotals }) => ({
      key,
      label,
      color,
      ...segmentTotals,
    })),
    {
      key: "unassigned",
      label: "Unassigned",
      color: "#66736a",
      ...unassignedTotals,
    },
  ].map((segment) => ({
    key: segment.key,
    label: segment.label,
    color: segment.color,
    copies: segment.copies,
    value: segment.value,
    absoluteChange:
      segment.comparableCopies > 0 ? segment.absoluteChange : null,
    relativeChange:
      segment.purchaseTotal > 0
        ? (segment.absoluteChange / segment.purchaseTotal) * 100
        : null,
    unpricedCopies: segment.unpricedCopies,
    percentage: total > 0 ? (segment.value / total) * 100 : 0,
  }));

  return {
    total,
    totalCopies,
    absoluteChange,
    relativeChange:
      purchaseTotal > 0 && absoluteChange !== null
        ? (absoluteChange / purchaseTotal) * 100
        : null,
    unpricedCopies,
    segments,
  };
}

function getTodayLocalDate() {
  const today = new Date();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${today.getFullYear()}-${month}-${day}`;
}

function createCopyDraft(
  defaults: CopyDefaults,
  finish = defaults.finish,
  binderId = ""
): CopyDraft {
  return {
    ...defaults,
    binder_id: binderId,
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
    binder_id: draft.binder_id ? Number(draft.binder_id) : null,
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
    binder_id: copy.binder_id?.toString() ?? "",
    purchase_price: copy.purchase_price?.toString() ?? "",
    purchase_date: copy.purchase_date ?? "",
    notes: copy.notes ?? "",
  };
}

function getLatestPurchaseDate(copies: OwnedCopy[]) {
  return copies.reduce<string | null>(
    (latest, copy) =>
      copy.purchase_date &&
      (!latest || copy.purchase_date > latest)
        ? copy.purchase_date
        : latest,
    null
  );
}

function getAveragePurchasePrice(copies: OwnedCopy[]) {
  const prices = copies
    .map((copy) =>
      copy.purchase_price === null ? null : Number(copy.purchase_price)
    )
    .filter((price): price is number => price !== null && Number.isFinite(price));

  if (prices.length === 0) {
    return null;
  }

  return prices.reduce((total, price) => total + price, 0) / prices.length;
}

function formatCurrency(value: string | number | null) {
  if (value === null || value === "") {
    return null;
  }

  const amount = Number(value);
  return Number.isFinite(amount)
    ? new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "EUR",
      }).format(amount)
    : null;
}

function formatEuroAmount(value: number | null) {
  return value === null
    ? null
    : `${new Intl.NumberFormat(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value)} €`;
}

function formatPortfolioChange(
  absoluteChange: number | null,
  relativeChange: number | null
) {
  if (absoluteChange === null) {
    return "Purchase value not recorded";
  }

  const amount = formatEuroAmount(Math.abs(absoluteChange)) ?? "0.00 €";
  const sign = absoluteChange > 0 ? "+" : absoluteChange < 0 ? "-" : "";
  const percentage =
    relativeChange === null
      ? " (n/a)"
      : ` (${relativeChange > 0 ? "+" : ""}${relativeChange.toFixed(1)}%)`;

  return `${sign}${amount}${percentage}`;
}

function getPortfolioChangeClass(absoluteChange: number | null) {
  if (absoluteChange === null || absoluteChange === 0) {
    return "is-neutral";
  }
  return absoluteChange > 0 ? "is-positive" : "is-negative";
}

function formatPriceChange(value: number | null) {
  if (value === null) {
    return null;
  }
  const formatted = formatEuroAmount(Math.abs(value));
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return formatted ? `${sign}${formatted}` : null;
}

function formatPercentChange(value: number | null) {
  if (value === null) {
    return null;
  }
  const formatted = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
  }).format(value);
  return `${value > 0 ? "+" : ""}${formatted}%`;
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
  binders,
}: {
  draft: CopyDraft;
  onChange: (draft: CopyDraft) => void;
  binders: Binder[];
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
          <span>Binder</span>
          <select
            value={draft.binder_id}
            onChange={(event) => update("binder_id", event.target.value)}
          >
            <option value="">Unassigned</option>
            {binders.map((binder) => (
              <option key={binder.id} value={binder.id}>
                {binder.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Purchase price (EUR)</span>
          <div className="input-prefix">
            <span>€</span>
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

function BinderCoverPreview({ binder }: { binder: BinderDraft }) {
  const printingLabel = [
    binder.cover_set_code?.toUpperCase(),
    binder.cover_collector_number
      ? `#${binder.cover_collector_number}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      className="binder-cover-preview"
      style={{ borderColor: binder.color }}
    >
      <div
        className="binder-cover-art"
        style={{ backgroundColor: `${binder.color}30` }}
      >
        {binder.cover_image_uri ? (
          <Image
            src={binder.cover_image_uri}
            alt=""
            width={600}
            height={220}
            unoptimized
          />
        ) : (
          <span>No cover artwork selected</span>
        )}
      </div>
      <div className="binder-cover-caption">
        <strong>{binder.cover_card_name ?? "Binder cover"}</strong>
        <span>{printingLabel || "Choose a printing to set the cover"}</span>
      </div>
    </div>
  );
}

export default function CollectionManager({
  initialCollection,
  initialBinders,
  initialBinderView,
}: CollectionManagerProps) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchRequestRef = useRef(0);
  const printingsRequestRef = useRef(0);
  const binderImageRequestRef = useRef(0);
  const catalogRefreshStartedRef = useRef(false);
  const [collection, setCollection] = useState(initialCollection);
  const [binders, setBinders] = useState(initialBinders);
  const selectedBinderView = initialBinderView;
  const [binderDashboardQuery, setBinderDashboardQuery] = useState("");
  const [searchFilter, setSearchFilter] = useState("");
  const [selectedSet, setSelectedSet] = useState("all");
  const [sortBy, setSortBy] = useState("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
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
  const [bulkBinder, setBulkBinder] = useState("unchanged");
  const [bulkError, setBulkError] = useState("");
  const [binderManagerOpen, setBinderManagerOpen] = useState(false);
  const [newBinderDraft, setNewBinderDraft] =
    useState<BinderDraft>(emptyBinderDraft);
  const [editingBinderId, setEditingBinderId] = useState<number | null>(null);
  const [editingBinderDraft, setEditingBinderDraft] =
    useState<BinderDraft>(emptyBinderDraft);
  const [binderError, setBinderError] = useState("");
  const [binderBusy, setBinderBusy] = useState(false);
  const [binderCoverPickerOpen, setBinderCoverPickerOpen] = useState(false);
  const [binderCoverTarget, setBinderCoverTarget] = useState<
    "new" | number | null
  >(null);
  const [binderImageQuery, setBinderImageQuery] = useState("");
  const [binderImageResults, setBinderImageResults] = useState<ScryfallCard[]>(
    []
  );
  const [binderImageCard, setBinderImageCard] =
    useState<ScryfallCard | null>(null);
  const [binderImagePrintings, setBinderImagePrintings] = useState<
    ScryfallCard[]
  >([]);
  const [binderImageLoading, setBinderImageLoading] = useState(false);
  const [binderImageError, setBinderImageError] = useState("");
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
  const [autoPurchasePrice, setAutoPurchasePrice] = useState(false);
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
        if (status.refreshing) {
          catalogRefreshStartedRef.current = true;
        } else if (
          catalogRefreshStartedRef.current &&
          status.status === "ready"
        ) {
          catalogRefreshStartedRef.current = false;
          try {
            const refreshedCollection = await getCollection();
            if (active) {
              setCollection(refreshedCollection);
            }
          } catch (error) {
            if (active) {
              setPageError(getErrorMessage(error));
            }
          }
        }
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

  const portfolio = useMemo(
    () => getPortfolioValue(collection, binders),
    [collection, binders]
  );
  const portfolioSegmentsByKey = useMemo(
    () => new Map(portfolio.segments.map((segment) => [segment.key, segment])),
    [portfolio.segments]
  );
  const portfolioGradient = useMemo(() => {
    let start = 0;
    const stops = portfolio.segments.flatMap((segment) => {
      if (segment.value <= 0) {
        return [];
      }
      const end = start + segment.percentage;
      const stop = `${segment.color} ${start}% ${end}%`;
      start = end;
      return [stop];
    });

    return stops.length > 0
      ? `conic-gradient(${stops.join(", ")})`
      : "conic-gradient(#2d3b32 0% 100%)";
  }, [portfolio.segments]);
  const visibleCollection = useMemo(
    () => filterCollectionByBinder(collection, selectedBinderView),
    [collection, selectedBinderView]
  );
  const visibleBinders = useMemo(() => {
    const query = binderDashboardQuery.trim().toLocaleLowerCase();
    return query
      ? binders.filter((binder) =>
          binder.name.toLocaleLowerCase().includes(query)
        )
      : binders;
  }, [binders, binderDashboardQuery]);
  const activeBinderDraftValue = selectedBinderView.startsWith("binder:")
    ? selectedBinderView.slice("binder:".length)
    : "";
  const activeBinder =
    binders.find(
      (binder) => selectedBinderView === `binder:${binder.id}`
    ) ?? null;
  const editingBinder =
    binders.find((binder) => binder.id === editingBinderId) ?? null;
  const activeBinderName =
    selectedBinderView === "unassigned"
      ? "Unassigned copies"
      : activeBinder?.name ?? "Cards on the shelf";
  const isDashboard = selectedBinderView === "dashboard";
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
          visibleCollection.flatMap((card) =>
            card.printings.map((printing) => printing.set_code.toUpperCase())
          )
        )
      ).sort(),
    [visibleCollection]
  );
  const entries = useMemo(() => {
    const normalizedFilter = searchFilter.trim().toLowerCase();

    return visibleCollection
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
        const direction = sortDirection === "asc" ? 1 : -1;
        const compareNames = () => left.card.name.localeCompare(right.card.name);

        if (sortBy === "quantity") {
          return (
            (left.printing.copies.length - right.printing.copies.length) *
              direction ||
            compareNames() * direction
          );
        }
        if (sortBy === "set") {
          return (
            left.printing.set_code.localeCompare(right.printing.set_code) *
              direction ||
            compareNames() * direction
          );
        }
        if (sortBy === "purchase-date") {
          const leftDate = getLatestPurchaseDate(left.printing.copies);
          const rightDate = getLatestPurchaseDate(right.printing.copies);
          if (leftDate === null || rightDate === null) {
            if (leftDate === rightDate) {
              return compareNames() * direction;
            }
            return leftDate === null ? 1 : -1;
          }
          return (
            leftDate.localeCompare(rightDate) * direction ||
            compareNames() * direction
          );
        }
        if (sortBy === "purchase-value") {
          const leftPrice = getAveragePurchasePrice(left.printing.copies);
          const rightPrice = getAveragePurchasePrice(right.printing.copies);
          if (leftPrice === null || rightPrice === null) {
            if (leftPrice === rightPrice) {
              return compareNames() * direction;
            }
            return leftPrice === null ? 1 : -1;
          }
          return (
            (leftPrice - rightPrice) * direction ||
            compareNames() * direction
          );
        }
        if (
          sortBy === "current-value" ||
          sortBy === "absolute-change" ||
          sortBy === "relative-change"
        ) {
          const metric =
            sortBy === "current-value"
              ? "currentValue"
              : sortBy === "absolute-change"
                ? "absoluteChange"
                : "relativeChange";
          const leftValue = getPrintingValuation(left.printing)[metric];
          const rightValue = getPrintingValuation(right.printing)[metric];
          if (leftValue === null || rightValue === null) {
            if (leftValue === rightValue) {
              return compareNames() * direction;
            }
            return leftValue === null ? 1 : -1;
          }
          return (
            (leftValue - rightValue) * direction ||
            compareNames() * direction
          );
        }
        return compareNames() * direction;
      });
  }, [visibleCollection, searchFilter, selectedSet, sortBy, sortDirection]);
  const selectedEntries = useMemo(
    () =>
      visibleCollection
        .flatMap((card) =>
          card.printings.map((printing) => ({ card, printing }))
        )
        .filter(({ printing }) => selectedPrintingIds.includes(printing.id)),
    [visibleCollection, selectedPrintingIds]
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
    const activeCollection = filterCollectionByBinder(
      updatedCollection,
      selectedBinderView
    );
    const updatedCard = activeCollection.find(
      (card) => card.id === entry.card.id
    );
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
    const finish = getDefaultFinish(printing, copyDefaults.finish);
    const purchasePrice = getScryfallCurrentEuroPrice(printing, finish);
    setAutoPurchasePrice(true);
    setAddDraft({
      ...createCopyDraft(copyDefaults, finish, activeBinderDraftValue),
      purchase_price: purchasePrice === null ? "" : String(purchasePrice),
    });
  }

  function handleAddDraftChange(draft: CopyDraft) {
    const finishChanged = draft.finish !== addDraft.finish;
    const purchasePriceChanged =
      draft.purchase_price !== addDraft.purchase_price;

    if (purchasePriceChanged) {
      setAutoPurchasePrice(false);
    } else if (finishChanged && autoPurchasePrice && selectedCard) {
      const purchasePrice = getScryfallCurrentEuroPrice(
        selectedCard,
        draft.finish
      );
      draft = {
        ...draft,
        purchase_price: purchasePrice === null ? "" : String(purchasePrice),
      };
    }

    setAddDraft(draft);
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
      setAddDraft(
        createCopyDraft(copyDefaults, copyDefaults.finish, activeBinderDraftValue)
      );
      setAutoPurchasePrice(false);
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
        toCopyInput(
          createCopyDraft(
            copyDefaults,
            copyDefaults.finish,
            activeBinderDraftValue
          )
        )
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
    setAddDraft(
      createCopyDraft(copyDefaults, copyDefaults.finish, activeBinderDraftValue)
    );
    setAutoPurchasePrice(false);
    setIsAddOpen(true);
  }

  function handleSortKeyChange(sortKey: string) {
    setSortBy(sortKey);
    setSortDirection(
      sortKey === "name" || sortKey === "set" ? "asc" : "desc"
    );
  }

  function handleSortDirectionChange(direction: string) {
    if (direction === "asc" || direction === "desc") {
      setSortDirection(direction);
    }
  }

  function handleBinderViewChange(binderView: string) {
    if (binderView === "all") {
      router.push("/collection");
    } else if (binderView === "unassigned") {
      router.push("/unassigned");
    } else if (binderView.startsWith("binder:")) {
      router.push(`/binders/${binderView.slice("binder:".length)}`);
    }
  }

  function openBinderCoverPicker(target: "new" | number) {
    binderImageRequestRef.current += 1;
    setBinderCoverTarget(target);
    setBinderImageQuery("");
    setBinderImageResults([]);
    setBinderImageCard(null);
    setBinderImagePrintings([]);
    setBinderImageError("");
    setBinderCoverPickerOpen(true);
  }

  function closeBinderCoverPicker() {
    binderImageRequestRef.current += 1;
    setBinderCoverPickerOpen(false);
    setBinderCoverTarget(null);
    setBinderImageLoading(false);
  }

  async function handleSearchBinderImage(
    event: React.FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();
    const query = binderImageQuery.trim();
    if (query.length < 2) {
      setBinderImageError("Enter at least two characters to search.");
      return;
    }

    const requestId = ++binderImageRequestRef.current;
    setBinderImageLoading(true);
    setBinderImageError("");
    setBinderImageCard(null);
    setBinderImagePrintings([]);
    try {
      const results = await searchCardCatalog(query);
      if (requestId === binderImageRequestRef.current) {
        setBinderImageResults(results.slice(0, 24));
      }
    } catch (error) {
      if (requestId === binderImageRequestRef.current) {
        setBinderImageError(getErrorMessage(error));
      }
    } finally {
      if (requestId === binderImageRequestRef.current) {
        setBinderImageLoading(false);
      }
    }
  }

  async function handleSelectBinderImageCard(card: ScryfallCard) {
    if (!card.oracle_id) {
      setBinderImageError("This card does not have a printable card identity.");
      return;
    }

    const requestId = ++binderImageRequestRef.current;
    setBinderImageCard(card);
    setBinderImagePrintings([]);
    setBinderImageLoading(true);
    setBinderImageError("");
    try {
      const printings = await getCardPrintings(card.oracle_id);
      if (requestId === binderImageRequestRef.current) {
        setBinderImagePrintings(
          [...printings].sort((left, right) =>
            (right.released_at ?? "").localeCompare(left.released_at ?? "")
          )
        );
      }
    } catch (error) {
      if (requestId === binderImageRequestRef.current) {
        setBinderImageError(getErrorMessage(error));
      }
    } finally {
      if (requestId === binderImageRequestRef.current) {
        setBinderImageLoading(false);
      }
    }
  }

  function returnToBinderImageResults() {
    binderImageRequestRef.current += 1;
    setBinderImageCard(null);
    setBinderImagePrintings([]);
    setBinderImageError("");
    setBinderImageLoading(false);
  }

  function handleChooseBinderCover(printing: ScryfallCard) {
    if (binderCoverTarget === null) {
      return;
    }
    if (printing.printing_id === undefined) {
      setBinderImageError("This printing is not available in the local catalog.");
      return;
    }
    if (!printing.image_uris?.art_crop) {
      setBinderImageError("This printing does not have a cropped artwork image.");
      return;
    }

    const cover: Partial<BinderDraft> = {
      cover_printing_id: printing.printing_id,
      cover_image_uri: printing.image_uris.art_crop,
      cover_card_name: printing.name,
      cover_set_code: printing.set,
      cover_collector_number: printing.collector_number,
    };
    if (binderCoverTarget === "new") {
      setNewBinderDraft((current) => ({ ...current, ...cover }));
    } else {
      setEditingBinderDraft((current) => ({ ...current, ...cover }));
    }
    setBinderCoverPickerOpen(false);
    setBinderCoverTarget(null);
  }

  function handleClearBinderCover(target: "new" | number) {
    const cover: Partial<BinderDraft> = {
      cover_printing_id: null,
      cover_image_uri: null,
      cover_card_name: null,
      cover_set_code: null,
      cover_collector_number: null,
    };
    if (target === "new") {
      setNewBinderDraft((current) => ({ ...current, ...cover }));
    } else {
      setEditingBinderDraft((current) => ({ ...current, ...cover }));
    }
  }

  async function handleCreateBinder(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newBinderDraft.name.trim();
    if (!name) {
      setBinderError("Enter a binder name.");
      return;
    }

    setBinderBusy(true);
    setBinderError("");
    try {
      const binder = await createBinder({
        name,
        color: newBinderDraft.color,
        cover_printing_id: newBinderDraft.cover_printing_id,
      });
      setBinders((current) =>
        [...current, binder].sort((left, right) =>
          left.name.localeCompare(right.name)
        )
      );
      setNewBinderDraft(emptyBinderDraft);
      handleBinderViewChange(`binder:${binder.id}`);
      setNotice(`Created ${binder.name}.`);
    } catch (error) {
      setBinderError(getErrorMessage(error));
    } finally {
      setBinderBusy(false);
    }
  }

  async function handleSaveBinder(
    event: React.FormEvent<HTMLFormElement>,
    binderId: number
  ) {
    event.preventDefault();
    const name = editingBinderDraft.name.trim();
    if (!name) {
      setBinderError("Enter a binder name.");
      return;
    }

    setBinderBusy(true);
    setBinderError("");
    try {
      const binder = await updateBinder(binderId, {
        name,
        color: editingBinderDraft.color,
        cover_printing_id: editingBinderDraft.cover_printing_id,
      });
      setBinders((current) =>
        current
          .map((item) => (item.id === binder.id ? binder : item))
          .sort((left, right) => left.name.localeCompare(right.name))
      );
      setEditingBinderId(null);
      setEditingBinderDraft(emptyBinderDraft);
      setNotice(`Updated ${binder.name}.`);
    } catch (error) {
      setBinderError(getErrorMessage(error));
    } finally {
      setBinderBusy(false);
    }
  }

  async function handleDeleteBinder(binder: Binder) {
    const copyCount = collection.reduce(
      (total, card) =>
        total +
        card.printings.reduce(
          (printingTotal, printing) =>
            printingTotal +
            printing.copies.filter((copy) => copy.binder_id === binder.id)
              .length,
          0
        ),
      0
    );
    if (
      !window.confirm(
        `Delete "${binder.name}"? ${copyCount} ${copyCount === 1 ? "copy will" : "copies will"} become unassigned.`
      )
    ) {
      return;
    }

    setBinderBusy(true);
    setBinderError("");
    try {
      await deleteBinder(binder.id);
      setBinders((current) =>
        current.filter((item) => item.id !== binder.id)
      );
      if (selectedBinderView === `binder:${binder.id}`) {
        handleBinderViewChange("all");
      }
      setEditingBinderId(null);
      setEditingBinderDraft(emptyBinderDraft);
      try {
        await refreshCollection();
      } catch (error) {
        setPageError(
          `Binder deleted, but the collection could not be refreshed: ${getErrorMessage(error)}`
        );
      }
      setNotice(`Deleted ${binder.name}; its copies are now unassigned.`);
    } catch (error) {
      setBinderError(getErrorMessage(error));
    } finally {
      setBinderBusy(false);
    }
  }

  function closeBinderManager() {
    if (binderBusy) {
      return;
    }
    setBinderManagerOpen(false);
    setEditingBinderId(null);
    setEditingBinderDraft(emptyBinderDraft);
    setBinderError("");
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
    if (bulkBinder !== "unchanged") {
      updates.binder_id =
        bulkBinder === "unassigned"
          ? null
          : Number(bulkBinder.slice("binder:".length));
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
      setBulkBinder("unchanged");
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
    <main className="app-shell workspace-shell">
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

      <div className="workspace-layout">
        <aside className="side-menu">
          <nav className="side-navigation" aria-label="Collection">
            <p className="side-navigation-label">COLLECTION</p>
            <Link
              className={`side-navigation-link${isDashboard ? " selected" : ""}`}
              href="/"
              aria-current={isDashboard ? "page" : undefined}
            >
              <span aria-hidden="true">◉</span>
              Overview
            </Link>
            <Link
              className={`side-navigation-link${selectedBinderView === "all" ? " selected" : ""}`}
              href="/collection"
              aria-current={selectedBinderView === "all" ? "page" : undefined}
            >
              <span aria-hidden="true">▤</span>
              All collection
            </Link>
            <Link
              className={`side-navigation-link${selectedBinderView === "unassigned" ? " selected" : ""}`}
              href="/unassigned"
              aria-current={
                selectedBinderView === "unassigned" ? "page" : undefined
              }
            >
              <span aria-hidden="true">▤</span>
              Unassigned
            </Link>
            <p className="side-navigation-label side-navigation-binders">
              BINDERS
            </p>
            {binders.map((binder) => {
              const isSelected =
                selectedBinderView === `binder:${binder.id}`;
              return (
                <Link
                  className={`side-navigation-link binder-navigation-link${isSelected ? " selected" : ""}`}
                  href={`/binders/${binder.id}`}
                  key={binder.id}
                  aria-current={isSelected ? "page" : undefined}
                >
                  <span
                    className="side-navigation-color"
                    style={{ backgroundColor: binder.color }}
                    aria-hidden="true"
                  />
                  <span className="side-navigation-name">{binder.name}</span>
                </Link>
              );
            })}
            <button
              type="button"
              className="side-navigation-manage"
              onClick={() => {
                setBinderError("");
                setBinderManagerOpen(true);
              }}
              disabled={binderBusy}
            >
              <span aria-hidden="true">＋</span>
              Manage binders
            </button>
          </nav>
        </aside>

        <div className="workspace-content">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">THE BINDER</p>
          <h1>
            {isDashboard
              ? "Collection overview"
              : activeBinder?.name ?? activeBinderName}
          </h1>
          <p className="hero-description">
            {isDashboard
              ? "Your collection at a glance."
              : "Every printing, every copy, all in one place."}
          </p>
        </div>
        {!isDashboard && <div className="hero-actions">
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
        </div>}
      </section>

      {!isDashboard && catalogStatus &&
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

      {isDashboard && <section className="portfolio-dashboard" aria-labelledby="portfolio-title">
        <div className="portfolio-dashboard-heading">
          <div>
            <p className="eyebrow">YOUR COLLECTION</p>
            <h2 id="portfolio-title">Collection</h2>
          </div>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setBinderError("");
              setBinderManagerOpen(true);
            }}
            disabled={binderBusy}
          >
            Manage binders
          </button>
        </div>
        <div className="portfolio-chart" aria-label="Value share by binder">
          <div
            className="portfolio-donut"
            role="img"
            aria-label={`Collection value ${formatEuroAmount(portfolio.total) ?? "0 euros"} across ${portfolio.totalCopies.toLocaleString()} cards`}
            style={{ background: portfolioGradient }}
          >
            <div className="portfolio-donut-center">
              <span
                className={`portfolio-change ${getPortfolioChangeClass(portfolio.absoluteChange)}`}
              >
                {formatPortfolioChange(
                  portfolio.absoluteChange,
                  portfolio.relativeChange
                )}
              </span>
              <strong>{formatEuroAmount(portfolio.total) ?? "€0.00"}</strong>
              <span className="portfolio-donut-count">
                {portfolio.totalCopies.toLocaleString()}{" "}
                {portfolio.totalCopies === 1 ? "card" : "cards"}
              </span>
            </div>
          </div>
        </div>
        {portfolio.unpricedCopies > 0 && (
          <p className="portfolio-note">
            {portfolio.unpricedCopies.toLocaleString()}{" "}
            {portfolio.unpricedCopies === 1 ? "copy has" : "copies have"} no
            current market price and are excluded from the total.
          </p>
        )}
        <div className="binder-dashboard-heading">
          <div>
            <p className="eyebrow">YOUR BINDERS</p>
            <h3>Binders</h3>
          </div>
          {binders.length > 0 && (
            <label className="binder-dashboard-search">
              <span className="search-icon" aria-hidden="true">
                ⌕
              </span>
              <input
                type="search"
                aria-label="Search binders"
                placeholder="Search binders"
                value={binderDashboardQuery}
                onChange={(event) =>
                  setBinderDashboardQuery(event.target.value)
                }
              />
            </label>
          )}
        </div>
        {binders.length === 0 ? (
          <div className="binder-dashboard-empty">
            <p>Create a binder to group your cards and track its value.</p>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setBinderError("");
                setBinderManagerOpen(true);
              }}
            >
              Create a binder
            </button>
          </div>
        ) : visibleBinders.length === 0 ? (
          <p className="binder-dashboard-empty">
            No binders match &quot;{binderDashboardQuery.trim()}&quot;.
          </p>
        ) : (
          <div className="binder-dashboard-list">
            {visibleBinders.map((binder) => {
              const segment = portfolioSegmentsByKey.get(
                `binder:${binder.id}`
              );
              if (!segment) {
                return null;
              }

              return (
                <Link
                  className={`binder-dashboard-card${selectedBinderView === segment.key ? " selected" : ""}`}
                  key={binder.id}
                  href={`/binders/${binder.id}`}
                  aria-current={selectedBinderView === segment.key ? "page" : undefined}
                >
                  <span className="binder-dashboard-art" aria-hidden="true">
                    {binder.cover_image_uri && (
                      <Image
                        src={binder.cover_image_uri}
                        alt=""
                        width={880}
                        height={180}
                        unoptimized
                      />
                    )}
                  </span>
                  <span
                    className="binder-dashboard-accent"
                    style={{ backgroundColor: binder.color }}
                    aria-hidden="true"
                  />
                  <span className="binder-dashboard-copy">
                    <strong>{binder.name}</strong>
                    <small>
                      {segment.copies.toLocaleString()}{" "}
                      {segment.copies === 1 ? "card" : "cards"}
                    </small>
                  </span>
                  <span className="binder-dashboard-value">
                    <strong>
                      {formatEuroAmount(segment.value) ?? "€0.00"}
                    </strong>
                    <small
                      className={`portfolio-change ${getPortfolioChangeClass(segment.absoluteChange)}`}
                    >
                      {formatPortfolioChange(
                        segment.absoluteChange,
                        segment.relativeChange
                      )}
                    </small>
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </section>}

      {!isDashboard && <section className="collection-section">
        <div className="section-heading">
          <div className="inventory-heading">
            {activeBinder && (
              <div
                className="selected-binder-cover"
                style={{
                  backgroundColor: activeBinder.color,
                  borderColor: activeBinder.color,
                }}
              >
                {activeBinder.cover_image_uri && (
                  <Image
                    src={activeBinder.cover_image_uri}
                    alt={`${activeBinder.name} cover artwork`}
                    width={420}
                    height={170}
                    unoptimized
                  />
                )}
              </div>
            )}
            <div>
              <p className="eyebrow">YOUR INVENTORY</p>
              <h2>
                {selectedBinderView === "all"
                  ? "Cards on the shelf"
                  : selectedBinderView === "unassigned"
                    ? "Unassigned copies"
                    : `Cards in ${activeBinderName}`}
              </h2>
            </div>
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
            <span>SORT BY</span>
            <select
              aria-label="Sort collection by"
              value={sortBy}
              onChange={(event) => handleSortKeyChange(event.target.value)}
            >
              <option value="name">Name</option>
              <option value="set">Set</option>
              <option value="quantity">Quantity</option>
              <option value="purchase-date">Purchase date</option>
              <option value="purchase-value">Purchase value</option>
              <option value="current-value">Current value (€ / copy)</option>
              <option value="absolute-change">Value change (€ / copy)</option>
              <option value="relative-change">Value change (%)</option>
            </select>
          </label>
          <label className="toolbar-select">
            <span>DIRECTION</span>
            <select
              aria-label="Sort direction"
              value={sortDirection}
              onChange={(event) =>
                handleSortDirectionChange(event.target.value)
              }
            >
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
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
                  setBulkCondition("");
                  setBulkFinish("");
                  setBulkLanguage("");
                  setBulkBinder("unchanged");
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
              const valuation = getPrintingValuation(printing);
              const absoluteChange = formatPriceChange(
                valuation.absoluteChange
              );
              const relativeChange = formatPercentChange(
                valuation.relativeChange
              );
              const rarityClass = `rarity-${printing.rarity?.toLowerCase() ?? "common"}`;
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
                    <span
                      className="market-price-badge"
                      title="Current market price per copy"
                    >
                      {formatEuroAmount(valuation.currentValue) ?? "— €"}
                    </span>
                  </button>
                  {selectionMode && (
                    <span
                      className="card-selection-mark"
                      aria-hidden="true"
                    >
                      {isSelected ? "✓" : ""}
                    </span>
                  )}
                  <div
                    className="card-valuation"
                    title="Average market value and price change per owned copy, using Scryfall EUR prices and recorded purchase prices."
                  >
                    <div className="card-printing-meta">
                      <Image
                        className={`set-symbol ${rarityClass}`}
                        src={`https://svgs.scryfall.io/sets/${printing.set_code.toLowerCase()}.svg`}
                        alt=""
                        aria-hidden="true"
                        width={16}
                        height={16}
                        loading="lazy"
                        unoptimized
                        style={{ width: 16, height: 16 }}
                        onError={(event) => {
                          event.currentTarget.style.visibility = "hidden";
                        }}
                      />
                      <strong>{printing.set_code.toUpperCase()}</strong>
                      <span>#{printing.collector_number}</span>
                    </div>
                    <span
                      className={
                        valuation.absoluteChange === null ||
                        valuation.absoluteChange === 0
                          ? "neutral"
                          : valuation.absoluteChange > 0
                            ? "positive"
                            : "negative"
                      }
                    >
                      {absoluteChange ?? "unavailable"} (
                      {relativeChange ?? "—"})
                    </span>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="empty-state">
            <span className="empty-mark" aria-hidden="true">✳</span>
            <h3>
              {collection.length === 0
                ? "A binder full of possibility"
                : searchFilter || selectedSet !== "all"
                  ? "No cards match that search"
                  : selectedBinderView === "unassigned"
                    ? "No unassigned copies"
                    : selectedBinderView === "all"
                      ? "No cards match that search"
                      : `No cards in ${activeBinderName}`}
            </h3>
            <p>
              {collection.length
                ? searchFilter || selectedSet !== "all"
                  ? "Try a different name, set, or collector number."
                  : selectedBinderView === "unassigned"
                    ? "All of your copies are already assigned to a binder."
                    : selectedBinderView === "all"
                      ? "Try a different name, set, or collector number."
                      : "Assign copies to this binder from the collection or bulk-edit tools."
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
      </section>}

      <footer className="page-footer">
        <span>VEXING BAUBLE</span>
        <span>A LITTLE ORDER FOR YOUR MAGIC</span>
      </footer>

      {binderManagerOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeBinderManager();
            }
          }}
        >
          <section
            className="modal binder-manager-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="binder-manager-title"
          >
            <div className="modal-header">
              <div>
                <p className="eyebrow">ORGANIZE YOUR COPIES</p>
                <h2 id="binder-manager-title">
                  {editingBinderId === null ? "Manage binders" : "Edit binder"}
                </h2>
              </div>
              <button
                className="modal-close"
                aria-label="Close"
                onClick={closeBinderManager}
                disabled={binderBusy}
              >
                ×
              </button>
            </div>
            {editingBinderId === null ? (
              <>
                <p className="import-description">
                  Each copy can belong to one binder. Deleting a binder keeps
                  its cards and moves those copies to Unassigned.
                </p>
                <form
                  className="binder-create-form"
                  onSubmit={handleCreateBinder}
                >
                  <div className="binder-draft-controls">
                    <label className="field">
                      <span>New binder name</span>
                      <input
                        type="text"
                        maxLength={80}
                        autoComplete="off"
                        placeholder="e.g. Modern deck"
                        value={newBinderDraft.name}
                        onChange={(event) =>
                          setNewBinderDraft((current) => ({
                            ...current,
                            name: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label className="field binder-color-field">
                      <span>Color</span>
                      <input
                        type="color"
                        aria-label="New binder color"
                        value={newBinderDraft.color}
                        onChange={(event) =>
                          setNewBinderDraft((current) => ({
                            ...current,
                            color: event.target.value,
                          }))
                        }
                      />
                    </label>
                  </div>
                  <div className="binder-cover-controls">
                    <BinderCoverPreview binder={newBinderDraft} />
                    <div>
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => openBinderCoverPicker("new")}
                        disabled={binderBusy}
                      >
                        Choose cover art
                      </button>
                      {newBinderDraft.cover_printing_id !== null && (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => handleClearBinderCover("new")}
                          disabled={binderBusy}
                        >
                          Clear
                        </button>
                      )}
                    </div>
                  </div>
                  <button
                    className="primary-button"
                    disabled={binderBusy || !newBinderDraft.name.trim()}
                  >
                    {binderBusy ? "Saving..." : "Create binder"}
                  </button>
                </form>
                <div className="binder-manager-list">
                  {binders.length === 0 ? (
                    <p className="binder-manager-empty">
                      No binders yet. Create one to start organizing copies.
                    </p>
                  ) : (
                    binders.map((binder) => (
                      <div className="binder-manager-row" key={binder.id}>
                        <div className="binder-row-summary">
                          <span
                            className="binder-row-color"
                            style={{ backgroundColor: binder.color }}
                          />
                          <span
                            className="binder-row-cover"
                            style={{ backgroundColor: `${binder.color}30` }}
                          >
                            {binder.cover_image_uri && (
                              <Image
                                src={binder.cover_image_uri}
                                alt=""
                                width={160}
                                height={72}
                                unoptimized
                              />
                            )}
                          </span>
                          <span className="binder-row-copy">
                            <strong>{binder.name}</strong>
                            <small>
                              {binder.cover_card_name
                                ? `${binder.cover_card_name}${binder.cover_set_code ? ` · ${binder.cover_set_code.toUpperCase()}` : ""}`
                                : "No cover art selected"}
                            </small>
                          </span>
                        </div>
                        <div className="binder-row-actions">
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => {
                              setEditingBinderId(binder.id);
                              setEditingBinderDraft({
                                name: binder.name,
                                color: binder.color,
                                cover_printing_id: binder.cover_printing_id,
                                cover_image_uri: binder.cover_image_uri,
                                cover_card_name: binder.cover_card_name,
                                cover_set_code: binder.cover_set_code,
                                cover_collector_number:
                                  binder.cover_collector_number,
                              });
                              setBinderError("");
                            }}
                            disabled={binderBusy}
                          >
                            Edit binder
                          </button>
                          <button
                            type="button"
                            className="text-button danger-text-button"
                            onClick={() => void handleDeleteBinder(binder)}
                            disabled={binderBusy}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </>
            ) : editingBinder ? (
              <>
                <button
                  type="button"
                  className="secondary-button binder-editor-back"
                  onClick={() => {
                    setEditingBinderId(null);
                    setEditingBinderDraft(emptyBinderDraft);
                    setBinderError("");
                  }}
                  disabled={binderBusy}
                >
                  Back to binders
                </button>
                <form
                  className="binder-edit-form"
                  onSubmit={(event) =>
                    handleSaveBinder(event, editingBinder.id)
                  }
                >
                  <div className="binder-editor-heading">
                    <div>
                      <span className="eyebrow">EDITING BINDER</span>
                      <strong>{editingBinder.name}</strong>
                    </div>
                    <span
                      className="binder-editor-color-chip"
                      style={{
                        backgroundColor: editingBinderDraft.color,
                      }}
                      aria-hidden="true"
                    />
                  </div>
                  <div className="binder-editor-fields">
                    <label className="field">
                      <span>Binder name</span>
                      <input
                        type="text"
                        aria-label={`Rename ${editingBinder.name}`}
                        maxLength={80}
                        value={editingBinderDraft.name}
                        onChange={(event) =>
                          setEditingBinderDraft((current) => ({
                            ...current,
                            name: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label className="field binder-color-field">
                      <span>Binder color</span>
                      <input
                        type="color"
                        aria-label={`${editingBinder.name} color`}
                        value={editingBinderDraft.color}
                        onChange={(event) =>
                          setEditingBinderDraft((current) => ({
                            ...current,
                            color: event.target.value,
                          }))
                        }
                      />
                    </label>
                  </div>
                  <div className="binder-editor-cover">
                    <div className="binder-editor-section-heading">
                      <strong>Cover artwork</strong>
                      <span>
                        Used to identify this binder in your collection.
                      </span>
                    </div>
                    <div className="binder-cover-controls">
                      <BinderCoverPreview binder={editingBinderDraft} />
                      <div>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() =>
                            openBinderCoverPicker(editingBinder.id)
                          }
                          disabled={binderBusy}
                        >
                          Choose artwork
                        </button>
                        {editingBinderDraft.cover_printing_id !== null && (
                          <button
                            type="button"
                            className="text-button"
                            onClick={() =>
                              handleClearBinderCover(editingBinder.id)
                            }
                            disabled={binderBusy}
                          >
                            Remove cover
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="binder-edit-actions">
                    <button
                      className="primary-button"
                      disabled={
                        binderBusy || !editingBinderDraft.name.trim()
                      }
                    >
                      {binderBusy ? "Saving..." : "Save changes"}
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => {
                        setEditingBinderId(null);
                        setEditingBinderDraft(emptyBinderDraft);
                        setBinderError("");
                      }}
                      disabled={binderBusy}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </>
            ) : (
              <p className="inline-error" role="alert">
                This binder is no longer available.
              </p>
            )}
            {binderError && (
              <p className="inline-error" role="alert">
                {binderError}
              </p>
            )}
            {editingBinderId === null && (
              <div className="modal-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={closeBinderManager}
                  disabled={binderBusy}
                >
                  Done
                </button>
              </div>
            )}
          </section>
        </div>
      )}

      {binderCoverPickerOpen && (
        <div
          className="modal-backdrop binder-cover-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !binderImageLoading) {
              closeBinderCoverPicker();
            }
          }}
        >
          <section
            className="modal binder-image-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="binder-cover-title"
          >
            <div className="modal-header">
              <div>
                <p className="eyebrow">SELECT A PRINTING</p>
                <h2 id="binder-cover-title">Choose cover artwork</h2>
              </div>
              <button
                type="button"
                className="modal-close"
                aria-label="Close"
                onClick={closeBinderCoverPicker}
                disabled={binderImageLoading}
              >
                ×
              </button>
            </div>
            <p className="import-description">
              Search for a card, then choose its printing. The binder uses
              Scryfall&apos;s artwork-only crop rather than the full card frame.
            </p>
            {!binderImageCard && (
              <>
                <form
                  className="binder-image-search"
                  onSubmit={handleSearchBinderImage}
                >
                  <label className="search-field">
                    <span aria-hidden="true" className="search-icon">⌕</span>
                    <input
                      autoFocus
                      aria-label="Search cards for binder cover"
                      placeholder="Search card names..."
                      value={binderImageQuery}
                      onChange={(event) =>
                        setBinderImageQuery(event.target.value)
                      }
                    />
                  </label>
                  <button
                    className="primary-button"
                    disabled={binderImageLoading}
                  >
                    {binderImageLoading ? "Searching..." : "Search"}
                  </button>
                </form>
                {binderImageResults.length > 0 && (
                  <div className="binder-image-results">
                    {binderImageResults.map((card) => (
                      <button
                        type="button"
                        className="binder-image-result"
                        key={`${card.oracle_id ?? card.id}-${card.id}`}
                        onClick={() =>
                          void handleSelectBinderImageCard(card)
                        }
                        disabled={binderImageLoading}
                      >
                        <strong>{card.name}</strong>
                        <span>
                          {card.set_name} · {card.set.toUpperCase()}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
            {binderImageCard && (
              <div className="binder-image-printings-view">
                <button
                  type="button"
                  className="text-button"
                  onClick={returnToBinderImageResults}
                  disabled={binderImageLoading}
                >
                  ← Back to search results
                </button>
                <div className="binder-image-printings-heading">
                  <h3>{binderImageCard.name}</h3>
                  <span>
                    {binderImageLoading
                      ? "Loading printings..."
                      : `${binderImagePrintings.length} printings`}
                  </span>
                </div>
                {!binderImageLoading &&
                  binderImagePrintings.length === 0 &&
                  !binderImageError && (
                    <p className="search-status">
                      No printings were found in the local catalog.
                    </p>
                  )}
                <div className="binder-printing-grid">
                  {binderImagePrintings.map((printing) => {
                    const artCrop = printing.image_uris?.art_crop;
                    return (
                      <button
                        type="button"
                        className="binder-printing-choice"
                        key={printing.printing_id ?? printing.id}
                        onClick={() => handleChooseBinderCover(printing)}
                        disabled={
                          binderImageLoading ||
                          printing.printing_id === undefined ||
                          !artCrop
                        }
                      >
                        <span className="binder-printing-art">
                          {artCrop ? (
                            <Image
                              src={artCrop}
                              alt=""
                              width={488}
                              height={220}
                              unoptimized
                            />
                          ) : (
                            <span>No artwork crop</span>
                          )}
                        </span>
                        <span className="binder-printing-meta">
                          <strong>{printing.set_name}</strong>
                          <small>
                            {printing.set.toUpperCase()} · #
                            {printing.collector_number}
                            {printing.released_at
                              ? ` · ${printing.released_at.slice(0, 4)}`
                              : ""}
                          </small>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {binderImageError && (
              <p className="inline-error" role="alert">
                {binderImageError}
              </p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={closeBinderCoverPicker}
                disabled={binderImageLoading}
              >
                Cancel
              </button>
            </div>
          </section>
        </div>
      )}

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
              <label className="field">
                <span>Binder</span>
                <select
                  value={bulkBinder}
                  onChange={(event) => setBulkBinder(event.target.value)}
                >
                  <option value="unchanged">Leave unchanged</option>
                  <option value="unassigned">Unassigned</option>
                  {binders.map((binder) => (
                    <option key={binder.id} value={`binder:${binder.id}`}>
                      {binder.name}
                    </option>
                  ))}
                </select>
              </label>
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
                      const printingPrices = [
                        {
                          finish: "nonfoil",
                          price: getScryfallCurrentEuroPrice(printing, "Nonfoil"),
                        },
                        {
                          finish: "foil",
                          price: getScryfallCurrentEuroPrice(printing, "Foil"),
                        },
                        {
                          finish: "etched",
                          price: getScryfallCurrentEuroPrice(printing, "Etched"),
                        },
                      ].filter(
                        (entry): entry is { finish: string; price: number } =>
                          entry.price !== null
                      );
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
                            {printingPrices.length > 0 && (
                              <small>
                                {printingPrices
                                  .map(
                                    ({ finish, price }) =>
                                      `${formatCurrency(price)} ${finish}`
                                  )
                                  .join(" · ")}
                              </small>
                            )}
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
                <CopyFields
                  draft={addDraft}
                  onChange={handleAddDraftChange}
                  binders={binders}
                />
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
                      <CopyFields
                        draft={editDraft}
                        onChange={setEditDraft}
                        binders={binders}
                      />
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
        </div>
      </div>
    </main>
  );
}
