# 日本語WordNet(出典とライセンス)

「連想」タブの類語・複合語は、日本語WordNetのデータから作った索引(`wnja-index.json`)を使っています。

- 名称: 日本語WordNet (Japanese Wordnet) 2.1版
- 配布元: https://bond-lab.github.io/wnja/ (配布ファイル: https://github.com/bond-lab/wnja/releases/tag/v2.1)
- 元ファイル: wnja-2.1.xml(SHA-256: 0e08760cd3fd82ac583b846d210a7db25282378af28e8d6c1612aaac51139919)
- ライセンス: 配布元のライセンス(WordNetに似た、無償での使用・複写・改変・頒布を認める許諾)。全文は `LICENSE-wnja.txt`

表示(配布元の指定による):

> 日本語ワードネット (2.1版) © 2009-2011 NICT, 2012-2015 Francis Bond and 2016-2026 Francis Bond, Takayuki Kuribayashi linked to https://bond-lab.github.io/wnja/index.ja.html

加えた変更: 見出し語と、同じ語義に入っている語の組だけを取り出し、小さなJSONに変換しました(定義文・例文・読み・語義どうしの関係は入れていません)。
作り方: `tools/build_wnja_index.py`

配布元は、データの約5%に誤りがあり得ると注記しています。
