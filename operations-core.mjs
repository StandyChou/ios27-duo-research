function nonNegativeFinite(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function finiteRatio(numerator, denominator) {
  if (!denominator) return null;
  const ratio = numerator / denominator;
  return Number.isFinite(ratio) ? ratio : null;
}

export function calculateGrowthEconomics(input) {
  const spend = nonNegativeFinite(input.spend);
  const paid = nonNegativeFinite(input.paid);
  const proceeds = nonNegativeFinite(input.proceeds);

  return {
    paidCac: finiteRatio(spend, paid),
    roas: finiteRatio(proceeds, spend),
    contributionMargin: proceeds - spend,
  };
}

export function decideFunnelAction(funnel) {
  if (!funnel.hold) return "换首帧与前两秒";
  if (!funnel.click) return "重写价值主张与 CTA";
  if (!funnel.install) return "校准素材与商店页";
  if (!funnel.trial) return "修正首启与付费墙时机";
  if (!funnel.paid) return "检查价格、试用和持续价值";
  return "小步放量并守住下游质量";
}

export function filterHook(hook, filters) {
  return ["channel", "timing", "scenario"].every(
    (dimension) => filters[dimension] === "全部" || hook[dimension] === filters[dimension],
  );
}
