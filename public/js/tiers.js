// Gift tier + particle intensity, scaled by total diamond value of a finalized gift.
// Shared by overlay and tests.

export const MAX_PARTICLES_PER_BURST = 90;

export const TIERS = Object.freeze([
  { name: 'petals', min: 0 }, // rose petals
  { name: 'sparkle', min: 20 }, // gold sparkles
  { name: 'rain', min: 200 }, // falling gift icons
  { name: 'mega', min: 1000 }, // everything at once
]);

export function tierFor(diamondTotal) {
  let tier = TIERS[0];
  for (const t of TIERS) if (diamondTotal >= t.min) tier = t;
  return tier.name;
}

/** Particle count grows logarithmically with value: 1 diamond → 12, 30k → 90 (cap). */
export function particleCount(diamondTotal) {
  const d = Math.max(0, diamondTotal | 0);
  return Math.min(MAX_PARTICLES_PER_BURST, Math.round(12 + 17 * Math.log10(1 + d)));
}
