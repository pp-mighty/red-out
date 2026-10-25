/*
 * データ同期の窓口。
 * - Firebase の設定があれば Firebase Realtime Database を使う（オンライン対戦）
 * - なければブラウザ内（IndexedDB）を使うテストモード（同じブラウザのタブ同士だけで対戦）
 * どちらも同じ関数（on / get / set / update / remove / transaction / presence）で扱えます。
 */
(function (root) {
  'use strict';

  const FIREBASE_VERSION = '10.12.2';

  function clean(v) {
    return v === undefined ? null : JSON.parse(JSON.stringify(v));
  }

  function hasFirebaseConfig(cfg) {
    return Boolean(cfg && cfg.apiKey && cfg.databaseURL);
  }

  // ---------- Firebase ----------
  async function createFirebaseStore(cfg) {
    const base = 'https://www.gstatic.com/firebasejs/' + FIREBASE_VERSION + '/';
    const appMod = await import(base + 'firebase-app.js');
    const dbMod = await import(base + 'firebase-database.js');
    const app = appMod.initializeApp(cfg);
    const db = dbMod.getDatabase(app);
    const r = function (path) { return dbMod.ref(db, path); };
    const presenceOff = [];

    return {
      mode: 'firebase',
      on: function (path, cb) {
        return dbMod.onValue(r(path), function (s) { cb(s.val()); });
      },
      get: async function (path) {
        return (await dbMod.get(r(path))).val();
      },
      set: function (path, value) { return dbMod.set(r(path), clean(value)); },
      update: function (path, obj) { return dbMod.update(r(path), clean(obj)); },
      remove: function (path) { return dbMod.remove(r(path)); },
      transaction: async function (path, fn) {
        const res = await dbMod.runTransaction(r(path), function (cur) {
          const next = fn(cur);
          return next === undefined ? undefined : clean(next);
        });
        return { committed: res.committed, value: res.snapshot.val() };
      },
      // 接続中は true、切断されたら自動で false にする
      presence: function (path) {
        const node = r(path);
        const off = dbMod.onValue(r('.info/connected'), function (s) {
          if (s.val() !== true) return;
          dbMod.onDisconnect(node).set(false).then(function () { return dbMod.set(node, true); });
        });
        presenceOff.push(function () {
          off();
          return Promise.all([dbMod.onDisconnect(node).cancel(), dbMod.set(node, false)]);
        });
      },
      stopPresence: function () {
        const jobs = [];
        while (presenceOff.length) jobs.push(presenceOff.pop()());
        return Promise.all(jobs).catch(function () { /* 切断中でも続行 */ });
      },
      now: function () { return Date.now(); },
    };
  }

  // ---------- パス操作（テストモード用） ----------
  function parts(path) { return String(path).split('/').filter(Boolean); }
  function getAt(data, path) {
    let o = data;
    for (const k of parts(path)) {
      if (o == null || typeof o !== 'object') return null;
      o = o[k];
    }
    return o === undefined ? null : o;
  }
  function setAt(data, path, value) {
    const keys = parts(path);
    if (!keys.length) return clean(value) || {};
    if (data == null || typeof data !== 'object') data = {};
    let o = data;
    for (let i = 0; i < keys.length - 1; i++) {
      if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
      o = o[keys[i]];
    }
    const last = keys[keys.length - 1];
    if (value === null || value === undefined) delete o[last];
    else o[last] = clean(value);
    return data;
  }

  // ---------- テストモード（IndexedDB で読み書きを1件ずつ確実に処理し、BroadcastChannel で他のタブへ知らせる） ----------
  function openIdb() {
    return new Promise(function (resolve, reject) {
      const req = indexedDB.open('redout-local', 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('kv'); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  async function createLocalStore() {
    const idb = await openIdb();
    const subs = new Set();
    const bc = new BroadcastChannel('redout-local');
    const presencePaths = [];
    let cache = null;
    let version = -1;

    // 1回の読み書きを IndexedDB のトランザクションで原子的に行う
    function atomic(mutate) {
      return new Promise(function (resolve, reject) {
        const tx = idb.transaction('kv', 'readwrite');
        const st = tx.objectStore('kv');
        const g = st.get('db');
        let out = null;
        g.onsuccess = function () {
          const rec = g.result || { v: 0, data: {} };
          try {
            out = mutate(rec.data);
          } catch (e) {
            tx.abort();
            reject(e);
            return;
          }
          if (out.changed) {
            out.record = { v: rec.v + 1, data: out.data };
            st.put(out.record, 'db');
          } else {
            out.record = rec;
          }
        };
        tx.oncomplete = function () { resolve(out); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    }

    function apply(record) {
      if (!record || record.v <= version) return;
      version = record.v;
      cache = record.data;
      subs.forEach(function (s) { s.cb(clean(getAt(cache, s.path))); });
    }

    function publish(out) {
      if (out.changed) bc.postMessage(out.record);
      apply(out.record);
      return out;
    }

    function write(mutateData) {
      return atomic(function (data) { return { data: mutateData(data), changed: true }; }).then(publish);
    }

    bc.onmessage = function (e) { apply(e.data); };
    apply((await atomic(function (data) { return { data: data, changed: false }; })).record);

    window.addEventListener('pagehide', function () {
      presencePaths.forEach(function (p) {
        write(function (d) { return setAt(d, p, false); }).catch(function () { /* 閉じる途中 */ });
      });
    });

    return {
      mode: 'local',
      on: function (path, cb) {
        const s = { path: path, cb: cb };
        subs.add(s);
        setTimeout(function () { if (subs.has(s) && cache) cb(clean(getAt(cache, path))); }, 0);
        return function () { subs.delete(s); };
      },
      get: async function (path) {
        const out = await atomic(function (data) { return { data: data, changed: false }; });
        apply(out.record);
        return clean(getAt(out.record.data, path));
      },
      set: function (path, value) { return write(function (d) { return setAt(d, path, value); }); },
      update: function (path, obj) {
        return write(function (d) {
          Object.keys(obj).forEach(function (k) { d = setAt(d, path + '/' + k, obj[k]); });
          return d;
        });
      },
      remove: function (path) { return write(function (d) { return setAt(d, path, null); }); },
      transaction: async function (path, fn) {
        const out = await atomic(function (data) {
          const cur = clean(getAt(data, path));
          const next = fn(cur);
          if (next === undefined) return { data: data, changed: false, committed: false, value: cur };
          return { data: setAt(data, path, next), changed: true, committed: true, value: clean(next) };
        });
        publish(out);
        return { committed: out.committed, value: out.value };
      },
      presence: function (path) {
        presencePaths.push(path);
        write(function (d) { return setAt(d, path, true); });
      },
      stopPresence: function () {
        while (presencePaths.length) {
          const p = presencePaths.pop();
          write(function (d) { return setAt(d, p, false); });
        }
      },
      now: function () { return Date.now(); },
    };
  }

  async function createStore(cfg) {
    if (hasFirebaseConfig(cfg)) return createFirebaseStore(cfg);
    return createLocalStore();
  }

  root.RedOutStore = { createStore: createStore, hasFirebaseConfig: hasFirebaseConfig };
})(window);
