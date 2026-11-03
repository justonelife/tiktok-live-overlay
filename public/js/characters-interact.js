// Interaction rules between viewer characters. Pure functions over a
// CharacterWorld (see characters.js); no DOM.
//
//   join     newcomer drops in and waves; the nearest neighbour waves back
//   comment  speaker talks with a pixel speech bubble; up to 2 neighbours nod
//   like     liker sends hearts; up to 2 neighbours join in
//   follow   follower throws stars; up to 2 neighbours too
//   share    sharer waves
//   gift     giver dances (big gift: celebrates); up to 4 neighbours turn and wave / send hearts
//   idle     two characters that meet may greet each other (both wave, face each other)
//   group    every 25-40 s everybody hops to the same beat (config: characters.groupDance)

export const BIG_GIFT = 100; // diamonds: celebrate instead of dance
export const GREETING = Object.freeze({ every: 0.6, chance: 0.12, cooldown: 9, range: 2.6 });
export const GROUP_DANCE = Object.freeze({ min: 25, max: 40, dur: 2.2, beatsPerSec: 2 });
const HELLO = ['Chào!', 'Hi!', 'Hế lô!', 'Yo!', 'Xin chào!'];
const ENTER_DELAY = 0.8; // newcomer lands before anyone waves back

const free = (c) => c.state === 'idle' || c.state === 'walk';

/** Neighbours react to `src` one after another (small stagger), facing it. */
function cheer(world, src, list, pick) {
  list.forEach((n, i) => {
    world.later(0.15 + i * 0.14 + world.rng() * 0.1, () => n.react(pick(i), world.time, { face: src.x }));
  });
}

/**
 * Apply one normalized overlay event to the world.
 * @returns {object|null} the acting character
 */
export function onEvent(world, ev) {
  if (!ev || !ev.user) return null;
  const ch = world.ensure(ev.user);
  if (!ch) return null;
  const now = world.time;
  const onStage = world.isOnStage(ch);
  const near = (r, n) => (onStage ? world.neighbors(ch, r * world.bodyW, n) : []);

  switch (ev.type) {
    case 'join': {
      ch.react('wave', now);
      const [buddy] = near(4, 1);
      if (buddy && ch.state === 'enter') world.later(ENTER_DELAY, () => buddy.react('wave', world.time, { face: ch.x }));
      break;
    }
    case 'comment':
      world.say(ch, ev.text);
      ch.react('talk', now);
      cheer(world, ch, near(3.5, 2), () => 'nod');
      break;
    case 'like':
      if (ch.react('heart', now) === 'applied') {
        cheer(world, ch, near(3, 2).filter(() => world.rng() < 0.6), () => 'heart');
      }
      break;
    case 'follow':
      ch.react('star', now);
      cheer(world, ch, near(3.5, 2), () => 'star');
      break;
    case 'share':
      ch.react('wave', now);
      break;
    case 'gift': {
      const big = (ev.gift?.diamondTotal ?? 0) >= BIG_GIFT;
      ch.react(big ? 'celebrate' : 'dance', now);
      if (big) for (let i = 0; i < 6; i++) world.fx('spark', ch.x + (world.rng() - 0.5) * 2 * world.bodyW, ch.y - world.bodyW * (1 + world.rng()));
      cheer(world, ch, near(big ? 6 : 4, 4), (i) => (i % 2 ? 'heart' : 'wave'));
      break;
    }
    default:
      break;
  }
  return ch;
}

/** Live gift-streak progress: keep the giver dancing (cooldown prevents spam). */
export function onCombo(world, d) {
  if (!d?.user || !(d.comboCount >= 2)) return null;
  const ch = world.ensure(d.user);
  ch?.react('dance', world.time);
  return ch;
}

/** Per-frame interaction checks: greetings between neighbours and the group dance. */
export function tickInteractions(world, dt) {
  const now = world.time;

  // Greetings: two free characters close together, both off greeting cooldown, small chance.
  world.greetClock += dt;
  if (world.greetClock >= GREETING.every) {
    world.greetClock = 0;
    const list = world.characters;
    const range = GREETING.range * world.bodyW;
    outer: for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!free(a) || a.greetAt > now) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!free(b) || b.greetAt > now) continue;
        if (Math.abs(a.x - b.x) > range || Math.abs(a.y - b.y) > world.bodyW * 0.6) continue;
        if (world.rng() >= GREETING.chance) continue;
        greet(world, a, b);
        break outer; // at most one greeting per check
      }
    }
  }

  // Group dance.
  world.groupTimer -= dt;
  if (world.groupTimer <= 0) {
    world.groupTimer = GROUP_DANCE.min + world.rng() * (GROUP_DANCE.max - GROUP_DANCE.min);
    if (world.groupDance) groupDance(world);
  }
}

/** Make `a` and `b` greet each other. Exported for tests. */
export function greet(world, a, b) {
  const now = world.time;
  a.react('wave', now, { face: b.x, force: true });
  b.react('wave', now, { face: a.x, force: true });
  world.say(a, HELLO[Math.floor(world.rng() * HELLO.length)], 1.8);
  world.later(0.45, () => world.say(b, HELLO[Math.floor(world.rng() * HELLO.length)], 1.6));
  a.greetAt = b.greetAt = now + GREETING.cooldown;
  world.stats.greetings++;
}

/** Everyone on stage hops to the same beat. Returns how many joined. Exported for tests. */
export function groupDance(world) {
  const dancers = world.characters.filter((c) => c.state !== 'enter' && c.state !== 'leave' && c.kind !== 'celebrate');
  if (dancers.length < 2) return 0;
  world.groupStart = world.time;
  for (const c of dancers) c.react('dance', world.time, { force: true, sync: true, dur: GROUP_DANCE.dur });
  for (let i = 0; i < 8; i++) world.fx('spark', world.margin + world.rng() * (world.width - 2 * world.margin), world.minY - world.bodyW * (1 + world.rng()));
  world.stats.groupDances++;
  return dancers.length;
}
