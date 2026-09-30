// src/branding.ts
//
// Whose this is, in one place and in English.
//
// The signature was in four places and said four things — "Simorgh Software",
// "Simorgh Design Suite", a Persian line on the splash and nothing at all on
// the reports that leave the building. A signature that varies is not a
// signature. These are the words, and everything that signs anything takes
// them from here.
//
// English everywhere, on purpose: these go onto drawings and spreadsheets that
// are sent to clients and to EPLAN, and a right-to-left line in the middle of
// a left-to-right title block is not a thing anybody wants to explain.

/** The product. */
export const PRODUCT_NAME = 'Simorgh Design Suite';

/** What it is, for a subtitle. */
export const PRODUCT_TAGLINE = 'Electrical Engineering Design Platform';

/** The company that owns it. */
export const COMPANY_NAME = 'Simorgh Smart Technology of Iranians Co.';

/** The year rights are asserted from. */
export const COPYRIGHT_YEAR = 2025;

/** The one line that goes at the foot of a screen. */
export const COPYRIGHT_LINE =
  `© ${COPYRIGHT_YEAR} ${COMPANY_NAME} — All rights reserved.`;

/** The same, for a drawing title block or a report header, where it is tight. */
export const COPYRIGHT_SHORT = `© ${COMPANY_NAME}`;

/** Product and owner together, for a report cover or an About box. */
export const PRODUCT_AND_OWNER = `${PRODUCT_NAME} — ${COPYRIGHT_SHORT}`;
