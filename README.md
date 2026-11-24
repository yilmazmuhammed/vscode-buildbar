# BuildBar

Birden fazla proje iceren bir workspace'te **yalnizca aktif projenin**
derleme gorevlerini ve hata ayiklama yapilandirmalarini kalici butonlarda
gosterir. Liste projenin kendi `.vscode/tasks.json` ya da
`.vscode/launch.json` dosyasindan gelir; eklentiye ozel bir dosya formati yok.

Iki duzen de calisir:

- **Multi-root workspace** (`.code-workspace`): her workspace klasoru bir
  proje.
- **Icinde birden fazla repo olan tek bir klasor** (File > Open Folder ile
  `~/workspace` gibi): klasorun kendisi proje degilse alt klasorlerdeki
  repolar ayri projeler olarak bulunur. Bkz.
  [Tek klasorde birden fazla repo](#tek-klasorde-birden-fazla-repo).

## Ne veriyor

| Yer | Icerik |
| --- | --- |
| Editor baslik cubugu (ust sag) | `▶` derle (ya da `🐞` hata ayikla), hemen saginda `⌄` acilir ok: sec ve derle; derleme surerken solda `■` durdur |
| Status bar (alt sol) | `▶ proje-adi` + `☰ secenek-adi` — ikisi yan yana; derleme surerken `⟳ proje-adi` + `■` |
| Explorer paneli | "BuildBar" agaci: projeler > secenekler; proje satirinda sag tik: temizle / temizle ve derle |
| Explorer sag tik | `BuildBar >` alt menusu: derle / secenek sec / sec ve derle / aktif proje yap / temizle / temizle ve derle |

Secili secenek bir **gorev** ise dugme `$(play)` ikonuyla derler; bir
**launch yapilandirmasi** ise `$(debug-alt)` ikonuyla hata ayiklama oturumu
baslatir. Ikon `buildbar.isLaunch` baglam anahtarina gore degisir, boylece
dugmenin ne yapacagi basmadan once bellidir.

`▶` ve `⌄` `navigation@-101` ve `navigation@-100` sirasiyla katkilanir;
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

Listeler (agac, `☰` ve `⌄` listeleri) **alfabetik** siralanir: sayilar
sayi gibi karsilastirilir (`debug-2` < `debug-10`), buyuk/kucuk harf
ayrilmaz. `both` modunda once gorevler, sonra yapilandirmalar gelir; her
grup kendi icinde alfabetiktir.

Ilk secim, `tasks.json` icinde
`"group": { "kind": "build", "isDefault": true }` olan gorevdir; yoksa
**dosyadaki** ilk secenek (alfabetik ilk degil — dosyayi yazanin sirasi
korunur). Sonrasinda proje basina son secim `workspaceState`
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

## Tek klasorde birden fazla repo

Repolar yan yana tek bir klasore klonlanmis ve VS Code'da o klasor
(**File > Open Folder**) acilmissa:

```
workspace/              <- VS Code'da acilan klasor; kendisinde gorev yok
  uygulama/.vscode/tasks.json
  surucu/CMakePresets.json
  araclar/betik/.vscode/tasks.json
```

BuildBar acilan klasorun kendisinde secenek bulamazsa alt klasorlerine iner
ve kendi `tasks.json` / `launch.json` / `CMakePresets.json` dosyasi olan her
klasoru ayri bir proje sayar. Agacta ve proje listesinde `uygulama`,
`surucu`, `araclar/betik` gorunur; acilan klasor yalnizca bir kaptir.
Aktif proje, acik dosyayi iceren **en derindeki** repodur; sag tik menusu ve
agac da ayni sekilde calisir. Kap klasordeki bir dosyada (ornegin
`workspace/NOTLAR.md`) butonlar kaybolur.

- **Ne kadar derine:** `buildbar.nestedProjectDepth` (varsayilan `2`:
  `workspace/repo` ve `workspace/grup/repo`). `0` aramayi kapatir.
- **Projenin icine inilmez.** Bulunan bir reponun alt klasorleri taranmaz;
  repo icinde vendor'lanmis bir kutuphanenin `CMakePresets.json` dosyasi ayri
  proje gibi gorunmez. Ayni sebeple acilan klasorun kendisinde secenek varsa
  (tek bir repo acildiysa) hic arama yapilmaz — eski davranis aynen kalir.
- Gizli klasorlere (`.git`, `.vscode`...), `node_modules`'e ve sembolik
  baglantilara inilmez.

VS Code bu repolarin `.vscode` dosyalarini okumaz (yalnizca workspace
klasorlerininkini okur). BuildBar eksigi soyle kapatir:

| Konu | Repo workspace klasoru olsaydi | Ic ice repoda BuildBar |
| --- | --- | --- |
| `${workspaceFolder}` | Repo klasoru | Ayni: BuildBar repo klasorune cozer; gorev repo klasorunde kosar |
| Diger degiskenler (`${env:...}`, `${config:...}`, `${file}`) | VS Code cozer | Ayni: VS Code gorevi kosarken cozer |
| `${input:...}` | VS Code sorar | **Desteklenmez** — uyari verilir |
| `dependsOn` | VS Code zincirler | BuildBar zincirler: **sirayla** (`dependsOrder: parallel` da sirali), biri basarisizsa ana gorev kosmaz |
| `preLaunchTask` | VS Code kosar | Repodaki gorevse BuildBar kosar (dependsOn'uyla), basariliysa oturum baslar |
| `postDebugTask` | VS Code kosar | **Desteklenmez** (VS Code gorevi bulamaz) |
| `.vscode/settings.json` | VS Code okur | Yalnizca `buildbar.*` anahtarlarini BuildBar okur |

Gorevler workspace klasoru kapsaminda, `buildbar` turunde kosar; derleme
durumu, durdur, sonuc satiri ve Problems sayisi (yalnizca o repodaki
bulgular) her zamanki gibi calisir.

> Her seyin (IntelliSense'in `c_cpp_properties.json`'i dahil) VS Code
> tarafindan da taninmasi isteniyorsa repolari ayri workspace klasorleri
> olarak ekleyin (File > Add Folder to Workspace; sonra Save Workspace As...).
> BuildBar iki duzende de ayni gorunur.

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

## Sec ve derle

Eclipse'teki cekicin acilir okunun karsiligi; VS Code'da Python dosyasi
acikken calistir dugmesinin yanindaki okla ayni duzen. Editor baslik
cubugunda `▶`'in hemen sagindaki `⌄` secenek listesini acar:

- Listeden secilen secenek **secilir ve hemen derlenir** (launch
  yapilandirmasiysa oturum baslar).
- Secilen, `▶`'in yeni varsayilani olur; sonraki `▶` ayni secenegi kosar.

Status bar'daki `☰` ise **yalnizca secer** — "Set Active Build
Configuration" gibi; derlemek icin `▶`.

Ayni is komut paletinde **BuildBar: Sec ve derle...** ve Explorer'daki
`BuildBar >` alt menusunde.

> VS Code'un yerel acilir menuleri (Python'un okundaki gibi) yalnizca
> `package.json`'da sabit basligi olan komutlari gosterebilir; projeye gore
> degisen gorev adlari oraya konamaz. Bu yuzden `⌄` listeyi VS Code'un
> secim kutusunda (ekranin ust ortasi) acar.

## Derleme durumu, durdur ve sonuc

Projenin bir secenegi (ya da temizlik gorevi) kosarken — BuildBar'dan, Ctrl+Shift+B
ile ya da Terminal > Run Task ile baslatilmis olmasi farketmez:

- status bar'daki derle ogesi `⟳ proje-adi` olur, agacta proje satiri
  `(derleniyor)` yazar ve kosan secenegin ikonu doner,
- yaninda bir `■` **durdur** dugmesi cikar (editor baslik cubugunda ve agac
  basliginda da). Durdur, izlenen butun derlemeleri ve siradaki isleri
  sonlandirir — Eclipse'teki Progress iptali ya da Launch Bar'daki Stop gibi.
- Derleme surerken derle dugmesine yeniden basilirsa Eclipse'teki gibi sorar:
  **Durdur** ya da **Yeniden baslat**. Cift tiklama derlemeyi kazara
  durdurmaz, ayni gorev ust uste de baslamaz.

Bitince status bar'da birkac saniye sonuc satiri gorunur (Eclipse
konsolundaki "Build Finished" satirinin karsiligi):

```
✓ BuildBar: proje-a / host-debug tamam (4,1 sn)
✗ BuildBar: proje-c / host-O0 basarisiz (cikis 2) - Problems: 3 hata, 1 uyari
```

Son derleme basarisizsa derle ogesinin arka plani kirmizi kalir; bir sonraki
derleme baslayinca temizlenir. Ipucunda son sonuc ve o projenin Problems
sayisi yazar.

Izlenen gorevler: projenin secenek listesindekiler, `buildbar.cleanTask` ve
BuildBar'in sentezledikleri. Listede olmayan gorevler (ornegin bir `watch`
gorevi) durdur dugmesini acmaz.

## Temizle

Eclipse'teki Project > Clean... ve "Start a build immediately" karsiligi.

- **Temizle**: projenin temizlik gorevini kosar. Secili secenek degismez.
- **Temizle ve derle**: once temizler, temizlik basarili biterse secili
  secenegi derler.

Ikisi de Explorer'daki `BuildBar >` alt menusunde, agactaki proje satirinin
sag tik menusunde ve komut paletinde (aktif proje icin) var. Explorer'da
birden fazla proje seciliyse hepsine sirayla uygulanir.

Temizlik gorevi `buildbar.cleanTask` ayariyla adlandirilir:

```json
{ "buildbar.cleanTask": "temizle" }
```

Bu gorev artik secenek listesinde gorunmez — bir yapilandirma degil.
`CMakePresets.json` projelerinde ayar gerekmez: secili preset icin
`cmake --build --preset X --target clean` kosar.

## Explorer'da coklu secim

Explorer'da birden fazla proje (ya da farkli projelerden dosyalar) secip
**BuildBar > Derle / baslat** dendiginde her projenin secili secenegi
**sirayla** derlenir: bir sonraki proje, oncekinin gorevi bittikten sonra
baslar. Biri basarisiz olsa da digerlerine devam edilir, sonunda tek bir
ozet bildirimi gelir. Ilk proje aktif proje olur. Secili secenegi launch
yapilandirmasi olan projeler bu sirada atlanir (hata ayiklama oturumlari ust
uste acilmasin diye).

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
| `buildbar.cleanTask` | `""` | Temizle komutunun kosacagi `tasks.json` gorevinin etiketi |
| `buildbar.nestedProjectDepth` | `2` | Acilan klasor proje degilse alt klasorlerde kac seviye repo aranacagi; `0` kapatir |

`followActiveEditor` **window**, digerleri **resource** kapsaminda. Ic ice
bir reponun kendi `.vscode/settings.json` dosyasindaki `buildbar.*`
degerleri o repo icin gecerlidir (VS Code o dosyayi okumadigi icin BuildBar
okur).

## Eclipse karsiligi

Eclipse CDT'den gelenler icin kisa bir esleme.

| Eclipse | VS Code + BuildBar |
| --- | --- |
| Cekic (Build): secili projenin aktif yapilandirmasini derler | `▶ proje` (status bar) ya da ust sagdaki `▶` |
| Cekicin acilir oku: sec ve derle | Ust sagda `▶`'in yanindaki `⌄`; ya da **Sec ve derle...** |
| Set Active Build Configuration | Status bar'daki `☰` listesi, ya da agacta satira tiklamak |
| Birden fazla proje secip cekic | Explorer'da coklu secim > **BuildBar > Derle / baslat** |
| Project > Clean... (+ "Start a build immediately") | **Temizle** / **Temizle ve derle** (`buildbar.cleanTask`) |
| Progress iptali, Launch Bar Stop | `■` durdur dugmesi |
| Konsoldaki "Build Finished. N errors..." | Status bar'daki sonuc satiri, basarisizlikta kirmizi arka plan |
| Build Console | Gorevin terminal paneli (`presentation` ayarlari) |
| Problems gorunumu, Next/Previous Error | Problems paneli, F8 / Shift+F8 |
| Save automatically before build | `task.saveBeforeRun` (VS Code, varsayilan `always`) |
| Build before launching | `launch.json` icinde `preLaunchTask` |
| Launch Bar: yapilandirma secici + Launch | `buildbar.source: launch` ya da `both` |
| Manage Configurations... | `tasks.json` / `launch.json` dosyasini duzenlemek |

Bilerek olmayanlar: Build All (Ctrl+B), varsayilan kisayol, Run/Debug mod
secici, Working Set, Build Automatically, target secici (VS Code'da hedef
kavrami yok; hedef `launch.json` icinde tanimlanir).

## Gelistirme

```bash
# Calisma zamani bagimliligi yok, derleme adimi yok. Klasoru VS Code'da acip F5.
code buildbar/

# Duman testi (VS Code olmadan, sahte vscode modulu ile)
npm test

# .vsix paketi (vsce devDependency olarak kurulu)
npm ci
npx vsce package
```

Surum gecmisi `CHANGELOG.md` dosyasinda; kaynak git ile izleniyor. Surum
cikarma yordami CLAUDE.md icindeki "Surum cikarma yordami" bolumunde.

## Yayinlama

`main` dalina yapilan her push'ta `.github/workflows/publish.yml` calisir:
`npm ci`, duman testi (`npm test`), sonra `package.json` icindeki surum
Marketplace'teki surumle karsilastirilir. Surum farkliysa eklenti
`vsce publish --oidc` ile yayinlanir; ayniysa hicbir sey yayinlanmaz. Is
akisi Actions sekmesinden elle de (`workflow_dispatch`) baslatilabilir.

Yayin Trusted Publishing (OIDC) ile yapilir; depoda erisim anahtari (PAT)
tutulmaz. Bunun icin `myilmaz` yayinci sayfasinda bu depoyu ve
`publish.yml` is akisini adlandiran bir Trusted Publishing politikasi tanimli
olmali. `--oidc` bayragi `@vscode/vsce` 4.1.1 ve sonrasinda var; bu yuzden
vsce `devDependencies` icinde.

Yeni surum icin `version` alanini yukseltip `CHANGELOG.md` girdisini yazmak ve
`main`'e push etmek yeterli.

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
- Sentezleme yoluna dusuldugunde satir ici `problemMatcher` nesneleri
  uygulanmaz (yalnizca adla verilen `$gcc` gibi matcher'lar); workspace
  klasorlerinde `dependsOn` da uygulanmaz. Pratikte bu yol CMake
  preset'lerinde, ic ice repolarda ve henuz taranmamis dosyalarda devreye
  girer. Ic ice repolarda `dependsOn`'u BuildBar sirayla uygular.
- Ic ice repolarda `${input:...}` ve `postDebugTask` desteklenmez; bunlar
  gerekiyorsa repoyu workspace klasoru olarak ekleyin.
- `${input:...}` iceren ve gorev sistemine devredilen gorevlerin bitisi
  beklenemez: coklu secimde ya da "Temizle ve derle" sirasinda bir sonraki
  adim hemen baslar. Durum ve durdur dugmesi bu gorevlerde de calisir.
- Problems sayisi derleyici hatalarinin yaninda dil sunucusunun (IntelliSense)
  bildirdiklerini de icerir; Eclipse'in Problems gorunumunun Codan
  bulgularini da saymasi gibi.
- `buildbar.source: launch` iken `preLaunchTask` olarak kosan derleme izlenmez
  (secenek listesinde degil); hata ayiklama oturumu VS Code'un kendi hata
  ayiklama arac cubugundan durdurulur.
