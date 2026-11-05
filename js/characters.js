// Playable characters. Each is original art drawn as SVG, inspired by crypto slang.
// The look (svg) and the CPU play style (style) are separate, so a character can be
// re-skinned without touching how it plays.
//
// expr: 'normal' | 'win' | 'lose' | 'think'

const INK = '#1d1a16';

function frame(id, bg, body) {
  return `<svg viewBox="0 0 120 120" class="char char-${id}" role="img" xmlns="http://www.w3.org/2000/svg">
    <defs><clipPath id="clip-${id}"><circle cx="60" cy="60" r="58"/></clipPath></defs>
    <g clip-path="url(#clip-${id})">${bg}${body}</g>
    <circle cx="60" cy="60" r="58" fill="none" stroke="rgba(0,0,0,.35)" stroke-width="3"/>
  </svg>`;
}

// ---- shared face parts ------------------------------------------------------

function dotEyes(lx, rx, y, expr, { r = 4.2, color = INK } = {}) {
  if (expr === 'win') {
    return `<path d="M${lx - 5} ${y + 1} q5 -7 10 0 M${rx - 5} ${y + 1} q5 -7 10 0" stroke="${color}" stroke-width="3" fill="none" stroke-linecap="round"/>`;
  }
  if (expr === 'lose') {
    return `<path d="M${lx - 5} ${y - 4} l10 -4 M${rx + 5} ${y - 4} l-10 -4" stroke="${color}" stroke-width="2.6" stroke-linecap="round"/>
      <ellipse cx="${lx}" cy="${y + 3}" rx="${r * 0.8}" ry="${r}" fill="${color}"/><ellipse cx="${rx}" cy="${y + 3}" rx="${r * 0.8}" ry="${r}" fill="${color}"/>
      <path d="M${rx + 6} ${y + 6} q3 7 0 10 q-3 -3 0 -10z" fill="#7cc4ff"/>`;
  }
  if (expr === 'think') {
    return `<ellipse cx="${lx}" cy="${y}" rx="${r}" ry="${r * 0.5}" fill="${color}"/>
      <ellipse cx="${rx}" cy="${y - 1}" rx="${r}" ry="${r * 1.05}" fill="${color}"/><circle cx="${rx + 1.4}" cy="${y - 2.4}" r="1.3" fill="#fff"/>`;
  }
  return `<ellipse cx="${lx}" cy="${y}" rx="${r}" ry="${r * 1.15}" fill="${color}"/><ellipse cx="${rx}" cy="${y}" rx="${r}" ry="${r * 1.15}" fill="${color}"/>
    <circle cx="${lx + 1.4}" cy="${y - 1.8}" r="1.4" fill="#fff"/><circle cx="${rx + 1.4}" cy="${y - 1.8}" r="1.4" fill="#fff"/>`;
}

function mouth(x, y, expr, { color = INK, w = 7 } = {}) {
  if (expr === 'win') return `<path d="M${x - w} ${y - 1} q${w} ${w * 1.4} ${w * 2} 0 z" fill="#8a2a22" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`;
  if (expr === 'lose') return `<path d="M${x - w * 0.7} ${y + 3} q${w * 0.7} -5 ${w * 1.4} 0" stroke="${color}" stroke-width="2.4" fill="none" stroke-linecap="round"/>`;
  if (expr === 'think') return `<path d="M${x - w * 0.5} ${y + 1} h${w}" stroke="${color}" stroke-width="2.4" stroke-linecap="round"/>`;
  return `<path d="M${x - w * 0.8} ${y} q${w * 0.4} 3 ${w * 0.8} 0 q${w * 0.4} 3 ${w * 0.8} 0" stroke="${color}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;
}

function thinkBubble(x, y) {
  return `<g opacity=".9"><circle cx="${x}" cy="${y}" r="7" fill="#fff"/><circle cx="${x - 8}" cy="${y + 9}" r="3" fill="#fff"/>
    <text x="${x}" y="${y + 3.5}" font-size="10" font-weight="700" text-anchor="middle" fill="${INK}">?</text></g>`;
}

function sparkles(x, y) {
  return `<g fill="#ffe08a"><path d="M${x} ${y - 8} l2 6 6 2 -6 2 -2 6 -2 -6 -6 -2 6 -2z"/><path d="M${x + 14} ${y + 8} l1.2 3.6 3.6 1.2 -3.6 1.2 -1.2 3.6 -1.2 -3.6 -3.6 -1.2 3.6 -1.2z"/></g>`;
}

// ---- characters ----------------------------------------------------------------

function moonRabbit(expr) {
  const bg = `<rect width="120" height="120" fill="#16224a"/>
    <circle cx="92" cy="28" r="20" fill="#ffd96a"/><circle cx="101" cy="22" r="18" fill="#16224a"/>
    <g fill="#fff" opacity=".8"><circle cx="18" cy="22" r="1.4"/><circle cx="30" cy="40" r="1"/><circle cx="106" cy="66" r="1.2"/><circle cx="14" cy="70" r="1"/></g>`;
  const ears = expr === 'lose'
    ? `<path d="M40 52 C20 50 10 34 14 28 C22 30 36 40 46 50z" fill="#fff" stroke="${INK}" stroke-width="2"/><path d="M80 52 C100 50 110 34 106 28 C98 30 84 40 74 50z" fill="#fff" stroke="${INK}" stroke-width="2"/>`
    : `<g stroke="${INK}" stroke-width="2"><path d="M44 50 C36 26 38 6 46 4 C54 6 56 28 54 48z" fill="#fff"/><path d="M66 48 C64 28 68 6 76 6 C84 8 84 28 76 50z" fill="#fff"/></g>
       <path d="M46 44 C42 26 44 14 47 12 C50 16 50 30 50 44z" fill="#f6b2c2"/><path d="M70 44 C70 30 72 16 75 14 C78 18 76 30 74 44z" fill="#f6b2c2"/>`;
  const body = `${ears}
    <path d="M22 120 C24 98 40 92 60 92 C80 92 96 98 98 120z" fill="#e8ecf6" stroke="${INK}" stroke-width="2"/>
    <path d="M44 96 L60 108 L76 96" fill="none" stroke="#c0392b" stroke-width="5" stroke-linecap="round"/>
    <g transform="translate(76 104) rotate(35)"><path d="M0 -8 C4 -4 4 4 2 8 H-2 C-4 4 -4 -4 0 -8z" fill="#f3f3f3" stroke="${INK}" stroke-width="1.4"/><circle cy="-1" r="1.6" fill="#4aa3df"/><path d="M-2 8 l-3 4 M2 8 l3 4" stroke="#ff8a3d" stroke-width="2"/></g>
    <ellipse cx="60" cy="70" rx="29" ry="25" fill="#fff" stroke="${INK}" stroke-width="2"/>
    <ellipse cx="43" cy="79" rx="5" ry="3" fill="#f6b2c2" opacity=".85"/><ellipse cx="77" cy="79" rx="5" ry="3" fill="#f6b2c2" opacity=".85"/>
    ${dotEyes(50, 70, 68, expr)}
    <path d="M57 76 q3 3 6 0" fill="#f19aae"/>
    ${mouth(60, 82, expr, { w: 5 })}
    ${expr === 'win' ? sparkles(24, 64) : ''}${expr === 'think' ? thinkBubble(96, 54) : ''}`;
  return frame('moon', bg, body);
}

function degenShiba(expr) {
  const lasers = expr === 'normal' || expr === 'win';
  const bg = `<rect width="120" height="120" fill="#2b0e10"/>
    <circle cx="60" cy="60" r="52" fill="#4a1517"/>`;
  const beam = lasers ? `<g opacity=".95"><path d="M50 66 L-10 ${expr === 'win' ? 40 : 58} L-10 ${expr === 'win' ? 50 : 70} z" fill="#ff2a2a"/><path d="M70 66 L130 ${expr === 'win' ? 40 : 58} L130 ${expr === 'win' ? 50 : 70} z" fill="#ff2a2a"/>
      <path d="M50 66 L-10 ${expr === 'win' ? 44 : 62} L-10 ${expr === 'win' ? 46 : 66}z M70 66 L130 ${expr === 'win' ? 44 : 62} L130 ${expr === 'win' ? 46 : 66}z" fill="#fff"/></g>` : '';
  const eyes = lasers
    ? `<circle cx="50" cy="66" r="6" fill="#ff2a2a"/><circle cx="70" cy="66" r="6" fill="#ff2a2a"/><circle cx="50" cy="66" r="2.6" fill="#fff"/><circle cx="70" cy="66" r="2.6" fill="#fff"/>`
    : dotEyes(50, 70, 66, expr, { r: 3.6 });
  const body = `
    <path d="M18 120 C22 98 38 92 60 92 C82 92 98 98 102 120z" fill="#d97a32" stroke="${INK}" stroke-width="2"/>
    <path d="M44 96 C50 108 70 108 76 96 C70 112 50 112 44 96z" fill="#f7e7cf"/>
    <path d="M30 52 L34 22 L50 40z" fill="#d97a32" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/><path d="M34 30 L36 26 L44 38z" fill="#f7e7cf"/>
    <path d="M90 52 L86 22 L70 40z" fill="#d97a32" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/><path d="M86 30 L84 26 L76 38z" fill="#f7e7cf"/>
    <path d="M28 66 C28 44 42 36 60 36 C78 36 92 44 92 66 C92 86 78 96 60 96 C42 96 28 86 28 66z" fill="#d97a32" stroke="${INK}" stroke-width="2"/>
    <path d="M38 78 C40 66 50 62 60 70 C70 62 80 66 82 78 C80 92 70 96 60 96 C50 96 40 92 38 78z" fill="#f7e7cf"/>
    <path d="M44 58 q6 -4 10 0 M66 58 q6 -4 10 0" stroke="#f7e7cf" stroke-width="3" stroke-linecap="round" fill="none"/>
    <path d="M30 48 Q60 40 90 48 L90 54 Q60 46 30 54z" fill="#f4f1ea" stroke="${INK}" stroke-width="1.5"/>
    <circle cx="88" cy="51" r="3" fill="#c0392b"/><path d="M90 52 l8 6 M90 52 l9 0" stroke="#f4f1ea" stroke-width="3" stroke-linecap="round"/>
    ${beam}${eyes}
    <ellipse cx="60" cy="78" rx="5" ry="3.6" fill="${INK}"/>
    ${expr === 'win' ? `<path d="M50 84 q10 12 20 0 z" fill="#8a2a22" stroke="${INK}" stroke-width="2"/>` : mouth(60, 86, expr === 'normal' ? 'normal' : expr, { w: 6 })}
    ${expr === 'lose' ? `<path d="M80 58 q4 8 0 12 q-4 -4 0 -12z" fill="#7cc4ff"/>` : ''}${expr === 'think' ? thinkBubble(98, 30) : ''}`;
  return frame('shiba', bg, body);
}

function paperCrane(expr) {
  const crumple = expr === 'lose';
  const bg = `<rect width="120" height="120" fill="#efe5cf"/>
    <g stroke="#d9cba9" stroke-width="1"><path d="M0 30 L120 10 M0 70 L120 50 M0 110 L120 90"/><path d="M20 0 L40 120 M70 0 L90 120"/></g>`;
  const dash = crumple ? ' stroke-dasharray="4 2"' : '';
  // a folded crane: wings up on both sides, neck rising to the left, tail to the right
  const wingL = expr === 'lose' ? 'M60 74 L10 96 L38 70z' : 'M60 74 L14 22 L44 66z';
  const wingR = expr === 'lose' ? 'M60 74 L110 96 L82 70z' : 'M60 74 L106 22 L76 66z';
  const body = `
    <g stroke="${INK}" stroke-width="2" stroke-linejoin="round"${dash}>
      <path d="${wingL}" fill="#f7f4ec"/><path d="M60 74 ${expr === 'lose' ? 'L38 70 L30 82z' : 'L44 66 L30 46z'}" fill="#e4dccb"/>
      <path d="${wingR}" fill="#ece6d8"/><path d="M60 74 ${expr === 'lose' ? 'L82 70 L90 82z' : 'L76 66 L90 46z'}" fill="#d8d0bd"/>
      <path d="M44 72 L28 38 L22 30 L34 34 L54 70z" fill="#f7f4ec"/>
      <path d="M76 72 L98 44 L104 40 L100 50 L70 76z" fill="#e4dccb"/>
      <path d="M60 58 L84 80 L60 112 L36 80z" fill="#fbf9f3"/>
      <path d="M60 58 L60 112 L84 80z" fill="#ece6d8"/>
    </g>
    <circle cx="24" cy="31" r="3.2" fill="#c0392b"/>
    ${crumple ? `<path d="M44 84 l6 4 -4 4 M74 82 l-5 5 5 3" stroke="#b9ad92" stroke-width="1.4" fill="none"/>` : ''}
    ${dotEyes(53, 67, 80, expr, { r: 2.8 })}
    ${expr === 'win' ? `<path d="M55 90 q5 5 10 0" stroke="${INK}" stroke-width="2" fill="none" stroke-linecap="round"/>`
      : expr === 'lose' ? `<path d="M55 93 q5 -4 10 0" stroke="${INK}" stroke-width="2" fill="none" stroke-linecap="round"/>`
      : `<path d="M56 91 h8" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>`}
    <ellipse cx="47" cy="88" rx="3.6" ry="2.2" fill="#f6b2c2" opacity=".8"/><ellipse cx="73" cy="88" rx="3.6" ry="2.2" fill="#f6b2c2" opacity=".8"/>
    ${expr === 'think' ? `<path d="M80 68 q4 6 0 9 q-4 -3 0 -9z" fill="#7cc4ff"/>${thinkBubble(98, 72)}` : ''}${expr === 'win' ? sparkles(96, 92) : ''}`;
  return frame('crane', bg, body);
}

function stableCat(expr) {
  const pawUp = expr !== 'lose';
  const bg = `<rect width="120" height="120" fill="#7a1e22"/>
    <g fill="#e0b04a" opacity=".25"><circle cx="16" cy="18" r="7"/><circle cx="104" cy="96" r="9"/><circle cx="100" cy="20" r="5"/><circle cx="14" cy="96" r="6"/></g>`;
  const closed = expr === 'normal';
  const eyes = closed
    ? `<path d="M44 66 q6 5 12 0 M64 66 q6 5 12 0" stroke="${INK}" stroke-width="3" fill="none" stroke-linecap="round"/>`
    : dotEyes(50, 70, 66, expr, { r: 3.6 });
  const body = `
    <path d="M20 120 C22 98 38 92 60 92 C82 92 98 98 100 120z" fill="#fbf8f1" stroke="${INK}" stroke-width="2"/>
    ${pawUp
      ? `<path d="M84 104 C86 88 90 70 98 62 C104 60 108 66 104 74 C100 82 96 96 96 108z" fill="#fbf8f1" stroke="${INK}" stroke-width="2"/><path d="M98 62 c2 -4 8 -2 6 4" fill="none" stroke="${INK}" stroke-width="1.6"/><circle cx="100" cy="68" r="2" fill="#f6b2c2"/>`
      : `<path d="M86 108 C88 100 92 96 98 98 C102 102 98 110 94 112z" fill="#fbf8f1" stroke="${INK}" stroke-width="2"/>`}
    <path d="M32 50 L34 26 L52 40z" fill="#fbf8f1" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/><path d="M36 34 L37 30 L46 40z" fill="#f6b2c2"/>
    <path d="M88 50 L86 26 L68 40z" fill="#fbf8f1" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/><path d="M84 34 L83 30 L74 40z" fill="#f6b2c2"/>
    <ellipse cx="60" cy="66" rx="31" ry="27" fill="#fbf8f1" stroke="${INK}" stroke-width="2"/>
    <path d="M70 42 q6 -2 10 4 q-6 2 -10 -4z" fill="#e8933a"/><path d="M38 48 q4 -5 9 -3 q-4 4 -9 3z" fill="${INK}"/>
    ${eyes}
    <path d="M57 74 l3 3 3 -3z" fill="#f19aae"/>
    ${mouth(60, 80, expr, { w: 5 })}
    <path d="M30 74 h-12 M30 78 h-11 M90 74 h12 M90 78 h11" stroke="${INK}" stroke-width="1.2"/>
    <path d="M34 92 Q60 100 86 92 L86 98 Q60 106 34 98z" fill="#c0392b" stroke="${INK}" stroke-width="1.5"/>
    <circle cx="60" cy="104" r="8" fill="#e0b04a" stroke="${INK}" stroke-width="1.6"/>
    <text x="60" y="108" font-size="10" font-weight="800" text-anchor="middle" fill="${INK}" font-family="ui-monospace, monospace">1</text>
    ${expr === 'win' ? sparkles(20, 60) : ''}${expr === 'think' ? thinkBubble(22, 36) : ''}`;
  return frame('cat', bg, body);
}

function rugTanuki(expr) {
  const bg = `<rect width="120" height="120" fill="#22371f"/>
    <circle cx="60" cy="56" r="46" fill="#2e4a2a"/>`;
  const shifty = expr === 'think';
  const eyes = shifty
    ? `<ellipse cx="47" cy="64" rx="4" ry="2.6" fill="#fff"/><ellipse cx="73" cy="64" rx="4" ry="2.6" fill="#fff"/><circle cx="49.5" cy="64" r="2" fill="${INK}"/><circle cx="75.5" cy="64" r="2" fill="${INK}"/>`
    : dotEyes(48, 72, 64, expr, { r: 3.4, color: '#fff7e6' });
  const body = `
    <path d="M18 120 C22 98 38 92 60 92 C82 92 98 98 102 120z" fill="#8a6440" stroke="${INK}" stroke-width="2"/>
    <g transform="rotate(-24 60 104)"><rect x="12" y="96" width="96" height="16" rx="8" fill="#b83a2e" stroke="${INK}" stroke-width="2"/>
      <path d="M24 96 v16 M40 96 v16 M56 96 v16 M72 96 v16 M88 96 v16" stroke="#e0b04a" stroke-width="3"/>
      <ellipse cx="108" cy="104" rx="5" ry="8" fill="#7a2018" stroke="${INK}" stroke-width="2"/></g>
    <circle cx="36" cy="40" r="10" fill="#8a6440" stroke="${INK}" stroke-width="2"/><circle cx="36" cy="40" r="5" fill="#4a3424"/>
    <circle cx="84" cy="40" r="10" fill="#8a6440" stroke="${INK}" stroke-width="2"/><circle cx="84" cy="40" r="5" fill="#4a3424"/>
    <ellipse cx="60" cy="66" rx="31" ry="27" fill="#8a6440" stroke="${INK}" stroke-width="2"/>
    <path d="M34 66 C34 56 44 54 52 60 C54 66 50 72 42 72 C38 72 34 70 34 66z M86 66 C86 56 76 54 68 60 C66 66 70 72 78 72 C82 72 86 70 86 66z" fill="#3b2a1e"/>
    <path d="M48 76 C50 70 70 70 72 76 C72 88 48 88 48 76z" fill="#efe1c8"/>
    ${eyes}
    <ellipse cx="60" cy="76" rx="4" ry="3" fill="${INK}"/>
    ${expr === 'normal' ? `<path d="M54 82 q6 4 12 -2" stroke="${INK}" stroke-width="2.2" fill="none" stroke-linecap="round"/>` : mouth(60, 83, expr, { w: 5 })}
    <path d="M58 30 C66 20 80 22 82 30 C76 34 66 36 58 30z" fill="#5fae4e" stroke="${INK}" stroke-width="1.6"/><path d="M60 30 Q70 28 80 28" stroke="${INK}" stroke-width="1" fill="none"/>
    ${expr === 'lose' ? `<path d="M88 52 q4 8 0 12 q-4 -4 0 -12z M30 52 q4 8 0 12 q-4 -4 0 -12z" fill="#7cc4ff"/>` : ''}
    ${expr === 'win' ? `<circle cx="96" cy="70" r="8" fill="#e0b04a" stroke="${INK}" stroke-width="1.6"/>${sparkles(20, 70)}` : ''}`;
  return frame('tanuki', bg, body);
}

function inariFox(expr) {
  const bg = `<rect width="120" height="120" fill="#a8322a"/>
    <g fill="#7d1f19"><rect x="8" y="22" width="104" height="8"/><rect x="2" y="16" width="116" height="6" rx="2"/><rect x="22" y="22" width="8" height="98"/><rect x="90" y="22" width="8" height="98"/><rect x="14" y="40" width="92" height="5"/></g>`;
  const eyes = expr === 'think'
    ? `<path d="M44 66 q6 3 12 0 M64 66 q6 3 12 0" stroke="${INK}" stroke-width="2.6" fill="none" stroke-linecap="round"/>`
    : expr === 'normal'
      ? `<path d="M44 66 q6 -5 12 0 q-6 3 -12 0z M64 66 q6 -5 12 0 q-6 3 -12 0z" fill="${INK}"/>`
      : dotEyes(50, 70, 66, expr, { r: 3.4 });
  const body = `
    <path d="M18 120 C22 98 38 92 60 92 C82 92 98 98 102 120z" fill="#fbf8f1" stroke="${INK}" stroke-width="2"/>
    <path d="M40 96 Q60 110 80 96" stroke="#c0392b" stroke-width="5" fill="none"/><circle cx="60" cy="106" r="5" fill="#e0b04a" stroke="${INK}" stroke-width="1.5"/>
    <path d="M30 56 L30 18 L52 40z" fill="#fbf8f1" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/><path d="M33 26 L34 22 L46 38z" fill="#c0392b"/>
    <path d="M90 56 L90 18 L68 40z" fill="#fbf8f1" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/><path d="M87 26 L86 22 L74 38z" fill="#c0392b"/>
    <path d="M28 60 C30 44 44 38 60 38 C76 38 90 44 92 60 C92 70 74 88 60 92 C46 88 28 70 28 60z" fill="#fbf8f1" stroke="${INK}" stroke-width="2"/>
    <path d="M40 58 q8 -10 16 2 M80 58 q-8 -10 -16 2" stroke="#c0392b" stroke-width="3" fill="none" stroke-linecap="round"/>
    <path d="M56 46 q4 -6 8 0 q-4 4 -8 0z" fill="#c0392b"/>
    ${eyes}
    <ellipse cx="60" cy="82" rx="3.6" ry="2.6" fill="${INK}"/>
    ${expr === 'normal' ? `<path d="M55 86 q5 3 10 0" stroke="${INK}" stroke-width="2" fill="none" stroke-linecap="round"/>` : mouth(60, 87, expr, { w: 4 })}
    ${expr === 'win' ? sparkles(20, 66) : ''}${expr === 'think' ? thinkBubble(100, 56) : ''}`;
  return frame('fox', bg, body);
}

function kurokoReferee(expr) {
  const bg = `<rect width="120" height="120" fill="#141210"/><circle cx="60" cy="60" r="50" fill="#1f1c19"/>`;
  const body = `
    <path d="M16 120 C20 96 38 88 60 88 C82 88 100 96 104 120z" fill="#0b0908" stroke="#3a342e" stroke-width="2"/>
    <path d="M30 70 C30 36 44 22 60 22 C76 22 90 36 90 70 L92 96 L28 96z" fill="#0b0908" stroke="#3a342e" stroke-width="2"/>
    <path d="M36 50 L84 50 L86 94 L34 94z" fill="#15120f" stroke="#2c2722" stroke-width="1"/>
    <g stroke="#2c2722" stroke-width="1"><path d="M40 56 v36 M48 56 v36 M56 56 v36 M64 56 v36 M72 56 v36 M80 56 v36"/></g>
    <rect x="49" y="62" width="22" height="22" rx="2" fill="none" stroke="#e0b04a" stroke-width="2"/>
    <text x="60" y="79" font-size="16" text-anchor="middle" fill="#e0b04a" font-family="serif">審</text>
    ${expr === 'win' ? `<path d="M50 104 l6 6 14 -14" stroke="#e0b04a" stroke-width="4" fill="none" stroke-linecap="round"/>` : ''}`;
  return frame('kuroko', bg, body);
}

export const CHARACTERS = {
  moon: {
    id: 'moon', draw: moonRabbit,
    name: { ja: '月うさぎ', en: 'Moon Rabbit' }, motto: { ja: 'To the Moon', en: 'To the Moon' },
    tag: { ja: '強気の上昇志向', en: 'Always bullish' },
    bio: { ja: '安い手では上がらない。目指すは月まで。', en: 'Never settles for a cheap hand. The moon or bust.' },
    style: { greed: 1.6, risk: 0.6, keepJoker: 0.8, minPoints: 2 },
  },
  shiba: {
    id: 'shiba', draw: degenShiba,
    name: { ja: 'デゲン柴', en: 'Degen Shiba' }, motto: { ja: 'Laser Eyes', en: 'Laser Eyes' },
    tag: { ja: '全ツッパ', en: 'All in, always' },
    bio: { ja: 'リーチされても降りない。ジョーカーは絶対に手放さない。', en: 'Never folds to a riichi. Never lets go of a joker.' },
    style: { greed: 1.4, risk: 0.15, keepJoker: 1, neverFold: true },
  },
  crane: {
    id: 'crane', draw: paperCrane,
    name: { ja: '折り鶴', en: 'Paper Crane' }, motto: { ja: 'Paper Hands', en: 'Paper Hands' },
    tag: { ja: '超慎重', en: 'Folds first' },
    bio: { ja: 'リーチが入ったら即降り。安くても早上がり。', en: 'Folds the moment someone calls riichi. Takes any quick win.' },
    style: { greed: 0.7, risk: 2.2, keepJoker: 0.2 },
  },
  cat: {
    id: 'cat', draw: stableCat,
    name: { ja: '招き猫', en: 'Stable Cat' }, motto: { ja: 'Stablecoin', en: 'Stablecoin' },
    tag: { ja: '堅実', en: 'Pegged and steady' },
    bio: { ja: '大負けしないのが信条。持ち点を守り抜く。', en: 'Its creed: never lose big. Guards its points.' },
    style: { greed: 0.9, risk: 1.5, keepJoker: 0.4 },
  },
  tanuki: {
    id: 'tanuki', draw: rugTanuki,
    name: { ja: '化け狸', en: 'Rug Tanuki' }, motto: { ja: 'Rug Pull', en: 'Rug Pull' },
    tag: { ja: '変幻自在', en: 'Shapeshifter' },
    bio: { ja: '勝っていれば強気、負けが込むと敷物を抱えて逃げ腰に。', en: 'Bold when ahead; grabs the rug and runs when behind.' },
    style: { greed: 1.0, risk: 1.0, keepJoker: 0.6, adaptive: true },
  },
  fox: {
    id: 'fox', draw: inariFox,
    name: { ja: 'お稲荷の狐', en: 'Inari Fox' }, motto: { ja: 'Intent', en: 'Intent' },
    tag: { ja: '計算高い', en: 'The solver' },
    bio: { ja: '状況を読んで一番得な道を選ぶ。願いは必ず届ける。', en: 'Reads the table and finds the best path. Always delivers.' },
    style: { greed: 1.1, risk: 1.1, keepJoker: 0.55 },
  },
};

export const REFEREE = {
  id: 'kuroko', draw: kurokoReferee,
  name: { ja: '黒子の審判', en: 'Kuroko Referee' }, motto: { ja: 'Confidential', en: 'Confidential' },
  bio: { ja: '全員の手札を知っているが、誰にも言わない。', en: 'Knows every hand. Tells no one.' },
};

export const CHARACTER_IDS = Object.keys(CHARACTERS);

export function portrait(id, expr = 'normal') {
  const c = CHARACTERS[id] || (id === 'kuroko' ? REFEREE : null);
  return c ? c.draw(expr) : '';
}
