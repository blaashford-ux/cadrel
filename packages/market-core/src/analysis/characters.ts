export type Gender = 'female' | 'male' | 'nonbinary' | 'unknown';

const FEMALE_WORDS = /\b(?:she|her|hers|herself|woman|women|girl|heroine|daughter|mother|mom|widow|princess|queen|witch|lady|duchess|baroness|sister|wife)\b/gi;
const MALE_WORDS = /\b(?:he|him|his|himself|man|men|boy|hero|son|father|dad|widower|prince|king|wizard|lord|duke|baron|brother|husband)\b/gi;
const NB_WORDS = /\b(?:they|them|their|theirs|themself|themselves|nonbinary|non-binary|enby)\b/gi;

const countOf = (s: string, re: RegExp) => (s.match(re) ?? []).length;

/** Guess a character's gender from the words around them; "unknown" unless one set of cues clearly leads. */
function genderCues(text: string): Gender {
  const f = countOf(text, FEMALE_WORDS), m = countOf(text, MALE_WORDS), n = countOf(text, NB_WORDS);
  if (n >= 2 && n > f && n > m) return 'nonbinary';
  if (f >= 2 && f >= m * 2) return 'female';
  if (m >= 2 && m >= f * 2) return 'male';
  if (f > m && f >= 1 && m === 0) return 'female';
  if (m > f && m >= 1 && f === 0) return 'male';
  return 'unknown';
}

const DUAL_POV = /\bdual[- ](?:pov|point of view|narrat\w+|perspective)s?\b|\balternating (?:pov|point of view|perspective|narrat\w+)s?\b|\bmultiple (?:pov|point[s]? of view|perspectives)\b|\b(?:both|his and her|her and his) (?:pov|point[s]? of view|perspectives)\b|\btold (?:from|in) (?:both|alternating|dual)\b|\bboth (?:her|his|their) (?:and|&) (?:her|his|their) (?:pov|point of view|perspective)/i;

const MULTI_LI = /\breverse harem\b|\bharem\b|\bwhy choose\b|\bpolyamor\w*\b|\bmenage\b|\bménage\b|\bmultiple (?:love interests|suitors|mates|partners)\b|\b(?:three|four|five|several|many|multiple) (?:men|women|suitors|love interests|mates|lovers|hot|brooding)\b/i;
const TRIANGLE = /\blove triangle\b|\btorn between\b|\bchoose between\b/i;
const ROMANCE = /\b(?:romance|romantic|love interest|enemies[- ]to[- ]lovers|slow[- ]burn|falls? (?:for|in love)|fall(?:s|ing)? in love|fated mates?|mates?|kiss|swoon\w*|crush|heart(?:throb)?|lovers?|sparks? fly|boyfriend|girlfriend|husband|wife|suitor|betrothed|courtship)\b/i;

/** Archetype dictionaries are word cues only: they say how a blurb describes someone, not who they are in the book. */
export const MC_ARCHETYPES: Record<string, RegExp> = {
  'chosen one': /\bchosen one\b|\bdestined\b|\bprophecy\b|\bprophesi[sz]ed\b/i,
  'reluctant hero': /\breluctant\b|\bnever wanted\b|\bunwilling\b|\baccidental(?:ly)?\b|\bunexpected(?:ly)? (?:hero|heir|champion)\b/i,
  'underdog / outcast': /\bunderdog\b|\boutcast\b|\boverlooked\b|\bunderestimated\b|\bmisfit\b|\bnobody\b|\bpowerless\b|\bunwanted\b|\bdiscarded\b|\bbanished\b|\bexiled?\b/i,
  'ordinary person': /\bordinary\b|\bnormal (?:woman|girl|guy|man|person|life)\b|\baverage\b|\bregular (?:woman|girl|guy|man|person)\b/i,
  'cozy shopkeeper / maker': /\b(?:baker|bakery|barista|café|cafe|bookshop|bookstore|shopkeeper|innkeeper|inn\b|tea ?shop|florist|gardener|herbalist|cook|chef|brewer|cottage)\b/i,
  'fresh-start / second chance': /\bstart(?:s|ing)? over\b|\bfresh start\b|\bnew beginning\b|\bleav(?:es|ing) (?:her|his) (?:old|former|city|job|life)\b|\binherit\w*\b|\bdivorc\w+\b|\bburn(?:ed|t)[- ]?out\b|\bwidow\w*\b/i,
  'witch / mage': /\bwitch(?:es)?\b|\bwizards?\b|\bmage\b|\bsorcer\w+\b|\benchantress\b|\bapprentice\b/i,
  'warrior / knight': /\bwarrior\b|\bknight\b|\bsoldier\b|\bmercenary\b|\bassassin\b|\bhunter\b|\bslayer\b|\bcaptain\b|\bgeneral\b/i,
  'rogue / thief': /\bthief\b|\brogue\b|\bcon (?:artist|woman|man)\b|\bsmuggler\b|\bpirate\b|\bscoundrel\b|\bheist\b/i,
  'royal / heir': /\bprincess\b|\bprince\b|\bqueen\b|\bking\b|\bheir(?:ess)?\b|\bduchess\b|\bduke\b|\broyal\b|\bnoble(?:woman|man)?\b/i,
  'scholar / bookish': /\bscholar\b|\bacademic\b|\bbookish\b|\bbookworm\b|\blibrarian\b|\bprofessor\b|\bstudent\b|\bresearcher\b|\bscribe\b/i,
  'villain / anti-hero': /\bvillain(?:ess)?\b|\banti-?hero\b|\bdark lord\b|\bovertlord\b|\bevil\b|\bnecromancer\b|\bdemon (?:king|lord)\b|\bmorally gr[ae]y\b/i,
  'grumpy / sarcastic': /\bgrumpy\b|\bsarcas\w+\b|\bcranky\b|\bcurmudgeon\w*\b|\bsnark\w*\b|\bsassy\b|\bsharp[- ]tongued\b|\bcynical\b/i,
  'chaotic / bumbling': /\bclumsy\b|\bbumbling\b|\bchaotic\b|\bdisaster\b|\bmess\b|\bhopeless\b|\bawkward\b|\bscatterbrain\w*\b/i,
  'gamer / system user': /\bgamer\b|\blit ?rpg\b|\bsystem\b|\bplayer\b|\blevel(?:s|ing)? up\b|\bclass\b/i,
};

export const LI_ARCHETYPES: Record<string, RegExp> = {
  'grumpy / brooding': /\bgrumpy\b|\bbrood\w*\b|\bsurly\b|\bstoic\b|\bcold\b|\bscowl\w*\b|\bgruff\b|\bbrusque\b|\bcurmudgeon\w*\b/i,
  'alpha / dominant': /\balpha\b|\bdominant\b|\bpossessive\b|\boverprotective\b|\bcommanding\b|\bruthless\b|\bpowerful\b|\bbillionaire\b|\bmafia\b|\bboss\b|\bCEO\b/i,
  'rogue / bad boy': /\brogue\b|\bbad boy\b|\bcharming\b|\bscoundrel\b|\bflirt\w*\b|\broguish\b|\bsmuggler\b|\bpirate\b|\bthief\b|\bcharmer\b/i,
  'sweet / cinnamon roll': /\bsweet\b|\bkind\b|\bgentle\b|\bcinnamon roll\b|\bsoft[- ]hearted\b|\bsunshine\b|\bsupportive\b|\bswoon\w*\b|\bdevoted\b|\bwholesome\b/i,
  'villain / dark lord': /\bvillain\w*\b|\bdark lord\b|\bovertlord\b|\bdemon (?:king|lord|prince)\b|\bnecromancer\b|\bwarlord\b|\bevil\b|\bantagonist\b/i,
  'monster / non-human': /\bvampire\b|\bshifter\b|\bwere(?:wolf|bear)\b|\bdragon\b|\bfae\b|\bfaerie\b|\belf\b|\borc\b|\bdemon\b|\bgargoyle\b|\bmonster\b|\bminotaur\b|\bmerman\b|\bghost\b/i,
  'royal / noble': /\bprince\b|\bking\b|\bduke\b|\blord\b|\bearl\b|\bheir\b|\broyal\b|\bnoble\b|\bsovereign\b/i,
  'warrior / protector': /\bknight\b|\bwarrior\b|\bguard\b|\bbodyguard\b|\bprotector\b|\bsoldier\b|\bcaptain\b|\bmercenary\b|\bcommander\b|\bgeneral\b/i,
  'rival / enemy': /\brival\b|\benem(?:y|ies)\b|\bnemesis\b|\badversary\b|\benemies[- ]to[- ]lovers\b|\bsworn\b/i,
  'friend / childhood': /\bbest friend\b|\bfriends?[- ]to[- ]lovers\b|\bchildhood\b|\bold flame\b|\bfirst love\b|\bex\b|\bformer (?:lover|flame|fiancé|fiance)\b/i,
  'scholar / healer': /\bhealer\b|\bdoctor\b|\bscholar\b|\bprofessor\b|\blibrarian\b|\bapothecary\b|\bartist\b|\bbaker\b|\bcarpenter\b/i,
};

/** Relationship and character tropes worth naming; the general genre tropes live in TROPES. */
export const CHARACTER_TROPES: Record<string, RegExp> = {
  'enemies to lovers': /\benemies[- ]to[- ]lovers\b/i,
  'friends to lovers': /\bfriends[- ]to[- ]lovers\b|\bbest friend'?s? (?:brother|sister)\b/i,
  'slow burn': /\bslow[- ]burn\b/i,
  'grumpy / sunshine': /\bgrumpy\b.*\bsunshine\b|\bsunshine\b.*\bgrumpy\b|\bgrumpy[- ]sunshine\b/i,
  'fake relationship': /\bfake (?:dating|relationship|marriage|engagement|boyfriend|girlfriend|husband|wife)\b|\bmarriage of convenience\b|\bpretend(?:s|ing)? (?:to be|to date)\b/i,
  'forced proximity': /\bforced proximity\b|\bstuck (?:together|with)\b|\broommates?\b|\bshare[sd]? (?:a|the) (?:room|bed|cottage|house)\b|\bone bed\b/i,
  'second chance': /\bsecond[- ]chance\b|\bold flame\b|\bformer lover\b|\bex-?(?:husband|wife|boyfriend|girlfriend|fiancé|fiance)\b|\breunit\w+\b/i,
  'love triangle': /\blove triangle\b|\btorn between\b/i,
  // Female-lead romance with several love interests. Plain "harem" is a different market (a male lead with many women: harem fantasy, LitRPG), so it is its own trope.
  'reverse harem / why choose': /\breverse harem\b|\bwhy choose\b|\bwhy-choose\b/i,
  harem: /(?<!reverse )\bharem\b/i,
  'fated mates': /\bfated mates?\b|\bmate bond\b|\btrue mate\b/i,
  'forbidden love': /\bforbidden (?:love|romance|attraction)\b|\boff[- ]limits\b|\bshouldn'?t (?:want|love)\b/i,
  'only one bed': /\bonly one bed\b|\bshare a bed\b/i,
  'found family': /\bfound family\b/i,
  'chosen one': /\bchosen one\b/i,
  'reluctant hero': /\breluctant (?:hero|heroine|champion|leader)\b/i,
  'villain POV': /\bvillain(?:ess)?\b.*\b(?:pov|point of view|perspective)\b|\bdark lord\b|\bovertlord\b/i,
  'secret identity': /\bsecret identity\b|\bin disguise\b|\bdisguis\w+\b|\bpretend(?:s|ing)? to be\b/i,
  'age gap': /\bage[- ]gap\b|\bolder man\b|\bolder woman\b|\bolder brother'?s?\b/i,
  'closed door / sweet': /\bclosed[- ]door\b|\bsweet romance\b|\bclean romance\b|\bno spice\b/i,
  'spicy / steamy': /\bsteamy\b|\bspicy\b|\bopen[- ]door\b|\bsmut\w*\b/i,
};

export interface CharacterProfile {
  /** True when the blurb or the text was long enough to read anything from; otherwise every field is empty. */
  readable: boolean;
  /** What was read: the blurb, and the book's sample or uploaded text when there is one. */
  basis: { blurb: boolean; text: boolean };
  mainCharacter: { gender: Gender; archetypes: string[] };
  loveInterests: {
    /** 0 = no romance cues, 1 = one, 2 = a triangle, 3 = several (harem / why choose). */
    count: 0 | 1 | 2 | 3;
    romance: boolean;
    genders: Gender[];
    archetypes: string[];
  };
  /** True only when the blurb says so; false means "not stated", not "single POV". */
  dualPov: boolean;
  tropes: string[];
}

const MIN_WORDS = 15;
const MIN_TEXT_WORDS = 300;
/** The story text is read from its start only: a whole manuscript would swamp the first chapters that introduce the leads. */
export const TEXT_READ_CHARS = 60000;

export interface StoryText {
  body: string;
  /** Chapter titles in order; used to spot alternating point-of-view headings. */
  chapterTitles?: string[];
}

/** Chapters headed by a name ("Mara", "Chapter 3: Cole") that alternate between at least two names: dual POV. */
function alternatingPov(titles: string[]): boolean {
  const names = titles.map((t) => /^(?:(?:chapter|ch\.?)\s*\w+\s*[:.\-–—]?\s*)?(\p{Lu}[\p{L}'’-]{1,15})$/iu.exec(t.trim())?.[1]).filter((n): n is string => !!n && !/^(?:prologue|epilogue|chapter|part|one|two|three|four|five|six|seven|eight|nine|ten|interlude|acknowledg\w*|contents|copyright|dedication|preface|introduction|afterword|map)$/i.test(n));
  const tally = new Map<string, number>();
  for (const n of names) tally.set(n.toLowerCase(), (tally.get(n.toLowerCase()) ?? 0) + 1);
  const repeated = [...tally.values()].filter((v) => v >= 2);
  return repeated.length >= 2 && names.length >= 4;
}

/**
 * Reads a blurb for its characters. Everything is inferred from words (pronoun counts, archetype and trope phrases), so it
 * describes how the book is sold, not what is in it, and an unstated trait is "unknown", not "absent".
 */
export function characterOf(title: string | null, blurb: string | null, story?: StoryText | null): CharacterProfile {
  const b = (blurb ?? '').trim();
  const text = `${title ?? ''}\n${b}`;
  const words = (b.match(/[\p{L}\p{N}'’-]+/gu) ?? []).length;
  const body = (story?.body ?? '').slice(0, TEXT_READ_CHARS);
  const textWords = (body.match(/[\p{L}\p{N}'’-]+/gu) ?? []).length;
  const hasText = textWords >= MIN_TEXT_WORDS;
  const hasBlurb = words >= MIN_WORDS;
  const empty: CharacterProfile = { readable: false, basis: { blurb: hasBlurb, text: hasText }, mainCharacter: { gender: 'unknown', archetypes: [] }, loveInterests: { count: 0, romance: false, genders: [], archetypes: [] }, dualPov: false, tropes: [] };
  if (!hasBlurb && !hasText) return empty;

  // The first paragraph almost always introduces the protagonist; the rest of the blurb is where the love interest appears.
  const paras = b.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const sentences = b.split(/(?<=[.!?…])["'”’)]*\s+/).filter(Boolean);
  const lead = sentences.slice(0, 3).join(' ');
  const blurbGender = hasBlurb ? (genderCues(lead) !== 'unknown' ? genderCues(lead) : genderCues(paras[0] ?? b)) : 'unknown';
  // Narration only: words inside quotation marks are other people's speech, and "he said" would drown the lead's own pronouns.
  const narration = body.replace(/“[^”]*”|"[^"\n]*"/g, ' ');
  const textGender = hasText ? genderCues(narration) : 'unknown';
  // The book's own text outranks how it is sold, but only when its pronouns clearly lead.
  const mcGender = textGender !== 'unknown' ? textGender : blurbGender;

  const globalCount = (src: string, re: RegExp) => countOf(src, new RegExp(re.source, 'gi'));
  const multi = MULTI_LI.test(text);
  const triangle = TRIANGLE.test(text);
  const textRomance = hasText && globalCount(narration, ROMANCE) >= 3;
  const romance = ROMANCE.test(text) || multi || triangle || /\blove interest\b/i.test(text) || textRomance;
  const count: 0 | 1 | 2 | 3 = multi ? 3 : triangle ? 2 : romance ? 1 : 0;

  // A love interest's gender is whichever other gender appears alongside the lead's; with a same-gender lead pairing it
  // cannot be told from pronouns, so those books stay unknown unless the words say so.
  const gSrc = hasText ? narration : b;
  const f = countOf(gSrc, FEMALE_WORDS), m = countOf(gSrc, MALE_WORDS);
  const genders: Gender[] = [];
  if (romance) {
    if (mcGender === 'female') genders.push(m > 0 ? 'male' : 'unknown');
    else if (mcGender === 'male') genders.push(f > 0 ? 'female' : 'unknown');
    else genders.push('unknown');
    if (/\bwomen\b|\bgirlfriend\b|\bher (?:wife|girlfriend|lover)\b|\bsapphic\b|\bwlw\b|\blesbian\b|\bf\/f\b/i.test(text) && mcGender === 'female') genders.push('female');
    if (/\bhis (?:husband|boyfriend|lover)\b|\bgay\b|\bmlm\b|\bm\/m\b/i.test(text) && mcGender === 'male') genders.push('male');
    if (multi && m > 0 && f > 0 && mcGender === 'female' && !genders.includes('male')) genders.push('male');
  }

  // In the story text a descriptor must recur before it counts: one "cold" or "kind" says nothing about a person.
  const TEXT_HITS = 3;
  const arch = (dict: Record<string, RegExp>, blurbPart: string, textPart: string) =>
    Object.entries(dict).filter(([, re]) => (blurbPart && re.test(blurbPart)) || (textPart && globalCount(textPart, re) >= TEXT_HITS)).map(([k]) => k);
  const bodyLead = narration.slice(0, 8000);
  return {
    readable: true,
    basis: { blurb: hasBlurb, text: hasText },
    mainCharacter: { gender: mcGender, archetypes: arch(MC_ARCHETYPES, hasBlurb ? lead || b : '', bodyLead) },
    loveInterests: {
      count,
      romance,
      genders: [...new Set(genders)],
      // Everything after the lead sentences is where the blurb describes the other half of the pairing.
      archetypes: romance ? arch(LI_ARCHETYPES, hasBlurb ? sentences.slice(1).join(' ') || b : '', narration) : [],
    },
    dualPov: DUAL_POV.test(text) || (!!story?.chapterTitles && alternatingPov(story.chapterTitles)),
    tropes: Object.entries(CHARACTER_TROPES).filter(([, re]) => re.test(text) || (hasText && re.test(body))).map(([k]) => k),
  };
}
