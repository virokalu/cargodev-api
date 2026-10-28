// Settings for the public website API (/api/public) in one place, and tested (tests/public-stock.test.ts).
// Nothing here is read from a request.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The most listings a public page returns, however much a client asks for. */
export const PUBLIC_MAX_PAGE_SIZE = 24;
export const PUBLIC_DEFAULT_PAGE_SIZE = 12;

/** Public GET responses may be cached by browsers and a CDN for this long (everything else is no-store). */
export const PUBLIC_CACHE_SECONDS = 60;

/** Enquiry bodies are tiny; anything larger is refused before it is parsed. */
export const ENQUIRY_BODY_LIMIT_BYTES = 8 * 1024;

export const PUBLIC_RATE_LIMITS = {
  /** Browsing the stock: per IP. */
  read: { max: 120, windowMs: MINUTE },
  /** The enquiry form: per IP per minute, then per IP per hour and per email per hour. */
  enquiryIpBurst: { max: 5, windowMs: MINUTE },
  enquiryIpHour: { max: 10, windowMs: HOUR },
  enquiryEmailHour: { max: 3, windowMs: HOUR },
} as const;

/**
 * Every listing price is in Sri Lankan rupees. There is NO conversion and no per-listing currency (FTJ decision).
 * `StockVehicle.priceFob` holds the listing price in this currency; the column name is historical and is not renamed
 * (a rename is a non-additive change). The API always returns a price as { amount, currency }, never a bare number.
 */
export const STOCK_PRICE_CURRENCY = "LKR" as const;

/** A sane ceiling for one listing, in whole rupees (2 billion). Prices are positive whole rupees. */
export const MAX_STOCK_PRICE = 2_000_000_000;

/** Stock images: how many per vehicle, how big, which types. Public images are never SVG or HTML. */
export const MAX_IMAGES_PER_STOCK = 20;
export const MAX_STOCK_IMAGE_BYTES = 8 * 1024 * 1024;
export const STOCK_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

/** The most customers one "new stock" announcement is sent to. */
export const MAX_NEW_STOCK_RECIPIENTS = 1000;
