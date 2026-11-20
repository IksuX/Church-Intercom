# Interkom – aplikacja na iPhone i Android (1.5.0)

Aplikacja to „opakowanie” zwykłej strony interkomu (ten sam wygląd, logowanie, czat, powiadomienia),
ale **dźwięk obsługuje natywnie** (LiveKit), dzięki czemu:

- słychać i można mówić **przy zablokowanym ekranie / w kieszeni**,
- działają **przyciski sprzętowe**: przycisk na słuchawkach, piloty/przyciski PTT Bluetooth, przyciski głośności,
- powiadomienia (wezwania, wzmianki) przychodzą przez połączenie aplikacji – bez Web Push.

Strona nadal działa w przeglądarce jak dotąd – aplikacja jest dodatkiem. Wymaga serwera **0.32.0+** (wyszukiwanie w sieci: **0.33.0+**; strona prywatności, informacja przy logowaniu i konto demo: **0.52.0+**).

## Wybór serwera

Aplikacja startuje od ekranu **wyboru serwera**:
- **W tej sieci** – serwery interkomu znalezione automatycznie w Wi-Fi (serwer ogłasza się przez mDNS/Bonjour;
  instalator 0.33.0+ instaluje do tego `avahi-daemon`). Serwer w internecie (VPS) się tu nie pojawia.
- **Ostatnio używane** i **Serwer domyślny** (z `IK_SERVER_URL` przy budowaniu).
- **Wpisz adres** – domena albo adres IP, np. `192.168.1.10`.

Wybrany serwer jest zapamiętywany – kolejne uruchomienia otwierają go od razu. Zmiana: przycisk
**🔁 Zmień serwer** na ekranie logowania i w ⚙️. Gdy serwer nie odpowiada, pojawia się ekran
„Brak połączenia” z przyciskami „Spróbuj ponownie” / „Wybierz inny serwer”.

iPhone przy pierwszym wyszukiwaniu zapyta o dostęp do **sieci lokalnej** – trzeba zezwolić
(później: Ustawienia → Prywatność i ochrona → Sieć lokalna → Interkom).

## Wymagania

- Mac z **Xcode 16+** (iOS) i **Android Studio** (Ladybug lub nowsze, JDK 21) – Android można budować też na Windows/Linux,
- **Node 22+**,
- iPhone: płatne konto **Apple Developer Program** (99 USD/rok) do TestFlight / Ad Hoc / App Store. Darmowe konto
  Apple ID („Personal Team”) pozwala tylko zainstalować aplikację na własnym iPhonie (wygasa po 7 dniach) – nie da się
  nim wysłać aplikacji do TestFlight,
- Android: nic – plik APK instaluje się bezpośrednio.

## Budowanie

```bash
cd mobile
npm install
export IK_SERVER_URL=https://57-128-249-85.sslip.io   # opcjonalnie – „Serwer domyślny (internet)” na liście
npx cap add ios
npx cap add android
npm run sync
```

Identyfikator aplikacji (Bundle ID / applicationId) to **`pl.churchinterkom.app`** (`capacitor.config.ts`). Taki sam
musi być w App Store Connect – po utworzeniu aplikacji nie da się go zmienić. `IK_APP_ID` nadpisuje go tylko do prób.
Uwaga: do wersji 1.4.1 identyfikator był `pl.interkom.app`, więc na Androidzie 1.5.0 instaluje się jako nowa aplikacja.
Starą trzeba usunąć ręcznie.

`npm run sync` (oraz `npm run ios` / `npm run android`) uruchamia też skrypty `scripts/ios-setup.sh`
i `scripts/android-setup.sh`. Uruchamiaj je po każdym `cap add`. Bezpiecznie można je uruchamiać wielokrotnie.
- **iOS:** Info.plist (opisy uprawnień – tylko mikrofon, sieć lokalna i Bluetooth; tryb w tle tylko `audio`;
  `ITSAppUsesNonExemptEncryption = false`), wersja i numer kompilacji, manifest prywatności `PrivacyInfo.xcprivacy`
  (z `resources/`, dopisany do projektu Xcode), ikona i ekran startowy.
- **Android:** MainActivity, repozytorium JitPack, `versionName` / `versionCode`, ikony (`mipmap-*`, ikona adaptacyjna)
  i ekran startowy, usunięcie nieużywanych uprawnień dodawanych przez LiveKit (kamera, udostępnianie ekranu).

Zmiany w samej stronie (serwer) **nie wymagają** przebudowy aplikacji – aplikacja wczytuje stronę z serwera.

### Wersja i numer kompilacji

- **Wersja** (`CFBundleShortVersionString` / `versionName`) = `version` z `mobile/package.json` (teraz 1.5.0).
- **Numer kompilacji** (`CFBundleVersion` / `versionCode`) jest w pliku `mobile/build-number`. Przed **każdym**
  archiwum do TestFlight i każdym nowym APK: `npm run bump-build` (podnosi numer o 1 i od razu wpisuje go do projektów
  iOS i Android). App Store Connect odrzuca kompilację z numerem, który już był. Zmieniony `build-number` dołącz do commita.

### Ikona i ekran startowy

Źródła są w `mobile/resources/`: `icon.png` (1024×1024, bez przezroczystości – wymóg App Store),
`icon-foreground.png` (warstwa przednia ikony adaptacyjnej Androida) i `splash.png` (2732×2732). Obecna ikona
jest tymczasowa: pomarańczowe koło z mikrofonem, jak `app/public/icon.svg`. Generuje ją `npm run icons`
(`resources/make-icons.swift`, na Macu). Własną grafikę wystarczy podmienić w `resources/` i uruchomić `npm run sync`.

### iPhone

1. `npm run ios` – otworzy się Xcode.
2. Projekt **App** → zakładka *Signing & Capabilities* → zaznacz *Automatically manage signing* i wybierz *Team*
   z płatnego konta Apple Developer Program. Certyfikaty i profile zostają w Xcode i w pęku kluczy – **nic z tego
   nie trafia do repozytorium** (`.gitignore` blokuje `*.p12`, `*.p8`, `*.mobileprovision`, `*.cer`).
3. Podłącz iPhone’a → ▶ Run (próba na własnym telefonie).

### Dystrybucja na iPhone’a

**TestFlight służy do testowania** wersji przed wydaniem, nie zastępuje publikacji:
- kompilacja w TestFlight **wygasa po 90 dniach** – potem testerzy nie uruchomią aplikacji, dopóki nie wyślesz nowej,
- **testerzy wewnętrzni** (do 100 osób z kontem w App Store Connect) dostają kompilację od razu, bez recenzji,
- **testerzy zewnętrzni** (do 10 000, zaproszenie mailem albo publiczny link) wymagają recenzji **Beta App Review**
  – pierwsza kompilacja każdej wersji idzie do recenzji (zwykle do 1–2 dni).

Docelowo (do decyzji) zostają dwie drogi:
- **Ad Hoc** – instalacja na zarejestrowanych iPhone’ach zespołu (do 100 urządzeń rocznie, UDID każdego telefonu),
  profil i aplikację trzeba odnawiać co rok. Bez recenzji Apple.
- **Aplikacja niepubliczna w App Store** (*Unlisted App*) – pełna recenzja App Store, potem stały link, aktualizacje
  jak dla zwykłej aplikacji, bez wygasania. Nie da się jej znaleźć w wyszukiwarce sklepu.

#### TestFlight krok po kroku

1. **App Store Connect → Aplikacje → ＋ Nowa aplikacja**: platforma iOS, nazwa (np. „Interkom”), język główny polski,
   Bundle ID **`pl.churchinterkom.app`** (najpierw zarejestruj go w *Certificates, Identifiers & Profiles → Identifiers*,
   jeśli nie ma go na liście), SKU – dowolny własny kod (np. `interkom-ios`), dostęp: pełny.
2. `cd mobile && npm run bump-build && npm run sync` → `npx cap open ios`.
3. Xcode: u góry wybierz urządzenie **Any iOS Device (arm64)** → *Product → Archive*. Po zakończeniu otworzy się
   *Organizer*: **Validate App** (popraw zgłoszone problemy) → **Distribute App → App Store Connect → Upload**.
4. Po kilku–kilkunastu minutach kompilacja pojawi się w App Store Connect → TestFlight. **Export Compliance** jest
   wypełnione z góry (`ITSAppUsesNonExemptEncryption = false` – tylko standardowe szyfrowanie HTTPS/WebRTC).
5. **Testerzy wewnętrzni:** TestFlight → *Internal Testing* → ＋ grupa → dodaj użytkowników App Store Connect
   (muszą mieć konto w zespole, *Users and Access*). Instalują aplikację **TestFlight** z App Store i przyjmują zaproszenie.
6. **Grupa zewnętrzna:** TestFlight → *External Testing* → ＋ grupa (np. „Zespół kościoła”) → dodaj kompilację.
7. Uzupełnij dane do recenzji z [`docs/testflight-recenzja.md`](docs/testflight-recenzja.md): *Beta App Description*,
   *What to Test*, *Feedback Email*, *Privacy Policy URL*, dane logowania (PIN konta demo – tylko w App Store Connect)
   i *Review Notes*. Przed wysłaniem włącz konto demo na serwerze VPS (panel → Ogólne → Konto demo).
8. **Submit for Review**. Po akceptacji: **publiczny link** (*Enable Public Link*) – wklej go w panelu interkomu
   (Ogólne → Aplikacja na telefon) – albo zaproszenia mailowe dla osób dopisanych do grupy.

### Android

1. `npm run android` – otworzy się Android Studio (poczekaj na Gradle sync).
2. ▶ Run na podłączonym telefonie albo *Build → Generate Signed App Bundle / APK → APK*.
3. Plik APK (*Build → Build App Bundle(s) / APK(s) → Build APK(s)*, wynik: `android/app/build/outputs/apk/debug/app-debug.apk`) wgraj w panelu interkomu: **Ogólne → Aplikacja na telefon → Wgraj plik APK**. Na ekranie logowania pojawi się przycisk „Pobierz na Androida (APK)”. Instalacja: zezwól przeglądarce na „instalowanie nieznanych aplikacji”.
4. Po instalacji: Ustawienia → Aplikacje → Interkom → Bateria → **Bez ograniczeń** (inaczej niektóre telefony
   – Xiaomi, Huawei, Samsung – mogą zamykać aplikację w tle).

## Przyciski

Ustawienia: w aplikacji **Ustawienia → Dźwięk → Przyciski** (widoczne tylko w aplikacji).

| | Android | iPhone |
|---|---|---|
| Przycisk na słuchawkach / Bluetooth (play/pauza) | przytrzymaj lub naciśnij–naciśnij; także przy zablokowanym ekranie | naciśnij – mów, naciśnij – koniec (iOS nie przekazuje „puszczenia”); także przy zablokowanym ekranie |
| AirPods (ściśnięcie nóżki) | zależnie od telefonu | nie działa – w trakcie „rozmowy” iOS obsługuje gest sam (wymagałoby CallKit) |
| Przycisk PTT Bluetooth (pilot) | „Naucz przycisk PTT” – dowolny przycisk; przytrzymanie działa | działa, jeśli pilot wysyła play/pauza (większość pilotów) |
| Przyciski głośności | gdy ekran włączony | gdy aplikacja na ekranie; zmienia też głośność |

Krótkie naciśnięcie (< 0,35 s) w trybie „przytrzymaj” na Androidzie działa jak włącz/wyłącz.

## Jak to działa (dla ciekawych)

- `plugins/ik-audio` – natywna wtyczka (Swift / Kotlin) z LiveKit SDK.
- Strona w aplikacji wykrywa wtyczkę i oddaje jej dźwięk; mikrofon jest stale gotowy, ale wyciszony do naciśnięcia.
- Serwer co chwilę wysyła aplikacji listę osób, które ma słyszeć (wg kanałów), więc wszystko działa nawet gdy
  strona w tle „śpi”. Aplikacja zgłasza się serwerowi co 20 s (`/api/native/beat`).
- Mówienie przyciskiem sprzętowym idzie bezpośrednio do serwera (`/api/native/ptt`); nagranie do transkrypcji
  aplikacja wysyła sama.
- Android: usługa pierwszoplanowa (stałe powiadomienie „Interkom – połączony”, a w trakcie mówienia „🎙️ Mówisz – mikrofon włączony”) + MediaSession.
- iPhone: tryb audio w tle + MPRemoteCommandCenter.

## Ograniczenia

- iPhone: przycisk słuchawek działa wyłącznie jako przełącznik (ograniczenie systemu). Prawdziwe „przytrzymaj i mów”
  na iOS daje dopiero framework Apple PushToTalk – możliwy w kolejnej wersji.
- Słuchanie dźwięku transmisji w aplikacji idzie przez LiveKit (nie tryb „ultra”/lokalny z przeglądarki).
- Gdy telefon całkowicie zamknie aplikację (przesunięcie w górę na liście aplikacji), połączenie się kończy.
