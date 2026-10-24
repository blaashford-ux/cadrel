/** Word lists behind the manuscript analysis. Lowercase, apostrophes straight. */

const list = (s: string): string[] => s.split(/\s+/).filter(Boolean);

export const STOPWORDS = new Set(
  list(`a about above after again against all almost also although always am among an and another any anybody anyone anything are aren't around as at
  away back be because been before being below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each
  either else even ever every everyone everything few for from further get gets getting go goes going gone got had hadn't has hasn't have haven't having he
  he'd he'll he's her here hers herself him himself his how however i i'd i'll i'm i've if in into is isn't it it'd it'll it's its itself just let like
  many may maybe me might mine more most much must mustn't my myself neither never no nobody none nor not nothing now of off oh on once one only onto or
  other others ought our ours ourselves out over own per quite rather really said say says see she she'd she'll she's should shouldn't since so some
  somebody someone something still such than that that's the their theirs them themselves then there there's these they they'd they'll they're they've
  this those though through to too toward towards under until up upon us very want was wasn't we we'd we'll we're we've well were weren't what what's
  when where whether which while who whom whose why will with within without won't would wouldn't yes yet you you'd you'll you're you've your yours
  yourself yourselves`)
);

/** Capitalised words that are not names even in mid-sentence. */
export const NOT_NAMES = new Set(
  list(`i i'm i'll i'd i've monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october
  november december mr mrs ms miss mister madam sir lady lord dr doctor professor prof captain capt major colonel general sergeant lieutenant officer
  king queen prince princess duke duchess baron count earl saint st mt uncle aunt mother father mom dad mama papa grandma grandpa oh yes no okay ok hmm nope yeah yep nah huh ah um uh wow hey
  english french german spanish italian american british chinese japanese russian irish scottish welsh roman greek latin christmas easter`)
);

/** Titles that sit in front of a name; they are not part of it. */
export const TITLES = new Set(
  list(`mr mrs ms miss mister madam sir lady lord dr doctor professor prof captain capt major colonel general sergeant lieutenant officer king queen prince
  princess duke duchess baron count earl saint st uncle aunt father mother brother sister commander admiral judge agent detective inspector`)
);

/** Words ending in -ly that are not adverbs (or are too ordinary to count as the "weak" kind). */
export const NOT_ADVERBS = new Set(
  list(`only family early lonely belly bully fly reply supply apply rely multiply ugly silly holy jelly lily ally assembly anomaly butterfly friendly lovely
  lively deadly elderly orderly costly curly chilly hilly jolly folly rally tally italy july daily likely unlikely wily sly oily burly surly gully
  homely lowly kindly stately worldly manly womanly scholarly timely heavenly cowardly bubbly crumbly sparkly knobbly wobbly prickly spindly shapely
  sisterly brotherly motherly fatherly neighborly neighbourly queenly kingly princely saintly ghostly ghastly goodly godly ungainly unruly unsightly
  imply comply ply flyby overly`)
);

export const SPEECH_VERBS = list(`said says asked asks replied replies answered answers whispered whispers shouted shouts yelled yells called calls cried
  cries muttered mutters murmured murmurs snapped snaps growled growls hissed hisses breathed barked barks demanded demands exclaimed exclaims added adds
  continued continues began suggested suggests offered offers insisted insists declared declares announced announces remarked remarks observed observes
  retorted retorts stammered stammers whimpered sobbed groaned grumbled mumbled snarled drawled purred panted gasped
  scoffed sneered teased warned warns urged promised protested interrupted agreed conceded admitted confessed explained lied yelped squeaked rasped
  bellowed roared thundered boomed ordered commanded pleaded begged prompted wondered mused ventured`);

/** The plain, invisible tags. Everything else in SPEECH_VERBS is a "said-bookism" (when used as a tag). */
export const PLAIN_TAGS = new Set(list('said says asked asks replied replies answered answers added adds'));

/** Verbs that put the reader inside someone's head (head-hopping check). */
export const THOUGHT_VERBS = new Set(
  list(`thought felt knew wondered realized realised wished hoped wanted decided noticed remembered feared worried imagined understood supposed
  believed doubted suspected sensed assumed figured considered reckoned guessed longed dreaded regretted resented`)
);

export interface WordGroup {
  title: string;
  hint: string;
  /** label shown in the report, pattern (regex source on lowercase text with straight apostrophes). */
  items: { label: string; pattern: string }[];
}

const w = (word: string) => ({ label: word, pattern: `\\b${word}\\b` });
const p = (label: string, pattern = label) => ({ label, pattern: `\\b${pattern}\\b` });

export const WORD_GROUPS: WordGroup[] = [
  {
    title: 'Filler and hedge words',
    hint: 'Usually safe to cut; the sentence tends to get stronger.',
    items: [
      w('just'), w('really'), w('very'), w('quite'), w('rather'), w('somewhat'), w('slightly'), w('actually'), w('basically'), w('literally'),
      w('totally'), w('completely'), w('absolutely'), w('simply'), w('almost'), w('nearly'), w('perhaps'), w('somehow'), w('probably'), w('definitely'),
      w('certainly'), w('truly'), w('suddenly'), w('finally'), w('even'), w('still'), w('again'), w('then'),
      p('kind of'), p('sort of'), p('a bit'), p('a little'), p('a lot'), p('all of a sudden')
    ]
  },
  {
    title: 'Filter words',
    hint: 'They put a narrator between the reader and the scene ("she felt the cold" → "the cold bit her").',
    items: [
      w('felt'), p('feel', 'feel(?:s|ing)?'), w('seemed'), p('seem', 'seems?'), w('appeared'), w('saw'), p('see', 'see(?:s|ing)?'), w('noticed'), w('realized'), w('realised'),
      w('watched'), w('heard'), p('hear', 'hear(?:s|ing)?'), w('wondered'), w('thought'), w('knew'), w('decided'), w('wished'), w('hoped'),
      p('began to'), p('started to'), p('tried to'), p('managed to'), p('seemed to'), p('could see'), p('could hear'), p('could feel'),
      p('found himself', 'found (?:himself|herself|themselves|myself)'), p("couldn't help but")
    ]
  },
  {
    title: 'Stock gestures and beats',
    hint: 'Familiar body-language beats; a few are fine, a pile is a tic.',
    items: [
      w('nodded'), w('shrugged'), w('smiled'), w('grinned'), w('frowned'), w('sighed'), w('chuckled'), w('laughed'), w('shivered'), w('winced'), w('smirked'),
      p('shook his head', 'shook (?:his|her|their|my) head'), p('rolled eyes', 'rolled (?:his|her|their|my) eyes'), p('raised an eyebrow', 'rais(?:ed|ing) (?:an|one|his|her) eyebrows?'),
      p('deep breath', '(?:took|taking) a deep breath'), p('let out a breath', '(?:let|letting) out a (?:long |slow |deep )?breath'), p('heart pounded', '(?:heart|pulse) (?:pounded|raced|hammered|thudded|skipped)'),
      p('swallowed hard', 'swallowed (?:hard|thickly)'), p('a beat', 'a beat')
    ]
  }
];

/** Past participles that are not regular -ed words. */
export const IRREGULAR_PARTICIPLES = list(`born broken built bought caught chosen done drawn driven eaten forgotten forgiven found frozen given grown hidden held
  hit hurt kept known laid led left lost made met paid put read ridden said seen sent set shot shown shut slain spoken stolen struck swept taken taught
  thrown told torn understood woken won worn written wrung cut sold bound bitten beaten begun blown bent burnt dealt dug fed felt fought flung hung heard
  sung sunk split stuck stung swung thought trodden woven wound ground spread shaken shaved shorn slept spent spun stood stripped sworn awoken forbidden
  forgot overcome overtaken mistaken withdrawn`);

/** "was tired", "was scared": states rather than actions, so not passive voice. */
export const STATE_PARTICIPLES = new Set(
  list(`tired scared bored excited worried surprised shocked pleased relieved amazed confused annoyed embarrassed ashamed married finished interested
  exhausted terrified frightened disappointed determined satisfied convinced concerned prepared dressed crowded packed covered filled lined closed
  locked located situated supposed used gone fallen drunk lost done stuck pissed stunned startled puzzled delighted thrilled appalled horrified
  disgusted fascinated irritated overwhelmed amused exposed bound twisted crossed folded clenched raised arched curled parted pinned sealed
  tangled soaked drenched dazed lit dead need feed seed speed weed bleed breed indeed hundred sacred naked wicked ragged rugged crooked beloved wretched`)
);

export const ABBREVIATIONS = new Set(
  list('mr mrs ms dr st jr sr mt vs etc prof capt col gen lt sgt cmdr gov sen rep no fig vol ch pp approx dept est inc ltd co e.g i.e')
);
