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

/** setStatusBarMessage ile gosterilen gecici mesajlar. */
let statusMessages = [];

/** showWarningMessage'in hangi dugmeyi dondurecegi: (mesaj, dugmeler) => dugme */
let warnAnswer = () => undefined;

/**
 * Tanimliysa executeTask her gorevi bir sonraki turda baslatip bitirir;
 * donen deger cikis kodudur. Tanimsizsa gorevler kendiliginden bitmez,
 * test baslat/bitir olaylarini elle atar.
 */
let autoEnd;

/** Gorevlerin calisma ve bitis sirasi: ['run:x', 'end:x', ...] */
let taskLog = [];

/** languages.getDiagnostics'in dondurecegi [uri, diagnostics[]] listesi. */
let fakeDiagnostics = [];

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

/** Gorev olaylarini eklentiye ileten yardimcilar. */
const fireStart = (execution) => listeners.taskStart({ execution });
const fireEnd = (execution, exitCode) => {
  if (exitCode !== undefined) listeners.taskProcessEnd({ execution, exitCode });
  listeners.taskEnd({ execution });
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** vscode.TaskExecution: terminate() gercekte oldugu gibi gorevi bitirir. */
class TaskExecution {
  constructor(task) {
    this.task = task;
    this.terminated = false;
  }
  terminate() {
    this.terminated = true;
    setImmediate(() => fireEnd(this, 130));
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
  TaskGroup: { Build: 'build', Clean: 'clean' },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
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
          problemMatchers: ['$gcc'],
          cleanTask: '',
          nestedProjectDepth: 2
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
    /**
     * pickAnswer(items) ne donerse kullanici onu yapmis sayilir:
     *   item            -> Enter
     *   undefined       -> vazgecme (Esc)
     */
    createQuickPick: () => {
      const handlers = { accept: [], button: [], hide: [] };
      const qp = {
        items: [],
        activeItems: [],
        selectedItems: [],
        hidden: false,
        onDidAccept: (h) => (handlers.accept.push(h), { dispose() {} }),
        onDidTriggerItemButton: (h) => (handlers.button.push(h), { dispose() {} }),
        onDidHide: (h) => (handlers.hide.push(h), { dispose() {} }),
        show() {
          lastPick = { items: qp.items, opts: { title: qp.title, placeHolder: qp.placeholder } };
          const answer = pickAnswer(qp.items);
          Promise.resolve().then(() => {
            if (answer) {
              qp.selectedItems = [answer];
              handlers.accept.forEach((h) => h());
            } else {
              qp.hide();
            }
          });
        },
        hide() {
          if (qp.hidden) return;
          qp.hidden = true;
          handlers.hide.forEach((h) => h());
        },
        dispose() {}
      };
      return qp;
    },
    setStatusBarMessage: (text) => (statusMessages.push(text), { dispose() {} }),
    showWarningMessage: (m, ...items) => (
      executed.push({ kind: 'warn', message: m }), Promise.resolve(warnAnswer(m, items))
    ),
    showInformationMessage: (m) => (executed.push({ kind: 'info', message: m }), Promise.resolve())
  },

  languages: {
    getDiagnostics: () => fakeDiagnostics
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
      const execution = new TaskExecution(task);
      executed.push({
        kind: 'task',
        task,
        execution,
        name: task.name,
        line: task.execution && task.execution.render ? task.execution.render() : '(cozulmus gorev)',
        matchers: task.problemMatchers
      });
      taskLog.push(`run:${task.name}`);
      if (autoEnd) {
        const exitCode = autoEnd(task);
        setImmediate(() => {
          fireStart(execution);
          taskLog.push(`end:${task.name}`);
          fireEnd(execution, exitCode);
        });
      }
      return Promise.resolve(execution);
    },
    onDidStartTask: (h) => ((listeners.taskStart = h), { dispose() {} }),
    onDidEndTaskProcess: (h) => ((listeners.taskProcessEnd = h), { dispose() {} }),
    onDidEndTask: (h) => ((listeners.taskEnd = h), { dispose() {} })
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

const wsRoot = path.resolve(__dirname, '../ornek-workspace');

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

  check('proje-a: 5 gorev, yorum satirlarina ragmen okunuyor, alfabetik', () => {
    assert.deepStrictEqual(namesOf('proje-a'), [
      'arm-debug',
      'arm-release',
      'host-debug',
      'host-release',
      'temizle'
    ]);
  });

  check('proje-c: 4 gorev, son virgule ragmen okunuyor (JSONC)', () => {
    assert.deepStrictEqual(namesOf('proje-c'), ['arm-Os', 'host-O0', 'host-O2', 'temizle']);
  });

  check('proje-b: tasks.json yok -> CMakePresets fallback, hidden haric', () => {
    assert.deepStrictEqual(namesOf('proje-b'), ['arm-release', 'host-debug', 'host-release']);
  });

  check('proje-b: varsayilan yoksa dosyadaki ilk preset secili (alfabetik ilk degil)', () => {
    // Aktif projeyi degistirmeden: agacta secili isareti.
    const selected = nodesOf('proje-b').filter((n) =>
      /\(secili\)/.test(treeItem(n).description || '')
    );
    assert.deepStrictEqual(
      selected.map((n) => n.opt.name),
      ['host-debug']
    );
  });

  await checkAsync('siralama sayilari sayi gibi, harfleri buyuk/kucuk ayirmadan karsilastirir', async () => {
    const tasksFile = path.join(tempRoot, '.vscode/tasks.json');
    const saved = fs.readFileSync(tasksFile, 'utf8');
    const task = (label) => ({ label, type: 'shell', command: 'true' });
    fs.writeFileSync(
      tasksFile,
      JSON.stringify({
        version: '2.0.0',
        tasks: [task('debug-10'), task('Release'), task('debug-2'), task('alpha')]
      })
    );
    try {
      await commands['buildbar.refresh']();
      assert.deepStrictEqual(namesOf('proje-d'), ['alpha', 'debug-2', 'debug-10', 'Release']);
    } finally {
      fs.writeFileSync(tasksFile, saved);
      await commands['buildbar.refresh']();
    }
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
    'buildbar.pickAndBuild',
    'buildbar.pickAndBuildFromExplorer',
    'buildbar.stop',
    'buildbar.clean',
    'buildbar.cleanBuild',
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

    // Gorevler once, yapilandirmalar sonra; her grup kendi icinde alfabetik.
    assert.deepStrictEqual(namesOf('proje-a'), [
      'arm-debug',
      'arm-release',
      'host-debug',
      'host-release',
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

  await checkAsync('source=both: ayni adli gorev ve yapilandirma ayri dugumler', async () => {
    // proje-d'deki gorevle ayni adi tasiyan bir launch yapilandirmasi.
    const launchFile = path.join(tempRoot, '.vscode/launch.json');
    fs.writeFileSync(
      launchFile,
      JSON.stringify({
        version: '0.2.0',
        configurations: [{ name: 'sorulu-derleme', type: 'cppdbg', request: 'launch' }]
      })
    );
    configOverrides.source = 'both';
    try {
      await commands['buildbar.refresh']();
      const nodes = nodesOf('proje-d');
      assert.strictEqual(nodes.length, 2);
      assert.notStrictEqual(nodes[0], nodes[1], 'iki secenek ayni dugum nesnesine dusmus');
      assert.deepStrictEqual(
        nodes.map((n) => n.opt.kind),
        ['task', 'launch']
      );
      const ids = nodes.map((n) => treeItem(n).id);
      assert.notStrictEqual(ids[0], ids[1], 'agac kimlikleri cakisiyor');
    } finally {
      fs.rmSync(launchFile, { force: true });
      delete configOverrides.source;
      await commands['buildbar.refresh']();
    }
  });

  console.log('\ngorev secimi');

  await checkAsync('pickTask listesi secili olani isaretler', async () => {
    setActiveFolder(path.join(wsRoot, 'proje-a'));
    pickAnswer = () => undefined; // kullanici vazgecti
    await commands['buildbar.pickTask']();

    assert.match(lastPick.opts.title, /proje-a/);
    assert.match(lastPick.opts.placeHolder, /host-debug/);
    assert.strictEqual(lastPick.items[0].label, '$(blank) arm-debug');
    assert.strictEqual(lastPick.items[2].label, '$(check) host-debug');
    assert.match(lastPick.items[2].description, /secili/);
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

  console.log('\nderleme durumu ve durdur');

  const projectItem = (name) => treeItem(projectNodes().find((n) => n.folder.name.startsWith(name)));
  /** proje-c'yi derletir ve kosuyu "basladi" yapar. */
  const startBuild = async () => {
    executed = [];
    await commands['buildbar.build']();
    const run = executed.find((e) => e.kind === 'task');
    fireStart(run.execution);
    return run;
  };

  let running;

  await checkAsync('derleme baslayinca ikon doner, durdur dugmesi cikar', async () => {
    setActiveFolder(path.join(wsRoot, 'proje-c'));
    assert.strictEqual(contexts['buildbar.isRunning'], false);
    assert.strictEqual(statusItems['buildbar.stop'].visible, false);

    running = await startBuild();
    assert.strictEqual(contexts['buildbar.isRunning'], true);
    assert.match(statusItems['buildbar.build'].text, /^\$\(sync~spin\) proje-c/);
    assert.strictEqual(statusItems['buildbar.stop'].visible, true);
    assert.strictEqual(statusItems['buildbar.stop'].command, 'buildbar.stop');
    assert.match(projectItem('proje-c').description, /\(derleniyor\)/);
    const node = nodesOf('proje-c').find((n) => n.opt.name === 'host-O0');
    assert.strictEqual(treeItem(node).iconPath.id, 'sync~spin');
  });

  await checkAsync('derleme surerken derle ikinci gorevi baslatmaz, ne yapilacagini sorar', async () => {
    executed = [];
    await commands['buildbar.build']();
    assert.ok(!executed.some((e) => e.kind === 'task'), 'ikinci gorev baslamis');
    assert.ok(executed.some((e) => e.kind === 'warn' && /host-O0 derleniyor/.test(e.message)));
    assert.strictEqual(running.execution.terminated, false, 'soru cevapsizken durdurulmus');
  });

  await checkAsync('cikis kodu 2: kirmizi arka plan, "basarisiz" mesaji ve Problems sayisi', async () => {
    fakeDiagnostics = [
      [vscode.Uri.file(path.join(wsRoot, 'proje-c/src/main.c')), [{ severity: 0 }, { severity: 1 }]],
      // Baska projenin bulgulari sayilmaz.
      [vscode.Uri.file(path.join(wsRoot, 'proje-a/src/main.c')), [{ severity: 0 }]]
    ];
    statusMessages = [];
    try {
      fireEnd(running.execution, 2);
      assert.strictEqual(contexts['buildbar.isRunning'], false);
      assert.strictEqual(statusItems['buildbar.stop'].visible, false);
      assert.strictEqual(
        statusItems['buildbar.build'].backgroundColor.id,
        'statusBarItem.errorBackground'
      );
      assert.match(statusMessages[0], /proje-c \(make\) \/ host-O0 basarisiz \(cikis 2\)/);
      assert.match(statusMessages[0], /Problems: 1 hata, 1 uyari/);
      assert.match(statusItems['buildbar.build'].tooltip.value, /Son derleme: `host-O0` basarisiz/);
    } finally {
      fakeDiagnostics = [];
    }
  });

  await checkAsync('basarili derleme kirmizi arka plani temizler', async () => {
    statusMessages = [];
    const run = await startBuild();
    // Derleme surerken onceki hata rengi gosterilmez.
    assert.strictEqual(statusItems['buildbar.build'].backgroundColor, undefined);
    fireEnd(run.execution, 0);
    assert.strictEqual(statusItems['buildbar.build'].backgroundColor, undefined);
    assert.match(statusMessages[0], /host-O0 tamam \(\d+,\d sn\)/);
  });

  await checkAsync('Durdur kosan derlemeyi sonlandirir, sonuc "durduruldu" olur', async () => {
    statusMessages = [];
    const run = await startBuild();
    await commands['buildbar.stop']();
    assert.strictEqual(run.execution.terminated, true);
    await tick(); // terminate -> gorev biter
    assert.strictEqual(contexts['buildbar.isRunning'], false);
    assert.match(statusMessages[0], /host-O0 durduruldu/);
    assert.strictEqual(statusItems['buildbar.build'].backgroundColor, undefined);
  });

  await checkAsync('derleme surerken sorulan soruya "Durdur" denirse durdurulur', async () => {
    const run = await startBuild();
    warnAnswer = (m, items) => (items.includes('Durdur') ? 'Durdur' : undefined);
    try {
      executed = [];
      await commands['buildbar.build']();
    } finally {
      warnAnswer = () => undefined;
    }
    assert.strictEqual(run.execution.terminated, true);
    assert.ok(!executed.some((e) => e.kind === 'task'), 'yeni gorev baslamis');
    await tick();
    assert.strictEqual(contexts['buildbar.isRunning'], false);
  });

  await checkAsync('"Yeniden baslat" once durdurur, bitince yeniden derler', async () => {
    const run = await startBuild();
    warnAnswer = (m, items) => (items.includes('Yeniden baslat') ? 'Yeniden baslat' : undefined);
    try {
      executed = [];
      await commands['buildbar.build']();
    } finally {
      warnAnswer = () => undefined;
    }
    assert.strictEqual(run.execution.terminated, true);
    const again = executed.find((e) => e.kind === 'task');
    assert.ok(again, 'yeniden baslatilmamis');
    assert.notStrictEqual(again.execution, run.execution);
    assert.strictEqual(contexts['buildbar.isRunning'], false, 'eski kosu hala izleniyor');
  });

  check('secenek olmayan gorevler (watch vb.) izlenmez', () => {
    const other = new TaskExecution({
      name: 'izle',
      scope: folderNamed('proje-c'),
      definition: { type: 'shell' }
    });
    fireStart(other);
    assert.strictEqual(contexts['buildbar.isRunning'], false);
    fireEnd(other, 0);
  });

  console.log('\nsec ve derle');

  check('editor basliginda derle dugmesinin hemen saginda acilir ok var', () => {
    const manifest = require('../package.json');
    const title = manifest.contributes.menus['editor/title'];
    const entry = title.find((m) => m.command === 'buildbar.pickAndBuild');
    assert.ok(entry, 'acilir ok editor basliginda yok');
    assert.strictEqual(entry.group, 'navigation@-100');
    assert.ok(!title.some((m) => m.command === 'buildbar.pickTask'), 'eski liste dugmesi duruyor');
    const build = title.find((m) => m.command === 'buildbar.build');
    assert.strictEqual(build.group, 'navigation@-101');
    const cmd = manifest.contributes.commands.find((c) => c.command === 'buildbar.pickAndBuild');
    assert.strictEqual(cmd.icon, '$(chevron-down)');
  });

  await checkAsync('acilir ok listesinde Enter secer ve derler, satir dugmesi yok', async () => {
    setActiveFolder(path.join(wsRoot, 'proje-a'));
    executed = [];
    pickAnswer = (items) => items.find((i) => i.opt.name === 'host-release');
    await commands['buildbar.pickAndBuild']();

    assert.ok(lastPick.items.every((i) => !i.buttons), 'satir dugmesi geri gelmis');
    assert.match(lastPick.opts.placeHolder, /Enter: sec ve derle/);
    assert.strictEqual(statusItems['buildbar.task'].text, '$(list-selection) host-release');
    const run = executed.find((e) => e.kind === 'task');
    assert.ok(run, 'derlenmedi');
    assert.strictEqual(run.name, 'host-release');
  });

  await checkAsync('status bar listesinde Enter yalnizca secer, derlemez', async () => {
    executed = [];
    pickAnswer = (items) => items.find((i) => i.opt.name === 'arm-debug');
    await commands['buildbar.pickTask']();
    assert.match(lastPick.opts.placeHolder, /Enter: sec$/);
    assert.strictEqual(statusItems['buildbar.task'].text, '$(list-selection) arm-debug');
    assert.ok(!executed.some((e) => e.kind === 'task'), 'Enter derlemis');
  });

  await checkAsync('acilir oktan secilen derle dugmesinin yeni varsayilani olur', async () => {
    executed = [];
    pickAnswer = (items) => items.find((i) => i.opt.name === 'host-debug');
    await commands['buildbar.pickAndBuild']();
    assert.strictEqual(statusItems['buildbar.task'].text, '$(list-selection) host-debug');
    assert.strictEqual(executed.find((e) => e.kind === 'task').name, 'host-debug');

    // Python'daki gibi: sonraki derle tiklamasi ayni secenegi kosar.
    executed = [];
    await commands['buildbar.build']();
    assert.strictEqual(executed.find((e) => e.kind === 'task').name, 'host-debug');
  });

  console.log('\nExplorer coklu secim');

  await checkAsync('birden fazla proje secilince hepsi sirayla derlenir', async () => {
    executed = [];
    taskLog = [];
    const a = vscode.Uri.file(path.join(wsRoot, 'proje-a'));
    const c = vscode.Uri.file(path.join(wsRoot, 'proje-c/src'));
    const doc = vscode.Uri.file(path.join(wsRoot, 'dokuman'));
    autoEnd = () => 0;
    try {
      await commands['buildbar.buildFromExplorer'](a, [a, c, doc]);
    } finally {
      autoEnd = undefined;
    }

    // Ikinci proje, birincisi bittikten sonra baslar.
    assert.deepStrictEqual(taskLog, ['run:host-debug', 'end:host-debug', 'run:host-O0', 'end:host-O0']);
    assert.ok(statusItems['buildbar.build'].text.includes('proje-a'), 'ilk proje aktif olmali');
    assert.strictEqual(contexts['buildbar.isRunning'], false);
    const summary = executed.find((e) => e.kind === 'warn' && /host-O0: tamam/.test(e.message));
    assert.ok(summary, 'ozet yok');
    assert.match(summary.message, /dokuman: secenek yok/);
  });

  await checkAsync('sira surerken Durdur kalan projeleri iptal eder', async () => {
    executed = [];
    taskLog = [];
    const a = vscode.Uri.file(path.join(wsRoot, 'proje-a'));
    const c = vscode.Uri.file(path.join(wsRoot, 'proje-c'));
    // Ilk gorev kendiliginden bitmesin; durdurulsun.
    const pending = commands['buildbar.buildFromExplorer'](a, [a, c]);
    await tick();
    const first = executed.find((e) => e.kind === 'task');
    fireStart(first.execution);
    assert.strictEqual(statusItems['buildbar.stop'].visible, true);
    await commands['buildbar.stop']();
    await pending;

    assert.deepStrictEqual(taskLog, ['run:host-debug'], 'ikinci proje yine de derlenmis');
    const summary = executed.find((e) => e.kind === 'warn' && /iptal edildi/.test(e.message));
    assert.ok(summary, 'iptal ozeti yok');
    assert.strictEqual(contexts['buildbar.isRunning'], false);
  });

  console.log('\ntemizle');

  await checkAsync('cleanTask ayarliyken temizlik gorevi listede gorunmez', async () => {
    configOverrides.cleanTask = 'temizle';
    await commands['buildbar.refresh']();
    assert.deepStrictEqual(namesOf('proje-c'), ['arm-Os', 'host-O0', 'host-O2']);
    assert.ok(!namesOf('proje-a').includes('temizle'));
  });

  await checkAsync('Temizle aktif projenin temizlik gorevini kosar', async () => {
    setActiveFolder(path.join(wsRoot, 'proje-c'));
    executed = [];
    autoEnd = () => 0;
    try {
      await commands['buildbar.clean']();
    } finally {
      autoEnd = undefined;
    }
    const runs = executed.filter((e) => e.kind === 'task');
    assert.strictEqual(runs.length, 1);
    assert.match(runs[0].line, /make clean/);
    assert.deepStrictEqual(runs[0].matchers, []); // tasks.json'daki "problemMatcher": []
    // Secili gorev degismez: temizlik bir yapilandirma degil.
    assert.strictEqual(statusItems['buildbar.task'].text, '$(list-selection) host-O0');
  });

  await checkAsync('CMake projesinde Temizle --target clean uretir (agac satirindan)', async () => {
    executed = [];
    autoEnd = () => 0;
    try {
      await commands['buildbar.clean'](projectNodes().find((n) => n.folder.name.startsWith('proje-b')));
    } finally {
      autoEnd = undefined;
    }
    const run = executed.find((e) => e.kind === 'task');
    assert.match(run.line, /cmake --build --preset host-debug --target clean/);
    assert.ok(statusItems['buildbar.build'].text.includes('proje-b'));
  });

  await checkAsync('Temizle ve derle: once temizler, bitince secili gorevi derler', async () => {
    setActiveFolder(path.join(wsRoot, 'proje-c'));
    taskLog = [];
    autoEnd = () => 0;
    try {
      await commands['buildbar.cleanBuild']();
    } finally {
      autoEnd = undefined;
    }
    assert.deepStrictEqual(taskLog, ['run:temizle', 'end:temizle', 'run:host-O0', 'end:host-O0']);
  });

  await checkAsync('temizlik basarisizsa derleme yapilmaz', async () => {
    taskLog = [];
    autoEnd = (task) => (task.name === 'temizle' ? 2 : 0);
    try {
      await commands['buildbar.cleanBuild']();
    } finally {
      autoEnd = undefined;
    }
    assert.deepStrictEqual(taskLog, ['run:temizle', 'end:temizle']);
  });

  await checkAsync('temizlik gorevi tanimsizsa ayarin nasil yazilacagi soylenir', async () => {
    delete configOverrides.cleanTask;
    await commands['buildbar.refresh']();
    executed = [];
    await commands['buildbar.clean'](); // aktif proje: proje-c
    assert.ok(!executed.some((e) => e.kind === 'task'));
    assert.ok(executed.some((e) => e.kind === 'info' && /buildbar\.cleanTask/.test(e.message)));
  });

  await checkAsync('ayar varsayilanlari gelmese de calisir (bozuk kurulum)', async () => {
    emptyConfig = true;
    try {
      // Eskiden burada "path argument must be of type string" hatasi vardi.
      await commands['buildbar.refresh']();
      assert.deepStrictEqual(namesOf('proje-c'), ['arm-Os', 'host-O0', 'host-O2', 'temizle']);

      // followActiveEditor de undefined donuyor; takip yine calismali.
      openEditor(path.join(wsRoot, 'dokuman/README.md'));
      assert.strictEqual(contexts['buildbar.hasProject'], false);
    } finally {
      emptyConfig = false;
      await commands['buildbar.refresh']();
    }
  });

  console.log('\nic ice projeler (tek klasor acildi, icinde repolar)');

  const repolar = path.join(wsRoot, 'repolar');
  const inRepos = (...parts) => path.join(repolar, ...parts);
  const rootRepolar = { name: 'repolar', index: 0, uri: vscode.Uri.file(repolar) };
  /** VS Code'da workspace klasorlerini degistirir (File > Open Folder gibi). */
  const openFolders = async (...folders) => {
    workspaceFolders.splice(0, workspaceFolders.length, ...folders);
    listeners.folders({});
    await tick();
  };
  const listedNames = () => projectNodes().map((n) => n.folder.name);
  /** Gorevleri bir sonraki turda bitirerek komutu kosar. */
  const runToEnd = async (fn, exitCode = () => 0) => {
    autoEnd = exitCode;
    try {
      await fn();
      await tick();
    } finally {
      autoEnd = undefined;
    }
  };

  await checkAsync('kap klasor yerine icindeki repolar listelenir; vendor ve 3. seviye yok', async () => {
    vscode.window.activeTextEditor = undefined;
    activeTab = undefined;
    await openFolders(rootRepolar);
    assert.deepStrictEqual(listedNames(), ['araclar/betik', 'surucu', 'uygulama']);
    // Acilista bir repo aktif olur; onceki workspace'in butonlari kalmaz.
    assert.strictEqual(contexts['buildbar.hasProject'], true);
    assert.strictEqual(statusItems['buildbar.build'].text, '$(play) araclar/betik');
  });

  check('repo icindeki dosya acilinca o repo aktif olur', () => {
    openEditor(inRepos('uygulama', 'src', 'main.c'));
    assert.strictEqual(contexts['buildbar.hasProject'], true);
    assert.strictEqual(statusItems['buildbar.build'].text, '$(play) uygulama');
    assert.strictEqual(statusItems['buildbar.task'].text, '$(list-selection) derle');
  });

  check('reponun kendi .vscode/settings.json dosyasindaki buildbar.* ayari uygulanir', () => {
    // buildbar.cleanTask: "temizle" -> temizlik gorevi listede yok.
    assert.deepStrictEqual(namesOf('uygulama'), ['derle', 'yapilandir']);
  });

  check('vendor klasorundeki dosya kapsayan repoya aittir', () => {
    openEditor(inRepos('uygulama', 'vendor', 'kutuphane', 'CMakePresets.json'));
    assert.strictEqual(statusItems['buildbar.build'].text, '$(play) uygulama');
  });

  check('kap klasordeki dosyada butonlar kaybolur', () => {
    openEditor(inRepos('NOTLAR.md'));
    assert.strictEqual(contexts['buildbar.hasProject'], false);
    assert.match(statusItems['buildbar.build'].text, /repolar: secenek yok/);
  });

  await checkAsync('derle once dependsOn gorevini kosar; repo klasorunde, workspace kapsaminda', async () => {
    openEditor(inRepos('uygulama', 'src', 'main.c'));
    executed = [];
    taskLog = [];
    statusMessages = [];
    await runToEnd(() => commands['buildbar.build']());

    assert.deepStrictEqual(taskLog, ['run:yapilandir', 'end:yapilandir', 'run:derle', 'end:derle']);
    const main = executed.filter((e) => e.kind === 'task')[1];
    assert.strictEqual(main.line, 'make derle');
    assert.strictEqual(main.task.execution.options.cwd, inRepos('uygulama'));
    // VS Code ic ice klasoru tanimaz; gorev workspace klasoru kapsaminda kosar.
    assert.strictEqual(main.task.scope, rootRepolar);
    assert.strictEqual(main.task.definition.folder, inRepos('uygulama'));
    assert.deepStrictEqual(main.matchers, ['$gcc']);
    assert.ok(statusMessages.some((m) => /uygulama \/ derle tamam/.test(m)), 'sonuc satiri yok');
    assert.strictEqual(contexts['buildbar.isRunning'], false);
  });

  await checkAsync('dependsOn gorevi basarisizsa derleme kosmaz', async () => {
    taskLog = [];
    await runToEnd(
      () => commands['buildbar.build'](),
      (task) => (task.name === 'yapilandir' ? 2 : 0)
    );
    assert.deepStrictEqual(taskLog, ['run:yapilandir', 'end:yapilandir']);
  });

  await checkAsync('repo derlemesi izlenir: donen ikon, (derleniyor), Problems yalnizca bu repodan', async () => {
    executed = [];
    statusMessages = [];
    const pending = commands['buildbar.build']();
    await tick();
    const dep = executed.find((e) => e.kind === 'task');
    fireStart(dep.execution);
    assert.strictEqual(contexts['buildbar.isRunning'], true);
    assert.match(statusItems['buildbar.build'].text, /^\$\(sync~spin\) uygulama/);
    assert.match(projectItem('uygulama').description, /\(derleniyor\)/);

    fireEnd(dep.execution, 0);
    await pending;
    const main = executed.filter((e) => e.kind === 'task')[1];
    assert.ok(main, 'dependsOn bitince derle baslamadi');
    fakeDiagnostics = [
      [vscode.Uri.file(inRepos('uygulama', 'src', 'main.c')), [{ severity: 0 }]],
      [vscode.Uri.file(inRepos('surucu', 'src', 'surucu.c')), [{ severity: 0 }]]
    ];
    try {
      fireStart(main.execution);
      fireEnd(main.execution, 2);
    } finally {
      fakeDiagnostics = [];
    }
    assert.strictEqual(contexts['buildbar.isRunning'], false);
    const line = statusMessages.find((m) => /derle basarisiz/.test(m));
    assert.match(line, /uygulama \/ derle basarisiz \(cikis 2\)/);
    assert.match(line, /Problems: 1 hata, 0 uyari/);
  });

  await checkAsync('Temizle reponun kendi ayarindaki temizlik gorevini kosar', async () => {
    executed = [];
    await runToEnd(() => commands['buildbar.clean']());
    const runs = executed.filter((e) => e.kind === 'task');
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].line, 'make temizle');
  });

  await checkAsync('iki seviye derinde ${workspaceFolder} repoya cozulur, ${env:...} VS Code a kalir', async () => {
    openEditor(inRepos('araclar', 'betik', 'uret.sh'));
    assert.strictEqual(statusItems['buildbar.build'].text, '$(play) araclar/betik');
    executed = [];
    await runToEnd(() => commands['buildbar.build']());
    const run = executed.find((e) => e.kind === 'task');
    assert.ok(run, 'gorev kosmadi');
    assert.strictEqual(run.line, `sh ${inRepos('araclar', 'betik')}/uret.sh \${env:HOME}`);
    assert.ok(!executed.some((e) => e.kind === 'command'), 'gorev sistemine devredilmis');
  });

  await checkAsync('${input:...} repoda devredilmez, uyari verir', async () => {
    const node = nodesOf('araclar/betik').find((n) => n.opt.name === 'sorulu-uret');
    executed = [];
    await commands['buildbar.buildNode'](node);
    assert.ok(!executed.some((e) => e.kind === 'task' || e.kind === 'command'));
    assert.ok(executed.some((e) => e.kind === 'warn' && /\$\{input:\.\.\.\}/.test(e.message)));
  });

  await checkAsync('Explorer sag tik: CMake reposu aktif olur ve kendi klasorunde derlenir', async () => {
    setActiveFolder(inRepos('surucu', 'src'));
    assert.strictEqual(statusItems['buildbar.build'].text, '$(play) surucu');
    executed = [];
    await runToEnd(() => commands['buildbar.build']());
    const run = executed.find((e) => e.kind === 'task');
    assert.match(run.line, /cmake --preset debug && cmake --build --preset debug/);
    assert.strictEqual(run.task.execution.options.cwd, inRepos('surucu'));
  });

  await checkAsync('launch: preLaunchTask repoda kosar, yapilandirma nesne olarak verilir', async () => {
    configOverrides.source = 'both';
    try {
      await commands['buildbar.refresh']();
      const node = nodesOf('uygulama').find((n) => n.opt.kind === 'launch');
      executed = [];
      taskLog = [];
      debugStarts = [];
      await runToEnd(() => commands['buildbar.debugNode'](node));

      assert.deepStrictEqual(taskLog, ['run:yapilandir', 'end:yapilandir', 'run:derle', 'end:derle']);
      assert.strictEqual(debugStarts.length, 1);
      assert.strictEqual(debugStarts[0].folder, rootRepolar);
      const conf = debugStarts[0].name;
      assert.strictEqual(typeof conf, 'object', 'ad verilmis; VS Code bu launch.json i tanimaz');
      assert.strictEqual(conf.name, 'uygulamayi calistir');
      assert.strictEqual(conf.program, `${inRepos('uygulama')}/build/uygulama`);
      assert.strictEqual(conf.cwd, inRepos('uygulama'));
      assert.strictEqual(conf.preLaunchTask, undefined, 'VS Code bulamayacagi gorevi arayacak');

      // preLaunchTask basarisizsa oturum baslamaz.
      debugStarts = [];
      executed = [];
      await runToEnd(
        () => commands['buildbar.debugNode'](node),
        (task) => (task.name === 'derle' ? 2 : 0)
      );
      assert.strictEqual(debugStarts.length, 0);
      assert.ok(executed.some((e) => e.kind === 'warn' && /hata ayiklama baslatilmadi/.test(e.message)));
    } finally {
      delete configOverrides.source;
      await commands['buildbar.refresh']();
    }
  });

  await checkAsync('nestedProjectDepth: 3 daha derini bulur (repo icindeki vendor yine yok), 0 eski davranis', async () => {
    setActiveFolder(inRepos('uygulama'));
    try {
      configOverrides.nestedProjectDepth = 3;
      await commands['buildbar.refresh']();
      assert.deepStrictEqual(listedNames(), ['araclar/betik', 'cok/derin/proje', 'surucu', 'uygulama']);

      configOverrides.nestedProjectDepth = 0;
      await commands['buildbar.refresh']();
      assert.deepStrictEqual(listedNames(), ['repolar']);
      // Aktif repo artik proje degil: kap klasor "secenek yok".
      assert.match(statusItems['buildbar.build'].text, /repolar: secenek yok/);
      assert.strictEqual(contexts['buildbar.hasProject'], false);
    } finally {
      delete configOverrides.nestedProjectDepth;
      await commands['buildbar.refresh']();
    }
  });

  await checkAsync('multi-root: repo adlarinin onunde klasor adi, workspace klasoru olan repo bir kez', async () => {
    const dokuman = { name: 'dokuman', index: 1, uri: vscode.Uri.file(path.join(wsRoot, 'dokuman')) };
    await openFolders(rootRepolar, dokuman);
    assert.deepStrictEqual(listedNames(), [
      'repolar/araclar/betik',
      'repolar/surucu',
      'repolar/uygulama',
      'dokuman'
    ]);

    const uygulama = { name: 'uygulama', index: 1, uri: vscode.Uri.file(inRepos('uygulama')) };
    await openFolders(rootRepolar, uygulama);
    assert.deepStrictEqual(listedNames(), ['repolar/araclar/betik', 'repolar/surucu', 'uygulama']);
  });

  fs.rmSync(tempRoot, { recursive: true, force: true });

  console.log(`\n${passed} kontrol gecti${process.exitCode ? ', HATALAR VAR' : ''}\n`);
})();
