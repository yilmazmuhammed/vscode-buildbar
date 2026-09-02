# Degisiklik kaydi

Kaynak artik git ile izleniyor; her surum icin yalnizca kurulum paketi
(`buildbar-<surum>.vsix`) uretilir. 0.2.1 ile 0.3.0 arasinda kisa bir sure
kaynak arsivi (`-kaynak.zip`) de konuyordu, git'e gecisle birakildi.

> **Yukseltme notu:** yeni `.vsix` kurulduktan sonra
> Ctrl+Shift+P → **Developer: Reload Window**. Yeniden yuklemezseniz calisan
> extension host eski kodu tutmaya devam eder, ayar tanimlari ise yeni
> surumden gelir; bu karisik durum tuhaf hatalara yol acar.

## 0.3.0 — 2026-09-02

Ikinci kaynak: `launch.json`. Liste artik gorevlerden ya da hata ayiklama
yapilandirmalarindan gelebiliyor, secim ayardan yapiliyor.

**Eklendi**

- `buildbar.source` ayari (`tasks` | `launch` | `both`, varsayilan `tasks`).
  **Resource** kapsaminda: her proje kendi `.vscode/settings.json` dosyasinda
  ayri deger verebilir, yani bir repo gorev listesiyle yanindaki repo launch
  yapilandirmalariyla calisabilir.
- `launch.json` okuma: `configurations[]` icindeki her `name` bir secenek,
  `compounds[]` girdileri de listeleniyor. Aciklama satirinda `type`,
  `request` ve varsa `preLaunchTask` gorunuyor. Dosya JSONC olarak okunuyor.
- `buildbar.launchFile` ayari (varsayilan `.vscode/launch.json`).
- Secili secenek bir yapilandirma ise dugme derlemiyor,
  `vscode.debug.startDebugging(folder, ad)` ile oturumu baslatiyor. Ad klasor
  kapsaminda cozuldugu icin dogru projenin dosyasi kullaniliyor. Oturum
  baslamazsa uyari cikiyor.
- `preLaunchTask` yazan yapilandirmalarda derlemeyi VS Code kendisi
  zincirliyor: tek tusla derle + hata ayikla.
- Dugme ikonu turune gore degisiyor: gorevde `$(play)`, yapilandirmada
  `$(debug-alt)`. Ust sagdaki ikon `buildbar.isLaunch` baglam anahtarina
  bagli; agac satirindaki inline ikon da ayni sekilde ayriliyor.
- Ornek workspace: `proje-a/.vscode/launch.json` (iki yapilandirma + bir
  compound, `preLaunchTask` ile tasks.json'a bagli) ve
  `demo.code-workspace` icinde acik `buildbar.source` satiri.

**Degisti**

- Secim kaydi artik `tur:ad` seklinde (`task:host-debug`,
  `launch:ikisi birden`). `both` modunda ayni ada sahip bir gorev ile
  yapilandirmanin karismamasi icin. 0.2.x kayitlari (yalnizca ad) geriye
  donuk olarak taninmaya devam ediyor.
- Arayuz metinleri, yerine gore "gorev" degil "secenek" diyor:
  `proje: secenek yok`, "Secenek sec...". Explorer alt menusundeki girdi
  "Derle / baslat" oldu.
- Explorer panelindeki agacin adi "Derleme" yerine "BuildBar" — liste artik
  yalnizca derleme gorevleri olmayabilir.
- `launch.json` da `FileSystemWatcher` ile izleniyor.

## 0.2.1 — 2026-09-02

Kurulum sonrasi pencere yeniden yuklenmediginde ortaya cikan iki hatanin
giderilmesi.

**Duzeltildi**

- Ayar varsayilanlari artik kod icinde de duruyor (`DEFAULTS` + `pref()`).
  Eski kod + yeni manifest karisimi durumda `conf.get(...)` undefined
  donuyordu ve `buildbar.refresh` komutu
  `The "path" argument must be of type string. Received undefined` hatasi
  veriyordu. Artik hicbir ayar okumasindan undefined sizmiyor.
- `discover()` cagrisi try/catch ile sarildi. Kesif sirasinda bir hata
  ciksa bile `render()` yarida kalmiyor; butonlar onceki projede takili
  kalmiyor.
- Aktif proje takibi artik metin editoru olmayan sekmelerde de calisiyor.
  `onDidChangeActiveTextEditor` sadece metin editorlerinde tetikleniyordu;
  resim, notebook ve fark gorunumu sekmelerinde butonlar guncellenmiyordu.
  Ek olarak `window.tabGroups` olaylari dinleniyor ve aktif sekmenin
  `input.uri` / `input.modified` alani kullaniliyor.
- BOM ile baslayan `tasks.json` dosyalari da okunuyor.

**Dokuman**

- KURULUM.md §2: kurulumdan sonra pencereyi yeniden yukleme adimi ve
  kurulu surumu dogrulama komutu eklendi.
- Bu degisiklik kaydi dosyasi eklendi.

## 0.2.0 — 2026-09-02

Gorev kaynaginin `tasks.json`'a tasinmasi ve arayuz duzeltmeleri.

**Degisti (uyumsuz)**

- Gorev kaynagi artik projenin kendi `.vscode/tasks.json` dosyasi. Eklentiye
  ozel `.vscode/build-configs.json` formati **kaldirildi**; `tasks[]`
  icindeki her `label` bir secenek, `detail` aciklama,
  `group.isDefault` acilistaki secim.
- `buildbar.configFile`, `buildbar.buildScript`,
  `buildbar.buildScriptWindows` ve `buildbar.configArgument` ayarlari
  silindi. Yerine `buildbar.tasksFile` ve `buildbar.onlyBuildGroup` geldi.
  Windows farki artik gorevin kendi `windows` blogu ile veriliyor.
- `buildbar.pickConfig` komutu `buildbar.pickTask`, `buildbar.buildNode`
  hedefi `buildbar.option` oldu.
- CMake projelerinde sarmalayici script varsayan kod yolu kaldirildi;
  `ornek-workspace/proje-b/build.sh` silindi.

**Eklendi**

- Derleme once `vscode.tasks.fetchTasks()` ile VS Code'un cozdugu gercek
  gorev uzerinden kosuyor: `dependsOn`, satir ici `problemMatcher`
  nesneleri, `${...}` degiskenleri ve `presentation` korunuyor. Eslesme
  yoksa gorev sentezleniyor; `${input:...}` gibi cozulemeyen degisken varsa
  is `workbench.action.tasks.runTask` ile gorev sistemine devrediliyor.
- `tasks.json` JSONC olarak okunuyor: yorum satirlari ve son virgul
  tolere ediliyor (bagimlilik eklenmedi, ~80 satirlik okuyucu).
- Explorer sag tikta `BuildBar >` alt menusu: "Derle",
  "Derleme gorevi sec...", "Aktif proje yap". Derleme artik aktif projeyi
  degistirmeden dogrudan yapilabiliyor.
- Secilen gorev `workspaceState` icinde saklaniyor; pencere yeniden
  yuklenince varsayilana donmuyor.

**Duzeltildi**

- Derle ikonu `$(tools)` (somun anahtari + tornavida) yerine `$(play)`.
  Onceki ikon konfigurasyon ikonu gibi okunuyordu. Gorev secimi
  `$(list-selection)`.
- Gorevi olmayan bir klasore gecildiginde butonlar artik kayboluyor.
  Onceden editor takibi yalnizca derlenebilir klasorlerde guncelleniyordu,
  bu yuzden onceki projenin butonlari ekranda kaliyor ve yanlis projeyi
  derliyordu.
- Editor baslik cubugundaki iki ikon `navigation@-101` / `navigation@-100`
  sirasina alindi; aralarina markdown preview gibi baska butonlar girmiyor.
- Secili gorev artik belli: status bar'da adi yazili ikinci bir oge, quick
  pick'te `$(check)` + "secili", agacta dolu daire + `(secili)`.
- Agacta bir goreve tiklamak artik derlemiyor, yalnizca seciyor; derleme
  satir sonundaki oynat ikonunda.

## 0.1.0 — 2026-09-02

Ilk surum.

- Aktif projenin derleme konfigurasyonlarini `.vscode/build-configs.json`
  ya da `CMakePresets.json` icindeki `buildPresets` uzerinden listeleme.
- Editor baslik cubugunda iki ikon, status bar'da tek oge, Explorer'da
  "Derleme" agaci, Explorer sag tikta "aktif proje yap".
- Derleme task API uzerinden (`$gcc` matcher'i ile Problems paneli
  baglantisi).
