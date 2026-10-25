/*
 * RED OUT — ルール部分（画面や通信に依存しない純粋なロジック）
 * ブラウザでは window.RedOut、Node では module.exports として使えます。
 */
(function (root) {
  'use strict';

  // 手札の並び順
  const CARDS = ['B', 'W', 'BS', 'WS', 'RS'];

  const CARD_INFO = {
    B: { name: '黒', tone: 'black', skull: false },
    W: { name: '白', tone: 'white', skull: false },
    BS: { name: '黒ドクロ', tone: 'black', skull: true },
    WS: { name: '白ドクロ', tone: 'white', skull: true },
    RS: { name: '赤ドクロ', tone: 'red', skull: true },
  };

  // 左のカードが右のカードに勝つ組み合わせ。ここにないものはすべて引き分け。
  const BEATS = {
    RS: ['BS', 'WS'],
    BS: ['B'],
    WS: ['W'],
    B: [],
    W: [],
  };

  function beats(a, b) {
    return Boolean(BEATS[a] && BEATS[a].indexOf(b) !== -1);
  }

  function fullHand() {
    return { B: true, W: true, BS: true, WS: true, RS: true };
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

  /**
   * 新しい試合を作る。
   * players: [{ pid, name }]（席順）
   */
  function newMatch(id, players, now) {
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

    // 生き残りが複数いて、全員の札が尽きたら手札を戻して再戦（あいこ）
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

  /** 途中退出・切断などで脱落扱いにする */
  function forfeit(match, pid) {
    const m = clone(match);
    if (isOver(m) || !m.alive || !m.alive[pid]) return null;
    delete m.alive[pid];
    const entry = { kind: 'forfeit', turn: m.turn, pid: pid, winner: null, draw: false };
    settle(m, entry);
    m.seq = (m.seq || 0) + 1;
    m.log = m.log || {};
    m.log[logKey(m.seq)] = entry;
    if (isOver(m)) m.last = m.last || null;
    return m;
  }

  /** コミット用の文字列（ハッシュの入力） */
  function commitInput(room, matchId, turn, pid, card, salt) {
    return ['redout', room, matchId, turn, pid, card, salt].join('|');
  }

  const api = {
    CARDS: CARDS,
    CARD_INFO: CARD_INFO,
    BEATS: BEATS,
    beats: beats,
    fullHand: fullHand,
    handList: handList,
    asArray: asArray,
    alivePids: alivePids,
    turnKey: turnKey,
    isOver: isOver,
    newMatch: newMatch,
    resolveTurn: resolveTurn,
    forfeit: forfeit,
    commitInput: commitInput,
    clone: clone,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RedOut = api;
})(typeof window !== 'undefined' ? window : globalThis);
