/*
 * 地図の上に重ねる 3D ビュー（蟲神器市のみ）。
 *
 * 地図で「3D」を押したときだけ読み込む。開いた瞬間のカメラは、そのとき
 * 地図が映していた場所と縮尺にそろえてある。真上から見た状態は 2D と
 * 一致するので、そこから傾けると同じ場所がそのまま起き上がって見える。
 *
 * データは近い順に 4 段階（形つき / 立方体 / 2倍粗 / 4倍粗）。
 * 開いただけなら一番粗い段階しか読まないので、通信量は 1 MB 前後で収まる。
 *
 * 外部ライブラリは使っていない。地図側が OpenLayers を読んでいるので、
 * ここで別の 3D ライブラリを足すと読み込みがそのぶん重くなるため。
 */
window.City3D = (function () {
'use strict';

var BASE = 'city3d/';          // タイルと絵の置き場（呼び出し側で差し替え可）
var host = null, cv = null, hud = null, help = null, pinBtn = null, loading = null, gl = null;
var booted = false, opened = false;
var onClose = null;

// ---- 画面の組み立て --------------------------------------------------------
function build(parent) {
    host = document.createElement('div');
    host.className = 'city3d';
    cv = document.createElement('canvas');
    cv.className = 'city3d-canvas';
    hud = document.createElement('div');
    hud.className = 'city3d-hud';
    hud.textContent = '読み込み中…';

    var back = document.createElement('button');
    back.className = 'city3d-close';
    back.innerHTML =
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M15 5l-7 7 7 7"/></svg><span>地図へ戻る</span>';
    back.onclick = function () { closeView(); };

    // ピンの表示切り替え。景色だけ見たいときに邪魔になるので消せるようにする。
    pinBtn = document.createElement('button');
    pinBtn.className = 'city3d-pintoggle is-on';
    pinBtn.title = '地点のピン';
    pinBtn.innerHTML =
        '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"/>' +
        '<circle cx="12" cy="10" r="2.6"/></svg><span>ピン</span>';
    pinBtn.onclick = function () { showPins(!pinsOn); };

    help = document.createElement('div');
    help.className = 'city3d-help';
    // 指と マウスでは操作が違うので、書き分ける。
    var touch = false;
    try { touch = window.matchMedia('(pointer: coarse)').matches; } catch (e) {}
    help.textContent = touch
        ? '1本指で移動 / 2本指でひねると回転・そろえて上下で角度 / つまんで拡大'
        : 'ドラッグで移動 / 右ドラッグ・Shift+ドラッグで回転 / ホイールで拡大';

    host.appendChild(cv);
    host.appendChild(hud);
    host.appendChild(back);
    host.appendChild(pinBtn);
    host.appendChild(help);
    parent.appendChild(host);

    // 読み込み中の表示。host の外に置く。
    // 中に入れると、host ごと隠している間はこれも見えない。
    loading = document.createElement('div');
    loading.className = 'city3d-loading';
    loading.innerHTML = '<span class="city3d-spin"></span>3D を読み込み中…';
    parent.appendChild(loading);

    gl = cv.getContext('webgl2', { antialias: true });
    if (!gl) return false;
    initGL();
    bindControls();
    return true;
}

/*
 * タイルに分けた街を出す試作ビューア。
 *
 * 近いタイルは細かい形つき、遠いタイルは立方体だけの荒い版に切り替える。
 * まず全タイルの荒い版を読んで街全体を出し、そのあとカメラに近いものから
 * 細かい版を読む。全部を細かい版で持つと 165 万三角になり重すぎる。
 *
 * ライブラリを使っていないのは、どれだけ出せるかを測るのが目的で、
 * 間に何か挟むとその重さが混ざって判断できなくなるため。
 */

// ---- 行列 ----
const persp = (f, a, n, fa) => { const t = 1 / Math.tan(f / 2); return [t/a,0,0,0, 0,t,0,0, 0,0,(fa+n)/(n-fa),-1, 0,0,2*fa*n/(n-fa),0]; };
const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const norm=(a)=>{const l=Math.hypot(...a)||1;return [a[0]/l,a[1]/l,a[2]/l];};
function look(e, c, u) {
    const z = norm(sub(e, c)), x = norm(cross(u, z)), y = cross(z, x);
    return [x[0],y[0],z[0],0, x[1],y[1],z[1],0, x[2],y[2],z[2],0, -dot(x,e),-dot(y,e),-dot(z,e),1];
}
const mul = (a, b) => { const o = new Array(16); for (let i=0;i<4;i++) for (let j=0;j<4;j++) { let s=0; for (let k=0;k<4;k++) s += a[k*4+j]*b[i*4+k]; o[i*4+j]=s; } return o; };

// ---- シェーダ ----
const VS = `#version 300 es
in vec3 aPos; in vec3 aNor; in vec4 aCol; in vec2 aUV; in float aLayer;
uniform mat4 uVP; uniform vec3 uOff; uniform float uScale;
out vec3 vN; out vec4 vC; out vec2 vUV; out float vL;
void main(){
    vN=aNor; vC=aCol; vUV=aUV; vL=aLayer;
    // 頂点はタイル原点からの 1/16 ブロック単位の整数で来る
    gl_Position = uVP * vec4(aPos * uScale + uOff, 1.0);
}`;
const FS = `#version 300 es
precision mediump float; precision mediump sampler2DArray;
in vec3 vN; in vec4 vC; in vec2 vUV; in float vL;
uniform sampler2DArray uTex;
uniform float uBlend;               // 0=不透明パス 1=ガラスのパス
out vec4 outColor;
void main(){
    // UV は 1/16 ブロック単位（テクセル）で来る。16 で割ってタイル数に戻す。
    vec4 t = (vL > 32767.0) ? vec4(1.0) : texture(uTex, vec3(vUV / 16.0, vL));
    // 葉や草は抜く。ガラスは抜かずに合成する（抜くとミップで不透明に化ける）
    if (uBlend < 0.5 && t.a < 0.5) discard;
    vec3 n = normalize(vN);
    // マイクラ本体と同じ、面の向きだけで決まる陰影。
    // 斜めの光源を置くと東を向いた壁だけ明るくなり、東側から街を見たときに
    // 淡いガラスが空の明るさに紛れて見えにくくなる。
    // 東西・南北を同じ値にすることで、どちらから回り込んでも同じ見え方になる。
    float f = n.y > 0.5 ? 1.0
            : (n.y < -0.5 ? 0.55
            : (abs(n.x) > 0.5 ? 0.72 : 0.86));
    vec3 c = t.rgb * vC.rgb * f;
    // ガラスは枠だけだと寂しいので、面全体にうっすら色を乗せる
    float a = (uBlend > 0.5) ? max(t.a, 0.42) : 1.0;
    outColor = vec4(c, a);
}`;
function sh(t, s) { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o);
    if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; }

// gl は canvas を作ってからでないと存在しないので、組み立ては build() のあと。
let prog = null, A = null, uVP, uTex, uBlend, uOff, uScale;
function initGL() {
    prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog); gl.useProgram(prog);
    A = {
        pos: gl.getAttribLocation(prog,'aPos'), nor: gl.getAttribLocation(prog,'aNor'),
        col: gl.getAttribLocation(prog,'aCol'), uv: gl.getAttribLocation(prog,'aUV'),
        layer: gl.getAttribLocation(prog,'aLayer'),
    };
    uVP = gl.getUniformLocation(prog,'uVP'); uTex = gl.getUniformLocation(prog,'uTex');
    uBlend = gl.getUniformLocation(prog,'uBlend');
    uOff = gl.getUniformLocation(prog,'uOff'); uScale = gl.getUniformLocation(prog,'uScale');
}

// ---- テクスチャ配列 ----
// blocks.png は 16×16 のコマを 32 列の格子に並べたもの。
// 縦 1 列に積むと 900 層あたりで MAX_TEXTURE_SIZE（8192）を超えて
// 画像ごと拒否されるので、格子で持って読み込み時に層へ詰め直す。
function loadTexArray(url, layers, cols) {
    return new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => {
            const cvs = document.createElement('canvas');
            cvs.width = img.width; cvs.height = img.height;
            const ctx = cvs.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0);
            const src = ctx.getImageData(0, 0, img.width, img.height).data;
            const data = new Uint8Array(layers * 16 * 16 * 4);
            for (let i = 0; i < layers; i++) {
                const cx = (i % cols) * 16, cy = ((i / cols) | 0) * 16;
                for (let y = 0; y < 16; y++) {
                    const s = ((cy + y) * img.width + cx) * 4;
                    data.set(src.subarray(s, s + 16 * 4), (i * 16 + y) * 16 * 4);
                }
            }
            const tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
            gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, 16, 16, layers, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
            gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
            const ext = gl.getExtension('EXT_texture_filter_anisotropic');
            if (ext) gl.texParameterf(gl.TEXTURE_2D_ARRAY, ext.TEXTURE_MAX_ANISOTROPY_EXT,
                Math.min(8, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
            res(tex);
        };
        img.onerror = () => rej(new Error('テクスチャが読めない'));
        img.src = url;
    });
}

// ---- glb ----
const TYPE_N = { SCALAR:1, VEC2:2, VEC3:3, VEC4:4 };
const CT = { 5120:Int8Array, 5121:Uint8Array, 5122:Int16Array, 5123:Uint16Array, 5125:Uint32Array, 5126:Float32Array };

// 先に gzip したものを置いてある場合はそれを取り、ブラウザ側で解く。
// Content-Encoding が付いていないので自動では解かれない（そこが狙いで、
// GitHub Pages は glb に何もしてくれないため自前で圧縮している）。
let USE_GZ = false;
let net = 0;                        // 実際に線を通ったバイト数（圧縮後）

async function loadGlb(url) {
    let buf;
    if (USE_GZ) {
        const r = await fetch(url + '.gz');
        if (!r.ok) throw new Error(url + ' が読めない');
        const z = await r.arrayBuffer();
        net += z.byteLength;
        buf = await new Response(new Blob([z]).stream()
            .pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    } else {
        buf = await (await fetch(url)).arrayBuffer();
        net += buf.byteLength;
    }
    const dv = new DataView(buf);
    let off = 12, json = null, bin = null;
    while (off < dv.byteLength) {
        const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
        const body = buf.slice(off + 8, off + 8 + len);
        if (type === 0x4E4F534A) json = JSON.parse(new TextDecoder().decode(body));
        else if (type === 0x004E4942) bin = body;
        off += 8 + len;
    }
    const read = (ai) => {
        const a = json.accessors[ai], bv = json.bufferViews[a.bufferView];
        return new CT[a.componentType](bin, (bv.byteOffset || 0) + (a.byteOffset || 0), a.count * TYPE_N[a.type]);
    };
    const ps = json.meshes[0].primitives;
    const pr = ps[0];
    const r = (json.extras && json.extras.ranges) || { opaqueQuads: 0, glassQuads: 0 };
    return {
        pos: read(pr.attributes.POSITION), nor: read(pr.attributes.NORMAL), col: read(pr.attributes.COLOR_0),
        uv: read(pr.attributes.TEXCOORD_0), lay: read(pr.attributes._LAYER),
        // 索引は入っていない。四角の数だけ分かれば共用のもので描ける。
        opaqueQuads: r.opaqueQuads, glassQuads: r.glassQuads,
        posType: json.accessors[pr.attributes.POSITION].componentType,
        layers: (json.extras && json.extras.textureLayers) || 0,
        off: (json.nodes[0].translation || [0,0,0]),
        scale: (json.nodes[0].scale || [1,1,1])[0],
        bounds: (json.extras && json.extras.bounds) || null,
        min: json.accessors[pr.attributes.POSITION].min, max: json.accessors[pr.attributes.POSITION].max,
    };
}

// 全タイル共通の索引。四角 n 個ぶんを [0,1,2, 0,2,3] で並べたもの。
// 各タイルの索引を書き出さない代わりにこれを 1 本だけ持つ。
// 圧縮後の 5 割が索引だったので、通信量がそのぶん丸ごと消える。
let shareIB = null, shareQuads = 0;
function sharedIndex(quads) {
    if (shareIB && shareQuads >= quads) return shareIB;
    shareQuads = Math.max(quads, shareQuads * 2, 65536);
    // 頂点が 65536 を超えるタイルがあるので索引は 32bit
    const a = new Uint32Array(shareQuads * 6);
    for (let q = 0, o = 0, b = 0; q < shareQuads; q++, b += 4) {
        a[o++] = b; a[o++] = b + 1; a[o++] = b + 2;
        a[o++] = b; a[o++] = b + 2; a[o++] = b + 3;
    }
    if (!shareIB) shareIB = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, shareIB);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, a, gl.STATIC_DRAW);
    return shareIB;
}

// 頂点配列オブジェクトにまとめておくと、タイルの切り替えが 1 コールで済む
function upload(m) {
    // 頂点は 1 組。前半が不透明、後半がガラス。
    // 索引はどちらも「先頭から連番」なので共用のものを使い、
    // ガラス側は頂点の読み出し位置をずらすことで後半を指させる。
    //
    // VAO を 2 つ作るのが肝。索引バッファの結び付けは VAO の状態に含まれるので、
    // 1 つの VAO を使い回してガラスを描く前に貼り替えると、その状態が
    // 次のフレームまで残り、不透明のつもりでガラスの索引を読む。
    // （実際にそうなって、街全体が半透明になった）
    sharedIndex(Math.max(m.opaqueQuads, m.glassQuads));

    const bufs = [];
    const mkBuf = (data) => {
        const b = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        bufs.push(b);
        return b;
    };
    // 座標は 1 バイトで済むタイルと 2 バイト要るタイルがあるので、
    // 書き出し側が選んだ型をそのまま使う。
    const posType = m.posType === 5121 ? gl.UNSIGNED_BYTE : gl.SHORT;
    const attrs = [
        [mkBuf(m.pos), A.pos, 3, posType, false, m.pos.BYTES_PER_ELEMENT * 3],
        [mkBuf(m.nor), A.nor, 3, gl.BYTE, true, 3],
        [mkBuf(m.col), A.col, 4, gl.UNSIGNED_BYTE, true, 4],
        [mkBuf(m.uv), A.uv, 2, gl.SHORT, false, 4],
        [mkBuf(m.lay), A.layer, 1, gl.UNSIGNED_SHORT, false, 2],
    ];
    // firstVert から始まる頂点を、共用索引で描くための VAO
    const mkVao = (quads, firstVert) => {
        if (!quads) return null;
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        for (const [b, loc, size, type, normed, stride] of attrs) {
            if (loc < 0) continue;
            gl.bindBuffer(gl.ARRAY_BUFFER, b);
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, size, type, normed, 0, firstVert * stride);
        }
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, shareIB);
        gl.bindVertexArray(null);
        return vao;
    };
    const g = {
        vao: mkVao(m.opaqueQuads, 0), count: m.opaqueQuads * 6,
        vaoT: mkVao(m.glassQuads, m.opaqueQuads * 4), countT: m.glassQuads * 6,
        type: gl.UNSIGNED_INT,
        min: m.min, max: m.max, off: m.off, scale: m.scale, bounds: m.bounds,
        tris: (m.opaqueQuads + m.glassQuads) * 2,
        bufs, bytes: m.pos.byteLength + m.nor.byteLength + m.col.byteLength
            + m.uv.byteLength + m.lay.byteLength,
    };
    vram += g.bytes;
    return g;
}

// 街が広くなると、通り過ぎたタイルの細かい版が GPU に溜まり続ける。
// 全部残すと 300MB を超えるので、遠ざかったものは捨てて読み直させる。
let vram = 0;
const VRAM_MAX = 220 * 1048576;

function dispose(g) {
    for (const b of g.bufs) gl.deleteBuffer(b);
    if (g.vao) gl.deleteVertexArray(g.vao);
    if (g.vaoT) gl.deleteVertexArray(g.vaoT);
    vram -= g.bytes;
}

// ---- 街 ----
let tiles = [], center = [0, 64, 0], radius = 200;
let yaw = 0.9, pitch = 0.6, dist = 600;
let texReady = false;
let bbox = null;                // 街の外接矩形 [x0,z0,x1,z1]。ここから出さない。
let pendingView = null;         // 開くときに地図から受け取った位置と縮尺

// 縦の画角。地図の縮尺をカメラ距離に直すときに使うので定数で持つ。
const FOV = 50 * Math.PI / 180;
const viewH = () => (cv && cv.clientHeight) || 700;

// 見た目の段階。カメラからタイルまでの距離で選ぶ。
//   near … 形つき（階段以外の細い物も作る）
//   far  … 立方体だけ
//   vfar … 2×2×2 を 1 つに潰した粗版
//   xfar … 4×4×4 まで潰した全景用。起動時に必ず読むのはこれだけ。
const LODS = ['near', 'far', 'vfar', 'xfar'];
const BASE_LOD = 'xfar';                     // これだけは捨てずに持ち続ける
let LOD_NEAR = 190, LOD_FAR = 460, LOD_VFAR = 950;

// 視錐台の 6 平面。ビュープロジェクション行列から取り出す。
// 列優先で入っているので、4 行目 ± 各行 という形で作る。
function frustum(m) {
    const p = [];
    for (let i = 0; i < 3; i++) {
        for (const sg of [1, -1]) {
            const a = m[3] + sg * m[i], b = m[7] + sg * m[i + 4],
                  c = m[11] + sg * m[i + 8], d = m[15] + sg * m[i + 12];
            const l = Math.hypot(a, b, c) || 1;
            p.push([a / l, b / l, c / l, d / l]);
        }
    }
    return p;
}

// 外接箱が視錐台の外に完全に出ているか
function outside(pl, b) {
    for (const [a, bb, c, d] of pl) {
        // 平面の向きに一番遠い角だけ見れば足りる
        const x = a > 0 ? b[3] : b[0], y = bb > 0 ? b[4] : b[1], z = c > 0 ? b[5] : b[2];
        if (a * x + bb * y + c * z + d < 0) return true;
    }
    return false;
}

async function boot(afterManifest) {
    const man = await (await fetch(BASE + 'tiles.json')).json();
    USE_GZ = !!man.gz && typeof DecompressionStream === 'function';
    center = [man.center[0], 80, man.center[1]];
    radius = man.span / 2;
    dist = radius * 1.5;   // 街が横長になったので、初期位置は寄せ気味に
    // タイルの並びから街の外接矩形を作る。カメラをここから出さない。
    bbox = man.tiles.reduce((b, t) => [
        Math.min(b[0], t.x), Math.min(b[1], t.z),
        Math.max(b[2], t.x + t.size), Math.max(b[3], t.z + t.size),
    ], [1e9, 1e9, -1e9, -1e9]);

    tiles = man.tiles.map(t => ({
        ...t, cx: t.x + t.size / 2, cz: t.z + t.size / 2,
        // 高さは書き出し時の値。無ければ広めに取っておく。
        box: [t.x, (t.y0 != null ? t.y0 : -64), t.z, t.x + t.size, (t.y1 != null ? t.y1 : 200), t.z + t.size],
        gpu: {}, loading: {},
    }));

    // 街の広さが分かったので、ここでカメラを決める。
    // タイルを読む前に決めておかないと、途中のフレームが違う向きで描かれる。
    if (afterManifest) afterManifest();

    // テクスチャを先に。無いと真っ黒になる。
    // 画像はキャッシュが効く設定で配信されるので、中身が変わったことが
    // 分かる印を付ける。付けないと古い枚数の絵を掴んだまま層がずれる（実際にずれた）。
    const meta = await (await fetch(BASE + 'blocks.json?t=' + Date.now())).json();
    await loadTexArray(BASE + `blocks.png?v=${meta.layers}x${meta.width}`, meta.layers, meta.cols);
    gl.uniform1i(uTex, 0);
    texReady = true;

    // まず一番粗い版を全部。街の形がすぐ出て、以降は必ず何か表示できる。
    // ここが「開いただけで必ず掛かる通信量」なので、一番荒い段階にしてある。
    // 50 枚を 1 枚ずつ待つと待ち時間が積み上がるので、少しずつ束ねて取る。
    const q = tiles.slice();
    await Promise.all(Array.from({ length: 6 }, async () => {
        while (q.length) {
            const t = q.shift();
            const lv = t[BASE_LOD] ? BASE_LOD : (t.vfar ? 'vfar' : 'far');
            t.baseLod = lv;
            t.gpu[lv] = upload(await loadGlb(BASE + t[lv].file));
            frame();
        }
    }));
    need();
}

// カメラからタイルまでの距離。
//
// 高さを入れずに水平距離だけで測ると、真上から見下ろしたときに
// 「2000 ブロック上空なのに距離ゼロ」になり、豆粒に見えているタイルへ
// 細かい版を読みに行く。地図から開いた直後がまさにその向きなので、
// 開くだけで 10MB 落としていた。
function tileDist(t, eye) {
    const ty = (t.box[1] + t.box[4]) / 2;
    return Math.hypot(eye[0] - t.cx, eye[1] - ty, eye[2] - t.cz);
}

// そのタイルに要る段階
function wantLod(t, eye) {
    const d = tileDist(t, eye);
    if (d < LOD_NEAR) return 'near';
    if (d < LOD_FAR) return 'far';
    if (d < LOD_VFAR) return 'vfar';
    return 'xfar';
}

// 持っているうちで、要る段階に一番近いもの
function bestGpu(t, want) {
    if (t.gpu[want]) return [t.gpu[want], want];
    // 粗い方から順に探す。何も無いより粗くても出す方がいい。
    for (let i = LODS.indexOf(want) + 1; i < LODS.length; i++)
        if (t.gpu[LODS[i]]) return [t.gpu[LODS[i]], LODS[i]];
    for (let i = LODS.indexOf(want) - 1; i >= 0; i--)
        if (t.gpu[LODS[i]]) return [t.gpu[LODS[i]], LODS[i]];
    return [null, want];
}

// 使い道のなくなった細かい版を捨てる。
// 一番粗い版だけは必ず残す。捨てると街に穴が開く。
function evict(eye) {
    if (vram < VRAM_MAX) return;
    const KEEP = { near: LOD_NEAR, far: LOD_FAR, vfar: LOD_VFAR };
    const cand = [];
    for (const t of tiles)
        for (const lv of ['near', 'far', 'vfar']) {
            if (!t.gpu[lv] || lv === t.baseLod) continue;
            const d = tileDist(t, eye);
            // 境目でちょうど出入りすると読み直しが続くので、少し外へ出てから捨てる
            if (d > KEEP[lv] * 1.5) cand.push({ t, lv, d });
        }
    cand.sort((a, b) => b.d - a.d);
    for (const c of cand) {
        if (vram < VRAM_MAX * 0.8) break;
        dispose(c.t.gpu[c.lv]);
        delete c.t.gpu[c.lv];
    }
}

// 画面に入っているタイルの、要る段階から順に読む
function need() {
    const eye = camEye();
    evict(eye);
    const pl = frustum(viewProj());
    const want = tiles
        .filter(t => !outside(pl, t.box))
        .map(t => ({ t, lv: wantLod(t, eye), d: tileDist(t, eye) }))
        .filter(x => x.t[x.lv] && !x.t.gpu[x.lv] && !x.t.loading[x.lv])
        .sort((a, b) => a.d - b.d);
    if (!want.length) return;
    const { t, lv } = want[0];
    t.loading[lv] = true;
    loadGlb(BASE + t[lv].file).then(m => { t.gpu[lv] = upload(m); frame(); need(); });
}

function camEye() {
    return [
        center[0] + dist * Math.cos(pitch) * Math.sin(yaw),
        center[1] + dist * Math.sin(pitch),
        center[2] + dist * Math.cos(pitch) * Math.cos(yaw),
    ];
}

function viewProj() {
    const w = cv.clientWidth || 1, h = cv.clientHeight || 1;
    return mul(persp(FOV, w/h, 1, radius * 14), look(camEye(), center, [0,1,0]));
}

function draw() {
    const w = cv.clientWidth, h = cv.clientHeight, dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cv.width !== w*dpr || cv.height !== h*dpr) { cv.width = w*dpr; cv.height = h*dpr; }
    gl.viewport(0, 0, cv.width, cv.height);
    gl.clearColor(0.53, 0.72, 0.92, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE);

    const eye = camEye();
    const vp = viewProj();
    gl.uniformMatrix4fv(uVP, false, new Float32Array(vp));
    const pl = frustum(vp);

    let tris = 0, culled = 0;
    const cnt = { near: 0, far: 0, vfar: 0, xfar: 0 };
    const shown = [];
    for (const t of tiles) {
        // 画面に入っていないタイルは、読み込みも描画もしない
        if (outside(pl, t.box)) { culled++; continue; }
        // 欲しい段階が未着なら、持っているうちで一番近いもので代用する
        const [g, lv] = bestGpu(t, wantLod(t, eye));
        if (!g) continue;
        cnt[lv]++;
        g.d2 = (eye[0] - t.cx) * (eye[0] - t.cx) + (eye[2] - t.cz) * (eye[2] - t.cz);
        shown.push(g); tris += g.tris;
    }

    // ガラスは奥行きを書かずに重ねるので、奥のタイルから順に描かないと
    // 混ざり方が変わる。生成順のままだと、見る方角によって
    // 手前から奥の順になり、ガラスが薄く見えたり濃く見えたりする。
    const backToFront = shown.slice().sort((a, b) => b.d2 - a.d2);

    const drawSet = (pass) => {
        for (const g of (pass ? backToFront : shown)) {
            const vao = pass ? g.vaoT : g.vao;
            if (!vao) continue;
            gl.uniform3f(uOff, g.off[0], g.off[1], g.off[2]);
            gl.uniform1f(uScale, g.scale);
            gl.bindVertexArray(vao);
            gl.drawElements(gl.TRIANGLES, pass ? g.countT : g.count, g.type, 0);
        }
    };
    // 1 回目: 不透明
    gl.uniform1f(uBlend, 0);
    gl.disable(gl.BLEND); gl.depthMask(true); gl.enable(gl.CULL_FACE);
    drawSet(false);
    // 2 回目: ガラス。奥行きは見るが書かない。裏面も出す。
    gl.uniform1f(uBlend, 1);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false); gl.disable(gl.CULL_FACE);
    drawSet(true);
    gl.depthMask(true); gl.disable(gl.BLEND); gl.enable(gl.CULL_FACE);
    gl.bindVertexArray(null);

    last = { tris, cnt, culled };
    layoutPins(vp, cv.clientWidth, cv.clientHeight, eye);
}

// ---- 操作 ----
// canvas は開くときに作るので、結び付けもそのときに行う。
let drag = null, down = null, two = null;
function bindControls() {
    cv.addEventListener('pointerdown', e => {
        pts.set(e.pointerId, [e.clientX, e.clientY]);
        if (pts.size === 1) { drag = [e.clientX, e.clientY]; down = [e.clientX, e.clientY]; }
        cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', e => {
        if (!pts.has(e.pointerId)) return;
        pts.set(e.pointerId, [e.clientX, e.clientY]);
        // 二本指。指の間の距離・角度・中点の 3 つを同時に見る。
        //
        //   広げる/つまむ … 拡大縮小
        //   ひねる         … 向きを変える（yaw）
        //   そろえて上下   … 見下ろす角度を変える（pitch）
        //
        // Shift や右ボタンは指では出せないので、これが無いと
        // スマホでは回転も角度変更もできない（実際できなかった）。
        if (pts.size >= 2) {
            const v = [...pts.values()];
            const d = Math.hypot(v[0][0] - v[1][0], v[0][1] - v[1][1]);
            const a = Math.atan2(v[1][1] - v[0][1], v[1][0] - v[0][0]);
            const my = (v[0][1] + v[1][1]) / 2;
            if (two) {
                if (d > 4 && Math.abs(d - two.d) > 0.5) zoomBy(two.d / d);
                // 角度は ±π で折り返すので、近いほうの差を取る
                let da = a - two.a;
                while (da >  Math.PI) da -= Math.PI * 2;
                while (da < -Math.PI) da += Math.PI * 2;
                // 足すのが正しい。引くと、指を左へひねったのに景色が右へ回る。
                //
                // 画面の y は下向きなので、da が正 = 指は時計回り。
                // 一方 yaw を減らすと、真北の点は画面の左へ動く（＝景色は反時計回り）。
                // つまり「引く」と指と景色が逆向きになる。
                yaw += da;
                // 0.006 だと 170px 動かしただけで真上から水平まで振り切れた。
                // 画面の高さの半分ほど動かして端から端、くらいが手になじむ。
                pitch = Math.max(0.10, Math.min(1.55, pitch + (my - two.my) * 0.0035));
                frame();
            }
            two = { d, a, my };
            drag = null; down = null;
            return;
        }
        if (!drag) return;
        const dx = e.clientX - drag[0], dy = e.clientY - drag[1];
        drag = [e.clientX, e.clientY];
        // 地図と同じで、ふつうに引いたら景色が動く（＝平行移動）。
        // 回すのは右ボタンか Shift、指なら二本目を足したとき。
        if (e.shiftKey || e.buttons === 2 || rotMode) {
            // 二本指のひねりと同じ向きにそろえる。
            // 引いた方向へ景色が回る（右へ引けば景色も右へ）。
            yaw += dx * 0.005;
            pitch = Math.max(0.10, Math.min(1.55, pitch + dy * 0.005));
        } else {
            pan(dx, dy);
        }
        frame();
    });
    const up = e => {
        pts.delete(e.pointerId);
        // 指を 1 本離したら二本指の基準は捨てる。残さないと、
        // 次に触れた瞬間に前回との差ぶんだけ画面が飛ぶ。
        if (pts.size < 2) two = null;
        if (pts.size === 1) {
            const v = [...pts.values()][0];
            drag = [v[0], v[1]];      // 残った指でそのまま移動を続けられる
        }
        if (!pts.size) drag = null;
        // ほとんど動いていなければ「押した」とみなしてピンを拾う。
        // 少しでも滑らせたらドラッグなので、地図をずらしただけで
        // カードが開くことはない。
        if (down && Math.abs(e.clientX - down[0]) < 6 && Math.abs(e.clientY - down[1]) < 6) {
            const r = cv.getBoundingClientRect();
            const hit = pinAt(e.clientX - r.left, e.clientY - r.top);
            if (hit && onPick) onPick(hit.p.name);
        }
        down = null;
        need();
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', e => {
        e.preventDefault();
        zoomBy(1 + Math.sign(e.deltaY) * 0.12);
    }, { passive: false });
    // 右ドラッグで回すので、右クリックのメニューは出さない
    cv.addEventListener('contextmenu', e => e.preventDefault());
}
const pts = new Map();
let rotMode = false;
function zoomBy(k) {
    dist = Math.max(24, Math.min(radius * 1.7, dist * k));
    frame(); need();
}

// 画面上の移動量を地面の上の移動量に直す。
// 中心の高さでの「1 ピクセルあたり何ブロックか」は、真上から見たときの
// 縮尺と同じ 2*dist*tan(画角/2)/画面の高さ。斜めのときは奥ほど詰まるが、
// 中心付近で合っていれば掴んだ場所がついてくる感じになる。
function pan(dx, dy) {
    const bpp = 2 * dist * Math.tan(FOV / 2) / viewH();
    const s = Math.sin(yaw), c = Math.cos(yaw);
    // 画面の横は地面の (c, -s)、縦は視線を地面に落とした向き。
    // 見下ろすほど縦の動きが効かなくなるので sin(pitch) で割って戻す。
    const k = Math.max(0.35, Math.sin(pitch));
    const wx = -dx * bpp, wz = -dy * bpp / k;
    // カメラの向きぶん回して世界の軸に戻す。
    //   右方向   = ( cos yaw, -sin yaw)
    //   奥方向   = (-sin yaw, -cos yaw)
    // 縦の項の符号を落とすと、上へ引いたのに下へ動く。
    const p = clampToTown(center[0] + wx * c + wz * s, center[2] - wx * s + wz * c);
    center = [p[0], center[1], p[1]];
}
window.addEventListener('resize', () => { if (opened) frame(); });

let pending = false, last = { tris: 0, cnt: { near:0, far:0, vfar:0, xfar:0 }, culled: 0 }, fps = 0, fc = 0, ft = performance.now();
function frame() { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; draw(); tick(); }); }
function tick() {
    if (++fc >= 20) { fps = fc * 1000 / (performance.now() - ft); fc = 0; ft = performance.now(); }
    hud.textContent =
        `タイル ${tiles.length}（細 ${last.cnt.near} / 中 ${last.cnt.far} / 粗 ${last.cnt.vfar} / 極粗 ${last.cnt.xfar} / 画面外 ${last.culled}）\n` +
        `三角 ${last.tris.toLocaleString()} / GPU ${(vram/1048576).toFixed(0)} MB\n` +
        `通信 ${(net/1048576).toFixed(1)} MB\n` +
        `${fps ? fps.toFixed(0) + ' fps' : '…'}`;
    window.__stats = { tris: last.tris, ...last.cnt, culled: last.culled, fps,
                       vram: Math.round(vram/1048576), net: +(net/1048576).toFixed(2) };
}


// ---- 地点のピン ------------------------------------------------------------
//
// 3D の中に立てるのではなく、毎フレーム世界座標を画面座標へ落として
// HTML を置いている。文字の見やすさとタップの当たり判定が、板を立てるより
// ずっと素直に済むため。
//
// 建物に隠れる処理はしていない。深度を読み戻す必要があって割に合わないのと、
// 隠れないほうが「どこに何があるか」は分かりやすいため（地図の注記と同じ）。
let pins = [], pinLayer = null, onPick = null, pinsOn = true;
const PIN_Y = 68;                    // y の指定が無い地点を置く高さ

function setPins(list, cb) {
    onPick = cb || null;
    if (!host) return;
    if (!pinLayer) {
        pinLayer = document.createElement('div');
        pinLayer.className = 'city3d-pins';
        host.appendChild(pinLayer);
    }
    pinLayer.innerHTML = '';
    pins = (list || []).map(p => {
        const e = document.createElement('button');
        e.className = 'city3d-pin';
        e.style.setProperty('--c', p.color || '#ea4335');
        e.innerHTML = '<i></i><span>' + esc(p.name) + '</span>';
        // 位置が決まるまでは出さない。既定のままだと、まだ一度も
        // 置いていないピンが画面の左上隅にまとめて出る。
        e.style.display = 'none';
        pinLayer.appendChild(e);
        // y が空の地点は地面あたりに置く。高いと建物から浮いて見える。
        // 真値が要るのは屋上の地点だけで、そういうものは CSV の y に入れる。
        return { p, e, w: [p.x, p.y != null ? p.y : PIN_Y, p.z], on: false };
    });
}
function esc(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}

// 名前を出す上限。これを超えたぶんは点だけにする。
// 全部に名前を出すと、街の中心では文字が重なって何も読めなくなる。
const PIN_LABELS = 22;

// 世界座標 → 画面座標。vp は列優先の 4×4。
function layoutPins(vp, w, h, eye) {
    if (!pins.length) return;
    const live = [];
    for (const it of pins) {
        // ピンを消していても、選んでいる地点だけは出す。
        // カードを開いているのに、どこの話か分からなくなるため。
        const sel = it.p.name === selName;
        if (!pinsOn && !sel) { hide(it); continue; }
        const x = it.w[0], y = it.w[1], z = it.w[2];
        const cw = vp[3]*x + vp[7]*y + vp[11]*z + vp[15];
        // カメラの後ろに回ったものは出さない（出すと画面の反対側に化ける）
        if (cw <= 0.001) { hide(it); continue; }
        const cx = (vp[0]*x + vp[4]*y + vp[8]*z + vp[12]) / cw;
        const cy = (vp[1]*x + vp[5]*y + vp[9]*z + vp[13]) / cw;
        if (cx < -1.2 || cx > 1.2 || cy < -1.2 || cy > 1.2) { hide(it); continue; }

        const d = Math.hypot(eye[0]-x, eye[1]-y, eye[2]-z);
        if (d > 1100) { hide(it); continue; }
        if (!it.on) { it.e.style.display = ''; it.on = true; }
        it.e.style.transform =
            'translate(' + ((cx * 0.5 + 0.5) * w).toFixed(1) + 'px,' +
                           ((1 - (cy * 0.5 + 0.5)) * h).toFixed(1) + 'px)';
        it.e.style.zIndex = String(Math.max(1, 4000 - Math.round(d)));
        it.d = d;
        it.sx = (cx * 0.5 + 0.5) * w;
        it.sy = (1 - (cy * 0.5 + 0.5)) * h;
        live.push(it);
    }

    // 名前を出す相手を選ぶ。
    //
    // 近い順に上限まで、では画面の手前側に固まる（斜めに見ているので
    // 手前は画面の下）。実際そうなって、下辺だけ名札の列になった。
    // 近い順に見ていって、画面上で先客と重なるものは飛ばす。
    // 幅は文字数からの概算。実測すると毎フレーム再レイアウトが走る。
    live.sort((a, b) => (b.p.name === selName) - (a.p.name === selName) || a.d - b.d);
    const put = [];
    let n = 0;
    for (const it of live) {
        // 選んでいる地点は必ず名前ごと出す。押した本人が探すことになる。
        if (it.p.name === selName) {
            it.e.classList.remove('is-dot');
            it.e.style.zIndex = '5000';   // 選んだものは必ず手前
            put.push({ x: it.sx, y: it.sy, w: 34 + it.p.name.length * 12 });
            continue;
        }
        let ok = n < PIN_LABELS;
        if (ok) {
            const wpx = 34 + it.p.name.length * 12, hpx = 22;
            for (const r of put) {
                if (Math.abs(it.sx - r.x) < (wpx + r.w) / 2 &&
                    Math.abs(it.sy - r.y) < hpx) { ok = false; break; }
            }
            if (ok) { put.push({ x: it.sx, y: it.sy, w: wpx }); n++; }
        }
        it.e.classList.toggle('is-dot', !ok);
    }
}
function hide(it) { if (it.on) { it.e.style.display = 'none'; it.on = false; } }

// 選んでいる地点は赤いピンにする。2D で選んだときと同じ見た目。
let selName = null;
function setSelected(name) {
    selName = name || null;
    for (const it of pins) it.e.classList.toggle('is-sel', it.p.name === selName);
    frame();
}

// ピンの表示切り替え。選んだ状態は次に開いたときも覚えておく。
function showPins(on) {
    pinsOn = !!on;
    if (pinBtn) pinBtn.classList.toggle('is-on', pinsOn);
    try { localStorage.setItem('city3dPins', pinsOn ? '1' : '0'); } catch (e) {}
    frame();
}

// 画面の位置からピンを探す。名前つきは名札の帯ごと、点だけのものは丸の近くで拾う。
function pinAt(sx, sy) {
    if (!pinsOn) return null;
    let best = null, bd = 1e9;
    for (const it of pins) {
        if (!it.on) continue;
        const dot = it.e.classList.contains('is-dot');
        const w = dot ? 20 : 34 + it.p.name.length * 12;
        const dx = sx - (it.sx + (dot ? 0 : w / 2 - 12)), dy = sy - it.sy;
        if (Math.abs(dx) > w / 2 + 4 || Math.abs(dy) > 13) continue;
        const d = Math.abs(dx) + Math.abs(dy) * 2;
        if (d < bd) { bd = d; best = it; }
    }
    return best;
}

// ---- 開くときの動き --------------------------------------------------------

// 地図から受け取った位置と縮尺をカメラに移し、真上から見た状態にする。
// この瞬間の見え方は 2D の地図とほぼ同じになる。
// カメラを地図の見え方に合わせる。
//
// これは「読み込みを始める前」に済ませておく必要がある。あとから直すと、
// 読み込み中のフレームが前回の角度（初回なら既定の斜め）で描かれ、
// 出来かけの街が一瞬斜めに見えてしまう。実際そう見えていた。
function applyCamera() {
    if (!pendingView) return;
    const p = pendingView; pendingView = null;
    const q = clampToTown(p.x, p.z);
    center = [q[0], p.y, q[1]];
    // 地図を引きすぎた状態から開くと、青い海に街だけが浮いた絵になる。
    // 立体があるのは街の中だけなので、引きの上限は街が収まるところで止める。
    dist = Math.min(distForView(p.bpp, viewH()), radius * 1.7);
    yaw = 0;
    pitch = 1.5707;              // ほぼ真上。この向きなら 2D の地図とほぼ同じ絵。
}

// 街がひととおり出そろってから見せる。
// それまでは下の 2D 地図をそのまま見せておく。
function reveal() {
    if (!opened) return;
    if (loading) loading.classList.remove('is-on');
    frame(); need();
    host.classList.add('is-open');
    if (help) {
        help.classList.remove('is-gone');
        setTimeout(function () { help.classList.add('is-gone'); }, 5200);
    }
    // 少し置いてから起こす。出た瞬間に動き出すと、切り替わったことが
    // 分からないまま景色だけ変わる。
    setTimeout(() => { if (opened) animatePitch(tiltFor(dist), 900); }, 380);
}

// 起こしたあとの見下ろす角度。
//
// 遠くから見るときは寝かせたほうが立体に見えるが、寄っているときに
// 同じだけ寝かせると、目の前の高層ビルの裏に回り込んで画面が壁で
// 埋まる。中心の建物の高さぶんだけカメラが下がるため。
// 近いほど真上寄りに残す。
function tiltFor(d) {
    const k = Math.min(1, Math.max(0, (d - 110) / 300));
    let t = 1.12 + (0.70 - 1.12) * k;
    // 縦長の画面では、同じ角度だと上半分が空だけになる。
    // 横長の画面を基準に決めた角度なので、縦に長いぶんだけ見下ろしを強くする。
    const a = cv ? cv.clientHeight / Math.max(1, cv.clientWidth) : 1;
    if (a > 1.2) t = Math.min(1.42, t + Math.min(0.34, (a - 1.2) * 0.34));
    return t;
}

// 見下ろす角度をなめらかに変える
let anim = 0;
function animatePitch(to, ms) {
    const from = pitch, t0 = performance.now();
    const id = ++anim;
    const step = () => {
        if (id !== anim || !opened) return;
        const k = Math.min(1, (performance.now() - t0) / ms);
        // 終わりをゆっくり止める
        pitch = from + (to - from) * (1 - Math.pow(1 - k, 3));
        frame();
        if (k < 1) requestAnimationFrame(step); else need();
    };
    requestAnimationFrame(step);
}

// 地図の見え方を 3D のカメラに移す。
// 透視投影で真上から見たとき、地面に写る縦幅は 2*dist*tan(画角/2)。
// これが「地図の縦ピクセル × 1ピクセルあたりのブロック数」と等しくなる
// 距離を選ぶと、切り替えた瞬間の見え方が 2D と一致する。
function distForView(blocksPerPx, heightPx) {
    return Math.max(30, heightPx * blocksPerPx / (2 * Math.tan(FOV / 2)));
}

function clampToTown(x, z) {
    if (!bbox) return [x, z];
    return [Math.min(Math.max(x, bbox[0]), bbox[2]),
            Math.min(Math.max(z, bbox[1]), bbox[3])];
}

// 閉じるときは、今 3D で見ていた地面の位置と縮尺を地図に返す。
// これをしないと、戻った瞬間に元いた場所へ飛ばされて迷子になる。
function closeView() {
    if (!opened) return null;
    opened = false;
    if (host) host.classList.remove('is-open');
    // 読み込み中に閉じられることもある
    if (loading) loading.classList.remove('is-on');
    var r = {
        x: center[0], z: center[2],
        blocksPerPx: 2 * dist * Math.tan(FOV / 2) / viewH(),
    };
    if (onClose) onClose(r);
    return r;
}

// ---- 外から使う口 ----------------------------------------------------------

return {
    // parent: 重ねる先の要素、opts: { x, z, blocksPerPx, y }
    open: function (parent, opts, done) {
        if (!host && !build(parent)) { alert('この端末では 3D を出せません（WebGL2 非対応）'); return false; }
        opened = true;
        var o = opts || {};
        var p = clampToTown(o.x != null ? o.x : center[0], o.z != null ? o.z : center[2]);
        pendingView = {
            x: p[0], z: p[1], y: o.y != null ? o.y : 72,
            bpp: o.blocksPerPx || 1,
        };
        onClose = done || null;
        // 先にカメラを決めてから読み込む。順番が逆だと出来かけが斜めに映る。
        if (booted) applyCamera();
        if (loading) loading.classList.add('is-on');
        if (!booted) {
            booted = true;
            // 一覧を読んだ直後（＝街の広さが分かった時点）でカメラを決め、
            // そのあとタイルを読む。boot が終わるまで画面には出さない。
            boot(applyCamera).then(reveal)
                  .catch(function (e) {
                      if (loading) loading.classList.remove('is-on');
                      host.classList.add('is-open');
                      host.classList.add('is-debug');
                      hud.textContent = 'エラー: ' + e.message;
                  });
        } else {
            reveal();
        }
        return true;
    },
    close: closeView,
    isOpen: function () { return opened; },
    where: function () { return { x: Math.round(center[0]), z: Math.round(center[2]), dist: Math.round(dist) }; },
    setBase: function (b) { BASE = b; },
    // 地点の一覧を渡す。[{ name, x, z, y, color }]
    setPins: function (list, cb) {
        setPins(list, cb);
        try { showPins(localStorage.getItem('city3dPins') !== '0'); } catch (e) { frame(); }
    },
    pinsVisible: function () { return pinsOn; },
    // 動作確認用にカメラの値を見せる
    cam: function () { return { yaw: +yaw.toFixed(3), pitch: +pitch.toFixed(3), dist: Math.round(dist) }; },
    // 選んでいる地点。null で解除。
    setSelected: function (name) { setSelected(name); },
    // 特定の地点へ寄せる
    goTo: function (x, z, d) {
        var q = clampToTown(x, z);
        center = [q[0], center[1], q[1]];
        if (d) dist = Math.max(24, Math.min(radius * 1.7, d));
        frame(); need();
    },
    // 真上→斜めの起き上がり。開いた直後に一度だけ回す。
    tilt: function (to, ms) { animatePitch(to != null ? to : tiltFor(dist), ms || 900); },
    // 数字を出す（開発用）
    debug: function (on) { if (host) host.classList.toggle('is-debug', !!on); },
};
})();
