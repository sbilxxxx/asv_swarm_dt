/**
 * rule_based_fallback.js — APIキー・ローカルLLM不要のデフォルト意思決定
 *
 * LlmAgent の decideFn を差し替えなかった場合に使われる。
 * 「非味方の最も近いコンタクトへ向かう」「対象がいなければ直進」という単純則。
 * これにより、GitHub Pages上でもセットアップなしにデモが動く。
 */

export async function simpleRuleBasedDecision(observation, self, memory) {
  const radar = observation?.radar;
  const nearestContact = radar?.contacts
    ?.filter((c) => c.faction !== self.faction)
    ?.sort((a, b) => a.rangeM - b.rangeM)[0];

  if (nearestContact) {
    return { throttle: 0.6, steering: bearingToSteering(nearestContact.bearingRad) };
  }
  return { throttle: 0.4, steering: 0 };
}

function bearingToSteering(bearingRad) {
  const normalized = Math.atan2(Math.sin(bearingRad), Math.cos(bearingRad));
  return Math.max(-1, Math.min(1, normalized / Math.PI));
}
