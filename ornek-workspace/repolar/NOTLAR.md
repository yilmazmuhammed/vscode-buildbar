# repolar

Icinde birden fazla repo olan tek bir klasor: VS Code'da **File > Open
Folder** ile bu klasor acildiginda BuildBar alt klasorlerdeki projeleri
ayri ayri listeler. Bu klasorun kendisinde gorev yok; yalnizca bir kap.

| Klasor | Ne icin |
| --- | --- |
| `uygulama/` | Makefile + `.vscode/tasks.json` (dependsOn zinciri), `launch.json` (preLaunchTask), kendi `settings.json`'i (`buildbar.cleanTask`) |
| `uygulama/vendor/kutuphane/` | Vendor'lanmis kutuphane: `CMakePresets.json` var ama ayri proje olarak **listelenmemeli** (projenin icine inilmez) |
| `surucu/` | Yalnizca `CMakePresets.json` |
| `araclar/betik/` | Iki seviye derinde bir proje; `${workspaceFolder}` bu klasore cozulur |
| `cok/derin/proje/` | Uc seviye derinde: varsayilan `buildbar.nestedProjectDepth: 2` ile **bulunmamali** |

Bu dosya acikken status bar `repolar: secenek yok` yazar.
