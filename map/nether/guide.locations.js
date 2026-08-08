/*
 * guide.locations.js - 案内マップに表示する地点データ。
 *
 * ここが編集する唯一のファイル。render-map.ps1 が map\<dimension>\ へ
 * 配布するので、地図を描き直しても内容は失われない。
 * （map\ の下にコピーされたものを編集しても次回の配布で上書きされるため、
 *   必ずこのファイルを編集すること）
 *
 * 地点の書き方:
 *
 *   {
 *       name:        "表示名",                  // 必須
 *       x:           100,                       // 必須 X座標
 *       z:           -250,                      // 必須 Z座標
 *       y:           64,                        // 任意 Y座標（ポップアップに表示）
 *       category:    "base",                    // 任意 下の categories のキー
 *       dimension:   "overworld",               // 任意 overworld / nether / end
 *                                               //      省略すると全マップに表示
 *       description: "説明文。改行も使える"        // 任意
 *   }
 *
 * カンマの付け忘れに注意。各項目の末尾に "," が要る（最後の項目は省略可）。
 */

UnminedGuideLocations = {

    // カテゴリの定義。color はピンと一覧の色、label はポップアップのバッジ文字。
    categories: {
        spawn:    { color: '#f2b134', label: 'スポーン' },
        base:     { color: '#4ea3f5', label: '拠点' },
        farm:     { color: '#5cc46b', label: '農場・施設' },
        portal:   { color: '#b06ee8', label: 'ポータル' },
        landmark: { color: '#e8663d', label: '名所' },
        shop:     { color: '#f57f4e', label: '商店' }
    },

    locations: [

        // ------------------------------------------------------------------
        // 以下はすべて記入例。実際の地点に置き換えて使うこと。
        // ------------------------------------------------------------------

        {
            name: 'スポーン地点',
            x: 0,
            z: 0,
            category: 'spawn',
            dimension: 'overworld',
            description: 'ワールドの原点。ここが X=0, Z=0。'
        },

        {
            name: '（例）拠点',
            x: 200,
            z: -150,
            y: 70,
            category: 'base',
            dimension: 'overworld',
            description: '説明をここに書く。\n改行するとそのまま表示される。'
        },

        {
            name: '（例）ネザーゲート',
            x: 25,
            z: -19,
            category: 'portal',
            dimension: 'nether',
            description: 'ネザー側の座標で登録する。'
        }

        // ここに追加していく（前の項目の末尾に "," を付けるのを忘れずに）

    ]
};
