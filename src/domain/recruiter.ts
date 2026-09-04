export type RecruiterInput = {
  isSelf: boolean;
  headline?: string;
  company?: string;
  messages?: string[];
};

const strong: Array<[string, RegExp]> = [
  ['profile:recruiter', /\b(recruit(er|ment|ing)|náborář(?:ka)?|rekruter(?:ka)?)\b/iu],
  ['profile:talent-acquisition', /\btalent\s+(acquisition|partner)\b/iu],
  ['profile:sourcing', /\b(headhunter|staffing|sourc(?:er|ing)|recruitment consultant)\b/iu],
];
const weak: Array<[string, RegExp]> = [
  ['profile:people-hr', /\b(HR|people\s+(partner|operations)|hiring)\b/iu],
];
const messageSignals: Array<[string, RegExp]> = [
  ['message:opportunity', /\b(job|career|freelance|contract|pracovní|kariérní)\s+(opportunity|offer|nabídka|příležitost)\b/iu],
  ['message:role', /\b(open|new|leadership|vacant|otevřen[áéou]?)\s+(role|position|pozice)\b/iu],
  ['message:interview', /\b(interview|pohovor)\b/iu],
  ['message:compensation', /\b(salary|compensation|plat|mzda|sazba)\b/iu],
];

export function classifyRecruiter(input: RecruiterInput): { probablyRecruiter: boolean; recruiterSignals: string[] } {
  if (input.isSelf) return { probablyRecruiter: false, recruiterSignals: [] };
  const profile = [input.headline, input.company].filter(Boolean).join(' ');
  const message = (input.messages ?? []).join('\n');
  const strongHits = strong.filter(([, regex]) => regex.test(profile)).map(([name]) => name);
  const weakHits = weak.filter(([, regex]) => regex.test(profile)).map(([name]) => name);
  const textHits = messageSignals.filter(([, regex]) => regex.test(message)).map(([name]) => name);
  const signals = [...new Set([...strongHits, ...weakHits, ...textHits])].sort();
  return { probablyRecruiter: strongHits.length > 0 || weakHits.length + textHits.length >= 2, recruiterSignals: signals };
}

