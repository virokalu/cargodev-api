// The rate limit for the file-link route (GET /f/v1/...), in one place (tested: tests/file-links.test.ts).
// Per client address. A screen of thumbnails opens many links at once, so the limit is generous; a wrong or forged link is still
// counted, which is what slows down guessing.

const MINUTE = 60_000;

export const FILE_LINK_RATE_LIMIT = { max: 240, windowMs: MINUTE } as const;
