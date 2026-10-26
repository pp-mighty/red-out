/*
 * RED OUT — 画面と進行
 * データの形（Firebase / テストモード共通）:
 * rooms/{CODE} = {
 *   createdAt, hostId, target(対戦人数), phase('lobby'|'game'), matchCount,
 *   players:  { pid: { name, joinedAt, sitOut? } },   // 対戦する人（sitOut = 次は観戦にまわる）
 *   watchers: { pid: { name, joinedAt, wantsIn? } },  // 観戦する人（名前は空でもよい。wantsIn = 次の試合に参加）
 *   presence: { pid: true|false },                    // 接続中かどうか
 *   scores:   { pid: 勝ち数 },
 *   cheers:   { pid: { k, t, n } },                   // 応援スタンプ（1人1枠を上書き）
 *   match: {                                          // 進行中または直前の試合
 *     id, turn, order[], names{}, alive{}, hands{},
 *     commits: { t1: { pid: SHA-256 } },              // 伏せた札（ハッシュだけ）
 *     reveals: { t1: { pid: { card, salt } } },       // 全員そろったら公開
 *     log: {...}, last, winner, rematches
 *   }
 * }
 */
(function () {
  'use strict';

  const G = window.RedOut;
  const app = document.getElementById('app');
  const sheet = document.getElementById('sheet');
  const sheetBody = document.getElementById('sheet-body');
  const toastEl = document.getElementById('toast');

  const MIN_PLAYERS = 2;
  const MAX_PLAYERS = 8;
  const CODE_LEN = 5;
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const ID_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789';
  const HEX = '0123456789abcdef';
  const REVEAL_MS = 1300;
  const CHEERS = [
    { k: 'clap', e: '👏', label: '拍手' },
    { k: 'fire', e: '🔥', label: '熱い' },
    { k: 'wow', e: '😱', label: 'びっくり' },
    { k: 'sad', e: '😢', label: '惜しい' },
    { k: 'party', e: '🎉', label: 'おめでとう' },
  ];
  const APP_VERSION = (document.querySelector('meta[name="app-version"]') || {}).content || 'dev';

  const state = {
    store: null,
    mode: 'local',
    kv: null,
    pid: '',
    name: '',
    code: null,
    room: null,
    roomLoaded: false,
    unsub: null,
    member: false,     // 対戦する人として部屋にいる
    watching: false,   // 観戦する人として部屋にいる
    presenceFor: null,
    invite: null,
    notice: '',
    error: '',
    busy: false,
    selected: null,
    form: { name: null, code: '', target: 2, showCreate: false },
    animKey: null,
    animAt: 0,
    animAtKey: null,
    pending: {},
    lastHtml: '',
    fanPlayed: false,
    wakeLock: null,
    sheetView: null,
    cheerSeen: {},
    cheerInit: false,
    lastCheerAt: 0,
    updateAvailable: false,
    latestVersion: null,
  };

  // ---------- 小さな道具 ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function randomId(n, chars) {
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    let s = '';
    for (let i = 0; i < n; i++) s += chars[a[i] % chars.length];
    return s;
  }

  async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  function memoryStorage() {
    const m = new Map();
    return {
      getItem: function (k) { return m.has(k) ? m.get(k) : null; },
      setItem: function (k, v) { m.set(k, String(v)); },
      removeItem: function (k) { m.delete(k); },
    };
  }

  function pickStorage(kind) {
    try {
      const s = window[kind];
      s.setItem('__redout', '1');
      s.removeItem('__redout');
      return s;
    } catch (e) {
      return memoryStorage();
    }
  }
  const longStore = pickStorage('localStorage');

  function kvGet(k) { try { return state.kv.getItem(k); } catch (e) { return null; } }
  function kvSet(k, v) { try { state.kv.setItem(k, v); } catch (e) { /* 保存できなくても続行 */ } }

  function normCode(raw) {
    const c = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return c.length === CODE_LEN ? c : null;
  }

  function clampTarget(n) {
    n = Number(n) || MIN_PLAYERS;
    return Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, n));
  }

  function roomPath(sub) {
    return 'rooms/' + state.code + (sub ? '/' + sub : '');
  }

  function secretKey(matchId, turn) {
    return 'redout:secret:' + state.code + ':' + matchId + ':' + turn + ':' + state.pid;
  }
  function readSecret(matchId, turn) {
    try { return JSON.parse(kvGet(secretKey(matchId, turn))); } catch (e) { return null; }
  }

  let toastTimer = null;
  function toast(text, ms) {
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, ms || 2400);
  }

  async function keepAwake(on) {
    if (!('wakeLock' in navigator)) return;
    try {
      if (on && !state.wakeLock && document.visibilityState === 'visible') {
        state.wakeLock = await navigator.wakeLock.request('screen');
        state.wakeLock.addEventListener('release', function () { state.wakeLock = null; });
      } else if (!on && state.wakeLock) {
        await state.wakeLock.release();
        state.wakeLock = null;
      }
    } catch (e) { /* 省電力モードなどで拒否されても問題なし */ }
  }

  function inRoom() {
    return (state.member || state.watching) && Boolean(state.room);
  }

  // ---------- 部屋データの読み取り ----------
  function playersOf(room) {
    const ps = (room && room.players) || {};
    return Object.keys(ps)
      .filter(function (id) { return ps[id] && ps[id].name; })
      .map(function (id) { return { pid: id, name: ps[id].name, joinedAt: ps[id].joinedAt || 0, sitOut: Boolean(ps[id].sitOut) }; })
      .sort(function (a, b) { return a.joinedAt - b.joinedAt || (a.pid < b.pid ? -1 : 1); });
  }

  function watchersOf(room) {
    const ws = (room && room.watchers) || {};
    return Object.keys(ws)
      .filter(function (id) { return ws[id] && typeof ws[id] === 'object'; })
      .map(function (id) { return { pid: id, name: ws[id].name || '', joinedAt: ws[id].joinedAt || 0, wantsIn: Boolean(ws[id].wantsIn) }; })
      .sort(function (a, b) { return a.joinedAt - b.joinedAt || (a.pid < b.pid ? -1 : 1); });
  }

  // 次の試合のメンバー（残る人＋参加希望の観戦者、最大8人まで申し込み順）
  function nextLineup(room) {
    const ps = playersOf(room);
    const stay = ps.filter(function (p) { return !p.sitOut; });
    const leaving = ps.filter(function (p) { return p.sitOut; });
    const joining = watchersOf(room).filter(function (w) { return w.wantsIn && w.name; });
    return { stay: stay, leaving: leaving, joining: joining, lineup: stay.concat(joining).slice(0, MAX_PLAYERS) };
  }

  function isOnline(pid) {
    const pr = state.room && state.room.presence;
    return Boolean(pr && pr[pid]);
  }

  function hostPid(room) {
    const ps = playersOf(room);
    const has = function (id) { return ps.some(function (p) { return p.pid === id; }); };
    if (room.hostId && has(room.hostId) && isOnline(room.hostId)) return room.hostId;
    const online = ps.find(function (p) { return isOnline(p.pid); });
    if (online) return online.pid;
    return room.hostId && has(room.hostId) ? room.hostId : (ps[0] && ps[0].pid);
  }

  function amHost() {
    return state.member && Boolean(state.room) && hostPid(state.room) === state.pid;
  }

  function winsOf(pid) {
    const s = state.room && state.room.scores;
    return (s && s[pid]) || 0;
  }

  function nameOf(m, pid) {
    if (m && m.names && m.names[pid]) return m.names[pid];
    const p = state.room && state.room.players && state.room.players[pid];
    if (p && p.name) return p.name;
    const w = state.room && state.room.watchers && state.room.watchers[pid];
    return (w && w.name) || '？';
  }

  function who(m, pid) {
    return pid === state.pid ? 'あなた' : nameOf(m, pid) + 'さん';
  }

  function myName() {
    const r = state.room;
    const p = r && r.players && r.players[state.pid];
    if (p && p.name) return p.name;
    const w = r && r.watchers && r.watchers[state.pid];
    return (w && w.name) || '';
  }

  // ---------- 札の見た目 ----------
  function cardHtml(card, extra) {
    const info = G.CARD_INFO[card];
    const inner = info.skull
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#skull"/></svg>'
      : '<span class="kanji" aria-hidden="true">' + info.name + '</span>';
    return '<span class="card card--' + info.tone + (extra ? ' ' + extra : '') + '" role="img" aria-label="' + info.name + '">' + inner + '</span>';
  }
  function backHtml() { return '<span class="card card--back" aria-hidden="true"></span>'; }
  function slotHtml() { return '<span class="card card--slot" aria-hidden="true"></span>'; }
  function pipHtml(card, used) {
    const info = G.CARD_INFO[card];
    return '<span class="pip card--' + info.tone + (used ? ' is-used' : '') + '" aria-hidden="true">' +
      (info.skull ? '<svg viewBox="0 0 24 24"><use href="#skull"/></svg>' : '') + '</span>';
  }
  function pipsHtml(hand) {
    const left = G.handList(hand).map(function (c) { return G.CARD_INFO[c].name; });
    return '<span class="pips" role="img" aria-label="残りの札：' + (left.join('、') || 'なし') + '">' +
      G.CARDS.map(function (c) { return pipHtml(c, !(hand && hand[c])); }).join('') + '</span>';
  }

  // ---------- 文章 ----------
  function describe(m, e) {
    if (!e) return '';
    if (e.kind === 'forfeit') return who(m, e.pid) + 'は退出したため脱落しました。';
    const parts = [];
    G.asArray(e.eliminated).forEach(function (p) {
      const by = G.asArray(e.beatenBy && e.beatenBy[p]).map(function (q) {
        return who(m, q) + 'の' + G.CARD_INFO[e.plays[q]].name;
      });
      parts.push(who(m, p) + 'は' + by.join('と') + 'に負けて脱落。');
    });
    G.asArray(e.fouls).forEach(function (p) {
      parts.push(who(m, p) + 'は札の確認が取れず反則負け。');
    });
    if (!parts.length) parts.push('勝負つかず。出した札は捨て札になります。');
    if (e.rematch) parts.push('全員の札が尽きたので、手札を戻して再戦します。');
    return parts.join('');
  }

  function rulesHtml() {
    const beat = function (a, bs) {
      return '<div class="beat">' + cardHtml(a) + '<span>は</span>' + bs.map(function (b) { return cardHtml(b); }).join('') +
        '<span class="gt">に勝つ</span></div>';
    };
    return '' +
      '<h3>強さ</h3>' +
      '<div class="beat-chart">' + beat('RS', ['BS', 'WS']) + beat('BS', ['B']) + beat('WS', ['W']) + '</div>' +
      '<p>それ以外の組み合わせは、すべて引き分けです。</p>' +
      '<h3>流れ</h3>' +
      '<ul>' +
      '<li>全員が同じ5枚（黒・白・黒ドクロ・白ドクロ・赤ドクロ）を持って始めます。</li>' +
      '<li>1枚ずつ伏せて出し、全員そろったら一斉に公開します。</li>' +
      '<li>誰か1人にでも負けた人は脱落です。</li>' +
      '<li>出した札は、勝っても引き分けでも捨て札になります。</li>' +
      '<li>最後の1人になった人の勝ちです。</li>' +
      '<li>生き残った全員が5枚を使い切ったら、手札を戻して再戦します。</li>' +
      '</ul>' +
      '<h3>読み合いのコツ</h3>' +
      '<p>相手が使った札は、席の小さな札で薄く表示されます。残りの札から、相手が次に出せるものを読みましょう。</p>' +
      '<h3>観戦</h3>' +
      '<p>招待リンクから「観戦する」を選ぶと、名前なしでも観戦できます。伏せた札は観戦者にも公開まで見えません。試合が終わったら「次の試合に参加する」で対戦に加われます。</p>';
  }

  function watchersLineHtml() {
    const ws = watchersOf(state.room).filter(function (w) { return isOnline(w.pid); });
    if (!ws.length) return '';
    const named = ws.map(function (w) {
      if (w.pid === state.pid) return 'あなた';
      return w.name ? w.name + 'さん' : null;
    }).filter(Boolean);
    const shown = named.slice(0, 3);
    const rest = ws.length - shown.length;
    let text = '観戦 ' + ws.length + '人';
    if (shown.length) text += '：' + shown.join('、') + (rest > 0 ? ' ほか' + rest + '人' : '');
    return '<p class="watchers">' + esc(text) + '</p>';
  }

  function cheerBarHtml() {
    return '<div class="cheer-bar" role="group" aria-label="応援スタンプ">' + CHEERS.map(function (c) {
      return '<button class="cheer-btn" data-action="cheer" data-kind="' + c.k + '" aria-label="' + c.label + '"><span aria-hidden="true">' + c.e + '</span></button>';
    }).join('') + '</div>';
  }

  function nameInputHtml(placeholder) {
    const name = state.form.name != null ? state.form.name : state.name;
    return '<label class="label" for="name">名前</label>' +
      '<input class="input" id="name" maxlength="12" autocomplete="nickname" enterkeyhint="done" placeholder="' + placeholder + '" value="' + esc(name) + '">';
  }

  // ---------- 画面 ----------
  function testmodeHtml() {
    if (state.mode !== 'local') return '';
    return '<div class="testmode">テストモード：このブラウザのタブ同士でだけ対戦できます</div>';
  }

  function renderHome() {
    const fanOrder = [['B', -26, 22], ['BS', -13, 6], ['RS', 0, 0], ['WS', 13, 6], ['W', 26, 22]];
    const fan = '<div class="fan' + (state.fanPlayed ? '' : ' is-opening') + '" aria-hidden="true">' +
      fanOrder.map(function (f, i) {
        return cardHtml(f[0]).replace('class="card ', 'style="--r:' + f[1] + 'deg;--y:' + f[2] + 'px;--i:' + i + '" class="card ');
      }).join('') + '</div>';
    state.fanPlayed = true;

    const busy = state.busy ? ' disabled' : '';
    const targetOptions = [];
    for (let n = MIN_PLAYERS; n <= MAX_PLAYERS; n++) {
      targetOptions.push('<option value="' + n + '"' + (state.form.target === n ? ' selected' : '') + '>' + n + '人で対戦</option>');
    }
    const createForm =
      '<form data-form="create" class="row" style="margin-top:14px">' +
      '<div class="grow"><label class="label" for="target">対戦人数</label>' +
      '<select class="select" id="target">' + targetOptions.join('') + '</select></div>' +
      '<button class="btn btn-primary" type="submit"' + busy + '>部屋を作る</button></form>';
    const joinForm =
      '<form data-form="join" class="row">' +
      '<div class="grow"><label class="label" for="code">部屋コード</label>' +
      '<input class="input input-code" id="code" maxlength="5" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="go" placeholder="ABCDE" value="' + esc(state.form.code) + '"></div>' +
      '<button class="btn btn-ghost" type="submit"' + busy + '>参加する</button></form>' +
      '<div class="home-foot" style="margin-top:6px"><button class="btn btn-text" data-action="watch-code"' + busy + '>このコードの部屋を観戦する</button></div>';
    const error = state.error ? '<p class="error" role="alert">' + esc(state.error) + '</p>' : '';

    let panel;
    if (state.invite) {
      const room = state.room;
      const missing = state.roomLoaded && !room;
      const playing = Boolean(room && room.phase === 'game');
      const full = Boolean(room && room.phase === 'lobby' && playersOf(room).length >= clampTarget(room.target));
      const canPlay = Boolean(room) && !playing && !full;
      let body;
      if (missing) {
        body = '<p class="error" role="alert">この部屋は見つかりませんでした。招待リンクを確認するか、新しく部屋を作ってください。</p>';
      } else {
        body = '<form data-form="invite">' + nameInputHtml('対戦相手に表示されます') +
          '<p class="hint">観戦だけなら、名前は空欄でも大丈夫です。</p>' +
          (canPlay
            ? '<div class="tray-actions" style="margin-top:14px">' +
              '<button class="btn btn-primary btn-block" type="submit"' + busy + '>対戦に参加する</button>' +
              '<button class="btn btn-ghost btn-block" type="button" data-action="watch-invite"' + busy + '>観戦する</button></div>'
            : '<p class="hint">' + (playing ? 'いま対戦中です。観戦しながら、次の試合から参加できます。' : 'この部屋は満員です。観戦はできます。') + '</p>' +
              '<button class="btn btn-primary btn-block" type="button" data-action="watch-invite" style="margin-top:10px"' + busy + '>観戦する</button>') +
          '</form>';
      }
      panel =
        '<section class="panel">' +
        '<h2 class="panel-title">部屋 <span class="invite-code">' + esc(state.invite) + '</span> に招待されています</h2>' +
        body + error +
        (state.form.showCreate || missing
          ? '<div class="or">または</div>' + (missing ? nameInputHtml('対戦相手に表示されます') : '') + createForm
          : '<div class="home-foot"><button class="btn btn-text" data-action="show-create">自分で部屋を作る</button></div>') +
        '</section>';
    } else {
      panel =
        '<section class="panel">' + nameInputHtml('対戦相手に表示されます') + createForm +
        '<div class="or">または</div>' + joinForm + error + '</section>';
    }

    return testmodeHtml() +
      '<div class="home">' +
      fan +
      '<h1 class="title">RED OUT</h1>' +
      '<p class="lede">5枚の札で読み合うドクロのじゃんけん。</p>' +
      (state.notice ? '<p class="notice" role="status" style="margin:0 0 12px">' + esc(state.notice) + '</p>' : '') +
      panel +
      '<div class="home-foot"><button class="btn btn-text" data-action="open-rules">ルールを見る</button></div>' +
      '</div>';
  }

  function topbarHtml() {
    return '<header class="topbar">' +
      '<span class="brand">RED OUT</span>' +
      '<button class="room-chip" data-action="share" aria-label="招待リンクを送る（部屋 ' + state.code + '）">招待<b>' + esc(state.code) + '</b></button>' +
      (state.room && state.room.phase === 'game' ? '<button class="btn btn-text" data-action="open-log">記録</button>' : '') +
      '<button class="btn btn-text" data-action="open-menu">メニュー</button>' +
      '</header>';
  }

  function renderLobby() {
    const room = state.room;
    const ps = playersOf(room);
    const target = clampTarget(room.target);
    const host = amHost();
    const hostId = hostPid(room);

    let targetCtl;
    if (host) {
      const opts = [];
      for (let n = Math.max(MIN_PLAYERS, ps.length); n <= MAX_PLAYERS; n++) {
        opts.push('<option value="' + n + '"' + (n === target ? ' selected' : '') + '>' + n + '人</option>');
      }
      targetCtl = '<select class="select" id="lobby-target" aria-label="対戦人数">' + opts.join('') + '</select>';
    } else {
      targetCtl = '<p style="margin:0;font-size:17px;font-weight:700">' + target + '人</p>';
    }

    const rows = ps.map(function (p) {
      const tags = [];
      if (p.pid === state.pid) tags.push('あなた');
      if (p.pid === hostId) tags.push('ホスト');
      const online = isOnline(p.pid);
      const kick = host && p.pid !== state.pid
        ? '<button class="btn btn-small btn-ghost" data-action="kick" data-pid="' + esc(p.pid) + '">外す</button>' : '';
      return '<li class="seat-row">' +
        '<span class="dot' + (online ? '' : ' is-off') + '" role="img" aria-label="' + (online ? '接続中' : '切断中') + '"></span>' +
        '<span class="who">' + esc(p.name) + (tags.length ? '<span class="tag">' + tags.join('、') + '</span>' : '') + '</span>' +
        (winsOf(p.pid) ? '<span class="wins">★' + winsOf(p.pid) + '</span>' : '') +
        kick + '</li>';
    });
    for (let i = ps.length; i < target; i++) {
      rows.push('<li class="seat-row seat-row--empty"><span class="dot is-empty"></span><span class="who">空席</span></li>');
    }

    const need = target - ps.length;
    let bottom;
    if (state.watching) {
      if (need > 0) {
        bottom = '<form data-form="sit">' + (myName() ? '' : nameInputHtml('対戦に参加するには名前が必要です')) +
          '<button class="btn btn-primary btn-block" type="submit" style="margin-top:' + (myName() ? '0' : '12px') + '"' + (state.busy ? ' disabled' : '') + '>対戦に参加する</button></form>';
      } else {
        bottom = '<p class="tray-note">満員です。観戦しながら、空きが出たら参加できます。</p>';
      }
    } else if (host) {
      const label = need > 0 ? 'あと' + need + '人で始められます' : (need < 0 ? '人数を合わせてください' : '対戦を始める');
      bottom = '<button class="btn btn-primary btn-block" data-action="start"' + (need !== 0 || state.busy ? ' disabled' : '') + '>' + label + '</button>';
    } else {
      bottom = '<p class="tray-note">' + (need > 0 ? 'あと' + need + '人そろうと、ホストが始められます。' : 'ホストが対戦を始めるのを待っています。') + '</p>';
    }

    return testmodeHtml() + topbarHtml() +
      '<div class="lobby">' +
      '<div class="code-block">' +
      '<div class="label">部屋コード</div>' +
      '<div class="code-big">' + esc(state.code) + '</div>' +
      '<button class="btn btn-ghost" data-action="share">招待リンクを送る</button>' +
      '</div>' +
      '<section class="panel">' +
      '<div class="row" style="align-items:center;margin-bottom:6px"><span class="grow" style="font-weight:700">対戦人数</span><div style="width:130px">' + targetCtl + '</div></div>' +
      '<ul class="seat-list">' + rows.join('') + '</ul>' +
      watchersLineHtml() +
      '</section>' +
      '</div>' +
      '<div class="tray">' + bottom + '</div>';
  }

  function seatState(m, pid, allCommitted) {
    if (!(m.alive && m.alive[pid])) return { text: '脱落', cls: 'is-out' };
    if (G.isOver(m)) return m.winner === pid ? { text: '勝ち', done: true } : { text: '' };
    const tk = G.turnKey(m.turn);
    const committed = m.commits && m.commits[tk] && m.commits[tk][pid];
    if (!isOnline(pid)) return { text: '切断中', off: true, done: Boolean(committed) };
    if (committed) {
      const revealed = m.reveals && m.reveals[tk] && m.reveals[tk][pid];
      return { text: allCommitted && !revealed ? '公開待ち' : '出した', done: true };
    }
    return { text: '考え中' };
  }

  function playHtml(m, pid, card, stamp) {
    return '<div class="play' + (pid === state.pid ? ' is-me' : '') + '">' +
      '<div class="stack">' + backHtml() + cardHtml(card, 'face') +
      (stamp ? '<span class="stamp' + (stamp === '勝ち' ? ' stamp--win' : '') + '">' + stamp + '</span>' : '') +
      '</div><span class="play-name">' + esc(pid === state.pid ? 'あなた' : nameOf(m, pid)) + '</span></div>';
  }

  function lineupHtml() {
    const lu = nextLineup(state.room);
    if (!lu.joining.length && !lu.leaving.length) return '';
    const names = lu.lineup.map(function (p) { return p.pid === state.pid ? 'あなた' : p.name; });
    return '<p class="lineup">次の試合：' + esc(names.join('、')) + '</p>';
  }

  function renderGame() {
    const room = state.room;
    const m = room.match;
    const me = state.pid;
    const order = G.asArray(m.order);
    const alive = G.alivePids(m);
    const over = G.isOver(m);
    const watching = order.indexOf(me) === -1;
    const isAlive = Boolean(m.alive && m.alive[me]);
    const tk = G.turnKey(m.turn);
    const commits = (m.commits && m.commits[tk]) || {};
    const committedCount = alive.filter(function (p) { return commits[p]; }).length;
    const allCommitted = alive.length > 0 && committedCount === alive.length;
    const host = amHost();
    const last = m.last || null;

    // 席（自分以外。観戦中は全員）
    const seats = order.filter(function (p) { return p !== me; }).map(function (p) {
      const st = seatState(m, p, allCommitted);
      const forfeitBtn = host && !over && m.alive && m.alive[p] && !isOnline(p)
        ? '<button class="btn btn-small btn-ghost" data-action="forfeit" data-pid="' + esc(p) + '">脱落扱い</button>' : '';
      return '<div class="seat' + (st.cls ? ' ' + st.cls : '') + (st.done ? ' is-done' : '') + '">' +
        '<div class="seat-name">' + esc(nameOf(m, p)) + '</div>' +
        '<div class="seat-meta"><span class="' + (st.off ? 'state-off' : (st.done ? 'state-done' : '')) + '">' + st.text + '</span>' +
        '<span class="wins">★' + winsOf(p) + '</span></div>' +
        pipsHtml(m.hands && m.hands[p]) + forfeitBtn + '</div>';
    }).join('');

    // 一斉公開の演出（新しい結果が届いたときだけ）
    const key = last ? m.id + ':' + last.turn : 'none:' + m.id;
    const now = performance.now();
    if (state.animKey === null) {
      state.animKey = key;
    } else if (state.animKey !== key) {
      state.animKey = key;
      if (last) {
        state.animAt = now;
        state.animAtKey = key;
        if (navigator.vibrate) { try { navigator.vibrate(30); } catch (e) { /* 対応していない端末 */ } }
      }
    }
    const elapsed = now - state.animAt;
    const revealing = Boolean(last) && state.animAtKey === key && elapsed < REVEAL_MS;

    // 場
    let field;
    const progress = '出した人 ' + committedCount + ' / ' + alive.length;
    if (over) {
      const winner = m.winner;
      const title = m.draw ? '引き分け' : (winner === me ? 'あなたの勝ち' : esc(nameOf(m, winner)) + 'さんの勝ち');
      let plays = '';
      let caption = '';
      const entries = Object.keys(m.log || {}).sort().map(function (k) { return m.log[k]; });
      const final = entries[entries.length - 1];
      if (final && final.kind === 'turn') {
        plays = '<div class="plays">' + order.filter(function (p) { return final.plays && final.plays[p]; }).map(function (p) {
          const out = G.asArray(final.eliminated).indexOf(p) !== -1 || G.asArray(final.fouls).indexOf(p) !== -1;
          return playHtml(m, p, final.plays[p], p === winner ? '勝ち' : (out ? '脱落' : ''));
        }).join('') + '</div>';
        caption = describe(m, final);
      } else if (final) {
        caption = describe(m, final);
      }
      field = '<div class="field-head">第' + m.id + '試合の結果</div>' + plays +
        '<p class="result-title">' + title + '</p>' +
        (caption ? '<p class="caption">' + esc(caption) + '</p>' : '');
    } else if (last) {
      field = '<div class="field-head">ターン' + last.turn + 'の結果</div>' +
        '<div class="plays">' + order.filter(function (p) { return last.plays && last.plays[p]; }).map(function (p) {
          const out = G.asArray(last.eliminated).indexOf(p) !== -1 || G.asArray(last.fouls).indexOf(p) !== -1;
          return playHtml(m, p, last.plays[p], out ? '脱落' : '');
        }).join('') + '</div>' +
        '<p class="caption">' + esc(describe(m, last)) + '</p>' +
        '<p class="caption-sub">ターン' + m.turn + '　' + progress + '</p>';
    } else {
      field = '<div class="field-head">第' + m.id + '試合　ターン' + m.turn + '</div>' +
        '<div class="plays">' + alive.map(function (p) {
          return '<div class="play' + (p === me ? ' is-me' : '') + '"><div class="stack">' + (commits[p] ? backHtml().replace(' aria-hidden="true"', ' style="display:grid;position:static"') : slotHtml()) +
            '</div><span class="play-name">' + esc(p === me ? 'あなた' : nameOf(m, p)) + '</span></div>';
        }).join('') + '</div>' +
        '<p class="caption">全員が札を伏せると、一斉に公開されます。</p>' +
        '<p class="caption-sub">' + progress + '</p>';
    }

    // 画面下のトレイ
    let tray;
    if (watching) {
      const meW = (room.watchers && room.watchers[me]) || {};
      let join = '';
      if (over) {
        if (meW.wantsIn) {
          join = '<div class="row" style="align-items:center;margin-top:12px"><p class="tray-note grow" style="min-height:0">次の試合に参加します。</p>' +
            '<button class="btn btn-small btn-ghost" data-action="opt-out">取り消す</button></div>';
        } else {
          join = '<form data-form="opt-in" style="margin-top:12px">' + (meW.name ? '' : nameInputHtml('対戦に参加するには名前が必要です')) +
            '<button class="btn btn-primary btn-block" type="submit" style="margin-top:' + (meW.name ? '0' : '12px') + '"' + (state.busy ? ' disabled' : '') + '>次の試合に参加する</button></form>';
        }
      }
      tray = '<div class="tray-head"><strong>観戦中</strong><span>スタンプで応援できます</span></div>' +
        cheerBarHtml() + (over ? lineupHtml() : '') + join;
    } else {
      const hand = (m.hands && m.hands[me]) || {};
      const myCommit = commits[me];
      const secret = myCommit ? readSecret(m.id, m.turn) : null;
      const canPick = isAlive && !over && !myCommit;
      if (state.selected && (!canPick || !hand[state.selected])) state.selected = null;
      const cards = G.CARDS.map(function (c) {
        const has = Boolean(hand[c]);
        const played = Boolean(secret && secret.card === c && !over);
        const sel = canPick && state.selected === c;
        return '<button class="hand-card' + (has ? '' : ' is-used') + (played ? ' is-played' : '') + '" data-action="pick" data-card="' + c + '"' +
          ' aria-pressed="' + sel + '"' + (canPick && has ? '' : ' disabled') + '>' +
          cardHtml(c) + '<span class="card-name">' + G.CARD_INFO[c].name + '</span></button>';
      }).join('');

      let action;
      if (over) {
        const sitOut = Boolean(room.players && room.players[me] && room.players[me].sitOut);
        action = lineupHtml() + '<div class="tray-actions">' +
          '<button class="btn btn-primary btn-block" data-action="next" data-match="' + m.id + '"' + (state.busy ? ' disabled' : '') + '>次の試合へ</button>' +
          '<div class="row">' +
          '<button class="btn btn-ghost btn-toggle grow" data-action="sit-out" data-on="' + (sitOut ? '0' : '1') + '" aria-pressed="' + sitOut + '">' + (sitOut ? '✓ ' : '') + '次は観戦にまわる</button>' +
          (host ? '<button class="btn btn-ghost grow" data-action="lobby"' + (state.busy ? ' disabled' : '') + '>ロビーに戻る</button>' : '') +
          '</div></div>';
      } else if (!isAlive) {
        action = '<p class="tray-note" style="min-height:0;margin-bottom:10px">脱落しました。決着まで観戦できます。</p>' + cheerBarHtml();
      } else if (myCommit && !secret) {
        action = '<p class="tray-note">この端末には伏せた札の記録がありません。札を出した端末で開き直してください。</p>';
      } else if (myCommit) {
        action = '<p class="tray-note">' + (allCommitted ? '公開しています…' : '札を伏せました。全員そろうと公開されます。') + '</p>';
      } else {
        action = '<button class="btn btn-primary btn-block" data-action="commit"' + (state.selected && !state.busy ? '' : ' disabled') + '>' +
          (state.selected ? G.CARD_INFO[state.selected].name + 'を出す' : '出す札を選んでください') + '</button>';
      }

      tray = over
        ? '<div class="tray-head" style="margin-bottom:10px"><strong>通算</strong><span class="wins">あなたは★' + winsOf(me) + '勝</span></div>' + action
        : '<div class="tray-head"><strong>あなたの手札</strong><span class="wins">★' + winsOf(me) + '勝</span></div>' +
          '<div class="hand">' + cards + '</div>' + action;
    }

    return testmodeHtml() + topbarHtml() +
      '<div class="game' + (order.length >= 5 ? ' is-crowded' : '') + '">' +
      (seats ? '<div class="seats">' + seats + '</div>' : '') +
      watchersLineHtml() +
      '<section class="field' + (revealing ? ' is-revealing' : '') + '" style="--offset:' + (revealing ? -Math.round(elapsed) : 0) + 'ms" aria-label="場">' + field + '</section>' +
      '<div class="tray">' + tray + '</div></div>';
  }

  function logHtml() {
    const room = state.room;
    const m = room && room.match;
    let html = '';
    const ps = playersOf(room);
    if (ps.length) {
      html += '<h3>通算の勝ち数</h3><ul class="log">' + ps.map(function (p) {
        return '<li style="display:flex;justify-content:space-between"><span>' + esc(p.pid === state.pid ? p.name + '（あなた）' : p.name) +
          '</span><span class="wins">★' + winsOf(p.pid) + '</span></li>';
      }).join('') + '</ul>';
    }
    html += '<h3>' + (m ? '第' + m.id + '試合の記録' : '記録') + '</h3>';
    const entries = m ? Object.keys(m.log || {}).sort().reverse().map(function (k) { return m.log[k]; }) : [];
    if (!entries.length) return html + '<p class="empty">まだ公開された勝負はありません。</p>';
    const order = G.asArray(m.order);
    html += '<ul class="log">' + entries.map(function (e) {
      if (e.kind === 'forfeit') return '<li>' + esc(describe(m, e)) + '</li>';
      const plays = order.filter(function (p) { return e.plays && e.plays[p]; }).map(function (p) {
        const out = G.asArray(e.eliminated).indexOf(p) !== -1 || G.asArray(e.fouls).indexOf(p) !== -1;
        return '<span class="log-play' + (out ? ' is-out' : '') + '">' + pipHtml(e.plays[p], false) + esc(p === state.pid ? 'あなた' : nameOf(m, p)) + '</span>';
      }).join('');
      return '<li><strong>ターン' + e.turn + '</strong><div class="log-plays">' + plays + '</div>' +
        '<div style="margin-top:4px;color:var(--muted)">' + esc(describe(m, e)) + '</div></li>';
    }).join('') + '</ul>';
    return html;
  }

  function renderSheet(view) {
    const head = function (t) {
      return '<div class="sheet-head"><h2 id="sheet-title">' + t + '</h2><button class="btn btn-text" data-action="close-sheet">閉じる</button></div>';
    };
    let html = '';
    if (view === 'rules') html = head('ルール') + rulesHtml();
    if (view === 'menu') {
      html = head('メニュー') +
        '<button class="btn btn-ghost btn-block" data-action="share">招待リンクを送る</button>' +
        rulesHtml() +
        '<div style="margin-top:24px"><button class="btn btn-danger btn-block" data-action="leave">' + (state.watching ? '観戦をやめる' : '部屋から退出する') + '</button></div>';
    }
    if (view === 'log') html = head('記録') + logHtml();
    sheetBody.innerHTML = html;
  }

  function openSheet(view) {
    state.sheetView = view;
    renderSheet(view);
    if (!sheet.open) {
      if (sheet.showModal) sheet.showModal(); else sheet.setAttribute('open', '');
    }
    sheetBody.scrollTop = 0;
  }

  function closeSheet() {
    if (sheet.open) { if (sheet.close) sheet.close(); else sheet.removeAttribute('open'); }
    state.sheetView = null;
  }

  function captureFocus() {
    const el = document.activeElement;
    if (!el || !app.contains(el) || !el.id) return null;
    return { id: el.id, start: el.selectionStart, end: el.selectionEnd };
  }

  function restoreFocus(f) {
    if (!f) return;
    const el = document.getElementById(f.id);
    if (!el) return;
    el.focus({ preventScroll: true });
    if (typeof f.start === 'number' && el.setSelectionRange) {
      try { el.setSelectionRange(f.start, f.end); } catch (e) { /* select 要素など */ }
    }
  }

  function render() {
    if (!state.store) return;
    let html;
    if (inRoom()) {
      html = state.room.phase === 'game' && state.room.match ? renderGame() : renderLobby();
    } else {
      html = renderHome();
    }
    if (state.updateAvailable) {
      html = '<div class="update-bar" role="status"><span>新しいバージョンがあります</span>' +
        '<button class="btn btn-small" data-action="reload">更新する</button></div>' + html;
    }
    if (html !== state.lastHtml) {
      const f = captureFocus();
      app.innerHTML = html;
      state.lastHtml = html;
      restoreFocus(f);
    }
    if (sheet.open && state.sheetView === 'log') renderSheet('log');
    if (sheet.open && state.sheetView === 'menu' && !inRoom()) closeSheet();
  }

  // ---------- 応援スタンプ ----------
  const cheerLayer = document.createElement('div');
  cheerLayer.className = 'cheers';
  cheerLayer.setAttribute('aria-hidden', 'true');
  document.body.appendChild(cheerLayer);

  function spawnCheer(c) {
    const def = CHEERS.find(function (x) { return x.k === c.k; });
    if (!def) return;
    const el = document.createElement('div');
    el.className = 'cheer';
    // 札や結果に重ならないよう、画面の左右の端から浮かび上がらせる
    el.style.left = (Math.random() < 0.5 ? 3 + Math.random() * 15 : 66 + Math.random() * 13) + '%';
    el.style.setProperty('--rot', (Math.random() * 24 - 12).toFixed(1) + 'deg');
    const emoji = document.createElement('span');
    emoji.className = 'emoji';
    emoji.textContent = def.e;
    el.appendChild(emoji);
    if (c.n) {
      const by = document.createElement('span');
      by.className = 'by';
      by.textContent = c.n;
      el.appendChild(by);
    }
    cheerLayer.appendChild(el);
    while (cheerLayer.children.length > 12) cheerLayer.firstChild.remove();
    setTimeout(function () { el.remove(); }, 2300);
  }

  // 届いたスタンプのうち、まだ表示していないものだけを出す（端末間の時計のずれに影響されない）
  function processCheers(room) {
    const ch = (room && room.cheers) || {};
    const first = !state.cheerInit;
    Object.keys(ch).forEach(function (sid) {
      const c = ch[sid];
      if (!c || !c.t) return;
      const key = c.t + ':' + (c.k || '');
      if (state.cheerSeen[sid] === key) return;
      state.cheerSeen[sid] = key;
      if (!first && inRoom()) spawnCheer(c);
    });
    state.cheerInit = true;
  }

  function canCheer() {
    if (!inRoom()) return false;
    if (state.watching) return true;
    const m = state.room.match;
    return Boolean(m && state.room.phase === 'game' && !G.isOver(m) && !(m.alive && m.alive[state.pid]));
  }

  function sendCheer(kind) {
    if (!canCheer()) return;
    const t = Date.now();
    if (t - state.lastCheerAt < 900) return;
    state.lastCheerAt = t;
    state.store.set(roomPath('cheers/' + state.pid), { k: kind, t: state.store.now(), n: myName() }).catch(function (e) { console.error(e); });
  }

  // ---------- 部屋の購読 ----------
  function watchRoom(code) {
    if (state.unsub) state.unsub();
    state.code = code;
    state.room = null;
    state.roomLoaded = false;
    state.animKey = null;
    state.cheerSeen = {};
    state.cheerInit = false;
    state.unsub = state.store.on('rooms/' + code, function (room) {
      if (state.code !== code) return;
      onRoom(room);
    });
  }

  function onRoom(room) {
    state.room = room || null;
    state.roomLoaded = true;
    const meIn = Boolean(room && room.players && room.players[state.pid] && room.players[state.pid].name);
    const meWatch = !meIn && Boolean(room && room.watchers && room.watchers[state.pid]);
    if (meIn || meWatch) {
      if (!state.member && !state.watching) state.animKey = null;
      state.member = meIn;
      state.watching = meWatch;
      state.invite = null;
      state.error = '';
      state.notice = '';
      if (state.presenceFor !== state.code) {
        state.store.presence(roomPath('presence/' + state.pid));
        state.presenceFor = state.code;
      }
      keepAwake(true);
    } else if (state.member || state.watching) {
      leaveLocal(room ? '部屋から外されました。' : 'この部屋は終了しました。');
      return;
    }
    processCheers(room);
    autoProgress();
    render();
  }

  function enterRoom(code) {
    kvSet('redout:lastRoom', code);
    try { history.replaceState(null, '', location.pathname + '?room=' + code); } catch (e) { /* file:// など */ }
    if (state.code !== code || !state.unsub) watchRoom(code);
  }

  function leaveLocal(message) {
    if (state.unsub) state.unsub();
    state.unsub = null;
    if (state.presenceFor) state.store.stopPresence();
    state.presenceFor = null;
    state.member = false;
    state.watching = false;
    state.code = null;
    state.room = null;
    state.roomLoaded = false;
    state.invite = null;
    state.selected = null;
    state.animKey = null;
    state.notice = message || '';
    state.form.showCreate = false;
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* file:// など */ }
    keepAwake(false);
    closeSheet();
    render();
  }

  // ---------- 操作 ----------
  async function run(fn) {
    if (state.busy) return;
    state.busy = true;
    render();
    try {
      await fn();
    } catch (e) {
      console.error(e);
      const denied = /permission[_ ]denied/i.test(String((e && (e.code || e.message)) || ''));
      toast(denied
        ? 'Firebase に書き込めませんでした。README の手順2-3（ルールの公開）を確認してください。'
        : '通信に失敗しました。電波の良いところで、もう一度試してください。', 5000);
    } finally {
      state.busy = false;
      render();
    }
  }

  function saveName(n) {
    state.name = n;
    state.form.name = n;
    kvSet('redout:name', n);
    try { longStore.setItem('redout:name', n); } catch (e) { /* 保存できなくても続行 */ }
  }

  function takeName() {
    const raw = state.form.name != null ? state.form.name : state.name;
    const n = String(raw || '').trim().slice(0, 12);
    if (!n) {
      state.error = '名前を入力してください。';
      toast('名前を入力してください。');
      render();
      const el = document.getElementById('name');
      if (el) el.focus();
      return null;
    }
    saveName(n);
    state.error = '';
    return n;
  }

  // 観戦用：名前は空でもよい
  function optionalName() {
    const raw = state.form.name != null ? state.form.name : state.name;
    const n = String(raw || '').trim().slice(0, 12);
    if (n) saveName(n);
    return n;
  }

  async function createRoom() {
    const name = takeName();
    if (!name) return;
    const target = clampTarget(state.form.target);
    let code = null;
    for (let i = 0; i < 8 && !code; i++) {
      const c = randomId(CODE_LEN, CODE_CHARS);
      const exists = await state.store.get('rooms/' + c + '/createdAt');
      if (!exists) code = c;
    }
    if (!code) throw new Error('部屋コードを作れませんでした');
    const now = state.store.now();
    const players = {};
    players[state.pid] = { name: name, joinedAt: now };
    await state.store.set('rooms/' + code, {
      createdAt: now, hostId: state.pid, target: target, phase: 'lobby', matchCount: 0, players: players,
    });
    enterRoom(code);
  }

  async function joinRoom(raw) {
    const name = takeName();
    if (!name) return;
    const code = normCode(raw);
    if (!code) {
      state.error = '部屋コード（英数字5文字）を入力してください。';
      return;
    }
    const now = state.store.now();
    let reason = null;
    const res = await state.store.transaction('rooms/' + code, function (room) {
      reason = null;
      if (!room) { reason = 'notfound'; return null; }
      const ps = room.players || {};
      if (ps[state.pid] && ps[state.pid].name) {
        ps[state.pid].name = name;
        room.players = ps;
        return room;
      }
      if (room.phase !== 'lobby') { reason = 'playing'; return; }
      if (playersOf(room).length >= clampTarget(room.target)) { reason = 'full'; return; }
      ps[state.pid] = { name: name, joinedAt: now };
      room.players = ps;
      if (room.watchers) delete room.watchers[state.pid];
      return room;
    });
    if (!res.committed || !res.value) {
      state.error = {
        notfound: '部屋 ' + code + ' は見つかりませんでした。コードを確認してください。',
        playing: 'この部屋は対戦中です。「観戦する」から観戦できます。',
        full: 'この部屋は満員です。「観戦する」から観戦できます。',
      }[reason || 'notfound'];
      if (state.invite !== code) state.invite = null;
      return;
    }
    enterRoom(code);
  }

  async function watchRoomAs(raw) {
    const code = normCode(raw);
    if (!code) {
      state.error = '部屋コード（英数字5文字）を入力してください。';
      return;
    }
    const name = optionalName();
    const now = state.store.now();
    const res = await state.store.transaction('rooms/' + code, function (room) {
      if (!room) return null;
      if (room.players && room.players[state.pid] && room.players[state.pid].name) return room; // すでに対戦メンバーならそのまま
      room.watchers = room.watchers || {};
      const prev = room.watchers[state.pid] || {};
      room.watchers[state.pid] = { name: name || prev.name || '', joinedAt: prev.joinedAt || now };
      return room;
    });
    if (!res.committed || !res.value) {
      state.error = '部屋 ' + code + ' は見つかりませんでした。コードを確認してください。';
      if (state.invite !== code) state.invite = null;
      return;
    }
    enterRoom(code);
  }

  // 観戦中にロビーの空席へ入る
  async function sitDown() {
    const name = myName() || takeName();
    if (!name) return;
    const now = state.store.now();
    let reason = null;
    const res = await state.store.transaction(roomPath(), function (r) {
      reason = null;
      if (!r) return r;
      if (r.phase !== 'lobby') { reason = 'playing'; return; }
      if (playersOf(r).length >= clampTarget(r.target)) { reason = 'full'; return; }
      r.players = r.players || {};
      r.players[state.pid] = { name: name, joinedAt: now };
      if (r.watchers) delete r.watchers[state.pid];
      return r;
    });
    if (!res.committed) toast(reason === 'full' ? '満員になりました。' : '対戦が始まりました。次の試合から参加できます。');
  }

  async function optIn() {
    const name = myName() || takeName();
    if (!name) return;
    await state.store.update(roomPath('watchers/' + state.pid), { name: name, wantsIn: true });
  }

  async function optOut() {
    await state.store.set(roomPath('watchers/' + state.pid + '/wantsIn'), null);
  }

  async function setSitOut(on) {
    await state.store.set(roomPath('players/' + state.pid + '/sitOut'), on ? true : null);
  }

  async function setTarget(n) {
    if (!amHost()) return;
    const count = playersOf(state.room).length;
    const t = Math.max(clampTarget(n), count, MIN_PLAYERS);
    await state.store.set(roomPath('target'), t);
  }

  async function kick(pid) {
    const p = state.room.players && state.room.players[pid];
    if (!p || !confirm(p.name + 'さんを部屋から外しますか？')) return;
    await state.store.transaction(roomPath(), function (r) {
      if (!r) return r;
      if (r.players) delete r.players[pid];
      if (r.presence) delete r.presence[pid];
      if (r.hostId === pid) { const ps = playersOf(r); r.hostId = ps.length ? ps[0].pid : null; }
      return r;
    });
  }

  function clearSitOut(r) {
    Object.keys(r.players || {}).forEach(function (id) { if (r.players[id]) delete r.players[id].sitOut; });
  }

  async function startGame() {
    const now = state.store.now();
    let reason = null;
    await state.store.transaction(roomPath(), function (r) {
      reason = null;
      if (!r) return r;
      if (r.phase !== 'lobby') return;
      const ps = playersOf(r);
      if (ps.length < MIN_PLAYERS || ps.length !== clampTarget(r.target)) { reason = 'count'; return; }
      clearSitOut(r);
      r.matchCount = (r.matchCount || 0) + 1;
      r.match = G.newMatch(r.matchCount, ps.map(function (p) { return { pid: p.pid, name: p.name }; }), now);
      r.phase = 'game';
      return r;
    });
    if (reason === 'count') toast('人数がそろっていません。');
  }

  // 次の試合：観戦にまわる人と参加する観戦者を入れ替えてから始める
  async function nextMatch(matchId) {
    const now = state.store.now();
    let reason = null;
    await state.store.transaction(roomPath(), function (r) {
      reason = null;
      if (!r || r.phase !== 'game' || !r.match || !G.isOver(r.match) || r.match.id !== matchId) return;
      const lu = nextLineup(r);
      if (lu.lineup.length < MIN_PLAYERS) { reason = 'few'; return; }
      r.watchers = r.watchers || {};
      lu.leaving.forEach(function (p) {
        delete r.players[p.pid];
        r.watchers[p.pid] = { name: p.name, joinedAt: now };
      });
      lu.joining.forEach(function (w, i) {
        if (!lu.lineup.some(function (x) { return x.pid === w.pid; })) return; // 8人を超えた分は次回へ
        delete r.watchers[w.pid];
        r.players = r.players || {};
        r.players[w.pid] = { name: w.name, joinedAt: now + i + 1 };
      });
      clearSitOut(r);
      if (!r.players || !r.players[r.hostId]) { const ps = playersOf(r); r.hostId = ps.length ? ps[0].pid : null; }
      r.target = clampTarget(lu.lineup.length);
      r.matchCount = Math.max(r.matchCount || 0, r.match.id) + 1;
      r.match = G.newMatch(r.matchCount, lu.lineup.map(function (p) { return { pid: p.pid, name: p.name }; }), now);
      return r;
    });
    if (reason === 'few') toast('次の試合に出る人が2人以上必要です。', 3500);
  }

  async function backToLobby() {
    await state.store.transaction(roomPath(), function (r) {
      if (!r) return r;
      r.phase = 'lobby';
      r.match = null;
      clearSitOut(r);
      const count = playersOf(r).length;
      if (clampTarget(r.target) < count) r.target = clampTarget(count);
      return r;
    });
  }

  async function playCard(card) {
    const m = state.room && state.room.match;
    const me = state.pid;
    if (!m || G.isOver(m) || !(m.alive && m.alive[me]) || !(m.hands && m.hands[me] && m.hands[me][card])) return;
    const tk = G.turnKey(m.turn);
    if (m.commits && m.commits[tk] && m.commits[tk][me]) return;
    const salt = randomId(32, HEX);
    const hash = await sha256(G.commitInput(state.code, m.id, m.turn, me, card, salt));
    kvSet(secretKey(m.id, m.turn), JSON.stringify({ card: card, salt: salt }));
    await state.store.set(roomPath('match/commits/' + tk + '/' + me), hash);
    state.selected = null;
  }

  async function addWin(pid) {
    await state.store.transaction(roomPath('scores/' + pid), function (v) { return (v || 0) + 1; });
  }

  async function forfeitPlayer(pid) {
    const res = await state.store.transaction(roomPath('match'), function (cur) {
      if (!cur) return cur;
      const next = G.forfeit(cur, pid);
      return next || undefined;
    });
    if (res.committed && res.value && res.value.winner) await addWin(res.value.winner);
  }

  async function leaveRoom() {
    const room = state.room;
    const m = room && room.match;
    const watching = state.watching;
    const inPlay = !watching && room && room.phase === 'game' && m && !G.isOver(m) && m.alive && m.alive[state.pid];
    const question = watching ? '観戦をやめて部屋から出ますか？' : '部屋から退出しますか？' + (inPlay ? '\n対戦中の試合は脱落になります。' : '');
    if (!confirm(question)) return;
    closeSheet();
    const code = state.code;
    const pid = state.pid;
    if (inPlay) await forfeitPlayer(pid);
    if (state.unsub) state.unsub();
    state.unsub = null;
    state.member = false;
    state.watching = false;
    if (state.presenceFor) await state.store.stopPresence();
    state.presenceFor = null;
    await state.store.transaction('rooms/' + code, function (r) {
      if (!r) return r;
      if (r.players) delete r.players[pid];
      if (r.watchers) delete r.watchers[pid];
      if (r.presence) delete r.presence[pid];
      if (r.cheers) delete r.cheers[pid];
      const ps = playersOf(r);
      if (!ps.length && !watchersOf(r).length) return null; // 誰もいなくなったら部屋を片付ける
      if (!ps.length) { r.phase = 'lobby'; r.match = null; r.hostId = null; return r; }
      if (r.hostId === pid) r.hostId = ps[0].pid;
      return r;
    });
    leaveLocal('');
  }

  async function shareInvite() {
    const url = location.href.split('?')[0].split('#')[0] + '?room=' + state.code;
    const text = 'RED OUT で対戦しよう。部屋コード ' + state.code;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'RED OUT', text: text, url: url });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('招待リンクをコピーしました');
    } catch (e) {
      toast(url, 8000);
    }
  }

  // ---------- 自動進行（公開と勝負の解決） ----------
  function autoProgress() {
    const room = state.room;
    if (!inRoom() || room.phase !== 'game') return;
    const m = room.match;
    if (!m || G.isOver(m)) return;
    const T = m.turn;
    const tk = G.turnKey(T);
    const alive = G.alivePids(m);
    if (!alive.length) return;
    const commits = (m.commits && m.commits[tk]) || {};
    if (!alive.every(function (p) { return commits[p]; })) return;
    const reveals = (m.reveals && m.reveals[tk]) || {};

    // 全員が伏せたので、自分の札を公開する
    if (alive.indexOf(state.pid) !== -1 && !reveals[state.pid]) {
      const key = 'rv:' + m.id + ':' + T;
      const secret = readSecret(m.id, T);
      if (secret && !state.pending[key]) {
        state.pending[key] = true;
        state.store.set(roomPath('match/reveals/' + tk + '/' + state.pid), secret).catch(function () {
          delete state.pending[key];
        });
      }
      return;
    }

    // 勝負の解決はプレイヤーの端末が行う（観戦者は見るだけ）
    if (state.member && alive.every(function (p) { return reveals[p]; })) resolveTurn(m, T, alive, commits, reveals);
  }

  async function resolveTurn(m, T, alive, commits, reveals) {
    const key = 'rs:' + m.id + ':' + T;
    if (state.pending[key]) return;
    state.pending[key] = true;
    try {
      const plays = {};
      const fouls = [];
      for (const p of alive) {
        const rv = reveals[p] || {};
        let ok = G.CARDS.indexOf(rv.card) !== -1 && Boolean(m.hands && m.hands[p] && m.hands[p][rv.card]) && typeof rv.salt === 'string';
        if (ok) ok = (await sha256(G.commitInput(state.code, m.id, T, p, rv.card, rv.salt))) === commits[p];
        if (ok) plays[p] = rv.card; else fouls.push(p);
      }
      const res = await state.store.transaction(roomPath('match'), function (cur) {
        if (!cur) return cur;
        if (cur.id !== m.id || cur.turn !== T || G.isOver(cur)) return;
        const cr = (cur.reveals && cur.reveals[G.turnKey(T)]) || {};
        for (const p of alive) {
          if (!cr[p] || cr[p].card !== reveals[p].card || cr[p].salt !== reveals[p].salt) return;
        }
        return G.resolveTurn(cur, plays, fouls);
      });
      if (res.committed && res.value && res.value.turn === T + 1 && res.value.winner) await addWin(res.value.winner);
    } catch (e) {
      console.error(e);
      delete state.pending[key];
    }
  }

  // ---------- イベント ----------
  function handle(action, el) {
    switch (action) {
      case 'show-create': state.form.showCreate = true; render(); break;
      case 'open-rules': openSheet('rules'); break;
      case 'open-menu': openSheet('menu'); break;
      case 'open-log': openSheet('log'); break;
      case 'close-sheet': closeSheet(); break;
      case 'share': shareInvite(); break;
      case 'leave': run(leaveRoom); break;
      case 'kick': run(function () { return kick(el.dataset.pid); }); break;
      case 'forfeit': {
        const m = state.room && state.room.match;
        if (confirm(nameOf(m, el.dataset.pid) + 'さんを脱落扱いにしますか？')) run(function () { return forfeitPlayer(el.dataset.pid); });
        break;
      }
      case 'start': run(startGame); break;
      case 'next': run(function () { return nextMatch(Number(el.dataset.match)); }); break;
      case 'lobby': run(backToLobby); break;
      case 'sit-out': run(function () { return setSitOut(el.dataset.on === '1'); }); break;
      case 'opt-out': run(optOut); break;
      case 'watch-invite': run(function () { return watchRoomAs(state.invite); }); break;
      case 'watch-code': run(function () { return watchRoomAs(state.form.code); }); break;
      case 'cheer': sendCheer(el.dataset.kind); break;
      case 'reload': reloadToLatest(); break;
      case 'pick': {
        const c = el.dataset.card;
        state.selected = state.selected === c ? null : c;
        render();
        break;
      }
      case 'commit': if (state.selected) { const c = state.selected; run(function () { return playCard(c); }); } break;
      default: break;
    }
  }

  function onClick(e) {
    const t = e.target.closest('[data-action]');
    if (!t || t.disabled) return;
    e.preventDefault();
    handle(t.dataset.action, t);
  }

  app.addEventListener('click', onClick);
  sheet.addEventListener('click', function (e) {
    if (e.target === sheet) { closeSheet(); return; }
    onClick(e);
  });
  sheet.addEventListener('close', function () { state.sheetView = null; });

  app.addEventListener('input', function (e) {
    if (e.target.id === 'name') state.form.name = e.target.value;
    if (e.target.id === 'code') {
      const v = e.target.value.toUpperCase();
      state.form.code = v;
      if (e.target.value !== v) {
        const pos = e.target.selectionStart;
        e.target.value = v;
        try { e.target.setSelectionRange(pos, pos); } catch (err) { /* 無視 */ }
      }
    }
  });

  app.addEventListener('change', function (e) {
    if (e.target.id === 'target') state.form.target = clampTarget(e.target.value);
    if (e.target.id === 'lobby-target') run(function () { return setTarget(Number(e.target.value)); });
  });

  app.addEventListener('submit', function (e) {
    e.preventDefault();
    const kind = e.target.dataset.form;
    if (kind === 'create') run(createRoom);
    if (kind === 'join') run(function () { return joinRoom(state.form.code); });
    if (kind === 'invite') {
      const room = state.room;
      const canPlay = room && room.phase === 'lobby' && playersOf(room).length < clampTarget(room.target);
      run(function () { return canPlay ? joinRoom(state.invite) : watchRoomAs(state.invite); });
    }
    if (kind === 'sit') run(sitDown);
    if (kind === 'opt-in') run(optIn);
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    if (state.member || state.watching) keepAwake(true);
    checkUpdate();
  });

  // ---------- 新しい版の確認 ----------
  // GitHub Pages はファイルを10分ほどキャッシュさせるため、古い版のまま遊ぶ端末が出ないようにする。
  // version.json がこの版と違えば、対戦中でなければ自動で読み込み直し、対戦中なら上にお知らせを出す。
  function inActiveMatch() {
    const r = state.room;
    const m = r && r.match;
    return Boolean(inRoom() && r.phase === 'game' && m && !G.isOver(m) && m.alive && m.alive[state.pid]);
  }

  function reloadToLatest() {
    try { sessionStorage.setItem('redout:reloadTried', state.latestVersion || ''); } catch (e) { /* 無視 */ }
    const q = new URLSearchParams(location.search);
    q.set('v', state.latestVersion || String(Date.now()));
    location.replace(location.pathname + '?' + q.toString());
  }

  async function checkUpdate() {
    if (location.protocol === 'file:' || APP_VERSION === 'dev') return;
    try {
      const r = await fetch('version.json?ts=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      if (!j || !j.v || String(j.v) === APP_VERSION) return;
      state.latestVersion = String(j.v);
      let tried = null;
      try { tried = sessionStorage.getItem('redout:reloadTried'); } catch (e) { /* 無視 */ }
      if (!inActiveMatch() && tried !== state.latestVersion) { reloadToLatest(); return; }
      if (!state.updateAvailable) { state.updateAvailable = true; render(); }
    } catch (e) { /* オフラインなど。次の確認で再試行 */ }
  }
  setInterval(checkUpdate, 90 * 1000);

  // 公開演出のあいだに状態が変わらなくても、演出が終わったら印などを確定表示にする
  setInterval(function () {
    if (state.animAt && performance.now() - state.animAt > REVEAL_MS && performance.now() - state.animAt < REVEAL_MS + 1200) render();
  }, 500);

  // ---------- 起動 ----------
  async function init() {
    let store;
    try {
      store = await window.RedOutStore.createStore(window.FIREBASE_CONFIG);
    } catch (e) {
      console.error(e);
      app.innerHTML = '<div class="home"><h1 class="title" style="margin-top:20vh">RED OUT</h1>' +
        '<p class="notice" style="margin:24px 0 0">Firebase に接続できませんでした。firebase-config.js の値と、通信状況を確認してください。</p></div>';
      return;
    }
    state.store = store;
    state.mode = store.mode;
    // テストモードはタブごとに別のプレイヤーにするため sessionStorage を使う
    state.kv = pickStorage(store.mode === 'local' ? 'sessionStorage' : 'localStorage');
    let pid = kvGet('redout:pid');
    if (!pid) {
      pid = 'p' + randomId(11, ID_CHARS);
      kvSet('redout:pid', pid);
    }
    state.pid = pid;
    state.name = kvGet('redout:name') || longStore.getItem('redout:name') || '';

    const params = new URLSearchParams(location.search);
    if (params.has('v')) {
      params.delete('v');
      try { history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params.toString() : '')); } catch (e) { /* 無視 */ }
    }
    const code = normCode(params.get('room'));
    if (code) {
      state.invite = code;
      watchRoom(code);
    }
    render();
    checkUpdate();
  }

  init();
})();
