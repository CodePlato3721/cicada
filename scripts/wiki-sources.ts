export interface WikiSource {
  id: string;
  game: string;
  idPrefix: string;
  listUrl: string;
}

export const SOURCES: WikiSource[] = [
  {
    id: 'heroes',
    game: 'whiteout',
    idPrefix: 'HERO',
    listUrl: 'https://www.whiteoutsurvival.wiki/heroes/',
  },
  {
    id: 'events',
    game: 'whiteout',
    idPrefix: 'EVENT',
    listUrl: 'https://www.whiteoutsurvival.wiki/events/',
  },
  {
    id: 'research',
    game: 'whiteout',
    idPrefix: 'RESEARCH',
    listUrl: 'https://www.whiteoutsurvival.wiki/research/',
  },
  {
    id: 'buildings',
    game: 'whiteout',
    idPrefix: 'BUILDING',
    listUrl: 'https://www.whiteoutsurvival.wiki/buildings/',
  },
  {
    id: 'items',
    game: 'whiteout',
    idPrefix: 'ITEM',
    listUrl: 'https://www.whiteoutsurvival.wiki/items/',
  },
  {
    id: 'pets',
    game: 'whiteout',
    idPrefix: 'PET',
    listUrl: 'https://www.whiteoutsurvival.wiki/pets/',
  },
  {
    id: 'experts',
    game: 'whiteout',
    idPrefix: 'EXPERT',
    listUrl: 'https://www.whiteoutsurvival.wiki/experts/',
  },
  {
    id: 'alliance-tech',
    game: 'whiteout',
    idPrefix: 'ALLYTECH',
    listUrl: 'https://www.whiteoutsurvival.wiki/alliance-tech/',
  },
];

export function getSource(id: string): WikiSource {
  const source = SOURCES.find((s) => s.id === id);
  if (!source) {
    throw new Error(`Unknown scrape category "${id}", options: ${SOURCES.map((s) => s.id).join(', ')}`);
  }
  return source;
}
