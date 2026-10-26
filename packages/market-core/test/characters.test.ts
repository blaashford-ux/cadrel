import { describe, expect, it } from 'vitest';
import { characterOf } from '../src/index.js';

const BLURB = `Mara never wanted to be the chosen one. A grumpy baker with a talent for burning bread, she inherits a failing cottage bakery and her sharp tongue gets her into trouble. Then the brooding dragon shifter next door, who she is sure is her enemy, steals her sourdough starter. Enemies to lovers, slow burn, dual POV, closed door.`;

describe('characterOf', () => {
  it('reads gender, archetypes, dual POV and tropes from a blurb', () => {
    const p = characterOf('The Dragon Next Door', BLURB);
    expect(p.readable).toBe(true);
    expect(p.mainCharacter.gender).toBe('female');
    expect(p.mainCharacter.archetypes).toEqual(expect.arrayContaining(['chosen one', 'cozy shopkeeper / maker']));
    expect(p.loveInterests.count).toBe(1);
    expect(p.loveInterests.archetypes).toEqual(expect.arrayContaining(['grumpy / brooding', 'monster / non-human']));
    expect(p.dualPov).toBe(true);
    expect(p.tropes).toEqual(expect.arrayContaining(['enemies to lovers', 'slow burn', 'closed door / sweet']));
  });
  it('detects several love interests and a male lead', () => {
    const p = characterOf('x', 'He is a disgraced knight who lost everything, and now he must guard a princess from the kingdom he betrayed, while he fights his own past and the king he once served in a war nobody wins. Reverse harem, why choose.');
    expect(p.mainCharacter.gender).toBe('male');
    expect(p.loveInterests.count).toBe(3);
  });
  it('keeps harem (a male lead with many women) apart from reverse harem / why choose (women\'s romance)', () => {
    const long = ' She has to survive a long winter in the mountain village with nothing but her wits and a stubborn goat, and the neighbours are no help at all.';
    expect(characterOf('x', `A harem fantasy where one man collects a following.${long}`).tropes).toEqual(expect.arrayContaining(['harem']));
    expect(characterOf('x', `A harem fantasy where one man collects a following.${long}`).tropes).not.toContain('reverse harem / why choose');
    expect(characterOf('x', `A reverse harem romance, why choose.${long}`).tropes).toEqual(expect.arrayContaining(['reverse harem / why choose']));
    expect(characterOf('x', `A reverse harem romance, why choose.${long}`).tropes).not.toContain('harem');
  });
  it('says nothing about a blurb too short to read', () => {
    const p = characterOf('Title', 'A short line.');
    expect(p.readable).toBe(false);
    expect(p.mainCharacter.gender).toBe('unknown');
  });
});

describe('characterOf with story text', () => {
  const para = 'She walked to the bakery and she opened the shelves while her hands shook, and she hummed to herself. She thought her day would be quiet. He watched her from the door, and he smiled. ';
  const story = { body: para.repeat(30) + 'She kissed him. He kissed her. The lovers shared a kiss, then another kiss. Her crush was no secret to her lover.', chapterTitles: ['Mara', 'Cole', 'Mara', 'Cole'] };
  it('reads a book with no blurb from its text, and notes the basis', () => {
    const p = characterOf('T', null, story);
    expect(p.readable).toBe(true);
    expect(p.basis).toEqual({ blurb: false, text: true });
    expect(p.mainCharacter.gender).toBe('female');
    expect(p.loveInterests.romance).toBe(true);
    expect(p.dualPov).toBe(true);
  });
  it('ignores a text too short to read', () => {
    expect(characterOf('T', null, { body: 'She ran.' }).readable).toBe(false);
  });
});
