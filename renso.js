/* 連想ことば: 入力した言葉から、類語・複合語・関連語を集めて、蛍や滝で眺める。
 *
 * 取得元(差し替え・追加できる。いまは無料の2つだけ):
 *   wordnet   … 日本語WordNet(data/wnja/ の索引)。同じ語義の類語と、入力語を含む複合語
 *   wikipedia … 日本語Wikipedia(公式API)。主記事のリンクと、本文の全文検索
 * 有料のAIなどを足すときは registerProvider() で取得元を足す。無料の取得が失敗しても、自動で有料に切り替えない。
 *
 * 取得結果は、この端末の localStorage にだけ保存する(句の本文は入れない)。
 * 画面は index.html の「連想」タブから Renso.show() で出す。取得と表示は分けてある。
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Renso = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  var LOGIC_VERSION = 1;               // 取得・整理のやり方を変えたら上げる(保存済みの結果と区別するため)
  var MAX_ITEMS = 50;                  // 画面に出す語の上限(少ないときは無理に埋めない)
  var CAPS = { synonym: 12, compound: 16, related: 28 };
  var CACHE_MAX_ENTRIES = 60, CACHE_MAX_CHARS = 700000;
  var KIND_OF = { synonym: 'syn', compound: 'cmp', related: 'rel' };
  var CAT_LABEL = { synonym: '類語', compound: '複合語', related: '関連' };

  /* ---------- 小さな道具 ---------- */
  function normalizeQuery(s) { return String(s == null ? '' : s).normalize('NFKC').replace(/\s+/g, ' ').trim(); }
  function searchKey(s) { return normalizeQuery(s).toLowerCase(); }
  function dedupeKey(s) { return String(s).normalize('NFKC').replace(/[\s・･·\-]+/g, '').toLowerCase(); }   // 統合用のキーだけ。表示の表記は変えない
  function isJunkText(t) { return !t || !String(t).trim() || !/[0-9A-Za-z぀-ヿ㐀-鿿ｦ-ﾟ]/.test(t); }
  function abortError() { var e = new Error('aborted'); e.name = 'AbortError'; return e; }
  function makeErr(code, message) { var e = new Error(message); e.code = code; return e; }
  function defaultSleep(ms, signal) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) return reject(abortError());
      var t = setTimeout(function () { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
      function onAbort() { clearTimeout(t); reject(abortError()); }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  function shuffle(a) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  function rnd(a, b) { return a + Math.random() * (b - a); }

  /* ---------- 取得元1: 日本語WordNet ---------- */
  // 索引(data/wnja/wnja-index.json)は、開発時に tools/build_wnja_index.py で作る。
  function createWordnetProvider(opt) {
    var loadIndex = opt.loadIndex, built = null;
    function build(data) {
      var words = data.words.split('\n'), wordIdx = new Map(), wordSyn = new Array(words.length), i, j;
      for (i = 0; i < words.length; i++) { wordIdx.set(words[i], i); wordSyn[i] = []; }
      for (i = 0; i < data.syn.length; i++) { var ws = data.syn[i]; for (j = 0; j < ws.length; j++) wordSyn[ws[j]].push(i); }
      var wordFreq = new Array(words.length);
      for (i = 0; i < words.length; i++) { var f = 0; for (j = 0; j < wordSyn[i].length; j++) f = Math.max(f, data.freq[wordSyn[i][j]]); wordFreq[i] = f; }
      return { words: words, wordIdx: wordIdx, wordSyn: wordSyn, wordFreq: wordFreq, syn: data.syn, freq: data.freq, version: data.version };
    }
    return {
      id: 'wordnet', label: '日本語WordNet',
      run: function (q, ctx) {
        return Promise.resolve(built || loadIndex(ctx)).then(function (d) {
          if (!built) built = d.words && d.wordIdx ? d : build(d);
          var ix = built, items = [], notes = [], seen = new Set();
          var qi = ix.wordIdx.get(q), senses = (qi === undefined ? [] : ix.wordSyn[qi].slice());
          // 語義は、よく使われるものを先に。一つに決めつけず、全部を候補にするが、後ろの語義は少数だけ採る
          senses.sort(function (a, b) { return (ix.freq[b] - ix.freq[a]) || (ix.syn[b].length - ix.syn[a].length); });
          senses.forEach(function (si, rank) {
            var ws = ix.syn[si], pos = 0;
            ws.forEach(function (wi) {
              if (wi === qi) return;
              var w = ix.words[wi], poly = ix.wordSyn[wi].length;
              if (seen.has(w) || isJunkText(w)) return;
              if (poly > 12) return;                      // 汎用的すぎる語は出さない
              if (rank >= 2 && pos >= 3) return;          // 後ろの語義からは少数だけ
              seen.add(w); pos++;
              items.push({ text: w, category: 'synonym', source: 'wordnet', relationType: 'same-synset',
                evidence: 'wnja-' + ix.version + ' synset#' + si, sourceUrl: 'https://bond-lab.github.io/wnja/',
                score: 90 - 10 * rank - 2 * Math.min(poly - 1, 8) - 0.5 * pos + Math.min(Math.log2(1 + ix.wordFreq[wi]), 6) });
            });
          });
          // 入力語を含む複合語(見出し語の部分一致)。1文字のひらがなは対象外(ほぼ全部に当たるため)
          if (!(q.length === 1 && /[぀-ゟ]/.test(q))) {
            for (var i = 0; i < ix.words.length; i++) {
              var w2 = ix.words[i];
              if (w2 === q || w2.length < q.length || w2.indexOf(q) < 0 || seen.has(w2) || isJunkText(w2)) continue;
              var extra = w2.length - q.length; if (extra > 8) continue;
              seen.add(w2);
              items.push({ text: w2, category: 'compound', source: 'wordnet', relationType: 'contains-headword',
                evidence: '見出し語', sourceUrl: 'https://bond-lab.github.io/wnja/',
                score: 70 - 3 * extra + ((w2.indexOf(q) === 0 || w2.lastIndexOf(q) === w2.length - q.length) ? 8 : 0) + Math.min(Math.log2(1 + ix.wordFreq[i]) * 2, 10) });
            }
          }
          if (qi === undefined) notes.push('見出し語に「' + q + '」はありません(複合語だけ探しました)');
          else notes.push('語義 ' + senses.length + ' 件');
          return { items: items, meta: { notes: notes, version: ix.version, senses: senses.length }, dropped: [] };
        });
      }
    };
  }

  /* ---------- 取得元2: 日本語Wikipedia ---------- */
  var WP_BASE = 'https://ja.wikipedia.org/w/api.php';
  var WP_ART_URL = 'https://ja.wikipedia.org/wiki/';
  var SKIP_NS = /^(ファイル|File|画像|Image|Category|カテゴリ|Template|テンプレート|Wikipedia|プロジェクト|Help|ヘルプ|Portal|ポータル|特別|Special|Module|MediaWiki|Draft|:?[a-z]{2,3}(-[a-z]+)?):/i;
  var META_TITLES = new Set(['ウェイバックマシン', 'コトバンク', 'Portable Document Format', 'デジタルオブジェクト識別子', '国際標準図書番号', '日本語', 'ISBN', 'Doi']);
  var QUALIFIER_CLASS = [
    [/\((?:[^()]*)(歌手|俳優|声優|アイドル|政治家|作家|漫画家|選手|監督|タレント|お笑い|プロレスラー|騎手|棋士|ミュージシャン|YouTuber)\)$/, 'person'],
    [/\((?:[^()]*)(アルバム|曲|楽曲|シングル|映画|テレビドラマ|ドラマ|アニメ|漫画|小説|ゲーム|ミュージカル|番組|雑誌|バンド|グループ|ユニット|企業|会社)\)$/, 'work'],
    [/(のディスコグラフィ|のエピソード一覧)$/, 'work']
  ];
  var CLASS_FACTOR = { person: 0.22, work: 0.28, org: 0.7, place: 0.5, list: 0.3, chem: 0.4, unit: 0.3 };
  var CAT_RULES = [
    ['disamb', /曖昧さ回避/],
    ['list', /(^一覧$|の一覧$|^一覧)/],
    ['person', /(存命人物|[0-9]{3,4}年生|[0-9]{3,4}年没|の男性|の女性|日本の人物)/],
    ['work', /(の楽曲|のシングル|のアルバム|のテレビドラマ|のテレビアニメ|のアニメ|の映画|の小説|の漫画|のゲームソフト|のビデオゲーム|の児童文学|のミュージカル|の舞台作品|のテレビ番組|のラジオ番組|のCM|歌曲|の詩|の作品|のドラマ|の歌)/],
    ['org', /(の企業|企業|の会社|ブランド|出版社|レコードレーベル|の大学|大学$|の学校|の団体|の球団|の組織)/],
    ['place', /(の地名|の都市|の町|の村|の区$|の郡|の県|の市|行政区|の島|の河川|の山|主権国家|国際連合加盟国)/],
    ['chem', /(化合物|化学物質|アルカロイド|アミン|金属元素|元素)/],
    ['unit', /(の単位|情報量の単位|SI)/]
  ];

  function titleNoiseReason(title, q) {
    if (title === q) return '入力語そのもの';
    if (isJunkText(title)) return '記号だけ';
    if (/^\d{1,4}年$|^\d{1,2}月(\d{1,2}日)?$|^\d{1,2}日$|^\d+世紀$|^\d{3,4}年代$|^紀元前/.test(title)) return '年月日';
    if (/\(識別子\)$/.test(title) || /^(ISBN|ISSN|Doi|OCLC|PMID|Wikidata)\b/i.test(title)) return '識別子';
    if (META_TITLES.has(title)) return '管理用・汎用ページ';
    if (/\(曖昧さ回避\)$/.test(title)) return '曖昧さ回避';
    if (title.length > 18) return '長すぎる';
    if (/^[A-Za-z0-9\-.\s]+$/.test(title) && !/^[A-Za-z0-9\-.\s]+$/.test(q)) return 'ラテン文字だけ';
    return null;
  }
  function titleClasses(title) {
    var out = [];
    QUALIFIER_CLASS.forEach(function (r) { if (r[0].test(title)) out.push(r[1]); });
    if (/(一覧|年表)$|^一覧/.test(title)) out.push('list');
    return out;
  }
  function classesFromCategories(cats) {
    var out = [];
    cats.forEach(function (c) {
      var name = c.replace(/^(Category|カテゴリ):/, '');
      CAT_RULES.forEach(function (r) { if (r[1].test(name) && out.indexOf(r[0]) < 0) out.push(r[0]); });
    });
    return out;
  }

  function cleanWikitext(t) {
    t = String(t || '').replace(/<!--[\s\S]*?-->/g, '');
    t = t.replace(/<ref\b[^>]*\/>/gi, '').replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, '');
    t = t.replace(/<(gallery|math|syntaxhighlight|source|nowiki|score|imagemap)\b[\s\S]*?<\/\1>/gi, '');
    var prev, n = 0;
    do { prev = t; t = t.replace(/\{\{[^{}]*\}\}/g, ''); n++; } while (t !== prev && n < 12);   // テンプレートは内側から外す
    return t;
  }
  // 内部リンクを数える。count=本文での登場回数、lead=冒頭(最初の見出しより前)に出るか
  function parseWikiLinks(wikitext) {
    var text = cleanWikitext(wikitext), m = text.search(/^==/m), lead = m < 0 ? text : text.slice(0, m);
    function scan(s, fn) {
      var re = /\[\[([^\[\]|#\n]+)(?:#[^\[\]|\n]*)?(?:\|[^\[\]\n]*)?\]\]/g, r;
      while ((r = re.exec(s))) {
        var t = r[1].replace(/_/g, ' ').trim();
        if (!t || SKIP_NS.test(t)) continue;
        fn(t);
      }
    }
    var links = new Map();
    scan(text, function (t) { var o = links.get(t) || { count: 0, lead: false }; o.count++; links.set(t, o); });
    scan(lead, function (t) { var o = links.get(t); if (o) o.lead = true; });
    return links;
  }

  function createWikipediaProvider(opt) {
    var http = opt.http, sleep = opt.sleep || defaultSleep, now = opt.now || Date.now;
    var MIN_GAP = opt.minGap == null ? 300 : opt.minGap, lastAt = 0;

    // 1件ずつ順番に呼ぶ。混みあっているときは、指示された秒数を待って1回だけやり直す
    async function call(params, signal, notes) {
      for (var attempt = 0; attempt < 2; attempt++) {
        var gap = MIN_GAP - (now() - lastAt);
        if (gap > 0) await sleep(gap, signal);
        lastAt = now();
        var qs = Object.keys(params).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
        var r = await http(WP_BASE + '?' + qs + '&format=json&formatversion=2&origin=*', { signal: signal });
        var limited = r.status === 429 || r.status === 503 || (r.json && r.json.error && /ratelimit|maxlag/i.test(r.json.error.code || ''));
        if (limited) {
          var wait = r.retryAfter > 0 ? r.retryAfter : 5;
          if (attempt === 1 || wait > 20) throw makeErr('rate-limited', 'Wikipediaが混みあっています。しばらくしてから、もう一度お試しください');
          notes.push('混みあっているため、' + wait + '秒待ってやり直しました');
          await sleep(wait * 1000, signal);
          continue;
        }
        if (!r.ok || !r.json) throw makeErr('http', 'Wikipediaから応答がありません(HTTP ' + r.status + ')');
        if (r.json.error) throw makeErr('api', 'Wikipediaのエラー: ' + (r.json.error.info || r.json.error.code));
        return r.json;
      }
    }

    async function fetchPage(title, signal, notes) {
      var j = await call({ action: 'query', titles: title, redirects: 1, prop: 'pageprops|revisions', ppprop: 'disambiguation',
        rvprop: 'content', rvslots: 'main' }, signal, notes);
      var pg = j.query && j.query.pages && j.query.pages[0];
      if (!pg || pg.missing || pg.invalid) return { status: 'missing' };
      var rev = pg.revisions && pg.revisions[0], content = rev && rev.slots && rev.slots.main && rev.slots.main.content || '';
      var red = (j.query.redirects || [])[0];
      return { status: pg.pageprops && ('disambiguation' in pg.pageprops) ? 'disambiguation' : 'found',
        title: pg.title, wikitext: content, redirectedFrom: red ? red.from : null };
    }

    // 入力語に対応する記事を探す。リダイレクトは自動でたどる。見つからないときは、表記ゆれ(近い一致)だけを試す
    async function resolveArticle(q, signal, notes) {
      var p = await fetchPage(q, signal, notes);
      if (p.status !== 'missing') return p;
      var j = await call({ action: 'query', list: 'search', srsearch: q, srwhat: 'nearmatch', srlimit: 5, srnamespace: 0, srprop: '' }, signal, notes);
      var hits = (j.query && j.query.search || []).map(function (h) { return h.title; });
      var pick = hits.filter(function (t) { return dedupeKey(t) === dedupeKey(q); })[0];
      if (!pick) return { status: 'missing', nearHits: hits };
      var p2 = await fetchPage(pick, signal, notes);
      if (p2.status !== 'missing') p2.redirectedFrom = p2.redirectedFrom || q;
      return p2;
    }

    // 候補の記事ごとに、(1)カテゴリ(人物・作品などの種類)と、(2)元の記事へリンクを返しているか(相互リンク)を、50件ずつまとめて調べる
    async function classify(titles, mainTitle, signal, notes) {
      var out = new Map();
      for (var i = 0; i < titles.length; i += 50) {
        var chunk = titles.slice(i, i + 50), cont = null, pass = 0;
        do {
          var params = { action: 'query', prop: mainTitle ? 'categories|links' : 'categories', clshow: '!hidden', cllimit: 'max', titles: chunk.join('|') };
          if (mainTitle) { params.pltitles = mainTitle; params.pllimit = 'max'; params.plnamespace = 0; }
          if (cont) Object.keys(cont).forEach(function (k) { params[k] = cont[k]; });
          var j = await call(params, signal, notes);
          (j.query && j.query.pages || []).forEach(function (pg) {
            var o = out.get(pg.title) || { cats: [], back: false };
            (pg.categories || []).forEach(function (c) { o.cats.push(c.title); });
            (pg.links || []).forEach(function (l) { if (l.title === mainTitle) o.back = true; });
            out.set(pg.title, o);
          });
          cont = j.continue || null; pass++;
        } while (cont && pass < 2);
      }
      return out;
    }

    return {
      id: 'wikipedia', label: '日本語Wikipedia',
      run: async function (q, ctx) {
        var signal = ctx && ctx.signal, notes = [], dropped = [], pool = new Map();
        function drop(text, reason, how) { if (dropped.length < 600) dropped.push({ text: text, source: 'wikipedia', reason: reason, how: how }); }
        function ensure(t) { var o = pool.get(t); if (!o) { o = { text: t, link: null, hit: null }; pool.set(t, o); } return o; }

        // (1) 主記事と、そのリンク
        var art = await resolveArticle(q, signal, notes);
        var mainTitle = art.title || null, mainStatus = art.status;
        var linkTotal = 0;
        if (art.status === 'found' || art.status === 'disambiguation') {
          var links = parseWikiLinks(art.wikitext); linkTotal = links.size;
          var pos = 0;
          links.forEach(function (v, t) {
            pos++;
            var why = titleNoiseReason(t, q); if (why) { drop(t, why, '記事内リンク'); return; }
            ensure(t).link = { count: v.count, lead: v.lead, disamb: art.status === 'disambiguation', pos: pos };
          });
          if (art.redirectedFrom) {
            notes.push('「' + art.redirectedFrom + '」は記事「' + art.title + '」に転送されます');
            if (art.title !== q && !titleNoiseReason(art.title, q)) ensure(art.title).link = { count: 1, lead: true, redirect: true };
          }
          if (art.status === 'disambiguation') notes.push('「' + art.title + '」は曖昧さ回避ページです(主記事は決めず、載っている項目を候補にしました)');
        } else {
          notes.push('「' + q + '」に対応する記事が見つかりません' + (art.nearHits && art.nearHits.length ? '(近い名前: ' + art.nearHits.slice(0, 3).join('、') + ')' : ''));
        }

        // (2) 本文の全文検索(説明文に入力語が出てくる項目の見出しを拾う逆引き)
        var sj = await call({ action: 'query', list: 'search', srsearch: '"' + q.replace(/"/g, '') + '"', srlimit: 50, srnamespace: 0, srprop: 'snippet' }, signal, notes);   // 入力語そのものを含む記事だけ(文字ごとに分けて検索させない)
        var hitCount = 0;
        (sj.query && sj.query.search || []).forEach(function (h, rank) {
          hitCount++;
          if (h.title === mainTitle) return;
          var why = titleNoiseReason(h.title, q); if (why) { drop(h.title, why, '全文検索'); return; }
          var sn = String(h.snippet || ''), matches = (sn.match(/searchmatch/g) || []).length;
          ensure(h.title).hit = { rank: rank, matches: matches };
        });
        var total = sj.query && sj.query.searchinfo && sj.query.searchinfo.totalhits;
        notes.push('主記事のリンク ' + linkTotal + ' 件 / 全文検索 ' + hitCount + ' 件' + (total ? '(全体で' + total + '件)' : ''));

        // (3) 仮の点数 → 上位149件(と主記事)は、カテゴリ(人物・作品・企業などの種類)と、元の記事へのリンク返し(相互リンク)を調べて、点数を調整
        var arr = Array.from(pool.values());
        arr.forEach(function (o) {
          var s = 0;
          if (o.link) {
            var strong = o.link.count >= 2 || o.link.lead || o.link.disamb;
            s = o.link.disamb ? 36 + Math.min(o.link.count, 3)
              : (strong ? 28 + Math.min(o.link.count, 8) * 5 + (o.link.lead ? 20 : 0)
                : 22 + Math.max(0, 6 - 6 * o.link.pos / Math.max(1, linkTotal)));   // 1回だけのリンクは、記事の前のほうに出るものを少し優先
          }
          if (o.hit) s = Math.max(s, 58 - o.hit.rank * 0.8 + (o.text.indexOf(q) >= 0 ? 12 : 0) + (o.hit.matches >= 2 ? 4 : 0));
          if (o.link && o.hit) s += 6;
          o.pre = s; o.classes = titleClasses(o.text);
        });
        arr.sort(function (a, b) { return b.pre - a.pre; });
        var toClassify = arr.slice(0, 149).map(function (o) { return o.text; });
        if (mainTitle) toClassify.unshift(mainTitle);
        var info = await classify(toClassify, art.status === 'found' ? mainTitle : null, signal, notes).catch(function (e) {
          if (e && e.name === 'AbortError') throw e;
          notes.push('種類と相互リンクの判定ができませんでした(' + (e.message || e) + ')'); return new Map();
        });
        var mainClasses = (mainTitle && info.get(mainTitle)) ? classesFromCategories(info.get(mainTitle).cats) : [];
        var items = [], backCount = 0;
        arr.forEach(function (o) {
          var how = o.link ? '記事内リンク' : '全文検索', inf = info.get(o.text), cls = o.classes.slice();
          if (inf) classesFromCategories(inf.cats).forEach(function (c) { if (cls.indexOf(c) < 0) cls.push(c); });
          if (cls.indexOf('disamb') >= 0) { drop(o.text, '曖昧さ回避ページ', how); return; }
          var weakLink = o.link && !o.hit && !(o.link.count >= 2 || o.link.lead || o.link.disamb);
          if (!inf && weakLink) { drop(o.text, '記事内で1回だけで、判定の対象外(上位149件の外)', how); return; }
          var f = 1;
          cls.forEach(function (c) { if (mainClasses.indexOf(c) < 0 && CLASS_FACTOR[c]) f = Math.min(f, CLASS_FACTOR[c]); });   // 入力自体が人物・作品などなら、その種類は下げない
          if (!inf) f *= 0.9;
          var back = !!(inf && inf.back); if (back) backCount++;
          var score = (o.pre + (back ? 14 : 0)) * f;
          if (score < 26) { drop(o.text, '関連が弱い(点数 ' + score.toFixed(0) + (back ? '' : '・相互リンクなし') + ')' + (cls.length ? '・種類: ' + cls.join('/') : ''), how); return; }
          var contains = o.text.indexOf(q) >= 0;
          var rel = o.link && o.link.lead ? 'lead-link' : (o.link ? (o.link.disamb ? 'disambiguation-link' : 'article-link') : 'fulltext-hit');
          items.push({ text: o.text, category: contains ? 'compound' : 'related', source: 'wikipedia', relationType: rel,
            evidence: (o.link ? '記事内で' + o.link.count + '回' + (o.link.lead ? '(冒頭)' : '') : '') + (o.hit ? (o.link ? ' / ' : '') + '全文検索' + (o.hit.rank + 1) + '位' : '') + (back ? ' / 相互リンクあり' : '') + (cls.length ? ' / 種類:' + cls.join('/') : ''),
            sourceUrl: o.link && !o.hit ? WP_ART_URL + encodeURIComponent(mainTitle) : WP_ART_URL + encodeURIComponent(o.text), score: score });
        });
        if (art.status === 'found') notes.push('元の記事へリンクを返している記事 ' + backCount + ' 件');
        items.sort(function (a, b) { return b.score - a.score; });
        items.slice(90).forEach(function (i) { drop(i.text, '件数の上限で省略(点数 ' + i.score.toFixed(0) + ')', i.relationType); });   // 種類ごとの上限は、統合のときにかける
        return { items: items.slice(0, 90), meta: { notes: notes, mainTitle: mainTitle, mainStatus: mainStatus, links: linkTotal, hits: hitCount }, dropped: dropped };
      }
    };
  }

  /* ---------- 取得元の登録 ---------- */
  var registry = [];
  function registerProvider(p) {
    registry = registry.filter(function (x) { return x.id !== p.id; });
    registry.push(p);
  }

  /* ---------- 統合 ---------- */
  // 同じ語を統合し、取得元と根拠は残す。点数は内部の優先順位で、確率ではない
  function mergeCandidates(q, results) {
    var map = new Map();
    results.forEach(function (res) {
      (res.items || []).forEach(function (it) {
        var text = String(it.text).trim(), key = dedupeKey(text);
        if (isJunkText(text) || key === dedupeKey(q)) return;
        var cur = map.get(key);
        var rel = { source: it.source, type: it.relationType, evidence: it.evidence || '', url: it.sourceUrl || '' };
        if (!cur) {
          map.set(key, { text: text, category: it.category, sources: [it.source], sourceUrls: it.sourceUrl ? [it.sourceUrl] : [],
            relationType: it.relationType, relations: [rel], score: it.score });
          return;
        }
        if (cur.sources.indexOf(it.source) < 0) { cur.sources.push(it.source); cur.score += 6; }
        if (it.sourceUrl && cur.sourceUrls.indexOf(it.sourceUrl) < 0) cur.sourceUrls.push(it.sourceUrl);
        cur.relations.push(rel);
        var pri = { synonym: 3, compound: 2, related: 1 };
        if (pri[it.category] > pri[cur.category]) cur.category = it.category;
        if (it.score > cur.score - 6 * (cur.sources.length - 1)) { cur.relationType = it.relationType; if (it.source === 'wordnet') cur.text = text; }
        cur.score = Math.max(cur.score, it.score + 6 * (cur.sources.length - 1));
      });
    });
    var byCat = { synonym: [], compound: [], related: [] };
    map.forEach(function (v) { byCat[v.category].push(v); });
    var out = [];
    Object.keys(byCat).forEach(function (c) {
      byCat[c].sort(function (a, b) { return b.score - a.score; });
      out = out.concat(byCat[c].slice(0, CAPS[c]));
    });
    out.sort(function (a, b) { return b.score - a.score; });
    out = out.slice(0, MAX_ITEMS);
    out.forEach(function (it, i) { it.weight = i < out.length * 0.25 ? 3 : (i < out.length * 0.65 ? 2 : 1); it.score = Math.round(it.score * 10) / 10; });
    return out;
  }

  // 検索1回分: 取得元を順に呼び、どれかが失敗しても、残りで続ける
  async function search(query, opts) {
    opts = opts || {};
    var q = normalizeQuery(query), ctx = { signal: opts.signal }, providers = opts.providers || registry;
    var results = [], meta = { providers: {}, failures: [] }, dropped = [];
    for (var i = 0; i < providers.length; i++) {
      var p = providers[i];
      if (opts.signal && opts.signal.aborted) throw abortError();
      if (opts.onProgress) opts.onProgress(p);
      try {
        var r = await p.run(q, ctx);
        results.push(r);
        meta.providers[p.id] = { ok: true, label: p.label, count: r.items.length, notes: (r.meta && r.meta.notes) || [], info: r.meta || {} };
        (r.dropped || []).forEach(function (d) { dropped.push(d); });
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        meta.providers[p.id] = { ok: false, label: p.label, count: 0, error: (e && e.message) || String(e), code: e && e.code };
        meta.failures.push({ id: p.id, label: p.label, message: (e && e.message) || String(e) });
      }
    }
    var items = mergeCandidates(q, results);
    return { query: q, key: searchKey(q), logicVersion: LOGIC_VERSION, fetchedAt: Date.now(), items: items,
      meta: meta, partial: meta.failures.length > 0, dropped: dropped };
  }

  /* ---------- 端末への保存(localStorage) ---------- */
  function createCache(storage) {
    var IDX = 'senryu-renso-idx', PRE = 'senryu-renso-c:';
    function readIdx() { try { return JSON.parse(storage.getItem(IDX) || '[]') || []; } catch (e) { return []; } }
    function writeIdx(a) { try { storage.setItem(IDX, JSON.stringify(a)); } catch (e) { /* 保存できなくても動く */ } }
    function keyOf(q) { return searchKey(q) + '|v' + LOGIC_VERSION; }
    return {
      keyOf: keyOf,
      get: function (q) {
        var k = keyOf(q);
        try { var s = storage.getItem(PRE + k); if (!s) return null; var o = JSON.parse(s); o.fromCache = true; return o; } catch (e) { return null; }
      },
      put: function (res) {
        var k = keyOf(res.query), slim = { query: res.query, key: res.key, logicVersion: res.logicVersion, fetchedAt: res.fetchedAt,
          items: res.items, partial: res.partial,
          meta: { failures: res.meta.failures, providers: Object.keys(res.meta.providers).reduce(function (o, id) { var m = res.meta.providers[id]; o[id] = { ok: m.ok, label: m.label, count: m.count, notes: m.notes, error: m.error }; return o; }, {}) } };
        var s = JSON.stringify(slim);
        try {
          storage.setItem(PRE + k, s);
          var idx = readIdx().filter(function (e) { return e.k !== k; });
          idx.push({ k: k, q: res.query, at: res.fetchedAt, n: s.length });
          // 古いものから消して、件数と容量を保つ
          idx.sort(function (a, b) { return a.at - b.at; });
          var sum = idx.reduce(function (t, e) { return t + e.n; }, 0);
          while (idx.length > 1 && (idx.length > CACHE_MAX_ENTRIES || sum > CACHE_MAX_CHARS)) { var old = idx.shift(); sum -= old.n; try { storage.removeItem(PRE + old.k); } catch (e) { /* 無視 */ } }
          writeIdx(idx);
          return true;
        } catch (e) { return false; }
      },
      list: function () { return readIdx().sort(function (a, b) { return b.at - a.at; }); },
      stats: function () { var a = readIdx(); return { count: a.length, chars: a.reduce(function (t, e) { return t + e.n; }, 0) }; },
      clear: function () { readIdx().forEach(function (e) { try { storage.removeItem(PRE + e.k); } catch (x) { /* 無視 */ } }); writeIdx([]); }
    };
  }

  /* ---------- 画面(ブラウザだけ) ---------- */
  var CSS = [
    '.rs-wrap{--rs-syn:var(--indigo-ink);--rs-cmp:#3D7A4A;--rs-rel:var(--hanko);margin-top:18px;}',
    '@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .rs-wrap{--rs-cmp:#8CCB9B;--rs-rel:#E0877B;}}',
    ':root[data-theme="dark"] .rs-wrap{--rs-cmp:#8CCB9B;--rs-rel:#E0877B;}',
    '.rs-lead{font-size:13px;color:var(--ink-soft);margin:0 0 12px;}',
    '.rs-form{display:flex;gap:8px;}',
    '.rs-form input{flex:1;min-width:0;border:.5px solid var(--paper-edge);border-radius:20px;background:var(--paper);color:var(--ink);padding:9px 16px;font-size:16px;font-family:inherit;}',
    '.rs-form input:focus{outline:2px solid var(--indigo);outline-offset:1px;}',
    '.rs-choice{margin-top:10px;padding:10px 14px;border:.5px solid var(--paper-edge);border-radius:10px;background:var(--paper);font-size:13px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;}',
    '.rs-choice[hidden]{display:none;}',
    '.rs-choice span.t{flex-basis:100%;color:var(--ink-soft);}',
    '.rs-saved{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:10px;font-size:12px;color:var(--ink-soft);}',
    '.rs-chip{font:inherit;font-size:13px;padding:5px 12px;border-radius:16px;cursor:pointer;background:var(--paper);border:.5px solid var(--paper-edge);color:var(--ink);}',
    '.rs-bar{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;margin-top:14px;}',
    '.rs-legend{display:flex;gap:14px;font-size:12px;color:var(--ink-soft);flex-wrap:wrap;}',
    '.rs-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;}',
    '.rs-dot.syn{background:var(--rs-syn);}.rs-dot.cmp{background:var(--rs-cmp);}.rs-dot.rel{background:var(--rs-rel);}',
    '.rs-stage{position:relative;height:min(68vh,540px);min-height:400px;margin-top:10px;overflow:hidden;background:var(--paper);border:.5px solid var(--paper-edge);border-radius:12px;touch-action:manipulation;-webkit-user-select:none;user-select:none;}',
    '.rs-stage.night{background:#0E1424;border-color:#222B46;}',
    '.rs-layer{position:absolute;inset:0;}',
    '.rs-layer.fall{-webkit-mask-image:linear-gradient(to bottom,transparent,#000 12%,#000 88%,transparent);mask-image:linear-gradient(to bottom,transparent,#000 12%,#000 88%,transparent);}',
    '.rs-msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;font-size:14px;line-height:1.8;color:var(--ink-soft);pointer-events:none;}',
    '.rs-night .rs-msg{color:#9FB0D0;}',
    '.rs-msg.busy::after{content:"…";display:inline-block;animation:rsb 1.4s ease-in-out infinite;}',
    '@keyframes rsb{0%,100%{opacity:.2}50%{opacity:1}}',
    '.rs-status{font-size:12px;color:var(--ink-soft);margin:8px 2px 0;min-height:18px;line-height:1.6;}',
    '.rs-status .warn{color:var(--hanko);}',
    '.rs-w{position:absolute;left:0;top:0;padding:4px 6px;line-height:1.2;white-space:nowrap;cursor:pointer;font-family:"Shippori Mincho","Hiragino Mincho ProN","Yu Mincho",serif;-webkit-tap-highlight-color:transparent;will-change:transform,opacity;}',
    '.rs-w.syn{color:var(--rs-syn);font-weight:700;}.rs-w.cmp{color:var(--rs-cmp);font-weight:700;}.rs-w.rel{color:var(--rs-rel);font-weight:500;}',
    '.rs-w.kept{text-decoration:underline;text-decoration-thickness:2px;text-underline-offset:5px;opacity:1 !important;}',
    '.rs-v{writing-mode:vertical-rl;text-orientation:mixed;}',
    '.rs-night .rs-w.syn{color:#D8F07A;text-shadow:0 0 10px #B8E04A,0 0 22px #7FB02A;}',
    '.rs-night .rs-w.cmp{color:#8BE0B8;text-shadow:0 0 10px #4CC48C;}',
    '.rs-night .rs-w.rel{color:#BBD3FF;text-shadow:0 0 10px #6FA0FF;}',
    '.rs-fly{position:absolute;width:3px;height:3px;border-radius:50%;background:#D8F07A;box-shadow:0 0 8px 2px #B8E04A;opacity:0;animation:rsf 7s ease-in-out infinite;pointer-events:none;}',
    '@keyframes rsf{0%,100%{opacity:0;transform:translate(0,0);}40%,60%{opacity:.9;}50%{transform:translate(16px,-22px);}}',
    '@media (prefers-reduced-motion:reduce){.rs-fly{animation:none;opacity:.6;}.rs-msg.busy::after{animation:none;}}',
    '.rs-keptbox{margin-top:16px;}.rs-keptbox h3{font-family:"Shippori Mincho",serif;font-size:14px;margin:0 0 8px;}',
    '.rs-kept{display:flex;flex-wrap:wrap;gap:8px;min-height:36px;align-items:center;}',
    '.rs-hint{font-size:12px;color:var(--ink-soft);}',
    '.rs-keptact{margin-top:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:12px;color:var(--ink-soft);}',
    '.rs-kchip{font:inherit;font-family:"Shippori Mincho",serif;font-size:14px;padding:6px 12px;border-radius:16px;cursor:pointer;background:var(--paper);border:1px solid currentColor;}',
    '.rs-kchip.syn{color:var(--rs-syn);font-weight:700;}.rs-kchip.cmp{color:var(--rs-cmp);font-weight:700;}.rs-kchip.rel{color:var(--rs-rel);}',
    '.rs-src,.rs-dev{margin-top:18px;border-top:.5px solid var(--line);padding-top:10px;font-size:12px;color:var(--ink-soft);line-height:1.8;}',
    '.rs-src>summary,.rs-dev>summary{cursor:pointer;font-size:13px;}',
    '.rs-src a,.rs-dev a{color:var(--indigo-ink);}',
    '.rs-table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px;}',
    '.rs-table th,.rs-table td{border-bottom:.5px solid var(--line);padding:3px 6px;text-align:left;vertical-align:top;}',
    '.rs-tablewrap{overflow-x:auto;}',
    '.rs-dev input{border:.5px solid var(--paper-edge);border-radius:8px;background:var(--field);color:var(--ink);padding:5px 10px;font-size:13px;font-family:inherit;}'
  ].join('\n');

  var hooks = {};    // index.html から渡される処理(単語メモへの保存など)
  var ui = null;     // 画面の部品と状態
  var shown = false;
  var storage = (function () { try { return root.localStorage; } catch (e) { return null; } })();
  var cache = createCache(storage || { getItem: function () { return null; }, setItem: function () { throw new Error('no storage'); }, removeItem: function () { } });
  var reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function browserHttp(url, o) {
    return fetch(url, { signal: o && o.signal, headers: { Accept: 'application/json' } }).then(function (res) {
      var ra = res.headers.get('Retry-After');
      return res.json().catch(function () { return null; }).then(function (j) {
        return { status: res.status, ok: res.ok, retryAfter: ra ? parseInt(ra, 10) : null, json: j };
      });
    });
  }
  var wnPromise = null;
  function loadWordnetIndex(ctx) {
    if (!wnPromise) {
      wnPromise = fetch('data/wnja/wnja-index.json', { signal: ctx && ctx.signal }).then(function (r) {
        if (!r.ok) throw makeErr('wordnet-load', '日本語WordNetの索引を読み込めません(HTTP ' + r.status + ')');
        return r.json();
      }).catch(function (e) { wnPromise = null; if (e && e.name === 'AbortError') throw e; throw e.code ? e : makeErr('wordnet-load', '日本語WordNetの索引を読み込めません(' + (e.message || e) + ')'); });
    }
    return wnPromise;
  }
  function ensureProviders() {
    if (registry.length) return;
    registerProvider(createWordnetProvider({ loadIndex: loadWordnetIndex }));
    registerProvider(createWikipediaProvider({ http: browserHttp }));
  }

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function fmtTime(ms) { var d = new Date(ms), p = function (n) { return (n < 10 ? '0' : '') + n; }; return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + d.getHours() + ':' + p(d.getMinutes()); }

  function buildUI(container) {
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    var wrap = el('div', 'rs-wrap');
    wrap.innerHTML =
      '<p class="rs-lead">言葉を入れて「探す」を押すと、類語・複合語・関連する言葉が、蛍や滝になって現れます。そこから先の連想は、ご自身で。</p>' +
      '<form class="rs-form" autocomplete="off"><input type="text" id="rsInput" maxlength="30" placeholder="言葉を入れる(例: 雨)" enterkeyhint="search" aria-label="探す言葉"><button class="btn primary" type="submit" id="rsGo">探す</button></form>' +
      '<div class="rs-choice" id="rsChoice" hidden></div>' +
      '<div class="rs-saved" id="rsSaved"></div>' +
      '<div class="rs-bar"><div class="pillrow" id="rsModes"></div><div class="rs-legend"><span><i class="rs-dot syn"></i>類語</span><span><i class="rs-dot cmp"></i>複合語</span><span><i class="rs-dot rel"></i>関連</span></div></div>' +
      '<div class="rs-stage" id="rsStage" aria-label="言葉が現れる舞台"><div class="rs-layer" id="rsLayer"></div><div class="rs-msg" id="rsMsg"></div></div>' +
      '<div class="rs-status" id="rsStatus" role="status"></div>' +
      '<div class="rs-keptbox"><h3>残した言葉</h3><div class="rs-kept" id="rsKept"></div><div class="rs-keptact" id="rsKeptAct"></div></div>' +
      '<details class="rs-src"><summary>出典とライセンス</summary>' +
        '<p>類語・複合語: 日本語ワードネット (2.1版) © 2009-2011 NICT, 2012-2015 Francis Bond and 2016-2026 Francis Bond, Takayuki Kuribayashi linked to <a href="https://bond-lab.github.io/wnja/index.ja.html" target="_blank" rel="noopener">https://bond-lab.github.io/wnja/index.ja.html</a>。ライセンス全文は <a href="data/wnja/LICENSE-wnja.txt" target="_blank" rel="noopener">LICENSE-wnja.txt</a>、説明は <a href="data/wnja/NOTICE.md" target="_blank" rel="noopener">NOTICE.md</a>。配布元は、データの約5%に誤りがあり得ると注記しています。</p>' +
        '<p>関連語: <a href="https://ja.wikipedia.org/" target="_blank" rel="noopener">日本語Wikipedia</a> の記事名・記事内のリンク・検索結果から選んでいます。記事の文章は <a href="https://creativecommons.org/licenses/by-sa/4.0/deed.ja" target="_blank" rel="noopener">CC BY-SA 4.0</a> で提供されています。各記事の履歴(執筆者)は、記事のページで確認できます。</p>' +
      '</details>' +
      '<details class="rs-dev" id="rsDev"><summary>開発用: 取得内容を確認する</summary><div id="rsDevBody"></div></details>';
    container.appendChild(wrap);

    ui = { wrap: wrap, input: wrap.querySelector('#rsInput'), go: wrap.querySelector('#rsGo'), choice: wrap.querySelector('#rsChoice'),
      saved: wrap.querySelector('#rsSaved'), modes: wrap.querySelector('#rsModes'), stage: wrap.querySelector('#rsStage'),
      layer: wrap.querySelector('#rsLayer'), msg: wrap.querySelector('#rsMsg'), status: wrap.querySelector('#rsStatus'),
      keptBox: wrap.querySelector('#rsKept'), keptAct: wrap.querySelector('#rsKeptAct'), dev: wrap.querySelector('#rsDev'), devBody: wrap.querySelector('#rsDevBody'),
      mode: 'firefly', current: null, runId: 0, abort: null, raf: 0, running: false, kept: new Map(), resizeTimer: 0, lastW: 0, lastH: 0 };

    [['firefly', '蛍'], ['fall', '滝']].forEach(function (m) {
      var b = el('span', 'pill' + (m[0] === ui.mode ? ' active' : ''), m[1]); b.dataset.k = m[0];
      b.onclick = function () { ui.mode = m[0]; ui.modes.querySelectorAll('.pill').forEach(function (x) { x.classList.toggle('active', x.dataset.k === ui.mode); }); startPattern(); };
      ui.modes.appendChild(b);
    });
    wrap.querySelector('.rs-form').addEventListener('submit', function (e) { e.preventDefault(); onSubmit(); });
    ui.dev.addEventListener('toggle', function () { if (ui.dev.open) renderDev(); });
    if (window.ResizeObserver) {
      new ResizeObserver(function () {
        clearTimeout(ui.resizeTimer);
        ui.resizeTimer = setTimeout(function () {
          if (!shown || !ui.current) return;
          var w = ui.stage.clientWidth, h = ui.stage.clientHeight;
          if (w > 0 && (Math.abs(w - ui.lastW) > 2 || Math.abs(h - ui.lastH) > 2)) startPattern();
        }, 200);
      }).observe(ui.stage);
    }
    renderKept(); renderSaved(); setMsg('言葉を入れて「探す」を押してください');
  }

  function setMsg(text, busy) { ui.msg.textContent = text || ''; ui.msg.classList.toggle('busy', !!busy); ui.msg.style.display = text ? '' : 'none'; }
  function setStatus(html) { ui.status.innerHTML = ''; if (html) (Array.isArray(html) ? html : [html]).forEach(function (n) { ui.status.appendChild(typeof n === 'string' ? document.createTextNode(n) : n); }); }

  function renderSaved() {
    ui.saved.innerHTML = '';
    var list = cache.list().filter(function (e) { return e.k.slice(-('|v' + LOGIC_VERSION).length) === '|v' + LOGIC_VERSION; });
    if (!list.length) return;
    ui.saved.appendChild(document.createTextNode('保存済み:'));
    list.slice(0, 12).forEach(function (e) {
      var b = el('button', 'rs-chip', e.q); b.type = 'button'; b.title = '保存済みの結果を、もう一度眺める';
      b.onclick = function () { ui.input.value = e.q; viewCached(e.q); };
      ui.saved.appendChild(b);
    });
  }

  function onSubmit() {
    var q = normalizeQuery(ui.input.value);
    ui.choice.hidden = true;
    if (!q) { setMsg('言葉を入れてください'); return; }
    if (isJunkText(q)) { setMsg('文字や数字を含む言葉を入れてください'); return; }
    var hit = cache.get(q);
    if (!hit) { fetchFresh(q); return; }
    // 保存済みの言葉: 通信しないで眺めるか、取り直すかを選ぶ(候補は見せない)
    ui.choice.innerHTML = '';
    ui.choice.appendChild(el('span', 't', '「' + q + '」は保存済みです(取得 ' + fmtTime(hit.fetchedAt) + (hit.partial ? '・一部の取得元は失敗していました' : '') + ')。'));
    var a = el('button', 'btn primary', 'もう一度眺める'); a.type = 'button'; a.onclick = function () { ui.choice.hidden = true; viewCached(q); };
    var b = el('button', 'btn', '再取得'); b.type = 'button'; b.onclick = function () { ui.choice.hidden = true; fetchFresh(q); };
    ui.choice.appendChild(a); ui.choice.appendChild(b); ui.choice.hidden = false;
  }

  function viewCached(q) {
    var hit = cache.get(q);
    if (!hit) { fetchFresh(q); return; }
    ui.runId++; if (ui.abort) ui.abort.abort();
    present(hit);
  }

  async function fetchFresh(q) {
    ensureProviders();
    var my = ++ui.runId; if (ui.abort) ui.abort.abort();
    ui.abort = typeof AbortController !== 'undefined' ? new AbortController() : { signal: undefined, abort: function () { } };
    stopPattern(); ui.current = null; setStatus(''); setMsg('言葉を集めています', true);
    try {
      var res = await search(q, { signal: ui.abort.signal, onProgress: function (p) { if (my === ui.runId) setMsg(p.label + ' から集めています', true); } });
      if (my !== ui.runId) return;           // 新しい入力に切り替わったあとの古い結果は、使わない
      var okCount = Object.keys(res.meta.providers).filter(function (id) { return res.meta.providers[id].ok; }).length;
      if (!res.items.length) {
        ui.current = res; renderDev();
        if (!okCount) { setMsg('どの取得元からも取得できませんでした。通信を確認して、もう一度お試しください'); setStatus(failNodes(res)); }
        else { setMsg('「' + res.query + '」では、候補が見つかりませんでした'); setStatus(failNodes(res, true)); }
        return;
      }
      if (okCount) cache.put(res);
      renderSaved(); present(res);
    } catch (e) {
      if (my !== ui.runId || (e && e.name === 'AbortError')) return;
      setMsg('取得中に問題が起きました: ' + ((e && e.message) || e));
    }
  }

  function failNodes(res, okOnly) {
    var nodes = [], ids = Object.keys(res.meta.providers);
    ids.forEach(function (id) {
      var m = res.meta.providers[id];
      var s = el('div', m.ok && !m.error ? '' : 'warn', m.label + ': ' + (m.ok ? m.count + '語' + ((m.notes && m.notes[0]) ? '(' + m.notes.join(' / ') + ')' : '') : '取得できませんでした(' + m.error + ')'));
      nodes.push(s);
    });
    return nodes;
  }

  function present(res) {
    ui.current = res; ui.input.value = res.query;
    var counts = { synonym: 0, compound: 0, related: 0 }; res.items.forEach(function (i) { counts[i.category]++; });
    var nodes = [res.items.length + '語(類語' + counts.synonym + '・複合語' + counts.compound + '・関連' + counts.related + ')。' +
      (res.fromCache ? '保存済みの結果です(取得 ' + fmtTime(res.fetchedAt) + ')。' : '取得 ' + fmtTime(res.fetchedAt) + '。')];
    var provs = res.meta.providers || {};
    Object.keys(provs).forEach(function (id) { var m = provs[id]; if (!m.ok) nodes.push(el('div', 'warn', m.label + 'は取得できませんでした(' + m.error + ')。再取得で試せます。')); });
    if (res.items.length < 10) nodes.push(el('div', '', '候補が少ない言葉でした。無理に増やさず、取得できた分だけ出しています。'));
    setStatus(nodes); setMsg('');
    if (ui.dev.open) renderDev();
    startPattern();
  }

  function toggleKeep(o) {
    if (ui.kept.has(o.t)) ui.kept.delete(o.t); else ui.kept.set(o.t, { kind: o.kind, from: ui.current ? ui.current.query : '' });
    ui.stage.querySelectorAll('.rs-w[data-t]').forEach(function (e) { e.classList.toggle('kept', ui.kept.has(e.dataset.t)); });
    renderKept();
  }
  function renderKept() {
    ui.keptBox.innerHTML = ''; ui.keptAct.innerHTML = '';
    if (!ui.kept.size) { ui.keptBox.appendChild(el('span', 'rs-hint', '気に入った言葉を、タップで残せます。もう一度タップすると外れます。')); return; }
    ui.kept.forEach(function (v, t) { var c = el('button', 'rs-kchip ' + v.kind, t); c.type = 'button'; c.title = 'タップで外す'; c.onclick = function () { toggleKeep({ t: t, kind: v.kind }); }; ui.keptBox.appendChild(c); });
    if (hooks.saveWords) {   // 単語メモへ保存(index.html が用意する)
      var b = el('button', 'btn', '単語メモに保存'); b.type = 'button';
      var m = el('span', 'rs-keptmsg', '');
      b.onclick = function () {
        var list = []; ui.kept.forEach(function (v, t) { list.push({ word: t, from: v.from }); });
        var r = hooks.saveWords(list);
        m.textContent = !r ? '単語メモを読み込み中です。少し待ってから、もう一度お試しください'
          : r.added + '語を単語メモに登録しました' + (r.skipped ? '(登録済みの' + r.skipped + '語はスキップ)' : '');
      };
      ui.keptAct.appendChild(b); ui.keptAct.appendChild(m);
    }
  }
  function mk(o, vertical, sizes) {
    var e = el('span', 'rs-w ' + o.kind + (vertical ? ' rs-v' : ''), o.t);
    e.dataset.t = o.t; e.setAttribute('role', 'button'); e.tabIndex = 0; e.style.fontSize = sizes[o.w - 1] + 'px';
    if (ui.kept.has(o.t)) e.classList.add('kept');
    e.addEventListener('click', function () { toggleKeep(o); });
    e.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleKeep(o); } });
    return e;
  }
  function wordsOfCurrent() {
    return ui.current.items.map(function (i) { return { t: i.text, kind: KIND_OF[i.category], w: i.weight || 1 }; });
  }

  /* 表現1: 蛍 */
  function pFirefly(words, S) {
    var layer = ui.layer, live = [], pool = shuffle(words.slice()), pi = 0, cool = 0, i;
    var target = Math.max(1, Math.min(11, Math.round(S.w * S.h / 16000), Math.max(1, words.length - 1)));
    for (i = 0; i < 14; i++) { var f = el('i', 'rs-fly'); f.style.left = rnd(4, 96) + '%'; f.style.top = rnd(4, 96) + '%'; f.style.animationDelay = rnd(0, 7) + 's'; f.style.animationDuration = rnd(5, 9) + 's'; layer.appendChild(f); }
    function next() {   // いま出ていない語を、順番に
      for (var k = 0; k < pool.length; k++) {
        if (pi >= pool.length) { pool = shuffle(words.slice()); pi = 0; }
        var o = pool[pi++];
        if (!live.some(function (d) { return d.o.t === o.t; })) return o;
      }
      return null;
    }
    function paint(d) {
      var u = d.age / d.life, op = u < .25 ? u / .25 : (u > .7 ? Math.max(0, (1 - u) / .3) : 1);
      d.e.style.opacity = op.toFixed(3);
      d.e.style.transform = 'translate(' + (d.x + d.dx * u) + 'px,' + (d.y + d.dy * u) + 'px) translate(-50%,-50%)';
    }
    function spawn(age) {
      var o = next(); if (!o) return;
      var e = mk(o, false, [15, 19, 23]); e.style.opacity = '0'; layer.appendChild(e);
      var w = e.offsetWidth, h = e.offsetHeight, best = null;
      for (var k = 0; k < 12; k++) {
        var x = rnd(w / 2 + 8, Math.max(w / 2 + 9, S.w - w / 2 - 8)), y = rnd(h / 2 + 8, Math.max(h / 2 + 9, S.h - h / 2 - 8));
        var ok = live.every(function (l) { return Math.abs(l.x - x) > (l.w + w) / 2 + 10 || Math.abs(l.y - y) > (l.h + h) / 2 + 14; });
        if (!best) best = { x: x, y: y }; if (ok) { best = { x: x, y: y }; break; }
      }
      var d = { o: o, e: e, x: best.x, y: best.y, w: w, h: h, life: rnd(5.5, 8), age: age || 0, dx: rnd(-8, 8), dy: rnd(-14, -4) };
      live.push(d); paint(d);
    }
    for (i = 0; i < target; i++) spawn(rnd(.2, .65) * 7);
    return { frame: function (t, dt) {
      for (var k = live.length - 1; k >= 0; k--) {
        var d = live[k];
        if (d.e.classList.contains('kept')) d.age = Math.min(d.age + dt, d.life * .6); else d.age += dt;
        if (d.age >= d.life) { d.e.remove(); live.splice(k, 1); } else paint(d);
      }
      cool -= dt;
      var free = live.filter(function (d) { return !d.e.classList.contains('kept'); }).length;
      if (free < target && cool <= 0) { spawn(0); cool = rnd(.35, .9); }
    } };
  }

  /* 表現2: 滝(縦書きの言葉が流れ落ちる) */
  function pFall(words, S) {
    var layer = ui.layer, lanes = Math.max(3, Math.min(Math.floor(S.w / 46), Math.max(3, words.length))), lw = S.w / lanes, drops = [], pool = shuffle(words.slice()), pi = 0, i;
    var lane = []; for (i = 0; i < lanes; i++) lane.push({ x: (i + .5) * lw, gap: rnd(30, 140) });
    function next() {
      for (var k = 0; k < pool.length; k++) {
        if (pi >= pool.length) { pool = shuffle(words.slice()); pi = 0; }
        var o = pool[pi++];
        if (!drops.some(function (d) { return d.o.t === o.t; })) return o;
      }
      return pool[0];
    }
    function place(d) { d.e.style.transform = 'translate(' + d.L.x + 'px,' + d.y + 'px) translateX(-50%)'; }
    function spawn(L, y) {
      var o = next(), e = mk(o, true, [13, 16, 19]); layer.appendChild(e);
      var h = e.offsetHeight, d = { o: o, e: e, L: L, h: h, y: (y === undefined ? -h - 4 : y), speed: rnd(22, 48) * (1.15 - .15 * o.w) };
      drops.push(d); place(d); return d;
    }
    lane.forEach(function (L) { var y = rnd(-40, S.h * .2); while (y < S.h) { var d = spawn(L, y); y += d.h + rnd(40, 140); } });
    return { frame: function (t, dt) {
      for (var k = drops.length - 1; k >= 0; k--) { var d = drops[k]; d.y += d.speed * dt; if (d.y > S.h + 8) { d.e.remove(); drops.splice(k, 1); } else place(d); }
      lane.forEach(function (L) {
        var top = Infinity; drops.forEach(function (d) { if (d.L === L && d.y < top) top = d.y; });
        if (top > L.gap) { spawn(L); L.gap = rnd(30, 140); }
      });
    } };
  }

  function stopPattern() { cancelAnimationFrame(ui.raf); ui.running = false; ui.layer.innerHTML = ''; }
  function startPattern() {
    cancelAnimationFrame(ui.raf); ui.layer.innerHTML = ''; ui.running = false;
    if (!ui.current || !ui.current.items.length || !shown) return;
    var S = { w: ui.stage.clientWidth, h: ui.stage.clientHeight };
    if (S.w < 50 || S.h < 50) return;
    ui.lastW = S.w; ui.lastH = S.h;
    ui.stage.classList.toggle('night', ui.mode === 'firefly'); ui.wrap.classList.toggle('rs-night', ui.mode === 'firefly');
    ui.layer.classList.toggle('fall', ui.mode === 'fall');
    var p = (ui.mode === 'fall' ? pFall : pFirefly)(wordsOfCurrent(), S), last = performance.now(), t0 = last;
    p.frame(0, 0); ui.running = true;
    if (reduce) return;
    (function loop(now) {
      if (!ui.running) return;
      var dt = Math.min(.05, (now - last) / 1000); last = now; p.frame((now - t0) / 1000, dt);
      ui.raf = requestAnimationFrame(loop);
    })(last);
  }

  /* 開発用: 取得内容の確認(明示的に開いたときだけ) */
  function renderDev() {
    var b = ui.devBody; b.innerHTML = '';
    var res = ui.current;
    if (!res) { b.appendChild(el('p', '', 'まだ取得していません。')); return; }
    b.appendChild(el('p', '', '「' + res.query + '」 取得 ' + fmtTime(res.fetchedAt) + (res.fromCache ? '(保存済み)' : '') + ' / 取得の版 ' + res.logicVersion));
    var provs = res.meta.providers || {};
    Object.keys(provs).forEach(function (id) { var m = provs[id]; b.appendChild(el('p', '', m.label + ': ' + (m.ok ? m.count + '語 — ' + (m.notes || []).join(' / ') : '失敗 — ' + m.error))); });
    var wrapT = el('div', 'rs-tablewrap'), t = el('table', 'rs-table');
    t.innerHTML = '<thead><tr><th>語</th><th>種類</th><th>取得元</th><th>根拠</th><th>点</th></tr></thead>';
    var tb = el('tbody');
    res.items.forEach(function (i) {
      var tr = el('tr'); [i.text, CAT_LABEL[i.category], i.sources.join('+'), i.relationType + (i.relations && i.relations[0] && i.relations[0].evidence ? '(' + i.relations[0].evidence + ')' : ''), String(i.score)].forEach(function (x, ci) {
        var td = el('td'); if (ci === 0 && i.sourceUrls && i.sourceUrls[0]) { var a = el('a', '', x); a.href = i.sourceUrls[0]; a.target = '_blank'; a.rel = 'noopener'; td.appendChild(a); } else td.textContent = x; tr.appendChild(td);
      }); tb.appendChild(tr);
    });
    t.appendChild(tb); wrapT.appendChild(t); b.appendChild(wrapT);
    // 採用されなかった語と理由(取得したばかりのときだけ。保存済みの結果には残していない)
    var box = el('div'); box.style.marginTop = '10px';
    box.appendChild(el('div', '', '採用されなかった語を調べる(取得したばかりの結果のみ):'));
    var inp = el('input'); inp.type = 'text'; inp.placeholder = '調べたい語(例: テンパリング)'; box.appendChild(inp);
    var out = el('div'); box.appendChild(out);
    inp.oninput = function () {
      out.innerHTML = ''; var v = normalizeQuery(inp.value); if (!v) return;
      if (!res.dropped) { out.textContent = '保存済みの結果には、除外の記録がありません。再取得すると確認できます。'; return; }
      var adopted = res.items.filter(function (i) { return i.text.indexOf(v) >= 0; });
      var dr = res.dropped.filter(function (d) { return d.text.indexOf(v) >= 0; });
      adopted.forEach(function (i) { out.appendChild(el('div', '', '採用: ' + i.text + '(' + CAT_LABEL[i.category] + ')')); });
      dr.slice(0, 20).forEach(function (d) { out.appendChild(el('div', '', '除外: ' + d.text + ' — ' + d.reason + '(' + d.how + ')')); });
      if (!adopted.length && !dr.length) out.textContent = 'この語は、WordNetにも、Wikipediaの記事内リンク・全文検索にも出てきませんでした。';
    };
    b.appendChild(box);
  }

  /* 設定タブに出す、保存の管理 */
  function settingsGroup() {
    var g = el('div', 'setgroup'); g.appendChild(el('h3', '', '連想ことば'));
    function draw() {
      g.querySelectorAll('.rs-set').forEach(function (n) { n.remove(); });
      var s = cache.stats(), n = el('p', 'setnote rs-set', '保存した検索: ' + s.count + '件(約' + Math.max(1, Math.round(s.chars * 2 / 1024)) + 'KB)。この端末だけに保存されます。最大' + CACHE_MAX_ENTRIES + '件で、古いものから自動で消えます。');
      var b = el('button', 'btn danger rs-set', 'すべて削除'); b.type = 'button'; b.disabled = !s.count;
      b.onclick = function () { cache.clear(); draw(); if (ui) renderSaved(); };
      g.appendChild(n); g.appendChild(b);
    }
    draw(); return g;
  }

  function show(container) {
    if (!ui) buildUI(container);
    shown = true; ensureProviders();
    if (ui.current && ui.current.items.length && !ui.running) startPattern();
  }
  function setHooks(h) { hooks = h || {}; if (ui) renderKept(); }
  // 単語メモなどから、その言葉で探す(保存済みなら「もう一度眺める」か「再取得」の選択になる)
  function openWith(q) { if (!ui) return; ui.input.value = q; onSubmit(); }
  function hide() { shown = false; if (ui) { cancelAnimationFrame(ui.raf); ui.running = false; ui.layer.innerHTML = ''; } }

  return {
    version: LOGIC_VERSION, show: show, hide: hide, settingsGroup: settingsGroup, setHooks: setHooks, openWith: openWith,
    search: search, registerProvider: registerProvider, createCache: createCache,
    providers: { createWordnetProvider: createWordnetProvider, createWikipediaProvider: createWikipediaProvider },
    mergeCandidates: mergeCandidates,
    _t: { normalizeQuery: normalizeQuery, parseWikiLinks: parseWikiLinks, cleanWikitext: cleanWikitext, titleNoiseReason: titleNoiseReason,
      classesFromCategories: classesFromCategories, titleClasses: titleClasses, dedupeKey: dedupeKey }
  };
});
