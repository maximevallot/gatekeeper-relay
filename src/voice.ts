// Every reply speaks as Gatekeeper. The extension calls the feature "AI help"; a reply never names the model or
// "the agent" (Maxime's test before the first testers, 2026-10-18).

const SWAPS: [RegExp, string][] = [
  [/\bGatekeeper's agent\b/gi, "Gatekeeper"],
  [/\bthe agent\b/gi, "Gatekeeper"],
  [/\bClaude\b/g, "Gatekeeper"],
  [/\bAnthropic\b/g, "Gatekeeper"],
];

export function voice(reply: string): string {
  let r = reply;
  for (const [re, to] of SWAPS) r = r.replace(re, to);
  return r.replace(/Gatekeeper Gatekeeper/g, "Gatekeeper");
}
