#!/usr/bin/env python3
"""日本語WordNet(wnja)の配布データから、アプリ用の小さな索引を作る(開発時に1回だけ実行する)。

使い方:
  1. 配布データを取得して展開する(例: wnja-2.1.tar.xz → wnja/wnja-2.1.xml と wnja/LICENSE)
       https://github.com/bond-lab/wnja/releases/download/v2.1/wnja-2.1.tar.xz
  2. python3 tools/build_wnja_index.py <wnja-2.1.xml> <LICENSEファイル> <出力フォルダ(data/wnja)>

出力(出力フォルダ):
  wnja-index.json   見出し語の一覧と、同じ語義(synset)に入っている語の組
  LICENSE-wnja.txt  配布元のライセンス文(そのまま)
  NOTICE.md         出典・ライセンスの表示

索引に入れるのは「日本語の見出し語」と「同じ語義の語の組」だけ。定義文・例文・読みは入れない。
"""
import sys, json, hashlib, pathlib, datetime, collections
import xml.etree.ElementTree as ET


def main(xml_path, license_path, out_dir):
    xml_path, license_path, out_dir = pathlib.Path(xml_path), pathlib.Path(license_path), pathlib.Path(out_dir)
    raw = xml_path.read_bytes()
    sha = hashlib.sha256(raw).hexdigest()
    root = ET.fromstring(raw)
    lex = root.find('Lexicon')
    version = lex.get('version')

    # 語義ごとに (語, 使用回数) を集める
    syn_words = collections.OrderedDict()
    for entry in lex.findall('LexicalEntry'):
        written = entry.find('Lemma').get('writtenForm')
        if not written or not written.strip():
            continue
        for sense in entry.findall('Sense'):
            sid = sense.get('synset')
            cnt = 0
            for c in sense.findall('Count'):
                try:
                    cnt += int(c.text)
                except (TypeError, ValueError):
                    pass
            syn_words.setdefault(sid, {})
            syn_words[sid][written] = max(cnt, syn_words[sid].get(written, 0))

    words = sorted({w for d in syn_words.values() for w in d})
    index_of = {w: i for i, w in enumerate(words)}
    syn, freq = [], []
    for sid in sorted(syn_words):
        d = syn_words[sid]
        order = sorted(d, key=lambda w: (-d[w], w))  # よく使われる語を先頭に
        syn.append([index_of[w] for w in order])
        freq.append(sum(d.values()))

    out_dir.mkdir(parents=True, exist_ok=True)
    data = {
        'version': version,
        'built': datetime.date.today().isoformat(),
        'source': 'wnja-%s.xml' % version,
        'source_sha256': sha,
        'words': '\n'.join(words),
        'syn': syn,
        'freq': freq,
    }
    (out_dir / 'wnja-index.json').write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    (out_dir / 'LICENSE-wnja.txt').write_bytes(license_path.read_bytes())
    notice = f"""# 日本語WordNet(出典とライセンス)

「連想」タブの類語・複合語は、日本語WordNetのデータから作った索引(`wnja-index.json`)を使っています。

- 名称: 日本語WordNet (Japanese Wordnet) {version}版
- 配布元: https://bond-lab.github.io/wnja/ (配布ファイル: https://github.com/bond-lab/wnja/releases/tag/v{version})
- 元ファイル: wnja-{version}.xml(SHA-256: {sha})
- ライセンス: 配布元のライセンス(WordNetに似た、無償での使用・複写・改変・頒布を認める許諾)。全文は `LICENSE-wnja.txt`

表示(配布元の指定による):

> 日本語ワードネット ({version}版) © 2009-2011 NICT, 2012-2015 Francis Bond and 2016-2026 Francis Bond, Takayuki Kuribayashi linked to https://bond-lab.github.io/wnja/index.ja.html

加えた変更: 見出し語と、同じ語義に入っている語の組だけを取り出し、小さなJSONに変換しました(定義文・例文・読み・語義どうしの関係は入れていません)。
作り方: `tools/build_wnja_index.py`

配布元は、データの約5%に誤りがあり得ると注記しています。
"""
    (out_dir / 'NOTICE.md').write_text(notice, encoding='utf-8')
    print('version', version, '| words', len(words), '| synsets', len(syn),
          '| json bytes', (out_dir / 'wnja-index.json').stat().st_size)


if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
