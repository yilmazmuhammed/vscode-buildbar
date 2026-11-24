'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------- durum

/** @type {vscode.WorkspaceFolder | undefined} Aktif proje. */
let active;

/** @type {vscode.StatusBarItem} Derle butonu. */
let bar;

/** @type {vscode.StatusBarItem} Secili gorevi gosteren buton. */
let taskBar;

/** @type {vscode.StatusBarItem} Yalnizca derleme surerken gorunen durdur butonu. */
let stopBar;

/** @type {vscode.TreeView<Node>} */
let view;

/** Proje basina son secilen gorev adi. folderUri -> string */
const chosenTask = new Map();

/** Secimi pencere yeniden yuklenince de hatirlamak icin. */
const CHOSEN_KEY = 'buildbar.chosenTasks';
/** @type {vscode.Memento | undefined} */
let store;

/** Agac dugumlerinin kimligi sabit kalsin diye onbellek. */
const projectNodes = new Map();
const optionNodes = new Map();

/** tasks.json okumalarinin onbellegi. folderUri -> BuildOption[] */
const optionsCache = new Map();

/**
 * Proje listesi: workspace klasorleri ve kendisi proje olmayan klasorlerin
 * altindaki ic ice projeler. refresh ve klasor degisikligi temizler.
 * @type {Project[] | undefined}
 */
let projectCache;

/** Ic ice projelerin kendi .vscode/settings.json icerigi. uri -> object | null */
const ownSettingsCache = new Map();

/**
 * VS Code'un cozdugu gercek gorevler. folderUri -> Map<gorev adi, vscode.Task>
 * Derleme bunlarin uzerinden kosar; boylece dependsOn, satir ici
 * problemMatcher ve ${...} degiskenleri kaybolmaz.
 */
const realTasks = new Map();

/**
 * Su an kosan derlemeler.
 * folderUri -> Map<vscode.TaskExecution, {name, started, folder}>
 * Yalnizca projenin kendi secenekleri (ve temizlik gorevi) izlenir; boylece
 * Ctrl+Shift+B ile baslatilan ayni gorev de gorunur, ama izleme (watch) gibi
 * ilgisiz gorevler durdur dugmesini acik birakmaz.
 */
const running = new Map();

/** Proje basina son derleme sonucu. folderUri -> BuildResult */
const lastResult = new Map();

/** onDidEndTaskProcess'ten gelen cikis kodlari. */
const exitCodes = new WeakMap();

/** Kullanicinin durdurdugu kosular; sonuc "durduruldu" yazilsin diye. */
const stoppedRuns = new WeakSet();

/** Bitisini bekleyenler. TaskExecution -> resolve fonksiyonlari */
const waiters = new Map();

/** Bekleyen kaydolmadan biten kosular (cok hizli gorevler). */
const endedEarly = new WeakMap();

/**
 * Ardisik is kuyrugu (coklu proje, temizle ve derle). Ayni anda tek kuyruk.
 * @type {{cancelled: boolean} | undefined}
 */
let queue;

const treeChanged = new vscode.EventEmitter();

/**
 * Proje: ya bir workspace klasoru (VS Code'un WorkspaceFolder nesnesi) ya da
 * onun altinda kendi tasks.json / launch.json / CMakePresets.json dosyasi olan
 * bir klasor. Ic ice projeler ayni alanlari tasir; root, VS Code'un tanidigi
 * workspace klasorudur (gorev kapsami ve hata ayiklama icin gerekiyor).
 * @typedef {{ uri: vscode.Uri, name: string, index: number,
 *             root?: vscode.WorkspaceFolder }} Project
 * @typedef {{ kind: 'project', folder: Project }
 *         | {kind: 'option', folder: Project, opt: BuildOption}} Node
 * @typedef {{ kind: 'task' | 'launch', name: string, detail?: string,
 *             isDefault?: boolean, entry?: object, cmake?: boolean,
 *             configure?: boolean, clean?: boolean, preset?: string }} BuildOption
 * @typedef {{ name?: string, exitCode?: number, ms?: number,
 *             stopped?: boolean, error?: string, delegated?: boolean,
 *             execution?: object }} BuildResult
 */

const settings = (folder) =>
  vscode.workspace.getConfiguration('buildbar', folder && folder.uri);

/**
 * Ayar varsayilanlari burada da duruyor. package.json'daki
 * contributes.configuration normalde bunlari sagliyor; ama eklentinin eski
 * bir surumu kurulu kaldiysa ya da manifest katkisi yuklenmediyse
 * `get()` undefined donuyor ve path.join gibi cagrilar patliyor. Ayarlari
 * hep bu kapiden okuyoruz, boylece undefined hicbir zaman disariya cikmiyor.
 */
const DEFAULTS = {
  followActiveEditor: true,
  source: 'tasks',
  tasksFile: '.vscode/tasks.json',
  launchFile: '.vscode/launch.json',
  onlyBuildGroup: false,
  cmakeFallback: true,
  problemMatchers: ['$gcc'],
  cleanTask: '',
  nestedProjectDepth: 2
};

/** Ic ice proje mi? (workspace klasorunun altinda, kendisi workspace klasoru degil) */
const isNested = (folder) => !!folder && !!folder.root;

/** VS Code'un tanidigi workspace klasoru: gorev kapsami ve hata ayiklama icin. */
const rootOf = (folder) => (isNested(folder) ? folder.root : folder);

/** Ayar degeri varsayilanla ayni turde mi? Elle yazilmis dosyalara karsi. */
const sameType = (value, key) =>
  Array.isArray(DEFAULTS[key]) ? Array.isArray(value) : typeof value === typeof DEFAULTS[key];

/**
 * Ic ice projenin kendi .vscode/settings.json dosyasindaki deger. VS Code bu
 * dosyayi okumaz (yalnizca workspace klasorlerininkini okur); repo tek basina
 * acildiginda gecerli olan buildbar.* ayari ic ice acildiginda da gecerli
 * kalsin diye BuildBar kendisi okur.
 */
function ownSetting(folder, key) {
  if (!isNested(folder)) return undefined;
  const id = folder.uri.toString();
  if (!ownSettingsCache.has(id)) {
    const file = readJsonc(path.join(folder.uri.fsPath, '.vscode', 'settings.json'));
    ownSettingsCache.set(id, file && typeof file === 'object' ? file : null);
  }
  const own = ownSettingsCache.get(id);
  if (!own) return undefined;
  const flat = own[`buildbar.${key}`];
  if (flat !== undefined && flat !== null && sameType(flat, key)) return flat;
  const group = own.buildbar;
  const inner = group && typeof group === 'object' ? group[key] : undefined;
  return inner !== undefined && inner !== null && sameType(inner, key) ? inner : undefined;
}

/**
 * @param {Project | undefined} folder
 * @param {keyof DEFAULTS} key
 */
function pref(folder, key) {
  const own = ownSetting(folder, key);
  if (own !== undefined) return own;

  let value;
  try {
    value = settings(folder).get(key);
  } catch (err) {
    console.warn(`buildbar: ${key} ayari okunamadi -> ${err && err.message}`);
  }
  return value === undefined || value === null ? DEFAULTS[key] : value;
}

// ------------------------------------------------------------ jsonc okuma

/**
 * tasks.json JSONC'dir: yorum satiri ve son virgul icerebilir. Bagimlilik
 * eklemek yerine ikisini de temizleyip JSON.parse'a veriyoruz.
 */
function stripComments(text) {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const d = text[i + 1];

    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && d === '/') {
        inBlock = false;
        i++;
      } else if (c === '\n') {
        out += c; // satir numaralari kaymasin
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') {
        out += d === undefined ? '' : d;
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && d === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (c === '/' && d === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

function stripTrailingCommas(text) {
  let out = '';
  let inString = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inString) {
      out += c;
      if (c === '\\') {
        out += text[i + 1] === undefined ? '' : text[i + 1];
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') continue; // son virgul: at
    }
    out += c;
  }
  return out;
}

function readJsonc(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code !== 'ENOENT' && err.code !== 'ENOTDIR') {
      console.warn(`buildbar: ${file} okunamadi -> ${err.message}`);
    }
    return undefined;
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // BOM'lu dosyalar
  try {
    return JSON.parse(stripTrailingCommas(stripComments(raw)));
  } catch (err) {
    console.warn(`buildbar: ${file} ayristirilamadi -> ${err.message}`);
    return undefined;
  }
}

// ------------------------------------------------------------- gorev kesfi

const PLATFORM_KEY =
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';

/** tasks.json'daki windows/linux/osx bloklarini uygular. */
function platformEntry(entry) {
  if (!entry || typeof entry !== 'object') return {};
  const over = entry[PLATFORM_KEY];
  return over && typeof over === 'object' ? Object.assign({}, entry, over) : entry;
}

const groupKind = (entry) =>
  typeof entry.group === 'string'
    ? entry.group
    : entry.group && typeof entry.group === 'object'
      ? entry.group.kind
      : undefined;

const isDefaultBuild = (entry) =>
  !!entry.group && typeof entry.group === 'object' && entry.group.isDefault === true;

/** Detay verilmemis gorevler icin kisa bir komut ozeti. */
function commandLineOf(entry) {
  const e = platformEntry(entry);
  if (typeof e.command !== 'string') return undefined;
  const args = (Array.isArray(e.args) ? e.args : [])
    .map((a) => (typeof a === 'string' ? a : a && a.value))
    .filter((a) => typeof a === 'string');
  const line = [e.command, ...args].join(' ');
  return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}

/** tasks.json'daki ham gorev girdileri. */
function taskEntries(folder) {
  const file = readJsonc(path.join(folder.uri.fsPath, pref(folder, 'tasksFile')));
  const entries = file && Array.isArray(file.tasks) ? file.tasks : [];
  return entries.filter((entry) => entry && typeof entry === 'object');
}

/** Gorevin adi: label (2.0.0) ya da taskName (eski surum). */
const labelOf = (entry) =>
  typeof entry.label === 'string'
    ? entry.label
    : typeof entry.taskName === 'string'
      ? entry.taskName
      : undefined;

/** tasks.json icindeki gorevler. */
function taskOptions(folder) {
  const onlyBuild = pref(folder, 'onlyBuildGroup');
  // Temizlik gorevi bir yapilandirma degil; Temizle komutu onu ayrica kosar.
  const cleanName = pref(folder, 'cleanTask');

  const list = [];
  for (const entry of taskEntries(folder)) {
    const name = labelOf(entry);
    if (!name) continue;
    if (cleanName && name === cleanName) continue;
    if (onlyBuild && groupKind(entry) !== 'build') continue;

    list.push({
      kind: 'task',
      name,
      detail: typeof entry.detail === 'string' ? entry.detail : commandLineOf(entry),
      isDefault: isDefaultBuild(entry),
      entry
    });
  }
  return list;
}

/** tasks.json yoksa CMakePresets.json icindeki build preset'leri. */
function cmakeOptions(folder) {
  if (!pref(folder, 'cmakeFallback')) return [];

  const presets = readJsonc(path.join(folder.uri.fsPath, 'CMakePresets.json'));
  if (!presets || !Array.isArray(presets.buildPresets)) return [];

  const configureNames = new Set(
    (presets.configurePresets || []).filter((p) => p && !p.hidden).map((p) => p.name)
  );

  return presets.buildPresets
    .filter((p) => p && p.name && !p.hidden)
    .map((p) => ({
      kind: 'task',
      name: p.name,
      cmake: true,
      // Ayni isimli bir configure preset varsa configure adimini da zincirle.
      configure: configureNames.has(p.name),
      detail: configureNames.has(p.name) ? 'cmake configure + build' : 'cmake build'
    }));
}

/**
 * launch.json icindeki hata ayiklama yapilandirmalari. Bunlar derlenmez;
 * vscode.debug.startDebugging ile baslatilir. Yapilandirmada preLaunchTask
 * varsa derlemeyi VS Code kendisi zincirler.
 */
function launchOptions(folder) {
  const file = readJsonc(path.join(folder.uri.fsPath, pref(folder, 'launchFile')));
  if (!file) return [];

  const list = [];

  for (const conf of Array.isArray(file.configurations) ? file.configurations : []) {
    if (!conf || typeof conf !== 'object' || typeof conf.name !== 'string') continue;
    const parts = [conf.type, conf.request].filter((p) => typeof p === 'string');
    if (typeof conf.preLaunchTask === 'string') parts.push(`once: ${conf.preLaunchTask}`);
    list.push({
      kind: 'launch',
      name: conf.name,
      detail: parts.length ? parts.join(' / ') : undefined
    });
  }

  // compounds: birden fazla oturumu birlikte baslatan girdiler.
  for (const comp of Array.isArray(file.compounds) ? file.compounds : []) {
    if (!comp || typeof comp !== 'object' || typeof comp.name !== 'string') continue;
    const count = Array.isArray(comp.configurations) ? comp.configurations.length : 0;
    list.push({
      kind: 'launch',
      name: comp.name,
      detail: count ? `compound / ${count} yapilandirma` : 'compound'
    });
  }

  return list;
}

/**
 * Bir projenin seceneklerini bulur. Hangi dosyanin okundugu
 * buildbar.source ayarindan gelir: tasks | launch | both.
 *
 * @param {vscode.WorkspaceFolder} folder
 * @returns {BuildOption[]}
 */
function discover(folder) {
  const source = pref(folder, 'source');
  const list = [];

  if (source !== 'launch') {
    // tasks.json yoksa gorev tarafi CMakePresets'ten gelir.
    const tasks = taskOptions(folder);
    list.push(...(tasks.length ? tasks : cmakeOptions(folder)));
  }
  if (source !== 'tasks') {
    list.push(...launchOptions(folder));
  }

  // Dosyadaki sira yalnizca varsayilan secim icin saklanir (currentOption);
  // listeler (agac, quick pick) alfabetik gosterilir.
  list.forEach((opt, i) => {
    opt.order = i;
  });
  return sortOptions(list);
}

/** "debug-2" < "debug-10", buyuk/kucuk harf farki yok. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Gorevler once, yapilandirmalar sonra (both modu); her grubun icinde
 * alfabetik. Esit adlarda dosya sirasi korunur.
 */
function sortOptions(list) {
  const rank = (opt) => (isLaunch(opt) ? 1 : 0);
  return list
    .slice()
    .sort((a, b) => rank(a) - rank(b) || collator.compare(a.name, b.name) || a.order - b.order);
}

/** Ayara gore hangi dosyalara bakildigi; mesajlarda kullanilir. */
function sourceFiles(folder) {
  const source = pref(folder, 'source');
  const files = [];
  if (source !== 'launch') files.push(pref(folder, 'tasksFile'));
  if (source !== 'tasks') files.push(pref(folder, 'launchFile'));
  return files.join(' / ');
}

/** Listeye ne diyecegiz: gorev mi, yapilandirma mi? */
function sourceLabel(folder) {
  const source = pref(folder, 'source');
  if (source === 'launch') return 'hata ayiklama yapilandirmasi';
  if (source === 'both') return 'gorev ve yapilandirma';
  return 'derleme gorevi';
}

const isLaunch = (opt) => !!opt && opt.kind === 'launch';

/** Ad tek basina yetmez: both modunda gorev ve yapilandirma adi cakisabilir. */
const optionKey = (opt) => `${opt.kind || 'task'}:${opt.name}`;

/**
 * @param {vscode.WorkspaceFolder} folder
 * @returns {BuildOption[]}
 */
function optionsFor(folder) {
  const key = folder.uri.toString();
  if (!optionsCache.has(key)) {
    let list;
    try {
      list = discover(folder);
    } catch (err) {
      // Kesif hicbir kosulda disariya hata sizdirmamali: sizdirsa render()
      // yarida kalir ve butonlar onceki projede takili kalirdi.
      console.warn(`buildbar: ${folder.name} taranamadi -> ${err && err.message}`);
      list = [];
    }
    optionsCache.set(key, list);
  }
  return optionsCache.get(key);
}

const isBuildable = (folder) => !!folder && optionsFor(folder).length > 0;

// -------------------------------------------------------- ic ice projeler

/** Kesifte inilmeyen klasorler (gizli klasorler -- .git, .vscode... -- ayrica atlanir). */
const SKIP_DIRS = new Set(['node_modules']);

/** Ic ice aramada en fazla bu kadar seviye inilir (ayar ne derse desin). */
const MAX_DEPTH = 6;

/** dir, file'i (ya da kendisini) kapsiyor mu? Windows'ta buyuk/kucuk harf farki yok. */
function contains(dir, file) {
  const rel = path.relative(dir, file);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Workspace klasorunun altindaki projeler. Klasor kendisi bir projeyse
 * cagrilmaz. Bulunan bir projenin icine inilmez: vendor'lanmis bir
 * kutuphanenin CMakePresets.json dosyasi ayri proje gibi gorunmesin.
 *
 * @param {vscode.WorkspaceFolder} root
 * @param {boolean} prefix proje adinin onune klasor adi yazilsin mi (multi-root)
 * @returns {Project[]}
 */
function nestedProjects(root, prefix) {
  const depth = Math.min(Number(pref(root, 'nestedProjectDepth')) || 0, MAX_DEPTH);
  if (depth < 1) return [];

  const rootPath = root.uri.fsPath;
  // Baska bir workspace klasoru bu klasorun altindaysa o kendi basina listelenir.
  const roots = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.toString());
  // Hizli on eleme: proje olabilmesi icin bu adlardan biri klasorde durmali.
  const markers = [
    ...new Set([
      '.vscode',
      'CMakePresets.json',
      ...[pref(root, 'tasksFile'), pref(root, 'launchFile')].map(
        (file) => String(file).split(/[\\/]/)[0]
      )
    ])
  ].filter((m) => m && m !== '.' && m !== '..');

  const found = [];
  const walk = (dir, level) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return; // izin yok, silinmis...
    }
    const names = entries
      // Sembolik baglantilar izlenmez: dongu olusturabilirler.
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
      .map((e) => e.name)
      .sort(collator.compare);

    for (const name of names) {
      const full = path.join(dir, name);
      const uri = vscode.Uri.file(full);
      if (roots.includes(uri.toString())) continue;

      if (markers.some((m) => fs.existsSync(path.join(full, m)))) {
        const rel = path.relative(rootPath, full).split(path.sep).join('/');
        /** @type {Project} */
        const candidate = {
          uri,
          name: prefix ? `${root.name}/${rel}` : rel,
          index: root.index,
          root
        };
        if (isBuildable(candidate)) {
          found.push(candidate);
          continue; // projenin icine inilmez
        }
        optionsCache.delete(uri.toString());
        ownSettingsCache.delete(uri.toString());
      }
      if (level < depth) walk(full, level + 1);
    }
  };
  walk(rootPath, 1);
  return found;
}

/**
 * Butun projeler, workspace sirasiyla. Kendisi proje olmayan ama altinda
 * proje bulunan bir workspace klasoru (ornegin repolarin klonlandigi
 * ~/workspace) yalnizca bir kaptir; listede yerine icindekiler gorunur.
 * Altinda da proje yoksa klasor eskisi gibi "secenek yok" olarak kalir.
 *
 * @returns {Project[]}
 */
function projectList() {
  if (!projectCache) {
    const roots = vscode.workspace.workspaceFolders || [];
    const list = [];
    for (const root of roots) {
      let nested = [];
      if (!isBuildable(root)) {
        try {
          nested = nestedProjects(root, roots.length > 1);
        } catch (err) {
          console.warn(`buildbar: ${root.name} altinda proje aranamadi -> ${err && err.message}`);
        }
      }
      if (!nested.length) list.push(root);
      list.push(...nested);
    }
    projectCache = list;
  }
  return projectCache;
}

/**
 * Bir kaynagin ait oldugu proje: onu iceren en derindeki ic ice proje, yoksa
 * workspace klasoru.
 *
 *   Project -> o proje
 *   null    -> workspace disi
 *
 * @param {vscode.Uri} uri
 * @returns {Project | null}
 */
function projectOf(uri) {
  const root = vscode.workspace.getWorkspaceFolder(uri);
  if (!root) return null;
  const rootKey = root.uri.toString();
  let best;
  for (const p of projectList()) {
    if (!isNested(p) || p.root.uri.toString() !== rootKey) continue;
    if (!contains(p.uri.fsPath, uri.fsPath)) continue;
    if (!best || p.uri.fsPath.length > best.uri.fsPath.length) best = p;
  }
  return best || root;
}

/**
 * Projenin temizlik gorevi. Once buildbar.cleanTask ayarindaki tasks.json
 * etiketi aranir; proje secenekleri CMakePresets'ten geliyorsa secili
 * preset'in clean hedefi uretilir. Ikisi de yoksa undefined.
 *
 * @param {vscode.WorkspaceFolder} folder
 * @returns {BuildOption | undefined}
 */
function cleanOption(folder) {
  const name = pref(folder, 'cleanTask');
  if (name) {
    const entry = taskEntries(folder).find((e) => labelOf(e) === name);
    if (entry) {
      return {
        kind: 'task',
        name,
        entry,
        clean: true,
        detail: typeof entry.detail === 'string' ? entry.detail : commandLineOf(entry)
      };
    }
  }

  const current = currentOption(folder);
  if (current && current.cmake) {
    return {
      kind: 'task',
      name: `${current.name} (temizle)`,
      cmake: true,
      clean: true,
      preset: current.name,
      detail: 'cmake --target clean'
    };
  }
  return undefined;
}

/**
 * Secimi kaydeder. Ayni gorev adi pencere yeniden yuklendiginde de secili
 * kalsin diye workspaceState'e yazilir.
 */
function remember(folder, opt) {
  chosenTask.set(folder.uri.toString(), optionKey(opt));
  if (!store) return;
  const saved = {};
  for (const [key, value] of chosenTask) saved[key] = value;
  store.update(CHOSEN_KEY, saved);
}

/** Aktif projede secili olan gorev. */
function currentOption(folder) {
  const list = optionsFor(folder);
  if (!list.length) return undefined;
  const remembered = chosenTask.get(folder.uri.toString());
  return (
    list.find((o) => optionKey(o) === remembered) ||
    list.find((o) => o.name === remembered) || // 0.2.x kayitlari: yalnizca ad
    list.find((o) => o.isDefault) || // tasks.json'daki varsayilan build gorevi
    // Liste alfabetik; varsayilan yoksa dosyadaki ilk girdi (alfabetik ilk degil).
    list.reduce((first, o) => (o.order < first.order ? o : first))
  );
}

// ---------------------------------------------------- gercek gorevleri al

/** VS Code'un cozdugu gorevleri proje bazinda onbellege alir. */
async function reloadRealTasks() {
  realTasks.clear();
  let all;
  try {
    all = await vscode.tasks.fetchTasks();
  } catch (err) {
    console.warn(`buildbar: gorev listesi alinamadi -> ${err && err.message}`);
    return;
  }
  for (const task of all || []) {
    const scope = task.scope;
    // TaskScope.Global/Workspace sayidir; bize klasor kapsamlilar gerekiyor.
    if (!scope || typeof scope !== 'object' || !scope.uri) continue;
    const key = scope.uri.toString();
    if (!realTasks.has(key)) realTasks.set(key, new Map());
    realTasks.get(key).set(task.name, task);
  }
}

// ------------------------------------------------------- gorev calistirma

const VARIABLE = /\$\{[^}]+\}/;

/** Sentezlenen gorevde cozebildigimiz tek tuk degisken. */
function expand(value, folder) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([^}]+)\}/g, (all, name) => {
    if (name === 'workspaceFolder' || name === 'workspaceRoot') return folder.uri.fsPath;
    if (name === 'workspaceFolderBasename') return path.basename(folder.uri.fsPath);
    if (name === 'pathSeparator') return path.sep;
    return all; // cozemedik; sentezlemeyi iptal ettirecek
  });
}

const unresolved = (s) => typeof s === 'string' && VARIABLE.test(s);

/**
 * Ic ice projede gorevi VS Code tanimadigi icin gorev sistemine devretmek ise
 * yaramaz. Geri kalan degiskenleri (${env:...}, ${config:...}, ${file}...)
 * VS Code gorevi kosarken kendisi cozer; yalnizca ${input:...} cozulemez,
 * cunku girdi tanimi VS Code'un okumadigi tasks.json dosyasinda.
 */
const INPUT_VARIABLE = /\$\{input:[^}]*\}/;

/** Sentezlemeyi durduran bir degisken var mi? */
const blocked = (s, folder) =>
  typeof s === 'string' && (isNested(folder) ? INPUT_VARIABLE.test(s) : unresolved(s));

/** Nesnenin butun metin alanlarinda proje degiskenlerini cozer (derin kopya). */
function expandDeep(value, folder) {
  if (typeof value === 'string') return expand(value, folder);
  if (Array.isArray(value)) return value.map((v) => expandDeep(v, folder));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) out[key] = expandDeep(v, folder);
    return out;
  }
  return value;
}

/**
 * @param {Project} folder
 * @param {BuildOption} opt
 */
function executionFor(folder, opt) {
  const cwd = folder.uri.fsPath;

  // CMakePresets'ten gelen secenek: komutu biz uretiyoruz.
  if (opt.cmake) {
    if (opt.clean) {
      return new vscode.ShellExecution(`cmake --build --preset ${opt.preset} --target clean`, {
        cwd
      });
    }
    const build = `cmake --build --preset ${opt.name}`;
    return new vscode.ShellExecution(
      opt.configure ? `cmake --preset ${opt.name} && ${build}` : build,
      { cwd }
    );
  }

  const e = platformEntry(opt.entry);
  if (typeof e.command !== 'string') return undefined;

  const command = expand(e.command, folder);
  const args = (Array.isArray(e.args) ? e.args : []).map((a) =>
    expand(typeof a === 'string' ? a : a && a.value, folder)
  );
  const dir = e.options && e.options.cwd ? expand(e.options.cwd, folder) : cwd;

  if (args.some((a) => typeof a !== 'string')) return undefined;
  if ([command, dir, ...args].some((s) => blocked(s, folder))) return undefined;

  const opts = e.options && e.options.env ? { cwd: dir, env: e.options.env } : { cwd: dir };

  if (e.type === 'process') {
    return new vscode.ProcessExecution(command, args, opts);
  }

  // type: shell (varsayilan). args yoksa komut tam bir kabuk satiridir --
  // VS Code de boyle davranir, tirnaklamak "./build.sh --config x" i bozar.
  if (!args.length) return new vscode.ShellExecution(command, opts);

  return new vscode.ShellExecution(
    { value: command, quoting: vscode.ShellQuoting.Weak },
    args.map((a) => ({ value: a, quoting: vscode.ShellQuoting.Strong })),
    opts
  );
}

/** Gorevin kendi matcher'i yoksa ayardaki listeye duser. */
function matchersFor(folder, opt) {
  const fallback = pref(folder, 'problemMatchers');
  if (opt.cmake) return fallback;

  const pm = platformEntry(opt.entry).problemMatcher;
  if (pm === undefined) return fallback;

  // Satir ici (nesne) matcher'lar API uzerinden gecirilemez; adlari aliriz.
  return (Array.isArray(pm) ? pm : [pm]).filter((m) => typeof m === 'string');
}

function synthesize(folder, opt) {
  const exec = executionFor(folder, opt);
  if (!exec) return undefined;

  const definition = { type: 'buildbar', task: opt.name, project: folder.name };
  // Ic ice projenin gorevi workspace klasoru kapsaminda kosar; baslama
  // olayinda hangi projeye ait oldugu buradan bulunur (folderOfTask).
  if (isNested(folder)) definition.folder = folder.uri.fsPath;

  const task = new vscode.Task(
    definition,
    rootOf(folder),
    opt.name,
    'buildbar',
    exec,
    matchersFor(folder, opt)
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Dedicated,
    clear: true,
    showReuseMessage: false,
    echo: true
  };
  task.group = (opt.clean && vscode.TaskGroup.Clean) || vscode.TaskGroup.Build;
  return task;
}

/**
 * Secenegi kosar. Gorev kostuysa TaskExecution doner; hata ayiklama oturumu
 * ya da gorev sistemine devredilen islerde undefined.
 *
 * @param {Project} folder
 * @param {BuildOption} opt
 * @param {string[]} [chain] dependsOn zincirindeki gorevler (dongu korumasi)
 * @returns {Promise<vscode.TaskExecution | undefined>}
 */
async function runOption(folder, opt, chain) {
  // Hata ayiklama yapilandirmasi: derleme yok, oturum baslatilir. Ad klasor
  // kapsaminda cozuldugu icin dogru projenin launch.json'i kullanilir.
  if (isLaunch(opt)) {
    const started = isNested(folder)
      ? await startNestedDebugging(folder, opt)
      : await vscode.debug.startDebugging(folder, opt.name);
    if (started === false) {
      vscode.window.showWarningMessage(
        `BuildBar: ${opt.name} oturumu baslatilamadi. ${pref(
          folder,
          'launchFile'
        )} icindeki tanimi kontrol edin.`
      );
    }
    return;
  }

  // 1) tasks.json'daki gorevin VS Code tarafindan cozulmus hali.
  const known = realTasks.get(folder.uri.toString());
  const real = opt.entry && known ? known.get(opt.name) : undefined;
  if (real) return vscode.tasks.executeTask(real);

  // Ic ice projenin tasks.json'ini VS Code tanimaz; dependsOn'u biz uygulariz.
  if (isNested(folder) && opt.entry) {
    if (!(await runDependencies(folder, opt, chain))) return undefined;
    // Yalnizca dependsOn toplayan gorev: kosacak kendi komutu yok.
    if (typeof platformEntry(opt.entry).command !== 'string') return undefined;
  }

  // 2) Cozulmus hali yoksa (CMake preset, ic ice proje, henuz taranmamis
  //    dosya...) gorevi kendimiz kurariz.
  const task = synthesize(folder, opt);
  if (task) return vscode.tasks.executeTask(task);

  if (isNested(folder)) {
    vscode.window.showWarningMessage(
      `BuildBar: ${folder.name} / ${opt.name} kosturulamadi. Workspace klasoru olmayan ` +
        'projelerde ${input:...} degiskenleri desteklenmiyor; projeyi workspace klasoru ' +
        'olarak ekleyin (File > Add Folder to Workspace).'
    );
    return undefined;
  }

  // 3) Icinde ${input:...} gibi yalnizca VS Code'un cozebilecegi degisken
  //    var; gorev sistemine devret. Kosu onDidStartTask ile yine izlenir,
  //    ama bitisi beklenemez.
  await vscode.commands.executeCommand('workbench.action.tasks.runTask', opt.name);
  return undefined;
}

/** Ic ice projenin tasks.json'inda adi verilen gorev, secenek olarak. */
function nestedTaskOption(folder, name) {
  const entry = taskEntries(folder).find((e) => labelOf(e) === name);
  return entry ? { kind: 'task', name, entry } : undefined;
}

/**
 * dependsOn'daki gorevleri sirayla kosar (dependsOrder: parallel da sirali
 * kosar). Biri basarisizsa false: ana gorev kosmaz.
 */
async function runDependencies(folder, opt, chain) {
  const raw = opt.entry.dependsOn;
  const deps = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map((d) =>
    typeof d === 'string' ? d : JSON.stringify(d)
  );
  const seen = [...(chain || []), opt.name];
  for (const name of deps) {
    const dep = nestedTaskOption(folder, name);
    if (!dep || seen.includes(name)) {
      vscode.window.showWarningMessage(
        `BuildBar: ${folder.name} / ${opt.name}: dependsOn icindeki ${name} ` +
          (dep ? 'bir dongu olusturuyor.' : `${pref(folder, 'tasksFile')} icinde bulunamadi.`)
      );
      return false;
    }
    if (!succeeded(await runAndWait(folder, dep, seen))) return false;
  }
  return true;
}

/**
 * preLaunchTask projenin kendi tasks.json'indaysa onu biz kosariz ve alani
 * sileriz (VS Code o gorevi bulamazdi). Bulunamazsa alan oldugu gibi kalir:
 * VS Code'un tanidigi bir gorev olabilir. Gorev basarisizsa false.
 */
async function runPreLaunch(folder, conf) {
  if (typeof conf.preLaunchTask !== 'string') return true;
  const pre = nestedTaskOption(folder, conf.preLaunchTask);
  if (!pre) return true;
  delete conf.preLaunchTask;
  const result = await runAndWait(folder, pre);
  if (succeeded(result)) return true;
  vscode.window.showWarningMessage(
    `BuildBar: ${folder.name} / ${pre.name} ${statusOf(result)[1]}; hata ayiklama baslatilmadi.`
  );
  return false;
}

/**
 * Ic ice projede hata ayiklama. VS Code bu launch.json'i tanimadigi icin
 * yapilandirma adla degil nesne olarak verilir; ${workspaceFolder} projenin
 * klasorune cozulur, compound'lar tek tek baslatilir.
 *
 * @returns {Promise<boolean | undefined>} undefined: basarisizlik zaten bildirildi
 */
async function startNestedDebugging(folder, opt) {
  const file = readJsonc(path.join(folder.uri.fsPath, pref(folder, 'launchFile'))) || {};
  const configs = Array.isArray(file.configurations) ? file.configurations : [];
  const compound = (Array.isArray(file.compounds) ? file.compounds : []).find(
    (c) => c && typeof c === 'object' && c.name === opt.name
  );
  const names = compound
    ? (Array.isArray(compound.configurations) ? compound.configurations : []).map((c) =>
        typeof c === 'string' ? c : c && c.name
      )
    : [opt.name];

  if (compound && !(await runPreLaunch(folder, compound))) return undefined;

  let started = names.length > 0;
  for (const name of names) {
    const conf = configs.find((c) => c && typeof c === 'object' && c.name === name);
    if (!conf) {
      started = false;
      continue;
    }
    const resolved = expandDeep(platformEntry(conf), folder);
    if (!(await runPreLaunch(folder, resolved))) return undefined;
    started = (await vscode.debug.startDebugging(rootOf(folder), resolved)) && started;
  }
  return started;
}

// ------------------------------------------------- derleme durumu ve sonuc

/** Gorevin ait oldugu proje (yalnizca klasor kapsamli gorevler). */
function folderOfTask(task) {
  // Ic ice projelerin gorevleri workspace klasoru kapsaminda kosar; asil
  // proje sentezlerken tanima yazilan klasorden bulunur.
  const def = task && task.definition;
  if (def && def.type === 'buildbar' && typeof def.folder === 'string') {
    const key = vscode.Uri.file(def.folder).toString();
    const nested = projectList().find((p) => p.uri.toString() === key);
    if (nested) return nested;
  }

  const scope = task && task.scope;
  if (!scope || typeof scope !== 'object' || !scope.uri) return undefined;
  const key = scope.uri.toString();
  return (vscode.workspace.workspaceFolders || []).find((f) => f.uri.toString() === key);
}

/** Bu gorev bir derleme mi? Projenin secenegi, temizlik gorevi ya da bizim sentezimiz. */
function isTracked(folder, task) {
  if (task.definition && task.definition.type === 'buildbar') return true;
  const cleanName = pref(folder, 'cleanTask');
  if (cleanName && task.name === cleanName) return true;
  return optionsFor(folder).some((o) => !isLaunch(o) && o.name === task.name);
}

const isBuilding = (folder) => !!folder && running.has(folder.uri.toString());

/** Izlenen butun kosular: [{execution, name, started, folder}] */
function runningList() {
  const list = [];
  for (const execs of running.values()) {
    for (const [execution, info] of execs) list.push(Object.assign({ execution }, info));
  }
  return list;
}

const anyRunning = () => running.size > 0 || !!queue;

function onTaskStarted(e) {
  const execution = e && e.execution;
  const task = execution && execution.task;
  const folder = folderOfTask(task);
  if (!folder || !isTracked(folder, task)) return;

  endedEarly.delete(execution);
  const key = folder.uri.toString();
  if (!running.has(key)) running.set(key, new Map());
  running.get(key).set(execution, { name: task.name, started: Date.now(), folder });
  render();
}

function onTaskProcessEnded(e) {
  const execution = e && e.execution;
  if (!execution) return;
  exitCodes.set(execution, e.exitCode);

  // Normalde surec bitisi gorev bitisinden once gelir. Tersi olduysa sonucu
  // sonradan duzelt.
  for (const result of lastResult.values()) {
    if (result.execution === execution && result.exitCode === undefined) {
      result.exitCode = e.exitCode;
      render();
    }
  }
}

function onTaskEnded(e) {
  const execution = e && e.execution;
  if (!execution) return;

  let result;
  for (const [key, execs] of running) {
    const info = execs.get(execution);
    if (!info) continue;
    execs.delete(execution);
    if (!execs.size) running.delete(key);

    result = {
      name: info.name,
      exitCode: exitCodes.get(execution),
      ms: Date.now() - info.started,
      stopped: stoppedRuns.has(execution),
      execution
    };
    lastResult.set(key, result);
    announce(info.folder, result);
    render();
    break;
  }

  if (!result) result = { exitCode: exitCodes.get(execution), stopped: stoppedRuns.has(execution) };
  const list = waiters.get(execution);
  if (list) {
    waiters.delete(execution);
    list.forEach((resolve) => resolve(result));
  } else {
    endedEarly.set(execution, result);
  }
}

/**
 * Kosunun bitmesini bekler.
 * @returns {Promise<BuildResult>}
 */
function whenEnded(execution) {
  if (endedEarly.has(execution)) {
    const result = endedEarly.get(execution);
    endedEarly.delete(execution);
    return Promise.resolve(result);
  }
  return new Promise((resolve) => {
    if (!waiters.has(execution)) waiters.set(execution, []);
    waiters.get(execution).push(resolve);
  });
}

/**
 * Secenegi kosar ve bitmesini bekler. Hata ayiklama oturumu ya da gorev
 * sistemine devredilen islerde beklenecek bir sey yok.
 * @returns {Promise<BuildResult>}
 */
async function runAndWait(folder, opt, chain) {
  let execution;
  try {
    execution = await runOption(folder, opt, chain);
  } catch (err) {
    return { name: opt.name, error: (err && err.message) || String(err) };
  }
  if (!execution || typeof execution !== 'object') return { name: opt.name, delegated: true };
  return whenEnded(execution);
}

/** Basarisiz sayilir mi? Cikis kodu bilinmiyorsa basarisiz denmez. */
const failed = (r) =>
  !!r && (!!r.error || (!r.stopped && typeof r.exitCode === 'number' && r.exitCode !== 0));

/** Bir sonraki adima gecmek icin yeterince iyi mi? */
const succeeded = (r) => !!r && !r.stopped && !failed(r);

/** Sonucu kisa metne cevirir: [ikon, durum]. */
function statusOf(r) {
  if (r.error) return ['$(error)', `hata: ${r.error}`];
  if (r.stopped) return ['$(debug-stop)', 'durduruldu'];
  if (r.delegated) return ['$(info)', 'gorev sistemine devredildi'];
  if (typeof r.exitCode !== 'number') return ['$(info)', 'bitti'];
  if (r.exitCode === 0) return ['$(check)', 'tamam'];
  return ['$(error)', `basarisiz (cikis ${r.exitCode})`];
}

const seconds = (ms) => `${(ms / 1000).toFixed(1).replace('.', ',')} sn`;

/**
 * Projedeki Problems sayisi. Derleyici hatalarinin yaninda dil sunucusunun
 * (IntelliSense) bildirdikleri de sayilir; Eclipse'in Problems gorunumu de
 * Codan bulgularini ayni sekilde karistirir.
 */
function problemCounts(folder) {
  let all;
  try {
    all = vscode.languages.getDiagnostics();
  } catch (err) {
    return undefined;
  }
  const key = folder.uri.toString();
  let errors = 0;
  let warnings = 0;
  for (const [uri, diagnostics] of all || []) {
    if (!uri || (uri.scheme && uri.scheme !== 'file')) continue;
    const owner = projectOf(uri);
    if (!owner || owner.uri.toString() !== key) continue;
    for (const d of diagnostics || []) {
      if (d.severity === vscode.DiagnosticSeverity.Error) errors++;
      else if (d.severity === vscode.DiagnosticSeverity.Warning) warnings++;
    }
  }
  return { errors, warnings };
}

function problemsText(folder) {
  const counts = problemCounts(folder);
  if (!counts || (!counts.errors && !counts.warnings)) return undefined;
  return `Problems: ${counts.errors} hata, ${counts.warnings} uyari`;
}

/** Eclipse'in "Build Finished. N errors, M warnings (took ...)" satirinin karsiligi. */
function resultLine(folder, r) {
  const [icon, status] = statusOf(r);
  const parts = [`${icon} BuildBar: ${folder.name} / ${r.name} ${status}`];
  if (typeof r.ms === 'number') parts[0] += ` (${seconds(r.ms)})`;
  const problems = problemsText(folder);
  if (problems && !r.stopped) parts.push(problems);
  return parts.join(' - ');
}

function announce(folder, r) {
  vscode.window.setStatusBarMessage(resultLine(folder, r), 10000);
}

/**
 * Kosan derlemeleri durdurur. folders verilmezse hepsi; kuyruk da iptal edilir.
 * wait true ise kosularin bitmesi beklenir.
 */
async function stopRuns(folders, opts) {
  const keys = folders ? new Set(folders.map((f) => f.uri.toString())) : undefined;
  if (!keys && queue) queue.cancelled = true;

  const targets = runningList().filter((r) => !keys || keys.has(r.folder.uri.toString()));
  for (const r of targets) {
    stoppedRuns.add(r.execution);
    try {
      r.execution.terminate();
    } catch (err) {
      console.warn(`buildbar: ${r.name} durdurulamadi -> ${err && err.message}`);
    }
  }
  if (opts && opts.wait && targets.length) {
    // terminate() normalde hemen biter; takilirsa sonsuza dek beklemeyelim.
    const timeout = new Promise((resolve) => setTimeout(resolve, 15000));
    await Promise.race([Promise.all(targets.map((r) => whenEnded(r.execution))), timeout]);
  }
  return targets.length;
}

/**
 * Tek bir projede derler. Proje zaten derleniyorsa Eclipse'teki gibi sorar:
 * durdur ya da yeniden baslat. Boylece cift tiklama derlemeyi kazara
 * durdurmaz, ayni gorev de ust uste baslamaz.
 */
async function buildFolder(folder, opt) {
  if (!isLaunch(opt) && isBuilding(folder)) {
    const names = runningList()
      .filter((r) => r.folder.uri.toString() === folder.uri.toString())
      .map((r) => r.name)
      .join(', ');
    const choice = await vscode.window.showWarningMessage(
      `BuildBar: ${folder.name} icinde ${names} derleniyor.`,
      'Durdur',
      'Yeniden baslat'
    );
    if (choice === 'Durdur') {
      await stopRuns([folder]);
      return undefined;
    }
    if (choice !== 'Yeniden baslat') return undefined;
    await stopRuns([folder], { wait: true });
  }
  return runOption(folder, opt);
}

/**
 * Adimlari sirayla kosar; her gorevin bitmesi beklenir. Bir adim
 * needsPrevious tasiyorsa onceki adim basarili degilse atlanir (temizle
 * basarisizsa derleme yapilmaz). Durdur dugmesi kuyrugu da iptal eder.
 *
 * @param {{folder: vscode.WorkspaceFolder, opt: BuildOption, needsPrevious?: boolean}[]} steps
 * @returns {Promise<{step: object, result?: BuildResult, skipped?: string}[] | undefined>}
 */
async function runQueue(steps) {
  if (queue) {
    vscode.window.showWarningMessage('BuildBar: onceki sira henuz bitmedi.');
    return undefined;
  }
  const busy = [...new Set(steps.filter((s) => isBuilding(s.folder)).map((s) => s.folder.name))];
  if (busy.length) {
    vscode.window.showWarningMessage(
      `BuildBar: ${busy.join(', ')} icinde derleme suruyor. Bitmesini bekleyin ya da durdurun.`
    );
    return undefined;
  }

  const current = { cancelled: false };
  queue = current;
  render();

  const results = [];
  try {
    for (const step of steps) {
      const previous = results[results.length - 1];
      if (current.cancelled) {
        results.push({ step, skipped: 'iptal edildi' });
      } else if (step.needsPrevious && previous && !succeeded(previous.result)) {
        results.push({ step, skipped: 'onceki adim basarisiz' });
      } else {
        results.push({ step, result: await runAndWait(step.folder, step.opt) });
      }
    }
  } finally {
    queue = undefined;
    render();
  }
  return results;
}

/** Coklu proje islerinden sonra tek bildirimde ozet. */
function summarize(results, skipped) {
  const lines = results.map(({ step, result, skipped: why }) => {
    const label = `${step.folder.name} / ${step.opt.name}`;
    return why ? `${label}: ${why}` : `${label}: ${statusOf(result)[1]}`;
  });
  lines.push(...skipped);
  const bad =
    skipped.length > 0 ||
    results.some((r) => r.skipped || failed(r.result) || (r.result && r.result.stopped));
  const text = `BuildBar: ${lines.join('; ')}`;
  if (bad) vscode.window.showWarningMessage(text);
  else vscode.window.showInformationMessage(text);
}

// ------------------------------------------------------------------- agac

const projectNode = (folder) => {
  const key = folder.uri.toString();
  if (!projectNodes.has(key)) projectNodes.set(key, { kind: 'project', folder });
  const node = projectNodes.get(key);
  node.folder = folder; // refresh sonrasi proje nesnesi yenilenmis olabilir
  return node;
};

const optionNode = (folder, opt) => {
  // Ad tek basina yetmez: both modunda ayni adli bir gorev ve yapilandirma
  // ayni dugum nesnesine duserdi.
  const key = `${folder.uri.toString()}::${optionKey(opt)}`;
  if (!optionNodes.has(key)) optionNodes.set(key, { kind: 'option', folder, opt });
  const node = optionNodes.get(key);
  node.opt = opt; // icerik degismis olabilir
  return node;
};

const isActive = (folder) => !!active && active.uri.toString() === folder.uri.toString();

/** @type {vscode.TreeDataProvider<Node>} */
const provider = {
  onDidChangeTreeData: treeChanged.event,

  getChildren(node) {
    if (!node) {
      return projectList().map(projectNode);
    }
    if (node.kind === 'project') {
      return optionsFor(node.folder).map((o) => optionNode(node.folder, o));
    }
    return [];
  },

  getParent(node) {
    return node.kind === 'option' ? projectNode(node.folder) : undefined;
  },

  getTreeItem(node) {
    if (node.kind === 'project') {
      const list = optionsFor(node.folder);
      const item = new vscode.TreeItem(
        node.folder.name,
        list.length
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.None
      );
      item.id = `p:${node.folder.uri.toString()}`;
      item.contextValue = 'buildbar.project';
      item.iconPath = new vscode.ThemeIcon(
        list.length ? 'folder-library' : 'folder',
        isActive(node.folder) ? new vscode.ThemeColor('charts.blue') : undefined
      );
      item.description =
        [
          isActive(node.folder) ? '(aktif)' : undefined,
          isBuilding(node.folder) ? '(derleniyor)' : undefined,
          list.length ? undefined : 'secenek yok'
        ]
          .filter(Boolean)
          .join(' ') || undefined;
      item.tooltip = new vscode.MarkdownString(
        `**${node.folder.name}**\n\n${node.folder.uri.fsPath}\n\n` +
          (list.length
            ? `${list.length} secenek`
            : `\`${sourceFiles(node.folder)}\` bulunamadi`)
      );
      return item;
    }

    const chosen = currentOption(node.folder);
    const selected = !!chosen && optionKey(chosen) === optionKey(node.opt);
    const launch = isLaunch(node.opt);
    const busy =
      !launch &&
      runningList().some(
        (r) => r.folder.uri.toString() === node.folder.uri.toString() && r.name === node.opt.name
      );

    const item = new vscode.TreeItem(node.opt.name, vscode.TreeItemCollapsibleState.None);
    item.id = `o:${node.folder.uri.toString()}::${optionKey(node.opt)}`;
    // Satir sonundaki eylem ikonu turune gore degisiyor (derle / hata ayikla).
    item.contextValue = launch ? 'buildbar.option.launch' : 'buildbar.option.task';
    item.iconPath = new vscode.ThemeIcon(
      busy ? 'sync~spin' : selected ? 'circle-filled' : 'circle-outline',
      selected && isActive(node.folder) ? new vscode.ThemeColor('charts.blue') : undefined
    );
    // Secili olani yazi ile de isaretle: ikon farki her temada okunmuyor.
    item.description = [node.opt.detail, selected ? '(secili)' : undefined]
      .filter(Boolean)
      .join('  ');
    item.tooltip = new vscode.MarkdownString(
      `**${node.opt.name}**\n\n` +
        (node.opt.detail ? `${node.opt.detail}\n\n` : '') +
        (launch
          ? 'Tikla: bu yapilandirmayi sec. Baslatmak icin satirin sagindaki ikona bas.'
          : 'Tikla: bu gorevi sec. Derlemek icin satirin sagindaki oynat ikonuna bas.')
    );
    // Bilerek item.command yok: tiklamak yalnizca secer. Kazara derleme
    // baslatmak yerine once secimin gorunur olmasi daha iyi.
    return item;
  }
};

// ----------------------------------------------------- aktif proje yonetimi

/** Workspace'te derlenebilir en az bir proje var mi? */
const anyBuildable = () => projectList().some(isBuildable);

/** Aktif projenin son derlemesi icin ipucu satirlari. */
function lastResultTooltip(folder) {
  const r = lastResult.get(folder.uri.toString());
  if (!r) return '';
  const [, status] = statusOf(r);
  let text = `\n\nSon derleme: \`${r.name}\` ${status}`;
  if (typeof r.ms === 'number') text += `, ${seconds(r.ms)}`;
  const problems = problemsText(folder);
  if (problems) text += `\n\n${problems} (bu projede)`;
  return text;
}

/** Durdur butonu: herhangi bir derleme ya da kuyruk surerken gorunur. */
function renderStop() {
  const list = runningList();
  if (!list.length && !queue) {
    stopBar.hide();
    return;
  }
  stopBar.text = '$(debug-stop)';
  stopBar.command = 'buildbar.stop';
  stopBar.tooltip = new vscode.MarkdownString(
    '**Derlemeyi durdur**' +
      (list.length
        ? `\n\n${list.map((r) => `- ${r.folder.name} / \`${r.name}\``).join('\n')}`
        : '') +
      (queue ? '\n\nSiradaki isler de iptal edilir.' : '')
  );
  stopBar.show();
}

function render() {
  const opt = active ? currentOption(active) : undefined;
  bar.backgroundColor = undefined;

  if (opt) {
    const list = optionsFor(active);
    const launch = isLaunch(opt);
    const building = isBuilding(active);

    // Ikon ve komut secenegin turune gore: gorev derlenir, yapilandirma
    // hata ayiklama oturumu baslatir. Derleme surerken ikon doner; tiklamak
    // durdurmaz, ne yapilacagini sorar (buildFolder).
    bar.text = `${building ? '$(sync~spin)' : launch ? '$(debug-alt)' : '$(play)'} ${active.name}`;
    bar.command = launch ? 'buildbar.debugStart' : 'buildbar.build';
    bar.tooltip = new vscode.MarkdownString(
      (building
        ? `**Derleniyor** \`${runningList()
            .filter((r) => r.folder.uri.toString() === active.uri.toString())
            .map((r) => r.name)
            .join(', ')}\` - durdurmak icin yanindaki kare dugme`
        : `${launch ? '**Hata ayiklamayi baslat**' : '**Derle**'} \`${opt.name}\``) +
        `\n\nProje: ${active.name}` +
        lastResultTooltip(active)
    );
    // Son derleme basarisizsa Eclipse'teki kirmizi isaretler gibi goze carpsin.
    if (!building && failed(lastResult.get(active.uri.toString()))) {
      bar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    }
    bar.show();

    taskBar.text = `$(list-selection) ${opt.name}`;
    taskBar.command = 'buildbar.pickTask';
    taskBar.tooltip = new vscode.MarkdownString(
      `**Secili ${launch ? 'yapilandirma' : 'gorev'}:** \`${opt.name}\`\n\n` +
        `${active.name} icinde ${list.length} secenek var. Tikla: degistir.`
    );
    taskBar.show();
  } else {
    taskBar.hide();

    if (active) {
      // Gorevi olmayan bir klasore gecildi. Onceki projenin butonlarini
      // birakmak yaniltici olurdu; durumu acikca yaz.
      bar.text = `$(circle-slash) ${active.name}: secenek yok`;
      bar.command = 'buildbar.pickProject';
      bar.tooltip = new vscode.MarkdownString(
        `**${active.name}** icinde \`${sourceFiles(active)}\` yok.\n\n` +
          'Tikla: derlenebilir bir proje sec.'
      );
      bar.show();
    } else if (anyBuildable()) {
      bar.text = '$(circle-slash) BuildBar: proje sec';
      bar.command = 'buildbar.pickProject';
      bar.tooltip = new vscode.MarkdownString('Aktif proje yok. Tikla: sec.');
      bar.show();
    } else {
      bar.hide();
    }
  }

  renderStop();

  vscode.commands.executeCommand('setContext', 'buildbar.hasProject', !!opt);
  // Ust sagdaki dugmenin ikonu bu anahtara gore degisiyor.
  vscode.commands.executeCommand('setContext', 'buildbar.isLaunch', isLaunch(opt));
  // Durdur dugmesi (editor basligi, agac basligi) bu anahtarla gorunur.
  vscode.commands.executeCommand('setContext', 'buildbar.isRunning', anyRunning());
  treeChanged.fire();
}

/**
 * @param {vscode.WorkspaceFolder | undefined} folder
 * @param {{reveal?: boolean}} [opts]
 */
function setActive(folder, opts) {
  const changed = (folder && folder.uri.toString()) !== (active && active.uri.toString());
  active = folder;
  render();

  if (changed && opts && opts.reveal && folder && view.visible) {
    view
      .reveal(projectNode(folder), { select: true, focus: false, expand: true })
      .then(undefined, () => {
        /* gorunum kapaliysa reveal reddedilir, sorun degil */
      });
  }
}

/**
 * Aktif editorun ait oldugu proje (ic ice projelerde en derindeki).
 *
 *   Project   -> bu projeye gec
 *   null      -> workspace disi dosya, aktif projeyi temizle
 *   undefined -> bilgi yok (ayarlar sekmesi, cikti paneli...), dokunma
 *
 * @param {vscode.TextEditor | undefined} editor
 */
function folderOfEditor(editor) {
  if (!editor || !editor.document) return undefined;
  const uri = editor.document.uri;
  if (uri.scheme && uri.scheme !== 'file') return undefined;
  return projectOf(uri);
}

/**
 * Aktif sekmenin URI'si. Metin editoru olmayan sekmeler de sayilir:
 * markdown preview'in yaninda resim, notebook, fark gorunumu...
 * Webview gibi URI tasimayan sekmelerde undefined doner.
 */
function uriOfActiveTab() {
  const groups = vscode.window.tabGroups;
  const tab = groups && groups.activeTabGroup && groups.activeTabGroup.activeTab;
  const input = tab && tab.input;
  if (!input || typeof input !== 'object') return undefined;
  return input.uri || input.modified || input.original || undefined;
}

/**
 * Aktif projeyi aktif sekmeye gore guncelle. Once metin editoru, o yoksa
 * sekme listesi. Ikisi de bir dosya gostermiyorsa mevcut durum korunur.
 */
function syncFromActiveTab() {
  if (!pref(undefined, 'followActiveEditor')) return;

  let folder = folderOfEditor(vscode.window.activeTextEditor);

  if (folder === undefined) {
    const uri = uriOfActiveTab();
    if (!uri) return; // ne gosterdigini bilmiyoruz
    if (uri.scheme && uri.scheme !== 'file') return;
    folder = projectOf(uri);
  }

  setActive(folder || undefined);
}

/** Ilk acilista makul bir baslangic projesi sec. */
function pickInitial() {
  const f = folderOfEditor(vscode.window.activeTextEditor);
  if (f) return f;

  const uri = uriOfActiveTab();
  const fromTab = uri && (!uri.scheme || uri.scheme === 'file') ? projectOf(uri) : undefined;
  if (fromTab) return fromTab;

  return projectList().find(isBuildable);
}

/**
 * Explorer baglam menusunden gelen argumanlari projeye cevirir.
 * Ilk arguman tiklanan kaynak, ikincisi coklu secimin tamami.
 */
function folderFromArgs(uri, uris) {
  const target = Array.isArray(uris) && uris.length ? uris[0] : uri;
  if (!target) return undefined;
  return projectOf(target) || undefined;
}

/** Coklu secimdeki farkli projeler, secim sirasiyla. */
function foldersFromArgs(uri, uris) {
  const targets = Array.isArray(uris) && uris.length ? uris : uri ? [uri] : [];
  const seen = new Set();
  const out = [];
  for (const target of targets) {
    const folder = projectOf(target);
    if (!folder || seen.has(folder.uri.toString())) continue;
    seen.add(folder.uri.toString());
    out.push(folder);
  }
  return out;
}

/**
 * Komutun hedef projeleri. Agac satirindan dugum, Explorer'dan URI gelir;
 * komut paletinden arguman gelmez, o zaman aktif proje.
 */
function targetFolders(arg, uris) {
  if (arg && (arg.kind === 'project' || arg.kind === 'option')) return [arg.folder];
  if (arg && typeof arg === 'object' && 'fsPath' in arg) return foldersFromArgs(arg, uris);
  return active ? [active] : [];
}

// ---------------------------------------------------------------- komutlar

async function cmdBuild() {
  if (!active) return void vscode.window.showWarningMessage('BuildBar: aktif proje yok.');
  const opt = currentOption(active);
  if (!opt) {
    return void vscode.window.showWarningMessage(
      `BuildBar: ${active.name} icin secenek bulunamadi (${sourceFiles(active)}).`
    );
  }
  await buildFolder(active, opt);
}

async function cmdBuildNode(node) {
  if (!node || node.kind !== 'option') return cmdBuild();
  remember(node.folder, node.opt);
  setActive(node.folder);
  await buildFolder(node.folder, node.opt);
}

/**
 * Secenek listesi. Iki kullanim:
 *   status bar'daki liste      -> Enter yalnizca secer (Set Active Build
 *                                 Configuration)
 *   derle dugmesinin yanindaki -> runOnAccept: Enter secer ve derler
 *   acilir ok (Sec ve derle...)   (Python'daki "Run Python File" oku gibi;
 *                                 secilen, derle dugmesinin yeni
 *                                 varsayilani olur)
 * Satir sonu dugmesi bilerek yok: sec ve derle acilir okun isi.
 *
 * @param {vscode.WorkspaceFolder} folder
 * @param {{runOnAccept?: boolean}} [opts]
 */
async function pickOption(folder, opts) {
  const runOnAccept = !!(opts && opts.runOnAccept);
  const list = optionsFor(folder);
  if (!list.length) {
    return void vscode.window.showWarningMessage(
      `BuildBar: ${folder.name} icin secenek bulunamadi (${sourceFiles(folder)}).`
    );
  }

  const current = currentOption(folder);
  const verb = list.every(isLaunch) ? 'baslat' : list.some(isLaunch) ? 'derle / baslat' : 'derle';

  // QuickPickItem.picked yalnizca canPickMany ile calisiyor, o yuzden secili
  // olani etiketin icinde isaretliyoruz.
  const items = list.map((o) => {
    const isCurrent = !!current && optionKey(o) === optionKey(current);
    return {
      opt: o,
      name: o.name,
      label: `${isCurrent ? '$(check)' : '$(blank)'} ${o.name}`,
      description: [
        isCurrent ? 'secili' : undefined,
        o.isDefault ? 'varsayilan' : undefined,
        o.detail
      ]
        .filter(Boolean)
        .join('  -  ')
    };
  });

  const qp = vscode.window.createQuickPick();
  qp.title = `${folder.name} - ${sourceLabel(folder)}`;
  qp.placeholder = [
    current ? `su an secili: ${current.name}` : undefined,
    runOnAccept ? `Enter: sec ve ${verb}` : 'Enter: sec'
  ]
    .filter(Boolean)
    .join('  |  ');
  qp.matchOnDescription = true;
  qp.items = items;
  const currentItem = items.find((i) => current && optionKey(i.opt) === optionKey(current));
  if (currentItem) qp.activeItems = [currentItem];

  /** @type {{opt: BuildOption, run: boolean} | undefined} */
  let choice;
  await new Promise((resolve) => {
    let done = false;
    const finish = (item, run) => {
      if (done) return;
      done = true;
      if (item) choice = { opt: item.opt, run };
      qp.hide();
      resolve();
    };
    qp.onDidAccept(() => finish(qp.selectedItems[0] || qp.activeItems[0], runOnAccept));
    qp.onDidHide(() => {
      qp.dispose();
      finish(undefined, false);
    });
    qp.show();
  });
  if (!choice) return;

  remember(folder, choice.opt);
  render();
  if (choice.run) await buildFolder(folder, choice.opt);
}

async function cmdPickTask() {
  if (!active) return void vscode.window.showWarningMessage('BuildBar: aktif proje yok.');
  await pickOption(active);
}

async function cmdPickAndBuild() {
  if (!active) return void vscode.window.showWarningMessage('BuildBar: aktif proje yok.');
  await pickOption(active, { runOnAccept: true });
}

async function cmdPickProject() {
  const folders = projectList().filter(isBuildable);
  if (!folders.length) {
    return void vscode.window.showWarningMessage(
      'BuildBar: secenek iceren proje bulunamadi.'
    );
  }
  const picked = await vscode.window.showQuickPick(
    folders.map((f) => ({
      label: `${isActive(f) ? '$(check)' : '$(blank)'} ${f.name}`,
      description: `${optionsFor(f).length} secenek`,
      folder: f
    })),
    { title: 'Aktif proje', placeHolder: active ? `su an aktif: ${active.name}` : undefined }
  );
  if (picked) setActive(picked.folder, { reveal: true });
}

/** Explorer sag tik: yalnizca aktif projeyi degistir. */
function cmdSetActiveFromExplorer(uri, uris) {
  const folder = folderFromArgs(uri, uris);
  if (!folder) return;
  setActive(folder, { reveal: true });
  if (!isBuildable(folder)) {
    vscode.window.showInformationMessage(
      `BuildBar: ${folder.name} icinde ${sourceFiles(folder)} bulunamadi.`
    );
  }
}

/**
 * Explorer sag tik: aktif projeyi degistir ve secili gorevi derle.
 * Birden fazla proje seciliyse Eclipse'teki cekic gibi hepsini sirayla
 * derler; ilki aktif proje olur.
 */
async function cmdBuildFromExplorer(uri, uris) {
  const folders = foldersFromArgs(uri, uris);
  if (!folders.length) {
    return void vscode.window.showWarningMessage(
      'BuildBar: bu kaynak bir workspace klasorunun icinde degil.'
    );
  }
  const folder = folders[0];
  setActive(folder, { reveal: true });

  if (folders.length === 1) {
    const opt = currentOption(folder);
    if (!opt) {
      return void vscode.window.showWarningMessage(
        `BuildBar: ${folder.name} icinde ${sourceFiles(folder)} bulunamadi.`
      );
    }
    return void (await buildFolder(folder, opt));
  }

  const steps = [];
  const skipped = [];
  for (const f of folders) {
    const opt = currentOption(f);
    if (!opt) skipped.push(`${f.name}: secenek yok`);
    // Coklu derlemede hata ayiklama oturumlari ust uste acilmasin.
    else if (isLaunch(opt)) skipped.push(`${f.name}: hata ayiklama yapilandirmasi, atlandi`);
    else steps.push({ folder: f, opt });
  }
  if (!steps.length) {
    return void vscode.window.showWarningMessage(`BuildBar: ${skipped.join('; ')}`);
  }
  const results = await runQueue(steps);
  if (results) summarize(results, skipped);
}

/** Explorer sag tik: aktif projeyi degistir ve gorev listesini ac. */
async function cmdPickTaskFromExplorer(uri, uris) {
  const folder = folderFromArgs(uri, uris);
  if (!folder) {
    return void vscode.window.showWarningMessage(
      'BuildBar: bu kaynak bir workspace klasorunun icinde degil.'
    );
  }
  setActive(folder, { reveal: true });
  await cmdPickTask();
}

/** Explorer sag tik: aktif projeyi degistir, listeden secileni hemen derle. */
async function cmdPickAndBuildFromExplorer(uri, uris) {
  const folder = folderFromArgs(uri, uris);
  if (!folder) {
    return void vscode.window.showWarningMessage(
      'BuildBar: bu kaynak bir workspace klasorunun icinde degil.'
    );
  }
  setActive(folder, { reveal: true });
  await pickOption(folder, { runOnAccept: true });
}

/** Durdur: izlenen butun derlemeler ve kuyruk (Launch Bar'daki Stop gibi). */
async function cmdStop() {
  const hadQueue = !!queue;
  const count = await stopRuns();
  if (!count && !hadQueue) {
    vscode.window.showInformationMessage('BuildBar: suren bir derleme yok.');
  }
}

/**
 * Temizle / Temizle ve derle (Eclipse: Project > Clean..., "Start a build
 * immediately"). Agac satirindan, Explorer'dan (coklu secim dahil) ya da
 * komut paletinden (aktif proje) cagrilir.
 */
async function cleanCommand(arg, uris, andBuild) {
  const folders = targetFolders(arg, uris);
  if (!folders.length) return void vscode.window.showWarningMessage('BuildBar: aktif proje yok.');
  if (arg) setActive(folders[0], { reveal: true });

  const steps = [];
  const missing = [];
  for (const f of folders) {
    const clean = cleanOption(f);
    if (!clean) {
      missing.push(f.name);
      continue;
    }
    steps.push({ folder: f, opt: clean });
    if (andBuild) {
      const opt = currentOption(f);
      if (opt && !isLaunch(opt)) steps.push({ folder: f, opt, needsPrevious: true });
    }
  }

  if (missing.length) {
    vscode.window.showInformationMessage(
      `BuildBar: ${missing.join(', ')} icin temizlik gorevi tanimli degil. ` +
        'tasks.json icindeki temizlik gorevinin etiketini "buildbar.cleanTask" ayarina yazin ' +
        '(CMakePresets projelerinde gerekmez).'
    );
  }
  if (!steps.length) return;

  const results = await runQueue(steps);
  if (results && folders.length > 1) summarize(results, []);
}

const cmdClean = (arg, uris) => cleanCommand(arg, uris, false);
const cmdCleanBuild = (arg, uris) => cleanCommand(arg, uris, true);

/**
 * Proje listesini yeniden kurar. Ic ice bir proje eklenmis ya da kaybolmus
 * olabilir; aktif proje ayni klasorden yeniden cozulur.
 */
function resetProjects() {
  optionsCache.clear();
  ownSettingsCache.clear();
  projectCache = undefined;
  if (active) active = projectOf(active.uri) || undefined;
}

async function cmdRefresh() {
  resetProjects();
  optionNodes.clear();
  render(); // dosyalardan gelen liste hemen tazelensin
  await reloadRealTasks();
  render();
}

// ---------------------------------------------------------------- activate

function activate(ctx) {
  store = ctx.workspaceState;
  const saved = (store && store.get(CHOSEN_KEY)) || {};
  for (const key of Object.keys(saved)) {
    if (typeof saved[key] === 'string') chosenTask.set(key, saved[key]);
  }

  // Ikisi yan yana dursun: sol hizada buyuk priority daha solda kalir.
  bar = vscode.window.createStatusBarItem('buildbar.build', vscode.StatusBarAlignment.Left, 1000);
  bar.name = 'BuildBar: derle';

  taskBar = vscode.window.createStatusBarItem(
    'buildbar.task',
    vscode.StatusBarAlignment.Left,
    999
  );
  taskBar.name = 'BuildBar: derleme gorevi';

  // Derle ile gorev arasinda, yalnizca derleme surerken gorunur.
  stopBar = vscode.window.createStatusBarItem(
    'buildbar.stop',
    vscode.StatusBarAlignment.Left,
    999.5
  );
  stopBar.name = 'BuildBar: durdur';

  view =vscode.window.createTreeView('buildbar.projects', {
    treeDataProvider: provider,
    showCollapseAll: true
  });

  // Asil mekanizma: kendi agacimizdaki secim gozlemlenebilir.
  view.onDidChangeSelection((e) => {
    const node = e.selection[0];
    if (!node) return;
    if (node.kind === 'option') {
      remember(node.folder, node.opt);
    }
    setActive(node.folder);
  });

  const watcher = vscode.workspace.createFileSystemWatcher(
    '**/{tasks.json,launch.json,CMakePresets.json}'
  );
  // Ic ice projelerin kendi buildbar.* ayarlari; VS Code bunlari okumadigi
  // icin onDidChangeConfiguration da gelmez.
  const settingsWatcher = vscode.workspace.createFileSystemWatcher('**/.vscode/settings.json');

  ctx.subscriptions.push(
    bar,
    taskBar,
    stopBar,
    view,
    watcher,
    settingsWatcher,
    treeChanged,
    vscode.commands.registerCommand('buildbar.build', cmdBuild),
    // Ayni islerin hata ayiklama ikonlu ikizleri: editor/title ve agac
    // satirindaki ikon yalnizca komuta bagli oldugu icin ikinci bir kayit
    // gerekiyor (bkz. package.json > menus, when: buildbar.isLaunch).
    vscode.commands.registerCommand('buildbar.debugStart', cmdBuild),
    vscode.commands.registerCommand('buildbar.buildNode', cmdBuildNode),
    vscode.commands.registerCommand('buildbar.debugNode', cmdBuildNode),
    vscode.commands.registerCommand('buildbar.pickTask', cmdPickTask),
    vscode.commands.registerCommand('buildbar.pickProject', cmdPickProject),
    vscode.commands.registerCommand('buildbar.setActiveFromExplorer', cmdSetActiveFromExplorer),
    vscode.commands.registerCommand('buildbar.buildFromExplorer', cmdBuildFromExplorer),
    vscode.commands.registerCommand('buildbar.pickTaskFromExplorer', cmdPickTaskFromExplorer),
    vscode.commands.registerCommand('buildbar.pickAndBuild', cmdPickAndBuild),
    vscode.commands.registerCommand(
      'buildbar.pickAndBuildFromExplorer',
      cmdPickAndBuildFromExplorer
    ),
    vscode.commands.registerCommand('buildbar.stop', cmdStop),
    vscode.commands.registerCommand('buildbar.clean', cmdClean),
    vscode.commands.registerCommand('buildbar.cleanBuild', cmdCleanBuild),
    vscode.commands.registerCommand('buildbar.refresh', cmdRefresh),

    // Derleme durumu: baslangic, surec bitisi (cikis kodu), gorev bitisi.
    vscode.tasks.onDidStartTask(onTaskStarted),
    vscode.tasks.onDidEndTaskProcess(onTaskProcessEnded),
    vscode.tasks.onDidEndTask(onTaskEnded),

    watcher.onDidChange(cmdRefresh),
    watcher.onDidCreate(cmdRefresh),
    watcher.onDidDelete(cmdRefresh),
    settingsWatcher.onDidChange(cmdRefresh),
    settingsWatcher.onDidCreate(cmdRefresh),
    settingsWatcher.onDidDelete(cmdRefresh),

    // Gorevi olmayan klasor de dahil her durumda aktif sekmeye gore
    // guncellenir; boylece onceki projenin butonlari ekranda kalmaz.
    vscode.window.onDidChangeActiveTextEditor(() => syncFromActiveTab()),

    // Metin editoru olmayan sekmeler (markdown preview, resim, notebook)
    // onDidChangeActiveTextEditor'i tetiklemiyor, sekme olaylari gerekiyor.
    ...(vscode.window.tabGroups
      ? [
          vscode.window.tabGroups.onDidChangeTabGroups(() => syncFromActiveTab()),
          vscode.window.tabGroups.onDidChangeTabs(() => syncFromActiveTab())
        ]
      : []),

    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      projectNodes.clear();
      optionNodes.clear();
      resetProjects(); // workspace disinda kalan aktif proje temizlenir
      if (!active) active = pickInitial();
      render();
      reloadRealTasks().then(render);
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('buildbar')) cmdRefresh();
    })
  );

  setActive(pickInitial());
  reloadRealTasks().then(render);
}

function deactivate() {}

module.exports = { activate, deactivate };
