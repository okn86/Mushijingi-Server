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
    var HIT_TOLERANCE  = 14;   // 指でのタップ判定の甘さ（px）
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
    }

    // ------------------------------------------------------------ レイヤー

    // ラベルの出し方を 3 段階で決める。
    //   'off'       … 引きすぎ。ラベルは出さない
    //   'declutter' … 通常。重なったラベルは退避して消える
    //   'always'    … 最大まで拡大した時。重なっても全部出す
    function labelState(ctx) {
        var view = ctx.olMap.getView();
        var z = view.getZoom();
        if (z == null) return 'off';

        var res = view.getResolutions();
        var maxZ = res ? res.length - 1 : 0;

        if (z >= maxZ - 0.01) return 'always';
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

    // ---------------------------------------------------------- ポップアップ

    function buildPopup(ctx) {
        var popupEl = el('div', 'guide-popup');
        popupEl.style.display = 'none';
        document.body.appendChild(popupEl);

        var overlay = new ol.Overlay({
            // 丸の中心が地点なので、吹き出しは丸の半径ぶんだけ上に置く
            element: popupEl, positioning: 'bottom-center', offset: [0, -16],
            stopEvent: true, autoPan: { animation: { duration: 200 }, margin: 24 }
        });
        ctx.olMap.addOverlay(overlay);

        ctx.closePopup = function () {
            popupEl.style.display = 'none';
            overlay.setPosition(undefined);
        };

        // 範囲の代表点（ラベルが出る位置）
        function anchorOf(item, kind) {
            if (kind === 'point') return [item.x, item.z];
            var sx = 0, sz = 0;
            item.points.forEach(function (p) { sx += p[0]; sz += p[1]; });
            return [Math.round(sx / item.points.length), Math.round(sz / item.points.length)];
        }

        ctx.openPopup = function (item, kind, isDraft) {
            var cat = categoryOf(item, ctx.config);
            popupEl.innerHTML = '';

            var close = el('button', 'guide-popup-close', '×');
            close.setAttribute('aria-label', '閉じる');
            close.onclick = ctx.closePopup;
            popupEl.appendChild(close);

            if (isDraft) {
                var d = el('span', 'guide-chip', '下書き');
                d.style.backgroundColor = '#8b8b93';
                popupEl.appendChild(d);
            }
            if (kind === 'area') {
                var k = el('span', 'guide-chip', '範囲');
                k.style.backgroundColor = '#5b5b66';
                popupEl.appendChild(k);
            }
            if (cat.label) {
                var chip = el('span', 'guide-chip', cat.label);
                chip.style.backgroundColor = cat.color;
                popupEl.appendChild(chip);
            }

            popupEl.appendChild(el('div', 'guide-popup-title', item.name));
            if (item.description) popupEl.appendChild(el('div', 'guide-popup-desc', item.description));

            var a = anchorOf(item, kind);
            var coords = el('div', 'guide-popup-coords');
            coords.appendChild(el('span', null, kind === 'area'
                ? '中心 X ' + a[0] + '  Z ' + a[1] + '  （' + item.points.length + '頂点）'
                : 'X ' + item.x + '  Z ' + item.z + (item.y != null ? '  Y ' + item.y : '')));

            var copy = el('button', 'guide-copy', 'コピー');
            copy.onclick = function () {
                copyText(a[0] + ' ' + (kind === 'point' && item.y != null ? item.y + ' ' : '') + a[1], function () {
                    copy.textContent = 'コピー済';
                    setTimeout(function () { copy.textContent = 'コピー'; }, 1400);
                });
            };
            coords.appendChild(copy);
            popupEl.appendChild(coords);

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
                popupEl.appendChild(del);
            }

            popupEl.style.display = 'block';
            overlay.setPosition(ol.proj.transform(a, ctx.map.dataProjection, ctx.map.viewProjection));
        };
        ctx.anchorOf = anchorOf;
    }

    // ---------------------------------------------------------- 地図の操作

    function buildInteractions(ctx) {
        var filter = function (l) { return guideLayers(ctx).indexOf(l) !== -1; };

        ctx.olMap.on('singleclick', function (evt) {
            // 範囲を描いている最中はクリックを取らない
            if (ctx.edit && ctx.drawMode === 'area') return;

            var hit = null;
            ctx.olMap.forEachFeatureAtPixel(evt.pixel, function (feature) {
                // ピンを面より優先する
                if (!hit || (hit.kind === 'area' && feature.get('guideKind') === 'point')) {
                    hit = {
                        item: feature.get('guideItem'),
                        kind: feature.get('guideKind'),
                        draft: feature.get('guideDraft')
                    };
                }
            }, { hitTolerance: HIT_TOLERANCE, layerFilter: filter });

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
            var over = ctx.olMap.hasFeatureAtPixel(evt.pixel, { hitTolerance: HIT_TOLERANCE, layerFilter: filter });
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
                ctx.map.center(a);
                var view = ctx.olMap.getView();
                if (view.getZoom() < 0) view.setZoom(0);
                ctx.openPopup(item, kind, isDraft);
                if (window.matchMedia('(max-width: 640px)').matches) setOpen(false);
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
