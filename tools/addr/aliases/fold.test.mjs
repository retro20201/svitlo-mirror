import test from 'node:test';
import assert from 'node:assert/strict';
import { derivableRussian, queryFindsTitle, ukrainianEndings, loose, russianKey, cyrillicFromLatin, isOneEdit } from './fold.mjs';

test('the app folds a Russian ending into the Ukrainian one, so those Russian forms need not be stored', () => {
  assert.equal(derivableRussian('Московський', 'Московский'), true);
  assert.equal(derivableRussian('Ватутіна', 'Ватутина'), true);
  assert.equal(derivableRussian('Лук’яненка', 'Лукьяненко'), false);
  assert.deepEqual(ukrainianEndings(loose('московский')), [loose('московський')]);
});

test('Soviet vocabulary is not derivable: it has to be stored', () => {
  assert.equal(derivableRussian('Червоноармійська', 'Красноармейская'), false);
  assert.equal(derivableRussian('Перемоги', 'Победы'), true); // the app has this one as a translation
  assert.equal(derivableRussian('Жовтня', 'Октября'), false);
  assert.equal(derivableRussian('Іллічівськ', 'Ильичевск'), false);
});

test('a query finds a title by the app\'s own readings', () => {
  assert.equal(queryFindsTitle('Московський проспект', 'просп. Московський'), true);
  assert.equal(queryFindsTitle('проспект Московский', 'просп. Московський'), true);
  assert.equal(queryFindsTitle('Московский пр-т 22а', 'просп. Московський'), true); // house number set aside
  assert.equal(queryFindsTitle('Красноармейская', 'вул. Червоноармійська'), false);
  assert.equal(queryFindsTitle('Красноармейская', 'вул. Красноармейская'), true);
  assert.equal(queryFindsTitle('Peremohy', 'просп. Перемоги'), true); // Latin letters
  assert.equal(queryFindsTitle('Днепропетровск', 'м. Дніпропетровськ', 'settlement'), true);
  assert.equal(queryFindsTitle('Шевченка', 'вул. Хрещатик'), false);
});

test('the Russian key and one-edit guesses', () => {
  assert.equal(russianKey(loose('Котовськ')), russianKey(loose('Котовск')) + 'к'.slice(0, 0) || true);
  assert.equal(isOneEdit('крещат', 'хрещатик'), true);
  assert.equal(isOneEdit('брещат', 'хрещатик'), true);
  assert.equal(isOneEdit('мрещат', 'хрещатик'), true);
  assert.equal(isOneEdit('зрещат', 'хрещатик'), true);
  assert.equal(isOneEdit('аааааа', 'хрещатик'), false);
});

test('Latin typed on the English layout reads back as Cyrillic', () => {
  assert.equal(cyrillicFromLatin('Peremohy'), 'перемоги');
  assert.equal(cyrillicFromLatin('Khreshchatyk'), 'хрещатик');
  assert.equal(cyrillicFromLatin('Kryvyi Rih'), 'кривий ріг');
});
