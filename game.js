/*
 * RED OUT — ルール部分（画面や通信に依存しない純粋なロジック）
 * ブラウザでは window.RedOut、Node では module.exports として使えます。
 *
 * 2人対戦。片方が黒、もう片方が白の札を持つ。
 *   黒の手札：赤ドクロ・黒ドクロ・黒無印
 *   白の手札：赤ドクロ・白ドクロ・白無印
 * 強さは三すくみ（色は関係なし）：
 *   赤ドクロ ＞ 色ドクロ ＞ 無印 ＞ 赤ドクロ
 * 同じ種類どうしは引き分け。
 */
(function (root) {
  'use strict';

  // 札の種類（手札の並び順）
  const CARDS = ['R', 'S', 'P'];
  const COLORS = ['black', 'white'];

  const TYPE_INFO = {
    R: { name: '赤ドクロ', skull: true },
    S: { name: 'ドクロ', skull: true },
    P: { name: '無印', skull: false },
  };

  // 左の種類が右の種類に勝つ（三すくみ）。同じ種類は引き分け。
  const BEATS = {
    R: ['S'],
    S: ['P'],
    P: ['R'],
  };

  function beats(a, b) {
    return Boolean(BEATS[a] && BEATS[a].indexOf(b) !== -1);
  }

  function colorName(color) {
    return color === 'white' ? '白' : '黒';
  }

  // 札の名前（例：黒ドクロ、白無印、赤ドクロ）
  function cardName(type, color) {
    if (type === 'R') return '赤ドクロ';
    return colorName(color) + TYPE_INFO[type].name;
  }

  // 札の地の色
  function cardTone(type, color) {
    if (type === 'R') return 'red';
    return color === 'white' ? 'white' : 'black';
  }

  function fullHand() {
    return { R: true, S: true, P: true };
  }

  function handList(hand) {
    return CARDS.filter(function (c) { return hand && hand[c]; });
  }

  function clone(v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }

  function asArray(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v.filter(function (x) { return x != null; });
    return Object.keys(v).sort(function (a, b) { return Number(a) - Number(b); }).map(function (k) { return v[k]; });
  }

  function alivePids(match) {
    const order = asArray(match.order);
    const alive = match.alive || {};
    return order.filter(function (pid) { return alive[pid]; });
  }

  function turnKey(turn) {
    return 't' + turn;
  }

  function logKey(seq) {
    return 'e' + String(seq).padStart(4, '0');
  }

  function isOver(match) {
    return Boolean(match && (match.winner || match.draw));
  }

  // この版のルールで作られた試合か（古い版の試合データは扱わない）
  function isCurrentMatch(match) {
    if (!match || !match.colors) return false;
    const hands = match.hands || {};
    return Object.keys(hands).every(function (pid) {
      return Object.keys(hands[pid] || {}).every(function (k) { return CARDS.indexOf(k) !== -1; });
    });
  }

  /**
   * 色の割り当て。前の試合と同じ2人なら黒白を入れ替え、そうでなければ先の人が黒。
   * players: [{ pid }]（席順）
   */
  function assignColors(players, prevMatch) {
    const a = players[0] && players[0].pid;
    const b = players[1] && players[1].pid;
    const colors = {};
    const prev = prevMatch && prevMatch.colors;
    if (prev && prev[a] && prev[b]) {
      colors[a] = prev[a] === 'black' ? 'white' : 'black';
      colors[b] = prev[b] === 'black' ? 'white' : 'black';
    } else {
      if (a) colors[a] = 'black';
      if (b) colors[b] = 'white';
    }
    return colors;
  }

  /**
   * 新しい試合を作る。
   * players: [{ pid, name }]（席順）  colors: { pid: 'black'|'white' }
   */
  function newMatch(id, players, now, colors) {
    const order = [];
    const names = {};
    const alive = {};
    const hands = {};
    players.forEach(function (p) {
      order.push(p.pid);
      names[p.pid] = p.name;
      alive[p.pid] = true;
      hands[p.pid] = fullHand();
    });
    return {
      id: id,
      turn: 1,
      order: order,
      names: names,
      colors: colors || assignColors(players, null),
      alive: alive,
      hands: hands,
      seq: 0,
      rematches: 0,
      winner: null,
      draw: false,
      startedAt: now || 0,
    };
  }

  // 生き残りが1人なら勝者を決める
  function settle(m, entry) {
    const survivors = alivePids(m);
    if (survivors.length === 1) {
      m.winner = survivors[0];
      entry.winner = survivors[0];
    } else if (survivors.length === 0) {
      m.draw = true;
      entry.draw = true;
    }
  }

  /**
   * 全員が公開した札で1回の勝負を解決する。
   * plays: { pid: card }  fouls: 不正（ハッシュ不一致・手札にない札）と判定された pid の配列
   * 元の match は変更せず、新しい match を返す。
   */
  function resolveTurn(match, plays, fouls) {
    const m = clone(match);
    fouls = (fouls || []).slice();
    const alive = alivePids(m);
    const fair = alive.filter(function (pid) { return fouls.indexOf(pid) === -1; });

    const beatenBy = {};
    const eliminated = [];
    fair.forEach(function (p) {
      const winners = fair.filter(function (q) {
        return q !== p && beats(plays[q], plays[p]);
      });
      if (winners.length) {
        beatenBy[p] = winners;
        eliminated.push(p);
      }
    });

    // 出した札は手札から消える（引き分けでも捨て札）
    fair.forEach(function (pid) {
      if (m.hands[pid]) m.hands[pid][plays[pid]] = false;
    });

    const out = eliminated.concat(fouls.filter(function (p) { return alive.indexOf(p) !== -1; }));
    out.forEach(function (pid) { delete m.alive[pid]; });

    const shownPlays = {};
    alive.forEach(function (pid) { if (plays[pid]) shownPlays[pid] = plays[pid]; });

    const entry = {
      kind: 'turn',
      turn: m.turn,
      plays: shownPlays,
      eliminated: eliminated,
      fouls: fouls,
      beatenBy: beatenBy,
      rematch: false,
      winner: null,
      draw: false,
    };

    settle(m, entry);

    // 決着がつかず全員の札が尽きたら手札を戻して再戦（あいこ）
    if (!isOver(m)) {
      const survivors = alivePids(m);
      const empty = survivors.every(function (pid) { return handList(m.hands[pid]).length === 0; });
      if (empty) {
        survivors.forEach(function (pid) { m.hands[pid] = fullHand(); });
        m.rematches = (m.rematches || 0) + 1;
        entry.rematch = true;
      }
    }

    if (m.commits) delete m.commits[turnKey(m.turn)];
    if (m.reveals) delete m.reveals[turnKey(m.turn)];
    m.seq = (m.seq || 0) + 1;
    m.log = m.log || {};
    m.log[logKey(m.seq)] = entry;
    m.last = entry;
    m.turn += 1;
    return m;
  }

  /** 途中退出・切断などで負け扱いにする */
  function forfeit(match, pid) {
    const m = clone(match);
    if (isOver(m) || !m.alive || !m.alive[pid]) return null;
    delete m.alive[pid];
    const entry = { kind: 'forfeit', turn: m.turn, pid: pid, winner: null, draw: false };
    settle(m, entry);
    m.seq = (m.seq || 0) + 1;
    m.log = m.log || {};
    m.log[logKey(m.seq)] = entry;
    return m;
  }

  /** コミット用の文字列（ハッシュの入力） */
  function commitInput(room, matchId, turn, pid, card, salt) {
    return ['redout', room, matchId, turn, pid, card, salt].join('|');
  }

  const api = {
    CARDS: CARDS,
    COLORS: COLORS,
    TYPE_INFO: TYPE_INFO,
    BEATS: BEATS,
    beats: beats,
    colorName: colorName,
    cardName: cardName,
    cardTone: cardTone,
    fullHand: fullHand,
    handList: handList,
    asArray: asArray,
    alivePids: alivePids,
    turnKey: turnKey,
    isOver: isOver,
    isCurrentMatch: isCurrentMatch,
    assignColors: assignColors,
    newMatch: newMatch,
    resolveTurn: resolveTurn,
    forfeit: forfeit,
    commitInput: commitInput,
    clone: clone,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RedOut = api;
})(typeof window !== 'undefined' ? window : globalThis);
