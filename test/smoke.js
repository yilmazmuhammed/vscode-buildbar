'use strict';

/**
 * BuildBar duman testi.
 *
 * VS Code olmadan calisir: 'vscode' modulunu require onbellegine sahte bir
 * nesneyle enjekte eder, sonra eklentiyi activate edip gorev kesfini,
 * aktif proje mantigini ve calistirilan gorevleri dogrular.
 *
 *   node test/smoke.js
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const Module = require('module');

// ------------------------------------------------------------ sahte vscode

const listeners = {};
const contexts = {};
const commands = {};
const statusItems = {};

/** Calistirilan gorevler ve gosterilen mesajlar. */
let executed = [];

/** showQuickPick'e verilen son liste ve secenekler. */
let lastPick;
/** showQuickPick'in ne dondurecegi: (items) => item */
let pickAnswer = () => undefined;

/** vscode.tasks.fetchTasks'in dondurdugu sahte gorevler. */
let fakeTasks = [];

/** true ise getConfiguration().get() her sey icin undefined doner:
 *  manifest katkisi yuklenmemis bir kurulumu taklit eder. */
let emptyConfig = false;

/** Testin ayar degerlerini gecici olarak ezmesi icin. */
const configOverrides = {};

/** vscode.debug.startDebugging cagrilari. */
let debugStarts = [];
/** startDebugging'in donecegi deger. */
let debugResult = true;

/** Aktif sekme (metin editoru olmayan sekmeleri taklit etmek icin). */
let activeTab;

class EventEmitter {
  constructor() {
    this.handlers = [];
    this.event = (h) => {
      this.handlers.push(h);
      return { dispose() {} };
    };
  }
  fire(v) {
    this.handlers.forEach((h) => h(v));
  }
  dispose() {}
}

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class ShellExecution {
  constructor(a, b, c) {
    this.commandLine = typeof a === 'string' && !Array.isArray(b) ? a : undefined;
    this.command = a;
    this.args = Array.isArray(b) ? b : [];
    this.options = Array.isArray(b) ? c : b;
  }
  /** Testte okunabilir tek satir. */
  render() {
    const name = typeof this.command === 'string' ? this.command : this.command.value;
    const args = this.args.map((a) => (typeof a === 'string' ? a : a.value));
    return [name, ...args].join(' ');
  }
}

class ProcessExecution {
  constructor(command, args, options) {
    Object.assign(this, { command, args: args || [], options });
  }
  render() {
    return [this.command, ...this.args].join(' ');
  }
}

class Task {
  constructor(definition, scope, name, source, execution, problemMatchers) {
    Object.assign(this, { definition, scope, name, source, execution, problemMatchers });
  }
}

const workspaceFolders = [];

const vscode = {
  EventEmitter,
  TreeItem,
  ShellExecution,
  ProcessExecution,
  Task,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ShellQuoting: { Escape: 1, Strong: 2, Weak: 3 },
  TaskRevealKind: { Always: 1, Silent: 2, Never: 3 },
  TaskPanelKind: { Shared: 1, Dedicated: 2, New: 3 },
  TaskScope: { Global: 1, Workspace: 2 },
  TaskGroup: { Build: 'build' },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ThemeIcon: class {
    constructor(id, color) {
      this.id = id;
      this.color = color;
    }
  },
  ThemeColor: class {
    constructor(id) {
      this.id = id;
    }
  },
  MarkdownString: class {
    constructor(v) {
      this.value = v;
    }
  },
  Uri: {
    file: (p) => ({
      scheme: 'file',
      fsPath: p,
      toString: () => `file://${p.split(path.sep).join('/')}`
    })
  },

  workspace: {
    workspaceFolders,
    getConfiguration: (section) => ({
      get: (key) => {
        if (emptyConfig) return undefined;
        if (key in configOverrides) return configOverrides[key];
        const defaults = {
          followActiveEditor: true,
          source: 'tasks',
          tasksFile: '.vscode/tasks.json',
          launchFile: '.vscode/launch.json',
          onlyBuildGroup: false,
          cmakeFallback: true,
          problemMatchers: ['$gcc']
        };
        return section === 'buildbar' ? defaults[key] : undefined;
      }
    }),
    getWorkspaceFolder: (uri) =>
      workspaceFolders.find(
        (f) => String(uri.fsPath) === f.uri.fsPath || String(uri.fsPath).startsWith(f.uri.fsPath + path.sep)
      ),
    createFileSystemWatcher: () => ({
      onDidChange: () => ({ dispose() {} }),
      onDidCreate: () => ({ dispose() {} }),
      onDidDelete: () => ({ dispose() {} }),
      dispose() {}
    }),
    onDidChangeWorkspaceFolders: (h) => ((listeners.folders = h), { dispose() {} }),
    onDidChangeConfiguration: (h) => ((listeners.config = h), { dispose() {} })
  },

  window: {
    activeTextEditor: undefined,
    createStatusBarItem: (id) => {
      const item = {
        id,
        visible: false,
        show() {
          this.visible = true;
        },
        hide() {
          this.visible = false;
        },
        dispose() {}
      };
      statusItems[id] = item;
      return item;
    },
    createTreeView: (id, opts) => ({
      id,
      visible: true,
      provider: opts.treeDataProvider,
      onDidChangeSelection: (h) => ((listeners.selection = h), { dispose() {} }),
      reveal: () => Promise.resolve(),
      dispose() {}
    }),
    onDidChangeActiveTextEditor: (h) => ((listeners.editor = h), { dispose() {} }),
    tabGroups: {
      get activeTabGroup() {
        return { activeTab };
      },
      onDidChangeTabGroups: (h) => ((listeners.tabGroups = h), { dispose() {} }),
      onDidChangeTabs: (h) => ((listeners.tabs = h), { dispose() {} })
    },
    showQuickPick: (items, opts) => {
      lastPick = { items, opts };
      return Promise.resolve(pickAnswer(items));
    },
    showWarningMessage: (m) => (executed.push({ kind: 'warn', message: m }), Promise.resolve()),
    showInformationMessage: (m) => (executed.push({ kind: 'info', message: m }), Promise.resolve())
  },

  commands: {
    registerCommand: (id, fn) => ((commands[id] = fn), { dispose() {} }),
    executeCommand: (id, ...args) => {
      if (id === 'setContext') contexts[args[0]] = args[1];
      else executed.push({ kind: 'command', id, args });
      return Promise.resolve();
    }
  },

  debug: {
    startDebugging: (folder, nameOrConfig) => {
      debugStarts.push({ folder, name: nameOrConfig });
      return Promise.resolve(debugResult);
    }
  },

  tasks: {
    fetchTasks: () => Promise.resolve(fakeTasks),
    executeTask: (task) => {
      executed.push({
        kind: 'task',
        task,
        name: task.name,
        line: task.execution && task.execution.render ? task.execution.render() : '(cozulmus gorev)',
        matchers: task.problemMatchers
      });
      return Promise.resolve({ task });
    }
  }
};

// 'vscode' require'ini sahte nesneye yonlendir
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return 'vscode';
  return originalResolve.call(this, request, ...rest);
};
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscode };

// --------------------------------------------------------------- kurulum

const wsRoot = path.resolve(__dirname, '../../ornek-workspace');

/**
 * Yalnizca VS Code'un cozebilecegi ${input:...} degiskeni iceren gecici bir
 * proje. Sentezleme burada devre disi kalmali, is gorev sistemine gitmeli.
 */
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'buildbar-smoke-'));
fs.mkdirSync(path.join(tempRoot, '.vscode'), { recursive: true });
fs.writeFileSync(
  path.join(tempRoot, '.vscode/tasks.json'),
  JSON.stringify({
    version: '2.0.0',
    tasks: [
      {
        label: 'sorulu-derleme',
        type: 'shell',
        command: './build.sh',
        args: ['--config', '${input:config}']
      }
    ]
  })
);

[
  ['proje-a (script)', path.join(wsRoot, 'proje-a')],
  ['proje-b (cmake)', path.join(wsRoot, 'proje-b')],
  ['proje-c (make)', path.join(wsRoot, 'proje-c')],
  ['dokuman', path.join(wsRoot, 'dokuman')],
  ['proje-d (input)', tempRoot]
].forEach(([name, dir], index) => {
  workspaceFolders.push({ name, index, uri: vscode.Uri.file(dir) });
});

const folderNamed = (name) => workspaceFolders.find((f) => f.name.startsWith(name));

const ext = require('../extension.js');
const subscriptions = [];

/** Sahte workspaceState: secimin kalici olup olmadigini gormek icin. */
const memory = {};
ext.activate({
  subscriptions,
  workspaceState: {
    get: (key) => memory[key],
    update: (key, value) => {
      memory[key] = value;
      return Promise.resolve();
    }
  }
});

const tree = subscriptions.find((s) => s && s.id === 'buildbar.projects');
const provider = tree.provider;

const projectNodes = () => provider.getChildren();
const nodesOf = (name) =>
  provider.getChildren(projectNodes().find((n) => n.folder.name.startsWith(name)));
const namesOf = (name) => nodesOf(name).map((n) => n.opt.name);

// ----------------------------------------------------------------- testler

let passed = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  ok    ${label}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${label}`);
    console.log(`        ${String(err.message).split('\n')[0]}`);
    process.exitCode = 1;
  }
}

async function checkAsync(label, fn) {
  try {
    await fn();
    console.log(`  ok    ${label}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${label}`);
    console.log(`        ${String(err.message).split('\n')[0]}`);
    process.exitCode = 1;
  }
}

/** Aktif projeyi Explorer sag tik yolundan degistirir. */
const setActiveFolder = (dir) =>
  commands['buildbar.setActiveFromExplorer'](vscode.Uri.file(dir));

/** Metin editorunde bir dosya acar. */
const openEditor = (file) => {
  vscode.window.activeTextEditor = { document: { uri: vscode.Uri.file(file) } };
  activeTab = { input: { uri: vscode.Uri.file(file) } };
  listeners.editor(vscode.window.activeTextEditor);
};

/** Metin editoru olmayan bir sekmeye gecer (preview, resim, notebook...). */
const openTab = (input) => {
  vscode.window.activeTextEditor = undefined;
  activeTab = { input };
  listeners.tabs({});
};

const treeItem = (node) => provider.getTreeItem(node);

(async () => {
  console.log('\nBuildBar duman testi\n');

  // fetchTasks: yalnizca proje-a icin bir gorev cozulmus olsun.
  const realHostRelease = {
    name: 'host-release',
    source: 'Workspace',
    scope: folderNamed('proje-a'),
    definition: { type: 'shell' }
  };
  fakeTasks = [realHostRelease];
  await commands['buildbar.refresh']();

  console.log('gorev kesfi (tasks.json)');

  check('proje-a: 5 gorev, yorum satirlarina ragmen okunuyor', () => {
    assert.deepStrictEqual(namesOf('proje-a'), [
      'host-debug',
      'host-release',
      'arm-debug',
      'arm-release',
      'temizle'
    ]);
  });

  check('proje-c: 4 gorev, son virgule ragmen okunuyor (JSONC)', () => {
    assert.deepStrictEqual(namesOf('proje-c'), ['host-O0', 'host-O2', 'arm-Os', 'temizle']);
  });

  check('proje-b: tasks.json yok -> CMakePresets fallback, hidden haric', () => {
    assert.deepStrictEqual(namesOf('proje-b'), ['host-debug', 'host-release', 'arm-release']);
  });

  check('proje-b: build.sh yok (cmake projesinde sarmalayici script olmaz)', () => {
    assert.ok(!fs.existsSync(path.join(wsRoot, 'proje-b/build.sh')));
  });

  check('dokuman: hicbir gorev kaynagi yok', () => {
    assert.deepStrictEqual(namesOf('dokuman'), []);
    const item = treeItem(projectNodes().find((n) => n.folder.name === 'dokuman'));
    assert.strictEqual(item.description, 'secenek yok');
  });

  check('eski build-configs.json artik hicbir projede yok', () => {
    for (const dir of ['proje-a', 'proje-b', 'proje-c']) {
      assert.ok(!fs.existsSync(path.join(wsRoot, dir, '.vscode/build-configs.json')), dir);
    }
  });

  console.log('\nkomut kaydi');
  [
    'buildbar.build',
    'buildbar.debugStart',
    'buildbar.buildNode',
    'buildbar.debugNode',
    'buildbar.pickTask',
    'buildbar.pickProject',
    'buildbar.setActiveFromExplorer',
    'buildbar.buildFromExplorer',
    'buildbar.pickTaskFromExplorer',
    'buildbar.refresh'
  ].forEach((id) => {
    check(`${id} kayitli`, () => assert.ok(typeof commands[id] === 'function'));
  });

  console.log('\naktif proje, baglam ve butonlar');

  check('acilista ilk derlenebilir proje aktif', () => {
    assert.strictEqual(contexts['buildbar.hasProject'], true);
    assert.ok(statusItems['buildbar.build'].text.includes('proje-a'));
  });

  check('varsayilan secim tasks.json isDefault gorevi', () => {
    assert.strictEqual(statusItems['buildbar.task'].text, '$(list-selection) host-debug');
    assert.strictEqual(contexts['buildbar.isLaunch'], false);
    assert.strictEqual(statusItems['buildbar.build'].text, '$(play) proje-a (script)');
  });

  check('dokuman icindeki dosya acilinca butonlar kaybolur', () => {
    openEditor(path.join(wsRoot, 'dokuman/README.md'));
    assert.strictEqual(contexts['buildbar.hasProject'], false);
    assert.strictEqual(statusItems['buildbar.task'].visible, false);
    assert.match(statusItems['buildbar.build'].text, /dokuman: secenek yok/);
  });

  check('proje-b icindeki dosya acilinca aktif proje proje-b olur', () => {
    openEditor(path.join(wsRoot, 'proje-b/src/main.c'));
    assert.strictEqual(contexts['buildbar.hasProject'], true);
    assert.ok(statusItems['buildbar.build'].text.includes('proje-b'));
    assert.strictEqual(statusItems['buildbar.task'].text, '$(list-selection) host-debug');
  });

  check('workspace disi dosya acilinca butonlar kaybolur', () => {
    openEditor(path.join(os.tmpdir(), 'workspace-disi.c'));
    assert.strictEqual(contexts['buildbar.hasProject'], false);
    assert.match(statusItems['buildbar.build'].text, /proje sec/);
  });

  check('URI tasimayan sekme (ayarlar, webview) durumu bozmaz', () => {
    setActiveFolder(path.join(wsRoot, 'proje-a'));
    vscode.window.activeTextEditor = {
      document: { uri: { scheme: 'vscode-settings', fsPath: '' } }
    };
    activeTab = { input: { viewType: 'mainThreadWebview-markdown.preview' } };
    listeners.editor(vscode.window.activeTextEditor);

    assert.strictEqual(contexts['buildbar.hasProject'], true);
    assert.ok(statusItems['buildbar.build'].text.includes('proje-a'));
  });

  check('metin editoru olmayan sekmede de butonlar guncellenir', () => {
    setActiveFolder(path.join(wsRoot, 'proje-a'));
    openTab({ uri: vscode.Uri.file(path.join(wsRoot, 'dokuman/README.md')) });

    assert.strictEqual(contexts['buildbar.hasProject'], false);
    assert.match(statusItems['buildbar.build'].text, /dokuman: secenek yok/);
  });

  check('fark gorunumu degistirilen dosyaya gore takip edilir', () => {
    setActiveFolder(path.join(wsRoot, 'dokuman'));
    openTab({ modified: vscode.Uri.file(path.join(wsRoot, 'proje-c/src/main.c')) });

    assert.ok(statusItems['buildbar.build'].text.includes('proje-c'));
  });

  check('Explorer coklu secimde ilk kaynak kullanilir', () => {
    commands['buildbar.setActiveFromExplorer'](vscode.Uri.file(path.join(wsRoot, 'dokuman')), [
      vscode.Uri.file(path.join(wsRoot, 'proje-c')),
      vscode.Uri.file(path.join(wsRoot, 'dokuman'))
    ]);
    assert.ok(statusItems['buildbar.build'].text.includes('proje-c'));
  });

  console.log('\nlaunch.json kaynagi');

  await checkAsync('source=launch: liste launch.json yapilandirmalarindan gelir', async () => {
    configOverrides.source = 'launch';
    await commands['buildbar.refresh']();

    assert.deepStrictEqual(namesOf('proje-a'), [
      'host-debug calistir',
      'host-release calistir',
      'ikisi birden'
    ]);
    // Yorum satirli launch.json okunabildi, compound da listeye girdi.
    const nodes = nodesOf('proje-a');
    assert.match(nodes[0].opt.detail, /cppdbg \/ launch \/ once: host-debug/);
    assert.match(nodes[2].opt.detail, /compound \/ 2 yapilandirma/);
  });

  await checkAsync('source=launch: dugme derlemez, hata ayiklama baslatir', async () => {
    executed = [];
    debugStarts = [];
    setActiveFolder(path.join(wsRoot, 'proje-a'));

    assert.strictEqual(contexts['buildbar.isLaunch'], true);
    assert.strictEqual(statusItems['buildbar.build'].text, '$(debug-alt) proje-a (script)');
    assert.strictEqual(statusItems['buildbar.build'].command, 'buildbar.debugStart');

    await commands['buildbar.build']();

    assert.ok(!executed.some((e) => e.kind === 'task'), 'gorev kosmus');
    assert.strictEqual(debugStarts.length, 1);
    assert.strictEqual(debugStarts[0].name, 'host-debug calistir');
    assert.strictEqual(debugStarts[0].folder.name, 'proje-a (script)');
  });

  await checkAsync('source=launch: oturum baslamazsa uyari verilir', async () => {
    executed = [];
    debugResult = false;
    try {
      await commands['buildbar.build']();
      assert.ok(executed.some((e) => e.kind === 'warn' && /baslatilamadi/.test(e.message)));
    } finally {
      debugResult = true;
    }
  });

  await checkAsync('source=launch: gorev dosyasi olan proje-c bos kalir', async () => {
    assert.deepStrictEqual(namesOf('proje-c'), []);
    setActiveFolder(path.join(wsRoot, 'proje-c'));
    assert.strictEqual(contexts['buildbar.hasProject'], false);
    assert.match(statusItems['buildbar.build'].text, /secenek yok/);
  });

  await checkAsync('source=both: gorevler ve yapilandirmalar bir arada', async () => {
    configOverrides.source = 'both';
    await commands['buildbar.refresh']();

    assert.deepStrictEqual(namesOf('proje-a'), [
      'host-debug',
      'host-release',
      'arm-debug',
      'arm-release',
      'temizle',
      'host-debug calistir',
      'host-release calistir',
      'ikisi birden'
    ]);
    // Agac dugum kimlikleri tur ile nitelenmis olmali (ad cakismasi olabilir).
    const nodes = nodesOf('proje-a');
    const item = treeItem(nodes[5]);
    assert.match(item.id, /::launch:host-debug calistir$/);
    assert.strictEqual(item.contextValue, 'buildbar.option.launch');
    assert.strictEqual(treeItem(nodes[0]).contextValue, 'buildbar.option.task');
  });

  await checkAsync('source=both: gorev derler, yapilandirma baslatir', async () => {
    executed = [];
    debugStarts = [];
    const nodes = nodesOf('proje-a');

    await commands['buildbar.buildNode'](nodes[4]); // temizle (gorev)
    assert.ok(executed.some((e) => e.kind === 'task'));
    assert.strictEqual(debugStarts.length, 0);

    executed = [];
    await commands['buildbar.debugNode'](nodes[7]); // ikisi birden (compound)
    assert.ok(!executed.some((e) => e.kind === 'task'));
    assert.strictEqual(debugStarts[0].name, 'ikisi birden');
  });

  await checkAsync('secim tur ile birlikte hatirlanir', async () => {
    const saved = memory['buildbar.chosenTasks'];
    assert.strictEqual(saved[folderNamed('proje-a').uri.toString()], 'launch:ikisi birden');

    // Ayar tasks'a donunce launch secimi listede yok; varsayilana dusulur.
    delete configOverrides.source;
    await commands['buildbar.refresh']();
    setActiveFolder(path.join(wsRoot, 'proje-a'));
    assert.strictEqual(statusItems['buildbar.task'].text, '$(list-selection) host-debug');
    assert.strictEqual(contexts['buildbar.isLaunch'], false);
  });

  console.log('\ngorev secimi');

  await checkAsync('pickTask listesi secili olani isaretler', async () => {
    setActiveFolder(path.join(wsRoot, 'proje-a'));
    pickAnswer = () => undefined; // kullanici vazgecti
    await commands['buildbar.pickTask']();

    assert.match(lastPick.opts.title, /proje-a/);
    assert.match(lastPick.opts.placeHolder, /host-debug/);
    assert.strictEqual(lastPick.items[0].label, '$(check) host-debug');
    assert.strictEqual(lastPick.items[1].label, '$(blank) host-release');
    assert.match(lastPick.items[0].description, /secili/);
  });

  await checkAsync('pickTask secimi status bar ve agaci gunceller', async () => {
    pickAnswer = (items) => items.find((i) => i.opt.name === 'arm-release');
    await commands['buildbar.pickTask']();

    assert.strictEqual(statusItems['buildbar.task'].text, '$(list-selection) arm-release');
    const item = treeItem(nodesOf('proje-a').find((n) => n.opt.name === 'arm-release'));
    assert.match(item.description, /\(secili\)/);
    assert.strictEqual(item.iconPath.id, 'circle-filled');
  });

  check('secim workspaceState icine yazilir (pencere yeniden yuklenince kalir)', () => {
    const saved = memory['buildbar.chosenTasks'];
    assert.ok(saved, 'hicbir sey kaydedilmemis');
    assert.strictEqual(saved[folderNamed('proje-a').uri.toString()], 'task:arm-release');
  });

  console.log('\ncalistirilan gorevler');

  await checkAsync('proje-a: VS Code cozdugu gorev varsa o kosar', async () => {
    executed = [];
    const node = nodesOf('proje-a').find((n) => n.opt.name === 'host-release');
    await commands['buildbar.buildNode'](node);

    const run = executed.find((e) => e.kind === 'task');
    assert.ok(run, 'gorev calistirilmadi');
    assert.strictEqual(run.task, realHostRelease, 'sentezlenen gorev kosmus');
  });

  await checkAsync('proje-a temizle: cozulmus gorev yok -> sentezlenir', async () => {
    executed = [];
    const node = nodesOf('proje-a').find((n) => n.opt.name === 'temizle');
    await commands['buildbar.buildNode'](node);

    const run = executed.find((e) => e.kind === 'task');
    assert.match(run.line, /build\.sh --clean/);
    // tasks.json'da "problemMatcher": [] yaziyor; ayardaki $gcc'ye dusmemeli.
    assert.deepStrictEqual(run.matchers, []);
  });

  await checkAsync('proje-c: make komutu argumanlariyla sentezlenir', async () => {
    executed = [];
    setActiveFolder(path.join(wsRoot, 'proje-c'));
    await commands['buildbar.build']();

    const run = executed.find((e) => e.kind === 'task');
    assert.match(run.line, /make ARCH=host OPT=O0/);
    assert.deepStrictEqual(run.matchers, ['$gcc']);
  });

  await checkAsync('proje-b: cmake configure + build zincirlenir', async () => {
    executed = [];
    setActiveFolder(path.join(wsRoot, 'proje-b'));
    await commands['buildbar.build']();

    const run = executed.find((e) => e.kind === 'task');
    assert.match(run.line, /cmake --preset host-debug && cmake --build --preset host-debug/);
  });

  await checkAsync('Explorer sag tik "Derle" dogru projeyi derler', async () => {
    executed = [];
    await commands['buildbar.buildFromExplorer'](vscode.Uri.file(path.join(wsRoot, 'proje-c/src')));

    const run = executed.find((e) => e.kind === 'task');
    assert.match(run.line, /make ARCH=host OPT=O0/);
    assert.ok(statusItems['buildbar.build'].text.includes('proje-c'));
  });

  await checkAsync('${input:...} iceren gorev VS Code gorev sistemine devredilir', async () => {
    executed = [];
    setActiveFolder(tempRoot);
    await commands['buildbar.build']();

    assert.ok(!executed.some((e) => e.kind === 'task'), 'yarim komut sentezlenmis');
    const cmd = executed.find((e) => e.kind === 'command');
    assert.strictEqual(cmd.id, 'workbench.action.tasks.runTask');
    assert.strictEqual(cmd.args[0], 'sorulu-derleme');
  });

  await checkAsync('gorevi olmayan projede derleme uyari verir', async () => {
    executed = [];
    setActiveFolder(path.join(wsRoot, 'dokuman'));
    await commands['buildbar.build']();

    assert.ok(!executed.some((e) => e.kind === 'task'));
    assert.ok(executed.some((e) => e.kind === 'warn'));
  });

  await checkAsync('ayar varsayilanlari gelmese de calisir (bozuk kurulum)', async () => {
    emptyConfig = true;
    try {
      // Eskiden burada "path argument must be of type string" hatasi vardi.
      await commands['buildbar.refresh']();
      assert.deepStrictEqual(namesOf('proje-c'), ['host-O0', 'host-O2', 'arm-Os', 'temizle']);

      // followActiveEditor de undefined donuyor; takip yine calismali.
      openEditor(path.join(wsRoot, 'dokuman/README.md'));
      assert.strictEqual(contexts['buildbar.hasProject'], false);
    } finally {
      emptyConfig = false;
      await commands['buildbar.refresh']();
    }
  });

  fs.rmSync(tempRoot, { recursive: true, force: true });

  console.log(`\n${passed} kontrol gecti${process.exitCode ? ', HATALAR VAR' : ''}\n`);
})();
