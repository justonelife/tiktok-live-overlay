// Banner text templating. Shared by the overlay (browser) and unit tests (Node).
// Output is plain text: the overlay assigns it via textContent, never innerHTML.

export const DEFAULT_TEMPLATE = '{user} sent {gift} {unit} · {ordinal} time';
// Default shown to Vietnamese streamers (server config default).
export const VI_TEMPLATE = '{user} tặng {gift} {unit} — lần thứ {count}';

export const TEMPLATE_VARS = Object.freeze(['user', 'gift', 'count', 'ordinal', 'unit', 'combo', 'diamonds']);

export function ordinal(n) {
  const v = n % 100;
  const suffix = v >= 11 && v <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th');
  return `${n}${suffix}`;
}

/** Variables available to a template for a normalized gift event. */
export function bannerVars(ev) {
  const g = ev.gift;
  return {
    user: ev.user.name,
    gift: g.name,
    count: String(g.count), // Nth time this user sent this gift
    ordinal: ordinal(g.count),
    unit: `×${g.comboCount}`, // quantity in this streak, e.g. "×5"
    combo: String(g.comboCount),
    diamonds: String(g.diamondTotal),
  };
}

/** Replace {var} placeholders; unknown placeholders are left untouched. */
export function renderTemplate(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? vars[k] : m));
}
