import { describe, expect, it } from 'vitest';
import { entrantOrderedCharacters } from './characters.js';

describe('set character order', () => {
  it('keeps entrant order when replay ports switch', () => {
    const ports: [string, string] = ['Fox', 'Falco'];
    expect(entrantOrderedCharacters({ player1Entrant: 'A', player2Entrant: 'B' }, ports))
      .toEqual(['Fox', 'Falco']);
    expect(entrantOrderedCharacters({ player1Entrant: 'B', player2Entrant: 'A' }, ports))
      .toEqual(['Falco', 'Fox']);
  });

  it('rejects a corrupt entrant mapping', () => {
    expect(() => entrantOrderedCharacters({ player1Entrant: 'A', player2Entrant: 'A' }, ['Fox', 'Falco']))
      .toThrow('Invalid entrant mapping');
  });
});
