/**
 * Page/pageSize query-parameter parsing for the collection endpoints.
 *
 * Every collection endpoint accepted the same two parameters with its
 * own copy of the parsing, so this is the one place that decides what
 * a valid page is. Invalid input is rejected rather than clamped: a
 * request asking for page 0 has a bug in it, and answering with page 1
 * hides that bug from the caller.
 */
import { HttpError } from "./errors.js";

/** Rows returned when the request does not ask for a page size. */
export const DEFAULT_PAGE_SIZE = 25;

/** The largest page a caller may ask for. */
export const MAX_PAGE_SIZE = 100;

/**
 * The highest page number accepted. Deep pages are answered from the
 * cursor endpoints instead, so an offset can never grow beyond
 * MAX_PAGE * MAX_PAGE_SIZE.
 */
export const MAX_PAGE = 1000;

export interface Pagination {
  /** 1-based page number. */
  page: number;
  /** Rows per page; the SQL LIMIT. */
  pageSize: number;
  /** Rows to skip; the SQL OFFSET. */
  offset: number;
}

/**
 * Parses one integer parameter. A repeated query parameter arrives as
 * an array rather than a string, which is a malformed request rather
 * than a value to guess at.
 */
function parseInteger(
  name: string,
  raw: unknown,
  fallback: number,
  max: number,
): number {
  if (raw === undefined) {
    return fallback;
  }
  if (typeof raw !== "string") {
    throw new HttpError(400, `${name} must be given at most once`);
  }
  if (!/^[0-9]+$/.test(raw)) {
    throw new HttpError(400, `${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (value < 1 || value > max) {
    throw new HttpError(400, `${name} must be between 1 and ${max}`);
  }
  return value;
}

/** Parses `page` and `pageSize`, or throws HttpError(400). */
export function parsePagination(query: Record<string, unknown>): Pagination {
  const page = parseInteger("page", query["page"], 1, MAX_PAGE);
  const pageSize = parseInteger(
    "pageSize",
    query["pageSize"],
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
  );

  return { page, pageSize, offset: (page - 1) * pageSize };
}
