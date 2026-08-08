/*
 * guide.js - uNmINeD の Web マップに「案内マップ」機能を追加する。
 *
 *   - 登録地点にピンを表示（カテゴリ別の色分け）
 *   - ピンをタップ/クリックすると名前・説明・座標をポップアップ表示
 *   - 一覧パネルから検索してその場所へ飛べる
 *
 * uNmINeD 本体には手を入れず、OpenLayers の地図オブジェクト
 * (unmined.olMap) に外から乗る形で実装している。
 * 地点データは guide.locations.js を参照。
 */
(function () {
    'use strict';

    var LABEL_MIN_ZOOM = -3;   // これより引くとラベルを隠す（ピンは残す）
    var HIT_TOLERANCE  = 14;   // 指でのタップ判定の甘さ（px）

    // ---------------------------------------------------------------- utils

    function el(tag, className, text) {
        var e = document.createElement(tag);
        if (className) e.className = className;
        if (text != null) e.textContent = text;
        return e;
    }

    // カテゴリ設定を引く。未定義のカテゴリでも落ちないようにする。
    function categoryOf(loc, config) {
        var cats = (config && config.categories) || {};
        return cats[loc.category] || { color: '#e8663d', label: loc.category || '' };
    }

    // 色付きのピン画像を SVG データ URI で作る（外部リクエストを発生させない）
    var pinCache = {};
    function pinImage(color) {
        if (pinCache[color]) return pinCache[color];
        var svg =
            '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="34" viewBox="0 0 26 34">' +
            '<path d="M13 33C13 33 24.5 19.6 24.5 12.5A11.5 11.5 0 1 0 1.5 12.5C1.5 19.6 13 33 13 33Z" ' +
            'fill="' + color + '" stroke="rgba(0,0,0,.55)" stroke-width="1.5"/>' +
            '<circle cx="13" cy="12.3" r="4.4" fill="rgba(255,255,255,.92)"/>' +
            '</svg>';
        pinCache[color] = 'data:image/svg+xml;base64,' + btoa(svg);
        return pinCache[color];
    }

    // ------------------------------------------------------------ 起動待ち

    // unmined は index.html 内の classic script で const 宣言されているため
    // window には乗らないが、グローバルスコープ経由で参照できる。
    function waitForMap(callback) {
        var tries = 0;

        // unmined は const 宣言なので、初期化前に触れると typeof でも
        // ReferenceError (TDZ) になる。読み込み順に依存しないよう握り潰す。
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
        if (!config || !config.locations || !config.locations.length) return;

        // このマップのディメンションに属する地点だけ拾う。
        // dimension 未指定の地点はどのマップにも出す。
        var dim = (typeof UnminedGuideDimension !== 'undefined') ? UnminedGuideDimension : null;
        var locations = config.locations.filter(function (loc) {
            return !loc.dimension || !dim || loc.dimension === dim;
        });
        if (!locations.length) return;

        var olMap = map.olMap;

        // --- フィーチャ生成 ---
        var features = locations.map(function (loc, i) {
            var f = new ol.Feature({
                geometry: new ol.geom.Point(
                    ol.proj.transform([loc.x, loc.z], map.dataProjection, map.viewProjection))
            });
            f.set('guideIndex', i);
            f.set('guideLocation', loc);
            return f;
        });

        var source = new ol.source.Vector({ features: features });

        var styleCache = {};
        var layer = new ol.layer.Vector({
            source: source,
            declutter: true,
            zIndex: 50,
            style: function (feature, resolution) {
                var loc = feature.get('guideLocation');
                var cat = categoryOf(loc, config);
                var showLabel = olMap.getView().getZoom() >= LABEL_MIN_ZOOM;
                var key = cat.color + '|' + (showLabel ? loc.name : '');

                if (!styleCache[key]) {
                    styleCache[key] = new ol.style.Style({
                        image: new ol.style.Icon({
                            src: pinImage(cat.color),
                            anchor: [0.5, 1],
                            scale: 1
                        }),
                        text: showLabel ? new ol.style.Text({
                            text: loc.name,
                            font: '600 13px system-ui, "Segoe UI", sans-serif',
                            offsetY: 12,
                            fill: new ol.style.Fill({ color: '#fff' }),
                            stroke: new ol.style.Stroke({ color: 'rgba(0,0,0,.85)', width: 3 }),
                            padding: [2, 4, 2, 4]
                        }) : null
                    });
                }
                return styleCache[key];
            }
        });
        olMap.addLayer(layer);

        // ズームでラベルの出し入れが変わるので再描画させる
        var lastShow = null;
        olMap.getView().on('change:resolution', function () {
            var show = olMap.getView().getZoom() >= LABEL_MIN_ZOOM;
            if (show !== lastShow) { lastShow = show; layer.changed(); }
        });

        // --- ポップアップ ---
        var popupEl = el('div', 'guide-popup');
        popupEl.style.display = 'none';
        document.body.appendChild(popupEl);

        var overlay = new ol.Overlay({
            element: popupEl,
            positioning: 'bottom-center',
            offset: [0, -36],
            stopEvent: true,
            autoPan: { animation: { duration: 200 }, margin: 24 }
        });
        olMap.addOverlay(overlay);

        function closePopup() {
            popupEl.style.display = 'none';
            overlay.setPosition(undefined);
        }

        function openPopup(loc) {
            var cat = categoryOf(loc, config);
            popupEl.innerHTML = '';

            var close = el('button', 'guide-popup-close', '×');
            close.setAttribute('aria-label', '閉じる');
            close.onclick = closePopup;
            popupEl.appendChild(close);

            if (cat.label) {
                var chip = el('span', 'guide-chip', cat.label);
                chip.style.backgroundColor = cat.color;
                popupEl.appendChild(chip);
            }

            popupEl.appendChild(el('div', 'guide-popup-title', loc.name));

            if (loc.description) {
                popupEl.appendChild(el('div', 'guide-popup-desc', loc.description));
            }

            var coordText = 'X ' + loc.x + '  Z ' + loc.z + (loc.y != null ? '  Y ' + loc.y : '');
            var coords = el('div', 'guide-popup-coords');
            coords.appendChild(el('span', null, coordText));

            var copy = el('button', 'guide-copy', 'コピー');
            copy.onclick = function () {
                var text = loc.x + ' ' + (loc.y != null ? loc.y + ' ' : '') + loc.z;
                var done = function () { copy.textContent = 'コピー済'; setTimeout(function () { copy.textContent = 'コピー'; }, 1400); };
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(text).then(done, function () {});
                } else {
                    var ta = el('textarea'); ta.value = text; document.body.appendChild(ta);
                    ta.select(); try { document.execCommand('copy'); done(); } catch (e) {}
                    document.body.removeChild(ta);
                }
            };
            coords.appendChild(copy);
            popupEl.appendChild(coords);

            popupEl.style.display = 'block';
            overlay.setPosition(ol.proj.transform([loc.x, loc.z], map.dataProjection, map.viewProjection));
        }

        // --- タップ/クリック ---
        olMap.on('singleclick', function (evt) {
            var hit = olMap.forEachFeatureAtPixel(evt.pixel,
                function (feature) { return feature.get('guideLocation') || null; },
                { hitTolerance: HIT_TOLERANCE, layerFilter: function (l) { return l === layer; } });

            if (hit) openPopup(hit); else closePopup();
        });

        // マウス環境ではピンの上でカーソルを変える
        olMap.on('pointermove', function (evt) {
            if (evt.dragging) return;
            var over = olMap.hasFeatureAtPixel(evt.pixel,
                { hitTolerance: HIT_TOLERANCE, layerFilter: function (l) { return l === layer; } });
            olMap.getTargetElement().style.cursor = over ? 'pointer' : '';
        });

        // --- 一覧パネル・戻る導線 ---
        buildListPanel(map, locations, config, openPopup);
        buildBackLink();
    }

    // 紹介サイト側へ戻るリンク。guide.config.js で URL が与えられた時だけ出す。
    function buildBackLink() {
        var url;
        try { url = (typeof UnminedGuideBackUrl !== 'undefined') ? UnminedGuideBackUrl : null; }
        catch (e) { url = null; }
        if (!url) return;

        var a = el('a', 'guide-back');
        a.href = url;
        a.innerHTML =
            '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
            'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M11 18l-6-6 6-6"/></svg>';
        a.appendChild(document.createTextNode('マップ一覧'));
        document.body.appendChild(a);
    }

    // -------------------------------------------------------------- 一覧UI

    function buildListPanel(map, locations, config, openPopup) {
        var panel = el('div', 'guide-panel');
        panel.classList.add('is-hidden');

        var header = el('div', 'guide-panel-header');
        header.appendChild(el('span', 'guide-panel-title', '地点一覧'));
        var closeBtn = el('button', 'guide-panel-close', '×');
        closeBtn.setAttribute('aria-label', '閉じる');
        header.appendChild(closeBtn);
        panel.appendChild(header);

        var search = el('input', 'guide-search');
        search.type = 'search';
        search.placeholder = '名前・説明で絞り込み';
        panel.appendChild(search);

        var list = el('div', 'guide-list');
        panel.appendChild(list);

        var toggle = el('button', 'guide-toggle');
        toggle.setAttribute('aria-label', '地点一覧');
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

        var sorted = locations.slice().sort(function (a, b) {
            return (a.category || '').localeCompare(b.category || '') ||
                   a.name.localeCompare(b.name, 'ja');
        });

        function render(filter) {
            list.innerHTML = '';
            var q = (filter || '').trim().toLowerCase();
            var shown = 0;

            sorted.forEach(function (loc) {
                var hay = (loc.name + ' ' + (loc.description || '') + ' ' + (loc.category || '')).toLowerCase();
                if (q && hay.indexOf(q) === -1) return;
                shown++;

                var cat = categoryOf(loc, config);
                var item = el('button', 'guide-list-item');

                var dot = el('span', 'guide-dot');
                dot.style.backgroundColor = cat.color;
                item.appendChild(dot);

                var body = el('div', 'guide-list-body');
                body.appendChild(el('div', 'guide-list-name', loc.name));
                body.appendChild(el('div', 'guide-list-meta',
                    (cat.label ? cat.label + ' · ' : '') + 'X ' + loc.x + ' Z ' + loc.z));
                item.appendChild(body);

                item.onclick = function () {
                    map.center([loc.x, loc.z]);
                    var view = map.olMap.getView();
                    if (view.getZoom() < 0) view.setZoom(0);
                    openPopup(loc);
                    if (window.matchMedia('(max-width: 640px)').matches) setOpen(false);
                };
                list.appendChild(item);
            });

            if (!shown) list.appendChild(el('div', 'guide-empty', '該当する地点がありません'));
        }

        search.oninput = function () { render(search.value); };
        render('');
    }

    // ---------------------------------------------------------------- start

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { waitForMap(init); });
    } else {
        waitForMap(init);
    }
})();
