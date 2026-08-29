export interface Game {
  id: string;
  name: string;
}

export const GAMES: Game[] = [
  { id: 'whiteout', name: 'Whiteout Survival' },
  { id: 'hok', name: 'Honor of Kings' },
];

export function isValidGame(id: string): boolean {
  return GAMES.some((game) => game.id === id);
}
