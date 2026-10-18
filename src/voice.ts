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
  [/\b(is|are) not watched\b/gi, "$1 not limited"],
  [/\bunwatched\b/gi, "not limited"],
];

export function voice(reply: string): string {
  let r = reply;
  for (const [re, to] of SWAPS) r = r.replace(re, to);
  // A category named at the start of a sentence keeps its capital: "Video", "Games".
  r = r.replace(/(^|[.!?]\s+)(video|social media|social|games|news|shopping)\b/g, (_m, before: string, w: string) => before + w[0]!.toUpperCase() + w.slice(1));
  return r.replace(/Gatekeeper Gatekeeper/g, "Gatekeeper");
}
