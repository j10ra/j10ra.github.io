export const TERMS_TOKEN = "{{TERMS}}";

const ATTRIBUTED_VALUE =
  /\b(posted|advertised|listed|stated|published)\s+(salary|rate|range|compensation|pay|fee|wage)\b/iu;
const DIGIT = /\d/u;

export interface MessageValidation {
  valid: boolean;
  errors: string[];
}

export function validateSubject(input: {
  subject: string;
  blockedTopics: string[];
}): MessageValidation {
  const errors = guardedContentErrors(input.subject, input.blockedTopics, "Subject");

  return { valid: errors.length === 0, errors };
}

export function validatePitch(input: {
  pitch: string;
  verbatimTerms: string;
  blockedTopics: string[];
  requiredDisclosure: string | null;
}): MessageValidation {
  const errors: string[] = [];
  const prose = removeVerbatimTerms(input.pitch, input.verbatimTerms);

  if (
    input.requiredDisclosure &&
    !input.pitch.includes(input.requiredDisclosure)
  ) {
    errors.push(
      `Pitch must include the required disclosure exactly: ${input.requiredDisclosure}`,
    );
  }
  errors.push(...guardedContentErrors(prose, input.blockedTopics, "Pitch"));

  return { valid: errors.length === 0, errors };
}

function guardedContentErrors(
  value: string,
  blockedTopics: string[],
  label: "Pitch" | "Subject",
): string[] {
  const errors: string[] = [];

  for (const topic of blockedTopics) {
    if (!boundaryPattern(topic).test(value)) continue;

    errors.push(`${label} must not mention blocked topic: ${topic}`);
  }
  if (ATTRIBUTED_VALUE.test(value)) {
    errors.push(`${label} must not characterize a numeric value as externally stated`);
  }

  if (DIGIT.test(value)) {
    errors.push(`${label} must not include digits outside the verbatim terms block`);
  }

  return errors;
}

function boundaryPattern(term: string): RegExp {
  const escaped = term
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/[\s-]+/g, "[\\s-]+");

  return new RegExp(
    `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,
    "iu",
  );
}

function removeVerbatimTerms(pitch: string, terms: string): string {
  const index = pitch.indexOf(terms);

  if (index === -1) return pitch;

  return `${pitch.slice(0, index)}${pitch.slice(index + terms.length)}`;
}
