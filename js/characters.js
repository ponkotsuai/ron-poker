// The cast. Ten crypto-flavoured characters; you pick one, and the computer players are drawn
// from the rest. Each has a portrait and four expressions (assets/chars/<id>[-joy|-angry|-sad|-fun].webp)
// and a playing style used by the AI (see ai.js):
//   greed      how much it values a bigger hand over a faster one
//   risk       how strongly it avoids dangerous discards once someone has declared riichi
//   keepJoker  how keen it is to hold a joker for the double instead of using it as a safe throw
//   adaptive   reacts twice as hard to its own score
//   ronOnly    never wins on its own draw (tsumo), only off someone's discard
//   minCat     smallest hand it will win with (4 = Straight; see CAT_KEYS in engine.js)
//   neverJoker never throws a joker away by choice
// This file is plain data so the referee server can import it too.

export const CHARACTERS = {
  king: {
    name: { ja: 'ビット王', en: 'King Bit' },
    style: { ja: '古参の大富豪', en: 'Old money' },
    bio: { ja: '2009年から握っている。少々の負けでは動じない。', en: 'Holding since 2009. A small loss won\'t move him.' },
    play: { greed: 1.2, risk: 1.3, keepJoker: 0.5 },
  },
  whale: {
    name: { ja: 'ドン・ホエール', en: 'Don Whale' },
    style: { ja: '大口', en: 'High roller' },
    bio: { ja: '一手で相場を動かす。安い上がりには興味がない。スリーカードでは上がらない。', en: 'Moves the market in one trade. Cheap wins bore him: he never wins with Three of a Kind.' },
    play: { greed: 1.6, risk: 0.45, keepJoker: 0.9, minCat: 4 },
  },
  gorilla: {
    name: { ja: 'ガチホ💎ゴリラ', en: 'Hodl💎Gorilla' },
    style: { ja: 'ダイヤの手', en: 'Diamond hands' },
    bio: { ja: '一度握ったら離さない。「降りる」という言葉を知らない。ジョーカーも絶対に捨てない。', en: 'Never lets go. Has never heard the word "fold", and never throws a joker away.' },
    play: { greed: 1.3, risk: 0.25, keepJoker: 1.0, neverJoker: true },
  },
  shiba: {
    name: { ja: 'シバイーヌ', en: 'Shibainu' },
    style: { ja: 'スピード狂', en: 'Speedster' },
    bio: { ja: 'とにかく早く上がりたい。1点でも上がりは上がり。', en: 'Wins fast. A 1-point win is still a win.' },
    play: { greed: 0.6, risk: 0.8, keepJoker: 0.2 },
  },
  witch: {
    name: { ja: 'エスラ', en: 'Ethra' },
    style: { ja: '計算魔', en: 'Calculator' },
    bio: { ja: 'すべてのカードを数える。危ない札は決して切らない。', en: 'Counts every card. Never throws a dangerous one.' },
    play: { greed: 1.0, risk: 1.5, keepJoker: 0.5 },
  },
  nia: {
    name: { ja: 'ニア', en: 'Nia' },
    style: { ja: 'オールラウンダー', en: 'All-rounder' },
    bio: { ja: 'NEARの看板娘。攻めと守りを状況で切り替える。', en: 'NEAR\'s poster girl. Switches between attack and defence.' },
    play: { greed: 1.0, risk: 1.0, keepJoker: 0.6 },
  },
  frog: {
    name: { ja: 'ペペロン', en: 'Peperon' },
    style: { ja: 'ハッタリ', en: 'Bluffer' },
    bio: { ja: 'いつもニヤニヤ。手が良いのか悪いのか読めない。', en: 'Always smirking. You never know if the hand is good.' },
    play: { greed: 1.4, risk: 0.6, keepJoker: 0.8 },
  },
  bull: {
    name: { ja: 'ブルド', en: 'Bulldo' },
    style: { ja: '超強気', en: 'Bullish' },
    bio: { ja: '上しか見ていない。リーチが来ても押す。', en: 'Only looks up. Pushes even into a riichi.' },
    play: { greed: 1.5, risk: 0.3, keepJoker: 0.7 },
  },
  bear: {
    name: { ja: 'ベアリー', en: 'Beary' },
    style: { ja: '超弱気', en: 'Bearish' },
    bio: { ja: 'どうせ下がると思っている。危なければすぐ降りる。', en: 'Expects the worst. Folds at the first sign of danger.' },
    play: { greed: 0.8, risk: 1.7, keepJoker: 0.3 },
  },
  fox: {
    name: { ja: 'ラギー', en: 'Ruggy' },
    style: { ja: 'ラグプル', en: 'Rug puller' },
    bio: { ja: '人から奪うことしか考えていない。ツモでは上がらず、ロンだけを狙う。', en: 'Only thinks about taking from others. Never wins on its own draw: ron or nothing.' },
    play: { greed: 1.0, risk: 1.0, keepJoker: 0.6, adaptive: true, ronOnly: true },
  },
};

export const CHARACTER_IDS = Object.keys(CHARACTERS);

// The referee's three AI players have fixed testnet accounts named after their first designs;
// they appear as these characters.
export const AI_SKIN = { tanuki: 'whale', tsuru: 'bear', kitsune: 'fox' };

export const characterOf = id => CHARACTERS[AI_SKIN[id] || id] ? (AI_SKIN[id] || id) : 'nia';

export const EXPRESSIONS = ['main', 'joy', 'angry', 'sad', 'fun'];

export function portraitUrl(id, expr = 'main') {
  const c = characterOf(id);
  return `assets/chars/${c}${expr === 'main' ? '' : `-${expr}`}.webp`;
}
