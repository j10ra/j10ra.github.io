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
  if (VISA_TERMS.test(prose)) {
    errors.push("Pitch must not mention visas, sponsorship, residency, or work rights");
  }
  if (POSTED_PAY_CLAIM.test(prose)) {
    errors.push("Pitch must not characterize pay as posted, advertised, listed, or stated");
  }

  const posting = normalizePayText(input.postingText);
  for (const match of prose.matchAll(PAY_FACT)) {
    const fact = normalizePayText(match[0]);

    if (!posting.includes(fact)) {
      errors.push(`Pitch includes a pay fact absent from the posting: ${match[0]}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

function normalizePayText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[–\u2014]/g, "-")
    .replace(/\s+/g, "")
    .replace(/,/g, "");
}
