"use server";

import type { Card, OwnedCopy, Printing } from "@/types/card";
import type { ScryfallCard } from "@/types/scryfall";
import type { ManaBoxPrintingImport } from "./manabox-csv";

export interface BulkCopyUpdateInput {
  condition?: string;
  finish?: string;
  language?: string;
}

export type CardCatalogStatus = {
  status:
    | "missing"
    | "checking"
    | "downloading"
    | "indexing"
    | "ready"
    | "error";
  message: string;
  error?: string;
  refreshing?: boolean;
  updated_at?: string;
  card_count?: number;
  printings_processed?: number;
};

function getBackendUrl() {
  const backendUrl = process.env.BACKEND_URL?.replace(/\/+$/, "");

  if (!backendUrl) {
    throw new Error("BACKEND_URL is not configured.");
  }

  return backendUrl;
}

function formatBackendError(body: string) {
  try {
    const parsed = JSON.parse(body) as {
      detail?: unknown;
      message?: unknown;
    };

    if (typeof parsed.detail === "string") {
      return parsed.detail;
    }

    if (Array.isArray(parsed.detail)) {
      return parsed.detail
        .map((issue) => {
          if (typeof issue !== "object" || issue === null) {
            return "";
          }

          const validationIssue = issue as {
            loc?: unknown;
            msg?: unknown;
          };
          const location = Array.isArray(validationIssue.loc)
            ? validationIssue.loc
                .filter((part) => part !== "body")
                .map(String)
                .join(".")
            : "";
          const message =
            typeof validationIssue.msg === "string"
              ? validationIssue.msg
              : "Invalid value.";

          return location ? `${location}: ${message}` : message;
        })
        .filter(Boolean)
        .join("\n");
    }

    if (typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    return body;
  }

  return body;
}

async function backendFetch<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${getBackendUrl()}${path}`, {
      ...init,
      cache: "no-store",
    });
  } catch (error) {
    const reason = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(
      `Could not reach the collection backend. Confirm it is running and BACKEND_URL is correct.${reason}`
    );
  }

  if (!response.ok) {
    const body = await response.text();
    const details = formatBackendError(body);
    const operation =
      path === "/collection/import" ? "ManaBox import" : "Backend request";
    const message =
      response.status === 404 && path === "/collection/import"
        ? "The running backend does not have the ManaBox import endpoint. Restart the backend so it loads the latest code."
        : details || response.statusText || "Unknown backend error.";

    throw new Error(`${operation} failed (HTTP ${response.status}): ${message}`);
  }

  return response.json();
}

export async function getCollection(): Promise<Card[]> {
  return backendFetch<Card[]>("/collection");
}

export async function searchCardCatalog(
  query: string
): Promise<ScryfallCard[]> {
  const normalizedQuery = query.trim();

  if (!normalizedQuery) {
    throw new Error("Enter a card name.");
  }

  const result = await backendFetch<{ data: ScryfallCard[] }>(
    `/scryfall/search?q=${encodeURIComponent(normalizedQuery)}`
  );

  return result.data;
}

export async function getCardCatalogStatus(): Promise<CardCatalogStatus> {
  return backendFetch<CardCatalogStatus>("/scryfall/catalog/status");
}

export async function startCardCatalogSync(): Promise<CardCatalogStatus> {
  return backendFetch<CardCatalogStatus>("/scryfall/catalog/sync", {
    method: "POST",
  });
}

export async function getCardPrintings(
  oracleId: string
): Promise<ScryfallCard[]> {
  const result = await backendFetch<{ data: ScryfallCard[] }>(
    `/scryfall/printings/${encodeURIComponent(oracleId)}`
  );

  return result.data;
}

export async function importScryfallPrinting(
  scryfallId: string
): Promise<{ message: string; card_id: number; printing: Printing }> {
  return backendFetch(`/scryfall/import/${encodeURIComponent(scryfallId)}`, {
    method: "POST",
  });
}

export interface OwnedCopyInput {
  condition: string;
  finish: string;
  language: string;
  purchase_price: string | null;
  purchase_date: string | null;
  notes: string | null;
}

export async function createOwnedCopy(
  printingId: number,
  copy: OwnedCopyInput
): Promise<OwnedCopy> {
  return backendFetch(`/printings/${printingId}/copies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ printing_id: printingId, ...copy }),
  });
}

export async function updateOwnedCopy(
  copyId: number,
  copy: OwnedCopyInput
): Promise<OwnedCopy> {
  return backendFetch(`/copies/${copyId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(copy),
  });
}

export async function deleteOwnedCopy(copyId: number): Promise<void> {
  await backendFetch<{ message: string }>(`/copies/${copyId}`, {
    method: "DELETE",
  });
}

export async function updateManyOwnedCopies(
  copyIds: number[],
  updates: BulkCopyUpdateInput
): Promise<OwnedCopy[]> {
  return backendFetch("/copies/bulk", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ copy_ids: copyIds, ...updates }),
  });
}

export async function deleteManyOwnedCopies(
  copyIds: number[]
): Promise<{ deleted: number }> {
  return backendFetch("/copies/bulk-delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ copy_ids: copyIds }),
  });
}

export async function importManaBoxCollection(
  printings: ManaBoxPrintingImport[]
): Promise<{ message: string; printings: number; copies: number }> {
  return backendFetch("/collection/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ printings }),
  });
}
