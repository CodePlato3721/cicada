import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GAMES, isValidGame } from '../../../dist/domain/games.js';

test('GAMES：目前唯一支持的游戏是 whiteout（Whiteout Survival）', () => {
  assert.ok(GAMES.some((game) => game.id === 'whiteout' && game.name === 'Whiteout Survival'));
});

test('isValidGame：已登记的 game id 返回 true', () => {
  assert.equal(isValidGame('whiteout'), true);
});

test('isValidGame：未登记的 game id 返回 false', () => {
  assert.equal(isValidGame('some-unregistered-game'), false);
});
