import { stem } from '../analysis/communityInsights.js';

/**
 * What makes a phrase look like something a reader types into the Kindle search box. A keyword is a noun phrase: a trope, creature,
 * setting, job or mood ("low stakes", "talking animal", "spicy romantasy"), not whatever words happen to recur in blurbs. Two parts:
 *
 *  - LEXICON: the search terms of fantasy, romance, LitRPG, cozy, mystery and science fiction readers. A term is suggested only when
 *    listed books' titles or blurbs carry it, so the vocabulary is a filter on meaning, not a list of guesses.
 *  - FILLER: the closed-class and everyday words (pronouns, auxiliaries, prepositions, adverbs, light verbs, "next", "back", "must",
 *    "become") that no one searches for and that appear in every blurb. Phrases built from recurring words must contain none.
 */
export const LEXICON: string[] = [
  // creatures and characters
  'dragons', 'dragon shifter', 'vampires', 'werewolves', 'shifters', 'fae', 'faeries', 'elves', 'orcs', 'goblins', 'trolls', 'witches', 'wizards',
  'necromancer', 'demons', 'angels', 'ghosts', 'mermaids', 'unicorns', 'gargoyles', 'minotaur', 'centaur', 'gnomes', 'dwarves', 'halflings',
  'talking animal', 'familiar', 'monsters', 'zombies', 'aliens', 'robots', 'cyborg', 'pirates', 'assassin', 'thief', 'knight', 'princess', 'prince',
  'queen', 'king', 'warrior', 'mage', 'sorceress', 'healer', 'bard', 'ranger', 'paladin', 'dark lord', 'villain', 'antihero', 'chosen one',
  'strong female lead', 'older heroine', 'female protagonist', 'male lead', 'single dad', 'bodyguard', 'billionaire', 'boss', 'neighbor', 'best friend\'s brother',
  // settings and places
  'magic academy', 'castle', 'kingdom', 'village', 'small town', 'bakery', 'cafe', 'tavern', 'inn', 'bookshop', 'library', 'farm', 'garden', 'forest',
  'island', 'tower', 'dungeon', 'labyrinth', 'spaceship', 'space opera', 'post apocalyptic', 'dystopian', 'medieval', 'victorian', 'regency', 'steampunk',
  'cyberpunk', 'urban fantasy', 'portal fantasy', 'isekai', 'fairy tale', 'mythology', 'norse', 'greek mythology', 'arthurian', 'haunted house',
  // jobs and activities
  'cooking', 'baking', 'gardening', 'brewing', 'crafting', 'farming', 'fishing', 'adventuring', 'treasure hunt', 'heist', 'quest', 'tournament',
  'sword fighting', 'magic training', 'detective', 'amateur sleuth', 'cold case', 'murder mystery', 'time travel', 'reincarnation', 'rebuilding',
  // magic and systems
  'magic system', 'spell casting', 'alchemy', 'potions', 'curse', 'prophecy', 'enchanted', 'artifact', 'portal', 'levelling', 'leveling', 'litrpg',
  'progression fantasy', 'cultivation', 'dungeon core', 'system apocalypse', 'gamelit', 'stats', 'skills', 'base building', 'tower climbing',
  // romance and relationship tropes
  'romantasy', 'slow burn', 'enemies to lovers', 'friends to lovers', 'fake dating', 'forced proximity', 'second chance', 'grumpy sunshine', 'found family',
  'forbidden love', 'fated mates', 'arranged marriage', 'marriage of convenience', 'love triangle', 'why choose', 'reverse harem', 'harem', 'workplace romance',
  'age gap', 'rivals to lovers', 'only one bed', 'touch her and die', 'secret identity', 'mistaken identity', 'royal romance', 'magical romance',
  // heat level and mood
  'closed door', 'open door', 'spicy', 'steamy', 'sweet romance', 'clean romance', 'wholesome', 'cozy', 'low stakes', 'feel good', 'heartwarming',
  'uplifting', 'humor', 'comedy', 'satire', 'parody', 'dark romance', 'grimdark', 'gothic', 'horror', 'psychological thriller', 'suspense', 'whodunit',
  // structure
  'romance', 'magic', 'shop', 'stakes', 'tea', 'coffee', 'friendship', 'politics', 'war', 'pets', 'cats', 'dogs',
  'standalone', 'cliffhanger', 'happy ending', 'epic fantasy', 'sword and sorcery', 'coming of age', 'first person', 'dual pov', 'multiple pov',
];

/** Everyday and closed-class words that are never a keyword by themselves or as the body of one. */
export const FILLER = new Set((
  'a an and the of for with to in on at by or but nor so yet if then than that this these those there here where when while who whom whose which what why how ' +
  'i me my mine we us our you your he him his she her hers it its they them their is am are was were be been being do does did done doing don\'t doesn\'t didn\'t ' +
  'have has had having will would shall should can could may might must cannot can\'t won\'t isn\'t aren\'t wasn\'t weren\'t not no yes ' +
  'next back behind before after again ago ahead along already also always anyway around away because both down during each either else enough even ever every ' +
  'far few first forever from further hence however into just last later least less lest like little long many more most much never new now off often once only ' +
  'other others out over own quite rather really same since some soon still such than through thus together too under until up upon very well whether within without yet ' +
  'become becomes became becoming begin begins began come comes came coming get gets got getting give gives gave go goes going gone keep keeps kept know knows knew ' +
  'let lets look looks made make makes making need needs one two three four five say says said see seen seems seem set take takes taken took tell tells told ' +
  'try tries tried turn turns turned use used want wants wanted find finds found thing things way ways time times day days year years life lives world ' +
  'something someone anyone anything everything everyone nothing nobody somebody everybody finally suddenly secretly truly simply ' +
  'book books novel story stories tale read reading ebook kindle series volume ' +
  // reader chatter that names no kind of book: said of any book, in any thread
  'character characters genre cover covers kind kinds little finished help vibe vibes plot writing writer review reviews favorite favourite good great nice lovely cute fun ' +
  'part point level fact idea ideas reason end ending start lot bit sort type person people stuff mood feel feeling opinion experience sense chapter chapters hard easy big small ' +
  'enjoy loved love hate like liked recommend recommended recommendation suggestion question questions answer answers thread post comment comments sub reddit ' +
  'without already'
).split(/\s+/));

export const isFiller = (w: string): boolean => FILLER.has(w.toLowerCase()) || FILLER.has(stem(w.toLowerCase())) || /['’]/.test(w);

/** A phrase made of recurring words qualifies only when every word carries meaning and it is at least two words. */
export const looksLikeSearchTerm = (phrase: string): boolean => {
  const words = phrase.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length >= 2 && words.every((w) => w.length >= 3 && !isFiller(w));
};

const tokens = (text: string): string[] => (text.toLowerCase().match(/[\p{L}][\p{L}'’-]*/gu) ?? []).map(stem);
export const asStems = (term: string): string => ` ${tokens(term).join(' ')} `;

/** For each lexicon term, the indexes of the texts that carry it (all its words, in order, plural or not). */
export function lexiconHits(texts: string[]): Map<string, Set<number>> {
  const haystacks = texts.map((t) => ` ${tokens(t).join(' ')} `);
  const out = new Map<string, Set<number>>();
  for (const term of LEXICON) {
    const needle = asStems(term);
    const hit = new Set<number>();
    haystacks.forEach((h, i) => { if (h.includes(needle)) hit.add(i); });
    if (hit.size) out.set(term, hit);
  }
  return out;
}
