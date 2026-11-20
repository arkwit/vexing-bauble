export interface ManaBoxCopyImport {
  quantity: number;
  condition: string;
  finish: string;
  language: string;
  purchase_price: string | null;
  purchase_date: string | null;
  notes: string | null;
}

export interface ManaBoxPrintingImport {
  scryfall_id: string;
  copies: ManaBoxCopyImport[];
}

export interface ManaBoxPreviewRow {
  rowNumber: number;
  name: string;
  setCode: string;
  collectorNumber: string;
  quantity: number;
  condition: string;
  finish: string;
  language: string;
}

export interface ManaBoxParseResult {
  printings: ManaBoxPrintingImport[];
  previewRows: ManaBoxPreviewRow[];
  errors: string[];
  totalCopies: number;
}

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];

    if (quoted) {
      if (character === '"' && content[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
      continue;
    }

    if (character === '"' && cell.trim() === "") {
      cell = "";
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && content[index + 1] === "\n") {
        index += 1;
      }
      row.push(cell);
      if (row.some((value) => value.trim() !== "")) {
        rows.push(row);
      }
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }

  if (quoted) {
    throw new Error("The CSV contains an unterminated quoted field.");
  }

  row.push(cell);
  if (row.some((value) => value.trim() !== "")) {
    rows.push(row);
  }

  return rows;
}

function normalizeHeader(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function readField(
  row: string[],
  columns: Map<string, number>,
  ...aliases: string[]
) {
  for (const alias of aliases) {
    const index = columns.get(normalizeHeader(alias));
    if (index !== undefined) {
      return row[index]?.trim() ?? "";
    }
  }
  return "";
}

function parsePrice(value: string) {
  if (!value) {
    return null;
  }

  let normalized = value.replace(/[^\d,.-]/g, "");
  if (normalized.includes(",") && normalized.includes(".")) {
    normalized = normalized.replace(/,/g, "");
  } else if (normalized.includes(",")) {
    normalized = normalized.replace(",", ".");
  }

  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    return undefined;
  }

  return normalized;
}

function parseDate(value: string) {
  if (!value) {
    return null;
  }

  let normalized = value;
  const isoDateTime =
    /^(\d{4}-\d{2}-\d{2})(?:[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i.exec(
      value
    );
  if (isoDateTime) {
    normalized = isoDateTime[1];
    if (/[Tt]/.test(value) && Number.isNaN(Date.parse(value))) {
      return undefined;
    }
  }

  const usDate = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (!isoDateTime && usDate) {
    normalized = `${usDate[3]}-${usDate[1].padStart(2, "0")}-${usDate[2].padStart(2, "0")}`;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return undefined;
  }

  const parsed = new Date(`${normalized}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === normalized
    ? normalized
    : undefined;
}

function parseFinish(finishValue: string, foilValue: string) {
  const finish = finishValue.toLowerCase();
  if (finish.includes("proxy") || finish === "paper") {
    return "Paper/Proxy";
  }
  if (finish.includes("etched")) {
    return "Etched";
  }
  if (finish.includes("foil") && !finish.includes("nonfoil")) {
    return "Foil";
  }
  if (finish === "nonfoil" || finish === "non-foil" || finish === "regular") {
    return "Nonfoil";
  }

  const foil = foilValue.trim().toLowerCase();
  return ["true", "yes", "1", "foil"].includes(foil) ? "Foil" : "Nonfoil";
}

function normalizeCondition(value: string) {
  const condition = value.trim();
  switch (condition.toLowerCase().replace(/[\s-]+/g, "_")) {
    case "nm":
    case "near_mint":
      return "Near Mint";
    case "lp":
    case "lightly_played":
      return "Lightly Played";
    case "mp":
    case "moderately_played":
      return "Moderately Played";
    case "hp":
    case "heavily_played":
      return "Heavily Played";
    case "dmg":
    case "damaged":
      return "Damaged";
    default:
      return condition || "Near Mint";
  }
}

function normalizeLanguage(value: string) {
  const language = value.trim();
  const names: Record<string, string> = {
    ar: "Arabic",
    de: "German",
    en: "English",
    es: "Spanish",
    fr: "French",
    grc: "Ancient Greek",
    he: "Hebrew",
    it: "Italian",
    ja: "Japanese",
    ko: "Korean",
    la: "Latin",
    ph: "Phyrexian",
    pt: "Portuguese",
    ru: "Russian",
    sa: "Sanskrit",
    zhs: "Simplified Chinese",
    zht: "Traditional Chinese",
  };
  const normalized = language.toLowerCase().replace(/[\s_-]+/g, "");

  return names[normalized] ?? language;
}

export function parseManaBoxCsv(content: string): ManaBoxParseResult {
  let rows: string[][];
  try {
    rows = parseCsv(content.replace(/^\uFEFF/, ""));
  } catch (error) {
    return {
      printings: [],
      previewRows: [],
      errors: [error instanceof Error ? error.message : "Could not read the CSV."],
      totalCopies: 0,
    };
  }

  if (rows.length < 2) {
    return {
      printings: [],
      previewRows: [],
      errors: ["The CSV must include a header and at least one card row."],
      totalCopies: 0,
    };
  }

  const columns = new Map(
    rows[0].map((header, index) => [normalizeHeader(header), index])
  );
  const errors: string[] = [];

  if (!columns.has("scryfallid")) {
    errors.push('Required ManaBox column "Scryfall ID" was not found.');
  }
  if (!columns.has("quantity") && !columns.has("qty")) {
    errors.push('Required ManaBox column "Quantity" was not found.');
  }
  if (errors.length > 0) {
    return { printings: [], previewRows: [], errors, totalCopies: 0 };
  }

  const printingById = new Map<string, ManaBoxPrintingImport>();
  const previewRows: ManaBoxPreviewRow[] = [];
  let totalCopies = 0;

  rows.slice(1).forEach((row, index) => {
    const rowNumber = index + 2;
    const scryfallId = readField(row, columns, "Scryfall ID");
    const quantityValue = readField(row, columns, "Quantity", "Qty");
    const quantity = Number(quantityValue);
    const rowErrors: string[] = [];

    if (!scryfallId) {
      rowErrors.push("missing Scryfall ID");
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
      rowErrors.push("quantity must be a positive whole number");
    }

    const priceText = readField(
      row,
      columns,
      "Purchase price",
      "Purchase price (USD)"
    );
    const priceValue = parsePrice(priceText);
    if (priceValue === undefined) {
      rowErrors.push("purchase price is not a valid number");
    }
    const declaredPriceCurrency = readField(
      row,
      columns,
      "Purchase price currency"
    )
      .trim()
      .toUpperCase();
    const priceColumnIsUsd = columns.has(
      normalizeHeader("Purchase price (USD)")
    );
    const priceCurrency =
      priceColumnIsUsd ? "USD" : declaredPriceCurrency || "EUR";
    if (
      priceValue !== null &&
      priceValue !== undefined &&
      priceCurrency !== "EUR"
    ) {
      rowErrors.push(
        `purchase price currency must be EUR (found ${priceCurrency})`
      );
    }

    const purchaseDateValue =
      readField(row, columns, "Purchase date", "Date purchased") ||
      readField(row, columns, "Added");
    const purchaseDate = parseDate(purchaseDateValue);
    if (purchaseDate === undefined) {
      rowErrors.push("purchase date must be YYYY-MM-DD or MM/DD/YYYY");
    }

    if (rowErrors.length > 0) {
      errors.push(`Row ${rowNumber}: ${rowErrors.join(", ")}.`);
      return;
    }

    const condition = normalizeCondition(readField(row, columns, "Condition"));
    const finish = parseFinish(
      readField(row, columns, "Finish"),
      readField(row, columns, "Foil")
    );
    const language = normalizeLanguage(readField(row, columns, "Language") || "en");
    const copy = {
      quantity,
      condition,
      finish,
      language,
      purchase_price: priceValue ?? null,
      purchase_date: purchaseDate ?? null,
      notes: readField(row, columns, "Notes") || null,
    };
    const existing = printingById.get(scryfallId);

    if (existing) {
      existing.copies.push(copy);
    } else {
      printingById.set(scryfallId, {
        scryfall_id: scryfallId,
        copies: [copy],
      });
    }

    const rowName = readField(row, columns, "Name");
    previewRows.push({
      rowNumber,
      name: rowName || "Card",
      setCode: readField(row, columns, "Set code", "Set"),
      collectorNumber: readField(row, columns, "Collector number"),
      quantity,
      condition,
      finish,
      language,
    });
    totalCopies += quantity;
  });

  return {
    printings: Array.from(printingById.values()),
    previewRows,
    errors,
    totalCopies,
  };
}
