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
 * VS Code'un cozdugu gercek gorevler. folderUri -> Map<gorev adi, vscode.Task>
 * Derleme bunlarin uzerinden kosar; boylece dependsOn, satir ici
 * problemMatcher ve ${...} degiskenleri kaybolmaz.
 */
const realTasks = new Map();

const treeChanged = new vscode.EventEmitter();

/**
 * @typedef {{ kind: 'project', folder: vscode.WorkspaceFolder }
 *         | {kind: 'option', folder: vscode.WorkspaceFolder, opt: BuildOption}} Node
 * @typedef {{ kind: 'task' | 'launch', name: string, detail?: string,
 *             isDefault?: boolean, entry?: object, cmake?: boolean,
 *             configure?: boolean }} BuildOption
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
  problemMatchers: ['$gcc']
};

/**
 * @param {vscode.WorkspaceFolder | undefined} folder
 * @param {keyof DEFAULTS} key
 */
function pref(folder, key) {
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

/** tasks.json icindeki gorevler. */
function taskOptions(folder) {
  const file = readJsonc(path.join(folder.uri.fsPath, pref(folder, 'tasksFile')));
  const entries = file && Array.isArray(file.tasks) ? file.tasks : [];
  const onlyBuild = pref(folder, 'onlyBuildGroup');

  const list = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;

    const name =
      typeof entry.label === 'string'
        ? entry.label
        : typeof entry.taskName === 'string'
          ? entry.taskName
          : undefined;
    if (!name) continue;
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

  return list;
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
    list[0]
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
 * @param {vscode.WorkspaceFolder} folder
 * @param {BuildOption} opt
 */
function executionFor(folder, opt) {
  const cwd = folder.uri.fsPath;

  // CMakePresets'ten gelen secenek: komutu biz uretiyoruz.
  if (opt.cmake) {
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
  if ([command, dir, ...args].some(unresolved)) return undefined;

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

  const task = new vscode.Task(
    { type: 'buildbar', task: opt.name, project: folder.name },
    folder,
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
  task.group = vscode.TaskGroup.Build;
  return task;
}

/**
 * @param {vscode.WorkspaceFolder} folder
 * @param {BuildOption} opt
 */
async function runOption(folder, opt) {
  // Hata ayiklama yapilandirmasi: derleme yok, oturum baslatilir. Ad klasor
  // kapsaminda cozuldugu icin dogru projenin launch.json'i kullanilir.
  if (isLaunch(opt)) {
    const started = await vscode.debug.startDebugging(folder, opt.name);
    if (!started) {
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
  if (real) return void (await vscode.tasks.executeTask(real));

  // 2) Cozulmus hali yoksa (CMake preset, henuz taranmamis dosya...)
  //    gorevi kendimiz kurariz.
  const task = synthesize(folder, opt);
  if (task) return void (await vscode.tasks.executeTask(task));

  // 3) Icinde ${input:...} gibi yalnizca VS Code'un cozebilecegi degisken
  //    var; gorev sistemine devret.
  await vscode.commands.executeCommand('workbench.action.tasks.runTask', opt.name);
}

// ------------------------------------------------------------------- agac

const projectNode = (folder) => {
  const key = folder.uri.toString();
  if (!projectNodes.has(key)) projectNodes.set(key, { kind: 'project', folder });
  return projectNodes.get(key);
};

const optionNode = (folder, opt) => {
  const key = `${folder.uri.toString()}::${opt.name}`;
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
      return (vscode.workspace.workspaceFolders || []).map(projectNode);
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
      item.description = isActive(node.folder)
        ? '(aktif)'
        : list.length
          ? undefined
          : 'secenek yok';
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

    const item = new vscode.TreeItem(node.opt.name, vscode.TreeItemCollapsibleState.None);
    item.id = `o:${node.folder.uri.toString()}::${optionKey(node.opt)}`;
    // Satir sonundaki eylem ikonu turune gore degisiyor (derle / hata ayikla).
    item.contextValue = launch ? 'buildbar.option.launch' : 'buildbar.option.task';
    item.iconPath = new vscode.ThemeIcon(
      selected ? 'circle-filled' : 'circle-outline',
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
const anyBuildable = () => (vscode.workspace.workspaceFolders || []).some(isBuildable);

function render() {
  const opt = active ? currentOption(active) : undefined;

  if (opt) {
    const list = optionsFor(active);
    const launch = isLaunch(opt);

    // Ikon ve komut secenegin turune gore: gorev derlenir, yapilandirma
    // hata ayiklama oturumu baslatir.
    bar.text = `${launch ? '$(debug-alt)' : '$(play)'} ${active.name}`;
    bar.command = launch ? 'buildbar.debugStart' : 'buildbar.build';
    bar.tooltip = new vscode.MarkdownString(
      `${launch ? '**Hata ayiklamayi baslat**' : '**Derle**'} \`${opt.name}\`` +
        `\n\nProje: ${active.name}`
    );
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

  vscode.commands.executeCommand('setContext', 'buildbar.hasProject', !!opt);
  // Ust sagdaki dugmenin ikonu bu anahtara gore degisiyor.
  vscode.commands.executeCommand('setContext', 'buildbar.isLaunch', isLaunch(opt));
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
 * Aktif editorun ait oldugu workspace klasoru.
 *
 *   WorkspaceFolder -> bu projeye gec
 *   null            -> workspace disi dosya, aktif projeyi temizle
 *   undefined       -> bilgi yok (ayarlar sekmesi, cikti paneli...), dokunma
 *
 * @param {vscode.TextEditor | undefined} editor
 */
function folderOfEditor(editor) {
  if (!editor || !editor.document) return undefined;
  const uri = editor.document.uri;
  if (uri.scheme && uri.scheme !== 'file') return undefined;
  return vscode.workspace.getWorkspaceFolder(uri) || null;
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
    folder = vscode.workspace.getWorkspaceFolder(uri) || null;
  }

  setActive(folder || undefined);
}

/** Ilk acilista makul bir baslangic projesi sec. */
function pickInitial() {
  const f = folderOfEditor(vscode.window.activeTextEditor);
  if (f) return f;

  const uri = uriOfActiveTab();
  const fromTab = uri && (!uri.scheme || uri.scheme === 'file')
    ? vscode.workspace.getWorkspaceFolder(uri)
    : undefined;
  if (fromTab) return fromTab;

  return (vscode.workspace.workspaceFolders || []).find(isBuildable);
}

/**
 * Explorer baglam menusunden gelen argumanlari projeye cevirir.
 * Ilk arguman tiklanan kaynak, ikincisi coklu secimin tamami.
 */
function folderFromArgs(uri, uris) {
  const target = Array.isArray(uris) && uris.length ? uris[0] : uri;
  if (!target) return undefined;
  return vscode.workspace.getWorkspaceFolder(target);
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
  await runOption(active, opt);
}

async function cmdBuildNode(node) {
  if (!node || node.kind !== 'option') return cmdBuild();
  remember(node.folder, node.opt);
  setActive(node.folder);
  await runOption(node.folder, node.opt);
}

async function cmdPickTask() {
  if (!active) return void vscode.window.showWarningMessage('BuildBar: aktif proje yok.');
  const list = optionsFor(active);
  if (!list.length) {
    return void vscode.window.showWarningMessage(
      `BuildBar: ${active.name} icin secenek bulunamadi (${sourceFiles(active)}).`
    );
  }

  const current = currentOption(active);

  // showQuickPick'in 'picked' alani yalnizca canPickMany ile calisiyor,
  // o yuzden secili olani etiketin icinde isaretliyoruz.
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

  const picked = await vscode.window.showQuickPick(items, {
    title: `${active.name} - ${sourceLabel(active)}`,
    placeHolder: current ? `su an secili: ${current.name}` : undefined,
    matchOnDescription: true
  });
  if (!picked) return;

  remember(active, picked.opt);
  render();
}

async function cmdPickProject() {
  const folders = (vscode.workspace.workspaceFolders || []).filter(isBuildable);
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

/** Explorer sag tik: aktif projeyi degistir ve secili gorevi derle. */
async function cmdBuildFromExplorer(uri, uris) {
  const folder = folderFromArgs(uri, uris);
  if (!folder) {
    return void vscode.window.showWarningMessage(
      'BuildBar: bu kaynak bir workspace klasorunun icinde degil.'
    );
  }
  setActive(folder, { reveal: true });

  const opt = currentOption(folder);
  if (!opt) {
    return void vscode.window.showWarningMessage(
      `BuildBar: ${folder.name} icinde ${sourceFiles(folder)} bulunamadi.`
    );
  }
  await runOption(folder, opt);
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

async function cmdRefresh() {
  optionsCache.clear();
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

  view = vscode.window.createTreeView('buildbar.projects', {
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

  ctx.subscriptions.push(
    bar,
    taskBar,
    view,
    watcher,
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
    vscode.commands.registerCommand('buildbar.refresh', cmdRefresh),

    watcher.onDidChange(cmdRefresh),
    watcher.onDidCreate(cmdRefresh),
    watcher.onDidDelete(cmdRefresh),

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
      optionsCache.clear();
      if (active && !vscode.workspace.getWorkspaceFolder(active.uri)) active = undefined;
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
