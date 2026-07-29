export const SEBE_DISCLOSURE = "I’m Sebe, an AI assistant working with Jetz Alipalo.";
export const COMMERCIAL_TERMS_TOKEN = "{{COMMERCIAL_TERMS}}";

const VISA_TERMS =
  /\b(visa|sponsor(?:ship|ed|ing)?|residen(?:cy|t)|work[- ]?rights?|right to work|work authori[sz]ation)\b/iu;
const POSTED_PAY_CLAIM =
  /\b(posted|advertised|listed|stated|published)\s+(salary|rate|range|compensation|pay)\b/iu;
const PAY_FACT =
  /(?:[$€£]\s?\d[\d,.]*(?:\s?[kKmM])?(?:\s*(?:-|–|to)\s*[$€£]?\s?\d[\d,.]*(?:\s?[kKmM])?)?(?:\s*(?:\/|per)\s*(?:hour|hr|year|annum|week))?)|(?:\b\d[\d,.]*\s?(?:USD|NZD|AUD|CAD|EUR|GBP)(?:\s*(?:\/|per)\s*(?:hour|hr|year|annum|week))?\b)/giu;

export interface PitchValidation {
  valid: boolean;
  errors: string[];
}

export function validateSubject(input: {
  subject: string;
  postingText: string;
}): PitchValidation {
  const errors = guardedContentErrors(input.subject, input.postingText, "Subject");

  return { valid: errors.length === 0, errors };
}

export function validatePitch(input: {
  pitch: string;
  postingText: string;
  commercialTerms: string;
}): PitchValidation {
  const errors: string[] = [];
  const prose = input.pitch.replace(input.commercialTerms, "");

  if (!input.pitch.includes(SEBE_DISCLOSURE)) {
    errors.push(`Pitch must include the disclosure line exactly: ${SEBE_DISCLOSURE}`);
  }
  errors.push(...guardedContentErrors(prose, input.postingText, "Pitch"));

  return { valid: errors.length === 0, errors };
}

function guardedContentErrors(
  value: string,
  postingText: string,
  label: "Pitch" | "Subject",
): string[] {
  const errors: string[] = [];

  if (VISA_TERMS.test(value)) {
    errors.push(`${label} must not mention visas, sponsorship, residency, or work rights`);
  }
  if (POSTED_PAY_CLAIM.test(value)) {
    errors.push(`${label} must not characterize pay as posted, advertised, listed, or stated`);
  }

  const posting = normalizePayText(postingText);
  for (const match of value.matchAll(PAY_FACT)) {
    const fact = normalizePayText(match[0]);

    if (!posting.includes(fact)) {
      errors.push(`${label} includes a pay fact absent from the posting: ${match[0]}`);
    }
  }

  return errors;
}

function normalizePayText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[–\u2014]/g, "-")
    .replace(/\s+/g, "")
    .replace(/,/g, "");
}
