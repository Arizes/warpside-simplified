// Battle rank as the game writes it: BR 1-120, with a trailing ~n for an ASP (prestige) rank.
// A character the tracker has not looked up yet has no rank to show, so the badge is left out
// rather than guessed at.
export function brLabel(p) {
  const br = Number(p?.br) || 0;
  if (br <= 0) return '';
  const asp = Number(p?.asp) || 0;
  return `BR ${br}${asp > 0 ? `~${asp}` : ''}`;
}
