/*
 * guide.js - uNmINeD の Web マップに「案内マップ」機能を追加する。
 *
 *   - 地点（ピン）と範囲（多角形）を表示
 *   - タップで名前・説明・座標をポップアップ
 *   - カテゴリごとに表示のオン/オフを切り替えられる
 *   - 一覧パネルから検索してその場所へ飛べる
 *   - 編集モード（URL に #edit）で地図をクリック／範囲を描いて登録し、
 *     CSV として書き出せる
 *
 * uNmINeD 本体には手を入れず、OpenLayers の地図オブジェクト
 * (unmined.olMap) に外から乗る形で実装している。
 * データは guide.locations.js（各 CSV から自動生成）。
 */
(function () {
    'use strict';

    // ラベルを出し始める uNmINeD のズーム段階（-6 〜 maxZoom）。
    // OpenLayers のビューは 0 始まりの通し番号なので、minZoom を足して換算する。
    var LABEL_MIN_UNMINED = -3;
    var HIT_TOLERANCE  = 20;   // 地点の、指でのタップ判定の甘さ（px）
    var AREA_HIT_TOLERANCE = 0; // 面は塗りの内側だけ。地点より必ず下に来るようにする。
    var DRAFT_KEY      = 'unminedGuideDrafts2';
    var HIDDEN_KEY     = 'unminedGuideHidden';
    var HIDDEN_KIND_KEY = 'unminedGuideHiddenKind';

    // ---------------------------------------------------------------- utils

    function el(tag, className, text) {
        var e = document.createElement(tag);
        if (className) e.className = className;
        if (text != null) e.textContent = text;
        return e;
    }

    function categoryOf(item, config) {
        var cats = (config && config.categories) || {};
        return cats[item.category] || { color: '#e8663d', label: item.category || '' };
    }

    function rgba(hex, a) {
        var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
        if (!m) return 'rgba(232,102,61,' + a + ')';
        return 'rgba(' + parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16) + ',' + a + ')';
    }

    // 地点の印。座標そのものを指す丸で、中心が地点の位置になる。
    //
    // declutterMode: 'obstacle' が肝。既定の 'declutter' だと、ラベルが
    // 隣の地点とぶつかった時に丸ごと消えてしまい、最大まで拡大しても
    // 出てこない地点が生まれる。'obstacle' なら丸は必ず描かれ、
    // かつ他のラベルが丸の上に乗らないよう避けてくれる。
    function pinShape(color, draft) {
        return new ol.style.Circle({
            radius: draft ? 6.5 : 7,
            declutterMode: 'obstacle',
            fill: new ol.style.Fill({ color: draft ? rgba(color, 0.25) : color }),
            stroke: new ol.style.Stroke({
                color: draft ? color : 'rgba(255,255,255,.92)',
                width: draft ? 2.2 : 2,
                lineDash: draft ? [3, 3] : undefined
            })
        });
    }

    function isEditMode() {
        return /(^|[#?&])edit\b/.test(location.hash + location.search);
    }

    // CSV の 1 セルを RFC4180 に沿ってエスケープする
    function csvCell(v) {
        var s = (v == null) ? '' : String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }

    function copyText(text, onDone) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(onDone, function () {});
        } else {
            var ta = el('textarea');
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); onDone(); } catch (e) {}
            document.body.removeChild(ta);
        }
    }

    function readStore(key, fallback) {
        try { return JSON.parse(localStorage.getItem(key) || 'null') || fallback; }
        catch (e) { return fallback; }
    }
    function writeStore(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); }
        catch (e) { console.warn('[guide] 保存できませんでした', e); }
    }

    // ------------------------------------------------------------ 起動待ち

    // unmined は index.html 内の classic script で const 宣言されているため
    // window には乗らないが、グローバルスコープ経由で参照できる。
    function waitForMap(callback) {
        var tries = 0;

        // const は初期化前に触れると typeof でも ReferenceError (TDZ) になる。
        function peek() {
            try { return (typeof unmined !== 'undefined') ? unmined : null; }
            catch (e) { return null; }
        }

        (function poll() {
            var m = peek();
            if (m && m.olMap && m.dataProjection && m.viewProjection) {
                callback(m);
            } else if (++tries < 400) {
                setTimeout(poll, 50);
            } else {
                console.warn('[guide] uNmINeD のマップを見つけられませんでした');
            }
        })();
    }

    // ------------------------------------------------------------------ 本体

    function init(map) {
        var config = (typeof UnminedGuideLocations !== 'undefined') ? UnminedGuideLocations : null;
        if (!config) return;

        var dim = (typeof UnminedGuideDimension !== 'undefined') ? UnminedGuideDimension : null;
        var here = function (item) { return !item.dimension || !dim || item.dimension === dim; };

        var drafts = readStore(DRAFT_KEY, {})[dim || '_'] || {};

        var ctx = {
            map: map, olMap: map.olMap, config: config, dim: dim, edit: isEditMode(),
            points: (config.locations || []).filter(here),
            areas:  (config.areas || []).filter(here),
            draftPoints: drafts.points || [],
            draftAreas:  drafts.areas  || [],
            hidden: readStore(HIDDEN_KEY, {}),
            hiddenKind: readStore(HIDDEN_KIND_KEY, {}),
            drawMode: 'point'
        };

        // uNmINeD のズーム段階 → OpenLayers の通し番号（0始まり）へ換算する
        var props = null;
        try { props = (typeof UnminedMapProperties !== 'undefined') ? UnminedMapProperties : null; }
        catch (e) { props = null; }
        var minZ = (props && typeof props.minZoom === 'number') ? props.minZoom : -6;
        ctx.labelMinZ = LABEL_MIN_UNMINED - minZ;

        // 実タイルが存在する最深段階。ラベルを「必ず出す」判定に使う。
        var res0 = ctx.olMap.getView().getResolutions();
        ctx.tileMaxZ = res0 ? res0.length - 1 : 0;

        extendMaxZoom(ctx);

        // 地点が 0 件でも UI は出す。戻るリンクや一覧ボタンまで消えると
        // 「ただの地図」になり、機能があること自体が分からなくなるため。

        ctx.saveDrafts = function () {
            var all = readStore(DRAFT_KEY, {});
            all[ctx.dim || '_'] = { points: ctx.draftPoints, areas: ctx.draftAreas };
            writeStore(DRAFT_KEY, all);
        };
        // カテゴリと種類（地点/範囲）の両方でフィルターする
        ctx.isHidden = function (item, kind) {
            if (kind && ctx.hiddenKind[kind]) return true;
            return !!ctx.hidden[item.category || ''];
        };
        ctx.refreshAll = function () {
            ctx.pointLayer.refresh();
            ctx.areaLayer.refresh();
            if (ctx.draftPointLayer) ctx.draftPointLayer.refresh();
            if (ctx.draftAreaLayer)  ctx.draftAreaLayer.refresh();
            ctx.renderList();
            if (ctx.updateEditCount) ctx.updateEditCount();
        };

        buildLayers(ctx);
        buildPopup(ctx);
        buildInteractions(ctx);
        buildListPanel(ctx);
        buildBackLink();
        if (ctx.edit) buildEditUi(ctx);

        // 共有リンク（#p=地点名）で開かれたときは、その地点を選んだ状態にする
        ctx.openFromHash();
    }

    // ------------------------------------------------------------ レイヤー

    // ------------------------------------------------------- 拡大上限の拡張

    /*
     * uNmINeD はタイル解像度を  resolutions[z] = ブロック毎ピクセル * devicePixelRatio
     * として組み立てる。おかげで高精細画面ではタイルが端末の実ピクセル等倍で
     * 描かれて綺麗になる反面、CSS ピクセル基準の拡大率は画面倍率のぶんだけ下がる。
     *
     *   PC (DPR 1)    最深段階で 1ブロック = 4 CSSpx
     *   スマホ(DPR 3) 最深段階で 1ブロック = 1.33 CSSpx  ← 拡大できないと感じる原因
     *
     * そこでビューの解像度リストだけを下方向に継ぎ足す。タイルグリッドは触らない
     * ので、最深タイルがそのまま引き伸ばして描かれる。#map に image-rendering:
     * pixelated が効いているため、ぼやけずにブロックが大きくなるだけで済む。
     */
    function extendMaxZoom(ctx) {
        var olMap = ctx.olMap;
        var view = olMap.getView();
        var res = view.getResolutions();
        if (!res || res.length < 2) return;

        var dpr = window.devicePixelRatio || 1;
        var extra = Math.min(3, Math.max(1, Math.ceil(Math.log(dpr) / Math.LN2) + 1));

        var out = res.slice();
        for (var i = 0; i < extra; i++) out.push(out[out.length - 1] / 2);

        // 元のビューと同じ制約を保つため、範囲はタイルグリッドから借りる
        var extent;
        try {
            olMap.getLayers().getArray().some(function (l) {
                var src = l.getSource && l.getSource();
                var grid = src && src.getTileGrid && src.getTileGrid();
                if (grid) { extent = grid.getExtent(); return true; }
                return false;
            });
        } catch (e) { extent = undefined; }

        olMap.setView(new ol.View({
            center: view.getCenter(),
            extent: extent,
            projection: view.getProjection(),
            resolutions: out,
            maxZoom: out.length - 1,
            zoom: view.getZoom(),
            constrainResolution: true,
            showFullExtent: true,
            constrainOnlyCenter: true,
            enableRotation: false
        }));

        // 座標グリッドの目盛り間隔は生成時の getMaxZoom() から決まるので、
        // 深い段階でも目盛りが出るよう作り直させる。
        try { ctx.map.updateGraticule(); } catch (e) { /* 無くても致命的ではない */ }
    }

    // ラベルの出し方を 3 段階で決める。
    //   'off'       … 引きすぎ。ラベルは出さない
    //   'declutter' … 通常。重なったラベルは退避して消える
    //   'always'    … 最大まで拡大した時。重なっても全部出す
    function labelState(ctx) {
        var z = ctx.olMap.getView().getZoom();
        if (z == null) return 'off';

        // 実タイルの最深段階に達したら以降はずっと「必ず出す」
        if (z >= (ctx.tileMaxZ || 0) - 0.01) return 'always';
        return (z >= ctx.labelMinZ) ? 'declutter' : 'off';
    }

    function labelStyle(text, size, state) {
        return new ol.style.Text({
            text: text,
            font: (size || 13) + 'px system-ui, "Segoe UI", sans-serif',
            fill: new ol.style.Fill({ color: '#fff' }),
            stroke: new ol.style.Stroke({ color: 'rgba(0,0,0,.85)', width: 3 }),
            overflow: true,
            // 最大拡大時は重なり回避の対象から外し、必ず描画させる
            declutterMode: (state === 'always') ? 'none' : undefined,
            padding: [2, 4, 2, 4]
        });
    }

    function makePointLayer(ctx, getItems, draft) {
        var cache = {};
        var source = new ol.source.Vector();
        var layer = new ol.layer.Vector({
            source: source, declutter: true, zIndex: draft ? 60 : 50,
            style: function (feature) {
                var loc = feature.get('guideItem');
                if (ctx.isHidden(loc, 'point')) return null;
                var cat = categoryOf(loc, ctx.config);
                var st = labelState(ctx);
                var key = cat.color + (draft ? 'd' : '') + '|' + st + '|' + loc.name;
                if (!cache[key]) {
                    var s = new ol.style.Style({ image: pinShape(cat.color, draft) });
                    // 丸は中心が地点なので、ラベルは丸の下へ逃がす
                    if (st !== 'off') {
                        var t = labelStyle(loc.name, 13, st);
                        t.setOffsetY(17);
                        s.setText(t);
                    }
                    cache[key] = s;
                }
                return cache[key];
            }
        });
        layer.refresh = function () {
            source.clear();
            source.addFeatures(getItems().map(function (loc) {
                var f = new ol.Feature({
                    geometry: new ol.geom.Point(
                        ol.proj.transform([loc.x, loc.z], ctx.map.dataProjection, ctx.map.viewProjection))
                });
                f.set('guideItem', loc);
                f.set('guideKind', 'point');
                f.set('guideDraft', !!draft);
                return f;
            }));
        };
        layer.refresh();
        ctx.olMap.addLayer(layer);
        return layer;
    }

    function makeAreaLayer(ctx, getItems, draft) {
        var source = new ol.source.Vector();
        var layer = new ol.layer.Vector({
            // declutter は文字と画像にだけ効く（塗りと枠線は必ず描かれる）ので、
            // 面のラベルも地点のラベルと同じ土俵で重なりを避けさせる。
            source: source, declutter: true, zIndex: draft ? 45 : 40,
            style: function (feature) {
                var a = feature.get('guideItem');
                if (ctx.isHidden(a, 'area')) return null;
                var cat = categoryOf(a, ctx.config);
                var s = new ol.style.Style({
                    fill: new ol.style.Fill({ color: rgba(cat.color, draft ? 0.1 : 0.17) }),
                    stroke: new ol.style.Stroke({
                        color: cat.color, width: draft ? 2 : 2.5,
                        lineDash: draft ? [6, 5] : undefined
                    })
                });
                var st = labelState(ctx);
                if (st !== 'off') s.setText(labelStyle(a.name, 15, st));
                return s;
            }
        });
        layer.refresh = function () {
            source.clear();
            source.addFeatures(getItems().map(function (a) {
                var ring = a.points.map(function (p) {
                    return ol.proj.transform([p[0], p[1]], ctx.map.dataProjection, ctx.map.viewProjection);
                });
                // 多角形の環は閉じている必要がある
                if (ring.length && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) {
                    ring.push(ring[0]);
                }
                var f = new ol.Feature({ geometry: new ol.geom.Polygon([ring]) });
                f.set('guideItem', a);
                f.set('guideKind', 'area');
                f.set('guideDraft', !!draft);
                return f;
            }));
        };
        layer.refresh();
        ctx.olMap.addLayer(layer);
        return layer;
    }

    function buildLayers(ctx) {
        ctx.areaLayer  = makeAreaLayer(ctx,  function () { return ctx.areas; },  false);
        ctx.pointLayer = makePointLayer(ctx, function () { return ctx.points; }, false);
        if (ctx.edit) {
            ctx.draftAreaLayer  = makeAreaLayer(ctx,  function () { return ctx.draftAreas; },  true);
            ctx.draftPointLayer = makePointLayer(ctx, function () { return ctx.draftPoints; }, true);
        }

        // ラベルの出し方が変わる境目でだけ再描画させる
        var last = labelState(ctx);
        ctx.olMap.getView().on('change:resolution', function () {
            var s = labelState(ctx);
            if (s !== last) {
                last = s;
                guideLayers(ctx).forEach(function (l) { l.changed(); });
            }
        });
    }

    function guideLayers(ctx) {
        return [ctx.areaLayer, ctx.pointLayer, ctx.draftAreaLayer, ctx.draftPointLayer]
            .filter(function (l) { return !!l; });
    }

    // -------------------------------------------------------------- 情報カード

    /*
     * 地点をタップすると画面の端から出てくるカード。Google マップの
     * 「場所の詳細」に寄せてある。
     *
     *   横長の画面（PC）  … 画面の左端に縦長で出す
     *   縦長の画面（スマホ）… 下から出るシート。つまみを上下にドラッグできる
     *
     * 以前の吹き出しをやめた理由は 2 つ。ピンの真上に出るので指と吹き出しで
     * 肝心の場所が隠れること、写真やメモを載せる面積が取れないこと。
     *
     * 地図の操作ボタン類は黒いが、カードだけは白い。読み物なので
     * 明るいほうが読みやすく、地図の上に浮いていることも分かりやすい。
     */

    var DIM_LABEL = { overworld: 'オーバーワールド', nether: 'ネザー', end: 'ジ・エンド' };

    // 写真がまだ無い地点に出す代替画像。guide.css などと同じ場所に置いてあり、
    // render-map.ps1 が地図フォルダへ配る。
    var PLACEHOLDER = 'place-placeholder.png';

    function isNarrow() {
        return window.matchMedia('(max-width: 640px)').matches;
    }

    // 点が多角形の内側にあるか。住所として「どの街の中か」を出すのに使う。
    // 交差数判定（レイキャスティング）。
    function inPolygon(x, z, pts) {
        var inside = false;
        for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            var xi = pts[i][0], zi = pts[i][1], xj = pts[j][0], zj = pts[j][1];
            if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
        }
        return inside;
    }

    function svg(paths, attrs) {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
               'stroke-linecap="round" stroke-linejoin="round" ' + (attrs || '') + '>' + paths + '</svg>';
    }

    // 星 5 つ。半端な評価はグラデーションで部分的に塗る。
    var starSeq = 0;
    function starsHtml(rating, cls) {
        var out = '<span class="guide-stars ' + (cls || '') + '" aria-hidden="true">';
        for (var i = 0; i < 5; i++) {
            var f = Math.max(0, Math.min(1, rating - i));
            var id = 'gst' + (++starSeq);
            out += '<svg viewBox="0 0 24 24" class="guide-star">' +
                '<defs><linearGradient id="' + id + '">' +
                '<stop offset="' + (f * 100) + '%" stop-color="var(--gp-star)"/>' +
                '<stop offset="' + (f * 100) + '%" stop-color="var(--gp-star-off)"/>' +
                '</linearGradient></defs>' +
                '<path fill="url(#' + id + ')" d="M12 2.6l2.9 5.9 6.5.95-4.7 4.6 1.1 6.5L12 17.5 6.2 20.5l1.1-6.5-4.7-4.6 6.5-.95z"/>' +
                '</svg>';
        }
        return out + '</span>';
    }

    // 選択中の地点に立てるピン。カテゴリ色の丸（＝ただの地点）と紛れないよう、
    // 地図でおなじみの赤いしずく型にしてある。色は選択中である印なので固定。
    var MARKER_URL = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="44" viewBox="0 0 30 44">' +
        '<ellipse cx="15" cy="40.6" rx="5.2" ry="2.1" fill="rgba(0,0,0,.34)"/>' +
        '<path d="M15 40.5S27.2 24.4 27.2 14.9A12.2 12.2 0 1 0 2.8 14.9C2.8 24.4 15 40.5 15 40.5z" ' +
        'fill="#ea4335" stroke="rgba(120,20,14,.55)" stroke-width="0.8"/>' +
        '<circle cx="15" cy="14.6" r="4.4" fill="#b3241b"/></svg>');

    // クチコミの人物アイコン。名前から色を決めて頭文字を出す。
    var AVATAR_COLORS = ['#d93025', '#1a73e8', '#188038', '#e37400', '#9334e6', '#0b8a68', '#c5221f'];
    function avatarOf(name) {
        var h = 0;
        for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 100000;
        return { color: AVATAR_COLORS[h % AVATAR_COLORS.length], initial: (name || '?').trim().charAt(0) };
    }

    function buildPopup(ctx) {
        // --- 選択中のピンを立てるレイヤー -----------------------------------
        var selSource = new ol.source.Vector();
        ctx.olMap.addLayer(new ol.layer.Vector({
            source: selSource, zIndex: 70,
            // 印は 1 種類なのでスタイルを使い回す
            style: new ol.style.Style({
                image: new ol.style.Icon({
                    src: MARKER_URL, anchor: [0.5, 1],
                    anchorXUnits: 'fraction', anchorYUnits: 'fraction'
                })
            })
        }));

        // --- カードの骨組み -------------------------------------------------
        var card = el('aside', 'guide-place is-closed');
        card.setAttribute('role', 'dialog');
        card.innerHTML =
            '<div class="guide-place-grip" aria-hidden="true"><span></span></div>' +
            '<button class="guide-place-close" aria-label="閉じる">' +
                svg('<path d="M18 6L6 18M6 6l12 12"/>', 'width="19" height="19" stroke-width="2.3"') +
            '</button>' +
            '<div class="guide-place-scroll"></div>';
        document.body.appendChild(card);

        var scroll = card.querySelector('.guide-place-scroll');
        var grip   = card.querySelector('.guide-place-grip');
        card.querySelector('.guide-place-close').onclick = function () { ctx.closePopup(); };

        // 範囲の代表点（ラベルが出る位置）
        function anchorOf(item, kind) {
            if (kind === 'point') return [item.x, item.z];
            var sx = 0, sz = 0;
            item.points.forEach(function (p) { sx += p[0]; sz += p[1]; });
            return [Math.round(sx / item.points.length), Math.round(sz / item.points.length)];
        }
        ctx.anchorOf = anchorOf;

        // --- クチコミ --------------------------------------------------------

        // guide.reviews.csv から生成した一覧。地点名で引く。
        function reviewsOf(item) {
            var all = ctx.config.reviews || {};
            return all[item.name] || [];
        }

        // 評価は基本クチコミの平均。まだ 1 件も無ければ CSV の rating 列を使う。
        function scoreOf(item) {
            var rs = reviewsOf(item);
            if (!rs.length) return { rating: +(item.rating || 0), count: +(item.reviews || 0) };
            var sum = 0;
            rs.forEach(function (r) { sum += +r.rating || 0; });
            return { rating: sum / rs.length, count: rs.length };
        }

        // --- 住所 -----------------------------------------------------------

        // 「どの街の中か」＋座標。Google マップの住所欄にあたるもの。
        function addressOf(item, kind, a) {
            var town = null;
            if (kind === 'point') {
                ctx.areas.forEach(function (ar) {
                    if (!town && ar.points && inPolygon(item.x, item.z, ar.points)) town = ar.name;
                });
            }
            var coord = (kind === 'point' && item.y != null)
                ? 'X ' + item.x + '  Y ' + item.y + '  Z ' + item.z
                : 'X ' + a[0] + '  Z ' + a[1];
            return { town: town || (DIM_LABEL[ctx.dim] || ''), coord: coord };
        }

        // --- 共有 -----------------------------------------------------------

        // 共有 URL。uNmINeD 本体がハッシュを URLSearchParams として読むので
        // それに合わせ、p= に地点名を入れる（rx/rz など既存の値は壊さない）。
        function shareUrl(item) {
            var u = new URL(location.href);
            var q = new URLSearchParams(u.hash.replace(/^#/, ''));
            q.set('p', item.name);
            u.hash = '#' + q.toString();
            return u.toString();
        }

        function syncHash(item) {
            try {
                var u = new URL(location.href);
                var q = new URLSearchParams(u.hash.replace(/^#/, ''));
                if (item) { q.set('p', item.name); } else { q.delete('p'); }
                var s = q.toString();
                history.replaceState(null, '', u.pathname + u.search + (s ? '#' + s : ''));
            } catch (e) { /* file:// などでは諦める */ }
        }

        // --- 開閉 -----------------------------------------------------------

        ctx.selected = null;

        ctx.closePopup = function () {
            if (!ctx.selected) return;
            ctx.selected = null;
            selSource.clear();
            card.classList.add('is-closed');
            card.classList.remove('is-full');
            document.body.classList.remove('guide-with-place');
            syncHash(null);
        };

        // 地図をずらして、カードに隠れない位置へ地点を持ってくる。
        function bringIntoView(a) {
            var view = ctx.olMap.getView();
            var size = ctx.olMap.getSize();
            if (!size) return;
            var coord = ol.proj.transform(a, ctx.map.dataProjection, ctx.map.viewProjection);
            var px, py;
            if (isNarrow()) {
                px = size[0] / 2;
                py = (size[1] - Math.min(card.offsetHeight, size[1] * 0.7)) / 2;
            } else {
                px = (size[0] + card.offsetWidth) / 2;
                py = size[1] / 2;
            }
            var res = view.getResolution();
            view.animate({
                center: [coord[0] - (px - size[0] / 2) * res, coord[1] + (py - size[1] / 2) * res],
                duration: 260
            });
        }
        ctx.bringIntoView = bringIntoView;

        ctx.openPopup = function (item, kind, isDraft) {
            var cat = categoryOf(item, ctx.config);
            var a = anchorOf(item, kind);
            var addr = addressOf(item, kind, a);
            var sc = scoreOf(item);
            var revs = reviewsOf(item);

            ctx.selected = item;
            selSource.clear();
            selSource.addFeature(new ol.Feature({
                geometry: new ol.geom.Point(
                    ol.proj.transform(a, ctx.map.dataProjection, ctx.map.viewProjection))
            }));

            scroll.innerHTML = '';

            // 中身は縦一列。PC は 写真→名前→…、スマホは 名前→…→写真 と
            // 並びが変わるが、順番は CSS の order で入れ替えている。
            var body = el('div', 'guide-place-body');
            scroll.appendChild(body);

            // --- 写真 ---
            // まだ用意していない地点は共通の代替画像を出す。
            // 画像は地図のフォルダに一緒に置いてあるので相対パスでよい。
            var hero = el('div', 'guide-hero');
            var img = el('img');
            img.alt = item.image ? item.name : '';
            img.loading = 'lazy';
            if (!item.image) hero.classList.add('is-empty');
            // 指定された画像が読めなかったときも黙って代替へ落とす
            img.onerror = function () {
                if (img.src.indexOf(PLACEHOLDER) === -1) { hero.classList.add('is-empty'); img.src = PLACEHOLDER; }
            };
            img.src = item.image || PLACEHOLDER;
            hero.appendChild(img);
            body.appendChild(hero);

            // --- 名前・評価・カテゴリ ---
            var head = el('div', 'guide-place-head');
            body.appendChild(head);

            head.appendChild(el('h2', 'guide-place-name', item.name));

            var rate = el('div', 'guide-place-rate');
            rate.innerHTML =
                '<b>' + sc.rating.toFixed(1) + '</b>' + starsHtml(sc.rating) +
                '<span class="guide-place-count">(' + sc.count.toLocaleString('ja-JP') + ')</span>';
            head.appendChild(rate);

            var meta = el('div', 'guide-place-meta');
            if (isDraft)         meta.appendChild(tag('下書き', '#8b8b93'));
            if (kind === 'area') meta.appendChild(tag('範囲', '#6b7280'));
            meta.appendChild(tag(cat.label || '未分類', cat.color));
            head.appendChild(meta);

            function tag(text, color) {
                var t = el('span', 'guide-place-tag', text);
                t.style.setProperty('--tag', color);
                return t;
            }

            // --- 操作ボタン ---
            var acts = el('div', 'guide-place-acts');
            body.appendChild(acts);

            var share = el('button', 'guide-act is-primary');
            share.innerHTML = svg('<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/>' +
                '<circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/>',
                'width="17" height="17"') + '<span>共有</span>';
            share.onclick = function () {
                var url = shareUrl(item);
                var s = share.querySelector('span');
                if (navigator.share) {
                    navigator.share({ title: item.name, url: url }).then(function () {}, function () {});
                } else {
                    copyText(url, function () {
                        s.textContent = 'コピーしました';
                        setTimeout(function () { s.textContent = '共有'; }, 1600);
                    });
                }
            };
            acts.appendChild(share);

            var copy = el('button', 'guide-act');
            copy.innerHTML = svg('<rect x="9" y="9" width="12" height="12" rx="2.2"/>' +
                '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
                'width="17" height="17"') + '<span>座標をコピー</span>';
            copy.onclick = function () {
                copyText(a[0] + ' ' + (kind === 'point' && item.y != null ? item.y + ' ' : '') + a[1], function () {
                    var s = copy.querySelector('span');
                    s.textContent = 'コピーしました';
                    setTimeout(function () { s.textContent = '座標をコピー'; }, 1600);
                });
            };
            acts.appendChild(copy);

            // --- タブ ---
            var tabs = el('div', 'guide-tabs');
            tabs.setAttribute('role', 'tablist');
            body.appendChild(tabs);

            var panes = el('div', 'guide-panes');
            body.appendChild(panes);

            var overview = el('div', 'guide-pane');
            var reviewsPane = el('div', 'guide-pane');
            panes.appendChild(overview);
            panes.appendChild(reviewsPane);

            [['概要', overview], ['クチコミ', reviewsPane]].forEach(function (t, i) {
                var b = el('button', 'guide-tab' + (i === 0 ? ' is-on' : ''), t[0]);
                b.setAttribute('role', 'tab');
                if (i !== 0) t[1].classList.add('is-hidden');
                b.onclick = function () {
                    tabs.querySelectorAll('.guide-tab').forEach(function (x) { x.classList.remove('is-on'); });
                    panes.querySelectorAll('.guide-pane').forEach(function (x) { x.classList.add('is-hidden'); });
                    b.classList.add('is-on');
                    t[1].classList.remove('is-hidden');
                };
                tabs.appendChild(b);
            });

            // --- 概要タブ: メモと住所 ---
            var rows = el('div', 'guide-place-rows');
            overview.appendChild(rows);

            function addRow(icon, main, sub) {
                var r = el('div', 'guide-place-row');
                var ic = el('div', 'guide-place-ico');
                ic.innerHTML = svg(icon, 'width="19" height="19"');
                r.appendChild(ic);
                var tx = el('div', 'guide-place-rowtext');
                tx.appendChild(el('div', 'guide-place-rowmain', main));
                if (sub) tx.appendChild(el('div', 'guide-place-rowsub', sub));
                r.appendChild(tx);
                rows.appendChild(r);
                return r;
            }

            addRow('<path d="M4 5h16M4 10h16M4 15h11"/><path d="M4 20h7"/>',
                item.description || 'メモはまだありません', '')
                .classList.add(item.description ? 'has-text' : 'is-empty');

            addRow('<path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/>',
                addr.coord,
                addr.town + (kind === 'area' ? '（' + item.points.length + '頂点）' : ''))
                .classList.add('is-addr');

            if (isDraft) {
                var del = el('button', 'guide-danger', 'この下書きを削除');
                del.onclick = function () {
                    var arr = (kind === 'area') ? ctx.draftAreas : ctx.draftPoints;
                    var i = arr.indexOf(item);
                    if (i >= 0) arr.splice(i, 1);
                    ctx.saveDrafts();
                    ctx.refreshAll();
                    ctx.closePopup();
                };
                overview.appendChild(del);
            }

            // --- クチコミタブ ---
            buildReviews(reviewsPane, item, revs, sc);

            scroll.scrollTop = 0;
            card.classList.remove('is-closed', 'is-full');
            document.body.classList.add('guide-with-place');
            syncHash(item);
            bringIntoView(a);
        };

        // --- クチコミタブの中身 ----------------------------------------------

        function buildReviews(pane, item, revs, sc) {
            // 星ごとの本数を横棒で出す（Google マップと同じ並びで 5 が上）
            var counts = [0, 0, 0, 0, 0];
            revs.forEach(function (r) {
                var n = Math.round(+r.rating || 0);
                if (n >= 1 && n <= 5) counts[n - 1]++;
            });
            var max = Math.max.apply(null, counts.concat([1]));

            var sum = el('div', 'guide-rv-sum');
            var bars = el('div', 'guide-rv-bars');
            for (var n = 5; n >= 1; n--) {
                var row = el('div', 'guide-rv-bar');
                row.appendChild(el('span', 'guide-rv-barn', String(n)));
                var track = el('span', 'guide-rv-track');
                var fill = el('span', 'guide-rv-fill');
                fill.style.width = (counts[n - 1] / max * 100) + '%';
                track.appendChild(fill);
                row.appendChild(track);
                bars.appendChild(row);
            }
            sum.appendChild(bars);

            var big = el('div', 'guide-rv-big');
            big.innerHTML = '<b>' + sc.rating.toFixed(1) + '</b>' + starsHtml(sc.rating, 'is-lg') +
                '<span>' + sc.count.toLocaleString('ja-JP') + '件のクチコミ</span>';
            sum.appendChild(big);
            pane.appendChild(sum);

            // 書き込みは受け取り先が無いので、CSV の 1 行を作って渡すだけにする。
            // このサイトは静的で、地点も歴史も CSV を編集して作っているため。
            var write = el('button', 'guide-rv-write');
            write.innerHTML = svg('<path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z"/>', 'width="16" height="16"') +
                '<span>クチコミを書く</span>';
            write.onclick = function () { toggleForm(); };
            pane.appendChild(write);

            var form = el('div', 'guide-rv-form is-hidden');
            pane.appendChild(form);

            var who = el('input', 'guide-rv-input');
            who.placeholder = 'あなたの名前';
            form.appendChild(who);

            var stars = el('div', 'guide-rv-pick');
            var picked = 5;
            for (var s = 1; s <= 5; s++) {
                (function (v) {
                    var b = el('button', 'guide-rv-pickstar' + (v <= picked ? ' is-on' : ''), '★');
                    b.onclick = function () {
                        picked = v;
                        [].forEach.call(stars.children, function (c, i) { c.classList.toggle('is-on', i < picked); });
                    };
                    stars.appendChild(b);
                })(s);
            }
            form.appendChild(stars);

            var text = el('textarea', 'guide-rv-input guide-rv-text');
            text.placeholder = '感想を書く';
            form.appendChild(text);

            var send = el('button', 'guide-act is-primary guide-rv-send', 'コピーする');
            send.onclick = function () {
                var today = new Date();
                var d = today.getFullYear() + '-' +
                    ('0' + (today.getMonth() + 1)).slice(-2) + '-' + ('0' + today.getDate()).slice(-2);
                var line = [item.name, who.value.trim() || '名無し', picked, d, text.value.trim()]
                    .map(csvCell).join(',');
                copyText(line, function () {
                    send.textContent = 'コピーしました';
                    setTimeout(function () { send.textContent = 'コピーする'; }, 2400);
                });
            };
            form.appendChild(send);

            form.appendChild(el('p', 'guide-rv-note', 'コピーして Discord で送ってください。'));

            function toggleForm() {
                form.classList.toggle('is-hidden');
                if (!form.classList.contains('is-hidden')) who.focus();
            }

            // --- 一覧 ---
            if (!revs.length) {
                pane.appendChild(el('div', 'guide-rv-empty', 'まだクチコミはありません'));
                return;
            }

            var list = el('div', 'guide-rv-list');
            revs.forEach(function (r) {
                var av = avatarOf(r.who || '?');
                var it = el('div', 'guide-rv-item');

                var top = el('div', 'guide-rv-who');
                var ic = el('span', 'guide-rv-avatar', av.initial);
                ic.style.backgroundColor = av.color;
                top.appendChild(ic);
                top.appendChild(el('span', 'guide-rv-name', r.who || '名無し'));
                it.appendChild(top);

                var line = el('div', 'guide-rv-line');
                line.innerHTML = starsHtml(+r.rating || 0) +
                    '<span class="guide-rv-date">' + (r.date || '') + '</span>';
                it.appendChild(line);

                if (r.text) it.appendChild(el('p', 'guide-rv-text-body', r.text));
                list.appendChild(it);
            });
            pane.appendChild(list);
        }

        // --- スマホ: シートを上下にドラッグする ------------------------------

        // つまみと空白部分だけで掴む。本文の上でやると中身がスクロールできない。
        (function () {
            var startY = null, startFull = false, moved = 0;

            function down(e) {
                if (!isNarrow()) return;
                startY = e.clientY;
                startFull = card.classList.contains('is-full');
                moved = 0;
                card.classList.add('is-dragging');
                grip.setPointerCapture(e.pointerId);
            }
            function move(e) {
                if (startY == null) return;
                moved = e.clientY - startY;
                // ドラッグ中だけ指に追従させる。離した時に class で落ち着かせる。
                card.style.transform = 'translateY(' + Math.max(startFull ? 0 : -160, moved) + 'px)';
            }
            function up(e) {
                if (startY == null) return;
                card.style.transform = '';
                card.classList.remove('is-dragging');
                startY = null;
                if (moved < -50) card.classList.add('is-full');
                else if (moved > 90) {
                    if (startFull) card.classList.remove('is-full');
                    else ctx.closePopup();
                }
                try { grip.releasePointerCapture(e.pointerId); } catch (err) {}
            }

            grip.addEventListener('pointerdown', down);
            grip.addEventListener('pointermove', move);
            grip.addEventListener('pointerup', up);
            grip.addEventListener('pointercancel', up);
            // つまみのタップだけでも開け閉めできるように
            grip.addEventListener('click', function () {
                if (Math.abs(moved) < 6) card.classList.toggle('is-full');
            });
        })();

        // --- 共有リンクで開かれたとき ----------------------------------------

        ctx.openFromHash = function () {
            var name;
            try { name = new URLSearchParams(location.hash.replace(/^#/, '')).get('p'); }
            catch (e) { return; }
            if (!name) return;

            var hit = null, kind = 'point';
            ctx.points.forEach(function (p) { if (!hit && p.name === name) hit = p; });
            if (!hit) { ctx.areas.forEach(function (x) { if (!hit && x.name === name) { hit = x; kind = 'area'; } }); }
            if (!hit) return;

            var view = ctx.olMap.getView();
            if (view.getZoom() < 0) view.setZoom(0);
            ctx.openPopup(hit, kind, false);   // 寄せるのは bringIntoView がやる
        };
    }

    // ---------------------------------------------------------- 地図の操作

    function buildInteractions(ctx) {
        var filter = function (l) { return guideLayers(ctx).indexOf(l) !== -1; };

        /*
         * 地点を先に、面は誰も当たらなかったときだけ拾う。
         *
         * 1回の走査でまとめて取り、あとから種類で優先すると駄目だった。
         * 面は塗りの内側どこでも当たるので、指1本ぶん外したタップは
         * ピンの判定半径(HIT_TOLERANCE)から外れた瞬間に面へ吸われる。
         * 街のポリゴンの中にある地点が事実上押せなくなっていた。
         */
        function pickAt(pixel, kind) {
            var found = null;
            ctx.olMap.forEachFeatureAtPixel(pixel, function (feature) {
                if (found || feature.get('guideKind') !== kind) return;
                found = {
                    item: feature.get('guideItem'),
                    kind: feature.get('guideKind'),
                    draft: feature.get('guideDraft')
                };
            }, {
                // 面は塗りの内側どこでも当たるので甘さを足す必要がない。
                // むしろ足すと外周のすぐ外まで面になり、街の縁の地点を隠す。
                hitTolerance: (kind === 'area') ? AREA_HIT_TOLERANCE : HIT_TOLERANCE,
                layerFilter: filter
            });
            return found;
        }
        ctx.pickAt = pickAt;

        function pick(pixel) { return pickAt(pixel, 'point') || pickAt(pixel, 'area'); }

        ctx.olMap.on('singleclick', function (evt) {
            // 範囲を描いている最中はクリックを取らない
            if (ctx.edit && ctx.drawMode === 'area') return;

            var hit = pick(evt.pixel);

            if (hit && hit.item && !ctx.isHidden(hit.item, hit.kind)) {
                ctx.openPopup(hit.item, hit.kind, hit.draft);
                return;
            }

            ctx.closePopup();

            // 編集モードでは、何も無いところをクリック＝地点の追加
            if (ctx.edit) {
                var c = ol.proj.transform(evt.coordinate, ctx.map.viewProjection, ctx.map.dataProjection);
                ctx.openPointForm(Math.round(c[0]), Math.round(c[1]));
            }
        });

        ctx.olMap.on('pointermove', function (evt) {
            if (evt.dragging) return;
            if (ctx.edit && ctx.drawMode === 'area') {
                ctx.olMap.getTargetElement().style.cursor = 'crosshair';
                return;
            }
            // クリックと同じ判定を使う。見た目のカーソルと実際に開くものがずれないように。
            var over = !!pick(evt.pixel);
            ctx.olMap.getTargetElement().style.cursor = over ? 'pointer' : (ctx.edit ? 'crosshair' : '');
        });
    }

    // -------------------------------------------------------------- 一覧UI

    function buildListPanel(ctx) {
        var panel = el('div', 'guide-panel');
        panel.classList.add('is-hidden');

        var header = el('div', 'guide-panel-header');
        header.appendChild(el('span', 'guide-panel-title', '地点一覧'));
        var closeBtn = el('button', 'guide-panel-close', '×');
        closeBtn.setAttribute('aria-label', '閉じる');
        header.appendChild(closeBtn);
        panel.appendChild(header);

        // --- カテゴリのフィルター -------------------------------------------
        var filterBox = el('div', 'guide-filters');
        panel.appendChild(filterBox);

        // renderList() の先頭で renderFilters() を呼んでいるのでここでは呼ばない
        function applyFilters() {
            guideLayers(ctx).forEach(function (l) { l.changed(); });
            ctx.renderList();
        }

        function renderFilters() {
            filterBox.innerHTML = '';
            var cats = ctx.config.categories || {};
            var used = {};
            ctx.points.concat(ctx.draftPoints).forEach(function (p) { used[p.category || ''] = true; });
            ctx.areas.concat(ctx.draftAreas).forEach(function (a) { used[a.category || ''] = true; });

            var nPoint = ctx.points.length + ctx.draftPoints.length;
            var nArea  = ctx.areas.length + ctx.draftAreas.length;

            // --- 種類（地点／範囲）の表示切り替え ---
            if (nPoint || nArea) {
                var kHead = el('div', 'guide-filters-head');
                kHead.appendChild(el('span', null, '表示する種類'));
                filterBox.appendChild(kHead);

                var kWrap = el('div', 'guide-filters-chips');
                [['point', '地点', nPoint], ['area', '範囲', nArea]].forEach(function (t) {
                    if (!t[2]) return;
                    var on = !ctx.hiddenKind[t[0]];
                    var chip = el('button', 'guide-chip-toggle' + (on ? ' is-on' : ''));
                    var mark = el('span', 'guide-dot' + (t[0] === 'area' ? ' is-area' : ''));
                    mark.style.backgroundColor = t[0] === 'area' ? 'transparent' : 'rgba(255,255,255,.75)';
                    if (t[0] === 'area') mark.style.borderColor = 'rgba(255,255,255,.75)';
                    chip.appendChild(mark);
                    chip.appendChild(el('span', null, t[1] + ' (' + t[2] + ')'));
                    chip.onclick = function () {
                        ctx.hiddenKind[t[0]] = on;
                        writeStore(HIDDEN_KIND_KEY, ctx.hiddenKind);
                        applyFilters();
                    };
                    kWrap.appendChild(chip);
                });
                filterBox.appendChild(kWrap);
            }

            // --- カテゴリの表示切り替え ---
            var keys = Object.keys(cats).filter(function (k) { return used[k]; });
            if (used['']) keys.push('');
            if (!keys.length) return;

            var head = el('div', 'guide-filters-head');
            head.appendChild(el('span', null, '表示するカテゴリ'));
            var all = el('button', 'guide-filters-all',
                keys.some(function (k) { return ctx.hidden[k]; }) ? 'すべて表示' : 'すべて隠す');
            all.onclick = function () {
                var anyHidden = keys.some(function (k) { return ctx.hidden[k]; });
                keys.forEach(function (k) { ctx.hidden[k] = !anyHidden; });
                writeStore(HIDDEN_KEY, ctx.hidden);
                applyFilters();
            };
            head.appendChild(all);
            filterBox.appendChild(head);

            var wrap = el('div', 'guide-filters-chips');
            keys.forEach(function (k) {
                var cat = cats[k] || { color: '#8b8b93', label: '未分類' };
                var on = !ctx.hidden[k];
                var chip = el('button', 'guide-chip-toggle' + (on ? ' is-on' : ''));
                var dot = el('span', 'guide-dot');
                dot.style.backgroundColor = cat.color;
                chip.appendChild(dot);
                chip.appendChild(el('span', null, cat.label || k || '未分類'));
                chip.onclick = function () {
                    ctx.hidden[k] = on;
                    writeStore(HIDDEN_KEY, ctx.hidden);
                    applyFilters();
                };
                wrap.appendChild(chip);
            });
            filterBox.appendChild(wrap);
        }

        var search = el('input', 'guide-search');
        search.type = 'search';
        search.placeholder = '名前・説明で絞り込み';
        panel.appendChild(search);

        var list = el('div', 'guide-list');
        panel.appendChild(list);

        var toggle = el('button', 'guide-toggle');
        toggle.setAttribute('aria-label', '地点一覧');
        toggle.title = '地点一覧';
        toggle.innerHTML =
            '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
            'stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';

        document.body.appendChild(panel);
        document.body.appendChild(toggle);

        function setOpen(open) {
            panel.classList.toggle('is-hidden', !open);
            toggle.classList.toggle('is-open', open);
            if (open) search.focus();
        }
        toggle.onclick = function () { setOpen(panel.classList.contains('is-hidden')); };
        closeBtn.onclick = function () { setOpen(false); };

        function row(item, kind, isDraft) {
            var cat = categoryOf(item, ctx.config);
            var el_ = el('button', 'guide-list-item' + (isDraft ? ' is-draft' : ''));

            var dot = el('span', 'guide-dot' + (kind === 'area' ? ' is-area' : ''));
            dot.style.backgroundColor = kind === 'area' ? rgba(cat.color, .35) : cat.color;
            if (kind === 'area') dot.style.borderColor = cat.color;
            el_.appendChild(dot);

            var body = el('div', 'guide-list-body');
            body.appendChild(el('div', 'guide-list-name', item.name));
            var a = ctx.anchorOf(item, kind);
            body.appendChild(el('div', 'guide-list-meta',
                (isDraft ? '下書き · ' : '') + (kind === 'area' ? '範囲 · ' : '') +
                (cat.label ? cat.label + ' · ' : '') + 'X ' + a[0] + ' Z ' + a[1]));
            el_.appendChild(body);

            el_.onclick = function () {
                var view = ctx.olMap.getView();
                if (view.getZoom() < 0) view.setZoom(0);
                // 地図を寄せるのは openPopup（bringIntoView）に任せる。
                // ここで center も呼ぶと、カードを避ける分だけ二度動いて見える。
                ctx.openPopup(item, kind, isDraft);
                if (isNarrow()) setOpen(false);
            };
            return el_;
        }

        ctx.renderList = function () {
            renderFilters();

            var q = (search.value || '').trim().toLowerCase();
            var ok = function (kind) {
                return function (item) {
                    if (ctx.isHidden(item, kind)) return false;
                    if (!q) return true;
                    return (item.name + ' ' + (item.description || '') + ' ' + (item.category || ''))
                        .toLowerCase().indexOf(q) !== -1;
                };
            };
            var byName = function (a, b) {
                return (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name, 'ja');
            };

            list.innerHTML = '';
            var dp = ctx.draftPoints.filter(ok('point')), da = ctx.draftAreas.filter(ok('area'));
            var sp = ctx.points.filter(ok('point')).sort(byName), sa = ctx.areas.filter(ok('area')).sort(byName);

            if (dp.length || da.length) {
                list.appendChild(el('div', 'guide-list-head', '下書き（未保存）'));
                da.forEach(function (x) { list.appendChild(row(x, 'area', true)); });
                dp.forEach(function (x) { list.appendChild(row(x, 'point', true)); });
            }
            if ((dp.length || da.length) && (sp.length || sa.length)) {
                list.appendChild(el('div', 'guide-list-head', '登録済み'));
            }
            sa.forEach(function (x) { list.appendChild(row(x, 'area', false)); });
            sp.forEach(function (x) { list.appendChild(row(x, 'point', false)); });

            if (!dp.length && !da.length && !sp.length && !sa.length) {
                list.appendChild(el('div', 'guide-empty',
                    ctx.edit ? '地図をクリックして地点を追加できます' : '表示できる地点がありません'));
            }
        };

        search.oninput = ctx.renderList;
        ctx.renderList();
    }

    // 紹介サイト側へ戻るリンク。guide.config.js で URL が与えられた時だけ出す。
    function buildBackLink() {
        var url;
        try { url = (typeof UnminedGuideBackUrl !== 'undefined') ? UnminedGuideBackUrl : null; }
        catch (e) { url = null; }
        if (!url) return;

        var a = el('a', 'guide-back');
        a.href = url;
        a.title = 'マップ一覧へ戻る';
        a.setAttribute('aria-label', 'マップ一覧へ戻る');
        a.innerHTML =
            '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
            'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M11 18l-6-6 6-6"/></svg>';
        document.body.appendChild(a);
    }

    // ------------------------------------------------------------ 編集モード

    function buildEditUi(ctx) {
        // --- 下辺のバー -----------------------------------------------------
        var bar = el('div', 'guide-editbar');
        bar.appendChild(el('span', 'guide-editbar-badge', '編集モード'));

        var modes = el('div', 'guide-modes');
        var mPoint = el('button', 'guide-mode is-on', '地点');
        var mArea  = el('button', 'guide-mode', '範囲');
        modes.appendChild(mPoint);
        modes.appendChild(mArea);
        bar.appendChild(modes);

        var hint = el('span', 'guide-editbar-hint', '地図をクリックして追加');
        bar.appendChild(hint);

        var count = el('span', 'guide-editbar-count');
        bar.appendChild(count);

        var btnPt   = el('button', 'guide-editbar-btn is-primary', '地点CSV');
        var btnAr   = el('button', 'guide-editbar-btn is-primary', '範囲CSV');
        var btnClr  = el('button', 'guide-editbar-btn', '消去');
        bar.appendChild(btnPt); bar.appendChild(btnAr); bar.appendChild(btnClr);
        document.body.appendChild(bar);

        ctx.updateEditCount = function () {
            var np = ctx.draftPoints.length, na = ctx.draftAreas.length;
            count.textContent = (np || na) ? ('地点 ' + np + ' / 範囲 ' + na) : '';
            btnPt.disabled = !np;
            btnAr.disabled = !na;
            btnClr.disabled = !(np || na);
        };

        // --- 描画モードの切り替え -------------------------------------------
        var draw = null;
        function setMode(mode) {
            ctx.drawMode = mode;
            mPoint.classList.toggle('is-on', mode === 'point');
            mArea.classList.toggle('is-on', mode === 'area');
            hint.textContent = (mode === 'area')
                ? '頂点をクリック、ダブルクリックで確定'
                : '地図をクリックして追加';

            if (draw) { ctx.olMap.removeInteraction(draw); draw = null; }
            if (mode !== 'area') return;

            draw = new ol.interaction.Draw({
                type: 'Polygon',
                style: new ol.style.Style({
                    fill: new ol.style.Fill({ color: 'rgba(0,229,160,.14)' }),
                    stroke: new ol.style.Stroke({ color: '#00e5a0', width: 2.5, lineDash: [6, 5] }),
                    image: new ol.style.Circle({
                        radius: 5,
                        fill: new ol.style.Fill({ color: '#00e5a0' }),
                        stroke: new ol.style.Stroke({ color: 'rgba(0,0,0,.6)', width: 1.5 })
                    })
                })
            });
            draw.on('drawend', function (e) {
                var ring = e.feature.getGeometry().getCoordinates()[0];
                var pts = ring.map(function (c) {
                    var w = ol.proj.transform(c, ctx.map.viewProjection, ctx.map.dataProjection);
                    return [Math.round(w[0]), Math.round(w[1])];
                });
                // 閉じるための重複した最終点は落とす
                if (pts.length > 1 &&
                    pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) {
                    pts.pop();
                }
                if (pts.length < 3) return;
                setTimeout(function () { ctx.openAreaForm(pts); }, 0);
            });
            ctx.olMap.addInteraction(draw);
        }
        mPoint.onclick = function () { setMode('point'); };
        mArea.onclick  = function () { setMode('area'); };

        // --- 書き出し -------------------------------------------------------
        function flash(btn, label) {
            var old = btn.textContent;
            btn.textContent = label;
            setTimeout(function () { btn.textContent = old; }, 1800);
        }

        btnPt.onclick = function () {
            // guide.locations.csv と同じ列順（ヘッダー無し＝追記用）
            var rows = ctx.draftPoints.map(function (d) {
                return [d.name, d.x, d.z, d.y != null ? d.y : '', d.category || '',
                        d.dimension || ctx.dim || '', d.description || ''].map(csvCell).join(',');
            }).join('\n');
            copyText(rows, function () { flash(btnPt, 'コピー済'); });
        };

        btnAr.onclick = function () {
            // guide.areas.csv と同じ列順: name,category,dimension,points,description
            var rows = ctx.draftAreas.map(function (a) {
                var pts = a.points.map(function (p) { return p[0] + ' ' + p[1]; }).join(';');
                return [a.name, a.category || '', a.dimension || ctx.dim || '', pts,
                        a.description || ''].map(csvCell).join(',');
            }).join('\n');
            copyText(rows, function () { flash(btnAr, 'コピー済'); });
        };

        btnClr.onclick = function () {
            var n = ctx.draftPoints.length + ctx.draftAreas.length;
            if (!confirm('下書き ' + n + ' 件をすべて消去します。よろしいですか？')) return;
            ctx.draftPoints = []; ctx.draftAreas = [];
            ctx.saveDrafts();
            ctx.refreshAll();
            ctx.closePopup();
        };

        // --- 入力フォーム ---------------------------------------------------
        var form = el('div', 'guide-form');
        form.classList.add('is-hidden');
        document.body.appendChild(form);

        function buildForm(title, subtitle, extra, onSave) {
            form.innerHTML = '';

            var head = el('div', 'guide-form-head');
            head.appendChild(el('span', 'guide-form-title', title));
            var fc = el('button', 'guide-panel-close', '×');
            fc.onclick = function () { form.classList.add('is-hidden'); };
            head.appendChild(fc);
            form.appendChild(head);

            form.appendChild(el('div', 'guide-form-coords', subtitle));

            var name = el('input', 'guide-input');
            name.type = 'text';
            name.placeholder = '名前（必須）';
            form.appendChild(name);

            var cat = el('select', 'guide-input guide-select');
            var cats = ctx.config.categories || {};
            var empty = el('option', null, 'カテゴリなし');
            empty.value = '';
            cat.appendChild(empty);
            Object.keys(cats).forEach(function (k) {
                var o = el('option', null, cats[k].label || k);
                o.value = k;
                cat.appendChild(o);
            });
            form.appendChild(cat);

            var y = null;
            if (extra === 'y') {
                y = el('input', 'guide-input');
                y.type = 'number';
                y.placeholder = 'Y座標（任意）';
                form.appendChild(y);
            }

            var desc = el('textarea', 'guide-input guide-textarea');
            desc.placeholder = '説明（任意）';
            form.appendChild(desc);

            var actions = el('div', 'guide-form-actions');
            var cancel = el('button', 'guide-editbar-btn', 'やめる');
            var save   = el('button', 'guide-editbar-btn is-primary', '追加');
            actions.appendChild(cancel);
            actions.appendChild(save);
            form.appendChild(actions);

            cancel.onclick = function () { form.classList.add('is-hidden'); };
            save.onclick = function () {
                var n = name.value.trim();
                if (!n) { name.focus(); name.classList.add('is-error'); return; }
                onSave(n, cat.value, y ? y.value : '', desc.value.trim());
                form.classList.add('is-hidden');
                ctx.refreshAll();
            };
            name.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') { e.preventDefault(); save.click(); }
            });

            form.classList.remove('is-hidden');
            name.focus();
        }

        ctx.openPointForm = function (x, z) {
            buildForm('地点を追加', 'X ' + x + '   Z ' + z, 'y', function (n, category, yv, description) {
                var loc = { name: n, x: x, z: z, dimension: ctx.dim || undefined };
                if (category) loc.category = category;
                if (yv !== '') loc.y = parseInt(yv, 10);
                if (description) loc.description = description;
                ctx.draftPoints.push(loc);
                ctx.saveDrafts();
            });
        };

        ctx.openAreaForm = function (pts) {
            buildForm('範囲を追加', pts.length + ' 頂点', null, function (n, category, _y, description) {
                var a = { name: n, points: pts, dimension: ctx.dim || undefined };
                if (category) a.category = category;
                if (description) a.description = description;
                ctx.draftAreas.push(a);
                ctx.saveDrafts();
            });
        };

        setMode('point');
        ctx.updateEditCount();
    }

    // ---------------------------------------------------------------- start

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { waitForMap(init); });
    } else {
        waitForMap(init);
    }
})();
