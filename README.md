# BuildBar

Multi-root workspace'te **yalnizca aktif projenin** derleme gorevlerini ve
hata ayiklama yapilandirmalarini kalici butonlarda gosterir. Liste projenin
kendi `.vscode/tasks.json` ya da `.vscode/launch.json` dosyasindan gelir;
eklentiye ozel bir dosya formati yok.

## Ne veriyor

| Yer | Icerik |
| --- | --- |
| Editor baslik cubugu (ust sag) | `▶` derle (ya da `🐞` hata ayikla), `☰` secenek sec |
| Status bar (alt sol) | `▶ proje-adi` + `☰ secenek-adi` — ikisi yan yana |
| Explorer paneli | "BuildBar" agaci: projeler > secenekler |
| Explorer sag tik | `BuildBar >` alt menusu: derle / secenek sec / aktif proje yap |

Secili secenek bir **gorev** ise dugme `$(play)` ikonuyla derler; bir
**launch yapilandirmasi** ise `$(debug-alt)` ikonuyla hata ayiklama oturumu
baslatir. Ikon `buildbar.isLaunch` baglam anahtarina gore degisir, boylece
dugmenin ne yapacagi basmadan once bellidir.

Iki dugme `navigation@-101` ve `navigation@-100` sirasiyla katkilanir;
negatif sira sayesinde onlerine baska eklentilerin butonlari (markdown
preview gibi) girmez ve yan yana kalirlar.

Ikonlari pencerenin en ustundeki baslik cubuguna tasimak icin ayarlarda
`workbench.editor.editorActionsLocation` degerini `titleBar` yapin.

## Secenek kaynagi

`buildbar.source` ayari hangi dosyanin okunacagini belirler:

| Deger | Liste |
| --- | --- |
| `tasks` (varsayilan) | `.vscode/tasks.json` icindeki gorevler; dosya yoksa `CMakePresets.json` |
| `launch` | `.vscode/launch.json` icindeki hata ayiklama yapilandirmalari |
| `both` | Once gorevler, sonra yapilandirmalar — tek listede |

Ayar **resource** kapsaminda: her proje kendi `.vscode/settings.json`
dosyasinda ayri deger verebilir. Yani bir repo gorev listesiyle, yanindaki
repo launch yapilandirmalariyla calisabilir.

**`tasks.json`** — `tasks[]` icindeki her `label` bir secenek. Dosya JSONC
olarak okunur: yorum satirlari ve son virgul sorun degil.

```jsonc
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "host-debug",
      "detail": "cc -O0 -g",
      "type": "shell",
      "command": "./build.sh",
      "args": ["--config", "host-debug"],
      "group": { "kind": "build", "isDefault": true },
      "problemMatcher": "$gcc"
    }
  ]
}
```

**`launch.json`** — `configurations[]` icindeki her `name` bir secenek;
`compounds[]` girdileri de listelenir. Aciklama satirinda `type`, `request`
ve varsa `preLaunchTask` gorunur.

```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "host-debug calistir",
      "type": "cppdbg",
      "request": "launch",
      "program": "${workspaceFolder}/build/host-debug/demo",
      "preLaunchTask": "host-debug"
    }
  ]
}
```

`preLaunchTask` varsa derlemeyi **VS Code kendisi zincirler**: dugmeye
basmak once gorevi kosar, sonra oturumu baslatir.

**`CMakePresets.json`** — `tasks.json` yoksa (ve `source` launch degilse)
`buildPresets` okunur, `hidden: true` olanlar atlanir. Ayni isimli bir
`configurePreset` varsa komut `cmake --preset X && cmake --build --preset X`
seklinde zincirlenir. CMake projelerine hicbir sey eklemek gerekmez;
sarmalayici bir `build.sh` de gerekmez.

Ucu de `FileSystemWatcher` ile izlenir; degistirdiginizde liste kendini
yeniler, pencereyi yeniden yuklemek gerekmez.

## Hangi secenek secili

Secili secenek **uc yerde birden** yazili durur:

- status bar'da adi acikca gorunur (`☰ host-debug`),
- secenek listesinde (`$(check)` isareti + "secili" etiketi),
- agacta dolu daire ikonu + `(secili)` yazisi.

Ilk secim, `tasks.json` icinde
`"group": { "kind": "build", "isDefault": true }` olan gorevdir; yoksa
listedeki ilk secenek. Sonrasinda proje basina son secim `workspaceState`
icinde saklanir — pencereyi yeniden yukleseniz de kalir. Kayit `tur:ad`
seklinde tutulur, boylece `both` modunda ayni ada sahip bir gorev ile
yapilandirma karismaz.

## Aktif proje nasil belirlenir

Uc sinyal:

1. **"BuildBar" agacindaki secim** — `TreeView.onDidChangeSelection` ile
   dogrudan gozlemlenir.
2. **Explorer'da sag tik → BuildBar** — komut, secili URI'leri argüman olarak
   alir; coklu secimde ilki kullanilir.
3. **Aktif sekme** — `buildbar.followActiveEditor` acikken dosya degistikce
   takip eder.

Ucuncusu **bayat buton birakmaz**: secenegi olmayan bir klasordeki dosyaya
(ornegin `dokuman/README.md`) gecildiginde ust sagdaki ikonlar kaybolur ve
status bar `proje-adi: secenek yok` yazar. Workspace disi bir dosyada da
butonlar gizlenir.

Yerlesik Explorer'da bir klasore **sol** tiklamak izlenemez; VS Code o secimi
eklentilere aciklamiyor (bkz. microsoft/vscode#3553). Yani sadece klasore
tiklamak aktif projeyi degistirmez. Bu yuzden sag tik menusu var: derleme de
oradan yapilabildigi icin "hangi proje aktifti" sorusunu hic sormak gerekmez.

## Secenek nasil kosar

**Gorev** secili ise:

1. Once `vscode.tasks.fetchTasks()` ile **VS Code'un cozdugu gercek gorev**
   aranir (ayni klasor kapsami + ayni ad). Bulunursa o kosar: `dependsOn`,
   satir ici `problemMatcher` nesneleri, `${...}` degiskenleri, `presentation`
   ayarlari — hepsi korunur.
2. Bulunamazsa (CMake preset, henuz taranmamis dosya) gorev `ShellExecution`
   / `ProcessExecution` ile kurulur. `windows` / `linux` / `osx` bloklari,
   `options.cwd`, `${workspaceFolder}` burada da uygulanir.
3. Komutta yalnizca VS Code'un cozebilecegi bir degisken varsa
   (`${input:...}`, `${command:...}`) is `workbench.action.tasks.runTask`
   uzerinden gorev sistemine devredilir.

Her uc yolda da derleme **task API** uzerinden kosar, boylece `$gcc`
matcher'i hatalari Problems panelinde tiklanabilir yapar.

**Launch yapilandirmasi** secili ise `vscode.debug.startDebugging(folder,
ad)` cagrilir. Ad klasor kapsaminda cozuldugu icin dogru projenin
`launch.json` dosyasi kullanilir; compound girdiler de ayni yolla baslar.
Oturum baslamazsa (ornegin yapilandirma gecersizse) uyari gosterilir.

## Ayarlar

| Ayar | Varsayilan | Aciklama |
| --- | --- | --- |
| `buildbar.source` | `tasks` | Liste kaynagi: `tasks` / `launch` / `both` |
| `buildbar.followActiveEditor` | `true` | Aktif sekmeyi takip et |
| `buildbar.tasksFile` | `.vscode/tasks.json` | Gorev dosyasinin yolu |
| `buildbar.launchFile` | `.vscode/launch.json` | Yapilandirma dosyasinin yolu |
| `buildbar.onlyBuildGroup` | `false` | Yalnizca `group: build` gorevlerini listele |
| `buildbar.cmakeFallback` | `true` | tasks.json yoksa CMakePresets.json'a dus |
| `buildbar.problemMatchers` | `["$gcc"]` | Gorev kendi matcher'ini vermezse kullanilir |

`followActiveEditor` **window**, digerleri **resource** kapsaminda.

## Gelistirme

```bash
# Bagimlilik yok, derleme adimi yok. Klasoru VS Code'da acip F5.
code buildbar/

# Duman testi (VS Code olmadan, sahte vscode modulu ile)
node test/smoke.js

# .vsix paketi
npx --yes @vscode/vsce package --allow-missing-repository --skip-license
```

Surum gecmisi `CHANGELOG.md` dosyasinda; kaynak git ile izleniyor. Surum
cikarma yordami CLAUDE.md icindeki "Surum cikarma yordami" bolumunde.

## Bilinen sinirlar

- Explorer'da bir klasore sol tiklamak aktif projeyi degistirmez; VS Code o
  secimi eklentilere vermiyor. Sag tik menusu ya da "BuildBar" agaci
  kullanin.
- Editor baslik cubugu ikonlari, hic editor acik degilse gorunmez (o cubuk
  yoktur). Status bar ogeleri kalir; ikisini birlikte kullanmanin sebebi bu.
- Aktif sekme bir URI tasimiyorsa (markdown preview gibi webview sekmeleri)
  hangi dosyaya ait oldugu ogrenilemez; o durumda aktif proje degismez,
  onceki durum korunur. Resim, notebook ve fark gorunumu sekmeleri URI
  tasidiklari icin takip edilir.
- `.code-workspace` dosyasinin icindeki (workspace kapsamli) gorevler ve
  launch yapilandirmalari listelenmez: bunlar tek bir projeye ait degil.
- Sentezleme yoluna dusuldugunde `dependsOn` ve satir ici `problemMatcher`
  nesneleri uygulanmaz. Pratikte bu yol yalnizca CMake preset'lerinde ve
  henuz taranmamis dosyalarda devreye girer.
