// Every reply speaks as Gatekeeper. The extension calls the feature "AI help"; a reply never names the model or
// "the agent" (Maxime's test before the first testers, 2026-10-18).

const SWAPS: [RegExp, string][] = [
  [/\bGatekeeper's agent\b/gi, "Gatekeeper"],
  [/\bthe agent\b/gi, "Gatekeeper"],
  [/\bClaude\b/g, "Gatekeeper"],
  [/\bAnthropic\b/g, "Gatekeeper"],
  // Internal words a student never sees: a category is named, and "watched" means "has a limit".
  [/\bthe (video|social|social media|games|news|shopping) kind\b/gi, "$1"],
  [/\b(video|social|social media|games|news|shopping) kind\b/gi, "$1"],
  [/\b(that|this|its|the same|a watched|the watched) kind\b/gi, "that category"],
  // "Watched" reads as if someone were watching the student (Maxime, 2026-10-18): limits are "limited".
  [/\b(the |your )?watch(ing)? week\b/gi, "your first week"],
  [/\b(is|are|was|were) not (being )?watched\b/gi, "$1 not limited"],
  [/\b(no longer|not) watched\b/gi, "not limited"],
  [/\bunwatched\b/gi, "not limited"],
  // "kinds" as Gatekeeper's word for categories; "kinds of" stays ordinary English.
  [/\bkinds\b(?! of)/gi, "categories"],
  [/\b(is|are|was|were|stays?|remains?) (being )?watched\b/gi, "$1 limited"],
  [/\bwatched (categor(?:y|ies)|kinds?|sites?)\b/gi, "limited $1"],
  [/\bwatched\b(?= (?:or not|and|,|\.))/gi, "limited"],
];

export function voice(reply: string): string {
  let r = reply;
  for (const [re, to] of SWAPS) r = r.replace(re, to);
  // A category named at the start of a sentence keeps its capital: "Video", "Games".
  r = r.replace(/(^|[.!?]\s+)(video|social media|social|games|news|shopping)\b/g, (_m, before: string, w: string) => before + w[0]!.toUpperCase() + w.slice(1));
  return r.replace(/Gatekeeper Gatekeeper/g, "Gatekeeper");
}
